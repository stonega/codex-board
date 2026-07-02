import { AnimatePresence, motion } from 'framer-motion';
import {
  BookOpen,
  Check,
  ChevronRight,
  Database,
  ExternalLink,
  Filter,
  GitCommit,
  Home,
  Image as ImageIcon,
  Layout,
  List,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Sparkles,
  Tags,
  X,
} from 'lucide-react';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Route, Routes } from 'react-router';

import type {
  ExportMulticaResponse,
  InstallSkillPayload,
  InstallSkillResponse,
  IssueDetailResponse,
  IssueFilters,
  IssueListResponse,
  ParsedIssue,
  ParserProvider,
  ProjectListResponse,
  SavedViewListResponse,
  SettingsResponse,
  SkillDetail,
  SkillDetailResponse,
  SkillInstallTarget,
  SkillListResponse,
  SkillSuggestion,
  SkillSuggestionListResponse,
  SkillSummary,
  SyncDiagnostics,
  SyncRequestPayload,
  SyncResponse,
  SyncStatus,
  SyncStatusResponse,
  SyncTrigger,
  UpdateSettingsPayload,
  UpdateSkillEnabledPayload,
  UpdateSkillEnabledResponse,
} from '@codex-boards/domain';

import { UsagePage } from './UsagePage';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Select } from './components/ui/select';
import { Sheet } from './components/ui/sheet';
import { Table, TableEmpty, TableWrapper } from './components/ui/table';
import {
  resolveApiBaseUrl,
  resolveSyncStatusWebSocketUrl,
} from './lib/runtime';

type ParserPreset = {
  label: string;
  provider: ParserProvider;
  baseUrl: string;
  model: string;
  apiKeyRequired: boolean;
};

const PARSER_PRESETS = {
  codexCli: {
    label: 'Codex CLI',
    provider: 'codex-cli',
    baseUrl: '',
    model: 'gpt-5.4-mini',
    apiKeyRequired: false,
  },
  gemini: {
    label: 'Gemini',
    provider: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3-flash-preview',
    apiKeyRequired: true,
  },
  openrouter: {
    label: 'OpenRouter',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
    apiKeyRequired: true,
  },
  deepseek: {
    label: 'DeepSeek',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKeyRequired: true,
  },
} as const satisfies Record<string, ParserPreset>;

type MainView = 'project' | 'skills' | 'usage';
type ProjectTab = 'issues' | 'skills';
type ParserSettingsForm = {
  provider: ParserProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  outputLanguage: string;
};

type ParserSettingsField = 'baseUrl' | 'model' | 'apiKey' | 'outputLanguage';
export type OnboardingDisplayStep = 'provider' | 'language' | 'sync';

const DEFAULT_OUTPUT_LANGUAGE = 'English';
const PARSER_OUTPUT_LANGUAGE_OPTIONS = [
  'English',
  'Traditional Chinese',
  'Simplified Chinese',
  'Japanese',
  'Spanish',
  'French',
] as const;

const SIDEBAR_EXPANDED_WIDTH = 240;
const SIDEBAR_COLLAPSED_WIDTH = 64;

function isPresetOutputLanguage(value: string): boolean {
  return PARSER_OUTPUT_LANGUAGE_OPTIONS.some((language) => language === value);
}

function normalizeOutputLanguage(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DEFAULT_OUTPUT_LANGUAGE;
}

function createParserSettingsForm(
  parser?: SettingsResponse['parser'] | null,
): ParserSettingsForm {
  const provider = parser?.provider ?? 'codex-cli';

  return {
    provider,
    baseUrl: parser?.baseUrl ?? '',
    model:
      parser?.model ??
      (provider === 'codex-cli' ? PARSER_PRESETS.codexCli.model : ''),
    apiKey: '',
    apiKeyConfigured: parser?.apiKeyConfigured ?? false,
    outputLanguage: normalizeOutputLanguage(parser?.outputLanguage),
  };
}

export function getOnboardingDisplayStep(
  parserReady: boolean,
  languageConfirmed: boolean,
): OnboardingDisplayStep {
  if (!parserReady) {
    return 'provider';
  }

  return languageConfirmed ? 'sync' : 'language';
}

function formatLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isParserSettingsReady(
  parser: SettingsResponse['parser'] | null | undefined,
): boolean {
  if (!parser) {
    return false;
  }

  if (parser.provider === 'codex-cli') {
    return Boolean(parser.model);
  }

  return Boolean(parser.baseUrl && parser.model && parser.apiKeyConfigured);
}

const TAG_BADGE_CLASSES = [
  'border border-sky-200 bg-sky-50 text-sky-700',
  'border border-emerald-200 bg-emerald-50 text-emerald-700',
  'border border-amber-200 bg-amber-50 text-amber-700',
  'border border-rose-200 bg-rose-50 text-rose-700',
  'border border-violet-200 bg-violet-50 text-violet-700',
  'border border-cyan-200 bg-cyan-50 text-cyan-700',
] as const;

function getTagBadgeClass(tag: string): string {
  const hash = Array.from(tag).reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );

  return TAG_BADGE_CLASSES[hash % TAG_BADGE_CLASSES.length];
}

