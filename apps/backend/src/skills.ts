import { createHash } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type {
  ParsedIssue,
  ProjectSummary,
  SkillDetailResponse,
  SkillListResponse,
  SkillRecommendation,
  SkillRecommendationListResponse,
  SkillSource,
  SkillSummary,
} from '../../../packages/domain/src/index';

import type { AppConfig } from './config';
import type { BoardsDatabase } from './db';

interface SkillRoot {
  path: string;
  source: SkillSource;
  sourceLabel: string;
  sourceName: string | null;
  projectId?: string | null;
}

interface SkillMetadata {
  name: string;
  description: string;
}

interface PluginMetadata {
  name: string;
  displayName: string;
}

interface SkillRequestContext {
  config: AppConfig;
  database: BoardsDatabase;
  projectId?: string | null;
}

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build']);
const RECOMMENDATION_LIMIT = 5;
const IMPORTANT_SHORT_TOKENS = new Set([
  'ai',
  'api',
  'ci',
  'db',
  'e2e',
  'pr',
  'qa',
  'ui',
  'ux',
]);
const STOP_WORDS = new Set([
  'about',
  'after',
  'agent',
  'agents',
  'also',
  'and',
  'app',
  'apps',
  'application',
  'available',
  'any',
  'are',
  'around',
  'based',
  'been',
  'before',
  'being',
  'build',
  'can',
  'change',
  'changes',
  'codex',
  'could',
  'clean',
  'content',
  'data',
  'directly',
  'does',
  'each',
  'focused',
  'for',
  'from',
  'has',
  'have',
  'help',
  'helps',
  'history',
  'into',
  'issue',
  'issues',
  'its',
  'local',
  'make',
  'need',
  'needs',
  'new',
  'not',
  'only',
  'open',
  'opened',
  'opening',
  'pass',
  'project',
  'projects',
  'run',
  'running',
  'should',
  'skill',
  'skills',
  'task',
  'that',
  'the',
  'their',
  'this',
  'thread',
  'threads',
  'use',
  'used',
  'user',
  'users',
  'using',
  'via',
  'want',
  'web',
  'when',
  'with',
  'work',
  'workflow',
  'workflows',
  'would',
  'you',
  'your',
]);
const TOKEN_ALIASES: Record<string, string[]> = {
  action: ['github', 'ci'],
  actions: ['github', 'ci'],
  auth: ['authentication', 'login'],
  base: ['onchain', 'wallet'],
  billing: ['stripe', 'payment'],
  browser: ['playwright', 'web'],
  ci: ['github', 'actions', 'test'],
  database: ['db'],
  debug: ['bug', 'fix'],
  debugging: ['bug', 'fix'],
  db: ['database'],
  design: ['figma', 'ui', 'ux'],
  doc: ['docs', 'documentation'],
  docs: ['documentation'],
  e2e: ['playwright', 'test'],
  frontend: ['react', 'ui'],
  gh: ['github'],
  git: ['github', 'repository'],
  issue: ['bug'],
  mobile: ['responsive'],
  pay: ['payment'],
  pr: ['pull', 'request', 'review'],
  prs: ['pull', 'request', 'review'],
  qa: ['test', 'review'],
  review: ['pr', 'qa'],
  sql: ['database', 'db'],
  ui: ['frontend', 'interface'],
  ux: ['frontend', 'interface'],
  wallet: ['onchain', 'crypto'],
};

function resolveCodexHome(config: AppConfig): string {
  return config.codexHome ?? join(homedir(), '.codex');
}

function resolveAgentsHome(config: AppConfig): string {
  return config.agentsHome ?? join(homedir(), '.agents');
}

function cleanFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function parseSkillMetadata(
  content: string,
  fallbackName: string,
): SkillMetadata {
  const metadata: SkillMetadata = {
    name: fallbackName,
    description: '',
  };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    return metadata;
  }

  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(name|description):\s*(.+)$/);
    if (!field) {
      continue;
    }

    const [, key, value] = field;
    if (key === 'name') {
      metadata.name = cleanFrontmatterValue(value) || fallbackName;
    }
    if (key === 'description') {
      metadata.description = cleanFrontmatterValue(value);
    }
  }

  return metadata;
}

