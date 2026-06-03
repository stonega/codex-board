import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  type IssueCommitRef,
  type IssueGitEvidence,
  type IssuePriority,
  type IssueStatus,
  type ParseMode,
  type ParsedIssue,
  type ProjectSummary,
  type SyncTokenUsage,
  inferIssuePriority,
  inferIssueStatus,
  inferProjectId,
  inferProjectName,
  normalizeTags,
  scoreConfidence,
  shouldNeedsReview,
} from '@codex-boards/domain';

export interface RolloutFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface ThreadMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ThreadCandidate {
  sessionId: string;
  threadId: string;
  rolloutPath: string;
  startedAt: string;
  updatedAt: string;
  workspacePath: string;
  repository: string;
  branch: string | null;
  messages: ThreadMessage[];
  commands: string[];
  warnings: string[];
  git: IssueGitEvidence;
}

export interface ParsePayload {
  titleHint: string;
  preview: string;
  content: string;
}

interface AiParseResult {
  parent: {
    title: string;
    summary: string;
    status?: IssueStatus;
    priority?: IssuePriority;
    assignee?: string | null;
    dueDate?: string | null;
    tags?: string[];
  };
  subIssues: Array<{
    title: string;
    summary: string;
    status?: IssueStatus;
    priority?: IssuePriority;
    tags?: string[];
  }>;
  warnings?: string[];
}

export function listRolloutFiles(root: string): RolloutFile[] {
  if (!existsSync(root)) {
    return [];
  }

  const output: RolloutFile[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }

      if (
        !entry.isFile() ||
        !entry.name.startsWith('rollout-') ||
        !entry.name.endsWith('.jsonl')
      ) {
        continue;
      }

      const stats = statSync(absolute);
      output.push({
        path: absolute,
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
      });
    }
  }

  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function grepGitSignals(filePath: string): string[] {
  const patterns = [
    'commit\\s+[0-9a-f]{7,40}',
    '^##\\s+[^\\s]+',
    'On branch\\s+[^\\s]+',
    '\\bv?\\d+\\.\\d+\\.\\d+(?:[-+][a-z0-9.-]+)?\\b',
    '\\bgit\\s+(status|log|tag|show|rev-parse)\\b',
  ];
  const attempt = spawnSync(
    'rg',
    ['-n', '-i', ...patterns.flatMap((pattern) => ['-e', pattern]), filePath],
    {
      encoding: 'utf8',
    },
  );

  if (attempt.error || attempt.status === 127) {
    return [];
  }

  if (attempt.status !== 0 && attempt.status !== 1) {
    return [];
  }

  return attempt.stdout
    .split('\n')
    .map((line) => line.replace(/^\d+:/, '').replace(/\\n/g, '\n').trim())
    .filter(Boolean);
}

function extractTextContent(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const content = (payload as { content?: unknown }).content;

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .flatMap((part) => {
      if (!part || typeof part !== 'object') {
        return [];
      }

      const typedPart = part as { text?: string; type?: string };
      if (
        typedPart.type === 'output_text' ||
        typedPart.type === 'input_text' ||
        typedPart.type === 'text'
      ) {
        return typedPart.text ? [typedPart.text] : [];
      }

      return [];
    })
    .filter(Boolean);
}

function stripCodeBlocks(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, '[code omitted]')
    .replace(/diff --git[\s\S]+/g, '[diff omitted]');
}

function compactText(value: string): string {
  return stripCodeBlocks(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 16000);
}

function sanitizeMessageContent(value: string): string {
  return compactText(value)
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(
      /<permissions instructions>[\s\S]*?<\/permissions instructions>/gi,
      '',
    )
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, '')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, '')
    .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi, '')
    .replace(/^# AGENTS\.md instructions.*$/gim, '')
    .replace(
      /^##?\s+(Personality|Values|Interaction Style|Formatting rules|Final answer instructions|Escalation|General|Development Workflow|Coding Rules|Testing Requirements|Documentation Rules|Safety Rules|Pull Requests).*$/gim,
      '',
    )
    .trim();
}

