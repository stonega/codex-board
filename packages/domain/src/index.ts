export type ParseMode = 'ai' | 'fallback';

export interface IssueCommitRef {
  sha: string;
  message?: string | null;
  source: string;
}

export interface IssueGitEvidence {
  repository: string;
  workspacePath: string;
  branch?: string | null;
  commits: IssueCommitRef[];
  tags: string[];
}

export interface IssueEvidence {
  rolloutPath: string;
  sessionId: string;
  threadId: string;
  warnings: string[];
  parsePayloadPreview: string;
}

export type ThreadImageRole = 'user' | 'assistant' | 'tool';

export type ThreadImageSourceType =
  | 'inline_data'
  | 'file_path'
  | 'url'
  | 'elided';

export interface ThreadImage {
  id: string;
  issueId: string;
  threadId: string;
  role: ThreadImageRole;
  messageIndex: number;
  partIndex: number;
  sourceType: ThreadImageSourceType;
  mimeType: string | null;
  filename: string | null;
  originalUrl: string | null;
  localPath: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  caption: string | null;
  messageExcerpt: string | null;
  createdAt: string | null;
}

export interface IssueStats {
  messageCount: number;
  commandCount: number;
  imageCount: number;
}

export interface ParsedIssue {
  id: string;
  threadId: string;
  projectId: string;
  title: string;
  tags: string[];
  summary: string;
  startedAt: string;
  updatedAt: string;
  parseMode: ParseMode;
  confidence: number;
  needsReview: boolean;
  git: IssueGitEvidence;
  evidence: IssueEvidence;
  stats: IssueStats;
  images?: ThreadImage[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  repository: string;
  workspacePath: string;
  issueCount: number;
  needsReviewCount: number;
  lastUpdatedAt: string;
}

export type SkillSource = 'codex' | 'agent' | 'plugin' | 'project';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: SkillSource;
  sourceLabel: string;
  sourceName: string | null;
  path: string;
  relativePath: string;
  projectId?: string | null;
}

export interface SkillDetail extends SkillSummary {
  content: string;
}

export interface SkillSuggestionEvidence {
  threadId: string;
  prompt: string;
  outcome: string;
  updatedAt: string;
}

export interface SkillSuggestion {
  id: string;
  title: string;
  name: string;
  description: string;
  trigger: string;
  tags: string[];
  evidenceThreadCount: number;
  examplePrompts: string[];
  commonOutcomes: string[];
  evidence: SkillSuggestionEvidence[];
  suggestedSkillBody: string;
}

export type UsageRangePreset =
  | 'last-7-days'
  | 'last-30-days'
  | 'all-time'
  | 'custom';

export interface UsageDailyPoint {
  date: string;
  totalTokens: number;
  estimatedCostUsd: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  reasoningOutputTokens: number;
  newThreadCount: number;
}

export interface UsageModelSummary {
  model: string;
  pricedAs: string | null;
  pricingStatus: 'priced' | 'estimated' | 'unpriced';
  totalTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedCostUsd: number | null;
}

export interface UsagePricingSummary {
  loaded: boolean;
  path: string;
  source: {
    name?: string;
    url?: string;
    tier?: string;
    fetchedAt?: string;
  } | null;
  pricedTokens: number;
  unpricedTokens: number;
  pricedTokenRatio: number;
  unpricedModelCount: number;
}

export interface UsageRefreshSummary {
  refreshedAt: string | null;
  scannedFiles: number;
  parsedEvents: number;
  skippedEvents: number;
  includedArchived: boolean;
}

export interface UsageAggregateSummary {
  totalTokens: number;
  estimatedCostUsd: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  reasoningOutputTokens: number;
  newThreadCount: number;
  eventCount: number;
  cacheRatio: number;
}

export interface UsageSummaryResponse {
  generatedAt: string;
  range: {
    preset: UsageRangePreset;
    startDate: string;
    endDate: string;
  };
  summary: UsageAggregateSummary;
  total: UsageAggregateSummary;
  pricing: UsagePricingSummary;
  refresh: UsageRefreshSummary;
  daily: UsageDailyPoint[];
  models: UsageModelSummary[];
}

export interface UsageRefreshResponse {
  ok: boolean;
  usage: UsageSummaryResponse;
}

export interface SyncDiagnostics {
  runId: string;
  startedAt: string;
  completedAt: string;
  parserBaseUrl: string | null;
  parserModel: string | null;
  responseModels: string[];
  aiRequestCount: number;
  tokenUsage: SyncTokenUsage;
  scannedFiles: number;
  changedFiles: number;
  importedThreads: number;
  skippedThreads: number;
  aiParsedIssues: number;
  fallbackIssues: number;
  reviewIssues: number;
  errors: string[];
  parseLog: SyncParseLogEntry[];
}

export type SyncTrigger = 'manual' | 'background' | 'onboarding';

export type SyncState = 'idle' | 'syncing' | 'error';

export type SyncPhase =
  | 'idle'
  | 'scanning'
  | 'parsing'
  | 'persisting'
  | 'completed'
  | 'failed';

export interface SyncProgress {
  totalFiles: number;
  scannedFiles: number;
  changedFiles: number;
  importedThreads: number;
  skippedThreads: number;
  aiParsedIssues: number;
  fallbackIssues: number;
  reviewIssues: number;
  currentFilePath: string | null;
}

