import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ParserProvider } from '../../../packages/domain/src/index';

export const CODEX_CLI_DEFAULT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_PARSE_OUTPUT_LANGUAGE = 'English';

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
  parseOutputLanguage?: string | null;
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
  const configuredBaseUrl =
    process.env.OPENAI_COMPAT_BASE_URL ?? process.env.OPENAI_BASE_URL ?? null;
  const configuredApiKey =
    process.env.OPENAI_COMPAT_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
  const configuredModel =
    process.env.OPENAI_COMPAT_MODEL ?? process.env.OPENAI_MODEL ?? null;
  const parserProvider = inferParserProvider(
    process.env.CODEX_BOARDS_PARSER_PROVIDER,
    {
      baseUrl: configuredBaseUrl,
      apiKey: configuredApiKey,
      model: configuredModel,
    },
  );
  const openAiModel =
    configuredModel ??
    (process.env.CODEX_BOARDS_PARSER_PROVIDER === 'codex-cli'
      ? CODEX_CLI_DEFAULT_MODEL
      : null);

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
    openAiBaseUrl: configuredBaseUrl,
    openAiApiKey: configuredApiKey,
    openAiModel,
    parseOutputLanguage: normalizeParseOutputLanguage(
      process.env.CODEX_BOARDS_PARSE_OUTPUT_LANGUAGE,
    ),
    syncIntervalMs: Number(process.env.CODEX_BOARDS_SYNC_INTERVAL_MS ?? 60_000),
  };
}

export function normalizeParserProvider(
  value: string | null | undefined,
): ParserProvider {
  return value === 'openai-compatible' ? 'openai-compatible' : 'codex-cli';
}

function hasOpenAiSettings(settings: {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
}): boolean {
  return Boolean(settings.baseUrl || settings.apiKey || settings.model);
}

function inferParserProvider(
  value: string | null | undefined,
  settings: {
    baseUrl?: string | null;
    apiKey?: string | null;
    model?: string | null;
  } = {},
): ParserProvider {
  if (value === 'codex-cli' || value === 'openai-compatible') {
    return value;
  }

  return hasOpenAiSettings(settings) ? 'openai-compatible' : 'codex-cli';
}

export function getParserProvider(config: {
  parserProvider?: ParserProvider | string | null;
  openAiBaseUrl?: string | null;
  openAiApiKey?: string | null;
  openAiModel?: string | null;
}): ParserProvider {
  return inferParserProvider(config.parserProvider, {
    baseUrl: config.openAiBaseUrl,
    apiKey: config.openAiApiKey,
    model: config.openAiModel,
  });
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

export function normalizeParseOutputLanguage(
  value: string | null | undefined,
): string {
  const normalized = normalizeOptionalSetting(value);
  return normalized ?? DEFAULT_PARSE_OUTPUT_LANGUAGE;
}

export function readParserSettings(config: AppConfig) {
  const provider = getParserProvider(config);

  return {
    provider,
    baseUrl: provider === 'codex-cli' ? null : config.openAiBaseUrl,
    model: config.openAiModel,
    apiKeyConfigured:
      provider === 'openai-compatible' && Boolean(config.openAiApiKey),
    outputLanguage: normalizeParseOutputLanguage(config.parseOutputLanguage),
  };
}

export function updateParserSettings(
  config: AppConfig,
  parser: {
    provider?: ParserProvider | null;
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
    outputLanguage?: string | null;
  },
) {
  if (Object.hasOwn(parser, 'provider')) {
    config.parserProvider = normalizeParserProvider(parser.provider);
  } else if (
    Object.hasOwn(parser, 'baseUrl') ||
    Object.hasOwn(parser, 'apiKey')
  ) {
    config.parserProvider = 'openai-compatible';
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

  if (Object.hasOwn(parser, 'outputLanguage')) {
    config.parseOutputLanguage = normalizeParseOutputLanguage(
      parser.outputLanguage,
    );
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
    outputLanguage: normalizeParseOutputLanguage(config.parseOutputLanguage),
  };
}

export function applyPersistedParserSettings(
  config: AppConfig,
  parser: {
    provider?: ParserProvider | null;
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
    outputLanguage?: string | null;
  } | null,
): void {
  if (!parser) {
    return;
  }

  config.parserProvider = inferParserProvider(parser.provider, parser);
  config.openAiModel = normalizeOptionalSetting(parser.model);
  config.parseOutputLanguage = normalizeParseOutputLanguage(
    parser.outputLanguage,
  );

  if (getParserProvider(config) === 'codex-cli') {
    config.openAiBaseUrl = null;
    config.openAiApiKey = null;
    return;
  }

  config.openAiBaseUrl = normalizeOptionalSetting(parser.baseUrl);
  config.openAiApiKey = normalizeOptionalSetting(parser.apiKey);
}
