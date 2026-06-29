import type {
  SyncDiagnostics,
  SyncProgress,
  SyncStatus,
  SyncTrigger,
} from '../../../packages/domain/src/index';

import type { AppConfig } from './config';
import type { BoardsDatabase } from './db';
import type { SyncService } from './sync-service';

const EMPTY_PROGRESS: SyncProgress = {
  totalFiles: 0,
  scannedFiles: 0,
  changedFiles: 0,
  importedThreads: 0,
  skippedThreads: 0,
  aiParsedIssues: 0,
  fallbackIssues: 0,
  reviewIssues: 0,
  currentFilePath: null,
};

type SyncStatusListener = (status: SyncStatus) => void;

export class SyncCoordinator {
  private currentRun: Promise<SyncDiagnostics> | null = null;
  private latestError: string | null = null;
  private nextSyncAt: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<SyncStatusListener>();
  private status: Omit<SyncStatus, 'generatedAt' | 'lastSync' | 'latestError'> =
    {
      state: 'idle',
      phase: 'idle',
      trigger: null,
      runId: null,
      startedAt: null,
      completedAt: null,
      nextSyncAt: null,
      progress: { ...EMPTY_PROGRESS },
    };

  constructor(
    private readonly database: BoardsDatabase,
    private readonly syncService: SyncService,
    private readonly config: AppConfig,
  ) {}

  getStatus(): SyncStatus {
    return {
      generatedAt: new Date().toISOString(),
      ...this.status,
      nextSyncAt: this.nextSyncAt,
      lastSync: this.database.getLatestSync(),
      latestError: this.latestError,
    };
  }

  subscribe(listener: SyncStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());

    return () => {
      this.listeners.delete(listener);
    };
  }

  startBackgroundSyncIfEligible(): void {
    if (!this.database.getLatestSync()) {
      return;
    }

    this.scheduleNextBackgroundSync();
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  run(trigger: SyncTrigger = 'manual'): Promise<SyncDiagnostics> {
    if (this.currentRun) {
      return this.currentRun;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextSyncAt = null;
    }

    this.currentRun = this.syncService
      .sync({
        trigger,
        onProgress: (event) => {
          this.status = {
            state: 'syncing',
            phase: event.phase,
            trigger: event.trigger,
            runId: event.runId,
            startedAt: event.startedAt,
            completedAt: null,
            nextSyncAt: null,
            progress: event.progress,
          };
          this.broadcast();
        },
      })
      .then((sync) => {
        this.latestError = null;
        this.status = {
          state: 'idle',
          phase: 'completed',
          trigger,
          runId: sync.runId,
          startedAt: sync.startedAt,
          completedAt: sync.completedAt,
          nextSyncAt: null,
          progress: {
            totalFiles: sync.scannedFiles,
            scannedFiles: sync.scannedFiles,
            changedFiles: sync.changedFiles,
            importedThreads: sync.importedThreads,
            skippedThreads: sync.skippedThreads,
            aiParsedIssues: sync.aiParsedIssues,
            fallbackIssues: sync.fallbackIssues,
            reviewIssues: sync.reviewIssues,
            currentFilePath: null,
          },
        };
        this.broadcast();
        this.scheduleNextBackgroundSync();
        return sync;
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : 'Unknown sync error.';
        this.latestError = message;
        this.status = {
          ...this.status,
          state: 'error',
          phase: 'failed',
          trigger,
          completedAt: new Date().toISOString(),
        };
        this.broadcast();
        this.scheduleNextBackgroundSync();
        throw error;
      })
      .finally(() => {
        this.currentRun = null;
      });

    return this.currentRun;
  }

  private broadcast(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  private scheduleNextBackgroundSync(): void {
    const intervalMs = this.config.syncIntervalMs ?? 60_000;
    if (intervalMs <= 0 || !this.database.getLatestSync()) {
      this.nextSyncAt = null;
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.nextSyncAt = new Date(Date.now() + intervalMs).toISOString();
    this.broadcast();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextSyncAt = null;
      void this.run('background').catch((error) => {
        console.error(
          '[sync:background]',
          error instanceof Error ? error.message : String(error),
        );
      });
    }, intervalMs);
  }
}