export interface SyncStatus {
  generatedAt: string;
  state: SyncState;
  phase: SyncPhase;
  trigger: SyncTrigger | null;
  runId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  nextSyncAt: string | null;
  lastSync: SyncDiagnostics | null;
  latestError: string | null;
  progress: SyncProgress;
}

export interface SyncTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SyncParseLogEntry {
  filePath: string;
  threadId: string | null;
  repository: string | null;
  parseMode: ParseMode | null;
  issueCount: number;
  status: 'imported' | 'skipped' | 'error';
  message: string;
}

export interface SavedView {
  id: string;
  name: string;
  filters: IssueFilters;
  createdAt: string;
  updatedAt: string;
}

export interface IssueFilters {
  parseMode?: ParseMode | 'all';
  needsReview?: boolean;
  hasCommits?: boolean;
  hasTags?: boolean;
  hasImages?: boolean;
  tag?: string | null;
  query?: string | null;
}

export interface ProjectListResponse {
  generatedAt: string;
  sync: SyncDiagnostics | null;
  projects: ProjectSummary[];
}

export interface IssueListResponse {
  generatedAt: string;
  project: ProjectSummary | null;
  filters: IssueFilters;
  issues: ParsedIssue[];
}

export interface IssueDetailResponse {
  generatedAt: string;
  issue: ParsedIssue | null;
}

export interface SkillListResponse {
  generatedAt: string;
  scope: 'global' | 'project';
  project: ProjectSummary | null;
  skills: SkillSummary[];
}

export interface SkillDetailResponse {
  generatedAt: string;
  skill: SkillDetail | null;
}

export interface SkillSuggestionListResponse {
  generatedAt: string;
  project: ProjectSummary | null;
  signalCount: number;
  suggestions: SkillSuggestion[];
}

export type SkillInstallTarget = 'workspace' | 'global';

export interface InstallSkillPayload {
  target: SkillInstallTarget;
  projectId?: string | null;
  name: string;
  description?: string | null;
  content: string;
}

export interface InstallSkillResponse {
  ok: boolean;
  skill: SkillSummary | null;
  message: string;
}

export interface UpdateSkillEnabledPayload {
  enabled: boolean;
}

export interface UpdateSkillEnabledResponse {
  ok: boolean;
  skill: SkillSummary | null;
  message: string;
  restartRequired: boolean;
}

export interface SavedViewListResponse {
  generatedAt: string;
  views: SavedView[];
}

export interface SyncResponse {
  ok: boolean;
  sync: SyncDiagnostics;
  status?: SyncStatus;
}

export interface ExportMulticaPayload {
  projectId: string;
  issueIds?: string[];
  includeChildren?: boolean;
  runSync?: boolean;
  dryRun?: boolean;
}

export interface ExportedMulticaIssue {
  sourceIssueId: string;
  multicaIssueId: string | null;
  title: string;
  command: string[];
  dryRun: boolean;
}

export interface ExportMulticaResponse {
  ok: boolean;
  exported: ExportedMulticaIssue[];
  skippedChildren: Array<{
    sourceIssueId: string;
    reason: string;
  }>;
}

export type ParserProvider = 'openai-compatible' | 'codex-cli';

export interface ParserSettings {
  provider: ParserProvider;
  baseUrl: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
}

export interface OnboardingState {
  required: boolean;
  step: 'provider' | 'sync' | 'complete';
  providerReady: boolean;
  hasCompletedSync: boolean;
}

export interface SettingsResponse {
  generatedAt: string;
  parser: ParserSettings;
  onboarding: OnboardingState;
  sync: SyncDiagnostics | null;
  syncHistory: SyncDiagnostics[];
}

export interface SyncRunListResponse {
  generatedAt: string;
  sync: SyncDiagnostics | null;
  runs: SyncDiagnostics[];
}

export interface SyncStatusResponse {
  generatedAt: string;
  status: SyncStatus;
}

export interface SyncRequestPayload {
  trigger?: SyncTrigger;
  maxThreads?: number | null;
}

export interface UpdateSettingsPayload {
  parser?: {
    provider?: ParserProvider;
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  };
}

export interface IssueReviewPayload {
  needsReview: boolean;
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function inferProjectId(
  repository: string,
  workspacePath: string,
): string {
  return slugify(
    repository || workspacePath.split('/').at(-1) || 'unknown-project',
  );
}

export function inferProjectName(
  repository: string,
  workspacePath: string,
): string {
  if (repository.trim()) {
    return repository.trim();
  }

  return workspacePath.split('/').filter(Boolean).at(-1) ?? 'unknown-project';
}

export function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .map((tag) => tag.replace(/[^a-z0-9:_/-]+/g, '-')),
    ),
  ).slice(0, 12);
}

export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function scoreConfidence(input: {
  parseMode: ParseMode;
  gitSignals: number;
  messageCount: number;
  imageCount: number;
  hasWarnings: boolean;
}): number {
  const base = input.parseMode === 'ai' ? 0.72 : 0.46;
  const score =
    base +
    Math.min(input.gitSignals, 4) * 0.05 +
    Math.min(input.messageCount, 6) * 0.015 +
    Math.min(input.imageCount, 4) * 0.015 -
    (input.hasWarnings ? 0.14 : 0);

  return clampConfidence(score);
}

export function shouldNeedsReview(input: {
  parseMode: ParseMode;
  confidence: number;
  warnings: string[];
}): boolean {
  return (
    input.parseMode === 'fallback' ||
    input.confidence < 0.6 ||
    input.warnings.length > 0
  );
}
