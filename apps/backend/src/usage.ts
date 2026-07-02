import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  UsageAggregateSummary,
  UsageDailyPoint,
  UsageModelSummary,
  UsagePricingSummary,
  UsageRangePreset,
  UsageRefreshResponse,
  UsageRefreshSummary,
  UsageSummaryResponse,
} from '../../../packages/domain/src/index';

import type { AppConfig } from './config';
import type { BoardsDatabase, UsageEventRecord } from './db';

interface UsageQuery {
  preset?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

interface UsageLogState {
  sessionId: string | null;
  model: string | null;
  effort: string | null;
}

interface UsagePricingRates {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  estimated: boolean;
}

interface UsagePricingConfig {
  loaded: boolean;
  path: string;
  source: UsagePricingSummary['source'];
  models: Map<string, UsagePricingRates>;
  aliases: Map<string, string>;
}

const USAGE_PRICING_SCHEMA = 'codex-boards-usage-pricing-v1';
const TOKEN_COUNT_EVENT_TYPE = 'token_count';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_USAGE_PRICING_SOURCE: NonNullable<UsagePricingSummary['source']> =
  {
    name: 'OpenAI API pricing defaults bundled with Codex Boards',
    url: 'https://developers.openai.com/api/docs/pricing',
    tier: 'standard',
    fetchedAt: '2026-06-30T00:00:00.000Z',
  };
const DEFAULT_USAGE_PRICING_ALIASES = new Map<string, string>([
  ['gpt-5.5 (<272K context length)', 'gpt-5.5'],
  ['gpt-5.5-pro (<272K context length)', 'gpt-5.5-pro'],
  ['gpt-5.4 (<272K context length)', 'gpt-5.4'],
  ['gpt-5.4-mini (<272K context length)', 'gpt-5.4-mini'],
  ['gpt-5.4-nano (<272K context length)', 'gpt-5.4-nano'],
  ['gpt-5.4-pro (<272K context length)', 'gpt-5.4-pro'],
]);
const DEFAULT_USAGE_PRICING_MODELS = new Map<string, UsagePricingRates>([
  ['gpt-5.5', defaultPricingRates(5, 30, 0.5)],
  ['gpt-5.5-pro', defaultPricingRates(30, 180)],
  ['gpt-5.4', defaultPricingRates(2.5, 15, 0.25)],
  ['gpt-5.4-mini', defaultPricingRates(0.75, 4.5, 0.075)],
  ['gpt-5.4-nano', defaultPricingRates(0.2, 1.25, 0.02)],
  ['gpt-5.4-pro', defaultPricingRates(30, 180)],
  ['gpt-5.2', defaultPricingRates(1.75, 14, 0.175)],
  ['gpt-5.2-pro', defaultPricingRates(21, 168)],
  ['gpt-5.1', defaultPricingRates(1.25, 10, 0.125)],
  ['gpt-5', defaultPricingRates(1.25, 10, 0.125)],
  ['gpt-5-mini', defaultPricingRates(0.25, 2, 0.025)],
  ['gpt-5-nano', defaultPricingRates(0.05, 0.4, 0.005)],
  ['gpt-5-pro', defaultPricingRates(15, 120)],
  ['gpt-4.1', defaultPricingRates(2, 8, 0.5)],
  ['gpt-4.1-mini', defaultPricingRates(0.4, 1.6, 0.1)],
  ['gpt-4.1-nano', defaultPricingRates(0.1, 0.4, 0.025)],
  ['gpt-4o', defaultPricingRates(2.5, 10, 1.25)],
  ['gpt-4o-2024-05-13', defaultPricingRates(5, 15)],
  ['gpt-4o-mini', defaultPricingRates(0.15, 0.6, 0.075)],
  ['o1', defaultPricingRates(15, 60, 7.5)],
  ['o1-pro', defaultPricingRates(150, 600)],
  ['o3-pro', defaultPricingRates(20, 80)],
  ['o3', defaultPricingRates(2, 8, 0.5)],
  ['o4-mini', defaultPricingRates(1.1, 4.4, 0.275)],
  ['o3-mini', defaultPricingRates(1.1, 4.4, 0.55)],
  ['o1-mini', defaultPricingRates(1.1, 4.4, 0.55)],
  ['gpt-4-turbo-2024-04-09', defaultPricingRates(10, 30)],
  ['gpt-4-0125-preview', defaultPricingRates(10, 30)],
  ['gpt-4-1106-preview', defaultPricingRates(10, 30)],
  ['gpt-4-1106-vision-preview', defaultPricingRates(10, 30)],
  ['gpt-4-0613', defaultPricingRates(30, 60)],
  ['gpt-4-0314', defaultPricingRates(30, 60)],
  ['gpt-4-32k', defaultPricingRates(60, 120)],
  ['gpt-3.5-turbo', defaultPricingRates(0.5, 1.5)],
  ['gpt-3.5-turbo-0125', defaultPricingRates(0.5, 1.5)],
  ['gpt-3.5-turbo-1106', defaultPricingRates(1, 2)],
  ['gpt-3.5-turbo-0613', defaultPricingRates(1.5, 2)],
  ['gpt-3.5-0301', defaultPricingRates(1.5, 2)],
  ['gpt-3.5-turbo-instruct', defaultPricingRates(1.5, 2)],
  ['gpt-3.5-turbo-16k-0613', defaultPricingRates(3, 4)],
  ['davinci-002', defaultPricingRates(2, 2)],
  ['babbage-002', defaultPricingRates(0.4, 0.4)],
]);

function defaultPricingRates(
  inputPerMillion: number,
  outputPerMillion: number,
  cachedInputPerMillion = inputPerMillion,
): UsagePricingRates {
  return {
    inputPerMillion,
    cachedInputPerMillion,
    outputPerMillion,
    estimated: false,
  };
}

export class UsageService {
  constructor(
    private readonly database: BoardsDatabase,
    private readonly config: AppConfig,
  ) {}

