import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';

import { getServerUrl } from './serverConfig';
import { fetchWithTimeout } from './fetchWithTimeout';
import type { ApiError } from './api';
import { refreshAccessToken } from './api';
import { approvalModeFromUsage, type AiApprovalMode } from './aiApprovalMode';
import type { PlanStreamEvent } from '../screens/chat/planState';
import {
  parseChoicesResponse,
  type AiTurnModel,
  type ChoicesResult,
  type ModelChoice,
} from '../screens/chat/modelPicker';

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
  title?: string;
  /**
   * W05: a model picked before the first message creates the session ON that
   * model (the web's create contract: `offeringId` + `options`, flat).
   */
  model?: ModelChoice;
}

async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
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

/**
 * A non-2xx answer from the AI API, carrying the parsed body so callers can
 * classify it (a `continuation_required` 409, a refused model).
 */
export class AiHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'AiHttpError';
    this.status = status;
    this.body = body;
  }
}

/** The server's `error` string from a failure body, else `HTTP <status>`. */
function httpErrorMessage(status: number, body: unknown): string {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof error === 'string' ? error : `HTTP ${status}`;
}

/** A request that never got an answer (offline, timeout): status 0. */
function transportFailure(err: unknown): { ok: false; status: 0; error: string } {
  return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function createAiSession(input: CreateSessionPayload = {}): Promise<AiSessionSummary> {
  const { model, ...rest } = input;
  const res = await authedFetch('/ai/sessions', {
    method: 'POST',
    body: JSON.stringify({
      ...rest,
      ...(model ? { offeringId: model.offeringId, ...(model.options ? { options: model.options } : {}) } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiHttpError(`createAiSession failed: ${res.status} ${text}`.trim(), res.status, parseJsonText(text));
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
): Promise<{ session: AiSessionSummary; messages: ServerAiMessage[]; lastTurnModel?: unknown }> {
  const res = await authedFetch(`/ai/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`getAiSessionMessages failed: ${res.status}`);
  return res.json();
}

/**
 * Outcome of an action-plan call. Failures are returned, not thrown, so the
 * plan card can tell "no longer pending" (400/404/409) from "try again"
 * (anything else; status 0 = transport failure). See planState.ts.
 */
export type PlanCallResult = { ok: true } | { ok: false; status: number; error: string };

async function planCall(path: string, body?: unknown): Promise<PlanCallResult> {
  try {
    const res = await authedFetch(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => null);
    return { ok: false, status: res.status, error: httpErrorMessage(res.status, data) };
  } catch (err) {
    return transportFailure(err);
  }
}

/** Approve or reject the plan the session is blocked on (`plan_approval_required`). */
export function decideAiPlan(sessionId: string, approved: boolean): Promise<PlanCallResult> {
  return planCall(`/ai/sessions/${sessionId}/approve-plan`, { approved });
}

/** Stop an approved plan that is still running. */
export function abortAiPlan(sessionId: string): Promise<PlanCallResult> {
  return planCall(`/ai/sessions/${sessionId}/abort-plan`);
}

/**
 * The approval mode the server enforces for the caller's org, read from
 * `GET /ai/usage` (same `ai_sessions:use` gate as chat, same effective-budget
 * resolver as the approval gate). Null when there is no org budget to report.
 * `orgId` is the open chat's org: a partner-scope token has no org of its
 * own, so without it the server always answers `budget: null`.
 */
export async function getAiApprovalMode(orgId?: string | null): Promise<AiApprovalMode | null> {
  const res = await authedFetch(orgId ? `/ai/usage?orgId=${encodeURIComponent(orgId)}` : '/ai/usage');
  if (!res.ok) throw new Error(`getAiApprovalMode failed: ${res.status}`);
  return approvalModeFromUsage(await res.json());
}

/**
 * The chat composer's model menu (W05): `GET /ai/models/choices/chat`. With a
 * session it is that chat's menu plus its stamped choice; without one it is
 * the caller's org menu (a partner-scope token has no org of its own, so the
 * server answers 400 — the picker then appears once the first message has
 * created a session). Never both: the API refuses a sessionId with an orgId.
 * Failures are returned, not thrown: no menu just means the server default.
 */
export async function getChatModelChoices(key: { sessionId?: string | null }): Promise<ChoicesResult> {
  const qs = key.sessionId ? `?sessionId=${encodeURIComponent(key.sessionId)}` : '';
  try {
    const res = await authedFetch(`/ai/models/choices/chat${qs}`);
    const body = await res.json().catch(() => null);
    return parseChoicesResponse(res.status, body);
  } catch {
    return { ok: false, status: 0, code: null };
  }
}

/**
 * W05 (spec §9.2): a switch that cannot resume becomes a new chat seeded with
 * a summary of this one. `POST /ai/sessions/:id/continue` → the new session.
 */
export async function continueAiSession(
  sessionId: string,
  model: ModelChoice,
): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; error: string }> {
  try {
    const res = await authedFetch(`/ai/sessions/${encodeURIComponent(sessionId)}/continue`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
    const body = await res.json().catch(() => null);
    const newId = body?.data?.sessionId;
    if (res.ok && typeof newId === 'string') return { ok: true, sessionId: newId };
    return { ok: false, status: res.status, error: httpErrorMessage(res.status, body) };
  } catch (err) {
    return transportFailure(err);
  }
}

/**
 * A non-2xx answer to the message POST. Carries the parsed body so the chat
 * can tell a `continuation_required` 409 from a plain failure.
 */
export class StreamHttpError extends AiHttpError {
  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = 'StreamHttpError';
  }
}

// Subset of SSE event types the chat shell consumes. We tolerate unknown
// event types (warning, title_updated, ...) by surfacing them through
// the generic `unknown` callback if the caller wants them.
export type AiStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_use_start'; toolUseId: string; toolName: string; input?: unknown }
  // `handoff` is set only by the server's pre-tool-use gate (#5107) — it is the
  // authoritative "approved, executing under the approval worker" signal.
  // `output.status` carries the same value but the tool owns that payload, so
  // it is only a history-replay fallback. See toolIndicatorLogic.ts.
  | { type: 'tool_result'; toolUseId: string; output?: unknown; isError?: boolean; handoff?: string }
  // Full tool input, published once the block closes (`tool_use_start` carries `{}`).
  | { type: 'tool_use_input'; toolUseId: string; input?: unknown }
  | { type: 'message_end'; messageId?: string }
  | { type: 'approval_required'; executionId: string; toolName: string; description?: string; approvalRequestId?: string }
  | PlanStreamEvent
  // W05: what actually ran this turn, and the alternatives after a refusal.
  | { type: 'turn_model'; turnModel: AiTurnModel }
  | { type: 'model_refusal'; category: string | null; alternatives: Array<{ offeringId: string; displayName: string }>; docsUrl?: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'unknown'; raw: { event: string; data: unknown } };

export interface SseStreamHandle {
  abort: () => void;
}

export interface SseStreamOptions {
  sessionId: string;
  content: string;
  /** W05: the composer's pending model choice for THIS turn. */
  model?: ModelChoice;
  onEvent: (event: AiStreamEvent) => void;
  onError: (err: Error) => void;
  onDone: () => void;
}

const KNOWN_EVENT_TYPES = new Set([
  'message_start',
  'content_delta',
  'tool_use_start',
  'tool_result',
  'tool_use_input',
  'message_end',
  'approval_required',
  'plan_approval_required',
  'plan_step_start',
  'plan_step_complete',
  'plan_complete',
  'turn_model',
  'model_refusal',
  'error',
  'done',
]);

// Minimal SSE client built on XHR. RN's `fetch` streaming support is
// platform-spotty; XHR's incremental `responseText` reads are reliable
// across iOS/Android/Hermes. We track how many bytes we've already parsed
// so each `onreadystatechange` (state 3 = LOADING) only handles new data.
//
// Auth mirrors authedFetch (#3114/#3140): the stored access token expires
// after 15 minutes, so a stream opened with a stale token 401s before any
// SSE data flows. On a 401 at stream open we refresh once through the same
// single-flighted refreshAccessToken() and reopen the stream with the fresh
// token; a second 401 (or a failed refresh) surfaces to the caller.
export function streamChat(opts: SseStreamOptions): SseStreamHandle {
  let aborted = false;
  let didEmitDone = false;
  let currentXhr: XMLHttpRequest | null = null;

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

  const emitHttpError = (xhr: XMLHttpRequest) => {
    const body = parseJsonText(xhr.responseText);
    opts.onError(new StreamHttpError(httpErrorMessage(xhr.status, body), xhr.status, body));
  };

  // Opens one stream attempt. Parse state (cursor/buffered) is per-attempt so
  // a retried stream never inherits the 401 attempt's response bytes.
  const openStream = (url: string, token: string | null, canRetryAuth: boolean) => {
    let cursor = 0;
    let buffered = '';
    const xhr = new XMLHttpRequest();
    currentXhr = xhr;

    const flushBuffered = () => {
      let idx = buffered.indexOf('\n\n');
      while (idx !== -1) {
        const block = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 2);
        handleSseBlock(block);
        idx = buffered.indexOf('\n\n');
      }
    };

    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Accept', 'text/event-stream');
    xhr.setRequestHeader('x-breeze-csrf', '1');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.withCredentials = true;

    xhr.onreadystatechange = () => {
      if (aborted) return;
      // A 401 body is a JSON error, never SSE blocks — skip incremental
      // parsing on an attempt we may retry so nothing leaks to callbacks.
      const authRetryPending = xhr.status === 401 && canRetryAuth;
      if (
        !authRetryPending &&
        xhr.readyState >= 3 &&
        xhr.responseText &&
        xhr.responseText.length > cursor
      ) {
        buffered += xhr.responseText.slice(cursor);
        cursor = xhr.responseText.length;
        flushBuffered();
      }
      if (xhr.readyState === 4) {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (!didEmitDone) opts.onDone();
          return;
        }
        if (authRetryPending) {
          // Stale access token (>15 min since login with no interim REST
          // call). Refresh once via the shared single-flight helper and
          // reopen; on refresh failure surface the original 401. The whole
          // body is guarded: a throw from the retried open (or from the
          // refresh) must reach onError — an unhandled rejection here would
          // leave the chat UI streaming forever with no error surfaced.
          void (async () => {
            try {
              const newToken = await refreshAccessToken();
              if (aborted) return;
              if (newToken) {
                openStream(url, newToken, false);
                return;
              }
              emitHttpError(xhr);
            } catch (err) {
              if (aborted) return;
              opts.onError(err instanceof Error ? err : new Error(String(err)));
            }
          })();
          return;
        }
        emitHttpError(xhr);
      }
    };

    xhr.onerror = () => {
      if (aborted) return;
      opts.onError(new Error('Network error'));
    };

    xhr.send(JSON.stringify({ content: opts.content, ...(opts.model ? { model: opts.model } : {}) }));
  };

  (async () => {
    try {
      const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
      const token = await getToken();
      const url = `${baseUrl}${API_CORE_PREFIX}/ai/sessions/${opts.sessionId}/messages`;
      if (aborted) return;
      openStream(url, token, true);
    } catch (err) {
      if (aborted) return;
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    abort: () => {
      aborted = true;
      try { currentXhr?.abort(); } catch { /* noop */ }
    },
  };
}
