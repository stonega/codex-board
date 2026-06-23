import { afterEach, describe, expect, test } from 'bun:test';

import { getConfig } from '../../apps/backend/src/config';

const originalBackendPort = process.env.CODEX_BOARDS_BACKEND_PORT;
const originalPort = process.env.PORT;

function restoreEnv(
  name: 'CODEX_BOARDS_BACKEND_PORT' | 'PORT',
  value: string | undefined,
) {
  if (value === undefined) {
    process.env[name] = undefined;
    return;
  }

  process.env[name] = value;
}

afterEach(() => {
  restoreEnv('CODEX_BOARDS_BACKEND_PORT', originalBackendPort);
  restoreEnv('PORT', originalPort);
});

describe('backend config', () => {
  test('prefers CODEX_BOARDS_BACKEND_PORT over PORT', () => {
    process.env.CODEX_BOARDS_BACKEND_PORT = '7799';
    process.env.PORT = '7788';

    expect(getConfig().port).toBe(7799);
  });
});
