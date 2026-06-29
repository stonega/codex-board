import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ParserProvider } from '../../../packages/domain/src/index';

export const CODEX_CLI_DEFAULT_MODEL = 'gpt-5.4-mini';

export interface AppConfig {
  port: number;
  sessionsRoot: string;
  databasePath: string;
  codexHome?: string;
  agentsHome?: string;
  usagePricingPath?: string;
  parserProvider?: ParserProvider;
  openAiBaseUrl: string | null;
  openAiApiKey: string | null;
  openAiModel: string | null;
  syncIntervalMs?: number;
}

function resolveProjectRoot(): string {
  return join(import.meta.dir, '..', '..', '..');
}

export function resolveDatabasePath(
  projectRoot = resolveProjectRoot(),
): string {
  const appDataRoot = process.env.CODEX_BOARDS_APP_DATA_DIR;

  if (appDataRoot && appDataRoot.trim().length > 0) {
    return join(appDataRoot, 'codex-boards.sqlite');
  }

  return (
    process.env.CODEX_BOARDS_DB_PATH ??
    join(projectRoot, '.tmp', 'codex-boards.sqlite')
  );
}

export function getConfig(): AppConfig {
  const projectRoot = resolveProjectRoot();
  const parserProvider = normalizeParserProvider(
    process.env.CODEX_BOARDS_PARSER_PROVIDER,
  );
  const openAiModel =
    process.env.OPENAI_COMPAT_MODEL ??
    process.env.OPENAI_MODEL ??
    (parserProvider === 'codex-cli' ? CODEX_CLI_DEFAULT_MODEL : null);

  return {
    port: Number(
      process.env.CODEX_BOARDS_BACKEND_PORT ?? process.env.PORT ?? 7788,
    ),
    sessionsRoot:
      process.env.CODEX_SESSIONS_ROOT ?? join(homedir(), '.codex', 'sessions'),
    databasePath: resolveDatabasePath(projectRoot),
    codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    agentsHome: process.env.AGENTS_HOME ?? join(homedir(), '.agents'),
    usagePricingPath: process.env.CODEX_BOARDS_USAGE_PRICING_PATH,
    parserProvider,
    openAiBaseUrl:
      process.env.OPENAI_COMPAT_BASE_URL ?? process.env.OPENAI_BASE_URL ?? null,
    openAiApiKey:
      process.env.OPENAI_COMPAT_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    openAiModel,
    syncIntervalMs: Number(process.env.CODEX_BOARDS_SYNC_INTERVAL_MS ?? 60_000),
  };
}

export function normalizeParserProvider(
  value: string | null | undefined,
): ParserProvider {
  return value === 'codex-cli' ? 'codex-cli' : 'openai-compatible';
}

export function getParserProvider(config: {
  parserProvider?: ParserProvider | string | null;
}): ParserProvider {
  return normalizeParserProvider(config.parserProvider);
}

function normalizeOptionalSetting(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readParserSettings(config: AppConfig) {
  const provider = getParserProvider(config);

  return {
    provider,
    baseUrl: provider === 'codex-cli' ? null : config.openAiBaseUrl,
    model: config.openAiModel,
    apiKeyConfigured:
      provider === 'openai-compatible' && Boolean(config.openAiApiKey),
  };
}

export function updateParserSettings(
  config: AppConfig,
  parser: {
    provider?: ParserProvider | null;
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  },
) {
  if (Object.hasOwn(parser, 'provider')) {
    config.parserProvider = normalizeParserProvider(parser.provider);
  }

  const provider = getParserProvider(config);

  if (Object.hasOwn(parser, 'baseUrl')) {
    config.openAiBaseUrl =
      provider === 'codex-cli'
        ? null
        : normalizeOptionalSetting(parser.baseUrl);
  }

  if (Object.hasOwn(parser, 'model')) {
    config.openAiModel = normalizeOptionalSetting(parser.model);
  }

  if (Object.hasOwn(parser, 'apiKey')) {
    config.openAiApiKey =
      provider === 'codex-cli' ? null : normalizeOptionalSetting(parser.apiKey);
  }

  if (provider === 'codex-cli') {
    config.openAiBaseUrl = null;
    config.openAiApiKey = null;
  }

  return readParserSettings(config);
}

export function readPersistableParserSettings(config: AppConfig) {
  const provider = getParserProvider(config);

  return {
    provider,
    baseUrl: provider === 'codex-cli' ? null : config.openAiBaseUrl,
    model: config.openAiModel,
    apiKey: provider === 'codex-cli' ? null : config.openAiApiKey,
  };
}

export function applyPersistedParserSettings(
  config: AppConfig,
  parser: {
    provider?: ParserProvider | null;
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  } | null,
): void {
  if (!parser) {
    return;
  }

  config.parserProvider = normalizeParserProvider(parser.provider);
  config.openAiModel = normalizeOptionalSetting(parser.model);

  if (getParserProvider(config) === 'codex-cli') {
    config.openAiBaseUrl = null;
    config.openAiApiKey = null;
    return;
  }

  config.openAiBaseUrl = normalizeOptionalSetting(parser.baseUrl);
  config.openAiApiKey = normalizeOptionalSetting(parser.apiKey);
}
