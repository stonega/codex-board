import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppConfig {
  port: number;
  sessionsRoot: string;
  databasePath: string;
  codexHome?: string;
  agentsHome?: string;
  usagePricingPath?: string;
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
    openAiBaseUrl:
      process.env.OPENAI_COMPAT_BASE_URL ?? process.env.OPENAI_BASE_URL ?? null,
    openAiApiKey:
      process.env.OPENAI_COMPAT_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    openAiModel:
      process.env.OPENAI_COMPAT_MODEL ?? process.env.OPENAI_MODEL ?? null,
    syncIntervalMs: Number(process.env.CODEX_BOARDS_SYNC_INTERVAL_MS ?? 60_000),
  };
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
  return {
    baseUrl: config.openAiBaseUrl,
    model: config.openAiModel,
    apiKeyConfigured: Boolean(config.openAiApiKey),
  };
}

export function updateParserSettings(
  config: AppConfig,
  parser: {
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  },
) {
  if (Object.hasOwn(parser, 'baseUrl')) {
    config.openAiBaseUrl = normalizeOptionalSetting(parser.baseUrl);
  }

  if (Object.hasOwn(parser, 'model')) {
    config.openAiModel = normalizeOptionalSetting(parser.model);
  }

  if (Object.hasOwn(parser, 'apiKey')) {
    config.openAiApiKey = normalizeOptionalSetting(parser.apiKey);
  }

  return readParserSettings(config);
}

export function readPersistableParserSettings(config: AppConfig) {
  return {
    baseUrl: config.openAiBaseUrl,
    model: config.openAiModel,
    apiKey: config.openAiApiKey,
  };
}

export function applyPersistedParserSettings(
  config: AppConfig,
  parser: {
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  } | null,
): void {
  if (!parser) {
    return;
  }

  config.openAiBaseUrl = normalizeOptionalSetting(parser.baseUrl);
  config.openAiModel = normalizeOptionalSetting(parser.model);
  config.openAiApiKey = normalizeOptionalSetting(parser.apiKey);
}
