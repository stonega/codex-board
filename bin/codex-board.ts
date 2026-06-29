#!/usr/bin/env bun

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_BACKEND_PORT = 7788;
const DEFAULT_HOST = '127.0.0.1';
const LOCAL_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_WEB_PORT = 5673;

export interface CodexBoardOptions {
  backendPort: number;
  clearLocalData: boolean;
  host: string;
  openBrowser: boolean;
  readyTimeoutMs: number;
  webPort: number;
}

export interface OpenCommand {
  command: string;
  args: string[];
}

export interface CodexBoardHelpCommand {
  help: true;
}

export interface CodexBoardVersionCommand {
  version: true;
}

interface LocalBackendRuntime {
  close(): void;
}

interface LocalBunServer {
  stop(closeActiveConnections?: boolean): void;
}

export type ConfirmClearLocalData = (message: string) => Promise<string>;

export interface RunCodexBoardCliOptions {
  confirmClearLocalData?: ConfirmClearLocalData;
}

export interface ClearLocalDataResult {
  confirmed: boolean;
  deletedPaths: string[];
}

const HELP_TEXT = `Usage:
  codex-board [options]

Starts the Codex Boards backend and web app locally, then opens the web UI.

Options:
  --no-open                  Start locally without opening a browser.
  --clear                    Clear local Codex Boards data after confirmation before startup.
  --backend-port <port>      Backend API port. Default: PORT, CODEX_BOARDS_BACKEND_PORT, or 7788.
  --web-port <port>          Web UI port. Default: CODEX_BOARDS_WEB_PORT or 5673.
  --host <host>              Local bind host. Default: CODEX_BOARDS_HOST or 127.0.0.1.
  --ready-timeout-ms <ms>    Startup wait timeout. Default: CODEX_BOARDS_READY_TIMEOUT_MS or 30000.
  --version, -v, -V          Show the CLI version.
  --help, -h                 Show this help text.
`;

export function getCodexBoardHelpText(): string {
  return HELP_TEXT;
}

export function getCodexBoardVersion(): string {
  const packageJsonPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'package.json',
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== 'string') {
    throw new Error('package.json must define a string version');
  }

  return packageJson.version;
}

function parsePort(value: string | undefined, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port from 1 to 65535`);
  }

  return port;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

export function parseCodexBoardArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): CodexBoardOptions | CodexBoardHelpCommand | CodexBoardVersionCommand {
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true };
  }

  if (
    args.includes('--version') ||
    args.includes('-v') ||
    args.includes('-V')
  ) {
    return { version: true };
  }

  const options: CodexBoardOptions = {
    backendPort: parsePort(
      env.CODEX_BOARDS_BACKEND_PORT ?? env.PORT ?? String(DEFAULT_BACKEND_PORT),
      'backend port',
    ),
    clearLocalData: false,
    host: env.CODEX_BOARDS_HOST ?? DEFAULT_HOST,
    openBrowser: true,
    readyTimeoutMs: parsePositiveInteger(
      env.CODEX_BOARDS_READY_TIMEOUT_MS ?? String(DEFAULT_READY_TIMEOUT_MS),
      'ready timeout',
    ),
    webPort: parsePort(
      env.CODEX_BOARDS_WEB_PORT ?? String(DEFAULT_WEB_PORT),
      'web port',
    ),
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--no-open') {
      options.openBrowser = false;
      continue;
    }

    if (token === '--clear') {
      options.clearLocalData = true;
      continue;
    }

    if (token === '--backend-port') {
      options.backendPort = parsePort(
        readFlagValue(args, index, token),
        'backend port',
      );
      index += 1;
      continue;
    }

    if (token === '--web-port') {
      options.webPort = parsePort(
        readFlagValue(args, index, token),
        'web port',
      );
      index += 1;
      continue;
    }

    if (token === '--host') {
      options.host = readFlagValue(args, index, token);
      index += 1;
      continue;
    }

    if (token === '--ready-timeout-ms') {
      options.readyTimeoutMs = parsePositiveInteger(
        readFlagValue(args, index, token),
        'ready timeout',
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  return options;
}

function browserHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') {
    return DEFAULT_HOST;
  }

  return host;
}

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }

  return host;
}

export function createLocalUrl(host: string, port: number, path = ''): string {
  return `http://${formatHostForUrl(browserHost(host))}:${port}${path}`;
}

export function resolveOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): OpenCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }

  return { command: 'xdg-open', args: [url] };
}

function createChildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== 'PORT' &&
      key !== 'CODEX_BOARDS_BACKEND_PORT'
    ) {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...overrides,
  };
}

function mergeNoProxy(value: string | undefined): string {
  const entries = new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  for (const host of LOCAL_NO_PROXY_HOSTS) {
    entries.add(host);
  }

  return Array.from(entries).join(',');
}

function ensureLocalNoProxy(): void {
  process.env.NO_PROXY = mergeNoProxy(process.env.NO_PROXY);
  process.env.no_proxy = mergeNoProxy(process.env.no_proxy);
}

async function openBrowser(url: string): Promise<void> {
  const { command, args } = resolveOpenCommand(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}

function probeTcp(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = connect(
      {
        host: target.hostname,
        port: Number(target.port),
      },
      () => {
        socket.end();
        resolve();
      },
    );

    socket.setTimeout(1000);
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy(new Error(`Timed out probing ${url}`));
    });
  });
}

