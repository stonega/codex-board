import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, test } from 'bun:test';

import {
  readParserSettings,
  resolveDatabasePath,
  updateParserSettings,
} from '../../apps/backend/src/config';
import { createAppServer } from '../../apps/backend/src/index';
import {
  buildIssuesFromCandidate,
  buildParsePayload,
  parseRolloutFile,
} from '../../apps/backend/src/rollout-parser';
import type {
  IssueDetailResponse,
  IssueListResponse,
} from '../../packages/domain/src';
import {
  inferProjectId,
  inferProjectName,
  normalizeTags,
} from '../../packages/domain/src';

describe('domain helpers', () => {
  test('infers project id and name from repository and workspace', () => {
    expect(inferProjectName('codex-boards', '/tmp/codex-boards')).toBe(
      'codex-boards',
    );
    expect(inferProjectId('codex boards', '/tmp/codex-boards')).toBe(
      'codex-boards',
    );
  });

  test('normalizes tags deterministically', () => {
    expect(normalizeTags([' Backend ', 'backend', 'Needs Review'])).toEqual([
      'backend',
      'needs-review',
    ]);
  });
});

describe('parser settings', () => {
  test('normalizes runtime parser settings updates', () => {
    const config = {
      port: 7788,
      sessionsRoot: '/tmp/codex-sessions',
      databasePath: '/tmp/codex-boards-test.sqlite',
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    };

    expect(
      updateParserSettings(config, {
        baseUrl: '  http://localhost:11434/v1  ',
        model: '  qwen2.5-coder:7b ',
        apiKey: '  secret-token ',
        outputLanguage: ' Traditional Chinese ',
      }),
    ).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      apiKeyConfigured: true,
      outputLanguage: 'Traditional Chinese',
    });

    expect(
      updateParserSettings(config, {
        model: '   ',
      }),
    ).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: null,
      apiKeyConfigured: true,
      outputLanguage: 'Traditional Chinese',
    });

    expect(readParserSettings(config)).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: null,
      apiKeyConfigured: true,
      outputLanguage: 'Traditional Chinese',
    });
  });

  test('normalizes codex cli parser settings without requiring an api key', () => {
    const config = {
      port: 7788,
      sessionsRoot: '/tmp/codex-sessions',
      databasePath: '/tmp/codex-boards-test.sqlite',
      openAiBaseUrl: 'https://api.deepseek.com',
      openAiApiKey: 'old-secret-token',
      openAiModel: 'deepseek-v4-flash',
    };

    expect(
      updateParserSettings(config, {
        provider: 'codex-cli',
        baseUrl: ' https://should-be-ignored.example/v1 ',
        model: ' gpt-5.4-mini ',
        apiKey: ' ignored-secret ',
      }),
    ).toEqual({
      provider: 'codex-cli',
      baseUrl: null,
      model: 'gpt-5.4-mini',
      apiKeyConfigured: false,
      outputLanguage: 'English',
    });

    expect(config.openAiBaseUrl).toBeNull();
    expect(config.openAiApiKey).toBeNull();
    expect(config.openAiModel).toBe('gpt-5.4-mini');
  });

  test('exposes and updates parser settings through the api', async () => {
    const root = `/tmp/codex-boards-settings-${Date.now()}`;
    mkdirSync(root, { recursive: true });

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: 'http://localhost:11434/v1',
      openAiApiKey: 'initial-key',
      openAiModel: 'qwen2.5-coder:7b',
    });

    try {
      const getResponse = await server.app.request('/api/settings');
      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toMatchObject({
        parser: {
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:7b',
          apiKeyConfigured: true,
          outputLanguage: 'English',
        },
      });

      const postResponse = await server.app.request('/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parser: {
            baseUrl: ' http://localhost:8000/v1 ',
            model: ' llama3.1:8b ',
            outputLanguage: ' Japanese ',
          },
        }),
      });

      expect(postResponse.status).toBe(200);
      expect(await postResponse.json()).toMatchObject({
        parser: {
          baseUrl: 'http://localhost:8000/v1',
          model: 'llama3.1:8b',
          apiKeyConfigured: true,
          outputLanguage: 'Japanese',
        },
      });

      expect(server.config.openAiBaseUrl).toBe('http://localhost:8000/v1');
      expect(server.config.openAiModel).toBe('llama3.1:8b');
      expect(server.config.openAiApiKey).toBe('initial-key');
      expect(server.config.parseOutputLanguage).toBe('Japanese');
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('persists parser settings across backend restarts', async () => {
    const root = `/tmp/codex-boards-settings-persist-${Date.now()}`;
    mkdirSync(root, { recursive: true });
    const databasePath = join(root, 'boards.sqlite');
    const sessionsRoot = join(root, 'sessions');

    const firstServer = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const postResponse = await firstServer.app.request('/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parser: {
            baseUrl: ' http://localhost:9000/v1 ',
            model: ' gpt-4.1-mini ',
            apiKey: ' persisted-key ',
            outputLanguage: ' Brazilian Portuguese ',
          },
        }),
      });

      expect(postResponse.status).toBe(200);
    } finally {
      firstServer.close();
    }

    const restartedServer = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const response = await restartedServer.app.request('/api/settings');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        parser: {
          baseUrl: 'http://localhost:9000/v1',
          model: 'gpt-4.1-mini',
          apiKeyConfigured: true,
          outputLanguage: 'Brazilian Portuguese',
        },
      });

      expect(restartedServer.config.openAiBaseUrl).toBe(
        'http://localhost:9000/v1',
      );
      expect(restartedServer.config.openAiModel).toBe('gpt-4.1-mini');
      expect(restartedServer.config.openAiApiKey).toBe('persisted-key');
      expect(restartedServer.config.parseOutputLanguage).toBe(
        'Brazilian Portuguese',
      );
    } finally {
      restartedServer.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('exposes onboarding state and sync status through the api', async () => {
    const root = `/tmp/codex-boards-status-${Date.now()}`;
    mkdirSync(root, { recursive: true });

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const settingsResponse = await server.app.request('/api/settings');
      expect(settingsResponse.status).toBe(200);
      expect(await settingsResponse.json()).toMatchObject({
        parser: {
          provider: 'codex-cli',
          baseUrl: null,
          model: null,
          apiKeyConfigured: false,
          outputLanguage: 'English',
        },
        onboarding: {
          required: true,
          step: 'provider',
          providerReady: false,
          hasCompletedSync: false,
        },
      });

      const statusResponse = await server.app.request('/api/sync/status');
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        status: {
          state: 'idle',
          phase: 'idle',
          lastSync: null,
          nextSyncAt: null,
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('reports discovered thread count before the first sync', async () => {
    const root = `/tmp/codex-boards-status-count-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });

    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-one.jsonl'),
      '{"timestamp":"2026-04-05T05:00:00.000Z","type":"session_meta","payload":{"id":"one","timestamp":"2026-04-05T04:59:00.000Z","cwd":"/tmp/no-git"}}\n',
    );
    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-two.jsonl'),
      '{"timestamp":"2026-04-05T05:01:00.000Z","type":"session_meta","payload":{"id":"two","timestamp":"2026-04-05T05:00:00.000Z","cwd":"/tmp/no-git"}}\n',
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const statusResponse = await server.app.request('/api/sync/status');

      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        status: {
          state: 'idle',
          phase: 'idle',
          lastSync: null,
          progress: {
            totalFiles: 2,
            scannedFiles: 0,
          },
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('moves onboarding to sync step after provider setup', async () => {
    const root = `/tmp/codex-boards-onboarding-${Date.now()}`;
    mkdirSync(root, { recursive: true });

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const response = await server.app.request('/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parser: {
            baseUrl: ' https://api.deepseek.com ',
            model: ' deepseek-v4-flash ',
            apiKey: ' test-key ',
            outputLanguage: ' Simplified Chinese ',
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        parser: {
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          apiKeyConfigured: true,
          outputLanguage: 'Simplified Chinese',
        },
        onboarding: {
          required: true,
          step: 'sync',
          providerReady: true,
          hasCompletedSync: false,
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('moves onboarding to sync step for codex cli without an api key', async () => {
    const root = `/tmp/codex-boards-onboarding-codex-cli-${Date.now()}`;
    mkdirSync(root, { recursive: true });

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const response = await server.app.request('/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parser: {
            provider: 'codex-cli',
            model: ' gpt-5.4-mini ',
            outputLanguage: ' French ',
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        parser: {
          provider: 'codex-cli',
          baseUrl: null,
          model: 'gpt-5.4-mini',
          apiKeyConfigured: false,
          outputLanguage: 'French',
        },
        onboarding: {
          required: true,
          step: 'sync',
          providerReady: true,
          hasCompletedSync: false,
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('skips first sync onboarding through settings api', async () => {
    const root = `/tmp/codex-boards-onboarding-skip-${Date.now()}`;
    const databasePath = join(root, 'boards.sqlite');
    const sessionsRoot = join(root, 'sessions');
    mkdirSync(root, { recursive: true });

    const firstServer = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const providerResponse = await firstServer.app.request('/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parser: {
            provider: 'codex-cli',
            model: ' gpt-5.4-mini ',
          },
        }),
      });

      expect(providerResponse.status).toBe(200);
      expect(await providerResponse.json()).toMatchObject({
        onboarding: {
          required: true,
          step: 'sync',
          providerReady: true,
          hasCompletedSync: false,
          hasSkippedSync: false,
        },
      });

      const skipResponse = await firstServer.app.request('/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          onboarding: {
            skipSync: true,
          },
        }),
      });

      expect(skipResponse.status).toBe(200);
      expect(await skipResponse.json()).toMatchObject({
        onboarding: {
          required: false,
          step: 'complete',
          providerReady: true,
          hasCompletedSync: false,
          hasSkippedSync: true,
        },
        sync: null,
      });
    } finally {
      firstServer.close();
    }

    const restartedServer = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const response = await restartedServer.app.request('/api/settings');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        onboarding: {
          required: false,
          step: 'complete',
          hasCompletedSync: false,
          hasSkippedSync: true,
        },
      });
    } finally {
      restartedServer.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('prefers desktop app data paths when configured', () => {
    const originalAppDataDir = process.env.CODEX_BOARDS_APP_DATA_DIR;
    const originalDatabasePath = process.env.CODEX_BOARDS_DB_PATH;

    process.env.CODEX_BOARDS_APP_DATA_DIR = '/tmp/codex-boards-app-data';
    process.env.CODEX_BOARDS_DB_PATH = '/tmp/ignored.sqlite';

    try {
      expect(resolveDatabasePath('/tmp/project-root')).toBe(
        '/tmp/codex-boards-app-data/codex-boards.sqlite',
      );
    } finally {
      if (originalAppDataDir === undefined) {
        process.env.CODEX_BOARDS_APP_DATA_DIR = undefined;
      } else {
        process.env.CODEX_BOARDS_APP_DATA_DIR = originalAppDataDir;
      }

      if (originalDatabasePath === undefined) {
        process.env.CODEX_BOARDS_DB_PATH = undefined;
      } else {
        process.env.CODEX_BOARDS_DB_PATH = originalDatabasePath;
      }
    }
  });

  test('returns parse log entries from sync runs through the api', async () => {
    const root = `/tmp/codex-boards-sync-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = '/tmp/codex-boards-fixture';
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-sample.jsonl'),
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ),
    );
    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-no-git.jsonl'),
      '{"timestamp":"2026-04-05T05:00:00.000Z","type":"session_meta","payload":{"id":"x","timestamp":"2026-04-05T04:59:00.000Z","cwd":"/tmp/no-git"}}\n',
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const response = await server.app.request('/api/sync', {
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        sync: {
          parserBaseUrl: 'codex-cli',
          parserModel: null,
          responseModels: [],
          aiRequestCount: 0,
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
          importedThreads: 1,
          skippedThreads: 1,
          parseLog: [
            {
              status: 'imported',
              parseMode: 'fallback',
              repository: 'codex-boards-fixture',
            },
            {
              status: 'skipped',
              parseMode: null,
            },
          ],
        },
      });

      const latestSync = server.database.getLatestSync();
      expect(latestSync?.parserBaseUrl).toBe('codex-cli');
      expect(latestSync?.parserModel).toBeNull();
      expect(latestSync?.responseModels).toEqual([]);
      expect(latestSync?.aiRequestCount).toBe(0);
      expect(latestSync?.tokenUsage.totalTokens).toBe(0);
      expect(latestSync?.parseLog).toHaveLength(2);
      expect(latestSync?.parseLog[0]?.filePath).toContain(
        'rollout-sample.jsonl',
      );
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(gitWorkspace, { force: true, recursive: true });
    }
  });

  test('limits maxThreads to the first sync only', async () => {
    const root = `/tmp/codex-boards-sync-limit-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = '/tmp/codex-boards-fixture';
    mkdirSync(join(sessionsRoot, '2026', '04', '05'), { recursive: true });
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    writeFileSync(
      join(sessionsRoot, '2026', '04', '05', 'rollout-no-git.jsonl'),
      '{"timestamp":"2026-04-05T05:00:00.000Z","type":"session_meta","payload":{"id":"x","timestamp":"2026-04-05T04:59:00.000Z","cwd":"/tmp/no-git"}}\n',
    );
    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-sample.jsonl'),
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const firstResponse = await server.app.request('/api/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          trigger: 'onboarding',
          maxThreads: 1,
        }),
      });

      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 1,
          importedThreads: 1,
          parseLog: [
            {
              status: 'imported',
              repository: 'codex-boards-fixture',
            },
          ],
        },
      });

      const secondResponse = await server.app.request('/api/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          trigger: 'onboarding',
          maxThreads: 1,
        }),
      });

      expect(secondResponse.status).toBe(200);
      expect(await secondResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 2,
          importedThreads: 0,
          skippedThreads: 2,
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(gitWorkspace, { force: true, recursive: true });
    }
  });

  test('background sync scans only newly updated rollout files', async () => {
    const root = `/tmp/codex-boards-background-sync-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = join(root, 'workspace');
    const sessionsDay = join(sessionsRoot, '2026', '04', '06');
    const firstRolloutPath = join(sessionsDay, 'rollout-alpha.jsonl');
    const secondRolloutPath = join(sessionsDay, 'rollout-beta.jsonl');
    mkdirSync(sessionsDay, { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    const fixture = readFileSync(
      join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
      'utf8',
    ).replaceAll('/tmp/codex-boards-fixture', gitWorkspace);

    writeFileSync(
      firstRolloutPath,
      fixture.replaceAll('thread-abc', 'thread-alpha'),
    );
    writeFileSync(
      secondRolloutPath,
      fixture
        .replaceAll('thread-abc', 'thread-beta')
        .replaceAll(
          'Build a sync service for the board',
          'Improve background sync for the board',
        ),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const firstResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });

      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 2,
          importedThreads: 2,
          skippedThreads: 0,
        },
      });

      writeFileSync(
        secondRolloutPath,
        `${readFileSync(secondRolloutPath, 'utf8')}\n{"timestamp":"2026-04-05T05:00:05.000Z","type":"event_msg","payload":{"type":"user_message","message":"Only this thread changed during automatic sync."}}\n`,
      );

      const backgroundResponse = await server.app.request('/api/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          trigger: 'background',
        }),
      });

      expect(backgroundResponse.status).toBe(200);
      expect(await backgroundResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 1,
          changedFiles: 1,
          importedThreads: 1,
          skippedThreads: 0,
          parseLog: [
            {
              threadId: 'thread-beta',
              status: 'imported',
            },
          ],
        },
      });

      const idleBackgroundResponse = await server.app.request('/api/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          trigger: 'background',
        }),
      });

      expect(idleBackgroundResponse.status).toBe(200);
      expect(await idleBackgroundResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 0,
          changedFiles: 0,
          importedThreads: 0,
          skippedThreads: 0,
          parseLog: [],
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('exports project issues to multica through the api', async () => {
    const root = `/tmp/codex-boards-export-${Date.now()}`;
    mkdirSync(root, { recursive: true });

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      server.database.upsertProject({
        id: 'codex-boards',
        name: 'codex-boards',
        repository: 'codex-boards',
        workspacePath: '/tmp/codex-boards',
        issueCount: 1,
        needsReviewCount: 0,
        lastUpdatedAt: '2026-04-09T00:00:00.000Z',
      });

      server.database.upsertIssue({
        id: 'issue-1',
        threadId: 'thread-1',
        projectId: 'codex-boards',
        title: 'Export issues to Multica',
        tags: ['backend'],
        summary: 'Export the board data to Multica.',
        startedAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
        parseMode: 'fallback',
        confidence: 0.6,
        needsReview: false,
        git: {
          repository: 'codex-boards',
          workspacePath: '/tmp/codex-boards',
          branch: 'feat/export',
          commits: [],
          tags: [],
        },
        evidence: {
          rolloutPath: '/tmp/rollout.jsonl',
          sessionId: 'session-1',
          threadId: 'thread-1',
          warnings: [],
          parsePayloadPreview: 'preview',
        },
        stats: {
          messageCount: 2,
          commandCount: 0,
          imageCount: 0,
        },
        images: [],
      });

      const response = await server.app.request('/api/export/multica', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: 'codex-boards',
          runSync: false,
          dryRun: true,
        }),
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok: boolean;
        exported: Array<{
          sourceIssueId: string;
          title: string;
          dryRun: boolean;
          command: string[];
        }>;
        skippedChildren: Array<{ sourceIssueId: string; reason: string }>;
      };
      expect(json).toMatchObject({
        ok: true,
        exported: [
          {
            sourceIssueId: 'issue-1',
            dryRun: true,
            title: 'Export issues to Multica',
          },
        ],
        skippedChildren: [],
      });
      expect(json.exported).toHaveLength(1);
      expect(json.exported[0]?.command).toContain('--title');
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('stores sync usage details and exposes sync history in settings', async () => {
    const root = `/tmp/codex-boards-sync-ai-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = '/tmp/codex-boards-fixture-ai';
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-sample.jsonl'),
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ),
    );

    const originalFetch = globalThis.fetch;
    let requestBody = '';
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini-2026-04-01',
          usage: {
            prompt_tokens: 111,
            completion_tokens: 29,
            total_tokens: 140,
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: 'Build a sync service for the board',
                  summary: 'Save parsed board issues from rollout history.',
                  tags: ['backend', 'sync'],
                  warnings: [],
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    };

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: 'http://localhost:11434/v1',
      openAiApiKey: 'test-key',
      openAiModel: 'gpt-4.1-mini',
      parseOutputLanguage: 'Traditional Chinese',
    });

    try {
      const syncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });

      expect(syncResponse.status).toBe(200);
      expect(await syncResponse.json()).toMatchObject({
        ok: true,
        sync: {
          parserBaseUrl: 'http://localhost:11434/v1',
          parserModel: 'gpt-4.1-mini',
          responseModels: ['gpt-4.1-mini-2026-04-01'],
          aiRequestCount: 1,
          tokenUsage: {
            promptTokens: 111,
            completionTokens: 29,
            totalTokens: 140,
          },
          importedThreads: 1,
          skippedThreads: 0,
          aiParsedIssues: 1,
        },
      });
      expect(requestBody).toContain(
        'Write title, summary, tags, and warnings in Traditional Chinese.',
      );

      const settingsResponse = await server.app.request('/api/settings');
      expect(settingsResponse.status).toBe(200);
      expect(await settingsResponse.json()).toMatchObject({
        parser: {
          baseUrl: 'http://localhost:11434/v1',
          model: 'gpt-4.1-mini',
          apiKeyConfigured: true,
          outputLanguage: 'Traditional Chinese',
        },
        sync: {
          parserBaseUrl: 'http://localhost:11434/v1',
          parserModel: 'gpt-4.1-mini',
          responseModels: ['gpt-4.1-mini-2026-04-01'],
          tokenUsage: {
            totalTokens: 140,
          },
        },
        syncHistory: [
          {
            parserBaseUrl: 'http://localhost:11434/v1',
            parserModel: 'gpt-4.1-mini',
            responseModels: ['gpt-4.1-mini-2026-04-01'],
            aiRequestCount: 1,
            tokenUsage: {
              promptTokens: 111,
              completionTokens: 29,
              totalTokens: 140,
            },
          },
        ],
      });

      const runsResponse = await server.app.request('/api/sync/runs');
      expect(runsResponse.status).toBe(200);
      expect(await runsResponse.json()).toMatchObject({
        sync: {
          parserModel: 'gpt-4.1-mini',
        },
        runs: [
          {
            responseModels: ['gpt-4.1-mini-2026-04-01'],
            tokenUsage: {
              totalTokens: 140,
            },
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
      server.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(gitWorkspace, { force: true, recursive: true });
    }
  });

  test('parses sync issues with codex cli without output schema or persisted threads', async () => {
    const root = `/tmp/codex-boards-sync-codex-cli-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = '/tmp/codex-boards-fixture';
    const fakeBin = join(root, 'bin');
    const fakeCodex = join(fakeBin, 'codex');
    const fakeArgsPath = join(root, 'codex-args.txt');
    const fakeStdinPath = join(root, 'codex-stdin.txt');
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-sample.jsonl'),
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ),
    );
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env sh
args="$*"
printf '%s\\n' "$args" > "$CODEX_FAKE_ARGS_PATH"
cat > "$CODEX_FAKE_STDIN_PATH"
case "$args" in
  *"--output-schema"*) exit 42 ;;
