import { randomUUID } from 'node:crypto';

import type { SyncDiagnostics, SyncParseLogEntry } from '@codex-boards/domain';

import type { AppConfig } from './config';
import type { BoardsDatabase } from './db';
import {
  buildIssuesFromCandidate,
  listRolloutFiles,
  parseRolloutFile,
} from './rollout-parser';

export class SyncService {
  constructor(
    private readonly database: BoardsDatabase,
    private readonly config: AppConfig,
  ) {}

  async sync(): Promise<SyncDiagnostics> {
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    let files = listRolloutFiles(this.config.sessionsRoot);

    // Temporary debug mode: always rebuild from scratch from the current session set.
    files = [...files].reverse().slice(0, 20);
    this.database.resetImportedData();

    const changedFiles = files.length;
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

    for (const file of files) {
      try {
        const candidate = parseRolloutFile(file);
        if (!candidate) {
          skippedThreads += 1;
          parseLog.push({
            filePath: file.path,
            threadId: null,
            repository: null,
            parseMode: null,
            issueCount: 0,
            status: 'skipped',
            message: 'Skipped: rollout has no Git workspace evidence.',
          });
          continue;
        }

        const built = await buildIssuesFromCandidate(candidate, {
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
        parseLog.push({
          filePath: file.path,
          threadId: candidate.threadId,
          repository: built.project.repository,
          parseMode: built.parseMode,
          issueCount: built.issues.length,
          status: 'imported',
          message: `Imported ${built.issues.length} issue${built.issues.length === 1 ? '' : 's'} via ${built.parseMode} parsing.`,
        });
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
      }
    }

    const sync: SyncDiagnostics = {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      parserBaseUrl: this.config.openAiBaseUrl,
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
