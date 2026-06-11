// Note: `expo-secure-store` and `serverConfig` are imported lazily inside
// `defaultFetchTicket` so the rest of this module is RN-free and can be
// unit-tested under Vitest's node environment without dragging in the
// React Native runtime.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const API_CORE_PREFIX = '/api/v1';
const TOKEN_KEY = 'breeze_auth_token';

// Subscribe to alert and incident events. The Systems tab cares primarily
// about alert lifecycle (triggered / acknowledged / resolved / suppressed /
// escalated) but incident events are cheap to receive and signal a state
// change worth refreshing for.
const SUBSCRIPTION_TYPES = ['alert.*', 'incident.*'] as const;

const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SystemsRealtimeEventType =
  | 'alert.triggered'
  | 'alert.acknowledged'
  | 'alert.resolved'
  | 'alert.suppressed'
  | 'alert.escalated'
  | 'incident.created'
  | 'incident.contained'
  | 'incident.escalated'
  | 'incident.closed'
  | (string & {}); // allow forward-compat unknown types

export interface SystemsRealtimeEvent {
  type: SystemsRealtimeEventType;
  orgId?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export type SystemsRealtimeListener = (event: SystemsRealtimeEvent) => void;

export interface SystemsRealtimeClient {
  /** Register a listener; returns an unsubscribe function. */
  subscribe: (listener: SystemsRealtimeListener) => () => void;
  /** Force-close the connection and stop reconnect attempts. */
  close: () => void;
  /** Visible for tests — current connection state. */
  readonly state: 'idle' | 'connecting' | 'open' | 'closed';
}

// ---------------------------------------------------------------------------
// Injection seams for tests
// ---------------------------------------------------------------------------

interface ClientDeps {
  /**
   * WebSocket constructor. Defaults to the global `WebSocket`. Tests inject
   * a fake constructor that records lifecycle calls.
   */
  WebSocketCtor?: typeof WebSocket;
  /**
   * Fetches a one-time WS ticket. Defaults to a real authedFetch round-trip;
   * tests inject a stub.
   */
  fetchTicket?: () => Promise<{ ticket: string; baseUrl: string } | null>;
  /** setTimeout/clearTimeout — overridable for fake timers. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Optional logger; defaults to console.warn for transient issues. */
  log?: (msg: string, err?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Default ticket fetcher (real auth path)
// ---------------------------------------------------------------------------

async function defaultFetchTicket(): Promise<{ ticket: string; baseUrl: string } | null> {
  // Lazy-import RN-only modules so this file is importable from a node test runner.
  const SecureStore = await import('expo-secure-store');
  const { getServerUrl } = await import('./serverConfig');

  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
  if (!token) return null;

  // Partner-scope users: ask the server to scope the ticket to all
  // accessible orgs in one connection. Org-scope users get a single-org
  // ticket either way (the server ignores allOrgs for them).
  const url = `${baseUrl}${API_CORE_PREFIX}/events/ws-ticket?allOrgs=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-breeze-csrf': '1',
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: { ticket?: string };
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body.ticket) return null;
  return { ticket: body.ticket, baseUrl };
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Convert https?:// → wss?://. Exposed for tests. */
export function toWsUrl(baseUrl: string, ticket: string): string {
  // Convert protocol; everything else (host, port, path) stays as-is.
  let scheme = 'ws';
  let rest = baseUrl;
  if (baseUrl.startsWith('https://')) {
    scheme = 'wss';
    rest = baseUrl.slice('https://'.length);
  } else if (baseUrl.startsWith('http://')) {
    scheme = 'ws';
    rest = baseUrl.slice('http://'.length);
  }
  // Strip trailing slash defensively.
  rest = rest.replace(/\/+$/, '');
  return `${scheme}://${rest}${API_CORE_PREFIX}/events/ws?ticket=${encodeURIComponent(ticket)}`;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a Systems realtime client. The client connects in the background,
 * reconnects with exponential backoff on close, and emits events to all
 * registered listeners. Designed to be additive — pull-to-refresh and the
 * push-notification listener stay authoritative.
 */
export function createSystemsRealtimeClient(deps: ClientDeps = {}): SystemsRealtimeClient {
  // If the caller passes the key explicitly (even as `undefined`) we honour
  // their choice — otherwise we fall back to the global. This lets tests
  // simulate a no-WebSocket environment by passing `WebSocketCtor: undefined`.
  const WSCtor = 'WebSocketCtor' in deps
    ? deps.WebSocketCtor
    : (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const fetchTicket = deps.fetchTicket ?? defaultFetchTicket;
  const log = deps.log ?? ((msg: string, err?: unknown) => {
    if (err !== undefined) console.warn(`[systemsRealtime] ${msg}`, err);
    else console.warn(`[systemsRealtime] ${msg}`);
  });

  if (!WSCtor) {
    // No WS impl available — return a no-op client.
    return {
      subscribe: () => () => {},
      close: () => {},
      get state() {
        return 'closed' as const;
      },
    };
  }

  const listeners = new Set<SystemsRealtimeListener>();
  let ws: WebSocket | null = null;
  let stopped = false;
  let retries = 0;
  let state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pongTimer) {
      clearTimeoutFn(pongTimer);
      pongTimer = null;
    }
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeoutFn(heartbeatTimer);
    heartbeatTimer = setTimeoutFn(() => {
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      try {
        ws.send(JSON.stringify({ action: 'ping' }));
      } catch (err) {
        log('failed to send ping', err);
        forceReconnect();
        return;
      }
      // Expect a pong within PONG_TIMEOUT_MS — otherwise treat the link
      // as dead and reconnect.
      if (pongTimer) clearTimeoutFn(pongTimer);
      pongTimer = setTimeoutFn(() => {
        log('pong timeout — reconnecting');
        forceReconnect();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  function backoffMs(): number {
    // Exponential backoff with cap, plus +/- 25% jitter so a fleet of
    // reconnecting clients doesn't synchronise.
    const exp = Math.min(MAX_RECONNECT_DELAY_MS, MIN_RECONNECT_DELAY_MS * 2 ** retries);
    const jitter = exp * (Math.random() * 0.5 - 0.25);
    return Math.max(MIN_RECONNECT_DELAY_MS, Math.floor(exp + jitter));
  }

  function emit(event: SystemsRealtimeEvent) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log('listener threw', err);
      }
    }
  }

  function handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'pong') {
      if (pongTimer) {
        clearTimeoutFn(pongTimer);
        pongTimer = null;
      }
      return;
    }

    if (msg.type === 'connected') {
      // Server accepted the ticket — subscribe to the event types we care
      // about. The dispatcher won't deliver anything until subscribedTypes
      // is non-empty.
      try {
        ws?.send(JSON.stringify({ action: 'subscribe', types: [...SUBSCRIPTION_TYPES] }));
      } catch (err) {
        log('failed to send subscribe', err);
      }
      return;
    }

    if (msg.type === 'event' && msg.data && typeof msg.data === 'object') {
      const data = msg.data as { type?: string; orgId?: string; payload?: Record<string, unknown>; metadata?: { timestamp?: string } };
      if (typeof data.type !== 'string') return;
      emit({
        type: data.type,
        orgId: data.orgId,
        payload: data.payload,
        timestamp: data.metadata?.timestamp,
      });
    }
  }

  function forceReconnect() {
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    // The onclose handler will schedule the actual reconnect.
  }

  async function connect() {
    if (stopped) return;
    if (state === 'connecting' || state === 'open') return;
    state = 'connecting';

    const ticketResult = await fetchTicket();
    if (stopped) return;
    if (!ticketResult) {
      // Auth/server not ready — back off and retry.
      retries += 1;
      const delay = backoffMs();
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
      state = 'idle';
      return;
    }

    const url = toWsUrl(ticketResult.baseUrl, ticketResult.ticket);
    // The early `if (!WSCtor)` guard above narrows for the no-op return,
    // but TS doesn't propagate that through this nested closure. Re-assert.
    const WSCtorChecked = WSCtor!;
    let socket: WebSocket;
    try {
      socket = new WSCtorChecked(url);
    } catch (err) {
      log('failed to construct WebSocket', err);
      retries += 1;
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        void connect();
      }, backoffMs());
      state = 'idle';
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (stopped) {
        try { socket.close(); } catch { /* ignore */ }
        return;
      }
      state = 'open';
      retries = 0;
      scheduleHeartbeat();
    };

    socket.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      handleMessage(data);
      // Any server message keeps the link alive — reset the heartbeat.
      scheduleHeartbeat();
    };

    socket.onerror = (err: any) => {
      log('socket error', err?.message ?? err);
    };

    socket.onclose = () => {
      ws = null;
      state = 'closed';
      if (heartbeatTimer) { clearTimeoutFn(heartbeatTimer); heartbeatTimer = null; }
      if (pongTimer) { clearTimeoutFn(pongTimer); pongTimer = null; }
      if (stopped) return;
      retries += 1;
      const delay = backoffMs();
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };
  }

  // Kick off the first connection attempt asynchronously so callers see
  // an idle state immediately after construction.
  void connect();

  return {
    subscribe(listener: SystemsRealtimeListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      stopped = true;
      clearTimers();
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      state = 'closed';
      listeners.clear();
    },
    get state() {
      return state;
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only export
// ---------------------------------------------------------------------------

/** @internal Exposed for tests. */
export const __testing = {
  HEARTBEAT_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  MIN_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  SUBSCRIPTION_TYPES,
};
