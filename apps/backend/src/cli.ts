import { spawnSync } from 'node:child_process';

import type {
  ExportedMulticaIssue,
  ParsedIssue,
} from '../../../packages/domain/src/index';

import type { BoardsDatabase } from './db';

export interface ExportMulticaCliOptions {
  projectId: string;
  issueIds: string[];
  includeChildren: boolean;
  runSync: boolean;
  dryRun: boolean;
}

export interface ServeCliOptions {
  port: number | null;
}

export type ParsedCliCommand =
  | {
      command: 'serve';
      options: ServeCliOptions;
    }
  | {
      command: 'export-multica';
      options: ExportMulticaCliOptions;
    }
  | {
      command: 'help';
    };

export interface MulticaCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExportMulticaResult {
  exported: ExportedMulticaIssue[];
  skippedChildren: Array<{
    sourceIssueId: string;
    reason: string;
  }>;
}

export type RunMulticaCommand = (
  args: string[],
) => MulticaCommandResult | Promise<MulticaCommandResult>;

const HELP_TEXT = `Usage:
  bun src/index.ts
  bun src/index.ts serve [--port <port>]
  bun src/index.ts issues export multica --project <project-id> [--issue <issue-id>] [--dry-run] [--skip-sync] [--no-children]

Commands:
  serve
      Start the backend server and run the initial sync.

  issues export multica
      Create Multica issues from the current local board state.

Flags:
  --port <port>          Serve the backend on a specific local port.
  --project <project-id>   Export issues from a single project. Required.
  --issue <issue-id>       Export only the selected parent issue. Repeatable.
  --dry-run                Print the Multica commands without executing them.
  --skip-sync              Export the current SQLite state without running sync first.
  --no-children            Export only parent issues.
  --help                   Show this help text.
`;

export function getCliHelpText(): string {
  return HELP_TEXT;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be a TCP port from 1 to 65535');
  }

  return port;
}

export function parseCliCommand(args: string[]): ParsedCliCommand {
  if (args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    return { command: 'help' };
  }

  if (args.length === 0) {
    return { command: 'serve', options: { port: null } };
  }

  if (args[0] === 'serve' || args[0] === 'server' || args[0] === 'start') {
    const options: ServeCliOptions = {
      port: null,
    };
    const serveArgs = args.slice(1);

    for (let index = 0; index < serveArgs.length; index += 1) {
      const token = serveArgs[index];

      if (token === '--port') {
        const value = serveArgs[index + 1];
        if (!value) {
          throw new Error('--port requires a value');
        }

        options.port = parsePort(value);
        index += 1;
        continue;
      }

      throw new Error(`Unknown serve flag: ${token}`);
    }

    return { command: 'serve', options };
  }

  const exportCommand =
    (args[0] === 'issues' &&
      args[1] === 'export' &&
      args[2] === 'multica' &&
      args.slice(3)) ||
    (args[0] === 'export' && args[1] === 'multica' && args.slice(2));

  if (!exportCommand) {
    throw new Error(`Unknown command: ${args.join(' ')}`);
  }

  const options: ExportMulticaCliOptions = {
    projectId: '',
    issueIds: [],
    includeChildren: true,
    runSync: true,
    dryRun: false,
  };

  for (let index = 0; index < exportCommand.length; index += 1) {
    const token = exportCommand[index];

    if (token === '--project') {
      const value = exportCommand[index + 1];
      if (!value) {
        throw new Error('--project requires a value');
      }

      options.projectId = value;
      index += 1;
      continue;
    }

    if (token === '--issue') {
      const value = exportCommand[index + 1];
      if (!value) {
        throw new Error('--issue requires a value');
      }

      options.issueIds.push(value);
      index += 1;
      continue;
    }

    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (token === '--skip-sync') {
      options.runSync = false;
      continue;
    }

    if (token === '--no-children') {
      options.includeChildren = false;
      continue;
    }

    throw new Error(`Unknown flag: ${token}`);
  }

  if (!options.projectId) {
    throw new Error('--project is required');
  }

  return {
    command: 'export-multica',
    options,
  };
}

