import { randomUUID } from 'node:crypto';

import type {
  SyncDiagnostics,
  SyncParseLogEntry,
  SyncPhase,
  SyncProgress,
  SyncTrigger,
} from '../../../packages/domain/src/index';

import { getParserProvider } from './config';
import type { AppConfig } from './config';
import type { BoardsDatabase, SyncFileState } from './db';
import {
  type RolloutFile,
  buildIssuesFromCandidate,
  listRolloutFiles,
  parseRolloutFile,
} from './rollout-parser';

export interface SyncProgressEvent {
  phase: SyncPhase;
  trigger: SyncTrigger;
  runId: string;
  startedAt: string;
  progress: SyncProgress;
}

export interface SyncOptions {
  trigger?: SyncTrigger;
  maxThreads?: number;
  onProgress?: (event: SyncProgressEvent) => void;
}

function parserFingerprint(config: AppConfig): string {
  const provider = getParserProvider(config);

  if (provider === 'codex-cli') {
    if (!config.openAiModel) {
      return 'fallback-only';
    }

    return `codex-cli:${config.openAiModel}:plain-json`;
  }

  if (!config.openAiBaseUrl || !config.openAiApiKey || !config.openAiModel) {
    return 'fallback-only';
  }

  return `openai-compatible:${config.openAiBaseUrl}:${config.openAiModel}:key-configured`;
}

function hasUpdatedRolloutFile(
  file: RolloutFile,
  previous: SyncFileState | undefined,
): boolean {
  return (
    !previous ||
    previous.mtimeMs !== file.mtimeMs ||
    previous.sizeBytes !== file.sizeBytes
  );
}

function hasSyncRelevantChange(
  file: RolloutFile,
  previous: SyncFileState | undefined,
  fingerprint: string,
): boolean {
  return (
    hasUpdatedRolloutFile(file, previous) ||
    previous?.parserFingerprint !== fingerprint
  );
}

export class SyncService {
  constructor(
    private readonly database: BoardsDatabase,
    private readonly config: AppConfig,
  ) {}

  countThreads(): number {
    return listRolloutFiles(this.config.sessionsRoot).length;
  }

