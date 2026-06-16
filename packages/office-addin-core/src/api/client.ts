/**
 * Typed /client-ai API client. Every request carries the Breeze session token;
 * a 401 triggers ONE single-flight re-exchange (auth/session.ts) + retry.
 * Contracts: Contract reconciliation section of this plan (Plan 2 / Plan 4 pins).
 */
import { getApiBaseUrl } from '../config';
import { AuthBlockedError, clearSession, getSessionToken, reExchange } from '../auth/session';
import { parseSseStream } from './sse';
import {
  CLIENT_AI_SSE_EVENTS,
  type ClientAiStreamEvent,
  type ClientAiTemplate,
  type ClientHost,
  type CreateSessionBody,
  type SendMessageBody,
  type SessionCreated,
  type SessionHistory,
  type SessionListItem,
  type ToolResultBody,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`client-ai request failed: ${status} ${code}`);
    this.name = 'ApiError';
  }
}

type FetchLike = typeof fetch;

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const doFetch = async (): Promise<Response> => {
    const token = getSessionToken();
    if (!token) throw new ApiError(401, 'no_session');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    return fetchImpl(`${getApiBaseUrl()}${path}`, { ...init, headers });
  };
  let res = await doFetch();
  if (res.status === 401) {
    await reExchange(); // throws AuthBlockedError when access was revoked
    res = await doFetch();
    if (res.status === 401) {
      clearSession();
      throw new ApiError(401, 'unauthorized');
    }
  }
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function expectOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) {
    const code =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `http_${res.status}`;
    throw new ApiError(res.status, code);
  }
  return body;
}

/**
 * POST /client-ai/sessions { workbookName? } → 201 { sessionId, writeMode, writeApproval }.
 * writeApproval is default-denied client-side too: any value other than the
 * explicit 'allow_auto' collapses to 'ask', so a malformed/legacy response can
 * never enable the pane's auto-apply toggle.
 */
export async function createSession(
  body: CreateSessionBody = {},
  fetchImpl?: FetchLike,
): Promise<SessionCreated> {
  const res = (await expectOk(
    await apiFetch(
      '/client-ai/sessions',
      { method: 'POST', body: JSON.stringify(body) },
      fetchImpl,
    ),
  )) as Partial<SessionCreated> & { sessionId: string };
  return {
    sessionId: res.sessionId,
    writeMode: res.writeMode === 'readonly' ? 'readonly' : 'readwrite',
    writeApproval: res.writeApproval === 'allow_auto' ? 'allow_auto' : 'ask',
  };
}

/**
 * GET /client-ai/sessions → { sessions: [...] } — THIS user's history
 * (workbook-tagged). The host is forwarded as `?host=<host>` so a non-Excel pane
 * lists only its own host's sessions.
 */
export async function listSessions(
  host?: ClientHost,
  fetchImpl?: FetchLike,
): Promise<SessionListItem[]> {
  const path = host ? `/client-ai/sessions?host=${encodeURIComponent(host)}` : '/client-ai/sessions';
  const body = await expectOk(await apiFetch(path, {}, fetchImpl));
  if (body && typeof body === 'object' && Array.isArray((body as { sessions?: unknown }).sessions))
    return (body as { sessions: SessionListItem[] }).sessions;
  return [];
}

/** POST /client-ai/sessions/:id/messages → 202 { accepted: true }; the turn streams over GET /events. */
export async function sendMessage(
  sessionId: string,
  message: SendMessageBody,
  fetchImpl?: FetchLike,
): Promise<void> {
  await expectOk(
    await apiFetch(
      `/client-ai/sessions/${sessionId}/messages`,
      { method: 'POST', body: JSON.stringify(message) },
      fetchImpl,
    ),
  );
}

/** POST /client-ai/sessions/:id/tool-results — resolves a parked tool_request server-side. */
export async function postToolResult(
  sessionId: string,
  result: ToolResultBody,
  fetchImpl?: FetchLike,
): Promise<void> {
  await expectOk(
    await apiFetch(
      `/client-ai/sessions/${sessionId}/tool-results`,
      { method: 'POST', body: JSON.stringify(result) },
      fetchImpl,
    ),
  );
}

/** POST /client-ai/sessions/:id/flag — the end user flags their own conversation for review. */
export async function flagSession(
  sessionId: string,
  reason?: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const trimmed = reason?.trim();
  await expectOk(
    await apiFetch(
      `/client-ai/sessions/${sessionId}/flag`,
      { method: 'POST', body: JSON.stringify(trimmed ? { reason: trimmed } : {}) },
      fetchImpl,
    ),
  );
}

