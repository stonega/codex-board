import { describe, expect, test } from 'bun:test';

import {
  createLocalUrl,
  parseCodexBoardArgs,
  resolveOpenCommand,
} from '../../bin/codex-board.ts';

describe('codex-board cli', () => {
  test('uses local defaults', () => {
    expect(parseCodexBoardArgs([], {})).toEqual({
      backendPort: 7788,
      host: '127.0.0.1',
      openBrowser: true,
      readyTimeoutMs: 30000,
      webPort: 5173,
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
      ]),
    ).toEqual({
      backendPort: 7799,
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
      host: 'localhost',
      openBrowser: true,
      readyTimeoutMs: 10000,
      webPort: 5175,
    });
  });

  test('formats wildcard bind hosts as browser-safe local urls', () => {
    expect(createLocalUrl('0.0.0.0', 5173)).toBe('http://127.0.0.1:5173');
    expect(createLocalUrl('::', 5173, '/api')).toBe(
      'http://127.0.0.1:5173/api',
    );
  });

  test('resolves platform browser open commands', () => {
    expect(resolveOpenCommand('http://127.0.0.1:5173', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://127.0.0.1:5173'],
    });
    expect(resolveOpenCommand('http://127.0.0.1:5173', 'darwin')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:5173'],
    });
    expect(resolveOpenCommand('http://127.0.0.1:5173', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:5173'],
    });
  });
});