function shouldKeepMessage(
  role: ThreadMessage['role'],
  content: string,
): boolean {
  const normalized = content.trim();
  if (!normalized) {
    return false;
  }

  if (
    /filesystem sandboxing|codex cli|skill-creator|plugin_name|apps \(connectors\)|available plugins/gi.test(
      normalized,
    )
  ) {
    return false;
  }

  if (role === 'assistant') {
    return (
      normalized.length < 900 &&
      /\b(i('| a)?m|i will|implemented|added|fixed|building|sync|table|sheet|issue|backend|frontend)\b/i.test(
        normalized,
      )
    );
  }

  return true;
}

function sliceHeadTail(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const half = Math.floor(maxLength / 2);
  return `${value.slice(0, half)}\n...\n${value.slice(-half)}`;
}

function findGitRoot(cwd: string): string | null {
  let current = cwd;
  const tempRoot = tmpdir();

  while (current.length > 1) {
    if (current === tempRoot) {
      return null;
    }

    if (existsSync(join(current, '.git'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return null;
}

function extractCommits(values: string[]): IssueCommitRef[] {
  const commits = new Map<string, IssueCommitRef>();

  for (const value of values) {
    const lines = value.split('\n');
    for (const line of lines) {
      const commitMatch = line.match(/\bcommit\s+([0-9a-f]{7,40})\b/i);
      if (commitMatch?.[1]) {
        commits.set(commitMatch[1], {
          sha: commitMatch[1],
          message: line.replace(/\s+/g, ' ').trim(),
          source: 'thread',
        });
        continue;
      }

      const gitLogMatch = line.match(/^([0-9a-f]{7,40})\s+(.+)$/);
      if (
        gitLogMatch?.[1] &&
        /\b(fix|feat|chore|docs|refactor|test|build|release)\b/i.test(
          gitLogMatch[2],
        )
      ) {
        commits.set(gitLogMatch[1], {
          sha: gitLogMatch[1],
          message: gitLogMatch[2].trim(),
          source: 'thread',
        });
      }
    }
  }

  return Array.from(commits.values()).slice(0, 12);
}

function extractTags(values: string[]): string[] {
  const tags = new Set<string>();

  for (const value of values) {
    const matches = value.matchAll(
      /\b(?:tag[:\s]+|release[:\s]+)?(v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)\b/gi,
    );
    for (const match of matches) {
      tags.add(match[1].toLowerCase());
    }

    const gitTagMatches = value.matchAll(
      /\bgit tag\b[^\n]*\n([\s\S]{0,300})/gi,
    );
    for (const match of gitTagMatches) {
      for (const line of match[1].split('\n')) {
        const trimmed = line.trim();
        if (/^[a-z0-9._/-]+$/i.test(trimmed)) {
          tags.add(trimmed.toLowerCase());
        }
      }
    }
  }

  return Array.from(tags).slice(0, 12);
}

function extractBranch(values: string[]): string | null {
  for (const value of values) {
    if (!/\bOn branch\b|^## /m.test(value)) {
      continue;
    }

    const onBranch = value.match(/\bOn branch ([^\s]+)/);
    if (onBranch?.[1]) {
      return onBranch[1];
    }

    const shortStatus = value.match(/^## ([^.\s]+)/m);
    if (shortStatus?.[1]) {
      return shortStatus[1];
    }
  }

  return null;
}

function buildFallbackTitle(
  messages: ThreadMessage[],
  repository: string,
): string {
  const firstUser =
    messages.find((message) => message.role === 'user')?.content ?? '';
  const lastAssistant =
    [...messages].reverse().find((message) => message.role === 'assistant')
      ?.content ?? '';

  const userSentence = cleanIssueTitle(firstUser.split('\n')[0] ?? '');
  if (userSentence) {
    return userSentence;
  }

  if (lastAssistant) {
    const summary = cleanIssueTitle(lastAssistant.split('\n')[0] ?? '');
    if (summary && summary.length > 20) {
      return summary;
    }
  }

  return `Sync work in ${repository}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function upperCaseFirst(value: string): string {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function stripMessagePrefix(value: string): string {
  return value
    .replace(/^(user|assistant|tool):\s*/i, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

function cleanIssueTitle(value: string): string {
  const normalized = normalizeWhitespace(stripMessagePrefix(value))
    .replace(/^(i will|i'll|we will|we'll)\s+/i, '')
    .replace(/^(implemented|implementing|added|adding|fixed|fixing)\s+/i, '')
    .replace(/[.:;,]+$/g, '')
    .replace(/\?+$/g, '');

  return upperCaseFirst(normalized).slice(0, 120);
}

function looksLikeRequestTitle(value: string): boolean {
  const normalized = normalizeWhitespace(stripMessagePrefix(value));
  if (!normalized) {
    return false;
  }

  if (/\?$/.test(normalized)) {
    return true;
  }

  return /^(can you|could you|please|do |does |is |are |should |confirm |check |add |update |remove |use |commit |push |release )/i.test(
    normalized,
  );
}

function titleFromSummary(value: string): string {
  const summary = cleanIssueSummary(value);
  if (!summary) {
    return '';
  }

  return cleanIssueTitle(summary.split(/[.!?]/)[0] ?? '');
}

function cleanIssueSummary(value: string): string {
  const normalized = normalizeWhitespace(stripMessagePrefix(value))
    .replace(/^(i will|i'll|we will|we'll)\s+/i, '')
    .replace(/^this (?:change|work|task)\s+/i, '')
    .slice(0, 320);

  if (!normalized) {
    return '';
  }

  return /[.!?]$/.test(normalized)
    ? upperCaseFirst(normalized)
    : `${upperCaseFirst(normalized)}.`;
}

function extractBulletItems(messages: ThreadMessage[]): string[] {
  return messages
    .flatMap((message) => message.content.split('\n'))
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => cleanIssueTitle(line))
    .filter((line) => line.length > 10)
    .slice(0, 6);
}

function buildFallbackSummary(
  candidate: ThreadCandidate,
  title: string,
): string {
  const firstUser =
    candidate.messages.find((message) => message.role === 'user')?.content ??
    '';
  const firstAssistant =
    candidate.messages.find((message) => message.role === 'assistant')
      ?.content ?? '';
  const bullets = extractBulletItems(candidate.messages);
  const primary =
    cleanIssueSummary(firstUser.split('\n')[0] ?? '') ||
    cleanIssueSummary(firstAssistant.split('\n')[0] ?? '') ||
    cleanIssueSummary(title);

  if (bullets.length === 0) {
    return primary;
  }

  const details = cleanIssueSummary(
    `Includes ${bullets
      .slice(0, 3)
      .map((item) => item.charAt(0).toLowerCase() + item.slice(1))
      .join(', ')}.`,
  );

  return `${primary} ${details}`.trim();
}

export function parseRolloutFile(file: RolloutFile): ThreadCandidate | null {
  const raw = readFileSync(file.path, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let sessionId = basename(file.path, '.jsonl');
  let startedAt = new Date(file.mtimeMs).toISOString();
  let updatedAt = startedAt;
  let workspacePath = '';
  const messages: ThreadMessage[] = [];
  const commands: string[] = [];
  const warnings: string[] = [];
  const gitTextPool: string[] = grepGitSignals(file.path);

  for (const line of lines) {
    const parsed = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
    updatedAt = parsed.timestamp ?? updatedAt;

    if (parsed.type === 'session_meta') {
      sessionId = String(parsed.payload?.id ?? sessionId);
      startedAt = String(parsed.payload?.timestamp ?? startedAt);
      workspacePath = String(parsed.payload?.cwd ?? workspacePath);
      continue;
    }

    if (parsed.type === 'event_msg') {
      const eventType = parsed.payload?.type;
      if (eventType === 'user_message' && parsed.payload?.message) {
        const content = sanitizeMessageContent(String(parsed.payload.message));
        if (!shouldKeepMessage('user', content)) {
          continue;
        }
        messages.push({
          role: 'user',
          content,
        });
      }

      if (eventType === 'agent_message' && parsed.payload?.message) {
        const content = sanitizeMessageContent(String(parsed.payload.message));
        if (!shouldKeepMessage('assistant', content)) {
          continue;
        }
        messages.push({
          role: 'assistant',
          content,
        });
      }

      if (eventType === 'exec_command_end') {
        const command = Array.isArray(parsed.payload?.command)
          ? parsed.payload.command.map(String).join(' ')
          : String(parsed.payload?.command ?? '');
        const output = compactText(
          String(parsed.payload?.aggregated_output ?? ''),
        );
        commands.push(command);
        if (/\bgit\b/i.test(command)) {
          gitTextPool.push(command, output);
        }
      }
    }

    if (parsed.type === 'response_item') {
      if (parsed.payload?.type === 'message') {
        const role = parsed.payload?.role === 'user' ? 'user' : 'assistant';
        const text = sanitizeMessageContent(
          extractTextContent(parsed.payload).join('\n'),
        );
        if (text.trim()) {
          if (!shouldKeepMessage(role, text)) {
            continue;
          }
          messages.push({ role, content: compactText(text) });
        }
      }

      if (parsed.payload?.type === 'function_call') {
        const args = String(parsed.payload.arguments ?? '');
        const name = String(parsed.payload.name ?? '');
        if (/\bgit\b/i.test(args) || /\bgit\b/i.test(name)) {
          gitTextPool.push(name, args);
        }
      }
    }
  }

  const focusedMessages = messages
    .filter((message) => shouldKeepMessage(message.role, message.content))
    .slice(-10);

  const gitRoot = workspacePath ? findGitRoot(workspacePath) : null;
  const repository = gitRoot
    ? basename(gitRoot)
    : workspacePath
      ? basename(workspacePath)
      : '';
  const commits = extractCommits(gitTextPool);
  const tags = extractTags(gitTextPool);
  const branch = extractBranch(gitTextPool);

  const hasGitWorkspace = Boolean(
    gitRoot || commits.length > 0 || tags.length > 0 || branch,
  );
  if (!hasGitWorkspace || !workspacePath) {
    return null;
  }

  if (!gitRoot) {
    warnings.push(
      'Workspace path is not a detected Git root; relying on rollout evidence only.',
    );
  }

  if (focusedMessages.length === 0) {
    focusedMessages.push({
      role: 'assistant',
      content: `Recovered Git-backed rollout for ${repository || workspacePath}.`,
    });
  }

  return {
    sessionId,
    threadId: sessionId,
    rolloutPath: file.path,
    startedAt,
    updatedAt,
    workspacePath: gitRoot ?? workspacePath,
    repository,
    branch,
    messages: focusedMessages,
    commands,
    warnings,
    git: {
      repository: repository || inferProjectName('', workspacePath),
      workspacePath: gitRoot ?? workspacePath,
      branch,
      commits,
      tags,
    },
  };
}

export function buildParsePayload(candidate: ThreadCandidate): ParsePayload {
  const blocks = candidate.messages
    .filter((message) => {
      if (message.role === 'tool') {
        return false;
      }

      return message.content.trim().length > 0;
    })
    .map(
      (message) =>
        `${message.role.toUpperCase()}:\n${sliceHeadTail(message.content, 900)}`,
    );

  const metadata = [
    `Repository: ${candidate.git.repository}`,
    `Workspace: ${candidate.git.workspacePath}`,
    `Branch: ${candidate.git.branch ?? 'unknown'}`,
    `Commits: ${candidate.git.commits.map((commit) => commit.sha).join(', ') || 'none'}`,
    `Tags: ${candidate.git.tags.join(', ') || 'none'}`,
  ].join('\n');

  const titleHint = buildFallbackTitle(
    candidate.messages,
    candidate.git.repository,
  );
  const content = sliceHeadTail(`${metadata}\n\n${blocks.join('\n\n')}`, 6000);
  const preview = sliceHeadTail(content, 1600);

  return {
    titleHint,
    preview,
    content,
  };
}

function fallbackTags(text: string, git: IssueGitEvidence): string[] {
  const inferred = [];
  if (/\bfix|bug|error|regression\b/i.test(text)) {
    inferred.push('bug');
  }
  if (/\bui|frontend|react|component|sheet|table\b/i.test(text)) {
    inferred.push('frontend');
  }
  if (/\bsync|sqlite|db|api|backend|hono\b/i.test(text)) {
    inferred.push('backend');
  }
  if (git.commits.length > 0) {
    inferred.push('has-commit');
  }
  if (git.tags.length > 0) {
    inferred.push('has-tag');
  }
  return normalizeTags(inferred);
}

function buildIssue(params: {
  project: ProjectSummary;
  candidate: ThreadCandidate;
  payloadPreview: string;
  kind: 'parent' | 'sub_issue';
  parentIssueId: string | null;
  parseMode: ParseMode;
  warnings: string[];
  title: string;
  summary: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: string | null;
  dueDate?: string | null;
  tags?: string[];
  subIssueCount: number;
  suffix: string;
}): ParsedIssue {
  const combinedText = `${params.title}\n${params.summary}`;
  const status = params.status ?? inferIssueStatus(combinedText);
  const priority = params.priority ?? inferIssuePriority(combinedText);
  const tags = normalizeTags(
    params.tags ?? fallbackTags(combinedText, params.candidate.git),
  );
  const unknownFields = [
    status === 'unknown',
    priority === 'unknown',
    !params.assignee,
    !params.dueDate,
  ].filter(Boolean).length;
  const confidence = scoreConfidence({
    parseMode: params.parseMode,
    gitSignals:
      Number(Boolean(params.candidate.git.branch)) +
      params.candidate.git.commits.length +
      params.candidate.git.tags.length,
    subIssueCount: params.subIssueCount,
    unknownFields,
    hasWarnings: params.warnings.length > 0,
  });
  const id = `${params.project.id}:${params.candidate.threadId}:${params.suffix}`;

  return {
    id,
    threadId: params.candidate.threadId,
    projectId: params.project.id,
    parentIssueId: params.parentIssueId,
    kind: params.kind,
    title: (() => {
      const cleanedTitle = cleanIssueTitle(params.title);
      const summaryTitle = titleFromSummary(params.summary);
      const previewTitle = cleanIssueTitle(
        params.payloadPreview.split('\n')[0] ?? '',
      );

      if (
        params.parseMode === 'ai' &&
        cleanedTitle &&
        looksLikeRequestTitle(params.title)
      ) {
        return summaryTitle || previewTitle || cleanedTitle;
      }

      return cleanedTitle || summaryTitle || previewTitle || 'Untitled issue';
    })(),
    status,
    priority,
    assignee: params.assignee ?? null,
    dueDate: params.dueDate ?? null,
    tags,
    summary:
      cleanIssueSummary(params.summary) ||
      cleanIssueSummary(params.payloadPreview) ||
      'No summary available.',
    updatedAt: params.candidate.updatedAt,
    parseMode: params.parseMode,
    confidence,
    needsReview: shouldNeedsReview({
      parseMode: params.parseMode,
      confidence,
      warnings: params.warnings,
      unknownFields,
    }),
    git: params.candidate.git,
    evidence: {
      rolloutPath: params.candidate.rolloutPath,
      sessionId: params.candidate.sessionId,
      threadId: params.candidate.threadId,
      warnings: params.warnings,
      parsePayloadPreview: params.payloadPreview,
    },
    subIssueCount: params.subIssueCount,
    children: [],
  };
}

async function parseWithAi(
  payload: ParsePayload,
  candidate: ThreadCandidate,
  options: {
    baseUrl: string;
    apiKey: string;
    model: string;
  },
): Promise<{
  result: AiParseResult;
  responseModel: string | null;
  tokenUsage: SyncTokenUsage;
}> {
  const requestBody = {
    model: options.model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You extract structured engineering issues from coding threads.

Your task:
- Read the thread carefully.
- Infer the main parent issue that best represents the overall piece of work.
- Infer zero or more sub-issues only when the thread clearly contains distinct actionable workstreams, deliverables, or milestones.
- Prefer accuracy and readability over exhaustiveness.

Output contract:
- Respond with valid JSON only.
- Top-level keys must be exactly: parent, subIssues, warnings.
- parent must be an object with:
  - title
  - summary
  - status
  - priority
  - assignee
  - dueDate
  - tags
- subIssues must be an array of objects with:
  - title
  - summary
  - status
  - priority
  - tags
- warnings must be an array of short strings.

Writing rules:
- Use natural, readable engineering language.
- Write titles in concise sentence case.
- Titles should read like issue tracker entries, not chat messages.
- Titles must describe the work the thread actually accomplished, fixed, implemented, or changed.
- Do not phrase titles as requests, commands, todo notes, or questions.
- Never output a title that ends with a question mark.
- Do not start titles with phrases like "I will", "we will", "implemented", "added", "fixed", or "working on".
- Do not copy raw bullets, metadata labels, shell output, or prompt text into titles.
- Summaries should be one or two short sentences.
- Summaries should explain the work, outcome, or scope in plain language.
- Do not dump repository metadata into summaries.
- Avoid repeating the title verbatim as the summary unless the thread is extremely sparse.

Interpretation rules:
- Focus on the actual work being requested, implemented, debugged, or reviewed.
- If the user asks a question but the thread answers it through investigation or code changes, title the answer or delivered change, not the question itself.
- If the thread mixes planning and implementation, prefer the concrete delivered or intended work over generic planning language.
- If there is clear evidence of a bug fix, title it like a bug fix.
- If there is clear evidence of a feature addition, title it like a feature or capability.
- If the thread is mostly infrastructure or refactoring work, title it accordingly.
- Only create sub-issues when the thread contains clearly separable chunks of work.
- Do not create sub-issues for trivial steps, logging chatter, or repeated rephrasings.

Status and priority:
- Choose the most plausible status from the thread content.
- Use "done" only when the thread strongly indicates the work was completed.
- Use "in_progress" when work is underway or described as being built.
- Use "todo" when the work is mostly requested or planned.
- Use "blocked" only when the thread clearly indicates a blocker.
- Use "unknown" when status is genuinely unclear.
- Infer priority conservatively from the thread wording.

Assignee and due date:
- Only set assignee or dueDate when explicitly stated or strongly implied.
- Otherwise return null.

Tags:
- Return a short list of concrete, useful tags.
- Prefer domain tags like backend, frontend, api, database, ui, bug, infra, sync.
- Avoid noisy or redundant tags.

Warnings:
- Add warnings when the thread is ambiguous, sparse, conflicting, or mixes multiple unrelated topics.
- Otherwise return an empty array.

Quality bar:
- Be specific.
- Be readable.
- Be deterministic.
- Preserve the likely intent of the thread.
- Do not invent facts that are not supported by the thread.`,
      },
      {
        role: 'user',
        content: `Thread metadata:\nrepository=${candidate.git.repository}\nbranch=${candidate.git.branch ?? 'unknown'}\ncommits=${candidate.git.commits.map((commit) => commit.sha).join(', ') || 'none'}\ntags=${candidate.git.tags.join(', ') || 'none'}\n\nThread content:\n${payload.content}`,
      },
    ],
  };

  console.log(
    `[parse:llm:request] url=${options.baseUrl.replace(/\/$/, '')}/chat/completions model=${options.model} thread=${candidate.threadId}`,
  );
  console.log(JSON.stringify(requestBody, null, 2));

  const response = await fetch(
    `${options.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    throw new Error(`AI parse failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('AI parse returned an empty response.');
  }

  return {
    result: JSON.parse(content) as AiParseResult,
    responseModel: json.model ?? null,
    tokenUsage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
  };
}

export async function buildIssuesFromCandidate(
  candidate: ThreadCandidate,
  options: {
    openAiBaseUrl: string | null;
    openAiApiKey: string | null;
    openAiModel: string | null;
  },
): Promise<{
  project: ProjectSummary;
  issues: ParsedIssue[];
  parseMode: ParseMode;
  aiDiagnostics: {
    requestCount: number;
    responseModel: string | null;
    tokenUsage: SyncTokenUsage;
  };
}> {
  const project: ProjectSummary = {
    id: inferProjectId(candidate.git.repository, candidate.git.workspacePath),
    name: inferProjectName(
      candidate.git.repository,
      candidate.git.workspacePath,
    ),
    repository: candidate.git.repository,
    workspacePath: candidate.git.workspacePath,
    issueCount: 0,
    subIssueCount: 0,
    needsReviewCount: 0,
    lastUpdatedAt: candidate.updatedAt,
  };
  const payload = buildParsePayload(candidate);
  const canUseAi = Boolean(
    options.openAiBaseUrl && options.openAiApiKey && options.openAiModel,
  );

  if (canUseAi) {
    try {
      const baseUrl = options.openAiBaseUrl;
      const apiKey = options.openAiApiKey;
      const model = options.openAiModel;
      if (!baseUrl || !apiKey || !model) {
        throw new Error('Missing AI parser configuration.');
      }

      const ai = await parseWithAi(payload, candidate, {
        baseUrl,
        apiKey,
        model,
      });

      const parent = buildIssue({
        project,
        candidate,
        payloadPreview: payload.preview,
        kind: 'parent',
        parentIssueId: null,
        parseMode: 'ai',
        warnings: [...candidate.warnings, ...(ai.result.warnings ?? [])],
        title: ai.result.parent.title || payload.titleHint,
        summary: ai.result.parent.summary || payload.preview,
        status: ai.result.parent.status,
        priority: ai.result.parent.priority,
        assignee: ai.result.parent.assignee,
        dueDate: ai.result.parent.dueDate,
        tags: ai.result.parent.tags,
        subIssueCount: ai.result.subIssues.length,
        suffix: 'parent',
      });

      const children = ai.result.subIssues.map((subIssue, index) =>
        buildIssue({
          project,
          candidate,
          payloadPreview: payload.preview,
          kind: 'sub_issue',
          parentIssueId: parent.id,
          parseMode: 'ai',
          warnings: [...candidate.warnings, ...(ai.result.warnings ?? [])],
          title: subIssue.title,
          summary: subIssue.summary,
          status: subIssue.status,
          priority: subIssue.priority,
          tags: subIssue.tags,
          subIssueCount: 0,
          suffix: `sub-${index + 1}`,
        }),
      );

      return {
        project,
        issues: [parent, ...children],
        parseMode: 'ai',
        aiDiagnostics: {
          requestCount: 1,
          responseModel: ai.responseModel,
          tokenUsage: ai.tokenUsage,
        },
      };
    } catch (error) {
      candidate.warnings.push(
        error instanceof Error ? error.message : 'AI parse failed.',
      );
    }
  }

  const parent = buildIssue({
    project,
    candidate,
    payloadPreview: payload.preview,
    kind: 'parent',
    parentIssueId: null,
    parseMode: 'fallback',
    warnings: candidate.warnings,
    title: payload.titleHint,
    summary: buildFallbackSummary(candidate, payload.titleHint),
    subIssueCount: 0,
    suffix: 'parent',
  });

  const bulletSubIssues = extractBulletItems(candidate.messages);

  const children = bulletSubIssues.map((title, index) =>
    buildIssue({
      project,
      candidate,
      payloadPreview: payload.preview,
      kind: 'sub_issue',
      parentIssueId: parent.id,
      parseMode: 'fallback',
      warnings: [
        ...candidate.warnings,
        'Sub-issue created from structured thread bullets.',
      ],
      title,
      summary: title,
      subIssueCount: 0,
      suffix: `sub-${index + 1}`,
    }),
  );

  parent.subIssueCount = children.length;

  return {
    project,
    issues: [parent, ...children],
    parseMode: 'fallback',
    aiDiagnostics: {
      requestCount: 0,
      responseModel: null,
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    },
  };
}