/**
 * GET /client-ai/templates → bare array (Plan 4 pin); {data:[...]} tolerated
 * defensively. `host` narrows the list to templates targeting this pane's host
 * (server-side filter); omit it to get every template for the org.
 */
export async function getTemplates(
  host?: ClientHost,
  fetchImpl?: FetchLike,
): Promise<ClientAiTemplate[]> {
  const path = host
    ? `/client-ai/templates?host=${encodeURIComponent(host)}`
    : '/client-ai/templates';
  const body = await expectOk(await apiFetch(path, {}, fetchImpl));
  if (Array.isArray(body)) return body as ClientAiTemplate[];
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data))
    return (body as { data: ClientAiTemplate[] }).data;
  return [];
}

/** GET /client-ai/sessions/:id → { session, messages } (already-redacted history). */
export async function getSession(sessionId: string, fetchImpl?: FetchLike): Promise<SessionHistory> {
  return (await expectOk(await apiFetch(`/client-ai/sessions/${sessionId}`, {}, fetchImpl))) as SessionHistory;
}

/** POST /client-ai/sessions/:id/close — best-effort teardown. */
export async function closeSession(sessionId: string, fetchImpl?: FetchLike): Promise<void> {
  await expectOk(
    await apiFetch(`/client-ai/sessions/${sessionId}/close`, { method: 'POST', body: '{}' }, fetchImpl),
  );
}

const KNOWN_EVENTS = new Set<string>(CLIENT_AI_SSE_EVENTS);

/** SSE frame → typed event. Unknown event names → null (additive server events are safe). */
export function decodeStreamFrame(frame: { event: string; data: string }): ClientAiStreamEvent | null {
  if (!KNOWN_EVENTS.has(frame.event)) return null;
  if (frame.event === 'ping') return { type: 'ping' };
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  return { type: frame.event, ...(payload as object) } as ClientAiStreamEvent;
}

export type StreamHandle = { stop: () => void };

export type StreamCallbacks = {
  onEvent: (event: ClientAiStreamEvent) => void;
  /**
   * Fires ONCE when the stream is confirmed open — i.e. the first server frame
   * has arrived, which means the server has registered this subscriber on the
   * session event bus. The server writes an immediate `ping` on subscribe for
   * exactly this purpose. Lets the caller defer the first message until the
   * subscription exists, so the first turn never streams before anyone listens.
   */
  onOpen?: () => void;
  /** Fires after a successful REconnect — re-GET history and reconcile (the gap may have streamed events). */
  onReconnect?: () => void | Promise<void>;
  /** Auth permanently lost (re-exchange failed / blocked) — stop and surface. */
  onPermanentError?: (err: unknown) => void;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * Persistent GET /events consumer. fetch + Authorization header (primary path;
 * the server's ?token= GET fallback is for EventSource clients only).
 * Reconnects forever with capped backoff until stop() — server pings (25s)
 * keep healthy connections alive, so a dropped read means real network loss.
 */
export function streamEvents(
  sessionId: string,
  callbacks: StreamCallbacks,
  fetchImpl: FetchLike = fetch,
  backoffMs: number[] = DEFAULT_BACKOFF_MS,
): StreamHandle {
  const controller = new AbortController();
  let attempt = 0;
  let connectedBefore = false;
  let openSignalled = false;

  const loop = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) return;
      try {
        const res = await apiFetch(
          `/client-ai/sessions/${sessionId}/events`,
          { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
          fetchImpl,
        );
        if (!res.ok || !res.body) throw new ApiError(res.status, `http_${res.status}`);
        if (connectedBefore) await callbacks.onReconnect?.();
        connectedBefore = true;
        for await (const frame of parseSseStream(res.body)) {
          // First frame on the first connection = subscriber is registered.
          if (!openSignalled) {
            openSignalled = true;
            callbacks.onOpen?.();
          }
          attempt = 0; // healthy traffic resets the backoff
          const event = decodeStreamFrame(frame);
          if (event) callbacks.onEvent(event);
        }
        // server closed the stream — fall through and reconnect
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof AuthBlockedError || (err instanceof ApiError && err.status === 401)) {
          callbacks.onPermanentError?.(err);
          return;
        }
        // transient (network drop, 5xx) — fall through to backoff
      }
      if (controller.signal.aborted) return;
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)]!;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };

  void loop();
  return { stop: () => controller.abort() };
}
