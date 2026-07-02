import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  type IssueCommitRef,
  type IssueGitEvidence,
  type ParseMode,
  type ParsedIssue,
  type ParserProvider,
  type ProjectSummary,
  type SyncTokenUsage,
  type ThreadImage,
  inferProjectId,
  inferProjectName,
  normalizeTags,
  scoreConfidence,
  shouldNeedsReview,
} from '../../../packages/domain/src/index';

export interface RolloutFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

const CODEX_CLI_SYNC_MARKER = 'CODEX_BOARDS_SYNC_PARSER_RUN_DO_NOT_IMPORT';

export interface ThreadMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

type ThreadImageCandidate = Omit<ThreadImage, 'id' | 'issueId'>;

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
  images: ThreadImageCandidate[];
  warnings: string[];
  git: IssueGitEvidence;
}

export interface ParsePayload {
  titleHint: string;
  preview: string;
  content: string;
}

interface AiParseResult {
  title: string;
  summary: string;
  tags?: string[];
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

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function estimateDataUrlBytes(value: string): number | null {
  const match = value.match(/^data:[^;]+;base64,([a-z0-9+/=\s]+)$/i);
  if (!match?.[1]) {
    return null;
  }

  const normalized = match[1].replace(/\s+/g, '');
  const padding = normalized.endsWith('==')
    ? 2
    : normalized.endsWith('=')
      ? 1
      : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function imageSourceType(value: string): ThreadImage['sourceType'] | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (
    /^remodex:\/\/history-image-elided/i.test(trimmed) ||
    /\bimage[-_\s]+elided\b/i.test(trimmed)
  ) {
    return 'elided';
  }

  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
    return 'inline_data';
  }

  if (
    /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#]\S*)?$/i.test(
      trimmed,
    )
  ) {
    return 'url';
  }

  if (/^https?:\/\/\S+$/i.test(trimmed) && /\bimage\b/i.test(trimmed)) {
    return 'url';
  }

  if (
    /^(?:file:\/\/)?(?:\/|~\/|\.{1,2}\/).+\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(
      trimmed,
    )
  ) {
    return 'file_path';
  }

  return null;
}

