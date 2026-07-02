import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import type { ProjectSummary } from '@codex-boards/domain';

import { createAppServer } from '../../apps/backend/src/index';
import {
  buildSkillThreadSignal,
  parseSkillMetadata,
} from '../../apps/backend/src/skills';

function writeSkill(path: string, content: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), content);
}

function createProject(workspacePath: string): ProjectSummary {
  return {
    id: 'codex-boards',
    name: 'codex-boards',
    repository: 'codex-boards',
    workspacePath,
    issueCount: 0,
    needsReviewCount: 0,
    lastUpdatedAt: '2026-04-09T00:00:00.000Z',
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
      expect(codexSkill.enabled).toBe(true);
      const globalDetailResponse = await server.app.request(
        `/api/skills/${codexSkill.id}`,
      );
      expect(globalDetailResponse.status).toBe(200);
      expect(await globalDetailResponse.json()).toMatchObject({
        skill: {
          name: 'codex-helper',
          enabled: true,
          content: expect.stringContaining('# Codex Helper'),
        },
      });

      const disableResponse = await server.app.request(
        `/api/skills/${codexSkill.id}/enabled`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(disableResponse.status).toBe(200);
      expect(await disableResponse.json()).toMatchObject({
        ok: true,
        restartRequired: true,
        skill: {
          id: codexSkill.id,
          enabled: false,
        },
      });
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain(
        'enabled = false',
      );

      const disabledGlobalResponse = await server.app.request('/api/skills');
      const disabledGlobalPayload = await disabledGlobalResponse.json();
      expect(
        disabledGlobalPayload.skills.find(
          (skill: { name: string }) => skill.name === 'codex-helper',
        )?.enabled,
      ).toBe(false);

      const enableResponse = await server.app.request(
        `/api/skills/${codexSkill.id}/enabled`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(enableResponse.status).toBe(200);
      expect(await enableResponse.json()).toMatchObject({
        ok: true,
        restartRequired: true,
        skill: {
          id: codexSkill.id,
          enabled: true,
        },
      });
      const enabledConfig = readFileSync(
        join(codexHome, 'config.toml'),
        'utf8',
      );
      expect(enabledConfig).toContain('[plugins."github@openai-curated"]');
      expect(enabledConfig).not.toContain('codex-helper/SKILL.md');

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
      expect(projectSkill.enabled).toBe(true);
      const projectDetailResponse = await server.app.request(
        `/api/skills/${projectSkill.id}?projectId=codex-boards`,
      );
      expect(projectDetailResponse.status).toBe(200);
      expect(await projectDetailResponse.json()).toMatchObject({
        skill: {
          name: 'project-helper',
          enabled: true,
          content: expect.stringContaining('# Project Helper'),
        },
      });

      const disableProjectResponse = await server.app.request(
        `/api/skills/${projectSkill.id}/enabled?projectId=codex-boards`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(disableProjectResponse.status).toBe(200);
      expect(await disableProjectResponse.json()).toMatchObject({
        ok: true,
        restartRequired: true,
        skill: {
          id: projectSkill.id,
          enabled: false,
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

  test('suggests draft skills from repeated workspace thread patterns', async () => {
    const root = `/tmp/codex-boards-skill-suggestions-${Date.now()}`;
    const codexHome = join(root, 'codex-home');
    const agentsHome = join(root, 'agents-home');
    const projectWorkspace = join(root, 'project-workspace');

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
      const project = createProject(projectWorkspace);
      server.database.upsertProject(project);

      const candidates = [
        {
          threadId: 'thread-playwright-1',
          userPrompt:
            'Fix the failing Playwright e2e checks in the React UI after the layout change.',
          assistantResponse:
            'Fixed the React layout regression and reran the Playwright e2e checks.',
          updatedAt: '2026-04-09T02:00:00.000Z',
        },
        {
          threadId: 'thread-playwright-2',
          userPrompt:
            'The browser UI test is failing on mobile. Can you debug the Playwright run?',
          assistantResponse:
            'Updated the responsive UI behavior and verified the Playwright browser test.',
          updatedAt: '2026-04-09T03:00:00.000Z',
        },
        {
          threadId: 'thread-react-1',
          userPrompt: 'Build a React settings panel for parser configuration.',
          assistantResponse:
            'Implemented the React settings panel and connected the backend API.',
          updatedAt: '2026-04-09T04:00:00.000Z',
        },
      ];

      for (const candidate of candidates) {
        const signal = buildSkillThreadSignal(
          {
            sessionId: candidate.threadId,
            threadId: candidate.threadId,
            rolloutPath: join(root, `${candidate.threadId}.jsonl`),
            startedAt: candidate.updatedAt,
            updatedAt: candidate.updatedAt,
            workspacePath: projectWorkspace,
            repository: 'codex-boards',
            branch: 'feat/react-ui',
            messages: [
              {
                role: 'user',
                content: candidate.userPrompt,
              },
              {
                role: 'assistant',
                content: candidate.assistantResponse,
              },
            ],
            commands: [],
            warnings: [],
            git: {
              repository: 'codex-boards',
              workspacePath: projectWorkspace,
              branch: 'feat/react-ui',
              commits: [],
              tags: [],
            },
          },
          project,
        );
        expect(signal).not.toBeNull();
        if (signal) {
          server.database.saveSkillThreadSignal(signal);
        }
      }

      const missingProjectResponse = await server.app.request(
        '/api/skills/suggestions',
      );
      expect(missingProjectResponse.status).toBe(400);

      const removedRecommendationsResponse = await server.app.request(
        '/api/skills/recommendations?projectId=codex-boards',
      );
      expect(removedRecommendationsResponse.status).toBe(404);

      const response = await server.app.request(
        '/api/skills/suggestions?projectId=codex-boards',
      );
      expect(response.status).toBe(200);
      const payload = await response.json();

      expect(payload).toMatchObject({
        project: {
          id: 'codex-boards',
        },
        signalCount: 3,
      });

      const browserSuggestion = payload.suggestions.find(
        (suggestion: { name: string }) =>
          suggestion.name === 'browser-ui-tests',
      );
      expect(browserSuggestion).toMatchObject({
        title: 'Fix browser UI test failures',
        evidenceThreadCount: 2,
        tags: expect.arrayContaining(['playwright', 'test', 'ui']),
      });
      expect(browserSuggestion.examplePrompts).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Playwright e2e checks'),
        ]),
      );
      expect(browserSuggestion.suggestedSkillBody).toContain(
        '# Fix browser UI test failures',
      );
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('installs draft skills into workspace or global skill roots', async () => {
    const root = `/tmp/codex-boards-skill-install-${Date.now()}`;
    const codexHome = join(root, 'codex-home');
    const agentsHome = join(root, 'agents-home');
    const projectWorkspace = join(root, 'project-workspace');
    const project = createProject(projectWorkspace);
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
      server.database.upsertProject(project);

      const workspaceResponse = await server.app.request(
        '/api/skills/install',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            target: 'workspace',
            projectId: project.id,
            name: 'Browser UI Tests',
            description: 'Use when debugging browser UI tests.',
            content: [
              '---',
              'name: browser-ui-tests',
              'description: Use when debugging browser UI tests.',
              '---',
              '',
              '# Browser UI Tests',
            ].join('\n'),
          }),
        },
      );
      expect(workspaceResponse.status).toBe(201);
      expect(await workspaceResponse.json()).toMatchObject({
        ok: true,
        skill: {
          name: 'browser-ui-tests',
          source: 'project',
          projectId: project.id,
        },
      });
      const workspaceSkillPath = join(
        projectWorkspace,
        '.agents',
        'skills',
        'browser-ui-tests',
        'SKILL.md',
      );
      expect(existsSync(workspaceSkillPath)).toBe(true);
      expect(readFileSync(workspaceSkillPath, 'utf8')).toContain(
        '# Browser UI Tests',
      );

      const conflictResponse = await server.app.request('/api/skills/install', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          target: 'workspace',
          projectId: project.id,
          name: 'browser-ui-tests',
          content: '# Replacement',
        }),
      });
      expect(conflictResponse.status).toBe(409);

      const globalResponse = await server.app.request('/api/skills/install', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          target: 'global',
          name: 'Release Publishing',
          content: [
            '---',
            'name: release-publishing',
            'description: Use when publishing releases.',
            '---',
            '',
            '# Release Publishing',
          ].join('\n'),
        }),
      });
      expect(globalResponse.status).toBe(201);
      expect(await globalResponse.json()).toMatchObject({
        ok: true,
        skill: {
          name: 'release-publishing',
          source: 'agent',
          projectId: null,
        },
      });
      expect(
        existsSync(
          join(agentsHome, 'skills', 'release-publishing', 'SKILL.md'),
        ),
      ).toBe(true);
    } finally {
      server.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
