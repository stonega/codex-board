export type IssueStatus =
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'unknown';

export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent' | 'unknown';

export type ParseMode = 'ai' | 'fallback';

export type IssueKind = 'parent' | 'sub_issue';

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

export interface ParsedIssue {
  id: string;
  threadId: string;
  projectId: string;
  parentIssueId: string | null;
  kind: IssueKind;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee: string | null;
  dueDate: string | null;
  tags: string[];
  summary: string;
  updatedAt: string;
  parseMode: ParseMode;
  confidence: number;
  needsReview: boolean;
  git: IssueGitEvidence;
  evidence: IssueEvidence;
  subIssueCount: number;
  children?: ParsedIssue[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  repository: string;
  workspacePath: string;
  issueCount: number;
  subIssueCount: number;
  needsReviewCount: number;
  lastUpdatedAt: string;
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
  status?: IssueStatus | 'all';
  priority?: IssuePriority | 'all';
  parseMode?: ParseMode | 'all';
  needsReview?: boolean;
  hasCommits?: boolean;
  hasTags?: boolean;
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

export interface SavedViewListResponse {
  generatedAt: string;
  views: SavedView[];
}

export interface SyncResponse {
  ok: boolean;
  sync: SyncDiagnostics;
}

export interface ParserSettings {
  baseUrl: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
}

export interface SettingsResponse {
  generatedAt: string;
  parser: ParserSettings;
  sync: SyncDiagnostics | null;
  syncHistory: SyncDiagnostics[];
}

export interface SyncRunListResponse {
  generatedAt: string;
  sync: SyncDiagnostics | null;
  runs: SyncDiagnostics[];
}

export interface UpdateSettingsPayload {
  parser?: {
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  };
}

export interface IssueReviewPayload {
  needsReview: boolean;
}

export interface IssueMergePayload {
  targetIssueId: string;
}

export interface IssueSplitPayload {
  children: Array<{
    title: string;
    summary?: string;
    status?: IssueStatus;
    priority?: IssuePriority;
    tags?: string[];
  }>;
}

const STATUS_KEYWORDS: Array<{ pattern: RegExp; value: IssueStatus }> = [
  { pattern: /\b(done|fixed|merged|released|shipped)\b/i, value: 'done' },
  { pattern: /\b(blocked|waiting|stuck|cannot)\b/i, value: 'blocked' },
  {
    pattern: /\b(progress|working|implement|building|syncing)\b/i,
    value: 'in_progress',
  },
  { pattern: /\b(todo|next|follow-up|follow up|need to)\b/i, value: 'todo' },
];

const PRIORITY_KEYWORDS: Array<{ pattern: RegExp; value: IssuePriority }> = [
  { pattern: /\b(urgent|p0|sev0|sev1|critical)\b/i, value: 'urgent' },
  { pattern: /\b(high|important|asap|blocking)\b/i, value: 'high' },
  { pattern: /\b(medium|normal)\b/i, value: 'medium' },
  { pattern: /\b(low|nice to have|later)\b/i, value: 'low' },
];

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

export function inferIssueStatus(content: string): IssueStatus {
  for (const keyword of STATUS_KEYWORDS) {
    if (keyword.pattern.test(content)) {
      return keyword.value;
    }
  }

  return 'unknown';
}

export function inferIssuePriority(content: string): IssuePriority {
  for (const keyword of PRIORITY_KEYWORDS) {
    if (keyword.pattern.test(content)) {
      return keyword.value;
    }
  }

  return 'unknown';
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
  unknownFields: number;
  gitSignals: number;
  subIssueCount: number;
  hasWarnings: boolean;
}): number {
  const base = input.parseMode === 'ai' ? 0.72 : 0.46;
  const score =
    base +
    Math.min(input.gitSignals, 4) * 0.05 +
    Math.min(input.subIssueCount, 4) * 0.02 -
    Math.min(input.unknownFields, 4) * 0.08 -
    (input.hasWarnings ? 0.14 : 0);

  return clampConfidence(score);
}

export function shouldNeedsReview(input: {
  parseMode: ParseMode;
  confidence: number;
  warnings: string[];
  unknownFields: number;
}): boolean {
  return (
    input.parseMode === 'fallback' ||
    input.confidence < 0.6 ||
    input.warnings.length > 0 ||
    input.unknownFields >= 2
  );
}