async function fetchJson<T>(path: string): Promise<T> {
  const apiBaseUrl = await resolveApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const apiBaseUrl = await resolveApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function patchJson<T>(path: string, body?: unknown): Promise<T> {
  const apiBaseUrl = await resolveApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function buildIssueSearchParams(
  projectId: string,
  filters: IssueFilters,
): URLSearchParams {
  const search = new URLSearchParams({ projectId });

  if (filters.parseMode && filters.parseMode !== 'all') {
    search.set('parseMode', filters.parseMode);
  }
  if (filters.needsReview) {
    search.set('needsReview', 'true');
  }
  if (filters.hasCommits) {
    search.set('hasCommits', 'true');
  }
  if (filters.hasTags) {
    search.set('hasTags', 'true');
  }
  if (filters.hasImages) {
    search.set('hasImages', 'true');
  }
  if (filters.tag) {
    search.set('tag', filters.tag);
  }
  if (filters.query) {
    search.set('query', filters.query);
  }

  return search;
}

function DetailSheet({
  issue,
  onClose,
  onReviewToggle,
}: {
  issue: ParsedIssue | null;
  onClose: () => void;
  onReviewToggle: (issueId: string, nextValue: boolean) => Promise<void>;
}) {
  const images = issue?.images ?? [];

  return (
    <Sheet
      open={Boolean(issue)}
      onClose={onClose}
      title={issue?.title ?? 'Issue details'}
    >
      {issue ? (
        <div className="grid gap-6">
          <header className="flex justify-between items-start mb-8">
            <div>
              <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                Thread issue
              </p>
              <h2 className="text-3xl font-bold tracking-tight">
                {issue.title}
              </h2>
            </div>
            <Button onClick={onClose} variant="ghost" size="sm">
              <X size={16} />
            </Button>
          </header>

          <section className="grid gap-6 pb-12">
            <div className="pt-4 border-t border-notion-border grid grid-cols-2 gap-4">
              <div>
                <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                  Parse mode
                </p>
                <Badge>{issue.parseMode}</Badge>
              </div>
              <div>
                <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                  Confidence
                </p>
                <Badge>{Math.round(issue.confidence * 100)}%</Badge>
              </div>
              <div>
                <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                  Messages
                </p>
                <p className="text-sm">{issue.stats.messageCount}</p>
              </div>
              <div>
                <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                  Commands
                </p>
                <p className="text-sm">{issue.stats.commandCount}</p>
              </div>
              <div>
                <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                  Images
                </p>
                <p className="text-sm">{issue.stats.imageCount}</p>
              </div>
            </div>

            <div className="pt-4 border-t border-notion-border">
              <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                Summary
              </p>
              <p className="text-sm leading-relaxed">{issue.summary}</p>
            </div>

            <div className="pt-4 border-t border-notion-border">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                    Tags
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {issue.tags.length > 0 ? (
                      issue.tags.map((tag) => (
                        <Badge className={getTagBadgeClass(tag)} key={tag}>
                          {tag}
                        </Badge>
                      ))
                    ) : (
                      <p className="text-sm text-notion-muted">No tags</p>
                    )}
                  </div>
                </div>
                <Button
                  onClick={() =>
                    void onReviewToggle(issue.id, !issue.needsReview)
                  }
                  variant="secondary"
                  size="sm"
                >
                  {issue.needsReview ? <Check size={14} /> : <Send size={14} />}
                  {issue.needsReview ? 'Mark reviewed' : 'Send to review'}
                </Button>
              </div>
            </div>

            <div className="pt-4 border-t border-notion-border">
              <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                Images
              </p>
              {images.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {images.map((image) => {
                    const previewUrl = image.previewUrl ?? null;
                    const canPreview = Boolean(previewUrl);
                    const label =
                      image.caption ||
                      image.filename ||
                      formatLabel(image.sourceType);
                    const source =
                      image.originalUrl ||
                      image.localPath ||
                      image.messageExcerpt ||
                      'No retrievable source';

                    return (
                      <article
                        className="rounded border border-notion-border overflow-hidden"
                        key={image.id}
                      >
                        {canPreview && previewUrl ? (
                          <a href={previewUrl} rel="noreferrer" target="_blank">
                            <img
                              alt={label}
                              className="aspect-[4/3] w-full object-cover bg-[#f7f7f5]"
                              loading="lazy"
                              src={previewUrl}
                            />
                          </a>
                        ) : (
                          <div className="aspect-[4/3] w-full bg-[#f7f7f5] text-notion-muted flex items-center justify-center">
                            <ImageIcon size={28} />
                          </div>
                        )}
                        <div className="p-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium truncate">
                              {label}
                            </p>
                            <Badge>{formatLabel(image.sourceType)}</Badge>
                          </div>
                          <p className="mt-1 text-[0.75rem] text-notion-muted break-all">
                            {source}
                          </p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-notion-muted">
                  No images were detected in this thread.
                </p>
              )}
            </div>

            <div className="pt-4 border-t border-notion-border">
              <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                Git evidence
              </p>
              <ul className="pl-5 list-disc text-sm text-notion-muted mb-3">
                <li>Repository: {issue.git.repository}</li>
                <li>Workspace: {issue.git.workspacePath}</li>
                <li>Branch: {issue.git.branch ?? 'Unknown'}</li>
                <li>Commits: {issue.git.commits.length}</li>
              </ul>
              {issue.git.commits.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {issue.git.commits.map((commit) => (
                    <Badge key={commit.sha}>{commit.sha.slice(0, 7)}</Badge>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="pt-4 border-t border-notion-border">
              <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                Traceability
              </p>
              <ul className="pl-5 list-disc text-sm text-notion-muted mb-3">
                <li>Thread: {issue.threadId}</li>
                <li>Rollout: {issue.evidence.rolloutPath}</li>
                <li>Started: {new Date(issue.startedAt).toLocaleString()}</li>
                <li>Updated: {new Date(issue.updatedAt).toLocaleString()}</li>
              </ul>
              {issue.evidence.warnings.length > 0 ? (
                <div className="bg-[#fef6ee] border border-[#f9dab3] p-2 rounded text-sm text-[#854c0e] mb-3">
                  {issue.evidence.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
              <pre className="bg-[#f7f7f5] border border-notion-border p-3 rounded font-mono text-[0.81rem] whitespace-pre-wrap break-all">
                {issue.evidence.parsePayloadPreview}
              </pre>
            </div>
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}

function ProjectTabBar({
  active,
  onChange,
}: {
  active: ProjectTab;
  onChange: (tab: ProjectTab) => void;
}) {
  const tabs: Array<{
    id: ProjectTab;
    label: string;
    icon: typeof ListTodo;
  }> = [
    { id: 'issues', label: 'Issues', icon: ListTodo },
    { id: 'skills', label: 'Skills', icon: Sparkles },
  ];

  return (
    <div
      aria-label="Project sections"
      className="project-tab-bar"
      role="tablist"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const selected = active === tab.id;

        return (
          <button
            aria-selected={selected}
            className={`project-tab-button ${selected ? 'project-tab-button-active' : ''}`}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            type="button"
          >
            <Icon size={13} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SkillSuggestionList({
  suggestions,
  signalCount,
  loading,
  onOpen,
}: {
  suggestions: SkillSuggestion[];
  signalCount: number;
  loading: boolean;
  onOpen: (suggestion: SkillSuggestion) => void;
}) {
  return (
    <section className="mb-8 grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-[0.75rem] font-semibold uppercase tracking-wider text-notion-muted">
            Workspace Patterns
          </p>
          <h3 className="text-lg font-semibold tracking-tight text-notion-text">
            Draft skill suggestions
          </h3>
        </div>
        <Badge>{signalCount} thread signals</Badge>
      </div>

      {loading ? (
        <TableEmpty>Finding repeated workspace task patterns...</TableEmpty>
      ) : suggestions.length === 0 ? (
        <TableEmpty>No repeated skill patterns were found yet.</TableEmpty>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {suggestions.map((suggestion) => (
            <button
              className="group flex min-h-56 w-full min-w-0 flex-col rounded-lg border border-notion-border bg-white p-4 text-left shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-colors hover:border-notion-muted/30 hover:bg-notion-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-notion-blue focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              key={suggestion.id}
              onClick={() => onOpen(suggestion)}
              type="button"
            >
              <div className="mb-3 flex min-w-0 flex-col items-start gap-2">
                <div className="min-w-0 max-w-full">
                  <strong className="block break-words text-sm font-semibold leading-snug text-notion-text">
                    {suggestion.title}
                  </strong>
                  <span className="mt-1 block break-words text-[0.75rem] text-notion-muted">
                    {suggestion.name}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge>Draft</Badge>
                  <Badge>{suggestion.evidenceThreadCount} threads</Badge>
                  <span className="text-[0.75rem] text-notion-muted">
                    from prompts and outcomes
                  </span>
                </div>
              </div>

              <p className="line-clamp-3 text-sm leading-relaxed text-notion-muted">
                {suggestion.description}
              </p>

              {suggestion.tags.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1">
                  {suggestion.tags.slice(0, 5).map((tag) => (
                    <Badge className={getTagBadgeClass(tag)} key={tag}>
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {suggestion.examplePrompts.length > 0 ? (
                <p className="mt-3 line-clamp-2 text-[0.75rem] leading-relaxed text-notion-muted">
                  {suggestion.examplePrompts[0]}
                </p>
              ) : null}

              <span className="mt-auto flex items-center gap-1.5 pt-4 text-[0.75rem] font-medium text-notion-muted transition-colors group-hover:text-notion-text">
                <Sparkles size={14} />
                Open draft
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SkillList({
  skills,
  loading,
  emptyMessage,
  onOpen,
}: {
  skills: SkillSummary[];
  loading: boolean;
  emptyMessage: string;
  onOpen: (skillId: string) => void;
}) {
  if (loading) {
    return <TableEmpty>Loading skills...</TableEmpty>;
  }

  if (skills.length === 0) {
    return <TableEmpty>{emptyMessage}</TableEmpty>;
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {skills.map((skill) => (
        <button
          className={`group flex min-h-40 w-full min-w-0 flex-col rounded-lg border p-4 text-left shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-colors hover:border-notion-muted/30 hover:bg-notion-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-notion-blue focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
            skill.enabled
              ? 'border-notion-border bg-white'
              : 'border-notion-border bg-[#f7f7f5]'
          }`}
          key={skill.id}
          onClick={() => onOpen(skill.id)}
          type="button"
        >
          <div className="mb-3 flex min-w-0 flex-col items-start gap-2">
            <div className="min-w-0 max-w-full">
              <strong className="block break-words text-sm font-semibold leading-snug text-notion-text">
                {skill.name}
              </strong>
              <span className="mt-1 block truncate text-[0.75rem] text-notion-muted">
                {skill.relativePath}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge>{skill.sourceLabel}</Badge>
              <Badge
                className={
                  skill.enabled
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-rose-50 text-rose-700'
                }
              >
                {skill.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
          </div>

          <p className="line-clamp-4 text-sm leading-relaxed text-notion-muted">
            {skill.description || 'No description provided.'}
          </p>

          <span className="mt-auto flex items-center gap-1.5 pt-4 text-[0.75rem] font-medium text-notion-muted transition-colors group-hover:text-notion-text">
            <BookOpen size={14} />
            Open skill
          </span>
        </button>
      ))}
    </div>
  );
}

function SkillDetailSheet({
  skill,
  onClose,
  onAddDraftSkill,
  onUpdateSkillEnabled,
  addingDraftSkill,
  draftSkillMessage,
  updatingSkillEnabled,
  skillEnablementMessage,
}: {
  skill: SkillDetail | null;
  onClose: () => void;
  onAddDraftSkill?: (target: SkillInstallTarget) => Promise<void>;
  onUpdateSkillEnabled?: (
    skill: SkillDetail,
    enabled: boolean,
  ) => Promise<void>;
  addingDraftSkill?: boolean;
  draftSkillMessage?: string | null;
  updatingSkillEnabled?: boolean;
  skillEnablementMessage?: string | null;
}) {
  const [addMenuState, setAddMenuState] = useState<{
    skillId: string | null;
    open: boolean;
  }>({
    skillId: null,
    open: false,
  });
  const isDraftSuggestion = skill?.sourceLabel === 'Draft suggestion';
  const addMenuOpen = addMenuState.skillId === skill?.id && addMenuState.open;

  return (
    <Sheet
      open={Boolean(skill)}
      onClose={onClose}
      title={skill?.name ?? 'Skill details'}
    >
      {skill ? (
        <div className="grid gap-6">
          <header className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="mb-2 text-[0.75rem] font-medium uppercase tracking-wider text-notion-muted">
                {skill.sourceLabel}
              </p>
              <h2 className="break-words text-3xl font-bold tracking-tight">
                {skill.name}
              </h2>
              {skill.description ? (
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-notion-muted">
                  {skill.description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {!isDraftSuggestion && onUpdateSkillEnabled ? (
                <button
                  aria-checked={skill.enabled}
                  className={`inline-flex h-7 items-center gap-2 rounded-md border px-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-notion-blue focus-visible:ring-offset-2 ${
                    skill.enabled
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-rose-200 bg-rose-50 text-rose-700'
                  }`}
                  disabled={updatingSkillEnabled}
                  onClick={() =>
                    void onUpdateSkillEnabled(skill, !skill.enabled)
                  }
                  role="switch"
                  type="button"
                >
                  <span
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                      skill.enabled ? 'bg-emerald-500' : 'bg-rose-400'
                    }`}
                  >
                    <span
                      className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                        skill.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                      }`}
                    />
                  </span>
                  {updatingSkillEnabled
                    ? 'Saving...'
                    : skill.enabled
                      ? 'Enabled'
                      : 'Disabled'}
                </button>
              ) : null}
              {isDraftSuggestion && onAddDraftSkill ? (
                <div className="relative">
                  <Button
                    disabled={addingDraftSkill}
                    onClick={() =>
                      setAddMenuState((current) => ({
                        skillId: skill?.id ?? null,
                        open:
                          current.skillId === skill?.id ? !current.open : true,
                      }))
                    }
                    size="sm"
                    type="button"
                  >
                    <Plus size={14} />
                    {addingDraftSkill ? 'Adding...' : 'Add Skill'}
                  </Button>
                  {addMenuOpen ? (
                    <div className="absolute right-0 top-[calc(100%+0.5rem)] z-20 grid min-w-44 overflow-hidden rounded-lg border border-notion-border bg-white p-1 text-[0.75rem] shadow-lg">
                      <button
                        className="rounded-md px-3 py-2 text-left text-notion-text hover:bg-notion-hover focus:bg-notion-hover focus:outline-none"
                        disabled={addingDraftSkill}
                        onClick={() => {
                          setAddMenuState({ skillId: null, open: false });
                          void onAddDraftSkill('workspace');
                        }}
                        type="button"
                      >
                        Add to workspace
                      </button>
                      <button
                        className="rounded-md px-3 py-2 text-left text-notion-text hover:bg-notion-hover focus:bg-notion-hover focus:outline-none"
                        disabled={addingDraftSkill}
                        onClick={() => {
                          setAddMenuState({ skillId: null, open: false });
                          void onAddDraftSkill('global');
                        }}
                        type="button"
                      >
                        Add globally
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <Button onClick={onClose} variant="ghost" size="sm">
                <X size={16} />
              </Button>
            </div>
          </header>

          {draftSkillMessage ? (
            <p className="rounded border border-notion-border bg-notion-hover p-3 text-sm text-notion-muted">
              {draftSkillMessage}
            </p>
          ) : null}

          {skillEnablementMessage ? (
            <p className="rounded border border-notion-border bg-notion-hover p-3 text-sm text-notion-muted">
              {skillEnablementMessage}
            </p>
          ) : null}

          <section className="grid gap-6 pb-12">
            <div className="grid gap-4 border-t border-notion-border pt-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-[0.75rem] font-medium uppercase tracking-wider text-notion-muted">
                  Source
                </p>
                <Badge>{skill.sourceLabel}</Badge>
              </div>
              <div>
                <p className="mb-2 text-[0.75rem] font-medium uppercase tracking-wider text-notion-muted">
                  File
                </p>
                <p className="break-all text-sm text-notion-muted">
                  {skill.path}
                </p>
              </div>
            </div>

            <div className="border-t border-notion-border pt-4">
              <p className="mb-2 flex items-center gap-2 text-[0.75rem] font-medium uppercase tracking-wider text-notion-muted">
                <BookOpen size={14} />
                Full content
              </p>
              <pre className="rounded border border-notion-border bg-[#f7f7f5] p-4 font-mono text-[0.81rem] leading-relaxed whitespace-pre-wrap break-words">
                {skill.content}
              </pre>
            </div>
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}

function ProviderPresetButtons({
  form,
  onApplyPreset,
}: {
  form: ParserSettingsForm;
  onApplyPreset: (preset: keyof typeof PARSER_PRESETS) => void;
}) {
  const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '');

  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(PARSER_PRESETS).map(([id, preset]) => {
        const active =
          form.provider === preset.provider &&
          (preset.provider === 'codex-cli' ||
            normalizeBaseUrl(form.baseUrl) ===
              normalizeBaseUrl(preset.baseUrl));

        return (
          <button
            aria-pressed={active}
            key={id}
            onClick={() => onApplyPreset(id as keyof typeof PARSER_PRESETS)}
            type="button"
            className={`rounded border px-3 py-1.5 text-[0.875rem] font-medium shadow-sm transition-colors ${
              active
                ? 'border-notion-blue bg-blue-50 text-blue-800 ring-1 ring-blue-100 hover:bg-blue-100'
                : 'border-notion-border bg-white text-notion-text hover:bg-notion-hover'
            }`}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

function OutputLanguageControl({
  idPrefix,
  form,
  onChange,
}: {
  idPrefix: string;
  form: ParserSettingsForm;
  onChange: (field: ParserSettingsField, value: string) => void;
}) {
  const selectValue = isPresetOutputLanguage(form.outputLanguage)
    ? form.outputLanguage
    : 'custom';

  return (
    <div className="grid gap-2">
      <label
        className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider"
        htmlFor={`${idPrefix}-outputLanguage`}
      >
        Output language
      </label>
      <Select
        id={`${idPrefix}-outputLanguage`}
        onChange={(event) =>
          onChange(
            'outputLanguage',
            event.target.value === 'custom' ? '' : event.target.value,
          )
        }
        value={selectValue}
        className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
      >
        {PARSER_OUTPUT_LANGUAGE_OPTIONS.map((language) => (
          <option key={language} value={language}>
            {language}
          </option>
        ))}
        <option value="custom">Custom</option>
      </Select>
      {selectValue === 'custom' ? (
        <Input
          id={`${idPrefix}-customOutputLanguage`}
          onChange={(event) => onChange('outputLanguage', event.target.value)}
          placeholder="Korean, Brazilian Portuguese, ..."
          value={form.outputLanguage}
          className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
        />
      ) : null}
    </div>
  );
}

function SyncStatusPill({
  status,
  fallbackSync,
  onRunSync,
  syncActive,
}: {
  status: SyncStatus | null;
  fallbackSync: SyncDiagnostics | null;
  onRunSync: () => Promise<void>;
  syncActive: boolean;
}) {
  const syncing = status?.state === 'syncing';
  const lastSync = status?.lastSync ?? fallbackSync;
  const error = status?.latestError;

  if (!syncing && !error && !lastSync) {
    return (
      <Button
        className="px-3 disabled:opacity-60"
        disabled={syncActive}
        onClick={() => void onRunSync()}
        type="button"
      >
        <RefreshCw size={13} />
        {syncActive ? 'Syncing...' : 'Start Sync'}
      </Button>
    );
  }

  const label = syncing
    ? status.progress.currentFilePath
      ? `Syncing ${status.progress.scannedFiles}/${status.progress.totalFiles}`
      : 'Syncing'
    : error
      ? 'Sync error'
      : lastSync
        ? `Synced ${new Date(lastSync.completedAt).toLocaleTimeString()}`
        : 'Not synced';
  const detail = syncing
    ? `${status.progress.changedFiles} changed`
    : status?.nextSyncAt
      ? `Next ${new Date(status.nextSyncAt).toLocaleTimeString()}`
      : null;

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1 text-[0.75rem] ${syncing ? 'border-blue-100 bg-blue-50 text-blue-700' : error ? 'border-rose-100 bg-rose-50 text-rose-700' : 'border-notion-border bg-notion-sidebar text-notion-muted'}`}
      title={error ?? undefined}
    >
      <RefreshCw size={13} className={syncing ? 'animate-spin' : undefined} />
      <span className="font-medium">{label}</span>
      {detail ? <span className="text-current/70">{detail}</span> : null}
    </div>
  );
}

function OnboardingScreen({
  form,
  step,
  saving,
  error,
  syncStatus,
  syncError,
  syncActive,
  onChange,
  onApplyPreset,
  onSaveLanguage,
  onSaveProvider,
  onSkipToHome,
  onRunSync,
}: {
  form: ParserSettingsForm;
  step: OnboardingDisplayStep;
  saving: boolean;
  error: string | null;
  syncStatus: SyncStatus | null;
  syncError: string | null;
  syncActive: boolean;
  onChange: (field: ParserSettingsField, value: string) => void;
  onApplyPreset: (preset: keyof typeof PARSER_PRESETS) => void;
  onSaveLanguage: () => Promise<boolean>;
  onSaveProvider: () => Promise<boolean>;
  onSkipToHome: () => Promise<void>;
  onRunSync: () => Promise<void>;
}) {
  const progress = syncStatus?.progress;
  const totalFiles = progress?.totalFiles ?? 0;
  const scannedFiles = progress?.scannedFiles ?? 0;
  const percent =
    totalFiles > 0
      ? Math.min(100, Math.round((scannedFiles / totalFiles) * 100))
      : syncActive
        ? 12
        : 0;
  const providerStepActive = step === 'provider';
  const languageStepActive = step === 'language';
  const syncStepActive = step === 'sync';
  const stepStateClass = (active: boolean, completed: boolean) => {
    if (active) {
      return 'border-notion-blue bg-blue-50 text-blue-800';
    }

    if (completed) {
      return 'border-emerald-100 bg-emerald-50 text-emerald-700';
    }

    return 'border-notion-border bg-notion-sidebar text-notion-muted';
  };
  const providerUsesApiKey = form.provider === 'openai-compatible';
  const providerCanContinue = providerUsesApiKey
    ? Boolean(
        form.baseUrl.trim() &&
          form.model.trim() &&
          (form.apiKeyConfigured || form.apiKey.trim()),
      )
    : Boolean(form.model.trim());
  const scanCountLabel =
    !syncActive && scannedFiles === 0
      ? `${totalFiles} thread${totalFiles === 1 ? '' : 's'} found`
      : `${scannedFiles}/${totalFiles} scanned`;

  return (
    <main className="min-h-screen bg-white text-notion-text">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center gap-8 px-6 py-10">
        <header className="grid gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-notion-muted">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-notion-active">
              <Layout size={15} />
            </div>
            Codex Boards
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Set up sync
          </h1>
        </header>

        <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="grid content-start gap-2 text-sm">
            <div
              className={`rounded-md border p-3 ${stepStateClass(providerStepActive, !providerStepActive)}`}
            >
              <p className="font-semibold">1. Provider</p>
              <p className="mt-1 text-[0.81rem] opacity-80">
                Configure a parser provider.
              </p>
            </div>
            <div
              className={`rounded-md border p-3 ${stepStateClass(languageStepActive, syncStepActive)}`}
            >
              <p className="font-semibold">2. Language</p>
              <p className="mt-1 text-[0.81rem] opacity-80">
                Choose parse output language.
              </p>
            </div>
            <div
              className={`rounded-md border p-3 ${stepStateClass(syncStepActive, false)}`}
            >
              <p className="font-semibold">3. Sync</p>
              <p className="mt-1 text-[0.81rem] opacity-80">
                Import local Codex rollout history.
              </p>
            </div>
          </aside>

          <section className="rounded-lg border border-notion-border bg-white p-5 shadow-sm">
            {providerStepActive ? (
              <div className="grid gap-5">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">
                    Choose parser provider
                  </h2>
                  <p className="mt-1 text-sm text-notion-muted">
                    The first sync uses this provider to turn local threads into
                    readable issues.
                  </p>
                </div>

                <ProviderPresetButtons
                  form={form}
                  onApplyPreset={onApplyPreset}
                />

                <div className="grid gap-4">
                  {providerUsesApiKey ? (
                    <div className="grid gap-1.5">
                      <label
                        className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider"
                        htmlFor="onboarding-baseUrl"
                      >
                        Base URL
                      </label>
                      <Input
                        id="onboarding-baseUrl"
                        onChange={(event) =>
                          onChange('baseUrl', event.target.value)
                        }
                        placeholder="https://api.deepseek.com"
                        value={form.baseUrl}
                        className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
                      />
                    </div>
                  ) : (
                    <p className="rounded border border-notion-border bg-notion-sidebar p-3 text-sm text-notion-muted">
                      Codex CLI returns a plain final message, so sync extracts
                      JSON from that text instead of sending a response schema.
                    </p>
                  )}
                  <div className="grid gap-1.5">
                    <label
                      className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider"
                      htmlFor="onboarding-model"
                    >
                      Model
                    </label>
                    <Input
                      id="onboarding-model"
                      onChange={(event) =>
                        onChange('model', event.target.value)
                      }
                      placeholder="deepseek-v4-flash"
                      value={form.model}
                      className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
                    />
                  </div>
                  {providerUsesApiKey ? (
                    <div className="grid gap-1.5">
                      <label
                        className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider"
                        htmlFor="onboarding-apiKey"
                      >
                        API key
                      </label>
                      <Input
                        id="onboarding-apiKey"
                        onChange={(event) =>
                          onChange('apiKey', event.target.value)
                        }
                        placeholder={
                          form.apiKeyConfigured
                            ? 'Stored already. Enter a new key to replace it.'
                            : 'Enter API key'
                        }
                        type="password"
                        value={form.apiKey}
                        className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
                      />
                    </div>
                  ) : null}
                </div>

                {error ? (
                  <p className="rounded border border-red-100 bg-red-50 p-3 text-sm text-red-800">
                    {error}
                  </p>
                ) : null}

                <div className="flex justify-end border-t border-notion-border pt-4">
                  <Button
                    disabled={saving || !providerCanContinue}
                    onClick={() => void onSaveProvider()}
                    className="bg-notion-blue px-4 text-white hover:bg-blue-600"
                  >
                    {saving ? 'Saving...' : 'Continue'}
                  </Button>
                </div>
              </div>
            ) : languageStepActive ? (
              <div className="grid gap-5">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">
                    Choose output language
                  </h2>
                  <p className="mt-1 text-sm text-notion-muted">
                    Parsed issue titles, summaries, tags, and warnings will use
                    this language while JSON keys stay stable.
                  </p>
                </div>

                <OutputLanguageControl
                  form={form}
                  idPrefix="onboarding-language"
                  onChange={onChange}
                />

                {error ? (
                  <p className="rounded border border-red-100 bg-red-50 p-3 text-sm text-red-800">
                    {error}
                  </p>
                ) : null}

                <div className="flex justify-end border-t border-notion-border pt-4">
                  <Button
                    disabled={saving}
                    onClick={() => void onSaveLanguage()}
                    className="bg-notion-blue px-4 text-white hover:bg-blue-600"
                  >
                    {saving ? 'Saving...' : 'Continue'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-5">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">
                    Sync workspace
                  </h2>
                  <p className="mt-1 text-sm text-notion-muted">
                    Codex Boards is importing local session history.
                  </p>
                </div>

                <div className="grid gap-3">
                  <div className="h-2 overflow-hidden rounded-full bg-notion-active">
                    <div
                      className="h-full rounded-full bg-notion-blue transition-all"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <Badge>{scanCountLabel}</Badge>
                    <Badge>{progress?.changedFiles ?? 0} changed</Badge>
                    <Badge>{progress?.importedThreads ?? 0} imported</Badge>
                    <Badge>{progress?.skippedThreads ?? 0} skipped</Badge>
                  </div>
                  {progress?.currentFilePath ? (
                    <p className="break-all rounded border border-notion-border bg-notion-sidebar p-2 font-mono text-[0.75rem] text-notion-muted">
                      {progress.currentFilePath}
                    </p>
                  ) : null}
                </div>

                {syncError ? (
                  <p className="rounded border border-red-100 bg-red-50 p-3 text-sm text-red-800">
                    {syncError}
                  </p>
                ) : null}

                <div className="flex flex-col gap-2 border-t border-notion-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    disabled={saving}
                    onClick={() => void onSkipToHome()}
                    variant="outline"
                    className="px-3"
                  >
                    <Home size={14} />
                    {saving ? 'Skipping...' : 'Skip to home'}
                  </Button>
                  <Button
                    disabled={syncActive || saving}
                    onClick={() => void onRunSync()}
                    className="bg-notion-blue px-4 text-white hover:bg-blue-600"
                  >
                    <RefreshCw
                      size={14}
                      className={syncActive ? 'animate-spin' : undefined}
                    />
                    {syncActive ? 'Syncing...' : 'Start sync'}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function SettingsModal({
  open,
  form,
  sync,
  syncHistory,
  parserReady,
  loading,
  saving,
  error,
  onClose,
  onSave,
  onChange,
  onApplyPreset,
}: {
  open: boolean;
  form: ParserSettingsForm;
  sync: SyncDiagnostics | null;
  syncHistory: SyncDiagnostics[];
  parserReady: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => Promise<boolean>;
  onChange: (field: ParserSettingsField, value: string) => void;
  onApplyPreset: (preset: keyof typeof PARSER_PRESETS) => void;
}) {
  const [activeSection, setActiveSection] = useState<'parser' | 'history'>(
    'parser',
  );
  const providerUsesApiKey = form.provider === 'openai-compatible';

  return (
    <Sheet open={open} onClose={onClose} title="Settings" variant="modal">
      <div className="grid gap-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.75rem] font-semibold uppercase tracking-wider text-notion-muted">
              Workspace settings
            </p>
          </div>
          <Button onClick={onClose} variant="ghost" size="sm">
            <X size={16} />
          </Button>
        </header>

        <div className="grid gap-4 md:grid-cols-[180px_1px_minmax(0,1fr)]">
          <aside className="flex flex-col gap-0.5 py-1">
            <button
              className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[0.875rem] transition-colors ${activeSection === 'parser' ? 'bg-notion-active font-medium text-notion-text' : 'text-notion-muted hover:bg-notion-hover'}`}
              onClick={() => setActiveSection('parser')}
              type="button"
            >
              <Settings size={16} />
              <span>Parser</span>
            </button>
            <button
              className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[0.875rem] transition-colors ${activeSection === 'history' ? 'bg-notion-active font-medium text-notion-text' : 'text-notion-muted hover:bg-notion-hover'}`}
              onClick={() => setActiveSection('history')}
              type="button"
            >
              <RefreshCw size={16} />
              <span>Sync history</span>
            </button>
          </aside>

          <div className="bg-notion-border w-px hidden md:block" />

          <section className="grid gap-6">
            {activeSection === 'parser' ? (
              <>
                <div className="grid gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-notion-text mb-1">
                      Parser configuration
                    </h3>
                    <p className="text-sm text-notion-muted">
                      Configure the parser provider used for the next sync run.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge
                      className={
                        parserReady
                          ? 'bg-blue-50 text-blue-700 border-blue-100'
                          : ''
                      }
                    >
                      {parserReady ? 'AI parser ready' : 'Fallback only'}
                    </Badge>
                    <Badge
                      className={
                        providerUsesApiKey && form.apiKeyConfigured
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                          : !providerUsesApiKey
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                            : ''
                      }
                    >
                      {providerUsesApiKey
                        ? form.apiKeyConfigured
                          ? 'API key configured'
                          : 'API key missing'
                        : 'No API key required'}
                    </Badge>
                    {sync ? (
                      <Badge className="bg-notion-active text-notion-muted">
                        Last sync{' '}
                        {new Date(sync.completedAt).toLocaleDateString()}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-3">
                  <span className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider">
                    Presets
                  </span>
                  <ProviderPresetButtons
                    form={form}
                    onApplyPreset={onApplyPreset}
                  />
                </div>

                <div className="grid gap-5">
                  {providerUsesApiKey ? (
                    <div className="grid gap-1.5">
                      <label
                        className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider"
                        htmlFor="settings-baseUrl"
                      >
                        Base URL
                      </label>
                      <Input
                        id="settings-baseUrl"
                        onChange={(event) =>
                          onChange('baseUrl', event.target.value)
                        }
                        placeholder="http://localhost:11434/v1"
                        value={form.baseUrl}
                        className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
                      />
                    </div>
                  ) : (
                    <p className="rounded border border-notion-border bg-notion-sidebar p-3 text-sm text-notion-muted">
                      Codex CLI returns a plain final message, so sync extracts
                      JSON from that text instead of sending a response schema.
                    </p>
                  )}

                  <div className="grid gap-1.5">
                    <label
                      className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider"
                      htmlFor="settings-model"
                    >
                      Model
                    </label>
                    <Input
                      id="settings-model"
                      onChange={(event) =>
                        onChange('model', event.target.value)
                      }
                      placeholder="qwen2.5-coder:7b"
                      value={form.model}
                      className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
                    />
                  </div>

                  <OutputLanguageControl
                    form={form}
                    idPrefix="settings"
                    onChange={onChange}
                  />

                  {providerUsesApiKey ? (
                    <div className="grid gap-1.5">
                      <label
                        className="text-[0.75rem] font-semibold text-notion-muted uppercase tracking-wider"
                        htmlFor="settings-apiKey"
                      >
                        API key
                      </label>
                      <Input
                        id="settings-apiKey"
                        onChange={(event) =>
                          onChange('apiKey', event.target.value)
                        }
                        placeholder={
                          form.apiKeyConfigured
                            ? 'Stored already. Enter a new key to replace it.'
                            : 'Enter API key'
                        }
                        type="password"
                        value={form.apiKey}
                        className="w-full bg-notion-sidebar border border-notion-border focus:bg-white focus:border-notion-blue transition-all"
                      />
                    </div>
                  ) : null}
                </div>

                {error ? (
                  <p className="rounded border border-red-100 bg-red-50 p-3 text-sm text-red-800">
                    {error}
                  </p>
                ) : null}

                <div className="flex items-center justify-between gap-4 border-t border-notion-border pt-5">
                  <p className="text-sm text-notion-muted leading-relaxed max-w-[240px]">
                    Leave fields empty to keep parsing on the deterministic
                    fallback path.
                  </p>
                  <Button
                    disabled={loading || saving}
                    onClick={() => void onSave()}
                    className="bg-notion-blue text-white hover:bg-blue-600 px-4 h-8"
                  >
                    {saving ? 'Saving...' : 'Save settings'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="grid gap-4 min-h-0 overflow-hidden">
                <div>
                  <h3 className="text-sm font-semibold text-notion-text mb-1">
                    Sync history
                  </h3>
                  <p className="text-sm text-notion-muted">
                    Recent sync runs with parser target and token usage.
                  </p>
                </div>

                {syncHistory.length > 0 ? (
                  <div className="overflow-hidden rounded-xl border border-notion-border bg-white shadow-sm">
                    <div className="max-h-[400px] overflow-auto">
                      <TableWrapper>
                        <Table className="w-full text-[0.81rem]">
                          <thead>
                            <tr className="border-b border-notion-border bg-[#fbfbfa] sticky top-0 z-10">
                              <th className="px-3 py-2 text-left font-semibold text-notion-muted whitespace-nowrap uppercase tracking-wider text-[0.68rem]">
                                Completed
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-notion-muted whitespace-nowrap uppercase tracking-wider text-[0.68rem]">
                                Model
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-notion-muted whitespace-nowrap uppercase tracking-wider text-[0.68rem]">
                                Tokens
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-notion-muted whitespace-nowrap uppercase tracking-wider text-[0.68rem]">
                                Imported
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-notion-muted whitespace-nowrap uppercase tracking-wider text-[0.68rem]">
                                Errors
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {syncHistory.map((entry) => (
                              <tr
                                className="border-b border-notion-border last:border-b-0 hover:bg-notion-hover transition-colors"
                                key={entry.runId}
                              >
                                <td className="px-3 py-2 align-top text-notion-muted whitespace-nowrap">
                                  {new Date(entry.completedAt).toLocaleString()}
                                </td>
                                <td className="px-3 py-2 align-top text-notion-text">
                                  {entry.parserModel ?? 'Fallback only'}
                                </td>
                                <td className="px-3 py-2 align-top text-notion-text">
                                  {entry.tokenUsage.totalTokens > 0
                                    ? entry.tokenUsage.totalTokens.toLocaleString()
                                    : 'n/a'}
                                </td>
                                <td className="px-3 py-2 align-top text-emerald-600 font-medium">
                                  {entry.importedThreads}
                                </td>
                                <td className="px-3 py-2 align-top text-rose-600 font-medium">
                                  {entry.errors.length}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      </TableWrapper>
                    </div>
                  </div>
                ) : (
                  <div className="p-12 text-center border border-dashed border-notion-border rounded-lg bg-notion-sidebar">
                    <p className="text-sm text-notion-muted">
                      No sync history recorded yet.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </Sheet>
  );
}

function BoardPage() {
  const [projectsResponse, setProjectsResponse] =
    useState<ProjectListResponse | null>(null);
  const [savedViewsResponse, setSavedViewsResponse] =
    useState<SavedViewListResponse | null>(null);
  const [settingsResponse, setSettingsResponse] =
    useState<SettingsResponse | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [issuesResponse, setIssuesResponse] =
    useState<IssueListResponse | null>(null);
  const [globalSkillsResponse, setGlobalSkillsResponse] =
    useState<SkillListResponse | null>(null);
  const [projectSkillsResponse, setProjectSkillsResponse] =
    useState<SkillListResponse | null>(null);
  const [skillSuggestionsResponse, setSkillSuggestionsResponse] =
    useState<SkillSuggestionListResponse | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<ParsedIssue | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [mainView, setMainView] = useState<MainView>('project');
  const [projectTab, setProjectTab] = useState<ProjectTab>('issues');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarLabelsVisible, setSidebarLabelsVisible] = useState(true);
  const [smallViewport, setSmallViewport] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(max-width: 639px)').matches,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [loadingGlobalSkills, setLoadingGlobalSkills] = useState(false);
  const [loadingProjectSkills, setLoadingProjectSkills] = useState(false);
  const [loadingSkillSuggestions, setLoadingSkillSuggestions] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [addingDraftSkill, setAddingDraftSkill] = useState(false);
  const [updatingSkillEnabled, setUpdatingSkillEnabled] = useState(false);
  const [draftSkillMessage, setDraftSkillMessage] = useState<string | null>(
    null,
  );
  const [skillEnablementMessage, setSkillEnablementMessage] = useState<
    string | null
  >(null);
  const [runningSync, setRunningSync] = useState(false);
  const [syncRefreshToken, setSyncRefreshToken] = useState(0);
  const [exportingMultica, setExportingMultica] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<IssueFilters>({
    parseMode: 'all',
    query: '',
  });
  const [settingsForm, setSettingsForm] = useState<ParserSettingsForm>(() =>
    createParserSettingsForm(),
  );
  const [onboardingLanguageConfirmed, setOnboardingLanguageConfirmed] =
    useState(false);

  useEffect(() => {
    let mounted = true;

    async function loadInitialData() {
      try {
        const [projects, views, settings, status] = await Promise.all([
          fetchJson<ProjectListResponse>('/projects'),
          fetchJson<SavedViewListResponse>('/views'),
          fetchJson<SettingsResponse>('/settings'),
          fetchJson<SyncStatusResponse>('/sync/status'),
        ]);

        if (!mounted) {
          return;
        }

        setProjectsResponse(projects);
        setSavedViewsResponse(views);
        setSettingsResponse(settings);
        setSyncStatus(status.status);
        setSettingsForm(createParserSettingsForm(settings.parser));
        setSelectedProjectId(
          (current) => current ?? projects.projects[0]?.id ?? null,
        );
      } catch (loadError) {
        if (mounted) {
          setError(
            loadError instanceof Error ? loadError.message : 'Unknown error',
          );
        }
      }
    }

    void loadInitialData();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const syncViewport = () => setSmallViewport(media.matches);

    syncViewport();
    media.addEventListener('change', syncViewport);

    return () => media.removeEventListener('change', syncViewport);
  }, []);

  useEffect(() => {
    if (typeof WebSocket === 'undefined') {
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;

    void resolveSyncStatusWebSocketUrl()
      .then((url) => {
        if (closed) {
          return;
        }

        socket = new WebSocket(url);
        socket.onmessage = (event) => {
          try {
            const payload = JSON.parse(String(event.data)) as {
              type?: string;
              status?: SyncStatus;
            };
            if (payload.type !== 'sync-status' || !payload.status) {
              return;
            }

            setSyncStatus(payload.status);
            if (
              payload.status.phase === 'completed' ||
              payload.status.phase === 'failed'
            ) {
              setSyncRefreshToken((current) => current + 1);
            }
          } catch {
            // Ignore malformed status events; the HTTP fallback still works.
          }
        };
      })
      .catch(() => {
        // The status route is also read during normal data refreshes.
      });

    return () => {
      closed = true;
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setIssuesResponse(null);
      return;
    }

    let mounted = true;
    setLoadingIssues(true);
    const search = buildIssueSearchParams(selectedProjectId, filters);

    void fetchJson<IssueListResponse>(`/issues?${search.toString()}`)
      .then((payload) => {
        if (!mounted) {
          return;
        }
        startTransition(() => {
          setIssuesResponse(payload);
        });
      })
      .catch((loadError) => {
        if (mounted) {
          setError(
            loadError instanceof Error ? loadError.message : 'Unknown error',
          );
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingIssues(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [selectedProjectId, filters]);

  useEffect(() => {
    if (mainView !== 'skills') {
      return;
    }

    let mounted = true;
    setLoadingGlobalSkills(true);
    setError(null);

    void fetchJson<SkillListResponse>('/skills')
      .then((payload) => {
        if (!mounted) {
          return;
        }
        startTransition(() => {
          setGlobalSkillsResponse(payload);
        });
      })
      .catch((loadError) => {
        if (mounted) {
          setError(
            loadError instanceof Error ? loadError.message : 'Unknown error',
          );
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingGlobalSkills(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [mainView]);

  useEffect(() => {
    if (
      !selectedProjectId ||
      mainView !== 'project' ||
      projectTab !== 'skills'
    ) {
      setProjectSkillsResponse(null);
      setSkillSuggestionsResponse(null);
      return;
    }

    let mounted = true;
    setLoadingProjectSkills(true);
    setLoadingSkillSuggestions(true);
    setError(null);
    const projectQuery = encodeURIComponent(selectedProjectId);

    void Promise.all([
      fetchJson<SkillListResponse>(`/skills?projectId=${projectQuery}`),
      fetchJson<SkillSuggestionListResponse>(
        `/skills/suggestions?projectId=${projectQuery}`,
      ),
    ])
      .then(([skillsPayload, suggestionsPayload]) => {
        if (!mounted) {
          return;
        }
        startTransition(() => {
          setProjectSkillsResponse(skillsPayload);
          setSkillSuggestionsResponse(suggestionsPayload);
        });
      })
      .catch((loadError) => {
        if (mounted) {
          setError(
            loadError instanceof Error ? loadError.message : 'Unknown error',
          );
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingProjectSkills(false);
          setLoadingSkillSuggestions(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [selectedProjectId, mainView, projectTab]);

  useEffect(() => {
    if (syncRefreshToken === 0) {
      return;
    }

    let mounted = true;

    async function refreshAfterSync() {
      try {
        const [projects, settings, status] = await Promise.all([
          fetchJson<ProjectListResponse>('/projects'),
          fetchJson<SettingsResponse>('/settings'),
          fetchJson<SyncStatusResponse>('/sync/status'),
        ]);

        if (!mounted) {
          return;
        }

        setProjectsResponse(projects);
        setSettingsResponse(settings);
        setSyncStatus(status.status);
        setSettingsForm(createParserSettingsForm(settings.parser));
        setSelectedProjectId((current) => {
          if (
            current &&
            projects.projects.some((project) => project.id === current)
          ) {
            return current;
          }

          return projects.projects[0]?.id ?? null;
        });

        if (selectedProjectId) {
          const search = buildIssueSearchParams(selectedProjectId, filters);
          const issues = await fetchJson<IssueListResponse>(
            `/issues?${search.toString()}`,
          );
          if (mounted) {
            setIssuesResponse(issues);
          }
        }
      } catch (loadError) {
        if (mounted) {
          setError(
            loadError instanceof Error ? loadError.message : 'Unknown error',
          );
        }
      }
    }

    void refreshAfterSync();

    return () => {
      mounted = false;
    };
  }, [syncRefreshToken, selectedProjectId, filters]);

  const selectedProject = useMemo(
    () =>
      projectsResponse?.projects.find(
        (project) => project.id === selectedProjectId,
      ) ?? null,
    [projectsResponse, selectedProjectId],
  );

  async function openIssue(issueId: string) {
    const response = await fetchJson<IssueDetailResponse>(`/issues/${issueId}`);
    setSelectedIssue(response.issue);
  }

  function selectProject(projectId: string) {
    setMainView('project');
    setSelectedProjectId(projectId);
  }

  function openGlobalSkills() {
    setMainView('skills');
    setError(null);
    setExportMessage(null);
  }

  function openUsage() {
    setMainView('usage');
    setError(null);
    setExportMessage(null);
  }

  const sidebarVisuallyCollapsed = sidebarCollapsed || smallViewport;
  const showSidebarLabels =
    !sidebarVisuallyCollapsed || (sidebarLabelsVisible && !smallViewport);

  function toggleSidebar() {
    setSidebarLabelsVisible(true);
    setSidebarCollapsed((current) => !current);
  }

  async function openSkill(skillId: string, scopedProjectId?: string | null) {
    setDraftSkillMessage(null);
    setSkillEnablementMessage(null);
    const projectQuery = scopedProjectId
      ? `?projectId=${encodeURIComponent(scopedProjectId)}`
      : '';
    try {
      const response = await fetchJson<SkillDetailResponse>(
        `/skills/${encodeURIComponent(skillId)}${projectQuery}`,
      );
      setSelectedSkill(response.skill);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : 'Unknown error',
      );
    }
  }

  function openSkillSuggestion(suggestion: SkillSuggestion) {
    setDraftSkillMessage(null);
    setSkillEnablementMessage(null);
    const relativePath = `.agents/skills/${suggestion.name}/SKILL.md`;
    setSelectedSkill({
      id: suggestion.id,
      name: suggestion.name,
      description: suggestion.description,
      enabled: true,
      source: 'project',
      sourceLabel: 'Draft suggestion',
      sourceName: selectedProject?.id ?? null,
      path: selectedProject
        ? `${selectedProject.workspacePath}/${relativePath}`
        : relativePath,
      relativePath,
      projectId: selectedProject?.id ?? null,
      content: suggestion.suggestedSkillBody,
    });
  }

  async function addDraftSkill(target: SkillInstallTarget) {
    if (!selectedSkill) {
      return;
    }

    setAddingDraftSkill(true);
    setDraftSkillMessage(null);

    const payload: InstallSkillPayload = {
      target,
      projectId: target === 'workspace' ? selectedProject?.id : null,
      name: selectedSkill.name,
      description: selectedSkill.description,
      content: selectedSkill.content,
    };

    try {
      const apiBaseUrl = await resolveApiBaseUrl();
      const installResponse = await fetch(`${apiBaseUrl}/skills/install`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const response = (await installResponse.json()) as InstallSkillResponse;
      if (!response.ok || !response.skill) {
        throw new Error(response.message || 'Failed to add skill.');
      }

      const savedSkill = response.skill;
      const installedSkill: SkillDetail = {
        ...savedSkill,
        content: selectedSkill.content,
      };
      setSelectedSkill(installedSkill);
      setDraftSkillMessage(response.message);

      if (target === 'workspace') {
        setProjectSkillsResponse((current) =>
          current
            ? {
                ...current,
                skills: [
                  ...current.skills.filter(
                    (skill) => skill.id !== savedSkill.id,
                  ),
                  savedSkill,
                ].sort((left, right) => left.name.localeCompare(right.name)),
              }
            : current,
        );
      } else {
        setGlobalSkillsResponse((current) =>
          current
            ? {
                ...current,
                skills: [
                  ...current.skills.filter(
                    (skill) => skill.id !== savedSkill.id,
                  ),
                  savedSkill,
                ].sort((left, right) => left.name.localeCompare(right.name)),
              }
            : current,
        );
      }
    } catch (installError) {
      setDraftSkillMessage(
        installError instanceof Error
          ? installError.message
          : 'Failed to add skill.',
      );
    } finally {
      setAddingDraftSkill(false);
    }
  }

  function replaceSkillSummary(
    response: SkillListResponse | null,
    updatedSkill: SkillSummary,
  ): SkillListResponse | null {
    if (!response) {
      return response;
    }

    let replaced = false;
    const skills = response.skills.map((skill) => {
      if (skill.id !== updatedSkill.id) {
        return skill;
      }

      replaced = true;
      return updatedSkill;
    });

    return replaced
      ? {
          ...response,
          skills,
        }
      : response;
  }

  async function setSkillEnabled(skill: SkillDetail, enabled: boolean) {
    setUpdatingSkillEnabled(true);
    setSkillEnablementMessage(null);
    setDraftSkillMessage(null);

    const projectQuery = skill.projectId
      ? `?projectId=${encodeURIComponent(skill.projectId)}`
      : '';
    const payload: UpdateSkillEnabledPayload = {
      enabled,
    };

    try {
      const response = await patchJson<UpdateSkillEnabledResponse>(
        `/skills/${encodeURIComponent(skill.id)}/enabled${projectQuery}`,
        payload,
      );
      if (!response.ok || !response.skill) {
        throw new Error(response.message || 'Failed to update skill.');
      }

      const updatedSkill = response.skill;
      setSelectedSkill((current) =>
        current?.id === updatedSkill.id
          ? {
              ...updatedSkill,
              content: current.content,
            }
          : current,
      );
      setGlobalSkillsResponse((current) =>
        replaceSkillSummary(current, updatedSkill),
      );
      setProjectSkillsResponse((current) =>
        replaceSkillSummary(current, updatedSkill),
      );
      setSkillEnablementMessage(response.message);
    } catch (toggleError) {
      setSkillEnablementMessage(
        toggleError instanceof Error
          ? toggleError.message
          : 'Failed to update skill.',
      );
    } finally {
      setUpdatingSkillEnabled(false);
    }
  }

  const runSync = useCallback(
    async (
      trigger: SyncTrigger = 'manual',
      options: { maxThreads?: number } = {},
    ) => {
      setRunningSync(true);
      setError(null);
      setExportMessage(null);

      try {
        const payload: SyncRequestPayload = { trigger };
        if (options.maxThreads !== undefined) {
          payload.maxThreads = options.maxThreads;
        }

        const response = await postJson<SyncResponse>('/sync', payload);
        const [projects, settings, status] = await Promise.all([
          fetchJson<ProjectListResponse>('/projects'),
          fetchJson<SettingsResponse>('/settings'),
          fetchJson<SyncStatusResponse>('/sync/status'),
        ]);
        setProjectsResponse({
          ...projects,
          sync: response.sync,
        });
        setSettingsResponse(settings);
        setSyncStatus(response.status ?? status.status);
        setSettingsForm(createParserSettingsForm(settings.parser));
        if (!selectedProjectId) {
          setSelectedProjectId(projects.projects[0]?.id ?? null);
        }
      } catch (syncError) {
        setError(
          syncError instanceof Error ? syncError.message : 'Unknown error',
        );
      } finally {
        setRunningSync(false);
      }
    },
    [selectedProjectId],
  );

  async function saveCurrentView() {
    const name = window.prompt('Name this view');
    if (!name) {
      return;
    }

    setSavedViewsResponse(
      await postJson<SavedViewListResponse>('/views', {
        name,
        filters,
      }),
    );
  }

  async function toggleReview(issueId: string, nextValue: boolean) {
    const payload = await postJson<IssueDetailResponse>(
      `/issues/${issueId}/review`,
      {
        needsReview: nextValue,
      },
    );
    setSelectedIssue(payload.issue);
    if (selectedProjectId) {
      const search = buildIssueSearchParams(selectedProjectId, filters);
      setIssuesResponse(
        await fetchJson<IssueListResponse>(`/issues?${search.toString()}`),
      );
    }
  }

  async function openSettings() {
    setSettingsOpen(true);
    setLoadingSettings(true);
    setSettingsError(null);

    try {
      const settings = await fetchJson<SettingsResponse>('/settings');
      setSettingsResponse(settings);
      setSettingsForm(createParserSettingsForm(settings.parser));
    } catch (loadError) {
      setSettingsError(
        loadError instanceof Error ? loadError.message : 'Unknown error',
      );
    } finally {
      setLoadingSettings(false);
    }
  }

  async function saveSettings(
    options: { closeSettings?: boolean } = {},
  ): Promise<boolean> {
    setSavingSettings(true);
    setSettingsError(null);

    const payload: UpdateSettingsPayload = {
      parser: {
        provider: settingsForm.provider,
        baseUrl:
          settingsForm.provider === 'codex-cli' ? null : settingsForm.baseUrl,
        model: settingsForm.model,
        outputLanguage: settingsForm.outputLanguage,
      },
    };

    if (settingsForm.provider === 'codex-cli' && payload.parser) {
      payload.parser.apiKey = null;
    } else if (settingsForm.apiKey.trim() && payload.parser) {
      payload.parser.apiKey = settingsForm.apiKey;
    }

    try {
      const settings = await postJson<SettingsResponse>('/settings', payload);
      setSettingsResponse(settings);
      setSettingsForm(createParserSettingsForm(settings.parser));
      if (options.closeSettings !== false) {
        setSettingsOpen(false);
      }
      return true;
    } catch (saveError) {
      setSettingsError(
        saveError instanceof Error ? saveError.message : 'Unknown error',
      );
      return false;
    } finally {
      setSavingSettings(false);
    }
  }

  async function skipOnboardingSync(): Promise<void> {
    setSavingSettings(true);
    setSettingsError(null);
    setError(null);

    try {
      const settings = await postJson<SettingsResponse>('/settings', {
        onboarding: {
          skipSync: true,
        },
      });
      setSettingsResponse(settings);
      setSettingsForm(createParserSettingsForm(settings.parser));
    } catch (skipError) {
      setSettingsError(
        skipError instanceof Error ? skipError.message : 'Unknown error',
      );
    } finally {
      setSavingSettings(false);
    }
  }

  const parserReady = isParserSettingsReady(settingsResponse?.parser);
  const syncActive = runningSync || syncStatus?.state === 'syncing';
  const onboardingDisplayStep = getOnboardingDisplayStep(
    parserReady,
    onboardingLanguageConfirmed,
  );

  function applyParserPreset(preset: keyof typeof PARSER_PRESETS) {
    const next = PARSER_PRESETS[preset];
    setSettingsForm((current) => ({
      ...current,
      provider: next.provider,
      baseUrl: next.baseUrl,
      model: next.model,
      apiKey: next.apiKeyRequired ? current.apiKey : '',
      apiKeyConfigured: next.apiKeyRequired ? current.apiKeyConfigured : false,
    }));
  }

  async function exportProjectToMultica() {
    if (!selectedProjectId) {
      return;
    }

    setExportingMultica(true);
    setError(null);
    setExportMessage(null);

    try {
      const response = await postJson<ExportMulticaResponse>(
        '/export/multica',
        {
          projectId: selectedProjectId,
          includeChildren: true,
          runSync: false,
        },
      );

      const skippedSuffix =
        response.skippedChildren.length > 0
          ? ` ${response.skippedChildren.length} child issues were skipped.`
          : '';
      setExportMessage(
        `Exported ${response.exported.length} issues to Multica.${skippedSuffix}`,
      );
    } catch (exportError) {
      setError(
        exportError instanceof Error ? exportError.message : 'Unknown error',
      );
    } finally {
      setExportingMultica(false);
    }
  }

  if (!settingsResponse && !error) {
    return (
      <main className="grid h-screen place-items-center bg-white text-sm text-notion-muted">
        Loading workspace...
      </main>
    );
  }

  if (settingsResponse?.onboarding.required) {
    return (
      <OnboardingScreen
        error={settingsError}
        form={settingsForm}
        onApplyPreset={applyParserPreset}
        onChange={(field, value) =>
          setSettingsForm((current) => ({ ...current, [field]: value }))
        }
        onRunSync={async () => {
          await runSync('onboarding');
        }}
        onSaveLanguage={async () => {
          const saved = await saveSettings({ closeSettings: false });
          if (saved) {
            setOnboardingLanguageConfirmed(true);
          }
          return saved;
        }}
        onSaveProvider={() => saveSettings({ closeSettings: false })}
        onSkipToHome={skipOnboardingSync}
        saving={savingSettings}
        step={onboardingDisplayStep}
        syncActive={syncActive}
        syncError={settingsError ?? error ?? syncStatus?.latestError ?? null}
        syncStatus={syncStatus}
      />
    );
  }

  return (
    <main className="h-screen w-screen overflow-hidden flex">
      <section className="flex w-full h-full overflow-hidden">
        <motion.aside
          animate={{
            width: sidebarVisuallyCollapsed
              ? SIDEBAR_COLLAPSED_WIDTH
              : SIDEBAR_EXPANDED_WIDTH,
          }}
          aria-expanded={!sidebarVisuallyCollapsed}
          className="bg-notion-sidebar border-r border-notion-border flex flex-col py-3 shrink-0 h-full overflow-hidden"
          initial={false}
          onAnimationComplete={() => {
            if (sidebarVisuallyCollapsed) {
              setSidebarLabelsVisible(false);
            }
          }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="px-3.5 pb-3 flex justify-between items-center shrink-0">
            {showSidebarLabels && (
              <div className="flex items-center gap-2 overflow-hidden">
                <div className="w-5 h-5 flex items-center justify-center bg-black/5 rounded text-[0.75rem] font-medium text-notion-muted shrink-0">
                  S
                </div>
                {showSidebarLabels && (
                  <h1 className="w-[132px] shrink-0 truncate text-[0.875rem] font-semibold text-notion-text">
                    Stone
                  </h1>
                )}
              </div>
            )}
            <Button onClick={toggleSidebar} size="sm" variant="ghost">
              {sidebarVisuallyCollapsed ? (
                <PanelLeftOpen size={16} />
              ) : (
                <PanelLeftClose size={16} />
              )}
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className="px-2.5 py-2 grid gap-[1px]">
              <button
                className={`w-full flex items-center gap-2 rounded-md p-1.5 text-[0.875rem] transition-colors ${mainView === 'usage' ? 'bg-notion-active' : 'hover:bg-notion-hover'} ${showSidebarLabels ? 'text-left' : 'justify-center'}`}
                onClick={openUsage}
                type="button"
                title="Usage"
              >
                <div
                  className={
                    'w-6 h-6 flex items-center justify-center rounded-full font-semibold text-[0.875rem] shrink-0 bg-notion-active text-notion-muted'
                  }
                >
                  <Database size={14} />
                </div>
                {showSidebarLabels && (
                  <div className="w-[176px] shrink-0 overflow-hidden py-0.5">
                    <strong className="block truncate font-medium leading-tight">
                      Usage
                    </strong>
                  </div>
                )}
              </button>
              <button
                className={`w-full flex items-center gap-2 rounded-md p-1.5 text-[0.875rem] transition-colors ${mainView === 'skills' ? 'bg-notion-active' : 'hover:bg-notion-hover'} ${showSidebarLabels ? 'text-left' : 'justify-center'}`}
                onClick={openGlobalSkills}
                type="button"
                title="Skills"
              >
                <div
                  className={
                    'w-6 h-6 flex items-center justify-center rounded-full font-semibold text-[0.875rem] shrink-0 bg-notion-active text-notion-muted'
                  }
                >
                  <Sparkles size={14} />
                </div>
                {showSidebarLabels && (
                  <div className="w-[176px] shrink-0 overflow-hidden py-0.5">
                    <strong className="block truncate font-medium leading-tight">
                      Skills
                    </strong>
                  </div>
                )}
              </button>
            </div>
            {showSidebarLabels ? (
              <p className="mx-3.5 mt-2 mb-1 w-[176px] overflow-hidden whitespace-nowrap uppercase tracking-[0.05em] text-[0.68rem] font-semibold text-notion-muted">
                Workspace
              </p>
            ) : (
              <div className="h-4" />
            )}
            <div className="px-2.5 grid gap-[1px]">
              {projectsResponse?.projects.map((project) => (
                <button
                  className={`w-full flex items-center gap-2 rounded-md p-1.5 text-[0.875rem] transition-colors ${showSidebarLabels ? 'text-left' : 'justify-center'} ${mainView === 'project' && project.id === selectedProjectId ? 'bg-notion-active' : 'hover:bg-notion-hover'}`}
                  key={project.id}
                  onClick={() => selectProject(project.id)}
                  type="button"
                  title={project.name}
                >
                  <div
                    className={`w-6 h-6 flex items-center justify-center rounded-full font-semibold text-[0.875rem] shrink-0 ${mainView === 'project' && project.id === selectedProjectId ? 'bg-notion-blue text-white' : 'bg-notion-active text-notion-muted'}`}
                  >
                    {project.name.charAt(0).toUpperCase()}
                  </div>
                  {showSidebarLabels && (
                    <div className="w-[176px] shrink-0 overflow-hidden py-0.5">
                      <strong className="block truncate font-medium leading-tight">
                        {project.name}
                      </strong>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="px-2.5 pt-3 grid gap-[1px] border-t border-notion-border/50 shrink-0">
            <button
              className={`w-full flex items-center gap-2 rounded-md p-1.5 text-[0.875rem] hover:bg-notion-hover transition-colors ${showSidebarLabels ? 'text-left' : 'justify-center'}`}
              type="button"
              title="Settings"
              onClick={() => void openSettings()}
            >
              <Settings size={16} />
              {showSidebarLabels && (
                <span className="w-[176px] shrink-0 overflow-hidden truncate text-left">
                  Settings
                </span>
              )}
            </button>
          </div>
        </motion.aside>

        <section className="flex-1 min-w-0 bg-white flex flex-col h-full">
          <header className="px-12 py-3 flex justify-between items-center border-b border-notion-border shrink-0">
            <div className="flex items-center gap-2 text-[0.875rem]">
              {mainView === 'skills' ? (
                <span className="font-medium">Skills</span>
              ) : mainView === 'usage' ? (
                <span className="font-medium">Usage</span>
              ) : (
                <>
                  <span className="text-notion-muted">Projects</span>
                  <ChevronRight
                    size={14}
                    className="text-notion-border-strong"
                  />
                  <span className="font-medium">
                    {selectedProject?.name ?? 'Select project'}
                  </span>
                </>
              )}
            </div>
            <SyncStatusPill
              fallbackSync={
                settingsResponse?.sync ?? projectsResponse?.sync ?? null
              }
              onRunSync={() => runSync('manual')}
              status={syncStatus}
              syncActive={syncActive}
            />
          </header>

          <div className="flex-1 overflow-y-auto">
            {mainView === 'skills' ? (
              <>
                <div className="px-4 pt-6 pb-3 flex items-start gap-3 sm:px-8 sm:pt-8 lg:px-12">
                  <div className="w-10 h-10 flex items-center justify-center bg-notion-active text-notion-muted rounded-full font-semibold text-xl shrink-0">
                    <Sparkles size={20} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                      Skills
                    </h2>
                    <p className="mt-2 text-sm text-notion-muted">
                      Global Codex, agent, and enabled plugin skills.
                    </p>
                  </div>
                </div>

                {error ? (
                  <p className="mx-4 mb-3 bg-red-50 border border-red-100 p-3 rounded text-sm text-red-800 sm:mx-8 lg:mx-12">
                    {error}
                  </p>
                ) : null}

                <div className="px-4 py-3 pb-12 sm:px-8 lg:px-12">
                  <SkillList
                    emptyMessage="No global skills were found."
                    loading={loadingGlobalSkills}
                    onOpen={(skillId) => void openSkill(skillId)}
                    skills={globalSkillsResponse?.skills ?? []}
                  />
                </div>
              </>
            ) : mainView === 'usage' ? (
              <UsagePage refreshToken={syncRefreshToken} />
            ) : (
              <>
                <div className="px-12 pt-8 pb-3 flex items-center gap-3">
                  <div className="w-10 h-10 flex items-center justify-center bg-notion-active text-notion-muted rounded-full font-semibold text-xl shrink-0">
                    {selectedProject?.name.charAt(0) ?? 'P'}
                  </div>
                  <h2 className="text-4xl font-bold tracking-tight">
                    {selectedProject?.name ?? 'Select a project'}
                  </h2>
                </div>

                <div className="px-12 pb-4">
                  <ProjectTabBar active={projectTab} onChange={setProjectTab} />
                </div>

                {projectTab === 'issues' ? (
                  <>
                    <div className="px-12 py-1 flex items-center justify-end border-y border-notion-border overflow-x-auto sticky top-0 bg-white z-10">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center bg-notion-hover rounded px-2">
                          <Search size={14} className="text-notion-muted" />
                          <Input
                            onChange={(event) =>
                              setFilters((current) => ({
                                ...current,
                                query: event.target.value,
                              }))
                            }
                            placeholder="Search"
                            value={filters.query ?? ''}
                            className="w-32 text-[0.81rem] h-7 bg-transparent border-none outline-none focus:bg-transparent"
                          />
                        </div>
                        <Button variant="ghost" size="sm">
                          <Filter size={14} /> Filter
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void exportProjectToMultica()}
                          disabled={!selectedProjectId || exportingMultica}
                        >
                          <ExternalLink size={14} />
                          {exportingMultica
                            ? 'Exporting…'
                            : 'Export to Multica'}
                        </Button>
                      </div>
                    </div>

                    <div className="px-12 py-2 flex items-center gap-2 overflow-x-auto">
                      <Button
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            needsReview: !current.needsReview,
                          }))
                        }
                        variant="ghost"
                        size="sm"
                        className={
                          filters.needsReview
                            ? 'text-notion-blue'
                            : 'text-notion-muted'
                        }
                      >
                        <ListTodo size={14} /> Review
                      </Button>
                      <Button
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            hasCommits: !current.hasCommits,
                          }))
                        }
                        variant="ghost"
                        size="sm"
                        className={
                          filters.hasCommits
                            ? 'text-notion-blue'
                            : 'text-notion-muted'
                        }
                      >
                        <GitCommit size={14} /> Commits
                      </Button>
                      <Button
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            hasTags: !current.hasTags,
                          }))
                        }
                        variant="ghost"
                        size="sm"
                        className={
                          filters.hasTags
                            ? 'text-notion-blue'
                            : 'text-notion-muted'
                        }
                      >
                        <Tags size={14} /> Tags
                      </Button>
                      <Button
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            hasImages: !current.hasImages,
                          }))
                        }
                        variant="ghost"
                        size="sm"
                        className={
                          filters.hasImages
                            ? 'text-notion-blue'
                            : 'text-notion-muted'
                        }
                      >
                        <ImageIcon size={14} /> Images
                      </Button>
                    </div>
                  </>
                ) : null}

                {error ? (
                  <p className="mx-12 mb-3 bg-red-50 border border-red-100 p-3 rounded text-sm text-red-800">
                    {error}
                  </p>
                ) : null}

                {exportMessage ? (
                  <p className="mx-12 mb-3 rounded border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-800">
                    {exportMessage}
                  </p>
                ) : null}

                <div className="px-4 pt-4 pb-12 sm:px-8 lg:px-12 border-t border-notion-border ">
                  {projectTab === 'skills' ? (
                    <>
                      <SkillSuggestionList
                        signalCount={skillSuggestionsResponse?.signalCount ?? 0}
                        loading={loadingSkillSuggestions}
                        onOpen={openSkillSuggestion}
                        suggestions={
                          skillSuggestionsResponse?.suggestions ?? []
                        }
                      />

                      <section className="grid gap-3">
                        <div>
                          <p className="mb-1 text-[0.75rem] font-semibold uppercase tracking-wider text-notion-muted">
                            Project skills
                          </p>
                          <h3 className="text-lg font-semibold tracking-tight text-notion-text">
                            Local catalog
                          </h3>
                        </div>
                        <SkillList
                          emptyMessage={
                            selectedProjectId
                              ? 'No project skills were found.'
                              : 'Select a project to load skills.'
                          }
                          loading={loadingProjectSkills}
                          onOpen={(skillId) =>
                            void openSkill(skillId, selectedProjectId)
                          }
                          skills={projectSkillsResponse?.skills ?? []}
                        />
                      </section>
                    </>
                  ) : loadingIssues ? (
                    <TableEmpty>Loading issues...</TableEmpty>
                  ) : issuesResponse?.issues.length ? (
                    <TableWrapper>
                      <Table className="min-w-[820px]">
                        <thead>
                          <tr className="border-b border-notion-border">
                            <th className="w-full min-w-72 py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                              Title
                            </th>
                            <th className="min-w-44 py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                              Tags
                            </th>
                            <th className="w-[1%] py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                              Images
                            </th>
                            <th className="w-[1%] py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                              Commits
                            </th>
                            <th className="w-[1%] py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                              Parse
                            </th>
                            <th className="w-[1%] py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                              Review
                            </th>
                            <th className="w-[1%] py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                              Updated
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {issuesResponse.issues.map((issue) => (
                            <tr
                              className="hover:bg-notion-hover group border-b border-notion-border"
                              key={issue.id}
                            >
                              <td className="w-full py-2 px-3 align-top">
                                <button
                                  className="w-full text-left focus:outline-none"
                                  onClick={() => void openIssue(issue.id)}
                                  type="button"
                                >
                                  <strong className="block text-sm font-medium">
                                    {issue.title}
                                  </strong>
                                </button>
                              </td>
                              <td className="min-w-44 py-2 px-3 align-top">
                                <div className="flex flex-wrap gap-1">
                                  {issue.tags.slice(0, 3).map((tag) => (
                                    <Badge
                                      className={getTagBadgeClass(tag)}
                                      key={tag}
                                    >
                                      {tag}
                                    </Badge>
                                  ))}
                                </div>
                              </td>
                              <td className="py-2 px-3 align-top text-sm whitespace-nowrap">
                                {issue.stats.imageCount}
                              </td>
                              <td className="py-2 px-3 align-top text-sm whitespace-nowrap">
                                {issue.git.commits.length}
                              </td>
                              <td className="py-2 px-3 align-top whitespace-nowrap">
                                <Badge>{issue.parseMode}</Badge>
                              </td>
                              <td className="py-2 px-3 align-top whitespace-nowrap">
                                <Badge>
                                  {issue.needsReview ? 'Review' : 'Reviewed'}
                                </Badge>
                              </td>
                              <td className="py-2 px-3 align-top text-sm text-notion-muted whitespace-nowrap">
                                {new Date(issue.updatedAt).toLocaleDateString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </TableWrapper>
                  ) : (
                    <TableEmpty>
                      {selectedProjectId
                        ? 'No issues match the current filters.'
                        : 'Select a project to load issues.'}
                    </TableEmpty>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </section>

      <DetailSheet
        issue={selectedIssue}
        onClose={() => setSelectedIssue(null)}
        onReviewToggle={toggleReview}
      />
      <SkillDetailSheet
        addingDraftSkill={addingDraftSkill}
        draftSkillMessage={draftSkillMessage}
        onAddDraftSkill={addDraftSkill}
        onUpdateSkillEnabled={setSkillEnabled}
        skill={selectedSkill}
        skillEnablementMessage={skillEnablementMessage}
        onClose={() => {
          setSelectedSkill(null);
          setDraftSkillMessage(null);
          setSkillEnablementMessage(null);
        }}
        updatingSkillEnabled={updatingSkillEnabled}
      />
      <SettingsModal
        error={settingsError}
        form={settingsForm}
        loading={loadingSettings}
        onApplyPreset={applyParserPreset}
        onChange={(field, value) =>
          setSettingsForm((current) => ({ ...current, [field]: value }))
        }
        onClose={() => setSettingsOpen(false)}
        onSave={() => saveSettings()}
        open={settingsOpen}
        parserReady={parserReady}
        sync={settingsResponse?.sync ?? null}
        syncHistory={settingsResponse?.syncHistory ?? []}
        saving={savingSettings}
      />
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<BoardPage />} path="/" />
    </Routes>
  );
}
