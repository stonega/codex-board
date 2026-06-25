import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import type { ParsedIssue } from '@codex-boards/domain';

import { createAppServer } from '../../apps/backend/src/index';
import { parseSkillMetadata } from '../../apps/backend/src/skills';

function writeSkill(path: string, content: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), content);
}

function createIssue(overrides: Partial<ParsedIssue>): ParsedIssue {
  return {
    id: 'issue-1',
    threadId: 'thread-1',
    projectId: 'codex-boards',
    parentIssueId: null,
    kind: 'parent',
    title: 'Fix GitHub PR review comments on React UI',
    status: 'todo',
    priority: 'high',
    assignee: null,
    dueDate: null,
    tags: ['frontend', 'ci'],
    summary:
      'Thread history mentions failing Playwright e2e checks and GitHub Actions review feedback.',
    updatedAt: '2026-04-09T00:00:00.000Z',
    parseMode: 'fallback',
    confidence: 0.72,
    needsReview: false,
    git: {
      repository: 'codex-boards',
      workspacePath: '/tmp/codex-boards',
      branch: 'feat/react-ui',
      commits: [
        {
          sha: 'abc123',
          message: 'Fix React UI review comments',
          source: 'test',
        },
      ],
      tags: ['ui'],
    },
    evidence: {
      rolloutPath: '/tmp/rollout.jsonl',
      sessionId: 'session-1',
      threadId: 'thread-1',
      warnings: ['Playwright test failed'],
      parsePayloadPreview:
        'User asked to address PR review feedback, browser UI layout, and CI failures.',
    },
    subIssueCount: 0,
    children: [],
    ...overrides,
  };
}

describe('skill metadata', () => {
  test('parses frontmatter and falls back to the directory name', () => {
    expect(
      parseSkillMetadata(
        [
          '---',
          'name: "global-helper"',
          "description: 'Helps with global work.'",
          '---',
          '',
          '# Global Helper',
        ].join('\n'),
        'fallback-name',
      ),
    ).toEqual({
      name: 'global-helper',
      description: 'Helps with global work.',
    });

    expect(parseSkillMetadata('# No frontmatter', 'fallback-name')).toEqual({
      name: 'fallback-name',
      description: '',
    });
  });
});

