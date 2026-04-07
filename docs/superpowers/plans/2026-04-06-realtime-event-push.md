# Real-Time Event Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver real-time events from the API to the web frontend via WebSocket, with immediate device online/offline/version updates and agent-side jitter bypass after self-update.

**Architecture:** A singleton EventDispatcher subscribes to Redis pub/sub per org and fans out filtered events to connected WebSocket clients. The frontend connects via one-time ticket auth and subscribes to event type patterns (e.g., `device.*`). The agent writes a marker file before self-update restart to skip startup jitter.

**Tech Stack:** Hono WebSocket (`@hono/node-ws`), Redis pub/sub (ioredis), React hooks, Go (marker file I/O)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/api/src/services/eventDispatcher.ts` | Create | Singleton: Redis sub per org, fan-out to WS clients, glob filtering |
| `apps/api/src/services/eventDispatcher.test.ts` | Create | Unit tests for dispatcher |
| `apps/api/src/routes/eventWs.ts` | Create | WS route + ticket endpoint |
| `apps/api/src/routes/eventWs.test.ts` | Create | Route tests |
| `apps/api/src/index.ts` | Modify | Mount event WS route, init dispatcher |
| `apps/api/src/routes/agentWs.ts` | Modify | Publish device.online/offline events |
| `apps/api/src/routes/agents/heartbeat.ts` | Modify | Publish device.updated on version change |
| `apps/web/src/hooks/useEventStream.ts` | Create | React hook: WS connect, subscribe, reconnect |
| `apps/web/src/components/devices/DevicesPage.tsx` | Modify | Wire up event stream for live device updates |
| `apps/web/src/components/devices/DeviceDetailPage.tsx` | Modify | Wire up event stream for live device detail |
| `agent/internal/updater/updater.go` | Modify | Write `.update-restart` marker before restart |
| `agent/internal/heartbeat/heartbeat.go` | Modify | Check marker, skip jitter if present |

---

### Task 1: EventDispatcher Service

**Files:**
- Create: `apps/api/src/services/eventDispatcher.ts`
- Create: `apps/api/src/services/eventDispatcher.test.ts`

- [ ] **Step 1: Write the failing test for event type matching**

Create `apps/api/src/services/eventDispatcher.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { matchesEventType } from './eventDispatcher';

