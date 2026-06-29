import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  confirmAndClearCodexBoardLocalData,
  createLocalUrl,
  getChildTerminationPid,
  getCodexBoardHelpText,
  getCodexBoardVersion,
  parseCodexBoardArgs,
  resolveOpenCommand,
  runCodexBoardCli,
  shouldDetachChildProcess,
} from '../../bin/codex-board.ts';

async function captureConsoleLog(
  callback: () => Promise<number>,
): Promise<{ exitCode: number; lines: string[] }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    const exitCode = await callback();
    return { exitCode, lines };
  } finally {
    console.log = originalLog;
  }
}

async function captureConsoleError(
  callback: () => Promise<number>,
): Promise<{ exitCode: number; lines: string[] }> {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  try {
    const exitCode = await callback();
    return { exitCode, lines };
  } finally {
    console.error = originalError;
  }
}

describe('codex-board cli', () => {
  test('uses local defaults', () => {
    expect(parseCodexBoardArgs([], {})).toEqual({
      backendPort: 7788,
      clearLocalData: false,
      host: '127.0.0.1',
      openBrowser: true,
      readyTimeoutMs: 30000,
      webPort: 5673,
    });
  });

  test('parses ports, host, timeout, and no-open flag', () => {
    expect(
      parseCodexBoardArgs([
        '--backend-port',
        '7799',
        '--web-port',
        '5174',
        '--host',
        '0.0.0.0',
        '--ready-timeout-ms',
        '5000',
        '--no-open',
        '--clear',
      ]),
    ).toEqual({
      backendPort: 7799,
      clearLocalData: true,
      host: '0.0.0.0',
      openBrowser: false,
      readyTimeoutMs: 5000,
      webPort: 5174,
    });
  });

  test('allows environment defaults', () => {
    expect(
      parseCodexBoardArgs([], {
        CODEX_BOARDS_BACKEND_PORT: '8788',
        CODEX_BOARDS_HOST: 'localhost',
        CODEX_BOARDS_READY_TIMEOUT_MS: '10000',
        CODEX_BOARDS_WEB_PORT: '5175',
      }),
    ).toEqual({
      backendPort: 8788,
      clearLocalData: false,
      host: 'localhost',
      openBrowser: true,
      readyTimeoutMs: 10000,
      webPort: 5175,
    });
  });

  test('parses help before environment validation', () => {
    expect(
      parseCodexBoardArgs(['--help'], {
        CODEX_BOARDS_WEB_PORT: 'not-a-port',
      }),
    ).toEqual({ help: true });
    expect(parseCodexBoardArgs(['-h'], {})).toEqual({ help: true });
  });

  test('parses version before environment validation', () => {
    expect(
      parseCodexBoardArgs(['--version'], {
        CODEX_BOARDS_BACKEND_PORT: 'not-a-port',
      }),
    ).toEqual({ version: true });
    expect(parseCodexBoardArgs(['-v'], {})).toEqual({ version: true });
    expect(parseCodexBoardArgs(['-V'], {})).toEqual({ version: true });
  });

  test('returns help text with supported global flags', () => {
    const helpText = getCodexBoardHelpText();

    expect(helpText).toContain('Usage:');
    expect(helpText).toContain('--clear');
    expect(helpText).toContain('--help, -h');
    expect(helpText).toContain('--version, -v, -V');
  });

  test('reads version from package metadata', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(getCodexBoardVersion()).toBe(packageJson.version);
  });

  test('prints help without starting servers', async () => {
    const result = await captureConsoleLog(() => runCodexBoardCli(['--help']));

    expect(result).toEqual({
      exitCode: 0,
      lines: [getCodexBoardHelpText()],
    });
  });

  test('prints version without starting servers', async () => {
    const result = await captureConsoleLog(() =>
      runCodexBoardCli(['--version']),
    );

    expect(result).toEqual({
      exitCode: 0,
      lines: [getCodexBoardVersion()],
    });
  });

  test('cancels clear without deleting local data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-board-clear-cancel-'));
    const databasePath = join(root, 'codex-boards.sqlite');
    writeFileSync(databasePath, 'database');

    try {
      const result = await confirmAndClearCodexBoardLocalData(
        databasePath,
        async (message) => {
          expect(message).toContain(databasePath);
          expect(message).toContain(
            'Codex session history will not be deleted',
          );
          return 'no';
        },
      );

      expect(result).toEqual({
        confirmed: false,
        deletedPaths: [],
      });
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('deletes sqlite local data after exact confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-board-clear-confirm-'));
    const databasePath = join(root, 'codex-boards.sqlite');
    const paths = [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ];
    const unrelatedPath = join(root, 'usage-pricing.json');

    for (const path of paths) {
      writeFileSync(path, 'database');
    }
    writeFileSync(unrelatedPath, 'pricing');

    try {
      const result = await confirmAndClearCodexBoardLocalData(
        databasePath,
        async () => ' clear ',
      );

      expect(result).toEqual({
        confirmed: true,
        deletedPaths: paths,
      });
      for (const path of paths) {
        expect(existsSync(path)).toBe(false);
      }
      expect(existsSync(unrelatedPath)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('aborts startup when clear is not confirmed', async () => {
    const result = await captureConsoleLog(() =>
      runCodexBoardCli(['--clear'], {
        confirmClearLocalData: async () => 'cancel',
      }),
    );

    expect(result).toEqual({
      exitCode: 1,
      lines: ['Clear cancelled.'],
    });
  });

  test('fails early with a clear message when the web port is in use', async () => {
    const blockedPort = 5699;
    const result = await captureConsoleError(() =>
      runCodexBoardCli(
        [
          '--no-open',
          '--web-port',
          String(blockedPort),
          '--backend-port',
          '8799',
        ],
        {
          isLocalPortListening: async (url) =>
            url === createLocalUrl('127.0.0.1', blockedPort),
        },
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain(
      `Web port ${blockedPort} is already in use`,
    );
    expect(result.lines[0]).toContain('--web-port <port>');
  });

  test('formats wildcard bind hosts as browser-safe local urls', () => {
    expect(createLocalUrl('0.0.0.0', 5673)).toBe('http://127.0.0.1:5673');
    expect(createLocalUrl('::', 5673, '/api')).toBe(
      'http://127.0.0.1:5673/api',
    );
  });

  test('resolves platform browser open commands', () => {
    expect(resolveOpenCommand('http://127.0.0.1:5673', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://127.0.0.1:5673'],
    });
    expect(resolveOpenCommand('http://127.0.0.1:5673', 'darwin')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:5673'],
    });
    expect(resolveOpenCommand('http://127.0.0.1:5673', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:5673'],
    });
  });

  test('targets child process groups when terminating POSIX web servers', () => {
    expect(shouldDetachChildProcess('linux')).toBe(true);
    expect(getChildTerminationPid(1234, 'linux')).toBe(-1234);
    expect(shouldDetachChildProcess('darwin')).toBe(true);
    expect(getChildTerminationPid(1234, 'darwin')).toBe(-1234);
    expect(shouldDetachChildProcess('win32')).toBe(false);
    expect(getChildTerminationPid(1234, 'win32')).toBe(1234);
    expect(getChildTerminationPid(undefined, 'linux')).toBeNull();
  });
});
