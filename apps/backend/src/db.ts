import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type {
  IssueDetailResponse,
  IssueFilters,
  IssueListResponse,
  ParsedIssue,
  ParserProvider,
  ProjectListResponse,
  ProjectSummary,
  SavedView,
  SavedViewListResponse,
  SyncDiagnostics,
  ThreadImage,
  UsageRefreshSummary,
} from '../../../packages/domain/src/index';

function parseJson<T>(value: string | null): T {
  if (!value) {
    return [] as T;
  }

  return JSON.parse(value) as T;
}

export interface UsageEventRecord {
  recordId: string;
  sessionId: string;
  threadId: string;
  eventTimestamp: string;
  sourceFile: string;
  lineNumber: number;
  model: string | null;
  effort: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  isArchived: boolean;
}

export interface OnboardingPreferences {
  skipSync: boolean;
}

export interface SyncFileState {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  parserFingerprint: string;
  threadId: string | null;
}

export interface SkillThreadSignalRecord {
  threadId: string;
  projectId: string;
  rolloutPath: string;
  userPrompt: string;
  assistantResponse: string;
  taskTitle: string;
  taskSummary: string;
  tags: string[];
  updatedAt: string;
}

export class BoardsDatabase {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        parser_base_url TEXT,
        parser_model TEXT,
        response_models_json TEXT NOT NULL DEFAULT '[]',
        ai_request_count INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        scanned_files INTEGER NOT NULL,
        changed_files INTEGER NOT NULL,
        imported_threads INTEGER NOT NULL,
        skipped_threads INTEGER NOT NULL,
        ai_parsed_issues INTEGER NOT NULL,
        fallback_issues INTEGER NOT NULL,
        review_issues INTEGER NOT NULL,
        errors_json TEXT NOT NULL,
        parse_log_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS sync_files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        parser_fingerprint TEXT NOT NULL DEFAULT 'fallback-only',
        thread_id TEXT,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repository TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        last_updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parse_mode TEXT NOT NULL,
        confidence REAL NOT NULL,
        needs_review INTEGER NOT NULL,
        repository TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        branch TEXT,
        commits_json TEXT NOT NULL,
        git_tags_json TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        parse_payload_preview TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        command_count INTEGER NOT NULL DEFAULT 0,
        image_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_issues_thread_id ON issues(thread_id);

