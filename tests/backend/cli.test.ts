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
    subIssueCount: 1,
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
    parentIssueId: overrides.parentIssueId ?? null,
    kind: overrides.kind ?? 'parent',
    title: overrides.title,
    status: overrides.status ?? 'todo',
    priority: overrides.priority ?? 'high',
    assignee: overrides.assignee ?? 'stone',
    dueDate: overrides.dueDate ?? '2026-04-20T10:00:00.000Z',
    tags: overrides.tags ?? ['backend', 'sync'],
    summary: overrides.summary ?? 'Build the Multica export command.',
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
    subIssueCount: overrides.subIssueCount ?? 0,
    children: overrides.children ?? [],
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

  test('exports parent and child issues to multica in order', async () => {
    const root = `/tmp/codex-boards-cli-${Date.now()}`;
    mkdirSync(root, { recursive: true });
    const database = new BoardsDatabase(join(root, 'boards.sqlite'));

    try {
      database.upsertProject(createProject('codex-boards'));
      database.upsertIssue(
        createIssue({
          id: 'parent-1',
          title: 'Export issues to Multica',
          subIssueCount: 1,
        }),
      );
      database.upsertIssue(
        createIssue({
          id: 'child-1',
          title: 'Create child issue in Multica',
          kind: 'sub_issue',
          parentIssueId: 'parent-1',
          projectId: 'codex-boards',
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
              stdout: JSON.stringify({ id: 'multica-parent-1' }),
              stderr: '',
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: 'multica-child-1' }),
            stderr: '',
          };
        },
      );

      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain('--title');
      expect(commands[0]).toContain('Export issues to Multica');
      expect(commands[1]).toContain('--parent');
      expect(commands[1]).toContain('multica-parent-1');
      expect(result.exported.map((entry) => entry.multicaIssueId)).toEqual([
        'multica-parent-1',
        'multica-child-1',
      ]);
      expect(result.skippedChildren).toEqual([]);
    } finally {
      database.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('retries without assignee when multica cannot resolve it', async () => {
    const root = `/tmp/codex-boards-cli-retry-${Date.now()}`;
    mkdirSync(root, { recursive: true });
    const database = new BoardsDatabase(join(root, 'boards.sqlite'));

    try {
      database.upsertProject(createProject('codex-boards'));
      database.upsertIssue(
        createIssue({
          id: 'parent-1',
          title: 'Export issues to Multica',
          assignee: 'stone',
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

          if (commands.length === 1) {
            return {
              exitCode: 1,
              stdout: '',
              stderr:
                'Error: resolve assignee: no member or agent found matching "stone"',
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: 'multica-parent-1' }),
            stderr: '',
          };
        },
      );

      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain('--assignee');
      expect(commands[1]).not.toContain('--assignee');
      expect(result.exported[0]?.multicaIssueId).toBe('multica-parent-1');
    } finally {
      database.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