  refresh(query: UsageQuery = {}): UsageRefreshResponse {
    const logs = listUsageLogFiles(this.config);
    const events: UsageEventRecord[] = [];
    let skippedEvents = 0;

    for (const log of logs) {
      const parsed = parseUsageLogFile(log.path, log.isArchived);
      events.push(...parsed.events);
      skippedEvents += parsed.skippedEvents;
    }

    const refresh: UsageRefreshSummary = {
      refreshedAt: new Date().toISOString(),
      scannedFiles: logs.length,
      parsedEvents: events.length,
      skippedEvents,
      includedArchived: true,
    };
    this.database.replaceUsageEvents(events, refresh);

    return {
      ok: true,
      usage: this.summary(query),
    };
  }

  summary(query: UsageQuery = {}): UsageSummaryResponse {
    const events = this.database.listUsageEvents();
    const pricing = loadUsagePricing(this.config);
    const range = resolveUsageRange(query);
    const buckets = createDailyBuckets(range.startDate, range.endDate);
    const modelBuckets = new Map<string, UsageModelSummary>();
    const firstThreadDate = new Map<string, string>();
    const totalSummary = createUsageSummaryAccumulator();
    const intervalSummary = createUsageSummaryAccumulator();

    for (const event of events) {
      const eventDay = localDateKey(event.eventTimestamp);
      const existingThreadDate = firstThreadDate.get(event.threadId);
      if (!existingThreadDate || eventDay < existingThreadDate) {
        firstThreadDate.set(event.threadId, eventDay);
      }
    }

    let pricedTokens = 0;
    let unpricedTokens = 0;
    const unpricedModels = new Set<string>();

    for (const event of events) {
      const cost = estimateEventCostUsd(event, pricing);
      addUsageEventToSummary(totalSummary, event, cost);

      const eventDay = localDateKey(event.eventTimestamp);
      const bucket = buckets.get(eventDay);
      if (!bucket) {
        continue;
      }

      const model = event.model ?? 'Unknown model';
      const rates = ratesForModel(model, pricing);
      const pricedAs = pricedAsModel(model, pricing);
      const modelBucket = modelBuckets.get(model) ?? {
        model,
        pricedAs,
        pricingStatus: rates
          ? rates.estimated
            ? 'estimated'
            : 'priced'
          : 'unpriced',
        totalTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        estimatedCostUsd: rates ? 0 : null,
      };

      addUsageEventToSummary(intervalSummary, event, cost);
      bucket.totalTokens += event.totalTokens;
      bucket.cachedInputTokens += event.cachedInputTokens;
      bucket.uncachedInputTokens += event.uncachedInputTokens;
      bucket.reasoningOutputTokens += event.reasoningOutputTokens;
      modelBucket.totalTokens += event.totalTokens;
      modelBucket.cachedInputTokens += event.cachedInputTokens;
      modelBucket.uncachedInputTokens += event.uncachedInputTokens;
      modelBucket.outputTokens += event.outputTokens;
      modelBucket.reasoningOutputTokens += event.reasoningOutputTokens;

      if (cost === null) {
        unpricedTokens += event.totalTokens;
        unpricedModels.add(model);
      } else {
        pricedTokens += event.totalTokens;
        bucket.estimatedCostUsd += cost;
        modelBucket.estimatedCostUsd =
          (modelBucket.estimatedCostUsd ?? 0) + cost;
      }

      modelBuckets.set(model, modelBucket);
    }

    totalSummary.newThreadCount = firstThreadDate.size;
    for (const startedAt of firstThreadDate.values()) {
      const bucket = buckets.get(startedAt);
      if (bucket) {
        bucket.newThreadCount += 1;
        intervalSummary.newThreadCount += 1;
      }
    }

    const daily = [...buckets.values()].map((point) => ({
      ...point,
      estimatedCostUsd: roundMoney(point.estimatedCostUsd),
    }));

    return {
      generatedAt: new Date().toISOString(),
      range,
      summary: finalizeUsageSummary(intervalSummary),
      total: finalizeUsageSummary(totalSummary),
      pricing: {
        loaded: pricing.loaded,
        path: pricing.path,
        source: pricing.source,
        pricedTokens,
        unpricedTokens,
        pricedTokenRatio:
          pricedTokens + unpricedTokens > 0
            ? pricedTokens / (pricedTokens + unpricedTokens)
            : 0,
        unpricedModelCount: unpricedModels.size,
      },
      refresh: this.database.readUsageRefresh(),
      daily,
      models: [...modelBuckets.values()]
        .map((model) => ({
          ...model,
          estimatedCostUsd:
            model.estimatedCostUsd === null
              ? null
              : roundMoney(model.estimatedCostUsd),
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens),
    };
  }
}

function createUsageSummaryAccumulator(): UsageAggregateSummary {
  return {
    totalTokens: 0,
    estimatedCostUsd: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    reasoningOutputTokens: 0,
    newThreadCount: 0,
    eventCount: 0,
    cacheRatio: 0,
  };
}

function addUsageEventToSummary(
  summary: UsageAggregateSummary,
  event: UsageEventRecord,
  estimatedCostUsd: number | null,
): void {
  summary.eventCount += 1;
  summary.totalTokens += event.totalTokens;
  summary.cachedInputTokens += event.cachedInputTokens;
  summary.uncachedInputTokens += event.uncachedInputTokens;
  summary.reasoningOutputTokens += event.reasoningOutputTokens;
  if (estimatedCostUsd !== null) {
    summary.estimatedCostUsd += estimatedCostUsd;
  }
}

function finalizeUsageSummary(
  summary: UsageAggregateSummary,
): UsageAggregateSummary {
  const inputTokens = summary.cachedInputTokens + summary.uncachedInputTokens;
  return {
    ...summary,
    estimatedCostUsd: roundMoney(summary.estimatedCostUsd),
    cacheRatio: inputTokens > 0 ? summary.cachedInputTokens / inputTokens : 0,
  };
}

function listUsageLogFiles(config: AppConfig): Array<{
  path: string;
  isArchived: boolean;
}> {
  const seen = new Set<string>();
  const logs: Array<{ path: string; isArchived: boolean }> = [];
  const addRoot = (root: string | null | undefined, isArchived: boolean) => {
    if (!root || !existsSync(root)) {
      return;
    }

    for (const path of walkJsonlFiles(root)) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      logs.push({ path, isArchived });
    }
  };

  addRoot(config.sessionsRoot, false);
  addRoot(resolveArchivedSessionsRoot(config), true);

  return logs.sort((left, right) => left.path.localeCompare(right.path));
}

function resolveArchivedSessionsRoot(config: AppConfig): string {
  if (config.codexHome) {
    return join(config.codexHome, 'archived_sessions');
  }

  return join(dirname(config.sessionsRoot), 'archived_sessions');
}

function walkJsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkJsonlFiles(path));
    } else if (stat.isFile() && path.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files;
}