describe('matchesEventType', () => {
  it('matches exact event type', () => {
    expect(matchesEventType('device.online', 'device.online')).toBe(true);
  });

  it('rejects non-matching exact type', () => {
    expect(matchesEventType('device.offline', 'device.online')).toBe(false);
  });

  it('matches wildcard prefix', () => {
    expect(matchesEventType('device.online', 'device.*')).toBe(true);
    expect(matchesEventType('device.offline', 'device.*')).toBe(true);
    expect(matchesEventType('device.updated', 'device.*')).toBe(true);
  });

  it('rejects wrong prefix with wildcard', () => {
    expect(matchesEventType('alert.triggered', 'device.*')).toBe(false);
  });

  it('matches global wildcard', () => {
    expect(matchesEventType('device.online', '*')).toBe(true);
    expect(matchesEventType('alert.triggered', '*')).toBe(true);
  });

  it('rejects invalid patterns', () => {
    expect(matchesEventType('device.online', '*.online')).toBe(false);
    expect(matchesEventType('device.online', 'device.**')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/eventDispatcher.test.ts`
Expected: FAIL — `matchesEventType` not found

- [ ] **Step 3: Implement matchesEventType and the EventDispatcher class**

Create `apps/api/src/services/eventDispatcher.ts`:

```typescript
import Redis from 'ioredis';
import type { WSContext } from 'hono/ws';
import { resolveRedisUrl } from './redis';

const STREAM_PREFIX = 'breeze:events';

/** Check if an event type matches a subscription pattern */
export function matchesEventType(eventType: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    // Reject malformed patterns like '**' or '*.foo'
    const prefix = pattern.slice(0, -2);
    if (!prefix || prefix.includes('*')) return false;
    return eventType.startsWith(prefix + '.');
  }
  // Reject patterns containing wildcards in wrong positions
  if (pattern.includes('*')) return false;
  return eventType === pattern;
}

export interface ClientEntry {
  ws: WSContext;
  userId: string;
  subscribedTypes: Set<string>;
}

class EventDispatcher {
  private clients = new Map<string, Set<ClientEntry>>(); // orgId -> clients
  private subscribers = new Map<string, Redis>();         // orgId -> Redis sub connection
  private stopped = false;

  register(orgId: string, client: ClientEntry): void {
    if (!this.clients.has(orgId)) {
      this.clients.set(orgId, new Set());
      this.subscribeToOrg(orgId);
    }
    this.clients.get(orgId)!.add(client);
  }

  unregister(orgId: string, client: ClientEntry): void {
    const orgClients = this.clients.get(orgId);
    if (!orgClients) return;
    orgClients.delete(client);
    if (orgClients.size === 0) {
      this.clients.delete(orgId);
      this.unsubscribeFromOrg(orgId);
    }
  }

  private subscribeToOrg(orgId: string): void {
    if (this.subscribers.has(orgId) || this.stopped) return;

    const url = resolveRedisUrl();
    const sub = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    sub.subscribe(`${STREAM_PREFIX}:live:${orgId}`, (err) => {
      if (err) {
        console.error(`[EventDispatcher] Failed to subscribe to org ${orgId}:`, err.message);
      }
    });

    sub.on('message', (_channel: string, message: string) => {
      this.dispatch(orgId, message);
    });

    sub.on('error', (err: Error) => {
      console.error(`[EventDispatcher] Redis subscriber error for org ${orgId}:`, err.message);
    });

    this.subscribers.set(orgId, sub);
  }

  private unsubscribeFromOrg(orgId: string): void {
    const sub = this.subscribers.get(orgId);
    if (!sub) return;
    sub.unsubscribe().catch(() => {});
    sub.quit().catch(() => {});
    this.subscribers.delete(orgId);
  }

  private dispatch(orgId: string, rawMessage: string): void {
    const orgClients = this.clients.get(orgId);
    if (!orgClients || orgClients.size === 0) return;

    let parsed: { type?: string };
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const eventType = parsed.type;
    if (!eventType) return;

    const outgoing = JSON.stringify({ type: 'event', data: parsed });

    for (const client of orgClients) {
      if (client.subscribedTypes.size === 0) continue;

      let matches = false;
      for (const pattern of client.subscribedTypes) {
        if (matchesEventType(eventType, pattern)) {
          matches = true;
          break;
        }
      }

      if (matches) {
        try {
          client.ws.send(outgoing);
        } catch {
          // Client send failed (backpressure). Skip this event for this client.
          console.warn(`[EventDispatcher] Failed to send event to client ${client.userId}, dropping`);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const [orgId] of this.subscribers) {
      this.unsubscribeFromOrg(orgId);
    }
    this.clients.clear();
  }
}

let instance: EventDispatcher | null = null;

export function getEventDispatcher(): EventDispatcher {
  if (!instance) {
    instance = new EventDispatcher();
  }
  return instance;
}

export async function shutdownEventDispatcher(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}
```

**Important prerequisite:** `resolveRedisUrl` is currently not exported from `redis.ts`. Export it by changing line 30 of `apps/api/src/services/redis.ts` from:
```typescript
function resolveRedisUrl(): string {
```
to:
```typescript
export function resolveRedisUrl(): string {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/eventDispatcher.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/eventDispatcher.ts apps/api/src/services/eventDispatcher.test.ts apps/api/src/services/redis.ts
git commit -m "feat: add EventDispatcher service for real-time event fan-out (#367)"
```

---

### Task 2: Event WebSocket Route

**Files:**
- Create: `apps/api/src/routes/eventWs.ts`
- Create: `apps/api/src/routes/eventWs.test.ts`

- [ ] **Step 1: Write the failing test for the ticket endpoint**

Create `apps/api/src/routes/eventWs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock dependencies before imports
vi.mock('../db', () => ({
  db: {},
  withDbAccessContext: vi.fn((_ctx, fn) => fn()),
}));

vi.mock('../db/schema', () => ({
  users: { id: 'id', status: 'status' },
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({
    setex: vi.fn().mockResolvedValue('OK'),
  })),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('userId', 'user-123');
    c.set('orgId', 'org-456');
    return next();
  }),
}));

import { createEventWsTicketRoute } from './eventWs';

describe('POST /events/ws-ticket', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/events', createEventWsTicketRoute());
  });

  it('returns a ticket for authenticated user', async () => {
    const res = await app.request('/events/ws-ticket', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket).toBeDefined();
    expect(typeof body.ticket).toBe('string');
    expect(body.expiresInSeconds).toBe(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/eventWs.test.ts`
Expected: FAIL — `createEventWsTicketRoute` not found

- [ ] **Step 3: Implement the event WebSocket route**

Create `apps/api/src/routes/eventWs.ts`:

```typescript
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { getRedis } from '../services/redis';
import { getEventDispatcher, matchesEventType, type ClientEntry } from '../services/eventDispatcher';

const TICKET_TTL_MS = 30_000;
const REDIS_KEY_PREFIX = 'events:ws_ticket:';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VALID_PATTERN = /^(\*|[a-z]+\.\*|[a-z]+\.[a-z_]+)$/;

// In-memory fallback for development (same pattern as remoteSessionAuth.ts)
const tickets = new Map<string, { userId: string; orgId: string; expiresAt: number }>();

function shouldUseRedis(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}

function isExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt;
}

/**
 * REST route for creating one-time WS tickets.
 * Mounted AFTER auth middleware so c.get('userId') is available.
 */
export function createEventWsTicketRoute(): Hono {
  const app = new Hono();

  app.post('/ws-ticket', async (c) => {
    const userId = c.get('userId') as string;
    const orgId = c.get('orgId') as string;

    if (!userId || !orgId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const ticket = randomBytes(32).toString('base64url');
    const record = { userId, orgId, expiresAt: Date.now() + TICKET_TTL_MS };
    const ttlSeconds = Math.floor(TICKET_TTL_MS / 1000);

    if (shouldUseRedis()) {
      const redis = getRedis();
      if (!redis) {
        return c.json({ error: 'Event stream unavailable' }, 503);
      }
      await redis.setex(`${REDIS_KEY_PREFIX}${ticket}`, ttlSeconds, JSON.stringify(record));
    } else {
      tickets.set(ticket, record);
    }

    return c.json({ ticket, expiresInSeconds: ttlSeconds });
  });

  return app;
}

async function consumeTicket(ticket: string): Promise<{ userId: string; orgId: string } | null> {
  if (shouldUseRedis()) {
    const redis = getRedis();
    if (!redis) return null;

    // Atomic GET+DEL via Redis Lua for one-time ticket semantics
    const lua = `
      local v = redis.call('GET', KEYS[1])
      if v then
        redis.call('DEL', KEYS[1])
      end
      return v
    `;

    const raw = await redis.eval(lua, 1, `${REDIS_KEY_PREFIX}${ticket}`);
    if (!raw || typeof raw !== 'string') return null;

    try {
      const record = JSON.parse(raw) as { userId: string; orgId: string; expiresAt: number };
      if (isExpired(record.expiresAt)) return null;
      return { userId: record.userId, orgId: record.orgId };
    } catch {
      return null;
    }
  }

  const record = tickets.get(ticket);
  if (!record) return null;
  tickets.delete(ticket);
  if (isExpired(record.expiresAt)) return null;
  return { userId: record.userId, orgId: record.orgId };
}

const clientMessageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('subscribe'), types: z.array(z.string().regex(VALID_PATTERN)) }),
  z.object({ action: z.literal('unsubscribe'), types: z.array(z.string().regex(VALID_PATTERN)) }),
  z.object({ action: z.literal('ping') }),
]);

/**
 * WebSocket route for real-time event streaming.
 * Mounted BEFORE auth middleware (uses one-time tickets).
 */
export function createEventWsRoutes(upgradeWebSocket: Function): Hono {
  const app = new Hono();

  app.get(
    '/ws',
    upgradeWebSocket((c: { req: { query: (key: string) => string | undefined } }) => {
      const ticket = c.req.query('ticket');

      let client: ClientEntry | null = null;
      let orgId: string | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      function resetIdleTimer(ws: WSContext) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            ws.send(JSON.stringify({ type: 'error', message: 'Idle timeout' }));
            ws.close(4000, 'Idle timeout');
          } catch { /* already closed */ }
        }, IDLE_TIMEOUT_MS);
      }

      function cleanup() {
        if (idleTimer) clearTimeout(idleTimer);
        if (client && orgId) {
          getEventDispatcher().unregister(orgId, client);
        }
      }

      return {
        onOpen: async (_event: unknown, ws: WSContext) => {
          if (!ticket) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing ticket' }));
            ws.close(4001, 'Missing ticket');
            return;
          }

          const auth = await consumeTicket(ticket);
          if (!auth) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired ticket' }));
            ws.close(4001, 'Invalid ticket');
            return;
          }

          orgId = auth.orgId;
          client = { ws, userId: auth.userId, subscribedTypes: new Set() };
          getEventDispatcher().register(orgId, client);

          ws.send(JSON.stringify({ type: 'connected', userId: auth.userId }));
          resetIdleTimer(ws);
        },

        onMessage: (event: { data: unknown }, ws: WSContext) => {
          if (!client) return;
          resetIdleTimer(ws);

          const raw = typeof event.data === 'string' ? event.data : '';
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
          }

          const result = clientMessageSchema.safeParse(parsed);
          if (!result.success) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
            return;
          }

          const msg = result.data;

          if (msg.action === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          if (msg.action === 'subscribe') {
            for (const t of msg.types) {
              client.subscribedTypes.add(t);
            }
            ws.send(JSON.stringify({ type: 'subscribed', types: Array.from(client.subscribedTypes) }));
            return;
          }

          if (msg.action === 'unsubscribe') {
            for (const t of msg.types) {
              client.subscribedTypes.delete(t);
            }
            ws.send(JSON.stringify({ type: 'subscribed', types: Array.from(client.subscribedTypes) }));
            return;
          }
        },

        onClose: () => {
          cleanup();
        },

        onError: () => {
          cleanup();
        },
      };
    })
  );

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/eventWs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/eventWs.ts apps/api/src/routes/eventWs.test.ts
git commit -m "feat: add event WebSocket route with ticket auth (#367)"
```

---

### Task 3: Mount Route and Init Dispatcher

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Add import for the new route**

In `apps/api/src/index.ts`, add these imports alongside the other route imports (find the block of import statements near the top):

```typescript
import { createEventWsRoutes, createEventWsTicketRoute } from './routes/eventWs';
import { shutdownEventDispatcher } from './services/eventDispatcher';
```

- [ ] **Step 2: Mount the WebSocket route before auth middleware**

In `apps/api/src/index.ts`, near line 657 where the other WS routes are mounted, add alongside them:

```typescript
api.route('/events', createEventWsRoutes(upgradeWebSocket)); // Event stream WebSocket (no auth middleware — uses one-time tickets)
```

Place it after the tunnel WS route at line 659 and before the auth-protected routes.

- [ ] **Step 3: Mount the ticket REST route after auth middleware**

In `apps/api/src/index.ts`, in the section where authenticated routes are mounted (after the auth middleware is applied), add:

```typescript
api.route('/events', createEventWsTicketRoute());
```

This must be AFTER the auth middleware so that `c.get('userId')` and `c.get('orgId')` are populated. Place it near the other non-resource routes.

- [ ] **Step 4: Add shutdown hook for the dispatcher**

Find the existing shutdown/cleanup logic in `index.ts` (search for `closeRedis` or process signal handlers) and add:

```typescript
await shutdownEventDispatcher();
```

- [ ] **Step 5: Verify the API starts without errors**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No new type errors (pre-existing ones are acceptable)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat: mount event WebSocket route and init dispatcher (#367)"
```