function createSkillId(path: string): string {
  return createHash('sha256').update(path).digest('base64url').slice(0, 32);
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function listDirectories(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function findSkillFiles(rootPath: string): string[] {
  if (!existsSync(rootPath)) {
    return [];
  }

  const files: string[] = [];
  const pending = [rootPath];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          pending.push(entryPath);
        }
        continue;
      }

      if (entry.isFile() && entry.name === 'SKILL.md') {
        files.push(entryPath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function readEnabledPluginIds(configPath: string): string[] {
  if (!existsSync(configPath)) {
    return [];
  }

  const enabledPlugins: string[] = [];
  let currentPlugin: string | null = null;
  let currentEnabled = false;

  function flushPlugin() {
    if (currentPlugin && currentEnabled) {
      enabledPlugins.push(currentPlugin);
    }
    currentPlugin = null;
    currentEnabled = false;
  }

  for (const rawLine of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const pluginHeader =
      line.match(/^\[plugins\."([^"]+)"\]$/) ??
      line.match(/^\[plugins\.([^\]]+)\]$/);

    if (pluginHeader) {
      flushPlugin();
      currentPlugin = pluginHeader[1];
      continue;
    }

    if (line.startsWith('[')) {
      flushPlugin();
      continue;
    }

    if (currentPlugin && /^enabled\s*=\s*true\b/.test(line)) {
      currentEnabled = true;
    }
  }

  flushPlugin();

  return enabledPlugins;
}

function readPluginMetadata(pluginRoot: string): PluginMetadata {
  const manifest = readJsonFile<{
    name?: string;
    interface?: { displayName?: string };
  }>(join(pluginRoot, '.codex-plugin', 'plugin.json'));
  const name = manifest?.name ?? basename(dirname(pluginRoot));

  return {
    name,
    displayName: manifest?.interface?.displayName ?? name,
  };
}

function getPluginSkillRoots(codexHome: string): SkillRoot[] {
  const configPath = join(codexHome, 'config.toml');
  const cachePath = join(codexHome, 'plugins', 'cache');
  const roots: SkillRoot[] = [];

  for (const pluginId of readEnabledPluginIds(configPath)) {
    const separator = pluginId.indexOf('@');
    if (separator === -1) {
      continue;
    }

    const pluginName = pluginId.slice(0, separator);
    const provider = pluginId.slice(separator + 1);
    const pluginCachePath = join(cachePath, provider, pluginName);

    for (const versionPath of listDirectories(pluginCachePath)) {
      const metadata = readPluginMetadata(versionPath);
      const skillsPath = join(versionPath, 'skills');

      roots.push({
        path: skillsPath,
        source: 'plugin',
        sourceLabel: `Plugin: ${metadata.displayName}`,
        sourceName: metadata.name,
      });
    }
  }

  return roots;
}

function getGlobalSkillRoots(config: AppConfig): SkillRoot[] {
  const codexHome = resolveCodexHome(config);
  const agentsHome = resolveAgentsHome(config);

  return [
    {
      path: join(codexHome, 'skills'),
      source: 'codex',
      sourceLabel: 'Codex',
      sourceName: 'codex',
    },
    {
      path: join(agentsHome, 'skills'),
      source: 'agent',
      sourceLabel: 'Agent',
      sourceName: 'agent',
    },
    ...getPluginSkillRoots(codexHome),
  ];
}

function getProjectSkillRoots(project: ProjectSummary): SkillRoot[] {
  return [
    {
      path: join(project.workspacePath, '.codex', 'skills'),
      source: 'project',
      sourceLabel: 'Project',
      sourceName: project.id,
      projectId: project.id,
    },
    {
      path: join(project.workspacePath, '.agents', 'skills'),
      source: 'project',
      sourceLabel: 'Project',
      sourceName: project.id,
      projectId: project.id,
    },
  ];
}

function canonicalizeRoot(root: SkillRoot): SkillRoot | null {
  if (!existsSync(root.path)) {
    return null;
  }

  try {
    const stats = statSync(root.path);
    if (!stats.isDirectory()) {
      return null;
    }

    return {
      ...root,
      path: realpathSync(root.path),
    };
  } catch {
    return null;
  }
}

function readSkillsFromRoot(root: SkillRoot): SkillSummary[] {
  const canonicalRoot = canonicalizeRoot(root);
  if (!canonicalRoot) {
    return [];
  }

  return findSkillFiles(canonicalRoot.path).flatMap((filePath) => {
    let canonicalPath: string;
    let content: string;
    try {
      canonicalPath = realpathSync(filePath);
      content = readFileSync(canonicalPath, 'utf8');
    } catch {
      return [];
    }

    const relativePath = relative(canonicalRoot.path, canonicalPath);
    const metadata = parseSkillMetadata(
      content,
      basename(dirname(canonicalPath)),
    );

    return [
      {
        id: createSkillId(canonicalPath),
        name: metadata.name,
        description: metadata.description,
        source: canonicalRoot.source,
        sourceLabel: canonicalRoot.sourceLabel,
        sourceName: canonicalRoot.sourceName,
        path: canonicalPath,
        relativePath,
        projectId: canonicalRoot.projectId ?? null,
      },
    ];
  });
}

function dedupeAndSortSkills(skills: SkillSummary[]): SkillSummary[] {
  const byIdentity = new Map<string, SkillSummary>();

  for (const skill of skills) {
    const identity = [
      skill.source,
      skill.sourceName ?? '',
      skill.projectId ?? '',
      skill.name,
    ].join(':');

    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, skill);
    }
  }

  return Array.from(byIdentity.values()).sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    if (nameOrder !== 0) {
      return nameOrder;
    }

    return left.sourceLabel.localeCompare(right.sourceLabel);
  });
}

