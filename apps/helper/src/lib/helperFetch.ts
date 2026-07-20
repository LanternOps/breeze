// Shared HTTP plumbing for talking to the Breeze API from the Helper.
// Extracted verbatim from chatStore.ts — no behavior change.

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface AgentConfig {
  api_url: string;
  token?: string;
  agent_id: string;
  has_mtls?: boolean;
  os_username?: string;
  helper_version?: string;
}

// ---------------------------------------------------------------------------
// Tauri bridge helpers
// ---------------------------------------------------------------------------

/** Cached reference to the Tauri invoke function, or null if not in Tauri. */
let _tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let _tauriInvokeResolved = false;

/**
 * Dynamically import Tauri invoke -- returns null in non-Tauri environments.
 */
export async function getTauriInvoke(): Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> {
  if (_tauriInvokeResolved) return _tauriInvoke;
  try {
    if (!window.__TAURI_INTERNALS__) {
      _tauriInvokeResolved = true;
      return null;
    }
    const mod = await import('@tauri-apps/api/core');
    _tauriInvoke = mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    _tauriInvokeResolved = true;
    return _tauriInvoke;
  } catch {
    _tauriInvokeResolved = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// helper_fetch response types (match Rust structs)
// ---------------------------------------------------------------------------

export interface HelperFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  stream_id: string | null;
}

export function requireDevBearerToken(config: AgentConfig): string {
  if (!config.token) {
    throw new Error('Browser dev mode requires VITE_AGENT_TOKEN');
  }
  return config.token;
}

// ---------------------------------------------------------------------------
// Unified HTTP helper that uses helper_fetch in Tauri, plain fetch otherwise
// ---------------------------------------------------------------------------

/**
 * Make a non-streaming HTTP request. In Tauri, uses the Rust backend
 * (which attaches the mTLS client cert). In browser dev mode, uses fetch().
 */
export async function helperRequest(
  config: AgentConfig,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const invoke = await getTauriInvoke();

  if (invoke) {
    const resp = (await invoke('helper_fetch', {
      request: {
        url,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        stream: false,
      },
    })) as HelperFetchResponse;

    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      body: resp.body,
    };
  }

  // Dev fallback: use native fetch
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${requireDevBearerToken(config)}`,
      ...(options.headers ?? {}),
    },
    body: options.body,
  });

  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
