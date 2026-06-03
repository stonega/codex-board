import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  ChevronRight,
  Database,
  ExternalLink,
  Filter,
  GitCommit,
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
  Tags,
  X,
} from 'lucide-react';
import { startTransition, useEffect, useMemo, useState } from 'react';
import { Route, Routes } from 'react-router';

import type {
  ExportMulticaResponse,
  IssueDetailResponse,
  IssueFilters,
  IssueListResponse,
  IssuePriority,
  IssueStatus,
  ParsedIssue,
  ProjectListResponse,
  SavedViewListResponse,
  SettingsResponse,
  SyncDiagnostics,
  SyncResponse,
  UpdateSettingsPayload,
} from '@codex-boards/domain';

import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Select } from './components/ui/select';
import { Sheet } from './components/ui/sheet';
import { Table, TableEmpty, TableWrapper } from './components/ui/table';
import { resolveApiBaseUrl } from './lib/runtime';

const STATUS_OPTIONS: Array<IssueStatus | 'all'> = [
  'all',
  'todo',
  'in_progress',
  'blocked',
  'done',
  'unknown',
];
const PRIORITY_OPTIONS: Array<IssuePriority | 'all'> = [
  'all',
  'urgent',
  'high',
  'medium',
  'low',
  'unknown',
];
const PARSER_PRESETS = {
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3-flash-preview',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
  },
} as const;

function formatLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const TAG_BADGE_CLASSES = [
  'border-sky-200 bg-sky-50 text-sky-700',
  'border-emerald-200 bg-emerald-50 text-emerald-700',
  'border-amber-200 bg-amber-50 text-amber-700',
  'border-rose-200 bg-rose-50 text-rose-700',
  'border-violet-200 bg-violet-50 text-violet-700',
  'border-cyan-200 bg-cyan-50 text-cyan-700',
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

function buildIssueSearchParams(
  projectId: string,
  filters: IssueFilters,
): URLSearchParams {
  const search = new URLSearchParams({ projectId });

  if (filters.status && filters.status !== 'all') {
    search.set('status', filters.status);
  }
  if (filters.priority && filters.priority !== 'all') {
    search.set('priority', filters.priority);
  }
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
                {issue.kind === 'parent' ? 'Parent issue' : 'Sub issue'}
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
                  Status
                </p>
                <Badge>{formatLabel(issue.status)}</Badge>
              </div>
              <div>
                <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                  Priority
                </p>
                <Badge>{formatLabel(issue.priority)}</Badge>
              </div>
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
                  Assignee
                </p>
                <p className="text-sm">{issue.assignee ?? 'Unassigned'}</p>
              </div>
              <div>
                <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                  Due date
                </p>
                <p className="text-sm">{issue.dueDate ?? 'Unset'}</p>
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
                      issue.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)
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

            <div className="pt-4 border-t border-notion-border">
              <p className="text-[0.75rem] font-medium text-notion-muted uppercase tracking-wider mb-2">
                Sub issues
              </p>
              {issue.children && issue.children.length > 0 ? (
                <div className="grid gap-3">
                  {issue.children.map((child) => (
                    <article
                      className="p-2 rounded hover:bg-notion-hover transition-colors"
                      key={child.id}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <strong className="text-sm font-medium">
                            {child.title}
                          </strong>
                          <p className="text-[0.81rem] text-notion-muted mt-0.5">
                            {child.summary}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <Badge>{formatLabel(child.status)}</Badge>
                          <Badge>{formatLabel(child.priority)}</Badge>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-notion-muted">
                  No sub issues extracted for this thread.
                </p>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </Sheet>
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
  form: {
    baseUrl: string;
    model: string;
    apiKey: string;
    apiKeyConfigured: boolean;
  };
  sync: SyncDiagnostics | null;
  syncHistory: SyncDiagnostics[];
  parserReady: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => Promise<void>;
  onChange: (field: 'baseUrl' | 'model' | 'apiKey', value: string) => void;
  onApplyPreset: (preset: keyof typeof PARSER_PRESETS) => void;
}) {
  const [activeSection, setActiveSection] = useState<'parser' | 'history'>(
    'parser',
  );

  return (
    <Sheet open={open} onClose={onClose} title="Settings" variant="modal">
      <div className="grid gap-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="mb-1 text-[0.75rem] font-semibold uppercase tracking-wider text-notion-muted">
              Workspace settings
            </p>
            <h2 className="text-2xl font-bold tracking-tight text-notion-text">
              Settings
            </h2>
          </div>
          <Button onClick={onClose} variant="ghost" size="sm">
            <X size={16} />
          </Button>
        </header>

        <div className="grid gap-8 md:grid-cols-[180px_1px_minmax(0,1fr)]">
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
                      Configure the OpenAI-compatible parser target used for the
                      next sync run.
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
                        form.apiKeyConfigured
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                          : ''
                      }
                    >
                      {form.apiKeyConfigured
                        ? 'API key configured'
                        : 'API key missing'}
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
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(PARSER_PRESETS).map(([id, preset]) => (
                      <button
                        key={id}
                        onClick={() =>
                          onApplyPreset(id as keyof typeof PARSER_PRESETS)
                        }
                        type="button"
                        className="px-3 py-1.5 rounded border border-notion-border text-[0.875rem] hover:bg-notion-hover transition-colors font-medium text-notion-text bg-white shadow-sm"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-5">
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
  const [issuesResponse, setIssuesResponse] =
    useState<IssueListResponse | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<ParsedIssue | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [runningSync, setRunningSync] = useState(false);
  const [exportingMultica, setExportingMultica] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<IssueFilters>({
    status: 'all',
    priority: 'all',
    parseMode: 'all',
    query: '',
  });
  const [settingsForm, setSettingsForm] = useState({
    baseUrl: '',
    model: '',
    apiKey: '',
    apiKeyConfigured: false,
  });

  useEffect(() => {
    let mounted = true;

    async function loadInitialData() {
      try {
        const [projects, views, settings] = await Promise.all([
          fetchJson<ProjectListResponse>('/projects'),
          fetchJson<SavedViewListResponse>('/views'),
          fetchJson<SettingsResponse>('/settings'),
        ]);

        if (!mounted) {
          return;
        }

        setProjectsResponse(projects);
        setSavedViewsResponse(views);
        setSettingsResponse(settings);
        setSettingsForm({
          baseUrl: settings.parser.baseUrl ?? '',
          model: settings.parser.model ?? '',
          apiKey: '',
          apiKeyConfigured: settings.parser.apiKeyConfigured,
        });
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

  async function runSync() {
    setRunningSync(true);
    setError(null);
    setExportMessage(null);

    try {
      const response = await postJson<SyncResponse>('/sync');
      const [projects, settings] = await Promise.all([
        fetchJson<ProjectListResponse>('/projects'),
        fetchJson<SettingsResponse>('/settings'),
      ]);
      setProjectsResponse({
        ...projects,
        sync: response.sync,
      });
      setSettingsResponse(settings);
      setSettingsForm((current) => ({
        ...current,
        baseUrl: settings.parser.baseUrl ?? '',
        model: settings.parser.model ?? '',
        apiKey: '',
        apiKeyConfigured: settings.parser.apiKeyConfigured,
      }));
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
  }

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
      setSettingsForm({
        baseUrl: settings.parser.baseUrl ?? '',
        model: settings.parser.model ?? '',
        apiKey: '',
        apiKeyConfigured: settings.parser.apiKeyConfigured,
      });
    } catch (loadError) {
      setSettingsError(
        loadError instanceof Error ? loadError.message : 'Unknown error',
      );
    } finally {
      setLoadingSettings(false);
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
    setSettingsError(null);

    const payload: UpdateSettingsPayload = {
      parser: {
        baseUrl: settingsForm.baseUrl,
        model: settingsForm.model,
      },
    };

    if (settingsForm.apiKey.trim() && payload.parser) {
      payload.parser.apiKey = settingsForm.apiKey;
    }

    try {
      const settings = await postJson<SettingsResponse>('/settings', payload);
      setSettingsResponse(settings);
      setSettingsForm({
        baseUrl: settings.parser.baseUrl ?? '',
        model: settings.parser.model ?? '',
        apiKey: '',
        apiKeyConfigured: settings.parser.apiKeyConfigured,
      });
      setSettingsOpen(false);
    } catch (saveError) {
      setSettingsError(
        saveError instanceof Error ? saveError.message : 'Unknown error',
      );
    } finally {
      setSavingSettings(false);
    }
  }

  const parserReady = Boolean(
    settingsResponse?.parser.baseUrl &&
      settingsResponse?.parser.model &&
      settingsResponse?.parser.apiKeyConfigured,
  );

  function applyParserPreset(preset: keyof typeof PARSER_PRESETS) {
    const next = PARSER_PRESETS[preset];
    setSettingsForm((current) => ({
      ...current,
      baseUrl: next.baseUrl,
      model: next.model,
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

  return (
    <main className="h-screen w-screen overflow-hidden flex">
      <section className="flex w-full h-full overflow-hidden">
        <motion.aside
          className={`bg-notion-sidebar border-r border-notion-border flex flex-col py-3 shrink-0 h-full ${sidebarCollapsed ? 'w-16' : 'w-60'}`}
          layout
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="px-3.5 pb-3 flex justify-between items-center shrink-0">
            <div className="flex items-center gap-2 overflow-hidden">
              <div className="w-5 h-5 flex items-center justify-center bg-black/5 rounded text-[0.75rem] font-medium text-notion-muted shrink-0">
                S
              </div>
              {!sidebarCollapsed && (
                <h1 className="text-[0.875rem] font-semibold text-notion-text truncate">
                  Stone
                </h1>
              )}
            </div>
            <Button
              onClick={() => setSidebarCollapsed((current) => !current)}
              size="sm"
              variant="ghost"
            >
              <PanelLeftClose size={16} />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!sidebarCollapsed ? (
              <p className="mx-3.5 mt-2 mb-1 uppercase tracking-[0.05em] text-[0.68rem] font-semibold text-notion-muted">
                Workspace
              </p>
            ) : (
              <div className="h-4" />
            )}
            <div className="px-2.5 grid gap-[1px]">
              {projectsResponse?.projects.map((project) => (
                <button
                  className={`w-full flex items-center gap-2 rounded-md p-1.5 text-[0.875rem] transition-colors text-left ${project.id === selectedProjectId ? 'bg-notion-active' : 'hover:bg-notion-hover'}`}
                  key={project.id}
                  onClick={() => setSelectedProjectId(project.id)}
                  type="button"
                  title={project.name}
                >
                  <div
                    className={`w-6 h-6 flex items-center justify-center rounded-full font-semibold text-[0.875rem] shrink-0 ${project.id === selectedProjectId ? 'bg-notion-blue text-white' : 'bg-notion-active text-notion-muted'}`}
                  >
                    {project.name.charAt(0).toUpperCase()}
                  </div>
                  {!sidebarCollapsed && (
                    <div className="flex-1 min-w-0 py-0.5">
                      <strong className="font-medium block break-words leading-tight">
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
              className={`w-full flex items-center gap-2 rounded-md p-1.5 text-[0.875rem] transition-colors ${runningSync ? 'cursor-wait text-notion-muted' : 'hover:bg-notion-hover'} ${sidebarCollapsed ? 'justify-center' : 'text-left'}`}
              type="button"
              onClick={() => void runSync()}
              title={runningSync ? 'Syncing' : 'Run Sync'}
              disabled={runningSync}
            >
              <RefreshCw
                size={16}
                className={runningSync ? 'animate-spin' : undefined}
              />
              {!sidebarCollapsed && (runningSync ? 'Syncing…' : 'Run Sync')}
            </button>
            <button
              className={`w-full flex items-center gap-2 rounded-md p-1.5 text-[0.875rem] hover:bg-notion-hover transition-colors ${sidebarCollapsed ? 'justify-center' : 'text-left'}`}
              type="button"
              title="Settings"
              onClick={() => void openSettings()}
            >
              <Settings size={16} /> {!sidebarCollapsed && 'Settings'}
            </button>
          </div>
        </motion.aside>

        <section className="flex-1 min-w-0 bg-white flex flex-col h-full">
          <header className="px-12 py-3 flex justify-between items-center border-b border-notion-border shrink-0">
            <div className="flex items-center gap-2 text-[0.875rem]">
              <span className="text-notion-muted">Projects</span>
              <ChevronRight size={14} className="text-notion-border-strong" />
              <span className="font-medium">
                {selectedProject?.name ?? 'Select project'}
              </span>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            <div className="px-12 pt-8 pb-3 flex items-center gap-3">
              <div className="w-10 h-10 flex items-center justify-center bg-notion-active text-notion-muted rounded-full font-semibold text-xl shrink-0">
                {selectedProject?.name.charAt(0) ?? 'P'}
              </div>
              <h2 className="text-4xl font-bold tracking-tight">
                {selectedProject?.name ?? 'Select a project'}
              </h2>
            </div>

            <div className="px-12 py-1 flex items-center justify-end border-b border-notion-border overflow-x-auto sticky top-0 bg-white z-10">
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
                  {exportingMultica ? 'Exporting…' : 'Export to Multica'}
                </Button>
                <Button variant="default" size="sm">
                  <Plus size={14} /> New
                </Button>
              </div>
            </div>

            <div className="px-12 py-2 flex items-center gap-2 overflow-x-auto">
              <Select
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value as IssueStatus | 'all',
                  }))
                }
                value={filters.status ?? 'all'}
                className="text-[0.81rem] h-7"
              >
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {formatLabel(status)}
                  </option>
                ))}
              </Select>
              <Select
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    priority: event.target.value as IssuePriority | 'all',
                  }))
                }
                value={filters.priority ?? 'all'}
                className="text-[0.81rem] h-7"
              >
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>
                    {formatLabel(priority)}
                  </option>
                ))}
              </Select>
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
                  filters.needsReview ? 'text-notion-blue' : 'text-notion-muted'
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
                  filters.hasCommits ? 'text-notion-blue' : 'text-notion-muted'
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
                  filters.hasTags ? 'text-notion-blue' : 'text-notion-muted'
                }
              >
                <Tags size={14} /> Tags
              </Button>
            </div>

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

            <div className="pb-12">
              {loadingIssues ? (
                <TableEmpty>Loading issues...</TableEmpty>
              ) : issuesResponse?.issues.length ? (
                <Table className="w-full">
                  <thead>
                    <tr className="border-b border-notion-border">
                      <th className="text-left py-2 px-3 text-notion-muted font-medium text-sm whitespace-nowrap w-full">
                        Title
                      </th>
                      <th className="text-left py-2 px-3 text-notion-muted font-medium text-sm whitespace-nowrap">
                        Status
                      </th>
                      <th className="text-left py-2 px-3 text-notion-muted font-medium text-sm whitespace-nowrap">
                        Priority
                      </th>
                      <th className="text-left py-2 px-3 text-notion-muted font-medium text-sm whitespace-nowrap">
                        Tags
                      </th>
                      <th className="text-left py-2 px-3 text-notion-muted font-medium text-sm whitespace-nowrap">
                        Sub issues
                      </th>
                      <th className="text-left py-2 px-3 text-notion-muted font-medium text-sm whitespace-nowrap">
                        Commits
                      </th>
                      <th className="text-left py-2 px-3 text-notion-muted font-medium text-sm whitespace-nowrap">
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
                        <td className="py-2 px-3 align-top w-full">
                          <button
                            className="w-full text-left focus:outline-none"
                            onClick={() => void openIssue(issue.id)}
                            type="button"
                          >
                            <strong className="font-medium text-sm block">
                              {issue.title}
                            </strong>
                          </button>
                        </td>
                        <td className="py-2 px-3 align-top">
                          <Badge>{formatLabel(issue.status)}</Badge>
                        </td>
                        <td className="py-2 px-3 align-top">
                          <Badge>{formatLabel(issue.priority)}</Badge>
                        </td>
                        <td className="py-2 px-3 align-top">
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
                        <td className="py-2 px-3 align-top text-sm">
                          {issue.subIssueCount}
                        </td>
                        <td className="py-2 px-3 align-top text-sm">
                          {issue.git.commits.length}
                        </td>
                        <td className="py-2 px-3 align-top text-sm text-notion-muted">
                          {new Date(issue.updatedAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <TableEmpty>
                  {selectedProjectId
                    ? 'No issues match the current filters.'
                    : 'Select a project to load issues.'}
                </TableEmpty>
              )}
            </div>
          </div>
        </section>
      </section>

      <DetailSheet
        issue={selectedIssue}
        onClose={() => setSelectedIssue(null)}
        onReviewToggle={toggleReview}
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
        onSave={saveSettings}
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