function parseUsageLogFile(
  path: string,
  isArchived: boolean,
): { events: UsageEventRecord[]; skippedEvents: number } {
  const state: UsageLogState = {
    sessionId: sessionIdFromFilename(path),
    model: null,
    effort: null,
  };
  const events: UsageEventRecord[] = [];
  let skippedEvents = 0;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    const envelope = parseObject(line);
    if (!envelope) {
      skippedEvents += 1;
      continue;
    }

    const payload = asObject(envelope.payload);
    if (!payload) {
      skippedEvents += 1;
      continue;
    }

    if (envelope.type === 'session_meta') {
      state.sessionId = optionalString(payload.id) ?? state.sessionId;
      continue;
    }

    if (envelope.type === 'turn_context') {
      state.model = optionalString(payload.model) ?? state.model;
      state.effort = optionalString(payload.effort) ?? state.effort;
      continue;
    }

    if (
      envelope.type !== 'event_msg' ||
      payload.type !== TOKEN_COUNT_EVENT_TYPE
    ) {
      continue;
    }

    const event = usageEventFromPayload({
      payload,
      state,
      path,
      lineNumber: index + 1,
      timestamp: optionalString(envelope.timestamp),
      isArchived,
    });

    if (!event) {
      skippedEvents += 1;
      continue;
    }

    events.push(event);
  }

  return { events, skippedEvents };
}

