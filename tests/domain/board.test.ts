import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
import {
  inferIssuePriority,
  inferIssueStatus,
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

  test('infers status and priority from content', () => {
    expect(inferIssueStatus('Need to fix this issue before merge')).toBe(
      'todo',
    );
    expect(inferIssuePriority('Critical blocking bug for production')).toBe(
      'urgent',
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
      }),
    ).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
      apiKeyConfigured: true,
    });

    expect(
      updateParserSettings(config, {
        model: '   ',
      }),
    ).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: null,
      apiKeyConfigured: true,
    });

    expect(readParserSettings(config)).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: null,
      apiKeyConfigured: true,
    });
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
          },
        }),
      });

      expect(postResponse.status).toBe(200);
      expect(await postResponse.json()).toMatchObject({
        parser: {
          baseUrl: 'http://localhost:8000/v1',
          model: 'llama3.1:8b',
          apiKeyConfigured: true,
        },
      });

      expect(server.config.openAiBaseUrl).toBe('http://localhost:8000/v1');
      expect(server.config.openAiModel).toBe('llama3.1:8b');
      expect(server.config.openAiApiKey).toBe('initial-key');
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
        },
      });

      expect(restartedServer.config.openAiBaseUrl).toBe(
        'http://localhost:9000/v1',
      );
      expect(restartedServer.config.openAiModel).toBe('gpt-4.1-mini');
      expect(restartedServer.config.openAiApiKey).toBe('persisted-key');
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
          parserBaseUrl: null,
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
      expect(latestSync?.parserBaseUrl).toBeNull();
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
        subIssueCount: 1,
        needsReviewCount: 0,
        lastUpdatedAt: '2026-04-09T00:00:00.000Z',
      });

      server.database.upsertIssue({
        id: 'issue-parent',
        threadId: 'thread-1',
        projectId: 'codex-boards',
        parentIssueId: null,
        kind: 'parent',
        title: 'Export issues to Multica',
        status: 'todo',
        priority: 'high',
        assignee: null,
        dueDate: null,
        tags: ['backend'],
        summary: 'Export the board data to Multica.',
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
        subIssueCount: 1,
        children: [],
      });

      server.database.upsertIssue({
        id: 'issue-child',
        threadId: 'thread-1',
        projectId: 'codex-boards',
        parentIssueId: 'issue-parent',
        kind: 'sub_issue',
        title: 'Export child issues to Multica',
        status: 'todo',
        priority: 'medium',
        assignee: null,
        dueDate: null,
        tags: ['backend'],
        summary: 'Export child issue data to Multica.',
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
        subIssueCount: 0,
        children: [],
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
            sourceIssueId: 'issue-parent',
            dryRun: true,
            title: 'Export issues to Multica',
          },
          {
            sourceIssueId: 'issue-child',
            dryRun: true,
            title: 'Export child issues to Multica',
          },
        ],
        skippedChildren: [],
      });
      expect(json.exported).toHaveLength(2);
      expect(json.exported[0]?.command).toContain('--title');
      expect(json.exported[1]?.command).toContain('--parent');
      expect(json.exported[1]?.command).toContain('dry-run:issue-parent');
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
    globalThis.fetch = async () =>
      new Response(
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
                  parent: {
                    title: 'Build a sync service for the board',
                    summary: 'Save parsed board issues from rollout history.',
                    status: 'done',
                    priority: 'medium',
                    assignee: null,
                    dueDate: null,
                    tags: ['backend', 'sync'],
                  },
                  subIssues: [],
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

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      openAiBaseUrl: 'http://localhost:11434/v1',
      openAiApiKey: 'test-key',
      openAiModel: 'gpt-4.1-mini',
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

      const settingsResponse = await server.app.request('/api/settings');
      expect(settingsResponse.status).toBe(200);
      expect(await settingsResponse.json()).toMatchObject({
        parser: {
          baseUrl: 'http://localhost:11434/v1',
          model: 'gpt-4.1-mini',
          apiKeyConfigured: true,
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
                  parent: {
                    title:
                      'Create project-oriented issue titles from rollout threads',
                    summary:
                      'Rewrite imported board issues into cleaner tracker-style titles.',
                    status: 'done',
                    priority: 'medium',
                    assignee: null,
                    dueDate: null,
                    tags: ['backend', 'sync'],
                  },
                  subIssues: [],
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
    expect(result.issues[0]?.kind).toBe('parent');
    expect(result.issues[0]?.title).toBe('Build a sync service for the board');
    expect(result.issues[0]?.summary).toContain(
      'Includes extract git commit info, save issues into sqlite, show a notion like table.',
    );
    expect(result.issues[0]?.subIssueCount).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.kind === 'sub_issue')).toBe(
      true,
    );
    rmSync(workspacePath, { force: true, recursive: true });
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
                  parent: {
                    title:
                      'Can you confirm that the dictionary is used during recognize?',
                    summary:
                      'Verify dictionary-backed recognition and document the actual recognition path used by the feature.',
                    status: 'done',
                    priority: 'medium',
                    assignee: null,
                    dueDate: null,
                    tags: ['backend'],
                  },
                  subIssues: [],
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
});