export function runMulticaCommand(args: string[]): MulticaCommandResult {
  const result = spawnSync('multica', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? '',
    stderr:
      result.stderr ??
      (result.error instanceof Error ? result.error.message : ''),
  };
}

function mapMulticaStatus(status: ParsedIssue['status']): string | null {
  if (status === 'unknown') {
    return null;
  }

  return status;
}

function mapMulticaPriority(priority: ParsedIssue['priority']): string | null {
  if (priority === 'unknown') {
    return null;
  }

  return priority;
}

function isRfc3339(value: string | null): value is string {
  if (!value) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}

export function buildMulticaDescription(issue: ParsedIssue): string {
  const lines = [issue.summary.trim() || issue.title.trim(), ''];

  if (issue.tags.length > 0) {
    lines.push(`Tags: ${issue.tags.join(', ')}`);
  }

  lines.push(`Source issue: ${issue.id}`);
  lines.push(`Project: ${issue.projectId}`);
  lines.push(`Repository: ${issue.git.repository}`);
  lines.push(`Workspace: ${issue.git.workspacePath}`);

  if (issue.git.branch) {
    lines.push(`Branch: ${issue.git.branch}`);
  }

  lines.push(`Thread: ${issue.threadId}`);
  lines.push(`Parse mode: ${issue.parseMode}`);
  lines.push(`Confidence: ${issue.confidence.toFixed(2)}`);
  lines.push(`Needs review: ${issue.needsReview ? 'yes' : 'no'}`);

  if (issue.git.tags.length > 0) {
    lines.push(`Git tags: ${issue.git.tags.join(', ')}`);
  }

  if (issue.git.commits.length > 0) {
    lines.push('');
    lines.push('Commits:');

    for (const commit of issue.git.commits) {
      const summary = commit.message?.trim()
        ? ` - ${commit.message.trim()}`
        : '';
      lines.push(`- ${commit.sha}${summary}`);
    }
  }

  if (issue.evidence.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');

    for (const warning of issue.evidence.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n').trim();
}

function buildMulticaCreateArgs(
  issue: ParsedIssue,
  parentMulticaIssueId: string | null,
): string[] {
  const args = [
    'issue',
    'create',
    '--output',
    'json',
    '--title',
    issue.title,
    '--description',
    buildMulticaDescription(issue),
  ];

  const status = mapMulticaStatus(issue.status);
  if (status) {
    args.push('--status', status);
  }

  const priority = mapMulticaPriority(issue.priority);
  if (priority) {
    args.push('--priority', priority);
  }

  if (issue.assignee) {
    args.push('--assignee', issue.assignee);
  }

  if (isRfc3339(issue.dueDate)) {
    args.push('--due-date', issue.dueDate);
  }

  if (parentMulticaIssueId) {
    args.push('--parent', parentMulticaIssueId);
  }

  return args;
}

function omitCommandFlag(args: string[], flag: string): string[] {
  const next: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      index += 1;
      continue;
    }

    next.push(args[index] as string);
  }

  return next;
}

function readCreatedMulticaIssueId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const directId = parsed.id;
    if (typeof directId === 'string' && directId.trim()) {
      return directId;
    }

    const nestedIssue = parsed.issue;
    if (
      nestedIssue &&
      typeof nestedIssue === 'object' &&
      typeof (nestedIssue as { id?: unknown }).id === 'string'
    ) {
      return (nestedIssue as { id: string }).id;
    }

    const nestedData = parsed.data;
    if (
      nestedData &&
      typeof nestedData === 'object' &&
      typeof (nestedData as { id?: unknown }).id === 'string'
    ) {
      return (nestedData as { id: string }).id;
    }
  } catch {
    return null;
  }

  return null;
}