async function waitForLocalPort(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  await delay(500);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await probeTcp(url);
      return;
    } catch {
      // Keep polling until the server is ready or the timeout is reached.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function createProcessExitPromise(
  name: string,
  child: ChildProcess,
): Promise<number> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }

      resolve(code ?? 0);
    });

    child.once('error', (error) => {
      console.error(`${name} failed to start:`, error);
      resolve(1);
    });
  });
}

function terminate(child: ChildProcess): void {
  if (!child.killed) {
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
        return;
      } catch {
        // Fall back to terminating the child process directly.
      }
    }

    child.kill('SIGTERM');
  }
}

export function getCodexBoardLocalDataPaths(databasePath: string): string[] {
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
}

export function clearCodexBoardLocalData(databasePath: string): string[] {
  const deletedPaths: string[] = [];

  for (const path of getCodexBoardLocalDataPaths(databasePath)) {
    if (!existsSync(path)) {
      continue;
    }

    rmSync(path, { force: true });
    deletedPaths.push(path);
  }

  return deletedPaths;
}

async function readClearLocalDataConfirmation(
  message: string,
): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await readline.question(message);
  } finally {
    readline.close();
  }
}

export async function confirmAndClearCodexBoardLocalData(
  databasePath: string,
  confirmClearLocalData: ConfirmClearLocalData = readClearLocalDataConfirmation,
): Promise<ClearLocalDataResult> {
  const answer = await confirmClearLocalData(
    `This will delete Codex Boards local data at ${databasePath}. Codex session history will not be deleted. Type "clear" to continue: `,
  );

  if (answer.trim().toLowerCase() !== 'clear') {
    return {
      confirmed: false,
      deletedPaths: [],
    };
  }

  return {
    confirmed: true,
    deletedPaths: clearCodexBoardLocalData(databasePath),
  };
}

export async function runCodexBoardCli(
  args: string[],
  options: RunCodexBoardCliOptions = {},
): Promise<number> {
  const parsed = parseCodexBoardArgs(args);
  if ('help' in parsed) {
    console.log(HELP_TEXT);
    return 0;
  }

  if ('version' in parsed) {
    console.log(getCodexBoardVersion());
    return 0;
  }

  ensureLocalNoProxy();

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const webRoot = resolve(root, 'apps/web');
  const webUrl = createLocalUrl(parsed.host, parsed.webPort);
  const backendUrl = createLocalUrl(
    parsed.host,
    parsed.backendPort,
    '/api/health',
  );
  const webEnv = createChildEnv({
    VITE_API_BASE_URL: createLocalUrl(parsed.host, parsed.backendPort, '/api'),
  });
  let backendRuntime: LocalBackendRuntime | null = null;
  let backendServer: LocalBunServer | null = null;
  let web: ChildProcess | null = null;

  let shuttingDown = false;
  const stopChildren = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (web) {
      terminate(web);
    }
    backendServer?.stop(true);
    backendRuntime?.close();
  };

  process.once('SIGINT', stopChildren);
  process.once('SIGTERM', stopChildren);
  process.once('exit', stopChildren);

  try {
    const [{ createAppServer, serveAppServer }, { getConfig }] =
      await Promise.all([
        import('../apps/backend/src/index.ts'),
        import('../apps/backend/src/config.ts'),
      ]);
    const config = getConfig();
    config.port = parsed.backendPort;

    if (parsed.clearLocalData) {
      const result = await confirmAndClearCodexBoardLocalData(
        config.databasePath,
        options.confirmClearLocalData,
      );

      if (!result.confirmed) {
        console.log('Clear cancelled.');
        return 1;
      }

      if (result.deletedPaths.length === 0) {
        console.log(
          `No Codex Boards local data found at ${config.databasePath}.`,
        );
      } else {
        console.log(
          `Cleared Codex Boards local data at ${config.databasePath}.`,
        );
      }
    }

    const runtime = createAppServer(config);
    backendRuntime = runtime;
    backendServer = serveAppServer(runtime);

    await waitForLocalPort(backendUrl, parsed.readyTimeoutMs);

    web = spawn(
      'bun',
      [
        'run',
        'dev',
        '--',
        '--host',
        parsed.host,
        '--port',
        String(parsed.webPort),
        '--strictPort',
      ],
      {
        cwd: webRoot,
        detached: process.platform !== 'win32',
        env: webEnv,
        stdio: 'inherit',
      },
    );

    const webExit = createProcessExitPromise('Web', web);

    await Promise.race([
      waitForLocalPort(webUrl, parsed.readyTimeoutMs),
      webExit.then((code) => {
        throw new Error(`Web server exited before startup completed (${code})`);
      }),
    ]);

    console.log(`Codex Boards is running at ${webUrl}`);

    if (parsed.openBrowser) {
      try {
        await openBrowser(webUrl);
      } catch (error) {
        console.warn(
          `Could not open the browser automatically: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const exitCode = await webExit;
    const wasShuttingDown = shuttingDown;
    stopChildren();
    return wasShuttingDown ? 0 : exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    stopChildren();
    return 1;
  } finally {
    process.removeListener('SIGINT', stopChildren);
    process.removeListener('SIGTERM', stopChildren);
    process.removeListener('exit', stopChildren);
  }
}

if (import.meta.main) {
  process.exitCode = await runCodexBoardCli(process.argv.slice(2));
}
