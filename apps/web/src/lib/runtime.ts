const DEFAULT_API_BASE_URL = 'http://127.0.0.1:7788/api';

declare global {
  interface Window {
    __CODEX_BOARDS_API_BASE_URL__?: string;
    __TAURI_INTERNALS__?: unknown;
  }
}

function normalizeApiBaseUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : null;
}

async function readTauriApiBaseUrl(): Promise<string | null> {
  if (
    typeof window === 'undefined' ||
    window.__TAURI_INTERNALS__ === undefined
  ) {
    return null;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const value = await invoke<string>('get_api_base_url');
    return normalizeApiBaseUrl(value);
  } catch {
    return null;
  }
}

let apiBaseUrlPromise: Promise<string> | null = null;

export async function resolveApiBaseUrl(): Promise<string> {
  if (!apiBaseUrlPromise) {
    apiBaseUrlPromise = (async () => {
      const windowValue = normalizeApiBaseUrl(
        typeof window === 'undefined'
          ? null
          : window.__CODEX_BOARDS_API_BASE_URL__,
      );
      if (windowValue) {
        return windowValue;
      }

      const tauriValue = await readTauriApiBaseUrl();
      if (tauriValue) {
        return tauriValue;
      }

      const envValue = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
      return envValue ?? DEFAULT_API_BASE_URL;
    })();
  }

  return apiBaseUrlPromise;
}

export function resetApiBaseUrlCache(): void {
  apiBaseUrlPromise = null;
}