function loadIssuesForExport(
  database: BoardsDatabase,
  projectId: string,
  issueIds: string[],
): ParsedIssue[] {
  if (issueIds.length === 0) {
    return database.listIssues(projectId, {}).issues.flatMap((issue) => {
      const response = database.getIssue(issue.id);
      return response.issue ? [response.issue] : [];
    });
  }

  return issueIds.map((issueId) => {
    const response = database.getIssue(issueId);
    const issue = response.issue;
    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`);
    }

    if (issue.projectId !== projectId) {
      throw new Error(
        `Issue ${issueId} belongs to project ${issue.projectId}, not ${projectId}`,
      );
    }

    return issue;
  });
}

async function exportSingleIssue(
  issue: ParsedIssue,
  parentMulticaIssueId: string | null,
  dryRun: boolean,
  runCommand: RunMulticaCommand,
): Promise<ExportedMulticaIssue> {
  const command = buildMulticaCreateArgs(issue, parentMulticaIssueId);

  if (dryRun) {
    return {
      sourceIssueId: issue.id,
      multicaIssueId: parentMulticaIssueId ? `dry-run:${issue.id}` : null,
      title: issue.title,
      command,
      dryRun: true,
    };
  }

  const result = await runCommand(command);
  if (
    result.exitCode !== 0 &&
    issue.assignee &&
    /resolve assignee|no member or agent found matching/i.test(result.stderr)
  ) {
    const fallbackCommand = omitCommandFlag(command, '--assignee');
    const fallbackResult = await runCommand(fallbackCommand);

    if (fallbackResult.exitCode === 0) {
      return {
        sourceIssueId: issue.id,
        multicaIssueId: readCreatedMulticaIssueId(fallbackResult.stdout),
        title: issue.title,
        command: fallbackCommand,
        dryRun: false,
      };
    }
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim() || 'Unknown multica error';
    throw new Error(`Failed to export issue ${issue.id}: ${stderr}`);
  }

  return {
    sourceIssueId: issue.id,
    multicaIssueId: readCreatedMulticaIssueId(result.stdout),
    title: issue.title,
    command,
    dryRun: false,
  };
}

export async function exportIssuesToMultica(
  database: BoardsDatabase,
  options: ExportMulticaCliOptions,
  runCommand: RunMulticaCommand = runMulticaCommand,
): Promise<ExportMulticaResult> {
  const project = database
    .listProjects()
    .projects.find((entry) => entry.id === options.projectId);

  if (!project) {
    throw new Error(`Project not found: ${options.projectId}`);
  }

  const issues = loadIssuesForExport(
    database,
    options.projectId,
    options.issueIds,
  );
  if (issues.length === 0) {
    throw new Error(`No parent issues found for project ${options.projectId}`);
  }

  const exported: ExportedMulticaIssue[] = [];
  const skippedChildren: ExportMulticaResult['skippedChildren'] = [];

  for (const issue of issues) {
    const parentResult = await exportSingleIssue(
      issue,
      null,
      options.dryRun,
      runCommand,
    );
    exported.push(parentResult);

    if (
      !options.includeChildren ||
      !issue.children ||
      issue.children.length === 0
    ) {
      continue;
    }

    const parentIdForChildren =
      parentResult.multicaIssueId ??
      (options.dryRun ? `dry-run:${issue.id}` : null);

    if (!parentIdForChildren) {
      for (const child of issue.children) {
        skippedChildren.push({
          sourceIssueId: child.id,
          reason: `Parent export for ${issue.id} did not return a Multica issue id`,
        });
      }
      continue;
    }

    for (const child of issue.children) {
      const childResult = await exportSingleIssue(
        child,
        parentIdForChildren,
        options.dryRun,
        runCommand,
      );
      exported.push(childResult);
    }
  }

  return {
    exported,
    skippedChildren,
  };
}
