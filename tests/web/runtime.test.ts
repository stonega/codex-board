import { afterEach, describe, expect, test } from 'bun:test';

import {
  apiBaseUrlToWebSocketUrl,
  resetApiBaseUrlCache,
  resolveApiBaseUrl,
} from '../../apps/web/src/lib/runtime';

const originalWindow = globalThis.window;
const originalEnvValue = import.meta.env.VITE_API_BASE_URL;

afterEach(() => {
  resetApiBaseUrlCache();

  if (originalWindow === undefined) {
    (globalThis as typeof globalThis & { window?: Window }).window = undefined;
  } else {
    globalThis.window = originalWindow;
  }

  if (originalEnvValue === undefined) {
    import.meta.env.VITE_API_BASE_URL = undefined;
  } else {
    import.meta.env.VITE_API_BASE_URL = originalEnvValue;
  }
});

describe('web runtime config', () => {
  test('prefers a window-injected api base url', async () => {
    (
      globalThis as typeof globalThis & {
        window: Window & { __CODEX_BOARDS_API_BASE_URL__?: string };
      }
    ).window = {
      __CODEX_BOARDS_API_BASE_URL__: 'http://127.0.0.1:9999/api/',
    } as Window & { __CODEX_BOARDS_API_BASE_URL__?: string };

    await expect(resolveApiBaseUrl()).resolves.toBe(
      'http://127.0.0.1:9999/api',
    );
  });

  test('falls back to the vite env value when desktop config is absent', async () => {
    (globalThis as typeof globalThis & { window?: Window }).window = undefined;
    import.meta.env.VITE_API_BASE_URL = 'http://127.0.0.1:8788/api/';

    await expect(resolveApiBaseUrl()).resolves.toBe(
      'http://127.0.0.1:8788/api',
    );
  });

  test('builds sync status websocket urls from api base urls', () => {
    expect(
      apiBaseUrlToWebSocketUrl('http://127.0.0.1:7788/api/', '/sync/status'),
    ).toBe('ws://127.0.0.1:7788/api/sync/status');
    expect(
      apiBaseUrlToWebSocketUrl('https://boards.example/api', '/sync/status'),
    ).toBe('wss://boards.example/api/sync/status');
  });
});