---

### Task 4: Publish Device Events in agentWs.ts

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts`

- [ ] **Step 1: Add publishEvent import**

In `apps/api/src/routes/agentWs.ts`, add to the imports at the top of the file (after line 25):

```typescript
import { publishEvent } from '../services/eventBus';
```

- [ ] **Step 2: Publish device.online when agent connects**

In `apps/api/src/routes/agentWs.ts`, in the `onOpen` handler, after the `runWithAgentDbAccess` block at lines 1350-1353:

```typescript
      const pendingCommands = await runWithAgentDbAccess(async () => {
        await updateDeviceStatus(agentId, 'online');
        return getPendingCommands(agentId);
      });
```

Add this block immediately after (before the `ws.send` welcome message at line 1356):

```typescript
      // Publish device.online event for real-time UI updates
      if (agentDb) {
        try {
          const [deviceInfo] = await runWithAgentDbAccess(async () =>
            db.select({ id: devices.id, hostname: devices.hostname, agentVersion: devices.agentVersion })
              .from(devices)
              .where(eq(devices.agentId, agentId))
              .limit(1)
          );
          if (deviceInfo) {
            publishEvent('device.online', agentDb.orgId, {
              deviceId: deviceInfo.id,
              hostname: deviceInfo.hostname,
              agentVersion: deviceInfo.agentVersion,
              status: 'online',
            }, 'agent-ws').catch(err => console.error('[AgentWs] Failed to publish device.online:', err));
          }
        } catch (err) {
          console.error('[AgentWs] Failed to query device for online event:', err);
        }
      }
