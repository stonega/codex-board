import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  type ExportMulticaPayload,
  type IssueFilters,
  type ParsedIssue,
  type SavedView,
  type SettingsResponse,
  type SyncRunListResponse,
  slugify,
} from '../../../packages/domain/src/index';

import { exportIssuesToMultica, getCliHelpText, parseCliCommand } from './cli';
import {
  type AppConfig,
  applyPersistedParserSettings,
  getConfig,
  readParserSettings,
  readPersistableParserSettings,
  updateParserSettings,
} from './config';
import { BoardsDatabase } from './db';
import { getSkillDetail, listSkillRecommendations, listSkills } from './skills';
import { SyncService } from './sync-service';
import { UsageService } from './usage';

export function createAppServer(config: AppConfig = getConfig()) {
  const database = new BoardsDatabase(config.databasePath);
  applyPersistedParserSettings(config, database.readParserSettings());
  const syncService = new SyncService(database, config);
  const usageService = new UsageService(database, config);
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

  app.get('/api/skills', (context) => {
    return context.json(
      listSkills({
        config,
        database,
        projectId: context.req.query().projectId ?? null,
      }),
    );
  });

  app.get('/api/skills/recommendations', (context) => {
    const projectId = context.req.query().projectId ?? null;
    if (!projectId) {
      return context.json({ message: 'projectId is required' }, 400);
    }

    return context.json(
      listSkillRecommendations({
        config,
        database,
        projectId,
      }),
    );
  });

  app.get('/api/skills/:id', (context) => {
    const response = getSkillDetail({
      config,
      database,
      projectId: context.req.query().projectId ?? null,
      skillId: context.req.param('id'),
    });

    if (!response.skill) {
      return context.json(response, 404);
    }

    return context.json(response);
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

  app.get('/api/usage', (context) => {
    const query = context.req.query();
    return context.json(
      usageService.summary({
        preset: query.range ?? query.preset,
        startDate: query.start ?? query.startDate,
        endDate: query.end ?? query.endDate,
      }),
    );
  });

  app.post('/api/usage/refresh', (context) => {
    const query = context.req.query();
    return context.json(
      usageService.refresh({
        preset: query.range ?? query.preset,
        startDate: query.start ?? query.startDate,
        endDate: query.end ?? query.endDate,
      }),
    );
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

  app.post('/api/export/multica', async (context) => {
    const body = (await context.req.json()) as ExportMulticaPayload;

    if (!body?.projectId) {
      return context.json({ message: 'projectId is required' }, 400);
    }

    if (body.runSync !== false) {
      await syncService.sync();
    }

    const result = await exportIssuesToMultica(database, {
      projectId: body.projectId,
      issueIds: Array.isArray(body.issueIds) ? body.issueIds.map(String) : [],
      includeChildren: body.includeChildren !== false,
      runSync: body.runSync !== false,
      dryRun: body.dryRun === true,
    });

    return context.json({
      ok: true,
      exported: result.exported,
      skippedChildren: result.skippedChildren,
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

export function serveAppServer(server = createAppServer()) {
  return Bun.serve({
    port: server.config.port,
    fetch: async (request) => server.app.fetch(request),
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let server: ReturnType<typeof createAppServer> | null = null;

  try {
    const command = parseCliCommand(args);

    if (command.command === 'help') {
      console.log(getCliHelpText());
    } else if (command.command === 'serve') {
      const config = getConfig();
      if (command.options.port !== null) {
        config.port = command.options.port;
      }

      server = createAppServer(config);
      serveAppServer(server);
      await server.syncService.sync().catch((error) => {
        console.error('Initial sync failed', error);
      });

      console.log(
        `Backend listening on http://localhost:${server.config.port}`,
      );
    } else if (command.command === 'export-multica') {
      server = createAppServer();
      if (command.options?.runSync) {
        await server.syncService.sync();
      }

      const result = await exportIssuesToMultica(
        server.database,
        command.options,
      );

      if (command.options.dryRun) {
        console.log('Multica dry run commands:');
        for (const entry of result.exported) {
          console.log(
            `multica ${entry.command.map((part) => JSON.stringify(part)).join(' ')}`,
          );
        }
      } else {
        console.log(`Exported ${result.exported.length} issues to Multica.`);
      }

      if (result.skippedChildren.length > 0) {
        for (const entry of result.skippedChildren) {
          console.warn(`Skipped child ${entry.sourceIssueId}: ${entry.reason}`);
        }
      }

      if (!command.options.dryRun) {
        console.log(
          JSON.stringify(
            {
              exported: result.exported,
              skippedChildren: result.skippedChildren,
            },
            null,
            2,
          ),
        );
      }

      server.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(getCliHelpText());
    server?.close();
    process.exitCode = 1;
  }
}