function findProject(
  database: BoardsDatabase,
  projectId: string | null | undefined,
): ProjectSummary | null {
  if (!projectId) {
    return null;
  }

  return (
    database
      .listProjects()
      .projects.find((project) => project.id === projectId) ?? null
  );
}

function listSkillsForRoots(roots: SkillRoot[]): SkillSummary[] {
  return dedupeAndSortSkills(roots.flatMap((root) => readSkillsFromRoot(root)));
}

function getScopedSkills(context: SkillRequestContext): {
  project: ProjectSummary | null;
  scope: 'global' | 'project';
  skills: SkillSummary[];
} {
  const project = findProject(context.database, context.projectId);

  if (context.projectId) {
    return {
      project,
      scope: 'project',
      skills: project ? listSkillsForRoots(getProjectSkillRoots(project)) : [],
    };
  }

  return {
    project: null,
    scope: 'global',
    skills: listSkillsForRoots(getGlobalSkillRoots(context.config)),
  };
}

function normalizeRecommendationToken(token: string): string | null {
  const normalized = token
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (!normalized) {
    return null;
  }

  if (normalized.length < 3 && !IMPORTANT_SHORT_TOKENS.has(normalized)) {
    return null;
  }

  if (STOP_WORDS.has(normalized)) {
    return null;
  }

  return normalized;
}

function tokenizeForRecommendations(value: string): string[] {
  const tokens = new Set<string>();

  for (const rawToken of value.split(/[^a-zA-Z0-9]+/)) {
    const token = normalizeRecommendationToken(rawToken);
    if (!token) {
      continue;
    }

    tokens.add(token);
    for (const alias of TOKEN_ALIASES[token] ?? []) {
      const normalizedAlias = normalizeRecommendationToken(alias);
      if (normalizedAlias) {
        tokens.add(normalizedAlias);
      }
    }
  }

  return Array.from(tokens);
}

function getIssueRecommendationText(issue: ParsedIssue): string {
  return [
    issue.title,
    issue.summary,
    issue.status,
    issue.priority,
    ...issue.tags,
    ...issue.evidence.warnings,
    issue.evidence.parsePayloadPreview,
    issue.git.branch ?? '',
    ...issue.git.tags,
    ...issue.git.commits.map((commit) => commit.message ?? ''),
  ].join(' ');
}

function getSkillRecommendationText(skill: SkillSummary): string {
  return [
    skill.name,
    skill.description,
    skill.relativePath,
    skill.sourceLabel,
    skill.sourceName ?? '',
  ].join(' ');
}

function createIssueSignals(issues: ParsedIssue[]): Array<{
  issue: ParsedIssue;
  terms: Set<string>;
}> {
  return issues.map((issue) => ({
    issue,
    terms: new Set(
      tokenizeForRecommendations(getIssueRecommendationText(issue)),
    ),
  }));
}