describe('skill api', () => {
  test('lists global skills, project skills, and scoped details', async () => {
    const root = `/tmp/codex-boards-skills-${Date.now()}`;
    const codexHome = join(root, 'codex-home');
    const agentsHome = join(root, 'agents-home');
    const projectWorkspace = join(root, 'project-workspace');

    writeSkill(
      join(codexHome, 'skills', 'codex-helper'),
      [
        '---',
        'name: codex-helper',
        'description: Helps Codex globally.',
        '---',
        '',
        '# Codex Helper',
      ].join('\n'),
    );
    writeSkill(
      join(agentsHome, 'skills', 'agent-helper'),
      [
        '---',
        'name: agent-helper',
        'description: Helps agent workflows.',
        '---',
        '',
        '# Agent Helper',
      ].join('\n'),
    );
    writeSkill(
      join(
        codexHome,
        'plugins',
        'cache',
        'openai-curated',
        'github',
        'abc123',
        'skills',
        'github-helper',
      ),
      [
        '---',
        'name: github-helper',
        'description: Helps GitHub workflows.',
        '---',
        '',
        '# GitHub Helper',
      ].join('\n'),
    );
    writeSkill(
      join(projectWorkspace, '.codex', 'skills', 'project-helper'),
      [
        '---',
        'name: project-helper',
        'description: Helps this project.',
        '---',
        '',
        '# Project Helper',
      ].join('\n'),
    );

    mkdirSync(
      join(
        codexHome,
        'plugins',
        'cache',
        'openai-curated',
        'github',
        'abc123',
        '.codex-plugin',
      ),
      { recursive: true },
    );
    writeFileSync(
      join(
        codexHome,
        'plugins',
        'cache',
        'openai-curated',
        'github',
        'abc123',
        '.codex-plugin',
        'plugin.json',
      ),
      JSON.stringify({
        name: 'github',
        interface: {
          displayName: 'GitHub',
        },
      }),
    );
    writeFileSync(
      join(codexHome, 'config.toml'),
      ['[plugins."github@openai-curated"]', 'enabled = true'].join('\n'),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      codexHome,
      agentsHome,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      server.database.upsertProject({
        id: 'codex-boards',
        name: 'codex-boards',
        repository: 'codex-boards',
        workspacePath: projectWorkspace,
        issueCount: 0,
        subIssueCount: 0,
        needsReviewCount: 0,
        lastUpdatedAt: '2026-04-09T00:00:00.000Z',
      });

      const globalResponse = await server.app.request('/api/skills');
      expect(globalResponse.status).toBe(200);
      const globalPayload = await globalResponse.json();
      expect(globalPayload).toMatchObject({
        scope: 'global',
        project: null,
      });
      expect(
        globalPayload.skills.map((skill: { name: string }) => skill.name),
      ).toEqual(['agent-helper', 'codex-helper', 'github-helper']);
      expect(
        globalPayload.skills.find(
          (skill: { name: string }) => skill.name === 'github-helper',
        )?.sourceLabel,
      ).toBe('Plugin: GitHub');

      const codexSkill = globalPayload.skills.find(
        (skill: { name: string }) => skill.name === 'codex-helper',
      );
      const globalDetailResponse = await server.app.request(
        `/api/skills/${codexSkill.id}`,
      );
      expect(globalDetailResponse.status).toBe(200);
      expect(await globalDetailResponse.json()).toMatchObject({
        skill: {
          name: 'codex-helper',
          content: expect.stringContaining('# Codex Helper'),
        },
      });

      const projectResponse = await server.app.request(
        '/api/skills?projectId=codex-boards',
      );
      expect(projectResponse.status).toBe(200);
      const projectPayload = await projectResponse.json();
      expect(projectPayload).toMatchObject({
        scope: 'project',
        project: {
          id: 'codex-boards',
        },
      });
      expect(
        projectPayload.skills.map((skill: { name: string }) => skill.name),
      ).toEqual(['project-helper']);

      const projectSkill = projectPayload.skills[0];
      const projectDetailResponse = await server.app.request(
        `/api/skills/${projectSkill.id}?projectId=codex-boards`,
      );
      expect(projectDetailResponse.status).toBe(200);
      expect(await projectDetailResponse.json()).toMatchObject({
        skill: {
          name: 'project-helper',
          content: expect.stringContaining('# Project Helper'),
        },
      });

      const wrongScopeResponse = await server.app.request(
        `/api/skills/${codexSkill.id}?projectId=codex-boards`,
      );
      expect(wrongScopeResponse.status).toBe(404);
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('recommends skills from project issue and thread history', async () => {
    const root = `/tmp/codex-boards-skill-recommendations-${Date.now()}`;
    const codexHome = join(root, 'codex-home');
    const agentsHome = join(root, 'agents-home');
    const projectWorkspace = join(root, 'project-workspace');

    writeSkill(
      join(codexHome, 'skills', 'github-review'),
      [
        '---',
        'name: github-review',
        'description: Use when addressing GitHub pull request review feedback and CI failures.',
        '---',
        '',
        '# GitHub Review',
      ].join('\n'),
    );
    writeSkill(
      join(agentsHome, 'skills', 'react-ui'),
      [
        '---',
        'name: react-ui',
        'description: Use when building React frontend UI and debugging layout problems.',
        '---',
        '',
        '# React UI',
      ].join('\n'),
    );
    writeSkill(
      join(projectWorkspace, '.agents', 'skills', 'playwright-e2e'),
      [
        '---',
        'name: playwright-e2e',
        'description: Use when testing browser UI with Playwright e2e checks.',
        '---',
        '',
        '# Playwright E2E',
      ].join('\n'),
    );

    const server = createAppServer({
      port: 7788,
      sessionsRoot: join(root, 'sessions'),
      databasePath: join(root, 'boards.sqlite'),
      codexHome,
      agentsHome,
      openAiBaseUrl: null,
      openAiApiKey: null,
      openAiModel: null,
    });

    try {
      server.database.upsertProject({
        id: 'codex-boards',
        name: 'codex-boards',
        repository: 'codex-boards',
        workspacePath: projectWorkspace,
        issueCount: 1,
        subIssueCount: 0,
        needsReviewCount: 0,
        lastUpdatedAt: '2026-04-09T00:00:00.000Z',
      });
      server.database.upsertIssue(createIssue({}));

      const missingProjectResponse = await server.app.request(
        '/api/skills/recommendations',
      );
      expect(missingProjectResponse.status).toBe(400);

      const response = await server.app.request(
        '/api/skills/recommendations?projectId=codex-boards',
      );
      expect(response.status).toBe(200);
      const payload = await response.json();

      expect(payload).toMatchObject({
        project: {
          id: 'codex-boards',
        },
        issueCount: 1,
      });

      const recommendationNames = payload.recommendations.map(
        (recommendation: { skill: { name: string } }) =>
          recommendation.skill.name,
      );
      expect(recommendationNames).toContain('github-review');
      expect(recommendationNames).toContain('react-ui');
      expect(recommendationNames).toContain('playwright-e2e');

      const projectRecommendation = payload.recommendations.find(
        (recommendation: { skill: { name: string } }) =>
          recommendation.skill.name === 'playwright-e2e',
      );
      expect(projectRecommendation).toMatchObject({
        skill: {
          source: 'project',
          projectId: 'codex-boards',
        },
        matchedIssueCount: 1,
      });
      expect(projectRecommendation.score).toBeGreaterThan(0);
      expect(projectRecommendation.matchedTerms).toEqual(
        expect.arrayContaining(['playwright', 'e2e']),
      );
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