function usageEventFromPayload({
  payload,
  state,
  path,
  lineNumber,
  timestamp,
  isArchived,
}: {
  payload: Record<string, unknown>;
  state: UsageLogState;
  path: string;
  lineNumber: number;
  timestamp: string | null;
  isArchived: boolean;
}): UsageEventRecord | null {
  const info = asObject(payload.info);
  const lastUsage = asObject(info?.last_token_usage) ?? asObject(payload.info);
  if (!lastUsage) {
    return null;
  }

  const inputTokens = usageInteger(lastUsage.input_tokens);
  const outputTokens = usageInteger(lastUsage.output_tokens);
  const totalTokens = usageInteger(lastUsage.total_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return null;
  }

  const cachedInputTokens = usageInteger(lastUsage.cached_input_tokens) ?? 0;
  const reasoningOutputTokens =
    usageInteger(lastUsage.reasoning_output_tokens) ?? 0;
  const eventTimestamp = timestamp ?? new Date().toISOString();
  const sessionId = state.sessionId ?? 'unknown-session';
  const model = state.model ?? optionalString(info?.model);
  const effort = state.effort ?? optionalString(info?.effort);

  return {
    recordId: createUsageRecordId({
      sessionId,
      eventTimestamp,
      lineNumber,
      totalTokens,
    }),
    sessionId,
    threadId: sessionId,
    eventTimestamp,
    sourceFile: path,
    lineNumber,
    model,
    effort,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(inputTokens - cachedInputTokens, 0),
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    isArchived,
  };
}

function createUsageRecordId({
  sessionId,
  eventTimestamp,
  lineNumber,
  totalTokens,
}: {
  sessionId: string;
  eventTimestamp: string;
  lineNumber: number;
  totalTokens: number;
}): string {
  return createHash('sha256')
    .update([sessionId, eventTimestamp, lineNumber, totalTokens].join('|'))
    .digest('hex');
}

function loadUsagePricing(config: AppConfig): UsagePricingConfig {
  const path =
    config.usagePricingPath ??
    join(dirname(config.databasePath), 'usage-pricing.json');
  if (!existsSync(path)) {
    return createDefaultUsagePricing(path);
  }

  const raw = parseObject(readFileSync(path, 'utf8'));
  if (!raw) {
    return createDefaultUsagePricing(path);
  }

  const modelPayload = asObject(raw.models) ?? raw;
  const models = cloneDefaultUsagePricingModels();
  for (const [model, rates] of Object.entries(modelPayload)) {
    if (model.startsWith('_')) {
      continue;
    }

    const ratePayload = asObject(rates);
    if (!ratePayload) {
      continue;
    }

    const input = usageNumber(ratePayload.input_per_million);
    const output = usageNumber(ratePayload.output_per_million);
    const cached = usageNumber(ratePayload.cached_input_per_million) ?? input;
    if (input === null || output === null || cached === null) {
      continue;
    }

    models.set(model, {
      inputPerMillion: input,
      cachedInputPerMillion: cached,
      outputPerMillion: output,
      estimated: ratePayload.estimated === true,
    });
  }

  const aliases = new Map(DEFAULT_USAGE_PRICING_ALIASES);
  const aliasPayload = asObject(raw.aliases);
  if (aliasPayload) {
    for (const [source, target] of Object.entries(aliasPayload)) {
      if (typeof target === 'string') {
        aliases.set(source, target);
      }
    }
  }

  const sourcePayload = asObject(raw._source);
  return {
    loaded: true,
    path,
    source: sourcePayload
      ? {
          name: optionalString(sourcePayload.name) ?? undefined,
          url: optionalString(sourcePayload.url) ?? undefined,
          tier: optionalString(sourcePayload.tier) ?? undefined,
          fetchedAt:
            optionalString(sourcePayload.fetched_at) ??
            optionalString(sourcePayload.fetchedAt) ??
            undefined,
        }
      : { name: USAGE_PRICING_SCHEMA },
    models,
    aliases,
  };
}

