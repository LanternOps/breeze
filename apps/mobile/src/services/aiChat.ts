import * as SecureStore from 'expo-secure-store';

import { getServerUrl } from './serverConfig';
import { fetchWithTimeout } from './fetchWithTimeout';
import { refreshToken } from './api';
import { storeToken } from './auth';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const API_CORE_PREFIX = '/api/v1';
const TOKEN_KEY = 'breeze_auth_token';

export interface AiSessionSummary {
  id: string;
  title: string | null;
  orgId: string;
  createdAt: string;
}

interface CreateSessionPayload {
  orgId?: string;
  title?: string;
}

async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

// Single-flight guard so N concurrent 401s trigger one /auth/refresh, not N.
// Cleared once the refresh settles; callers that grabbed the promise still
// receive its result.
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Refresh the access token via the shared `refreshToken()` helper (api.ts) and
 * persist it so every service reading `breeze_auth_token` picks it up.
 * Returns the new token, or null when refresh failed (e.g. the refresh cookie
 * itself expired) — callers then surface the original 401.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const { token } = await refreshToken();
        try {
          await storeToken(token);
        } catch {
          // Persisting failed (locked keychain, etc.) — the in-memory token is
          // still valid for the retry, and storeToken already reported the
          // failure. Don't turn a usable refresh into a hard failure.
        }
        return token;
      } catch {
        // Refresh itself failed — the session is genuinely over. Callers
        // return the original 401 so the UI's existing auth handling fires.
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

async function doAuthedFetch(
  path: string,
  init: RequestInit & { stream?: boolean },
  token: string | null,
): Promise<Response> {
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  const url = `${baseUrl}${API_CORE_PREFIX}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (init.method && init.method !== 'GET') headers['x-breeze-csrf'] = '1';
  if (init.stream) headers['Accept'] = 'text/event-stream';

  // Safe for SSE: fetchWithTimeout bounds only the wait for response
  // HEADERS and clears its timer once they arrive, so an open stream body is
  // never aborted mid-flight.
  return fetchWithTimeout(url, { ...init, headers, credentials: 'include' });
}

// Access tokens live 15 minutes (ACCESS_TOKEN_EXPIRY, apps/api/src/services/jwt.ts)
// and this wrapper reads whatever is in SecureStore, so any call made >15m
// after login starts with an expired bearer. On 401, refresh once via the same
// token lifecycle the rest of the mobile services use, then retry the request
// a single time (#3114). Bodies here are always JSON strings, so re-sending
// `init` unchanged is safe.
async function authedFetch(
  path: string,
  init: RequestInit & { stream?: boolean } = {},
): Promise<Response> {
  const res = await doAuthedFetch(path, init, await getToken());
  if (res.status !== 401) return res;

  const newToken = await refreshAccessToken();
  if (!newToken) return res;

  return doAuthedFetch(path, init, newToken);
}

export async function createAiSession(input: CreateSessionPayload = {}): Promise<AiSessionSummary> {
  const res = await authedFetch('/ai/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`createAiSession failed: ${res.status} ${body}`.trim());
  }
  const data: AiSessionSummary = await res.json();
  return data;
}

export interface AiSessionListItem {
  id: string;
  title: string | null;
  status: 'active' | 'closed' | 'expired';
  turnCount: number;
  lastActivityAt: string | null;
  createdAt: string;
}

export async function listAiSessions(limit = 20): Promise<AiSessionListItem[]> {
  const res = await authedFetch(`/ai/sessions?limit=${limit}&status=active`);
  if (!res.ok) throw new Error(`listAiSessions failed: ${res.status}`);
  const json: { data: AiSessionListItem[] } = await res.json();
  return json.data;
}

export interface ServerAiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content: string | null;
  toolName: string | null;
  toolUseId: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  createdAt: string;
}

export async function getAiSessionMessages(
  sessionId: string,
): Promise<{ session: AiSessionSummary; messages: ServerAiMessage[] }> {
  const res = await authedFetch(`/ai/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`getAiSessionMessages failed: ${res.status}`);
  return res.json();
}

// Subset of SSE event types the chat shell consumes. We tolerate unknown
// event types (plan_*, warning, title_updated) by surfacing them through
// the generic `unknown` callback if the caller wants them.
export type AiStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_use_start'; toolUseId: string; toolName: string; input?: unknown }
  | { type: 'tool_result'; toolUseId: string; output?: unknown; isError?: boolean }
  | { type: 'message_end'; messageId?: string }
  | { type: 'approval_required'; executionId: string; toolName: string; description?: string; approvalRequestId?: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'unknown'; raw: { event: string; data: unknown } };

export interface SseStreamHandle {
  abort: () => void;
}

export interface SseStreamOptions {
  sessionId: string;
  content: string;
  onEvent: (event: AiStreamEvent) => void;
  onError: (err: Error) => void;
  onDone: () => void;
}

const KNOWN_EVENT_TYPES = new Set([
  'message_start',
  'content_delta',
  'tool_use_start',
  'tool_result',
  'message_end',
  'approval_required',
  'error',
  'done',
]);

// Minimal SSE client built on XHR. RN's `fetch` streaming support is
// platform-spotty; XHR's incremental `responseText` reads are reliable
// across iOS/Android/Hermes. We track how many bytes we've already parsed
// so each `onreadystatechange` (state 3 = LOADING) only handles new data.
export function streamChat(opts: SseStreamOptions): SseStreamHandle {
  let aborted = false;
  let cursor = 0;
  let buffered = '';

  const xhr = new XMLHttpRequest();
  let didEmitDone = false;

  const flushBuffered = () => {
    let idx = buffered.indexOf('\n\n');
    while (idx !== -1) {
      const block = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 2);
      handleSseBlock(block);
      idx = buffered.indexOf('\n\n');
    }
  };

  const handleSseBlock = (block: string) => {
    if (!block.trim()) return;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // ignore malformed
    }
    if (KNOWN_EVENT_TYPES.has(event)) {
      opts.onEvent(parsed as AiStreamEvent);
      if (event === 'done') {
        didEmitDone = true;
        opts.onDone();
      }
    } else {
      opts.onEvent({ type: 'unknown', raw: { event, data: parsed } });
    }
  };

  (async () => {
    try {
      const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
      const token = await getToken();
      const url = `${baseUrl}${API_CORE_PREFIX}/ai/sessions/${opts.sessionId}/messages`;
      if (aborted) return;

      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Accept', 'text/event-stream');
      xhr.setRequestHeader('x-breeze-csrf', '1');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.withCredentials = true;

      xhr.onreadystatechange = () => {
        if (aborted) return;
        if (xhr.readyState >= 3 && xhr.responseText && xhr.responseText.length > cursor) {
          buffered += xhr.responseText.slice(cursor);
          cursor = xhr.responseText.length;
          flushBuffered();
        }
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300) {
            if (!didEmitDone) opts.onDone();
            return;
          }
          let msg = `HTTP ${xhr.status}`;
          try {
            const body = JSON.parse(xhr.responseText);
            if (body && typeof body.error === 'string') msg = body.error;
          } catch {
            // keep generic message
          }
          opts.onError(new Error(msg));
        }
      };

      xhr.onerror = () => {
        if (aborted) return;
        opts.onError(new Error('Network error'));
      };

      xhr.send(JSON.stringify({ content: opts.content }));
    } catch (err) {
      if (aborted) return;
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    abort: () => {
      aborted = true;
      try { xhr.abort(); } catch { /* noop */ }
    },
  };
}
