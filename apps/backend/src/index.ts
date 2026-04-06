import { randomUUID } from 'node:crypto';

import {
  type IssueFilters,
  type ParsedIssue,
  type SavedView,
  type SettingsResponse,
  type SyncRunListResponse,
  slugify,
} from '@codex-boards/domain';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  type AppConfig,
  applyPersistedParserSettings,
  getConfig,
  readParserSettings,
  readPersistableParserSettings,
  updateParserSettings,
} from './config';
import { BoardsDatabase } from './db';
import { SyncService } from './sync-service';

export function createAppServer(config: AppConfig = getConfig()) {
  const database = new BoardsDatabase(config.databasePath);
  applyPersistedParserSettings(config, database.readParserSettings());
  const syncService = new SyncService(database, config);
  const app = new Hono();

  app.use('/api/*', cors());

  function readFilters(
    query: Record<string, string | undefined>,
  ): IssueFilters {
    return {
      status: query.status as IssueFilters['status'],
      priority: query.priority as IssueFilters['priority'],
      parseMode: query.parseMode as IssueFilters['parseMode'],
      needsReview:
        query.needsReview === undefined
          ? undefined
          : query.needsReview === 'true',
      hasCommits: query.hasCommits === 'true',
      hasTags: query.hasTags === 'true',
      tag: query.tag ?? null,
      query: query.query ?? null,
    };
  }

  app.get('/api/health', (context) => {
    return context.json({
      ok: true,
      service: 'codex-boards-backend',
      databasePath: config.databasePath,
      sessionsRoot: config.sessionsRoot,
      latestSync: database.getLatestSync(),
      parser: readParserSettings(config),
    });
  });

  app.get('/api/projects', (context) => {
    return context.json(database.listProjects());
  });

  app.get('/api/settings', (context) => {
    const response: SettingsResponse = {
      generatedAt: new Date().toISOString(),
      parser: readParserSettings(config),
      sync: database.getLatestSync(),
      syncHistory: database.listSyncRuns(),
    };

    return context.json(response);
  });

  app.post('/api/settings', async (context) => {
    const body = (await context.req.json()) as {
      parser?: {
        baseUrl?: string | null;
        model?: string | null;
        apiKey?: string | null;
      };
    };

    if (!body?.parser) {
      return context.json({ message: 'parser settings are required' }, 400);
    }

    const response: SettingsResponse = {
      generatedAt: new Date().toISOString(),
      parser: updateParserSettings(config, body.parser),
      sync: database.getLatestSync(),
      syncHistory: database.listSyncRuns(),
    };
    database.saveParserSettings(readPersistableParserSettings(config));

    return context.json(response);
  });

  app.get('/api/issues', (context) => {
    const query = context.req.query();
    const projectId = query.projectId;

    if (!projectId) {
      return context.json(
        {
          message: 'projectId is required',
        },
        400,
      );
    }

    return context.json(database.listIssues(projectId, readFilters(query)));
  });

  app.get('/api/issues/:id', (context) => {
    const response = database.getIssue(context.req.param('id'));
    if (!response.issue) {
      return context.json(response, 404);
    }

    return context.json(response);
  });

  app.post('/api/issues/:id/review', async (context) => {
    const body = await context.req.json();
    database.setIssueNeedsReview(
      context.req.param('id'),
      Boolean(body?.needsReview),
    );
    return context.json(database.getIssue(context.req.param('id')));
  });

  app.post('/api/issues/:id/merge', async (context) => {
    const body = await context.req.json();
    if (!body?.targetIssueId) {
      return context.json({ message: 'targetIssueId is required' }, 400);
    }

    database.mergeIssue(context.req.param('id'), String(body.targetIssueId));
    return context.json(database.getIssue(String(body.targetIssueId)));
  });

  app.post('/api/issues/:id/split', async (context) => {
    const parent = database.getIssue(context.req.param('id')).issue;
    if (!parent) {
      return context.json({ message: 'Issue not found' }, 404);
    }

    const body = await context.req.json();
    const children = Array.isArray(body?.children) ? body.children : [];
    const created: ParsedIssue[] = children.map(
      (child: Record<string, unknown>, index: number) => ({
        ...parent,
        id: `${parent.id}:manual-${index + 1}-${randomUUID().slice(0, 8)}`,
        parentIssueId: parent.id,
        kind: 'sub_issue',
        title: String(child.title ?? `Manual sub issue ${index + 1}`),
        summary: String(child.summary ?? child.title ?? ''),
        status: (child.status as ParsedIssue['status']) ?? 'todo',
        priority: (child.priority as ParsedIssue['priority']) ?? 'medium',
        tags: Array.isArray(child.tags) ? child.tags.map(String) : parent.tags,
        parseMode: 'fallback',
        confidence: 0.51,
        needsReview: false,
        subIssueCount: 0,
        children: [],
      }),
    );

    database.splitIssue(parent.id, created);
    return context.json(database.getIssue(parent.id));
  });

  app.post('/api/sync', async (context) => {
    const sync = await syncService.sync();
    return context.json({
      ok: true,
      sync,
    });
  });

  app.get('/api/sync/runs', (context) => {
    const response: SyncRunListResponse = {
      generatedAt: new Date().toISOString(),
      sync: database.getLatestSync(),
      runs: database.listSyncRuns(),
    };

    return context.json(response);
  });

  app.get('/api/views', (context) => {
    return context.json(database.listSavedViews());
  });

  app.post('/api/views', async (context) => {
    const body = (await context.req.json()) as Partial<SavedView>;
    const now = new Date().toISOString();
    const view: SavedView = {
      id: body.id ?? slugify(body.name ?? `view-${now}`),
      name: body.name?.trim() || 'Saved View',
      filters: body.filters ?? {},
      createdAt: body.createdAt ?? now,
      updatedAt: now,
    };
    database.saveView(view);
    return context.json(database.listSavedViews());
  });

  return {
    app,
    config,
    database,
    syncService,
    close() {
      database.close();
    },
  };
}

const server = createAppServer();

export default {
  port: server.config.port,
  fetch: server.app.fetch,
};

if (import.meta.main) {
  await server.syncService.sync().catch((error) => {
    console.error('Initial sync failed', error);
  });

  console.log(`Backend listening on http://localhost:${server.config.port}`);
}