function scoreSkillRecommendation(
  skill: SkillSummary,
  issueSignals: Array<{ issue: ParsedIssue; terms: Set<string> }>,
  projectIssueCount: number,
): SkillRecommendation | null {
  const skillTerms = new Set(
    tokenizeForRecommendations(getSkillRecommendationText(skill)),
  );
  if (skillTerms.size === 0) {
    return null;
  }

  const matchedTermWeights = new Map<string, number>();
  const matchedIssues: Array<{
    issue: ParsedIssue;
    matchedTerms: string[];
  }> = [];

  for (const signal of issueSignals) {
    const matchedTerms = Array.from(skillTerms).filter((term) =>
      signal.terms.has(term),
    );
    if (matchedTerms.length === 0) {
      continue;
    }

    matchedIssues.push({
      issue: signal.issue,
      matchedTerms,
    });

    const issueWeight =
      signal.issue.needsReview || signal.issue.priority === 'urgent'
        ? 2
        : signal.issue.priority === 'high'
          ? 1.5
          : 1;

    for (const term of matchedTerms) {
      matchedTermWeights.set(
        term,
        (matchedTermWeights.get(term) ?? 0) + issueWeight,
      );
    }
  }

  if (matchedIssues.length === 0) {
    return null;
  }

  const matchedTerms = Array.from(matchedTermWeights.entries())
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([term]) => term)
    .slice(0, 6);
  const topIssue = matchedIssues
    .slice()
    .sort(
      (left, right) =>
        right.matchedTerms.length - left.matchedTerms.length ||
        right.issue.updatedAt.localeCompare(left.issue.updatedAt),
    )[0];
  const weightedTermTotal = Array.from(matchedTermWeights.values()).reduce(
    (total, weight) => total + weight,
    0,
  );
  const coverage = matchedIssues.length / Math.max(projectIssueCount, 1);
  const termBreadth = matchedTerms.length / 6;
  const matchDepth =
    weightedTermTotal / Math.max(matchedIssues.length * skillTerms.size, 1);
  const normalizedScore = Math.min(
    96,
    Math.round(
      coverage * 45 +
        termBreadth * 30 +
        Math.min(matchDepth, 1) * 18 +
        (skill.source === 'project' ? 3 : 0),
    ),
  );

  return {
    skill,
    score: Math.max(normalizedScore, 1),
    matchedIssueCount: matchedIssues.length,
    matchedTerms,
    reasons: [
      `Matched ${matchedIssues.length} project issue${
        matchedIssues.length === 1 ? '' : 's'
      } on ${matchedTerms.slice(0, 4).join(', ')}.`,
      `Strongest signal: ${topIssue?.issue.title ?? skill.name}.`,
    ],
  };
}

function getRecommendationSkills(
  config: AppConfig,
  project: ProjectSummary,
): SkillSummary[] {
  return dedupeAndSortSkills([
    ...listSkillsForRoots(getGlobalSkillRoots(config)),
    ...listSkillsForRoots(getProjectSkillRoots(project)),
  ]);
}

export function listSkills(context: SkillRequestContext): SkillListResponse {
  const scoped = getScopedSkills(context);

  return {
    generatedAt: new Date().toISOString(),
    scope: scoped.scope,
    project: scoped.project,
    skills: scoped.skills,
  };
}

export function listSkillRecommendations(
  context: SkillRequestContext,
): SkillRecommendationListResponse {
  const project = findProject(context.database, context.projectId);
  const issues = project ? context.database.listProjectIssues(project.id) : [];
  const issueSignals = createIssueSignals(issues);
  const skills = project
    ? getRecommendationSkills(context.config, project)
    : [];
  const recommendations = skills
    .flatMap((skill) => {
      const recommendation = scoreSkillRecommendation(
        skill,
        issueSignals,
        issues.length,
      );
      return recommendation ? [recommendation] : [];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.matchedIssueCount - left.matchedIssueCount ||
        left.skill.name.localeCompare(right.skill.name),
    )
    .slice(0, RECOMMENDATION_LIMIT);

  return {
    generatedAt: new Date().toISOString(),
    project,
    issueCount: issues.length,
    recommendations,
  };
}

export function getSkillDetail(
  context: SkillRequestContext & { skillId: string },
): SkillDetailResponse {
  const scoped = getScopedSkills(context);
  const summary =
    scoped.skills.find((skill) => skill.id === context.skillId) ?? null;

  if (!summary) {
    return {
      generatedAt: new Date().toISOString(),
      skill: null,
    };
  }

  const content = readFileSync(resolve(summary.path), 'utf8');

  return {
    generatedAt: new Date().toISOString(),
    skill: {
      ...summary,
      content,
    },
  };
}