  async sync(options: SyncOptions = {}): Promise<SyncDiagnostics> {
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const trigger = options.trigger ?? 'manual';
    const allFiles = [...listRolloutFiles(this.config.sessionsRoot)].reverse();
    const fingerprint = parserFingerprint(this.config);
    const previousFileStates = new Map(
      this.database
        .listSyncFileStates()
        .map((state) => [state.path, state] as const),
    );
    const candidateFiles =
      trigger === 'background'
        ? allFiles.filter((file) =>
            hasUpdatedRolloutFile(file, previousFileStates.get(file.path)),
          )
        : allFiles;
    const files =
      options.maxThreads && options.maxThreads > 0
        ? candidateFiles.slice(0, options.maxThreads)
        : candidateFiles;
    const currentFilePaths = new Set(allFiles.map((file) => file.path));
    let changedFiles = 0;
    let importedThreads = 0;
    let skippedThreads = 0;
    let aiParsedIssues = 0;
    let fallbackIssues = 0;
    let reviewIssues = 0;
    let aiRequestCount = 0;
    const responseModels: string[] = [];
    const tokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const errors: string[] = [];
    const parseLog: SyncParseLogEntry[] = [];
    const progress: SyncProgress = {
      totalFiles: files.length,
      scannedFiles: 0,
      changedFiles: 0,
      importedThreads: 0,
      skippedThreads: 0,
      aiParsedIssues: 0,
      fallbackIssues: 0,
      reviewIssues: 0,
      currentFilePath: null,
    };

    const emitProgress = (phase: SyncPhase) => {
      options.onProgress?.({
        phase,
        trigger,
        runId,
        startedAt,
        progress: { ...progress },
      });
    };

    emitProgress('scanning');

    for (const [path, state] of previousFileStates) {
      if (currentFilePaths.has(path)) {
        continue;
      }

      changedFiles += 1;
      progress.changedFiles = changedFiles;
      progress.currentFilePath = path;
      if (state.threadId) {
        this.database.deleteThreadIssues(state.threadId);
      } else {
        this.database.deleteIssuesByRolloutPath(path);
      }
      this.database.deleteSyncFile(path);
      parseLog.push({
        filePath: path,
        threadId: state.threadId,
        repository: null,
        parseMode: null,
        issueCount: 0,
        status: 'skipped',
        message: 'Removed: rollout file no longer exists.',
      });
      emitProgress('persisting');
    }

    for (const file of files) {
      progress.scannedFiles += 1;
      progress.currentFilePath = file.path;

      try {
        const previous = previousFileStates.get(file.path);
        const unchanged = !hasSyncRelevantChange(file, previous, fingerprint);

        if (unchanged) {
          skippedThreads += 1;
          progress.skippedThreads = skippedThreads;
          parseLog.push({
            filePath: file.path,
            threadId: previous.threadId,
            repository: null,
            parseMode: null,
            issueCount: 0,
            status: 'skipped',
            message: 'Skipped: rollout file unchanged for current parser.',
          });
          emitProgress('scanning');
          continue;
        }

        changedFiles += 1;
        progress.changedFiles = changedFiles;
        emitProgress('parsing');

        if (previous?.threadId) {
          this.database.deleteThreadIssues(previous.threadId);
        } else {
          this.database.deleteIssuesByRolloutPath(file.path);
        }

        const candidate = parseRolloutFile(file);
        if (!candidate) {
          skippedThreads += 1;
          progress.skippedThreads = skippedThreads;
          this.database.saveSyncFile(
            file.path,
            file.mtimeMs,
            file.sizeBytes,
            fingerprint,
            null,
            new Date().toISOString(),
          );
          parseLog.push({
            filePath: file.path,
            threadId: null,
            repository: null,
            parseMode: null,
            issueCount: 0,
            status: 'skipped',
            message: 'Skipped: rollout has no Git workspace evidence.',
          });
          emitProgress('persisting');
          continue;
        }

        const built = await buildIssuesFromCandidate(candidate, {
          parserProvider: getParserProvider(this.config),
          openAiBaseUrl: this.config.openAiBaseUrl,
          openAiApiKey: this.config.openAiApiKey,
          openAiModel: this.config.openAiModel,
        });

        const needsReviewCount = built.issues.filter(
          (issue) => issue.needsReview,
        ).length;
        const parentCount = built.issues.filter(
          (issue) => issue.kind === 'parent',
        ).length;
        const subIssueCount = built.issues.length - parentCount;

        this.database.upsertProject({
          ...built.project,
          issueCount: parentCount,
          subIssueCount,
          needsReviewCount,
          lastUpdatedAt: candidate.updatedAt,
        });

        for (const issue of built.issues) {
          this.database.upsertIssue(issue);
          if (issue.parentIssueId) {
            this.database.recountSubIssues(issue.parentIssueId);
          }
        }

        importedThreads += 1;
        reviewIssues += needsReviewCount;
        aiRequestCount += built.aiDiagnostics.requestCount;
        tokenUsage.promptTokens += built.aiDiagnostics.tokenUsage.promptTokens;
        tokenUsage.completionTokens +=
          built.aiDiagnostics.tokenUsage.completionTokens;
        tokenUsage.totalTokens += built.aiDiagnostics.tokenUsage.totalTokens;
        if (
          built.aiDiagnostics.responseModel &&
          !responseModels.includes(built.aiDiagnostics.responseModel)
        ) {
          responseModels.push(built.aiDiagnostics.responseModel);
        }
        if (built.parseMode === 'ai') {
          aiParsedIssues += built.issues.length;
        } else {
          fallbackIssues += built.issues.length;
        }
        progress.importedThreads = importedThreads;
        progress.aiParsedIssues = aiParsedIssues;
        progress.fallbackIssues = fallbackIssues;
        progress.reviewIssues = reviewIssues;
        this.database.saveSyncFile(
          file.path,
          file.mtimeMs,
          file.sizeBytes,
          fingerprint,
          candidate.threadId,
          new Date().toISOString(),
        );
        parseLog.push({
          filePath: file.path,
          threadId: candidate.threadId,
          repository: built.project.repository,
          parseMode: built.parseMode,
          issueCount: built.issues.length,
          status: 'imported',
          message: `Imported ${built.issues.length} issue${built.issues.length === 1 ? '' : 's'} via ${built.parseMode} parsing.`,
        });
        emitProgress('persisting');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown sync error.';
        errors.push(`${file.path}: ${message}`);
        parseLog.push({
          filePath: file.path,
          threadId: null,
          repository: null,
          parseMode: null,
          issueCount: 0,
          status: 'error',
          message,
        });
        emitProgress('parsing');
      }
    }

    progress.currentFilePath = null;
    this.database.pruneProjectsWithoutIssues();

    const sync: SyncDiagnostics = {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      parserBaseUrl:
        getParserProvider(this.config) === 'codex-cli'
          ? 'codex-cli'
          : this.config.openAiBaseUrl,
      parserModel: this.config.openAiModel,
      responseModels,
      aiRequestCount,
      tokenUsage,
      scannedFiles: files.length,
      changedFiles,
      importedThreads,
      skippedThreads,
      aiParsedIssues,
      fallbackIssues,
      reviewIssues,
      errors,
      parseLog,
    };

    this.logSyncRun(sync);
    this.database.saveSyncRun(sync);
    emitProgress('completed');
    return sync;
  }

  private logSyncRun(sync: SyncDiagnostics): void {
    console.log(
      [
        `[sync] run=${sync.runId}`,
        `baseUrl=${sync.parserBaseUrl ?? 'fallback-only'}`,
        `model=${sync.parserModel ?? 'fallback-only'}`,
        `responseModels=${sync.responseModels.join(',') || 'n/a'}`,
        `aiRequests=${sync.aiRequestCount}`,
        `tokens=${sync.tokenUsage.totalTokens}`,
        `scanned=${sync.scannedFiles}`,
        `changed=${sync.changedFiles}`,
        `imported=${sync.importedThreads}`,
        `skipped=${sync.skippedThreads}`,
        `aiIssues=${sync.aiParsedIssues}`,
        `fallbackIssues=${sync.fallbackIssues}`,
        `review=${sync.reviewIssues}`,
      ].join(' '),
    );

    for (const entry of sync.parseLog) {
      console.log(
        [
          `[sync:${entry.status}]`,
          `mode=${entry.parseMode ?? 'n/a'}`,
          `repo=${entry.repository ?? 'n/a'}`,
          `thread=${entry.threadId ?? 'n/a'}`,
          `issues=${entry.issueCount}`,
          `file=${entry.filePath}`,
          `message=${entry.message}`,
        ].join(' '),
      );
    }

    for (const error of sync.errors) {
      console.error(`[sync:error] ${error}`);
    }
  }
}