esac
case "$args" in
  *"--ask-for-approval"*) exit 45 ;;
esac
case "$args" in
  *"--ephemeral"*) ;;
  *) exit 43 ;;
esac
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    output="$1"
  fi
  shift
done
if [ -z "$output" ]; then
  exit 44
fi
cat > "$output" <<'JSON'
{"title":"Parse rollout issues through Codex CLI","summary":"Use Codex CLI as the parser without relying on structured response schema support.","tags":["backend","sync"],"warnings":[]}
JSON
`,
    );
    chmodSync(fakeCodex, 0o755);

    const originalFakeArgsPath = process.env.CODEX_FAKE_ARGS_PATH;
    const originalFakeStdinPath = process.env.CODEX_FAKE_STDIN_PATH;
    const originalCodexCliBin = process.env.CODEX_BOARDS_CODEX_CLI_BIN;
    process.env.CODEX_BOARDS_CODEX_CLI_BIN = fakeCodex;
    process.env.CODEX_FAKE_ARGS_PATH = fakeArgsPath;
    process.env.CODEX_FAKE_STDIN_PATH = fakeStdinPath;

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      parserProvider: 'codex-cli',
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: 'gpt-5.4-mini',
      parseOutputLanguage: 'Simplified Chinese',
    });

    try {
      const syncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });

      expect(syncResponse.status).toBe(200);
      expect(await syncResponse.json()).toMatchObject({
        ok: true,
        sync: {
          parserBaseUrl: 'codex-cli',
          parserModel: 'gpt-5.4-mini',
          responseModels: ['gpt-5.4-mini'],
          aiRequestCount: 1,
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
          aiParsedIssues: 1,
        },
      });

      const args = readFileSync(fakeArgsPath, 'utf8');
      expect(args).toContain('exec -m gpt-5.4-mini');
      expect(args).toContain('--ephemeral');
      expect(args).not.toContain('--output-schema');
      expect(args).not.toContain('--ask-for-approval');
      const stdin = readFileSync(fakeStdinPath, 'utf8');
      expect(stdin).toContain('CODEX_BOARDS_SYNC_PARSER_RUN_DO_NOT_IMPORT');
      expect(stdin).toContain(
        'Write title, summary, tags, and warnings in Simplified Chinese.',
      );

      const issuesResponse = await server.app.request(
        '/api/issues?projectId=codex-boards-fixture',
      );
      expect(issuesResponse.status).toBe(200);
      expect(await issuesResponse.json()).toMatchObject({
        issues: [
          {
            title: 'Parse rollout issues through Codex CLI',
            parseMode: 'ai',
          },
        ],
      });
    } finally {
      if (originalCodexCliBin === undefined) {
        process.env.CODEX_BOARDS_CODEX_CLI_BIN = undefined;
      } else {
        process.env.CODEX_BOARDS_CODEX_CLI_BIN = originalCodexCliBin;
      }
      if (originalFakeArgsPath === undefined) {
        process.env.CODEX_FAKE_ARGS_PATH = undefined;
      } else {
        process.env.CODEX_FAKE_ARGS_PATH = originalFakeArgsPath;
      }
      if (originalFakeStdinPath === undefined) {
        process.env.CODEX_FAKE_STDIN_PATH = undefined;
      } else {
        process.env.CODEX_FAKE_STDIN_PATH = originalFakeStdinPath;
      }
      server.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(gitWorkspace, { force: true, recursive: true });
    }
  });

  test('reparses unchanged files after parser settings change', async () => {
    const root = `/tmp/codex-boards-sync-reparse-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = '/tmp/codex-boards-fixture-reparse';
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    const rolloutPath = join(
      sessionsRoot,
      '2026',
      '04',
      '06',
      'rollout-sample.jsonl',
    );
    writeFileSync(
      rolloutPath,
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ),
    );

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini-2026-04-01',
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title:
                    'Create project-oriented issue titles from rollout threads',
                  summary:
                    'Rewrite imported board issues into cleaner tracker-style titles.',
                  tags: ['backend', 'sync'],
                  warnings: [],
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    };

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const fallbackSyncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(fallbackSyncResponse.status).toBe(200);
      expect(fetchCalls).toBe(0);

      const fallbackIssuesResponse = await server.app.request(
        '/api/issues?projectId=codex-boards-fixture',
      );
      expect(fallbackIssuesResponse.status).toBe(200);
      expect(await fallbackIssuesResponse.json()).toMatchObject({
        issues: [
          {
            title: 'Build a sync service for the board',
            parseMode: 'fallback',
          },
        ],
      });

      const settingsUpdateResponse = await server.app.request('/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parser: {
            baseUrl: ' http://localhost:11434/v1 ',
            model: ' gpt-4.1-mini ',
            apiKey: ' test-key ',
          },
        }),
      });
      expect(settingsUpdateResponse.status).toBe(200);

      const aiSyncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(aiSyncResponse.status).toBe(200);
      expect(fetchCalls).toBe(1);

      const aiIssuesResponse = await server.app.request(
        '/api/issues?projectId=codex-boards-fixture',
      );
      expect(aiIssuesResponse.status).toBe(200);
      expect(await aiIssuesResponse.json()).toMatchObject({
        issues: [
          {
            title: 'Create project-oriented issue titles from rollout threads',
            parseMode: 'ai',
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
      server.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(gitWorkspace, { force: true, recursive: true });
    }
  });

  test('reparses files imported with a legacy parser fingerprint', async () => {
    const root = `/tmp/codex-boards-parser-version-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = join(root, 'workspace');
    const rolloutPath = join(
      sessionsRoot,
      '2026',
      '04',
      '06',
      'rollout-sample.jsonl',
    );
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    writeFileSync(
      rolloutPath,
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ).replaceAll('/tmp/codex-boards-fixture', gitWorkspace),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const rolloutStats = statSync(rolloutPath);
      server.database.saveSyncFile(
        rolloutPath,
        rolloutStats.mtimeMs,
        rolloutStats.size,
        'fallback-only',
        'thread-abc',
        new Date().toISOString(),
      );

      const syncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });

      expect(syncResponse.status).toBe(200);
      expect(await syncResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 1,
          changedFiles: 1,
          importedThreads: 1,
          skippedThreads: 0,
          parseLog: [
            {
              status: 'imported',
              threadId: 'thread-abc',
            },
          ],
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('reparses files imported with the prior codex cli parser fingerprint', async () => {
    const root = `/tmp/codex-boards-parser-version-codex-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const rolloutPath = join(
      sessionsRoot,
      '2026',
      '04',
      '06',
      'rollout-sample.jsonl',
    );
    const gitWorkspace = '/tmp/codex-boards-fixture';
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    writeFileSync(
      rolloutPath,
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ).replaceAll('/tmp/codex-boards-fixture', gitWorkspace),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      parserProvider: 'codex-cli',
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      parseOutputLanguage: 'Simplified Chinese',
      syncIntervalMs: 0,
    });

    try {
      const rolloutStats = statSync(rolloutPath);
      server.database.saveSyncFile(
        rolloutPath,
        rolloutStats.mtimeMs,
        rolloutStats.size,
        'codex-cli:gpt-5.4-mini:plain-json:thread-issue-v2:language=Simplified Chinese',
        'thread-abc',
        new Date().toISOString(),
      );

      const syncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });

      expect(syncResponse.status).toBe(200);
      expect(await syncResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 1,
          changedFiles: 1,
          importedThreads: 1,
          skippedThreads: 0,
          parseLog: [
            {
              status: 'imported',
              threadId: 'thread-abc',
            },
          ],
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('skips unchanged rollout files during incremental sync', async () => {
    const root = `/tmp/codex-boards-incremental-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = '/tmp/codex-boards-fixture';
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-sample.jsonl'),
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      const firstSync = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(firstSync.status).toBe(200);
      expect(await firstSync.json()).toMatchObject({
        sync: {
          scannedFiles: 1,
          changedFiles: 1,
          importedThreads: 1,
        },
      });

      const secondSync = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(secondSync.status).toBe(200);
      expect(await secondSync.json()).toMatchObject({
        sync: {
          scannedFiles: 1,
          changedFiles: 0,
          importedThreads: 0,
          skippedThreads: 1,
          parseLog: [
            {
              status: 'skipped',
              message: 'Skipped: rollout file unchanged for current parser.',
            },
          ],
        },
      });

      const issuesResponse = await server.app.request(
        '/api/issues?projectId=codex-boards-fixture',
      );
      expect(issuesResponse.status).toBe(200);
      expect(await issuesResponse.json()).toMatchObject({
        issues: [
          {
            title: 'Build a sync service for the board',
          },
        ],
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(gitWorkspace, { force: true, recursive: true });
    }
  });

  test('runs background sync after the first completed sync', async () => {
    const root = `/tmp/codex-boards-background-sync-${Date.now()}`;
    mkdirSync(root, { recursive: true });

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 20,
    });

    try {
      const firstSync = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(firstSync.status).toBe(200);

      await delay(90);

      expect(server.database.listSyncRuns().length).toBeGreaterThan(1);
      expect(server.syncCoordinator.getStatus().lastSync).not.toBeNull();
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('full sync clears old imported data before rebuilding', async () => {
    const root = `/tmp/codex-boards-full-sync-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const gitWorkspace = '/tmp/codex-boards-fixture-full-sync';
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(gitWorkspace, '.git'), { recursive: true });

    const rolloutPath = join(
      sessionsRoot,
      '2026',
      '04',
      '06',
      'rollout-sample.jsonl',
    );
    writeFileSync(
      rolloutPath,
      readFileSync(
        join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
        'utf8',
      ),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const firstSync = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(firstSync.status).toBe(200);

      writeFileSync(
        rolloutPath,
        '{"timestamp":"2026-04-06T08:00:00.000Z","type":"session_meta","payload":{"id":"x","timestamp":"2026-04-06T07:59:00.000Z","cwd":"/tmp/no-git"}}\n',
      );

      const secondSync = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(secondSync.status).toBe(200);
      expect(await secondSync.json()).toMatchObject({
        sync: {
          scannedFiles: 1,
          changedFiles: 1,
          importedThreads: 0,
          skippedThreads: 1,
        },
      });

      const issuesResponse = await server.app.request(
        '/api/issues?projectId=codex-boards-fixture',
      );
      expect(issuesResponse.status).toBe(200);
      expect(await issuesResponse.json()).toMatchObject({
        issues: [],
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(gitWorkspace, { force: true, recursive: true });
    }
  });

  test('sync processes all discovered rollout files', async () => {
    const root = `/tmp/codex-boards-full-parse-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });

    for (let index = 0; index < 25; index += 1) {
      writeFileSync(
        join(
          sessionsRoot,
          '2026',
          '04',
          '06',
          `rollout-no-git-${String(index).padStart(2, '0')}.jsonl`,
        ),
        `{"timestamp":"2026-04-06T08:00:00.000Z","type":"session_meta","payload":{"id":"no-git-${index}","timestamp":"2026-04-06T07:59:00.000Z","cwd":"/tmp/no-git-${index}"}}\n`,
      );
    }

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const syncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(syncResponse.status).toBe(200);
      expect(await syncResponse.json()).toMatchObject({
        sync: {
          scannedFiles: 25,
          changedFiles: 25,
          importedThreads: 0,
          skippedThreads: 25,
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('serves local file image previews from issue details', async () => {
    const root = `/tmp/codex-boards-image-preview-${Date.now()}`;
    const sessionsRoot = join(root, 'sessions');
    const workspacePath = join(root, 'image-workspace');
    const imagePath = join(workspacePath, 'screens', 'sheet.png');
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );

    mkdirSync(join(sessionsRoot, '2026', '04', '06'), { recursive: true });
    mkdirSync(join(workspacePath, '.git'), { recursive: true });
    mkdirSync(join(workspacePath, 'screens'), { recursive: true });
    writeFileSync(imagePath, pngBytes);
    writeFileSync(
      join(sessionsRoot, '2026', '04', '06', 'rollout-image-preview.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-05T05:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'image-preview-thread',
            timestamp: '2026-04-05T04:59:00.000Z',
            cwd: workspacePath,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-05T05:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message:
              'Fix the issue detail sheet. ![Sheet screenshot](./screens/sheet.png)',
          },
        }),
      ].join('\n'),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const syncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });
      expect(syncResponse.status).toBe(200);

      const issuesResponse = await server.app.request(
        '/api/issues?projectId=image-workspace',
      );
      expect(issuesResponse.status).toBe(200);
      const issuesPayload = (await issuesResponse.json()) as IssueListResponse;
      const issue = issuesPayload.issues[0];
      expect(issue?.stats.imageCount).toBe(1);

      const detailResponse = await server.app.request(
        `/api/issues/${issue?.id}`,
      );
      expect(detailResponse.status).toBe(200);
      const detailPayload =
        (await detailResponse.json()) as IssueDetailResponse;
      const image = detailPayload.issue?.images?.[0];
      expect(image?.sourceType).toBe('file_path');
      expect(image?.filename).toBe('sheet.png');
      expect(image?.previewUrl).toContain('/issue-images/');

      if (!image?.previewUrl) {
        throw new Error('Expected local image preview URL');
      }

      const previewUrl = new URL(image.previewUrl);
      const previewResponse = await server.app.request(previewUrl.pathname);
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get('content-type')).toBe('image/png');
      expect(
        Buffer.from(await previewResponse.arrayBuffer()).equals(pngBytes),
      ).toBe(true);
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe('rollout parser', () => {
  test('parses git-backed rollout files and extracts evidence', () => {
    const workspacePath = '/tmp/codex-boards-fixture';
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    const candidate = parseRolloutFile({
      path: join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
      mtimeMs: Date.now(),
      sizeBytes: 1,
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.git.repository).toBe('codex-boards-fixture');
    expect(candidate?.git.branch).toBe('feat/thread-sync');
    expect(candidate?.git.commits[0]?.sha).toBe('9f31c2edc0f');
    expect(candidate?.git.tags).toEqual(['v0.1.0']);
    rmSync(workspacePath, { force: true, recursive: true });
  });

  test('builds truncated parse payload and fallback issues', async () => {
    const workspacePath = '/tmp/codex-boards-fixture';
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    const candidate = parseRolloutFile({
      path: join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
      mtimeMs: Date.now(),
      sizeBytes: 1,
    });
    if (!candidate) {
      throw new Error('Expected parsed candidate');
    }

    const payload = buildParsePayload(candidate);
    expect(payload.content).toContain('Repository: codex-boards-fixture');
    expect(payload.preview.length).toBeLessThanOrEqual(1603);

    const result = await buildIssuesFromCandidate(candidate, {
      openAiApiKey: null,
      openAiBaseUrl: null,
      openAiModel: null,
    });

    expect(result.parseMode).toBe('fallback');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.title).toBe('Build a sync service for the board');
    expect(result.issues[0]?.summary).toContain(
      'Includes extract git commit info, save issues into sqlite, show a notion like table.',
    );
    expect(result.issues[0]?.stats.messageCount).toBeGreaterThan(0);
    rmSync(workspacePath, { force: true, recursive: true });
  });

  test('extracts image references from rollout threads', async () => {
    const root = `/tmp/codex-boards-images-${Date.now()}`;
    const workspacePath = join(root, 'workspace');
    const rolloutPath = join(root, 'rollout-image-thread.jsonl');
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-04-05T05:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'image-thread',
            timestamp: '2026-04-05T04:59:00.000Z',
            cwd: workspacePath,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-05T05:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message:
              'Build the image detail sheet. ![Screenshot](https://example.com/screenshot.png)',
          },
        }),
      ].join('\n'),
    );

    const candidate = parseRolloutFile({
      path: rolloutPath,
      mtimeMs: Date.now(),
      sizeBytes: 1,
    });
    if (!candidate) {
      throw new Error('Expected parsed candidate');
    }

    expect(candidate.images).toHaveLength(1);
    expect(candidate.images[0]).toMatchObject({
      sourceType: 'url',
      originalUrl: 'https://example.com/screenshot.png',
      caption: 'Screenshot',
    });

    const result = await buildIssuesFromCandidate(candidate, {
      openAiApiKey: null,
      openAiBaseUrl: null,
      openAiModel: null,
    });

    expect(result.issues[0]?.stats.imageCount).toBe(1);
    expect(result.issues[0]?.images?.[0]).toMatchObject({
      issueId: 'workspace:image-thread',
      sourceType: 'url',
    });

    rmSync(root, { force: true, recursive: true });
  });

  test('retries ai parsing when the response is not a JSON object', async () => {
    const workspacePath = '/tmp/codex-boards-fixture';
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    const candidate = parseRolloutFile({
      path: join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
      mtimeMs: Date.now(),
      sizeBytes: 1,
    });
    if (!candidate) {
      throw new Error('Expected parsed candidate');
    }

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini-2026-04-01',
          usage: {
            prompt_tokens: 80,
            completion_tokens: 20,
            total_tokens: 100,
          },
          choices: [
            {
              message: {
                content:
                  fetchCalls < 4
                    ? 'I can summarize the thread, but I will not emit JSON.'
                    : JSON.stringify({
                        title: 'Retry non-json parse responses',
                        summary:
                          'Retry parser calls when the model omits the required JSON object.',
                        tags: ['backend', 'sync'],
                        warnings: [],
                      }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    };

    try {
      const result = await buildIssuesFromCandidate(candidate, {
        openAiApiKey: 'test-key',
        openAiBaseUrl: 'http://localhost:11434/v1',
        openAiModel: 'gpt-4.1-mini',
      });

      expect(fetchCalls).toBe(4);
      expect(result.parseMode).toBe('ai');
      expect(result.aiDiagnostics.requestCount).toBe(4);
      expect(result.issues[0]?.title).toBe('Retry non-json parse responses');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspacePath, { force: true, recursive: true });
    }
  });

  test('rewrites question-style ai titles into outcome titles', async () => {
    const workspacePath = '/tmp/codex-boards-fixture-ai-title';
    mkdirSync(join(workspacePath, '.git'), { recursive: true });

    const candidate = parseRolloutFile({
      path: join(process.cwd(), 'tests/fixtures/rollout-sample.jsonl'),
      mtimeMs: Date.now(),
      sizeBytes: 1,
    });
    if (!candidate) {
      throw new Error('Expected parsed candidate');
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          model: 'gpt-4.1-mini-2026-04-01',
          usage: {
            prompt_tokens: 80,
            completion_tokens: 20,
            total_tokens: 100,
          },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title:
                    'Can you confirm that the dictionary is used during recognize?',
                  summary:
                    'Verify dictionary-backed recognition and document the actual recognition path used by the feature.',
                  tags: ['backend'],
                  warnings: [],
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );

    try {
      const result = await buildIssuesFromCandidate(candidate, {
        openAiApiKey: 'test-key',
        openAiBaseUrl: 'http://localhost:11434/v1',
        openAiModel: 'gpt-4.1-mini',
      });

      expect(result.parseMode).toBe('ai');
      expect(result.issues[0]?.title).toBe(
        'Verify dictionary-backed recognition and document the actual recognition path used by the feature',
      );
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(workspacePath, { force: true, recursive: true });
    }
  });

  test('ignores rollouts without git evidence', () => {
    const tempFile = join(process.cwd(), 'tests/fixtures/rollout-no-git.jsonl');
    writeFileSync(
      tempFile,
      '{"timestamp":"2026-04-05T05:00:00.000Z","type":"session_meta","payload":{"id":"x","timestamp":"2026-04-05T04:59:00.000Z","cwd":"/tmp/no-git"}}\n',
    );

    const candidate = parseRolloutFile({
      path: tempFile,
      mtimeMs: Date.now(),
      sizeBytes: 1,
    });

    expect(candidate).toBeNull();
    rmSync(tempFile, { force: true });
  });

  test('ignores accidentally persisted codex cli parser rollouts', () => {
    const root = `/tmp/codex-boards-parser-self-${Date.now()}`;
    const workspacePath = join(root, 'workspace');
    const rolloutPath = join(root, 'rollout-codex-cli-parser.jsonl');
    mkdirSync(join(workspacePath, '.git'), { recursive: true });
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-04-05T05:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'thread-parser-self',
            timestamp: '2026-04-05T04:59:00.000Z',
            cwd: workspacePath,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-05T05:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message:
              'Internal marker: CODEX_BOARDS_SYNC_PARSER_RUN_DO_NOT_IMPORT.',
          },
        }),
      ].join('\n'),
    );

    try {
      expect(
        parseRolloutFile({
          path: rolloutPath,
          mtimeMs: Date.now(),
          sizeBytes: 1,
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