```

- [ ] **Step 3: Publish device.offline when agent disconnects**

In `apps/api/src/routes/agentWs.ts`, in the `onClose` handler at line 1758, expand the select to include `id` and `hostname`. Change:

```typescript
                .select({ status: devices.status })
```
to:
```typescript
                .select({ id: devices.id, status: devices.status, hostname: devices.hostname })
```

Then after `await updateDeviceStatus(agentId, 'offline')` at line 1773, add:

```typescript
            publishEvent('device.offline', agentDb.orgId, {
              deviceId: current.id,
              hostname: current.hostname,
            }, 'agent-ws').catch(err => console.error('[AgentWs] Failed to publish device.offline:', err));
```

- [ ] **Step 4: Verify type check passes**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No new type errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agentWs.ts
git commit -m "feat: publish device.online/offline events on WS connect/disconnect (#367)"
```

---

### Task 5: Publish Version Change in Heartbeat

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts`

- [ ] **Step 1: Add publishEvent import**

In `apps/api/src/routes/agents/heartbeat.ts`, add to the imports at the top (after line 24):

```typescript
import { publishEvent } from '../../services/eventBus';
```

- [ ] **Step 2: Publish device.updated when version changes**

In `apps/api/src/routes/agents/heartbeat.ts`, after the DB update at lines 147-150:

```typescript
  await db
    .update(devices)
    .set(deviceUpdates)
    .where(eq(devices.id, device.id));