function mimeTypeFromImageSource(value: string): string | null {
  const dataUrl = value.match(/^data:([^;]+);base64,/i);
  if (dataUrl?.[1]) {
    return dataUrl[1].toLowerCase();
  }

  const extension = value
    .split(/[?#]/)[0]
    ?.match(/\.([a-z0-9]+)$/i)?.[1]
    ?.toLowerCase();

  if (!extension) {
    return null;
  }

  const mimeByExtension: Record<string, string> = {
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };

  return mimeByExtension[extension] ?? null;
}

function filenameFromImageSource(value: string): string | null {
  if (/^data:/i.test(value) || /^remodex:\/\//i.test(value)) {
    return null;
  }

  const cleaned = value
    .replace(/^file:\/\//i, '')
    .split(/[?#]/)[0]
    ?.trim();
  if (!cleaned) {
    return null;
  }

  const name = basename(cleaned);
  return name && name !== cleaned ? name : name || null;
}

function messageExcerpt(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 180);
}

function buildImageCandidate(params: {
  threadId: string;
  role: ThreadImage['role'];
  messageIndex: number;
  partIndex: number;
  source: string;
  caption?: string | null;
  excerpt?: string | null;
  createdAt?: string | null;
  width?: unknown;
  height?: unknown;
}): ThreadImageCandidate | null {
  const source = params.source.trim();
  const sourceType = imageSourceType(source);
  if (!sourceType) {
    return null;
  }

  const width = Number(params.width);
  const height = Number(params.height);

  return {
    threadId: params.threadId,
    role: params.role,
    messageIndex: params.messageIndex,
    partIndex: params.partIndex,
    sourceType,
    mimeType: mimeTypeFromImageSource(source),
    filename: filenameFromImageSource(source),
    originalUrl:
      sourceType === 'url' || sourceType === 'elided' ? source : null,
    localPath:
      sourceType === 'file_path' ? source.replace(/^file:\/\//i, '') : null,
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
    sizeBytes:
      sourceType === 'inline_data' ? estimateDataUrlBytes(source) : null,
    caption: params.caption?.trim() || null,
    messageExcerpt: messageExcerpt(params.excerpt ?? ''),
    createdAt: params.createdAt ?? null,
  };
}

function extractImageSourcesFromText(value: string): Array<{
  source: string;
  caption: string | null;
}> {
  const sources: Array<{ source: string; caption: string | null }> = [];

  for (const match of value.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    if (match[2]) {
      sources.push({
        source: match[2].trim(),
        caption: match[1]?.trim() || null,
      });
    }
  }

  for (const match of value.matchAll(
    /\b(?:https?:\/\/|file:\/\/|remodex:\/\/history-image-elided)\S+/gi,
  )) {
    sources.push({ source: match[0].trim(), caption: null });
  }

  for (const match of value.matchAll(
    /(?:^|\s)((?:\/|~\/|\.{1,2}\/)[^\s'"()<>]+\.(?:png|jpe?g|gif|webp|avif|bmp|svg))(?:\s|$)/gi,
  )) {
    if (match[1]) {
      sources.push({ source: match[1].trim(), caption: null });
    }
  }

  if (/\bimage[-_\s]+elided\b/i.test(value)) {
    sources.push({ source: 'remodex://history-image-elided', caption: null });
  }

  return sources;
}

function extractImagesFromText(params: {
  threadId: string;
  role: ThreadImage['role'];
  messageIndex: number;
  partIndexStart: number;
  text: string;
  createdAt?: string | null;
}): ThreadImageCandidate[] {
  return extractImageSourcesFromText(params.text).flatMap((entry, index) => {
    const image = buildImageCandidate({
      threadId: params.threadId,
      role: params.role,
      messageIndex: params.messageIndex,
      partIndex: params.partIndexStart + index,
      source: entry.source,
      caption: entry.caption,
      excerpt: params.text,
      createdAt: params.createdAt,
    });
    return image ? [image] : [];
  });
}

function readImageSourceFromPart(part: Record<string, unknown>): string | null {
  for (const key of [
    'image_url',
    'imageUrl',
    'url',
    'path',
    'file_path',
    'filePath',
    'data',
  ]) {
    const value = part[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  const imageUrl = part.image_url ?? part.imageUrl;
  if (imageUrl && typeof imageUrl === 'object') {
    const nested = imageUrl as { url?: unknown; path?: unknown };
    if (typeof nested.url === 'string' && nested.url.trim()) {
      return nested.url;
    }
    if (typeof nested.path === 'string' && nested.path.trim()) {
      return nested.path;
    }
  }

  return null;
}

function extractImagesFromPayload(params: {
  threadId: string;
  role: ThreadImage['role'];
  messageIndex: number;
  payload: unknown;
  createdAt?: string | null;
}): ThreadImageCandidate[] {
  if (!params.payload || typeof params.payload !== 'object') {
    return [];
  }

  const content = (params.payload as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const images: ThreadImageCandidate[] = [];

  content.forEach((part, partIndex) => {
    if (!part || typeof part !== 'object') {
      return;
    }

    const typedPart = part as Record<string, unknown>;
    const partType = String(typedPart.type ?? '');
    const source = readImageSourceFromPart(typedPart);

    if (source && /\bimage\b/i.test(partType)) {
      const image = buildImageCandidate({
        threadId: params.threadId,
        role: params.role,
        messageIndex: params.messageIndex,
        partIndex,
        source,
        caption:
          typeof typedPart.caption === 'string' ? typedPart.caption : null,
        excerpt: typeof typedPart.text === 'string' ? typedPart.text : source,
        createdAt: params.createdAt,
        width: typedPart.width,
        height: typedPart.height,
      });
      if (image) {
        images.push(image);
      }
    }

    if (typeof typedPart.text === 'string') {
      images.push(
        ...extractImagesFromText({
          threadId: params.threadId,
          role: params.role,
          messageIndex: params.messageIndex,
          partIndexStart: partIndex + 1000,
          text: typedPart.text,
          createdAt: params.createdAt,
        }),
      );
    }
  });

  return images;
}

function dedupeImages(images: ThreadImageCandidate[]): ThreadImageCandidate[] {
  const seen = new Set<string>();
  const output: ThreadImageCandidate[] = [];

  for (const image of images) {
    const key = [
      image.threadId,
      image.role,
      image.messageIndex,
      image.sourceType,
      image.originalUrl,
      image.localPath,
      image.filename,
      image.mimeType,
    ].join(':');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(image);
  }

  return output;
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
  const images: ThreadImageCandidate[] = [];
  const warnings: string[] = [];
  const gitTextPool: string[] = grepGitSignals(file.path);

  for (const line of lines) {
    if (line.includes(CODEX_CLI_SYNC_MARKER)) {
      return null;
    }

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
        const messageIndex = messages.length;
        images.push(
          ...extractImagesFromText({
            threadId: sessionId,
            role: 'user',
            messageIndex,
            partIndexStart: 0,
            text: String(parsed.payload.message),
            createdAt: parsed.timestamp ?? null,
          }),
        );
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
        const messageIndex = messages.length;
        images.push(
          ...extractImagesFromText({
            threadId: sessionId,
            role: 'assistant',
            messageIndex,
            partIndexStart: 0,
            text: String(parsed.payload.message),
            createdAt: parsed.timestamp ?? null,
          }),
        );
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
        images.push(
          ...extractImagesFromText({
            threadId: sessionId,
            role: 'tool',
            messageIndex: messages.length + commands.length,
            partIndexStart: 0,
            text: `${command}\n${output}`,
            createdAt: parsed.timestamp ?? null,
          }),
        );
      }
    }

    if (parsed.type === 'response_item') {
      if (parsed.payload?.type === 'message') {
        const role = parsed.payload?.role === 'user' ? 'user' : 'assistant';
        const messageIndex = messages.length;
        const payloadImages = extractImagesFromPayload({
          threadId: sessionId,
          role,
          messageIndex,
          payload: parsed.payload,
          createdAt: parsed.timestamp ?? null,
        });
        const text = sanitizeMessageContent(
          extractTextContent(parsed.payload).join('\n'),
        );
        if (payloadImages.length > 0) {
          images.push(...payloadImages);
        }
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

  if (
    messages.some((message) => message.content.includes(CODEX_CLI_SYNC_MARKER))
  ) {
    return null;
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
    images: dedupeImages(
      images.map((image) => ({
        ...image,
        threadId: sessionId,
      })),
    ),
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
    `Images: ${candidate.images.length}`,
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
  parseMode: ParseMode;
  warnings: string[];
  title: string;
  summary: string;
  tags?: string[];
}): ParsedIssue {
  const combinedText = `${params.title}\n${params.summary}`;
  const tags = normalizeTags(
    params.tags ?? fallbackTags(combinedText, params.candidate.git),
  );
  const confidence = scoreConfidence({
    parseMode: params.parseMode,
    gitSignals:
      Number(Boolean(params.candidate.git.branch)) +
      params.candidate.git.commits.length +
      params.candidate.git.tags.length,
    messageCount: params.candidate.messages.length,
    imageCount: params.candidate.images.length,
    hasWarnings: params.warnings.length > 0,
  });
  const id = `${params.project.id}:${params.candidate.threadId}`;
  const title = (() => {
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
  })();
  const images = params.candidate.images.map((image, index) => ({
    ...image,
    id: `${id}:image-${stableHash(
      [
        image.role,
        image.messageIndex,
        image.partIndex,
        image.sourceType,
        image.originalUrl,
        image.localPath,
        image.filename,
      ].join(':'),
    )}-${index + 1}`,
    issueId: id,
  }));

  return {
    id,
    threadId: params.candidate.threadId,
    projectId: params.project.id,
    title,
    tags,
    summary:
      cleanIssueSummary(params.summary) ||
      cleanIssueSummary(params.payloadPreview) ||
      'No summary available.',
    startedAt: params.candidate.startedAt,
    updatedAt: params.candidate.updatedAt,
    parseMode: params.parseMode,
    confidence,
    needsReview: shouldNeedsReview({
      parseMode: params.parseMode,
      confidence,
      warnings: params.warnings,
    }),
    git: params.candidate.git,
    evidence: {
      rolloutPath: params.candidate.rolloutPath,
      sessionId: params.candidate.sessionId,
      threadId: params.candidate.threadId,
      warnings: params.warnings,
      parsePayloadPreview: params.payloadPreview,
    },
    stats: {
      messageCount: params.candidate.messages.length,
      commandCount: params.candidate.commands.length,
      imageCount: images.length,
    },
    images,
  };
}

const AI_PARSE_SYSTEM_PROMPT = `You extract structured engineering issues from coding threads.

Your task:
- Read the thread carefully.
- Produce one issue that represents the whole thread.
- Do not split the thread into sub-issues.
- Prefer accuracy and readability over exhaustiveness.

Output contract:
- Respond with valid JSON only.
- Top-level keys must be exactly: title, summary, tags, warnings.
- title must be a concise string.
- summary must be one or two short sentences.
- tags must be an array of short strings.
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
- Do not invent facts that are not supported by the thread.`;

function buildAiParseUserPrompt(
  payload: ParsePayload,
  candidate: ThreadCandidate,
): string {
  return `Thread metadata:\nrepository=${candidate.git.repository}\nbranch=${candidate.git.branch ?? 'unknown'}\ncommits=${candidate.git.commits.map((commit) => commit.sha).join(', ') || 'none'}\ntags=${candidate.git.tags.join(', ') || 'none'}\nimages=${candidate.images.length}\n\nThread content:\n${payload.content}`;
}

function extractJsonObjectFromText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('AI parse returned an empty response.');
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Continue with tolerant extraction below.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fencedContent = fenced[1].trim();
    try {
      JSON.parse(fencedContent);
      return fencedContent;
    } catch {
      // Continue with balanced object extraction below.
    }
  }

  const start = trimmed.indexOf('{');
  if (start === -1) {
    throw new Error('AI parse did not return a JSON object.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < trimmed.length; index += 1) {
    const character = trimmed[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const json = trimmed.slice(start, index + 1);
        JSON.parse(json);
        return json;
      }
    }
  }

  throw new Error('AI parse did not return a complete JSON object.');
}

function parseAiResultContent(content: string): AiParseResult {
  return JSON.parse(extractJsonObjectFromText(content)) as AiParseResult;
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
        content: AI_PARSE_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: buildAiParseUserPrompt(payload, candidate),
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
    result: parseAiResultContent(content),
    responseModel: json.model ?? null,
    tokenUsage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
  };
}

async function parseWithCodexCli(
  payload: ParsePayload,
  candidate: ThreadCandidate,
  options: {
    model: string;
  },
): Promise<{
  result: AiParseResult;
  responseModel: string | null;
  tokenUsage: SyncTokenUsage;
}> {
  const outputRoot = mkdtempSync(join(tmpdir(), 'codex-boards-parser-'));
  const outputPath = join(outputRoot, 'last-message.txt');
  const prompt = `${AI_PARSE_SYSTEM_PROMPT}

Codex CLI execution rules:
- Internal marker: ${CODEX_CLI_SYNC_MARKER}.
- Use only the thread metadata and content below.
- Do not inspect files, run commands, or modify the workspace.
- Return the JSON object as the final answer only.
- Do not wrap the JSON in Markdown.

${buildAiParseUserPrompt(payload, candidate)}`;

  const codexCliBin = process.env.CODEX_BOARDS_CODEX_CLI_BIN ?? 'codex';
  console.log(
    `[parse:codex-cli:request] command=${codexCliBin} exec model=${options.model} thread=${candidate.threadId}`,
  );

  try {
    const attempt = spawnSync(
      codexCliBin,
      [
        'exec',
        '-m',
        options.model,
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        '--skip-git-repo-check',
        '--ephemeral',
        '--color',
        'never',
        '--output-last-message',
        outputPath,
        '-',
      ],
      {
        cwd: candidate.git.workspacePath || process.cwd(),
        encoding: 'utf8',
        env: process.env,
        input: prompt,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (attempt.error) {
      throw new Error(
        `Codex CLI parse failed to start: ${attempt.error.message}`,
      );
    }

    if (attempt.status !== 0) {
      const details = sliceHeadTail(
        [attempt.stderr, attempt.stdout].filter(Boolean).join('\n').trim(),
        800,
      );
      throw new Error(
        `Codex CLI parse failed with status ${attempt.status}${details ? `: ${details}` : ''}`,
      );
    }

    const content =
      existsSync(outputPath) && readFileSync(outputPath, 'utf8').trim()
        ? readFileSync(outputPath, 'utf8')
        : attempt.stdout;

    return {
      result: parseAiResultContent(content),
      responseModel: options.model,
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    };
  } finally {
    rmSync(outputRoot, { force: true, recursive: true });
  }
}

export async function buildIssuesFromCandidate(
  candidate: ThreadCandidate,
  options: {
    parserProvider?: ParserProvider;
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
    needsReviewCount: 0,
    lastUpdatedAt: candidate.updatedAt,
  };
  const payload = buildParsePayload(candidate);
  const parserProvider = options.parserProvider ?? 'openai-compatible';
  const canUseOpenAiCompatible = Boolean(
    parserProvider === 'openai-compatible' &&
      options.openAiBaseUrl &&
      options.openAiApiKey &&
      options.openAiModel,
  );
  const canUseCodexCli = Boolean(
    parserProvider === 'codex-cli' && options.openAiModel,
  );

  if (canUseOpenAiCompatible || canUseCodexCli) {
    try {
      const model = options.openAiModel;
      if (!model) {
        throw new Error('Missing AI parser configuration.');
      }

      const ai =
        parserProvider === 'codex-cli'
          ? await parseWithCodexCli(payload, candidate, { model })
          : await parseWithAi(payload, candidate, {
              baseUrl: options.openAiBaseUrl ?? '',
              apiKey: options.openAiApiKey ?? '',
              model,
            });

      const issue = buildIssue({
        project,
        candidate,
        payloadPreview: payload.preview,
        parseMode: 'ai',
        warnings: [...candidate.warnings, ...(ai.result.warnings ?? [])],
        title: ai.result.title || payload.titleHint,
        summary: ai.result.summary || payload.preview,
        tags: ai.result.tags,
      });

      return {
        project,
        issues: [issue],
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

  const issue = buildIssue({
    project,
    candidate,
    payloadPreview: payload.preview,
    parseMode: 'fallback',
    warnings: candidate.warnings,
    title: payload.titleHint,
    summary: buildFallbackSummary(candidate, payload.titleHint),
  });

  return {
    project,
    issues: [issue],
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
