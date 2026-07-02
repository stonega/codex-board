import { createHash } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  type InstallSkillPayload,
  type InstallSkillResponse,
  type ParsedIssue,
  type ProjectSummary,
  type SkillDetailResponse,
  type SkillListResponse,
  type SkillSource,
  type SkillSuggestion,
  type SkillSuggestionListResponse,
  type SkillSummary,
  type UpdateSkillEnabledPayload,
  type UpdateSkillEnabledResponse,
  slugify,
} from '../../../packages/domain/src/index';

import type { AppConfig } from './config';
import type { BoardsDatabase, SkillThreadSignalRecord } from './db';
import type { ThreadCandidate } from './rollout-parser';

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

interface SkillConfigBlock {
  startLine: number;
  endLine: number;
  path: string | null;
  enabled: boolean | null;
}

interface SkillConfigFile {
  content: string;
  lines: string[];
  blocks: SkillConfigBlock[];
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
const SUGGESTION_LIMIT = 6;
const MIN_SUGGESTION_EVIDENCE = 2;
const MAX_EVIDENCE_ITEMS = 3;
const ACTION_TAGS = new Set([
  'build',
  'commit',
  'configure',
  'debug',
  'document',
  'fix',
  'improve',
  'investigate',
  'release',
  'refactor',
  'review',
  'test',
]);

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

function getCodexConfigPath(config: AppConfig): string {
  return join(resolveCodexHome(config), 'config.toml');
}

function expandHomePath(path: string): string {
  return path === '~' || path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path;
}

function canonicalizeSkillConfigPath(path: string): string {
  const expanded = expandHomePath(path);

  try {
    return realpathSync(expanded);
  } catch {
    return resolve(expanded);
  }
}

function parseTomlString(value: string): string | null {
  const trimmed = value.trim();
  const basicString = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
  if (basicString) {
    try {
      return JSON.parse(`"${basicString[1]}"`) as string;
    } catch {
      return basicString[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }

  const literalString = trimmed.match(/^'([^']*)'/);
  if (literalString) {
    return literalString[1];
  }

  return trimmed.match(/^([^\s#]+)/)?.[1] ?? null;
}

function parseTomlBoolean(value: string): boolean | null {
  const booleanMatch = value.trim().match(/^(true|false)\b/);
  if (!booleanMatch) {
    return null;
  }

  return booleanMatch[1] === 'true';
}

function splitTomlLines(content: string): string[] {
  if (!content) {
    return [];
  }

  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function parseSkillConfigFileContent(content: string): SkillConfigFile {
  const lines = splitTomlLines(content);
  const blocks: SkillConfigBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '[[skills.config]]') {
      continue;
    }

    const startLine = index;
    let endLine = index + 1;
    while (endLine < lines.length && !lines[endLine].trim().startsWith('[')) {
      endLine += 1;
    }

    let path: string | null = null;
    let enabled: boolean | null = null;
    for (const rawLine of lines.slice(startLine + 1, endLine)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const pathMatch = line.match(/^path\s*=\s*(.+)$/);
      if (pathMatch) {
        path = parseTomlString(pathMatch[1]);
        continue;
      }

      const enabledMatch = line.match(/^enabled\s*=\s*(.+)$/);
      if (enabledMatch) {
        enabled = parseTomlBoolean(enabledMatch[1]);
      }
    }

    blocks.push({
      startLine,
      endLine,
      path,
      enabled,
    });
    index = endLine - 1;
  }

  return {
    content,
    lines,
    blocks,
  };
}

function readSkillConfigFile(configPath: string): SkillConfigFile {
  if (!existsSync(configPath)) {
    return parseSkillConfigFileContent('');
  }

  try {
    return parseSkillConfigFileContent(readFileSync(configPath, 'utf8'));
  } catch {
    return parseSkillConfigFileContent('');
  }
}

function readSkillEnabledByPath(config: AppConfig): Map<string, boolean> {
  const configFile = readSkillConfigFile(getCodexConfigPath(config));
  const enabledByPath = new Map<string, boolean>();

  for (const block of configFile.blocks) {
    if (!block.path) {
      continue;
    }

    enabledByPath.set(
      canonicalizeSkillConfigPath(block.path),
      block.enabled ?? true,
    );
  }

  return enabledByPath;
}

function formatTomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')}"`;
}

function formatSkillConfigBlock(path: string, enabled: boolean): string[] {
  return [
    '[[skills.config]]',
    `path = ${formatTomlString(path)}`,
    `enabled = ${enabled ? 'true' : 'false'}`,
  ];
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const nextLines = [...lines];

  while (nextLines.at(-1) === '') {
    nextLines.pop();
  }

  return nextLines;
}

function removeSkillConfigBlocks(
  configFile: SkillConfigFile,
  canonicalPath: string,
): string[] {
  const ranges = configFile.blocks
    .filter(
      (block) =>
        block.path && canonicalizeSkillConfigPath(block.path) === canonicalPath,
    )
    .map((block) => [block.startLine, block.endLine] as const);

  if (ranges.length === 0) {
    return configFile.lines;
  }

  return configFile.lines.filter(
    (_line, index) =>
      !ranges.some(([startLine, endLine]) => {
        return index >= startLine && index < endLine;
      }),
  );
}

function updateSkillEnabledConfig(
  config: AppConfig,
  skillPath: string,
  enabled: boolean,
): { changed: boolean; configPath: string } {
  const configPath = getCodexConfigPath(config);
  const configFile = readSkillConfigFile(configPath);
  const canonicalPath = canonicalizeSkillConfigPath(skillPath);
  const nextLines = trimTrailingEmptyLines(
    removeSkillConfigBlocks(configFile, canonicalPath),
  );

  if (!enabled) {
    if (nextLines.length > 0) {
      nextLines.push('');
    }
    nextLines.push(...formatSkillConfigBlock(skillPath, false));
  }

  const nextContent = nextLines.length > 0 ? `${nextLines.join('\n')}\n` : '';

  if (nextContent === configFile.content) {
    return {
      changed: false,
      configPath,
    };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, nextContent);

  return {
    changed: true,
    configPath,
  };
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

function readSkillsFromRoot(
  root: SkillRoot,
  enabledByPath: Map<string, boolean>,
): SkillSummary[] {
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
        enabled: enabledByPath.get(canonicalPath) ?? true,
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

function listSkillsForRoots(
  roots: SkillRoot[],
  enabledByPath: Map<string, boolean>,
): SkillSummary[] {
  return dedupeAndSortSkills(
    roots.flatMap((root) => readSkillsFromRoot(root, enabledByPath)),
  );
}

function getScopedSkills(context: SkillRequestContext): {
  project: ProjectSummary | null;
  scope: 'global' | 'project';
  skills: SkillSummary[];
} {
  const project = findProject(context.database, context.projectId);
  const enabledByPath = readSkillEnabledByPath(context.config);

  if (context.projectId) {
    return {
      project,
      scope: 'project',
      skills: project
        ? listSkillsForRoots(getProjectSkillRoots(project), enabledByPath)
        : [],
    };
  }

  return {
    project: null,
    scope: 'global',
    skills: listSkillsForRoots(
      getGlobalSkillRoots(context.config),
      enabledByPath,
    ),
  };
}

interface TaskTagDefinition {
  tag: string;
  label: string;
  kind: 'action' | 'domain' | 'tool';
  patterns: RegExp[];
}

interface SkillSuggestionProfile {
  id: string;
  title: string;
  name: string;
  description: string;
  trigger: string;
  requiredTags: string[];
  anyTags?: string[];
}

interface SuggestionCluster {
  key: string;
  signals: SkillThreadSignalRecord[];
}

const TASK_TAGS: TaskTagDefinition[] = [
  {
    tag: 'fix',
    label: 'fix',
    kind: 'action',
    patterns: [
      /\bfix(?:ed|ing)?\b/i,
      /\bbug\b/i,
      /\berror\b/i,
      /\bfail(?:ed|ing|ure)?\b/i,
      /\bbroken\b/i,
      /\bregression\b/i,
    ],
  },
  {
    tag: 'improve',
    label: 'improve',
    kind: 'action',
    patterns: [
      /\bimprove(?:d|ment|ments|ing)?\b/i,
      /\bpolish(?:ed|ing)?\b/i,
      /\bclean(?:ed|ing)? up\b/i,
      /\bmake .*better\b/i,
    ],
  },
  {
    tag: 'build',
    label: 'build',
    kind: 'action',
    patterns: [
      /\badd(?:ed|ing)?\b/i,
      /\bbuild(?:ing|t)?\b/i,
      /\bcreate(?:d|ing)?\b/i,
      /\bimplement(?:ed|ing)?\b/i,
      /\bset up\b/i,
    ],
  },
  {
    tag: 'review',
    label: 'review',
    kind: 'action',
    patterns: [
      /\breview\b/i,
      /\breview comments?\b/i,
      /\brequested changes?\b/i,
      /\bpr feedback\b/i,
    ],
  },
  {
    tag: 'test',
    label: 'test',
    kind: 'action',
    patterns: [
      /\btest(?:ed|ing|s)?\b/i,
      /\be2e\b/i,
      /\bplaywright\b/i,
      /\bvitest\b/i,
      /\bcoverage\b/i,
    ],
  },
  {
    tag: 'release',
    label: 'release',
    kind: 'action',
    patterns: [
      /\brelease\b/i,
      /\bpublish(?:ed|ing)?\b/i,
      /\bversion\b/i,
      /\btag\b/i,
      /\bchangelog\b/i,
    ],
  },
  {
    tag: 'document',
    label: 'document',
    kind: 'action',
    patterns: [
      /\bdoc(?:s|umentation)?\b/i,
      /\breadme\b/i,
      /\bguide\b/i,
      /\bwrite up\b/i,
    ],
  },
  {
    tag: 'configure',
    label: 'configure',
    kind: 'action',
    patterns: [
      /\bconfig(?:ure|ured|uring|uration)?\b/i,
      /\bsetting(?:s)?\b/i,
      /\bsetup\b/i,
      /\bwire(?:d|ing)?\b/i,
    ],
  },
  {
    tag: 'refactor',
    label: 'refactor',
    kind: 'action',
    patterns: [
      /\brefactor(?:ed|ing)?\b/i,
      /\brework(?:ed|ing)?\b/i,
      /\brestructure(?:d|ing)?\b/i,
    ],
  },
  {
    tag: 'debug',
    label: 'debug',
    kind: 'action',
    patterns: [
      /\bdebug(?:ged|ging)?\b/i,
      /\binvestigat(?:e|ed|ing)\b/i,
      /\btrace(?:d|ing)?\b/i,
      /\bfind .*cause\b/i,
    ],
  },
  {
    tag: 'commit',
    label: 'commit',
    kind: 'action',
    patterns: [/\bcommit\b/i, /\bpush\b/i],
  },
  {
    tag: 'react',
    label: 'React',
    kind: 'tool',
    patterns: [/\breact\b/i, /\btsx\b/i, /\bjsx\b/i],
  },
  {
    tag: 'frontend',
    label: 'frontend',
    kind: 'domain',
    patterns: [
      /\bfrontend\b/i,
      /\bweb ui\b/i,
      /\bcomponent(?:s)?\b/i,
      /\blayout\b/i,
    ],
  },
  {
    tag: 'ui',
    label: 'UI',
    kind: 'domain',
    patterns: [
      /\bui\b/i,
      /\bux\b/i,
      /\bvisual\b/i,
      /\bstyle(?:d|s|ing)?\b/i,
      /\bresponsive\b/i,
      /\bmobile\b/i,
    ],
  },
  {
    tag: 'playwright',
    label: 'Playwright',
    kind: 'tool',
    patterns: [/\bplaywright\b/i, /\bbrowser test(?:s)?\b/i, /\be2e\b/i],
  },
  {
    tag: 'github',
    label: 'GitHub',
    kind: 'tool',
    patterns: [/\bgithub\b/i, /\bgh\b/i, /\bpull request\b/i, /\bpr\b/i],
  },
  {
    tag: 'ci',
    label: 'CI',
    kind: 'domain',
    patterns: [
      /\bci\b/i,
      /\bgithub actions?\b/i,
      /\bchecks?\b/i,
      /\bworkflow\b/i,
    ],
  },
  {
    tag: 'backend',
    label: 'backend',
    kind: 'domain',
    patterns: [/\bbackend\b/i, /\bserver\b/i, /\bhono\b/i, /\bendpoint\b/i],
  },
  {
    tag: 'api',
    label: 'API',
    kind: 'domain',
    patterns: [/\bapi\b/i, /\bendpoint(?:s)?\b/i, /\broute(?:s)?\b/i],
  },
  {
    tag: 'database',
    label: 'database',
    kind: 'domain',
    patterns: [
      /\bdatabase\b/i,
      /\bsqlite\b/i,
      /\bdb\b/i,
      /\bmigration\b/i,
      /\bschema\b/i,
    ],
  },
  {
    tag: 'sync',
    label: 'sync',
    kind: 'domain',
    patterns: [
      /\bsync\b/i,
      /\bingest(?:ion)?\b/i,
      /\brollout\b/i,
      /\bthread(?:s)?\b/i,
    ],
  },
  {
    tag: 'parser',
    label: 'parser',
    kind: 'domain',
    patterns: [
      /\bparser\b/i,
      /\bparse\b/i,
      /\bclassification\b/i,
      /\bheuristic(?:s)?\b/i,
    ],
  },
  {
    tag: 'skill',
    label: 'skills',
    kind: 'domain',
    patterns: [/\bskill(?:s)?\b/i, /\bskill\.md\b/i, /\bsuggestion(?:s)?\b/i],
  },
  {
    tag: 'usage',
    label: 'usage',
    kind: 'domain',
    patterns: [
      /\busage\b/i,
      /\btoken(?:s)?\b/i,
      /\bcost(?:s)?\b/i,
      /\bpricing\b/i,
    ],
  },
  {
    tag: 'desktop',
    label: 'desktop',
    kind: 'domain',
    patterns: [
      /\bdesktop\b/i,
      /\btauri\b/i,
      /\bgnome\b/i,
      /\bgtk\b/i,
      /\bflatpak\b/i,
    ],
  },
  {
    tag: 'docs',
    label: 'docs',
    kind: 'domain',
    patterns: [/\bdocs?\b/i, /\bdocumentation\b/i, /\breadme\b/i],
  },
];

const TASK_TAG_LABELS = new Map(TASK_TAGS.map((tag) => [tag.tag, tag.label]));

const SUGGESTION_PROFILES: SkillSuggestionProfile[] = [
  {
    id: 'github-pr-review',
    title: 'Handle GitHub PR review feedback',
    name: 'github-pr-review',
    description:
      'Use when a thread is about addressing GitHub pull request review comments, requested changes, or PR check feedback.',
    trigger:
      'addressing GitHub pull request review comments, requested changes, or PR check feedback',
    requiredTags: ['github', 'review'],
  },
  {
    id: 'browser-ui-tests',
    title: 'Fix browser UI test failures',
    name: 'browser-ui-tests',
    description:
      'Use when a workspace thread repeatedly combines Playwright, browser UI behavior, and failing tests.',
    trigger:
      'debugging Playwright or browser UI test failures for frontend changes',
    requiredTags: ['playwright'],
    anyTags: ['fix', 'test', 'frontend', 'ui'],
  },
  {
    id: 'react-ui-work',
    title: 'Build and polish React UI',
    name: 'react-ui-work',
    description:
      'Use when threads repeatedly ask for React components, frontend layout fixes, or UI polish.',
    trigger:
      'building, fixing, or polishing React frontend UI and responsive layout',
    requiredTags: ['react'],
    anyTags: ['frontend', 'ui', 'build', 'fix', 'improve'],
  },
  {
    id: 'backend-api-work',
    title: 'Implement backend API changes',
    name: 'backend-api-work',
    description:
      'Use when repeated work touches backend routes, API behavior, database shape, or server-side contracts.',
    trigger:
      'implementing or fixing backend API, database, or server-side contract changes',
    requiredTags: ['backend'],
    anyTags: ['api', 'database', 'sync', 'parser', 'fix', 'build'],
  },
  {
    id: 'sync-ingestion-work',
    title: 'Improve sync and ingestion behavior',
    name: 'sync-ingestion-work',
    description:
      'Use when repeated threads involve rollout ingestion, parser behavior, sync diagnostics, or thread import quality.',
    trigger:
      'debugging or improving rollout sync, ingestion, parser, or thread import behavior',
    requiredTags: ['sync'],
    anyTags: ['parser', 'database', 'backend', 'fix', 'improve'],
  },
  {
    id: 'skill-authoring-work',
    title: 'Design workspace skills',
    name: 'workspace-skill-design',
    description:
      'Use when threads repeatedly discuss skill suggestions, skill authoring, or project-local skill workflows.',
    trigger:
      'designing, improving, or generating workspace-specific Codex skills',
    requiredTags: ['skill'],
    anyTags: ['build', 'improve', 'configure'],
  },
  {
    id: 'usage-pricing-work',
    title: 'Maintain usage and pricing dashboards',
    name: 'usage-pricing-work',
    description:
      'Use when repeated threads touch usage charts, token accounting, cost estimates, or pricing data.',
    trigger:
      'working on token usage, cost, pricing, and local usage dashboard behavior',
    requiredTags: ['usage'],
    anyTags: ['frontend', 'backend', 'database', 'fix', 'improve'],
  },
  {
    id: 'release-publishing',
    title: 'Publish project releases',
    name: 'release-publishing',
    description:
      'Use when repeated threads involve versioning, release notes, tags, publishing, or changelogs.',
    trigger: 'preparing, tagging, documenting, or publishing project releases',
    requiredTags: ['release'],
    anyTags: ['commit', 'docs', 'github'],
  },
];

function normalizeSignalText(value: string): string {
  return value
    .replace(/<INSTRUCTIONS>[\s\S]*?(?:<\/INSTRUCTIONS>|$)/gi, ' ')
    .replace(
      /<environment_context>[\s\S]*?(?:<\/environment_context>|$)/gi,
      ' ',
    )
    .replace(
      /<permissions instructions>[\s\S]*?(?:<\/permissions instructions>|$)/gi,
      ' ',
    )
    .replace(/<collaboration_mode>[\s\S]*?(?:<\/collaboration_mode>|$)/gi, ' ')
    .replace(
      /<skills_instructions>[\s\S]*?(?:<\/skills_instructions>|$)/gi,
      ' ',
    )
    .replace(
      /<plugins_instructions>[\s\S]*?(?:<\/plugins_instructions>|$)/gi,
      ' ',
    )
    .replace(/```[\s\S]*?```/g, '[code omitted]')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSignalText(value: string, maxLength: number): string {
  const normalized = normalizeSignalText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function stripTaskPrefix(value: string): string {
  return value
    .replace(/^(user|assistant):\s*/i, '')
    .replace(/^(can|could|would) you\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^(let us|let's)\s+/i, '')
    .replace(/^i need you to\s+/i, '')
    .trim();
}

function upperCaseFirst(value: string): string {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function cleanTaskTitle(value: string): string {
  const normalized = stripTaskPrefix(normalizeSignalText(value));
  const firstSentence =
    normalized.split(/(?<=[.!?])\s+/)[0]?.replace(/[.!?]+$/g, '') ?? normalized;

  return upperCaseFirst(firstSentence).slice(0, 120);
}

function isLowValuePrompt(value: string): boolean {
  const normalized = normalizeSignalText(value).toLowerCase();

  return (
    normalized.length < 8 ||
    /^(ok|okay|yes|yep|sure|thanks|thank you|continue|go on)\b/.test(
      normalized,
    ) ||
    /^commit and push(?: all)?$/.test(normalized) ||
    /^push(?: it| all)?$/.test(normalized) ||
    /^(implemented|fixed|updated|added|removed|changed|created|wired|verified|ran|reran|documented|built|refactored)\b/.test(
      normalized,
    ) ||
    /^i(?:'m| am| )\b.*\b(found|fixed|updated|implemented|added|created|rerunning|patching)\b/.test(
      normalized,
    )
  );
}

function selectPrimaryUserPrompt(candidate: ThreadCandidate): string | null {
  const prompts = candidate.messages
    .filter((message) => message.role === 'user')
    .map((message) => truncateSignalText(message.content, 500))
    .filter(Boolean);
  const usefulPrompt = prompts.find((prompt) => !isLowValuePrompt(prompt));

  return usefulPrompt ?? prompts[0] ?? null;
}

function selectAssistantOutcome(candidate: ThreadCandidate): string {
  const outcomes = candidate.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => truncateSignalText(message.content, 500))
    .filter(Boolean);
  const outcomePattern =
    /\b(implemented|fixed|added|updated|changed|created|wired|ran|verified|found|reworked|replaced|documented|built|refactored|removed)\b/i;
  const usefulOutcome = outcomes
    .slice()
    .reverse()
    .find((outcome) => outcomePattern.test(outcome));

  return usefulOutcome ?? outcomes.at(-1) ?? '';
}

function inferTaskTags(text: string): string[] {
  const tags = new Set<string>();

  for (const definition of TASK_TAGS) {
    if (definition.patterns.some((pattern) => pattern.test(text))) {
      tags.add(definition.tag);
    }
  }

  if (tags.has('playwright')) {
    tags.add('test');
  }
  if (tags.has('react')) {
    tags.add('frontend');
    tags.add('ui');
  }
  if (tags.has('ci')) {
    tags.add('test');
  }
  if (
    tags.has('github') &&
    /\b(pr|pull request|review comments?)\b/i.test(text)
  ) {
    tags.add('review');
  }
  if (tags.has('database')) {
    tags.add('backend');
  }

  return Array.from(tags).sort((left, right) => left.localeCompare(right));
}

function buildTaskSummary(prompt: string, outcome: string): string {
  const source = outcome || prompt;
  const summary = stripTaskPrefix(truncateSignalText(source, 280));

  return /[.!?]$/.test(summary) ? summary : `${summary}.`;
}

export function buildSkillThreadSignal(
  candidate: ThreadCandidate,
  project: ProjectSummary,
): SkillThreadSignalRecord | null {
  const userPrompt = selectPrimaryUserPrompt(candidate);
  if (!userPrompt || isLowValuePrompt(userPrompt)) {
    return null;
  }

  const assistantResponse = selectAssistantOutcome(candidate);
  const tags = inferTaskTags(`${userPrompt}\n${assistantResponse}`);
  if (tags.length === 0) {
    return null;
  }

  return {
    threadId: candidate.threadId,
    projectId: project.id,
    rolloutPath: candidate.rolloutPath,
    userPrompt,
    assistantResponse,
    taskTitle: cleanTaskTitle(userPrompt) || cleanTaskTitle(assistantResponse),
    taskSummary: buildTaskSummary(userPrompt, assistantResponse),
    tags,
    updatedAt: candidate.updatedAt,
  };
}

function normalizeStoredSkillThreadSignal(
  signal: SkillThreadSignalRecord,
): SkillThreadSignalRecord {
  const userPrompt =
    truncateSignalText(signal.userPrompt, 500) ||
    truncateSignalText(signal.taskTitle, 500) ||
    truncateSignalText(signal.taskSummary, 500);
  const assistantResponse =
    truncateSignalText(signal.assistantResponse, 500) ||
    truncateSignalText(signal.taskSummary, 500);
  const tags =
    signal.tags.length > 0
      ? signal.tags
      : inferTaskTags(`${userPrompt}\n${assistantResponse}`);

  return {
    ...signal,
    userPrompt,
    assistantResponse,
    taskTitle: cleanTaskTitle(signal.taskTitle || userPrompt),
    taskSummary: buildTaskSummary(userPrompt, assistantResponse),
    tags,
  };
}

function isUsableSkillThreadSignal(signal: SkillThreadSignalRecord): boolean {
  return Boolean(
    signal.userPrompt &&
      !isLowValuePrompt(signal.userPrompt) &&
      signal.tags.length > 0,
  );
}

function extractPreviewRoleBlocks(preview: string, role: 'USER' | 'ASSISTANT') {
  const blocks: string[] = [];
  const pattern = new RegExp(
    `(?:^|\\n\\n)${role}:\\n([\\s\\S]*?)(?=\\n\\n(?:USER|ASSISTANT|TOOL):|$)`,
    'g',
  );

  for (const match of preview.matchAll(pattern)) {
    const content = truncateSignalText(match[1] ?? '', 500);
    if (content) {
      blocks.push(content);
    }
  }

  return blocks;
}

function buildSkillThreadSignalFromIssue(
  issue: ParsedIssue,
): SkillThreadSignalRecord | null {
  const userPrompt = extractPreviewRoleBlocks(
    issue.evidence.parsePayloadPreview,
    'USER',
  ).find((prompt) => !isLowValuePrompt(prompt));
  if (!userPrompt || isLowValuePrompt(userPrompt)) {
    return null;
  }

  const assistantBlocks = extractPreviewRoleBlocks(
    issue.evidence.parsePayloadPreview,
    'ASSISTANT',
  );
  const assistantResponse =
    assistantBlocks.at(-1) ?? truncateSignalText(issue.summary, 500);
  const tags = inferTaskTags(
    `${userPrompt}\n${assistantResponse}\n${issue.title}\n${issue.summary}`,
  );
  if (tags.length === 0) {
    return null;
  }

  return {
    threadId: issue.threadId,
    projectId: issue.projectId,
    rolloutPath: issue.evidence.rolloutPath,
    userPrompt,
    assistantResponse,
    taskTitle: cleanTaskTitle(userPrompt) || issue.title,
    taskSummary: buildTaskSummary(userPrompt, assistantResponse),
    tags,
    updatedAt: issue.updatedAt,
  };
}

function ensureProjectSkillThreadSignals(
  database: BoardsDatabase,
  project: ProjectSummary,
  existingSignals: SkillThreadSignalRecord[],
): SkillThreadSignalRecord[] {
  const existingThreadIds = new Set(
    existingSignals.map((signal) => signal.threadId),
  );
  const issuesByThread = new Map<string, ParsedIssue>();

  for (const issue of database.listProjectIssues(project.id)) {
    if (issue.kind !== 'parent' || existingThreadIds.has(issue.threadId)) {
      continue;
    }

    issuesByThread.set(issue.threadId, issue);
  }

  if (issuesByThread.size === 0) {
    return existingSignals;
  }

  for (const issue of issuesByThread.values()) {
    const signal = buildSkillThreadSignalFromIssue(issue);
    if (signal) {
      database.saveSkillThreadSignal(signal);
    }
  }

  return database.listProjectSkillThreadSignals(project.id);
}

function profileMatches(
  profile: SkillSuggestionProfile,
  tags: Set<string>,
): boolean {
  return (
    profile.requiredTags.every((tag) => tags.has(tag)) &&
    (!profile.anyTags || profile.anyTags.some((tag) => tags.has(tag)))
  );
}

function getSignalClusterKey(signal: SkillThreadSignalRecord): string | null {
  const tags = new Set(signal.tags);
  const profile = SUGGESTION_PROFILES.find((candidate) =>
    profileMatches(candidate, tags),
  );
  if (profile) {
    return profile.id;
  }

  const action = signal.tags.find((tag) => ACTION_TAGS.has(tag));
  const domains = signal.tags.filter((tag) => !ACTION_TAGS.has(tag));
  if (!action || domains.length === 0) {
    return null;
  }

  return `generic:${action}:${domains.slice(0, 2).join('+')}`;
}

function countClusterTags(signals: SkillThreadSignalRecord[]): string[] {
  const counts = new Map<string, number>();

  for (const signal of signals) {
    for (const tag of signal.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([tag]) => tag)
    .slice(0, 6);
}

function uniqueLimited(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = truncateSignalText(value, 220);
    const identity = normalized.toLowerCase();
    if (!normalized || seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    output.push(normalized);
    if (output.length >= limit) {
      break;
    }
  }

  return output;
}

function createGenericSuggestionMetadata(
  key: string,
  tags: string[],
): {
  title: string;
  name: string;
  description: string;
  trigger: string;
} {
  const [, action = 'improve', domainList = 'workspace'] = key.split(':');
  const domains = domainList.split('+').filter(Boolean);
  const actionLabel = TASK_TAG_LABELS.get(action) ?? action;
  const domainLabel =
    domains.map((tag) => TASK_TAG_LABELS.get(tag) ?? tag).join(' and ') ||
    tags
      .filter((tag) => !ACTION_TAGS.has(tag))
      .slice(0, 2)
      .map((tag) => TASK_TAG_LABELS.get(tag) ?? tag)
      .join(' and ') ||
    'workspace';
  const title = `${upperCaseFirst(actionLabel)} ${domainLabel} workflows`;
  const trigger = `${actionLabel} work around ${domainLabel} in this workspace`;

  return {
    title,
    name: slugify(title),
    description: `Use when recurring threads involve ${trigger}.`,
    trigger,
  };
}

function getSuggestionMetadata(key: string, tags: string[]) {
  const profile = SUGGESTION_PROFILES.find((candidate) => candidate.id === key);
  if (profile) {
    return {
      title: profile.title,
      name: profile.name,
      description: profile.description,
      trigger: profile.trigger,
    };
  }

  return createGenericSuggestionMetadata(key, tags);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

function buildSuggestedSkillBody(params: {
  title: string;
  name: string;
  description: string;
  trigger: string;
  tags: string[];
  evidenceThreadCount: number;
  examplePrompts: string[];
  commonOutcomes: string[];
}): string {
  const promptBullets = params.examplePrompts
    .map((prompt) => `- ${prompt}`)
    .join('\n');
  const outcomeBullets = params.commonOutcomes
    .map((outcome) => `- ${outcome}`)
    .join('\n');

  return [
    '---',
    `name: ${params.name}`,
    `description: ${quoteYaml(params.description)}`,
    '---',
    '',
    `# ${params.title}`,
    '',
    `Use this skill when ${params.trigger}.`,
    '',
    '## Workflow',
    '',
    '- Read the current user request and recent workspace context.',
    '- Inspect the relevant project files before changing code.',
    '- Apply the smallest change that handles the repeated task pattern.',
    '- Run focused verification and report the concrete result.',
    '',
    '## Workspace Signals',
    '',
    `- Seen in ${params.evidenceThreadCount} imported threads.`,
    `- Common tags: ${params.tags.join(', ') || 'none'}.`,
    '',
    '## Example Prompts',
    '',
    promptBullets || '- No prompt examples available.',
    '',
    '## Common Outcomes',
    '',
    outcomeBullets || '- No outcome examples available.',
  ].join('\n');
}

function createSkillSuggestion(
  project: ProjectSummary,
  cluster: SuggestionCluster,
): SkillSuggestion {
  const signals = cluster.signals
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const tags = countClusterTags(signals);
  const metadata = getSuggestionMetadata(cluster.key, tags);
  const examplePrompts = uniqueLimited(
    signals.map((signal) => signal.userPrompt),
    MAX_EVIDENCE_ITEMS,
  );
  const commonOutcomes = uniqueLimited(
    signals.map((signal) => signal.assistantResponse).filter(Boolean),
    MAX_EVIDENCE_ITEMS,
  );
  const evidence = signals.slice(0, MAX_EVIDENCE_ITEMS).map((signal) => ({
    threadId: signal.threadId,
    prompt: signal.userPrompt,
    outcome: signal.assistantResponse,
    updatedAt: signal.updatedAt,
  }));
  const id = createHash('sha256')
    .update(`${project.id}:${cluster.key}`)
    .digest('base64url')
    .slice(0, 24);

  return {
    id,
    title: metadata.title,
    name: metadata.name,
    description: metadata.description,
    trigger: metadata.trigger,
    tags,
    evidenceThreadCount: signals.length,
    examplePrompts,
    commonOutcomes,
    evidence,
    suggestedSkillBody: buildSuggestedSkillBody({
      ...metadata,
      tags,
      evidenceThreadCount: signals.length,
      examplePrompts,
      commonOutcomes,
    }),
  };
}

function createSkillSuggestions(
  project: ProjectSummary,
  signals: SkillThreadSignalRecord[],
): SkillSuggestion[] {
  const clusters = new Map<string, SuggestionCluster>();

  for (const signal of signals) {
    const key = getSignalClusterKey(signal);
    if (!key) {
      continue;
    }

    const cluster = clusters.get(key) ?? { key, signals: [] };
    cluster.signals.push(signal);
    clusters.set(key, cluster);
  }

  return Array.from(clusters.values())
    .filter((cluster) => cluster.signals.length >= MIN_SUGGESTION_EVIDENCE)
    .map((cluster) => createSkillSuggestion(project, cluster))
    .sort(
      (left, right) =>
        right.evidenceThreadCount - left.evidenceThreadCount ||
        left.title.localeCompare(right.title),
    )
    .slice(0, SUGGESTION_LIMIT);
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

export function listSkillSuggestions(
  context: SkillRequestContext,
): SkillSuggestionListResponse {
  const project = findProject(context.database, context.projectId);
  const signals = project
    ? ensureProjectSkillThreadSignals(
        context.database,
        project,
        context.database.listProjectSkillThreadSignals(project.id),
      )
        .map((signal) => normalizeStoredSkillThreadSignal(signal))
        .filter((signal) => isUsableSkillThreadSignal(signal))
    : [];

  return {
    generatedAt: new Date().toISOString(),
    project,
    signalCount: signals.length,
    suggestions: project ? createSkillSuggestions(project, signals) : [],
  };
}

function normalizeInstallSkillName(value: string): string {
  return slugify(value).slice(0, 80);
}

function normalizeInstallSkillContent(value: string): string {
  const normalized = value.replace(/\r/g, '').trim();

  return normalized ? `${normalized}\n` : '';
}

export function installSuggestedSkill(
  context: SkillRequestContext & { payload: InstallSkillPayload },
): { status: number; response: InstallSkillResponse } {
  const target = context.payload.target;
  const name = normalizeInstallSkillName(context.payload.name);
  const content = normalizeInstallSkillContent(context.payload.content);

  if (target !== 'workspace' && target !== 'global') {
    return {
      status: 400,
      response: {
        ok: false,
        skill: null,
        message: 'target must be workspace or global.',
      },
    };
  }

  if (!name) {
    return {
      status: 400,
      response: {
        ok: false,
        skill: null,
        message: 'name is required.',
      },
    };
  }

  if (!content) {
    return {
      status: 400,
      response: {
        ok: false,
        skill: null,
        message: 'content is required.',
      },
    };
  }

  if (content.length > 60_000) {
    return {
      status: 400,
      response: {
        ok: false,
        skill: null,
        message: 'content is too large.',
      },
    };
  }

  const project =
    target === 'workspace'
      ? findProject(context.database, context.payload.projectId)
      : null;

  if (target === 'workspace' && !project) {
    return {
      status: 400,
      response: {
        ok: false,
        skill: null,
        message: 'projectId is required for workspace skills.',
      },
    };
  }

  const root: SkillRoot =
    target === 'workspace' && project
      ? {
          path: join(project.workspacePath, '.agents', 'skills'),
          source: 'project',
          sourceLabel: 'Project',
          sourceName: project.id,
          projectId: project.id,
        }
      : {
          path: join(resolveAgentsHome(context.config), 'skills'),
          source: 'agent',
          sourceLabel: 'Agent',
          sourceName: 'agent',
        };
  const rootPath = resolve(root.path);
  const skillDirectory = join(rootPath, name);
  const skillPath = join(skillDirectory, 'SKILL.md');

  if (existsSync(skillPath)) {
    return {
      status: 409,
      response: {
        ok: false,
        skill: null,
        message: `Skill already exists at ${skillPath}.`,
      },
    };
  }

  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(skillPath, content);

  const canonicalRootPath = realpathSync(rootPath);
  const canonicalPath = realpathSync(skillPath);
  const metadata = parseSkillMetadata(content, name);
  const skill: SkillSummary = {
    id: createSkillId(canonicalPath),
    name: metadata.name,
    description:
      metadata.description || context.payload.description?.trim() || '',
    enabled: true,
    source: root.source,
    sourceLabel: root.sourceLabel,
    sourceName: root.sourceName,
    path: canonicalPath,
    relativePath: relative(canonicalRootPath, canonicalPath),
    projectId: root.projectId ?? null,
  };

  return {
    status: 201,
    response: {
      ok: true,
      skill,
      message:
        target === 'workspace'
          ? 'Skill added to workspace.'
          : 'Skill added globally.',
    },
  };
}

export function updateSkillEnabled(
  context: SkillRequestContext & {
    payload: UpdateSkillEnabledPayload;
    skillId: string;
  },
): { status: number; response: UpdateSkillEnabledResponse } {
  if (typeof context.payload.enabled !== 'boolean') {
    return {
      status: 400,
      response: {
        ok: false,
        skill: null,
        message: 'enabled must be a boolean.',
        restartRequired: false,
      },
    };
  }

  const scoped = getScopedSkills(context);
  const summary =
    scoped.skills.find((skill) => skill.id === context.skillId) ?? null;

  if (!summary) {
    return {
      status: 404,
      response: {
        ok: false,
        skill: null,
        message: 'Skill not found.',
        restartRequired: false,
      },
    };
  }

  const update = updateSkillEnabledConfig(
    context.config,
    summary.path,
    context.payload.enabled,
  );
  const refreshed = getScopedSkills(context).skills.find(
    (skill) => skill.id === context.skillId,
  ) ?? {
    ...summary,
    enabled: context.payload.enabled,
  };
  const stateLabel = context.payload.enabled ? 'enabled' : 'disabled';

  return {
    status: 200,
    response: {
      ok: true,
      skill: refreshed,
      message: update.changed
        ? `Skill ${stateLabel}. Restart Codex for this change to affect skill invocation.`
        : `Skill is already ${stateLabel}.`,
      restartRequired: update.changed,
    },
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