```

Add immediately after:

```typescript
  // Publish event when agent version changes (for real-time UI updates)
  if (data.agentVersion && data.agentVersion !== device.agentVersion) {
    publishEvent('device.updated', device.orgId, {
      deviceId: device.id,
      fields: ['agentVersion'],
      agentVersion: data.agentVersion,
    }, 'heartbeat').catch(err => console.error('[Heartbeat] Failed to publish device.updated:', err));
  }
```

This compares `data.agentVersion` (incoming from agent) with `device.agentVersion` (existing DB value from the select at lines 33-37). The `device` variable is the full row fetched before the update, so it has the old version.

- [ ] **Step 3: Verify type check passes**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No new type errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts
git commit -m "feat: publish device.updated event on agent version change (#367)"
```

---

### Task 6: Frontend useEventStream Hook

**Files:**
- Create: `apps/web/src/hooks/useEventStream.ts`

- [ ] **Step 1: Create the hook**

Create `apps/web/src/hooks/useEventStream.ts`:

```typescript
import { useEffect, useRef, useCallback, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

const PING_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

interface EventStreamEvent {
  type: string;
  orgId: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface EventStreamOptions {
  onEvent: (event: EventStreamEvent) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function useEventStream(options: EventStreamOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Array<{ action: string; types: string[] }>>([]);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    if (reconnectTimerRef.current) return; // already scheduled

    const delay = Math.min(1000 * Math.pow(2, retriesRef.current), MAX_BACKOFF_MS);
    retriesRef.current++;

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectWs();
    }, delay);
  }, []);

  const connectWs = useCallback(async () => {
    if (stoppedRef.current) return;

    try {
      const res = await fetchWithAuth('/events/ws-ticket', { method: 'POST' });
      if (!res.ok) {
        throw new Error(`Ticket request failed: ${res.status}`);
      }
      const { ticket } = await res.json();

      // Build WebSocket URL from current page location
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const apiHost = import.meta.env.PUBLIC_API_URL || '';
      let wsUrl: string;
      if (apiHost) {
        // Dev mode: PUBLIC_API_URL is set (e.g., http://localhost:3001)
        const parsed = new URL(apiHost);
        wsUrl = `${proto}//${parsed.host}/api/v1/events/ws?ticket=${ticket}`;
      } else {
        // Production: same host, behind reverse proxy
        wsUrl = `${proto}//${window.location.host}/api/v1/events/ws?ticket=${ticket}`;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retriesRef.current = 0;
        setConnected(true);
        optionsRef.current.onConnected?.();

        // Re-subscribe to previously subscribed types
        if (subscribedRef.current.size > 0) {
          send({ action: 'subscribe', types: Array.from(subscribedRef.current) });
        }

        // Flush pending subscription changes
        for (const msg of pendingRef.current) {
          send(msg);
        }
        pendingRef.current = [];

        // Start ping keepalive
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        pingTimerRef.current = setInterval(() => {
          send({ action: 'ping' });
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'event' && msg.data) {
            optionsRef.current.onEvent(msg.data);
          }
          // 'subscribed', 'pong', 'connected', 'error' — no action needed
        } catch {
          // Malformed message — ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        optionsRef.current.onDisconnected?.();
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire after onerror — reconnect handled there
      };
    } catch {
      scheduleReconnect();
    }
  }, [send, scheduleReconnect]);

  const subscribe = useCallback((types: string[]) => {
    for (const t of types) subscribedRef.current.add(t);
    const msg = { action: 'subscribe' as const, types };
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      send(msg);
    } else {
      pendingRef.current.push(msg);
    }
  }, [send]);

  const unsubscribe = useCallback((types: string[]) => {
    for (const t of types) subscribedRef.current.delete(t);
    const msg = { action: 'unsubscribe' as const, types };
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      send(msg);
    } else {
      pendingRef.current.push(msg);
    }
  }, [send]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    stoppedRef.current = false;
    connectWs();

    return () => {
      stoppedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connectWs]);

  return { connected, subscribe, unsubscribe };
}
```

- [ ] **Step 2: Verify the web project type-checks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No new type errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useEventStream.ts
git commit -m "feat: add useEventStream hook for real-time event WebSocket (#367)"
```