      CREATE TABLE IF NOT EXISTS thread_images (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        mime_type TEXT,
        filename TEXT,
        original_url TEXT,
        local_path TEXT,
        width INTEGER,
        height INTEGER,
        size_bytes INTEGER,
        caption TEXT,
        message_excerpt TEXT,
        created_at TEXT,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_thread_images_issue_id ON thread_images(issue_id);
      CREATE INDEX IF NOT EXISTS idx_thread_images_thread_id ON thread_images(thread_id);

      CREATE TABLE IF NOT EXISTS skill_thread_signals (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        assistant_response TEXT NOT NULL,
        task_title TEXT NOT NULL,
        task_summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_skill_thread_signals_project_id
        ON skill_thread_signals(project_id);

      CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        record_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        source_file TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        model TEXT,
        effort TEXT,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        uncached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(event_timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_events_thread_id ON usage_events(thread_id);
    `);

    const syncRunColumns = this.db
      .query('PRAGMA table_info(sync_runs)')
      .all() as Array<{ name: string }>;
    const hasParseLogColumn = syncRunColumns.some(
      (column) => column.name === 'parse_log_json',
    );
    const hasParserBaseUrlColumn = syncRunColumns.some(
      (column) => column.name === 'parser_base_url',
    );
    const hasParserModelColumn = syncRunColumns.some(
      (column) => column.name === 'parser_model',
    );
    const hasResponseModelsColumn = syncRunColumns.some(
      (column) => column.name === 'response_models_json',
    );
    const hasAiRequestCountColumn = syncRunColumns.some(
      (column) => column.name === 'ai_request_count',
    );
    const hasPromptTokensColumn = syncRunColumns.some(
      (column) => column.name === 'prompt_tokens',
    );
    const hasCompletionTokensColumn = syncRunColumns.some(
      (column) => column.name === 'completion_tokens',
    );
    const hasTotalTokensColumn = syncRunColumns.some(
      (column) => column.name === 'total_tokens',
    );
    const syncFileColumns = this.db
      .query('PRAGMA table_info(sync_files)')
      .all() as Array<{ name: string }>;
    const hasParserFingerprintColumn = syncFileColumns.some(
      (column) => column.name === 'parser_fingerprint',
    );
    const hasThreadIdColumn = syncFileColumns.some(
      (column) => column.name === 'thread_id',
    );
    const issueColumns = this.db
      .query('PRAGMA table_info(issues)')
      .all() as Array<{
      name: string;
    }>;
    const needsIssueTableRebuild =
      issueColumns.some((column) =>
        [
          'parent_issue_id',
          'kind',
          'status',
          'priority',
          'assignee',
          'due_date',
          'sub_issue_count',
        ].includes(column.name),
      ) ||
      !issueColumns.some((column) => column.name === 'started_at') ||
      !issueColumns.some((column) => column.name === 'message_count') ||
      !issueColumns.some((column) => column.name === 'image_count');

    if (!hasParseLogColumn) {
      this.db.exec(
        "ALTER TABLE sync_runs ADD COLUMN parse_log_json TEXT NOT NULL DEFAULT '[]'",
      );
    }

    if (!hasParserBaseUrlColumn) {
      this.db.exec('ALTER TABLE sync_runs ADD COLUMN parser_base_url TEXT');
    }

    if (!hasParserModelColumn) {
      this.db.exec('ALTER TABLE sync_runs ADD COLUMN parser_model TEXT');
    }

    if (!hasResponseModelsColumn) {
      this.db.exec(
        "ALTER TABLE sync_runs ADD COLUMN response_models_json TEXT NOT NULL DEFAULT '[]'",
      );
    }

    if (!hasAiRequestCountColumn) {
      this.db.exec(
        'ALTER TABLE sync_runs ADD COLUMN ai_request_count INTEGER NOT NULL DEFAULT 0',
      );
    }

    if (!hasPromptTokensColumn) {
      this.db.exec(
        'ALTER TABLE sync_runs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0',
      );
    }

    if (!hasCompletionTokensColumn) {
      this.db.exec(
        'ALTER TABLE sync_runs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0',
      );
    }

    if (!hasTotalTokensColumn) {
      this.db.exec(
        'ALTER TABLE sync_runs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0',
      );
    }

    if (!hasParserFingerprintColumn) {
      this.db.exec(
        "ALTER TABLE sync_files ADD COLUMN parser_fingerprint TEXT NOT NULL DEFAULT 'fallback-only'",
      );
    }

    if (!hasThreadIdColumn) {
      this.db.exec('ALTER TABLE sync_files ADD COLUMN thread_id TEXT');
    }

    if (needsIssueTableRebuild) {
      this.rebuildIssuesTable();
    }
  }

  private rebuildIssuesTable(): void {
    this.db.exec(`
      PRAGMA foreign_keys = OFF;

      DROP TABLE IF EXISTS issues_next;

      CREATE TABLE IF NOT EXISTS issues_next (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        parse_mode TEXT NOT NULL,
        confidence REAL NOT NULL,
        needs_review INTEGER NOT NULL,
        repository TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        branch TEXT,
        commits_json TEXT NOT NULL,
        git_tags_json TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        parse_payload_preview TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        command_count INTEGER NOT NULL DEFAULT 0,
        image_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      INSERT OR REPLACE INTO issues_next (
        id, thread_id, project_id, title, tags_json, summary, started_at, updated_at,
        parse_mode, confidence, needs_review, repository, workspace_path, branch,
        commits_json, git_tags_json, rollout_path, session_id, warnings_json,
        parse_payload_preview, message_count, command_count, image_count
      )
      SELECT
        project_id || ':' || thread_id,
        thread_id,
        project_id,
        title,
        tags_json,
        summary,
        updated_at,
        updated_at,
        parse_mode,
        confidence,
        needs_review,
        repository,
        workspace_path,
        branch,
        commits_json,
        git_tags_json,
        rollout_path,
        session_id,
        warnings_json,
        parse_payload_preview,
        0,
        0,
        0
      FROM issues
      WHERE COALESCE(kind, 'parent') = 'parent' OR parent_issue_id IS NULL;

      DELETE FROM thread_images;
      DROP TABLE issues;
      ALTER TABLE issues_next RENAME TO issues;

      CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_issues_thread_id ON issues(thread_id);

      PRAGMA foreign_keys = ON;
    `);
  }

  close(): void {
    this.db.close();
  }

  readParserSettings(): {
    provider?: ParserProvider | null;
    baseUrl: string | null;
    model: string | null;
    apiKey: string | null;
    outputLanguage?: string | null;
  } | null {
    const row = this.db
      .query(
        'SELECT value_json as valueJson FROM app_settings WHERE key = ? LIMIT 1',
      )
      .get('parser_settings') as { valueJson: string } | null;

    if (!row) {
      return null;
    }

    return parseJson<{
      provider?: ParserProvider | null;
      baseUrl: string | null;
      model: string | null;
      apiKey: string | null;
      outputLanguage?: string | null;
    }>(row.valueJson);
  }

  saveParserSettings(settings: {
    provider: ParserProvider;
    baseUrl: string | null;
    model: string | null;
    apiKey: string | null;
    outputLanguage: string;
  }): void {
    this.db
      .query(
        `
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        'parser_settings',
        JSON.stringify(settings),
        new Date().toISOString(),
      );
  }

  readOnboardingPreferences(): OnboardingPreferences {
    const row = this.db
      .query(
        'SELECT value_json as valueJson FROM app_settings WHERE key = ? LIMIT 1',
      )
      .get('onboarding_preferences') as { valueJson: string } | null;

    if (!row) {
      return {
        skipSync: false,
      };
    }

    const preferences = parseJson<{ skipSync?: boolean }>(row.valueJson);

    return {
      skipSync: Boolean(preferences.skipSync),
    };
  }

  saveOnboardingPreferences(preferences: OnboardingPreferences): void {
    this.db
      .query(
        `
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        'onboarding_preferences',
        JSON.stringify(preferences),
        new Date().toISOString(),
      );
  }

  readUsageRefresh(): UsageRefreshSummary {
    const row = this.db
      .query(
        'SELECT value_json as valueJson FROM app_settings WHERE key = ? LIMIT 1',
      )
      .get('usage_refresh') as { valueJson: string } | null;

    if (!row) {
      return {
        refreshedAt: null,
        scannedFiles: 0,
        parsedEvents: 0,
        skippedEvents: 0,
        includedArchived: true,
      };
    }

    return parseJson<UsageRefreshSummary>(row.valueJson);
  }

  replaceUsageEvents(
    events: UsageEventRecord[],
    refresh: UsageRefreshSummary,
  ): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM usage_events').run();

      const insert = this.db.query(`
        INSERT INTO usage_events (
          record_id, session_id, thread_id, event_timestamp, source_file, line_number,
          model, effort, input_tokens, cached_input_tokens, uncached_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens, is_archived
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const event of events) {
        insert.run(
          event.recordId,
          event.sessionId,
          event.threadId,
          event.eventTimestamp,
          event.sourceFile,
          event.lineNumber,
          event.model,
          event.effort,
          event.inputTokens,
          event.cachedInputTokens,
          event.uncachedInputTokens,
          event.outputTokens,
          event.reasoningOutputTokens,
          event.totalTokens,
          event.isArchived ? 1 : 0,
        );
      }

      this.db
        .query(
          `
          INSERT INTO app_settings (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
        )
        .run('usage_refresh', JSON.stringify(refresh), refresh.refreshedAt);
    })();
  }

  listUsageEvents(): UsageEventRecord[] {
    const rows = this.db
      .query(
        `
        SELECT
          record_id as recordId,
          session_id as sessionId,
          thread_id as threadId,
          event_timestamp as eventTimestamp,
          source_file as sourceFile,
          line_number as lineNumber,
          model,
          effort,
          input_tokens as inputTokens,
          cached_input_tokens as cachedInputTokens,
          uncached_input_tokens as uncachedInputTokens,
          output_tokens as outputTokens,
          reasoning_output_tokens as reasoningOutputTokens,
          total_tokens as totalTokens,
          is_archived as isArchived
        FROM usage_events
        ORDER BY event_timestamp ASC, line_number ASC, record_id ASC
      `,
      )
      .all() as Array<
      Omit<UsageEventRecord, 'isArchived'> & {
        isArchived: number;
      }
    >;

    return rows.map((row) => ({
      ...row,
      isArchived: Number(row.isArchived) === 1,
    }));
  }

  resetImportedData(): void {
    this.db.exec(`
      DELETE FROM skill_thread_signals;
      DELETE FROM thread_images;
      DELETE FROM issues;
      DELETE FROM projects;
      DELETE FROM sync_files;
      DELETE FROM sync_runs;
    `);
  }

  saveSyncFile(
    path: string,
    mtimeMs: number,
    sizeBytes: number,
    parserFingerprint: string,
    threadId: string | null,
    syncedAt: string,
  ): void {
    this.db
      .query(
        `
        INSERT INTO sync_files (path, mtime_ms, size_bytes, parser_fingerprint, thread_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          mtime_ms = excluded.mtime_ms,
          size_bytes = excluded.size_bytes,
          parser_fingerprint = excluded.parser_fingerprint,
          thread_id = excluded.thread_id,
          synced_at = excluded.synced_at
      `,
      )
      .run(path, mtimeMs, sizeBytes, parserFingerprint, threadId, syncedAt);
  }

  getSyncFileState(path: string): SyncFileState | null {
    return this.db
      .query(
        `
        SELECT
          path,
          mtime_ms as mtimeMs,
          size_bytes as sizeBytes,
          parser_fingerprint as parserFingerprint,
          thread_id as threadId
        FROM sync_files
        WHERE path = ?
      `,
      )
      .get(path) as SyncFileState | null;
  }

  listSyncFileStates(): SyncFileState[] {
    return this.db
      .query(
        `
        SELECT
          path,
          mtime_ms as mtimeMs,
          size_bytes as sizeBytes,
          parser_fingerprint as parserFingerprint,
          thread_id as threadId
        FROM sync_files
        ORDER BY path ASC
      `,
      )
      .all() as SyncFileState[];
  }

  deleteSyncFile(path: string): void {
    this.db.query('DELETE FROM sync_files WHERE path = ?').run(path);
  }

  deleteIssuesByRolloutPath(path: string): void {
    this.db
      .query('DELETE FROM skill_thread_signals WHERE rollout_path = ?')
      .run(path);
    this.db.query('DELETE FROM issues WHERE rollout_path = ?').run(path);
  }

  upsertProject(project: ProjectSummary): void {
    this.db
      .query(
        `
        INSERT INTO projects (id, name, repository, workspace_path, last_updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          repository = excluded.repository,
          workspace_path = excluded.workspace_path,
          last_updated_at = excluded.last_updated_at
      `,
      )
      .run(
        project.id,
        project.name,
        project.repository,
        project.workspacePath,
        project.lastUpdatedAt,
      );
  }

  upsertIssue(issue: ParsedIssue): void {
    this.db.transaction(() => {
      this.db
        .query(
          `
        INSERT INTO issues (
          id, thread_id, project_id, title, tags_json, summary, started_at, updated_at,
          parse_mode, confidence, needs_review, repository, workspace_path, branch,
          commits_json, git_tags_json, rollout_path, session_id, warnings_json,
          parse_payload_preview, message_count, command_count, image_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_id = excluded.thread_id,
          project_id = excluded.project_id,
          title = excluded.title,
          tags_json = excluded.tags_json,
          summary = excluded.summary,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          parse_mode = excluded.parse_mode,
          confidence = excluded.confidence,
          needs_review = excluded.needs_review,
          repository = excluded.repository,
          workspace_path = excluded.workspace_path,
          branch = excluded.branch,
          commits_json = excluded.commits_json,
          git_tags_json = excluded.git_tags_json,
          rollout_path = excluded.rollout_path,
          session_id = excluded.session_id,
          warnings_json = excluded.warnings_json,
          parse_payload_preview = excluded.parse_payload_preview,
          message_count = excluded.message_count,
          command_count = excluded.command_count,
          image_count = excluded.image_count
      `,
        )
        .run(
          issue.id,
          issue.threadId,
          issue.projectId,
          issue.title,
          JSON.stringify(issue.tags),
          issue.summary,
          issue.startedAt,
          issue.updatedAt,
          issue.parseMode,
          issue.confidence,
          issue.needsReview ? 1 : 0,
          issue.git.repository,
          issue.git.workspacePath,
          issue.git.branch ?? null,
          JSON.stringify(issue.git.commits),
          JSON.stringify(issue.git.tags),
          issue.evidence.rolloutPath,
          issue.evidence.sessionId,
          JSON.stringify(issue.evidence.warnings),
          issue.evidence.parsePayloadPreview,
          issue.stats.messageCount,
          issue.stats.commandCount,
          issue.images?.length ?? issue.stats.imageCount,
        );

      this.db
        .query('DELETE FROM thread_images WHERE issue_id = ?')
        .run(issue.id);

      const insertImage = this.db.query(`
        INSERT INTO thread_images (
          id, issue_id, thread_id, role, message_index, part_index, source_type,
          mime_type, filename, original_url, local_path, width, height, size_bytes,
          caption, message_excerpt, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const image of issue.images ?? []) {
        insertImage.run(
          image.id,
          issue.id,
          image.threadId,
          image.role,
          image.messageIndex,
          image.partIndex,
          image.sourceType,
          image.mimeType,
          image.filename,
          image.originalUrl,
          image.localPath,
          image.width,
          image.height,
          image.sizeBytes,
          image.caption,
          image.messageExcerpt,
          image.createdAt,
        );
      }
    })();
  }

  deleteThreadIssues(threadId: string): void {
    this.db
      .query('DELETE FROM skill_thread_signals WHERE thread_id = ?')
      .run(threadId);
    this.db.query('DELETE FROM issues WHERE thread_id = ?').run(threadId);
  }

  saveSkillThreadSignal(signal: SkillThreadSignalRecord): void {
    this.db
      .query(
        `
        INSERT INTO skill_thread_signals (
          thread_id, project_id, rollout_path, user_prompt, assistant_response,
          task_title, task_summary, tags_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          project_id = excluded.project_id,
          rollout_path = excluded.rollout_path,
          user_prompt = excluded.user_prompt,
          assistant_response = excluded.assistant_response,
          task_title = excluded.task_title,
          task_summary = excluded.task_summary,
          tags_json = excluded.tags_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        signal.threadId,
        signal.projectId,
        signal.rolloutPath,
        signal.userPrompt,
        signal.assistantResponse,
        signal.taskTitle,
        signal.taskSummary,
        JSON.stringify(signal.tags),
        signal.updatedAt,
      );
  }

  listProjectSkillThreadSignals(projectId: string): SkillThreadSignalRecord[] {
    const rows = this.db
      .query(
        `
        SELECT
          thread_id as threadId,
          project_id as projectId,
          rollout_path as rolloutPath,
          user_prompt as userPrompt,
          assistant_response as assistantResponse,
          task_title as taskTitle,
          task_summary as taskSummary,
          tags_json as tagsJson,
          updated_at as updatedAt
        FROM skill_thread_signals
        WHERE project_id = ?
        ORDER BY updated_at DESC, task_title ASC
      `,
      )
      .all(projectId) as Array<
      Omit<SkillThreadSignalRecord, 'tags'> & { tagsJson: string }
    >;

    return rows.map((row) => ({
      threadId: row.threadId,
      projectId: row.projectId,
      rolloutPath: row.rolloutPath,
      userPrompt: row.userPrompt,
      assistantResponse: row.assistantResponse,
      taskTitle: row.taskTitle,
      taskSummary: row.taskSummary,
      tags: parseJson<string[]>(row.tagsJson),
      updatedAt: row.updatedAt,
    }));
  }

  pruneProjectsWithoutIssues(): void {
    this.db
      .query(
        `
        DELETE FROM projects
        WHERE id NOT IN (
          SELECT DISTINCT project_id
          FROM issues
        )
      `,
      )
      .run();
  }

  saveSyncRun(sync: SyncDiagnostics): void {
    this.db
      .query(
        `
        INSERT INTO sync_runs (
          id, started_at, completed_at, parser_base_url, parser_model, response_models_json,
          ai_request_count, prompt_tokens, completion_tokens, total_tokens, scanned_files,
          changed_files, imported_threads, skipped_threads, ai_parsed_issues, fallback_issues,
          review_issues, errors_json, parse_log_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        sync.runId,
        sync.startedAt,
        sync.completedAt,
        sync.parserBaseUrl,
        sync.parserModel,
        JSON.stringify(sync.responseModels),
        sync.aiRequestCount,
        sync.tokenUsage.promptTokens,
        sync.tokenUsage.completionTokens,
        sync.tokenUsage.totalTokens,
        sync.scannedFiles,
        sync.changedFiles,
        sync.importedThreads,
        sync.skippedThreads,
        sync.aiParsedIssues,
        sync.fallbackIssues,
        sync.reviewIssues,
        JSON.stringify(sync.errors),
        JSON.stringify(sync.parseLog),
      );
  }

  private hydrateSync(
    row:
      | (Omit<
          SyncDiagnostics,
          'responseModels' | 'tokenUsage' | 'errors' | 'parseLog'
        > & {
          responseModelsJson: string;
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
          errorsJson: string;
          parseLogJson: string;
        })
      | null,
  ): SyncDiagnostics | null {
    if (!row) {
      return null;
    }

    return {
      ...row,
      responseModels: parseJson<string[]>(row.responseModelsJson),
      tokenUsage: {
        promptTokens: Number(row.promptTokens),
        completionTokens: Number(row.completionTokens),
        totalTokens: Number(row.totalTokens),
      },
      errors: parseJson<string[]>(row.errorsJson),
      parseLog: parseJson<SyncDiagnostics['parseLog']>(row.parseLogJson),
    };
  }

  getLatestSync(): SyncDiagnostics | null {
    const row = this.db
      .query(
        `
        SELECT
          id as runId,
          started_at as startedAt,
          completed_at as completedAt,
          parser_base_url as parserBaseUrl,
          parser_model as parserModel,
          response_models_json as responseModelsJson,
          ai_request_count as aiRequestCount,
          prompt_tokens as promptTokens,
          completion_tokens as completionTokens,
          total_tokens as totalTokens,
          scanned_files as scannedFiles,
          changed_files as changedFiles,
          imported_threads as importedThreads,
          skipped_threads as skippedThreads,
          ai_parsed_issues as aiParsedIssues,
          fallback_issues as fallbackIssues,
          review_issues as reviewIssues,
          errors_json as errorsJson,
          parse_log_json as parseLogJson
        FROM sync_runs
        ORDER BY completed_at DESC
        LIMIT 1
      `,
      )
      .get() as
      | (Omit<
          SyncDiagnostics,
          'responseModels' | 'tokenUsage' | 'errors' | 'parseLog'
        > & {
          responseModelsJson: string;
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
          errorsJson: string;
          parseLogJson: string;
        })
      | null;

    return this.hydrateSync(row);
  }

  listSyncRuns(limit = 20): SyncDiagnostics[] {
    const rows = this.db
      .query(
        `
        SELECT
          id as runId,
          started_at as startedAt,
          completed_at as completedAt,
          parser_base_url as parserBaseUrl,
          parser_model as parserModel,
          response_models_json as responseModelsJson,
          ai_request_count as aiRequestCount,
          prompt_tokens as promptTokens,
          completion_tokens as completionTokens,
          total_tokens as totalTokens,
          scanned_files as scannedFiles,
          changed_files as changedFiles,
          imported_threads as importedThreads,
          skipped_threads as skippedThreads,
          ai_parsed_issues as aiParsedIssues,
          fallback_issues as fallbackIssues,
          review_issues as reviewIssues,
          errors_json as errorsJson,
          parse_log_json as parseLogJson
        FROM sync_runs
        ORDER BY completed_at DESC
        LIMIT ?
      `,
      )
      .all(limit) as Array<
      Omit<
        SyncDiagnostics,
        'responseModels' | 'tokenUsage' | 'errors' | 'parseLog'
      > & {
        responseModelsJson: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        errorsJson: string;
        parseLogJson: string;
      }
    >;

    return rows.flatMap((row) => {
      const sync = this.hydrateSync(row);
      return sync ? [sync] : [];
    });
  }

  listProjects(): ProjectListResponse {
    const projects = this.db
      .query(
        `
        SELECT
          p.id as id,
          p.name as name,
          p.repository as repository,
          p.workspace_path as workspacePath,
          p.last_updated_at as lastUpdatedAt,
          COUNT(i.id) as issueCount,
          COUNT(CASE WHEN i.needs_review = 1 THEN 1 END) as needsReviewCount
        FROM projects p
        LEFT JOIN issues i ON i.project_id = p.id
        GROUP BY p.id
        ORDER BY p.last_updated_at DESC, p.name ASC
      `,
      )
      .all() as ProjectSummary[];

    return {
      generatedAt: new Date().toISOString(),
      sync: this.getLatestSync(),
      projects,
    };
  }

  private hydrateImage(row: Record<string, unknown>): ThreadImage {
    return {
      id: String(row.id),
      issueId: String(row.issueId),
      threadId: String(row.threadId),
      role: row.role as ThreadImage['role'],
      messageIndex: Number(row.messageIndex),
      partIndex: Number(row.partIndex),
      sourceType: row.sourceType as ThreadImage['sourceType'],
      mimeType: (row.mimeType as string | null) ?? null,
      filename: (row.filename as string | null) ?? null,
      originalUrl: (row.originalUrl as string | null) ?? null,
      localPath: (row.localPath as string | null) ?? null,
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
      caption: (row.caption as string | null) ?? null,
      messageExcerpt: (row.messageExcerpt as string | null) ?? null,
      createdAt: (row.createdAt as string | null) ?? null,
    };
  }

  private listIssueImages(issueId: string): ThreadImage[] {
    const rows = this.db
      .query(
        `
        SELECT
          id,
          issue_id as issueId,
          thread_id as threadId,
          role,
          message_index as messageIndex,
          part_index as partIndex,
          source_type as sourceType,
          mime_type as mimeType,
          filename,
          original_url as originalUrl,
          local_path as localPath,
          width,
          height,
          size_bytes as sizeBytes,
          caption,
          message_excerpt as messageExcerpt,
          created_at as createdAt
        FROM thread_images
        WHERE issue_id = ?
        ORDER BY message_index ASC, part_index ASC, id ASC
      `,
      )
      .all(issueId) as Record<string, unknown>[];

    return rows.map((row) => this.hydrateImage(row));
  }

  private hydrateIssue(
    row: Record<string, unknown>,
    images?: ThreadImage[],
  ): ParsedIssue {
    return {
      id: String(row.id),
      threadId: String(row.threadId),
      projectId: String(row.projectId),
      title: String(row.title),
      tags: parseJson<string[]>(row.tagsJson as string),
      summary: String(row.summary),
      startedAt: String(row.startedAt),
      updatedAt: String(row.updatedAt),
      parseMode: row.parseMode as ParsedIssue['parseMode'],
      confidence: Number(row.confidence),
      needsReview: Number(row.needsReview) === 1,
      git: {
        repository: String(row.repository),
        workspacePath: String(row.workspacePath),
        branch: (row.branch as string | null) ?? null,
        commits: parseJson(row.commitsJson as string),
        tags: parseJson(row.gitTagsJson as string),
      },
      evidence: {
        rolloutPath: String(row.rolloutPath),
        sessionId: String(row.sessionId),
        threadId: String(row.threadId),
        warnings: parseJson(row.warningsJson as string),
        parsePayloadPreview: String(row.parsePayloadPreview),
      },
      stats: {
        messageCount: Number(row.messageCount),
        commandCount: Number(row.commandCount),
        imageCount: Number(row.imageCount),
      },
      images,
    };
  }

  listIssues(projectId: string, filters: IssueFilters): IssueListResponse {
    const clauses = ['project_id = ?'];
    const args: Array<string | number> = [projectId];

    if (filters.parseMode && filters.parseMode !== 'all') {
      clauses.push('parse_mode = ?');
      args.push(filters.parseMode);
    }

    if (typeof filters.needsReview === 'boolean') {
      clauses.push('needs_review = ?');
      args.push(filters.needsReview ? 1 : 0);
    }

    if (filters.hasCommits) {
      clauses.push("commits_json != '[]'");
    }

    if (filters.hasTags) {
      clauses.push("git_tags_json != '[]'");
    }

    if (filters.hasImages) {
      clauses.push('image_count > 0');
    }

    if (filters.tag) {
      clauses.push('tags_json LIKE ?');
      args.push(`%${filters.tag.toLowerCase()}%`);
    }

    if (filters.query) {
      clauses.push('(LOWER(title) LIKE ? OR LOWER(summary) LIKE ?)');
      args.push(
        `%${filters.query.toLowerCase()}%`,
        `%${filters.query.toLowerCase()}%`,
      );
    }

    const rows = this.db
      .query(
        `
        SELECT
          id, thread_id as threadId, project_id as projectId, title, tags_json as tagsJson,
          summary, started_at as startedAt, updated_at as updatedAt, parse_mode as parseMode, confidence,
          needs_review as needsReview, repository, workspace_path as workspacePath, branch,
          commits_json as commitsJson, git_tags_json as gitTagsJson, rollout_path as rolloutPath,
          session_id as sessionId, warnings_json as warningsJson,
          parse_payload_preview as parsePayloadPreview, message_count as messageCount,
          command_count as commandCount, image_count as imageCount
        FROM issues
        WHERE ${clauses.join(' AND ')}
        ORDER BY needs_review DESC, updated_at DESC, title ASC
      `,
      )
      .all(...args) as Record<string, unknown>[];

    const issues = rows.map((row) => this.hydrateIssue(row));
    const project =
      (this.db
        .query(
          `
        SELECT
          p.id as id,
          p.name as name,
          p.repository as repository,
          p.workspace_path as workspacePath,
          p.last_updated_at as lastUpdatedAt,
          COUNT(i.id) as issueCount,
          COUNT(CASE WHEN i.needs_review = 1 THEN 1 END) as needsReviewCount
        FROM projects p
        LEFT JOIN issues i ON i.project_id = p.id
        WHERE p.id = ?
        GROUP BY p.id
      `,
        )
        .get(projectId) as ProjectSummary | null) ?? null;

    return {
      generatedAt: new Date().toISOString(),
      project,
      filters,
      issues,
    };
  }

  listProjectIssues(projectId: string): ParsedIssue[] {
    const rows = this.db
      .query(
        `
        SELECT
          id, thread_id as threadId, project_id as projectId, title, tags_json as tagsJson,
          summary, started_at as startedAt, updated_at as updatedAt, parse_mode as parseMode, confidence,
          needs_review as needsReview, repository, workspace_path as workspacePath, branch,
          commits_json as commitsJson, git_tags_json as gitTagsJson, rollout_path as rolloutPath,
          session_id as sessionId, warnings_json as warningsJson,
          parse_payload_preview as parsePayloadPreview, message_count as messageCount,
          command_count as commandCount, image_count as imageCount
        FROM issues
        WHERE project_id = ?
        ORDER BY updated_at DESC, title ASC
      `,
      )
      .all(projectId) as Record<string, unknown>[];

    return rows.map((row) => this.hydrateIssue(row));
  }

  getIssue(issueId: string): IssueDetailResponse {
    const row = this.db
      .query(
        `
        SELECT
          id, thread_id as threadId, project_id as projectId, title, tags_json as tagsJson,
          summary, started_at as startedAt, updated_at as updatedAt, parse_mode as parseMode, confidence,
          needs_review as needsReview, repository, workspace_path as workspacePath, branch,
          commits_json as commitsJson, git_tags_json as gitTagsJson, rollout_path as rolloutPath,
          session_id as sessionId, warnings_json as warningsJson,
          parse_payload_preview as parsePayloadPreview, message_count as messageCount,
          command_count as commandCount, image_count as imageCount
        FROM issues
        WHERE id = ?
      `,
      )
      .get(issueId) as Record<string, unknown> | null;

    if (!row) {
      return {
        generatedAt: new Date().toISOString(),
        issue: null,
      };
    }

    const issue = this.hydrateIssue(row, this.listIssueImages(issueId));

    return {
      generatedAt: new Date().toISOString(),
      issue,
    };
  }

  setIssueNeedsReview(issueId: string, needsReview: boolean): void {
    this.db
      .query('UPDATE issues SET needs_review = ? WHERE id = ?')
      .run(needsReview ? 1 : 0, issueId);
  }

  listSavedViews(): SavedViewListResponse {
    const rows = this.db
      .query(
        `
        SELECT
          id,
          name,
          filters_json as filtersJson,
          created_at as createdAt,
          updated_at as updatedAt
        FROM saved_views
        ORDER BY updated_at DESC, name ASC
      `,
      )
      .all() as Array<{
      id: string;
      name: string;
      filtersJson: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return {
      generatedAt: new Date().toISOString(),
      views: rows.map((row) => ({
        id: row.id,
        name: row.name,
        filters: parseJson(row.filtersJson),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  }

  saveView(view: SavedView): void {
    this.db
      .query(
        `
        INSERT INTO saved_views (id, name, filters_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          filters_json = excluded.filters_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        view.id,
        view.name,
        JSON.stringify(view.filters),
        view.createdAt,
        view.updatedAt,
      );
  }
}