function createDefaultUsagePricing(path: string): UsagePricingConfig {
  return {
    loaded: true,
    path,
    source: DEFAULT_USAGE_PRICING_SOURCE,
    models: cloneDefaultUsagePricingModels(),
    aliases: new Map(DEFAULT_USAGE_PRICING_ALIASES),
  };
}

function cloneDefaultUsagePricingModels(): Map<string, UsagePricingRates> {
  return new Map(
    [...DEFAULT_USAGE_PRICING_MODELS].map(([model, rates]) => [
      model,
      { ...rates },
    ]),
  );
}

function estimateEventCostUsd(
  event: UsageEventRecord,
  pricing: UsagePricingConfig,
): number | null {
  const rates = ratesForModel(event.model, pricing);
  if (!rates) {
    return null;
  }

  return (
    (event.uncachedInputTokens * rates.inputPerMillion +
      event.cachedInputTokens * rates.cachedInputPerMillion +
      event.outputTokens * rates.outputPerMillion) /
    1_000_000
  );
}

function ratesForModel(
  model: string | null,
  pricing: UsagePricingConfig,
): UsagePricingRates | null {
  const pricedAs = pricedAsModel(model, pricing);
  return pricedAs ? (pricing.models.get(pricedAs) ?? null) : null;
}

function pricedAsModel(
  model: string | null,
  pricing: UsagePricingConfig,
): string | null {
  if (!model) {
    return null;
  }

  for (const candidate of usageModelCandidates(model)) {
    if (pricing.models.has(candidate)) {
      return candidate;
    }

    const aliasTarget = pricing.aliases.get(candidate);
    if (aliasTarget && pricing.models.has(aliasTarget)) {
      return aliasTarget;
    }
  }

  return null;
}

function usageModelCandidates(model: string): string[] {
  const trimmed = model.trim();
  if (!trimmed) {
    return [];
  }

  const withoutContextLength = trimmed
    .replace(/\s+\(<[^)]*context length\)$/i, '')
    .trim();

  return [...new Set([trimmed, withoutContextLength].filter(Boolean))];
}

function resolveUsageRange(query: UsageQuery): UsageSummaryResponse['range'] {
  const today = localDateKey(new Date().toISOString());
  const preset = normalizePreset(query.preset);

  if (preset === 'custom' && query.startDate && query.endDate) {
    return {
      preset,
      startDate: query.startDate,
      endDate: query.endDate,
    };
  }

  const days = preset === 'last-30-days' ? 30 : 7;
  return {
    preset,
    startDate: shiftDateKey(today, -(days - 1)),
    endDate: today,
  };
}

function normalizePreset(value: string | null | undefined): UsageRangePreset {
  if (value === 'last-30-days' || value === 'custom') {
    return value;
  }

  return 'last-7-days';
}

function createDailyBuckets(
  startDate: string,
  endDate: string,
): Map<string, UsageDailyPoint> {
  const buckets = new Map<string, UsageDailyPoint>();
  let cursor = startDate;
  while (cursor <= endDate) {
    buckets.set(cursor, {
      date: cursor,
      totalTokens: 0,
      estimatedCostUsd: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      reasoningOutputTokens: 0,
      newThreadCount: 0,
    });
    cursor = shiftDateKey(cursor, 1);
  }
  return buckets;
}

function localDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDateKey(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setTime(date.getTime() + days * DAY_MS);
  return localDateKey(date.toISOString());
}

function sessionIdFromFilename(path: string): string | null {
  return (
    /rollout-[^-]+-[0-9T:-]+-([0-9a-f-]{36})\.jsonl$/i.exec(path)?.[1] ?? null
  );
}

function parseObject(value: string): Record<string, unknown> | null;
function parseObject(value: unknown): Record<string, unknown> | null;
function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asObject(parsed);
    } catch {
      return null;
    }
  }

  return asObject(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function usageInteger(value: unknown): number | null {
  const numberValue = usageNumber(value);
  return numberValue === null ? null : Math.trunc(numberValue);
}

function usageNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
