import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createAppServer } from '../../apps/backend/src/index';

function writeUsageLog(
  path: string,
  sessionId: string,
  timestamp: string,
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  },
): void {
  writeFileSync(
    path,
    [
      JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: {
          id: sessionId,
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'turn_context',
        payload: {
          turn_id: `${sessionId}-turn-1`,
          model: 'gpt-test',
          effort: 'medium',
        },
      }),
      JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: usage.inputTokens,
              cached_input_tokens: usage.cachedInputTokens,
              output_tokens: usage.outputTokens,
              reasoning_output_tokens: usage.reasoningOutputTokens,
              total_tokens: usage.totalTokens,
            },
            total_token_usage: {
              input_tokens: usage.inputTokens,
              cached_input_tokens: usage.cachedInputTokens,
              output_tokens: usage.outputTokens,
              reasoning_output_tokens: usage.reasoningOutputTokens,
              total_tokens: usage.totalTokens,
            },
          },
        },
      }),
    ].join('\n'),
  );
}

describe('usage api', () => {
  test('refreshes aggregate usage after sync runs', async () => {
    const root = `/tmp/codex-boards-usage-sync-${Date.now()}`;
    const codexHome = join(root, 'codex-home');
    const sessionsRoot = join(codexHome, 'sessions');
    mkdirSync(sessionsRoot, { recursive: true });

    writeUsageLog(
      join(sessionsRoot, 'active.jsonl'),
      'session-active',
      '2026-06-01T08:00:00.000Z',
      {
        inputTokens: 1000,
        cachedInputTokens: 300,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        totalTokens: 1200,
      },
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      codexHome,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
      syncIntervalMs: 0,
    });

    try {
      expect(server.database.readUsageRefresh().refreshedAt).toBeNull();

      const syncResponse = await server.app.request('/api/sync', {
        method: 'POST',
      });

      expect(syncResponse.status).toBe(200);
      expect(server.database.readUsageRefresh()).toMatchObject({
        scannedFiles: 1,
        parsedEvents: 1,
        skippedEvents: 0,
        includedArchived: true,
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('builds the usage index on first read', async () => {
    const root = `/tmp/codex-boards-usage-first-read-${Date.now()}`;
    const codexHome = join(root, 'codex-home');
    const sessionsRoot = join(codexHome, 'sessions');
    mkdirSync(sessionsRoot, { recursive: true });

    writeUsageLog(
      join(sessionsRoot, 'active.jsonl'),
      'session-active',
      '2026-06-01T08:00:00.000Z',
      {
        inputTokens: 1000,
        cachedInputTokens: 300,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        totalTokens: 1200,
      },
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      codexHome,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const response = await server.app.request(
        '/api/usage?range=custom&start=2026-06-01&end=2026-06-01',
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        refresh: {
          scannedFiles: 1,
          parsedEvents: 1,
          skippedEvents: 0,
          includedArchived: true,
        },
        summary: {
          totalTokens: 1200,
          cachedInputTokens: 300,
          uncachedInputTokens: 700,
          reasoningOutputTokens: 50,
          newThreadCount: 1,
          eventCount: 1,
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('refreshes aggregate usage from active and archived logs', async () => {
    const root = `/tmp/codex-boards-usage-${Date.now()}`;
    const codexHome = join(root, 'codex-home');
    const sessionsRoot = join(codexHome, 'sessions');
    const archivedRoot = join(codexHome, 'archived_sessions');
    mkdirSync(sessionsRoot, { recursive: true });
    mkdirSync(archivedRoot, { recursive: true });

    writeUsageLog(
      join(sessionsRoot, 'active.jsonl'),
      'session-active',
      '2026-06-01T08:00:00.000Z',
      {
        inputTokens: 1000,
        cachedInputTokens: 300,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        totalTokens: 1200,
      },
    );
    writeUsageLog(
      join(archivedRoot, 'archived.jsonl'),
      'session-archived',
      '2026-06-02T08:00:00.000Z',
      {
        inputTokens: 500,
        cachedInputTokens: 100,
        outputTokens: 100,
        reasoningOutputTokens: 25,
        totalTokens: 600,
      },
    );

    const pricingPath = join(root, 'usage-pricing.json');
    writeFileSync(
      pricingPath,
      JSON.stringify({
        _schema: 'codex-boards-usage-pricing-v1',
        _source: {
          name: 'test pricing',
          tier: 'standard',
          fetched_at: '2026-06-01T00:00:00.000Z',
        },
        models: {
          'gpt-test': {
            input_per_million: 2,
            cached_input_per_million: 0.5,
            output_per_million: 8,
          },
        },
      }),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot,
      databasePath: join(root, 'boards.sqlite'),
      codexHome,
      usagePricingPath: pricingPath,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      const refreshResponse = await server.app.request(
        '/api/usage/refresh?range=custom&start=2026-06-01&end=2026-06-03',
        {
          method: 'POST',
        },
      );
      expect(refreshResponse.status).toBe(200);
      const refreshPayload = await refreshResponse.json();
      expect(refreshPayload).toMatchObject({
        ok: true,
        usage: {
          refresh: {
            scannedFiles: 2,
            parsedEvents: 2,
            skippedEvents: 0,
            includedArchived: true,
          },
          summary: {
            totalTokens: 1800,
            cachedInputTokens: 400,
            uncachedInputTokens: 1100,
            reasoningOutputTokens: 75,
            newThreadCount: 2,
            eventCount: 2,
          },
          pricing: {
            loaded: true,
            pricedTokens: 1800,
            unpricedTokens: 0,
          },
        },
      });
      expect(refreshPayload.usage.summary.estimatedCostUsd).toBe(0.0048);
      expect(
        refreshPayload.usage.daily.map(
          (point: {
            date: string;
            totalTokens: number;
            newThreadCount: number;
          }) => ({
            date: point.date,
            newThreadCount: point.newThreadCount,
            totalTokens: point.totalTokens,
          }),
        ),
      ).toEqual([
        { date: '2026-06-01', newThreadCount: 1, totalTokens: 1200 },
        { date: '2026-06-02', newThreadCount: 1, totalTokens: 600 },
        { date: '2026-06-03', newThreadCount: 0, totalTokens: 0 },
      ]);

      const usageResponse = await server.app.request(
        '/api/usage?range=custom&start=2026-06-01&end=2026-06-03',
      );
      expect(usageResponse.status).toBe(200);
      expect(await usageResponse.json()).toMatchObject({
        summary: {
          totalTokens: 1800,
        },
      });
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