---

### Task 7: Wire Up DevicesPage

**Files:**
- Modify: `apps/web/src/components/devices/DevicesPage.tsx`

- [ ] **Step 1: Add the event stream hook import**

In `apps/web/src/components/devices/DevicesPage.tsx`, add the import alongside existing imports (after line 12):

```typescript
import { useEventStream } from '../../hooks/useEventStream';
```

- [ ] **Step 2: Add event handler inside the component**

Inside the `DevicesPage` component function, after the existing state hooks (after line 43, after `advancedFilter` state), add:

```typescript
  // Real-time device status updates
  const handleDeviceEvent = useCallback((event: { type: string; payload: Record<string, unknown> }) => {
    const { type, payload } = event;
    const deviceId = payload.deviceId as string;
    if (!deviceId) return;

    if (type === 'device.online' || type === 'device.offline') {
      setDevices(prev => prev.map(d =>
        d.id === deviceId
          ? { ...d, status: (payload.status as string ?? (type === 'device.online' ? 'online' : 'offline')) as DeviceStatus, lastSeen: new Date().toISOString() }
          : d
      ));
    } else if (type === 'device.updated') {
      const fields = payload.fields as string[] | undefined;
      if (fields?.includes('agentVersion')) {
        setDevices(prev => prev.map(d =>
          d.id === deviceId
            ? { ...d, agentVersion: (payload.agentVersion as string) ?? d.agentVersion }
            : d
        ));
      }
    } else if (type === 'device.enrolled' || type === 'device.decommissioned') {
      // Re-fetch the full list for structural changes
      fetchDevices();
    }
  }, [fetchDevices]);

  const { subscribe } = useEventStream({ onEvent: handleDeviceEvent });

  useEffect(() => {
    subscribe(['device.online', 'device.offline', 'device.updated', 'device.enrolled', 'device.decommissioned']);
  }, [subscribe]);
```

