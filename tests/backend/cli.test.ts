import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import type { ParsedIssue, ProjectSummary } from '@codex-boards/domain';

import {
  buildMulticaDescription,
  exportIssuesToMultica,
  parseCliCommand,
} from '../../apps/backend/src/cli';
import { BoardsDatabase } from '../../apps/backend/src/db';

function createProject(projectId: string): ProjectSummary {
  return {
    id: projectId,
    name: 'Codex Boards',
    repository: 'codex-boards',
    workspacePath: '/tmp/codex-boards-fixture',
    issueCount: 1,
    needsReviewCount: 0,
    lastUpdatedAt: '2026-04-09T00:00:00.000Z',
  };
}

function createIssue(
  overrides: Partial<ParsedIssue> & Pick<ParsedIssue, 'id' | 'title'>,
): ParsedIssue {
  return {
    id: overrides.id,
    threadId: overrides.threadId ?? 'thread-1',
    projectId: overrides.projectId ?? 'codex-boards',
    title: overrides.title,
    tags: overrides.tags ?? ['backend', 'sync'],
    summary: overrides.summary ?? 'Build the Multica export command.',
    startedAt: overrides.startedAt ?? '2026-04-09T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-09T00:00:00.000Z',
    parseMode: overrides.parseMode ?? 'fallback',
    confidence: overrides.confidence ?? 0.78,
    needsReview: overrides.needsReview ?? false,
    git: overrides.git ?? {
      repository: 'codex-boards',
      workspacePath: '/tmp/codex-boards-fixture',
      branch: 'feat/multica-export',
      commits: [
        {
          sha: 'abc1234',
          message: 'Add multica export command',
          source: 'git log',
        },
      ],
      tags: ['v0.1.0'],
    },
    evidence: overrides.evidence ?? {
      rolloutPath: '/tmp/rollout.jsonl',
      sessionId: 'session-1',
      threadId: overrides.threadId ?? 'thread-1',
      warnings: [],
      parsePayloadPreview: 'preview',
    },
    stats: overrides.stats ?? {
      messageCount: 2,
      commandCount: 1,
      imageCount: 0,
    },
    images: overrides.images ?? [],
  };
}

describe('backend cli', () => {
  test('parses serve port flags', () => {
    expect(parseCliCommand(['serve', '--port', '7799'])).toEqual({
      command: 'serve',
      options: {
        port: 7799,
      },
    });
  });

  test('parses multica export flags', () => {
    expect(
      parseCliCommand([
        'issues',
        'export',
        'multica',
        '--project',
        'codex-boards',
        '--issue',
        'issue-1',
        '--issue',
        'issue-2',
        '--dry-run',
        '--skip-sync',
        '--no-children',
      ]),
    ).toEqual({
      command: 'export-multica',
      options: {
        projectId: 'codex-boards',
        issueIds: ['issue-1', 'issue-2'],
        includeChildren: false,
        runSync: false,
        dryRun: true,
      },
    });
  });

  test('builds multica descriptions with source metadata', () => {
    const description = buildMulticaDescription(
      createIssue({
        id: 'issue-1',
        title: 'Export issues to Multica',
      }),
    );

    expect(description).toContain('Source issue: issue-1');
    expect(description).toContain('Repository: codex-boards');
    expect(description).toContain('Commits:');
    expect(description).toContain('- abc1234 - Add multica export command');
  });

  test('exports thread issues to multica in order', async () => {
    const root = `/tmp/codex-boards-cli-${Date.now()}`;
    mkdirSync(root, { recursive: true });
    const database = new BoardsDatabase(join(root, 'boards.sqlite'));

    try {
      database.upsertProject(createProject('codex-boards'));
      database.upsertIssue(
        createIssue({
          id: 'issue-1',
          title: 'Export issues to Multica',
          updatedAt: '2026-04-10T00:00:00.000Z',
        }),
      );
      database.upsertIssue(
        createIssue({
          id: 'issue-2',
          threadId: 'thread-2',
          title: 'Export another issue in Multica',
          projectId: 'codex-boards',
          updatedAt: '2026-04-09T00:00:00.000Z',
        }),
      );

      const commands: string[][] = [];
      const result = await exportIssuesToMultica(
        database,
        {
          projectId: 'codex-boards',
          issueIds: [],
          includeChildren: true,
          runSync: false,
          dryRun: false,
        },
        async (args) => {
          commands.push(args);
          if (commands.length === 1) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ id: 'multica-issue-1' }),
              stderr: '',
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: 'multica-issue-2' }),
            stderr: '',
          };
        },
      );

      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain('--title');
      expect(commands[0]).toContain('Export issues to Multica');
      expect(commands[1]).not.toContain('--parent');
      expect(result.exported.map((entry) => entry.multicaIssueId)).toEqual([
        'multica-issue-1',
        'multica-issue-2',
      ]);
      expect(result.skippedChildren).toEqual([]);
    } finally {
      database.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('does not emit task-tracker fields for multica export', async () => {
    const root = `/tmp/codex-boards-cli-flat-${Date.now()}`;
    mkdirSync(root, { recursive: true });
    const database = new BoardsDatabase(join(root, 'boards.sqlite'));

    try {
      database.upsertProject(createProject('codex-boards'));
      database.upsertIssue(
        createIssue({
          id: 'parent-1',
          title: 'Export issues to Multica',
        }),
      );

      const commands: string[][] = [];
      const result = await exportIssuesToMultica(
        database,
        {
          projectId: 'codex-boards',
          issueIds: [],
          includeChildren: false,
          runSync: false,
          dryRun: false,
        },
        async (args) => {
          commands.push(args);

          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: 'multica-parent-1' }),
            stderr: '',
          };
        },
      );

      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toContain('--status');
      expect(commands[0]).not.toContain('--priority');
      expect(commands[0]).not.toContain('--assignee');
      expect(commands[0]).not.toContain('--due-date');
      expect(result.exported[0]?.multicaIssueId).toBe('multica-parent-1');
    } finally {
      database.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