- [ ] **Step 3: Verify the web project type-checks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No new type errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/devices/DevicesPage.tsx
git commit -m "feat: wire DevicesPage to real-time event stream (#367)"
```

---

### Task 8: Wire Up DeviceDetailPage

**Files:**
- Modify: `apps/web/src/components/devices/DeviceDetailPage.tsx`

- [ ] **Step 1: Add the event stream hook import**

In `apps/web/src/components/devices/DeviceDetailPage.tsx`, add the import alongside existing imports:

```typescript
import { useEventStream } from '../../hooks/useEventStream';
```

- [ ] **Step 2: Add event handler inside the component**

Inside the `DeviceDetailPage` component function, after the existing state hooks (after line 23, after `scriptPickerOpen` state), add:

```typescript
  // Real-time device updates
  const handleDeviceEvent = useCallback((event: { type: string; payload: Record<string, unknown> }) => {
    const { type, payload } = event;
    const eventDeviceId = payload.deviceId as string;
    if (eventDeviceId !== deviceId) return;

    if (type === 'device.online' || type === 'device.offline') {
      setDevice(prev => prev ? {
        ...prev,
        status: (payload.status as string ?? (type === 'device.online' ? 'online' : 'offline')) as DeviceStatus,
        lastSeen: new Date().toISOString(),
        agentVersion: (payload.agentVersion as string) ?? prev.agentVersion,
      } : prev);
    } else if (type === 'device.updated') {
      const fields = payload.fields as string[] | undefined;
      if (fields?.includes('agentVersion')) {
        setDevice(prev => prev ? {
          ...prev,
          agentVersion: (payload.agentVersion as string) ?? prev.agentVersion,
        } : prev);
      }
    } else if (type === 'device.decommissioned') {
      // Re-fetch to get updated status
      fetchDevice();
    }
  }, [deviceId, fetchDevice]);

  const { subscribe } = useEventStream({ onEvent: handleDeviceEvent });

  useEffect(() => {
    subscribe(['device.online', 'device.offline', 'device.updated', 'device.decommissioned']);
  }, [subscribe]);
```

- [ ] **Step 3: Verify the web project type-checks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No new type errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/devices/DeviceDetailPage.tsx
git commit -m "feat: wire DeviceDetailPage to real-time event stream (#367)"
```

---

### Task 9: Agent — Write Update Marker File

**Files:**
- Modify: `agent/internal/updater/updater.go`

- [ ] **Step 1: Add imports and marker file writer**

In `agent/internal/updater/updater.go`, add `"path/filepath"` to the standard library imports (alongside `"os"`), and add `"github.com/breeze-rmm/agent/internal/config"` to the external imports block.

Then add this function after the `normalizePreflightErr` function (after line 67, before `UpdateTo`):

```go
// writeUpdateMarker creates a transient file that tells the new process
// to skip startup jitter and send an immediate heartbeat.
func writeUpdateMarker(version string) {
	markerPath := filepath.Join(config.ConfigDir(), ".update-restart")
	if err := os.WriteFile(markerPath, []byte(version), 0600); err != nil {
		log.Warn("failed to write update marker", "path", markerPath, "error", err.Error())
	}
}
```

- [ ] **Step 2: Call writeUpdateMarker before each restart path**

In `UpdateTo()`, there are three restart paths. Add the marker write before each:

**Path 1 — Windows helper (around line 109):** Before the `if err := RestartWithHelper(...)` call, add:
```go
		writeUpdateMarker(version)
```

**Path 2 — macOS pkg (around line 122):** Before `pkgErr := u.installViaPkg(version)`, add:
```go
		writeUpdateMarker(version)
```

**Path 3 — Linux binary replace (around line 144):** Before `if err := Restart(); err != nil {`, add:
```go
	writeUpdateMarker(version)
```

- [ ] **Step 3: Verify the agent builds**

Run: `cd agent && go build ./...`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add agent/internal/updater/updater.go
git commit -m "feat: write update marker file before agent restart (#367)"
```

---

### Task 10: Agent — Skip Jitter on Update Restart

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`

- [ ] **Step 1: Add a function to check and consume the update marker**

In `agent/internal/heartbeat/heartbeat.go`, add this function before the `Start()` method (before line 582):

```go
// checkUpdateMarker looks for the transient .update-restart file written
// by the updater before restart. If found, deletes it and returns true
// so the caller can skip the startup jitter and heartbeat immediately.
func checkUpdateMarker() bool {
	markerPath := filepath.Join(config.ConfigDir(), ".update-restart")
	_, err := os.Stat(markerPath)
	if err != nil {
		return false
	}
	// Marker exists — consume it (delete) and signal immediate heartbeat
	if removeErr := os.Remove(markerPath); removeErr != nil {
		log.Warn("failed to remove update marker", "path", markerPath, "error", removeErr.Error())
	}
	log.Info("update marker found, skipping startup jitter for immediate heartbeat")
	return true
}
```

Note: `config`, `filepath`, and `os` are already imported in this file (lines 6, 12, 27).

- [ ] **Step 2: Modify Start() to skip jitter when marker is present**

In `agent/internal/heartbeat/heartbeat.go`, replace the jitter block at lines 605-614:

```go
	// Jitter: random delay before first heartbeat to avoid thundering herd
	// after mass restart of agents
	interval := time.Duration(h.config.HeartbeatIntervalSeconds) * time.Second
	jitter := time.Duration(rand.Int64N(int64(interval)))
	log.Info("initial heartbeat jitter", "delay", jitter)
	select {
	case <-time.After(jitter):
	case <-h.stopChan:
		return
	}
```

With:

```go
	// Jitter: random delay before first heartbeat to avoid thundering herd
	// after mass restart of agents. Skip jitter if restarting after self-update
	// so the new version is reported immediately.
	interval := time.Duration(h.config.HeartbeatIntervalSeconds) * time.Second
	if checkUpdateMarker() {
		log.Info("post-update restart: sending immediate heartbeat (jitter skipped)")
	} else {
		jitter := time.Duration(rand.Int64N(int64(interval)))
		log.Info("initial heartbeat jitter", "delay", jitter)
		select {
		case <-time.After(jitter):
		case <-h.stopChan:
			return
		}
	}
```

- [ ] **Step 3: Verify the agent builds and tests pass**

Run: `cd agent && go build ./... && go test -race ./internal/heartbeat/... ./internal/updater/...`
Expected: Build succeeds, tests pass

- [ ] **Step 4: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go
git commit -m "feat: skip heartbeat jitter after self-update for instant version report (#367)"
```

---

### Task 11: End-to-End Verification

- [ ] **Step 1: Run all API tests**

Run: `cd apps/api && npx vitest run`
Expected: All existing tests pass, new tests pass

- [ ] **Step 2: Run all web type checks**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No new type errors

- [ ] **Step 3: Run Go agent tests**

Run: `cd agent && go test -race ./...`
Expected: All tests pass

- [ ] **Step 4: Start dev environment and manually verify**

Run: `pnpm dev`

Manual checks:
1. Open browser DevTools Network tab, verify `POST /api/v1/events/ws-ticket` returns a ticket
2. Verify WebSocket connection to `/api/v1/events/ws` establishes
3. Send subscribe message in console, verify `subscribed` response
4. Restart an agent — verify device status updates in UI without manual refresh

- [ ] **Step 5: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: address e2e verification feedback (#367)"
```
