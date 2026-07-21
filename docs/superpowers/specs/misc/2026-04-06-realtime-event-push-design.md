# Real-Time Event Push to Web UI

**Date:** 2026-04-06
**Issue:** LanternOps/breeze#367 — Version display lag after agent self-update
**Scope:** WebSocket-based real-time event delivery from API to web frontend, plus agent-side immediate heartbeat after self-update

## Problem

After an agent self-updates, the UI shows the old version for ~2 minutes. Two causes:

1. **Agent startup jitter**: New agent process waits 0-60s (random) before first heartbeat — thundering herd prevention
2. **No frontend push**: The web UI only fetches device data on page load. No mechanism pushes state changes to the browser.

## Design Decisions

- **Scope**: All org events (not just device status) — build the pipe once, every event type flows through it
- **Subscriptions**: Frontend subscribes to specific event types; server filters before sending
- **Transport**: WebSocket (bidirectional) — supports subscription changes as user navigates without reconnecting
- **State updates**: Hybrid — common fields (status, version) delivered in event payload for instant UI mutation; complex changes trigger REST re-fetch (invalidation)
- **Agent fix**: Marker file to skip jitter after self-update — ~20 lines of Go

## Architecture

```
Agent ──heartbeat──> API ──updateDB──> publishEvent('device.online', {deviceId, status, agentVersion})
                          │
                          v
                     EventBus.publish()
                          │
                     ┌────┴────┐
                     │ Redis   │
                     │ pub/sub │  channel: breeze:events:live:{orgId}
                     └────┬────┘
                          │
                     ┌────┴────────────────┐
                     │  EventDispatcher     │  singleton per API process
                     │  - 1 Redis sub/org   │
                     │  - filters by type   │
                     └────┬────────────────┘
                          │
                ┌─────────┼─────────┐
                v         v         v
            WS Client  WS Client  WS Client
            (dash)     (devices)  (alerts)
            device.*   device.*   alert.*
                       + alert.*
```

Three new components:

1. **EventDispatcher** — singleton service: subscribes to Redis pub/sub, fans out to registered WebSocket connections, filters by each client's subscribed event types
2. **eventWs.ts** — WebSocket route for web clients: ticket-based auth, subscribe/unsubscribe protocol
3. **useEventStream hook** — React hook: connect, manage subscriptions, reconnect with backoff

## Component Details

### 1. EventDispatcher Service

**File:** `apps/api/src/services/eventDispatcher.ts`

Singleton that manages Redis pub/sub subscriptions and fans out events to connected WebSocket clients.

**Data structures:**
```typescript
type ClientEntry = {
  ws: WSContext;
  userId: string;
  subscribedTypes: Set<string>;  // "device.*", "alert.triggered", "*"
};

// One Redis subscriber per org with connected clients
clients: Map<string, Set<ClientEntry>>           // orgId -> clients
redisSubscriptions: Map<string, RedisSubscriber>  // orgId -> subscriber
```

**Behavior:**
- First client for an org connects: subscribe to `breeze:events:live:{orgId}`
- Last client for an org disconnects: unsubscribe from that channel
- On incoming Redis message: iterate clients for that org, check subscribed types, send matches

**Glob matching for subscriptions:**
- `device.*` matches `device.online`, `device.offline`, etc. (single-level wildcard after prefix)
- `alert.*` matches all alert events
- `*` alone matches everything (discouraged — frontend should be specific)
- Exact matches like `device.online` also supported
- Implementation: if pattern ends with `.*`, check `eventType.startsWith(pattern.slice(0, -2))`. If pattern is `*`, always match. Otherwise, exact string equality. No regex, no multi-level globs.
- Invalid patterns (e.g., `*.online`, `device.**`) rejected with error message on subscribe.

**Backpressure:** If a WebSocket send buffer backs up, drop events for that client rather than blocking the dispatcher loop. Log a warning. Client catches up via REST on next interaction.

**Lifecycle:** Created at API startup (`index.ts`), destroyed on shutdown. Same pattern as `getEventBus()`.

### 2. WebSocket Route

**File:** `apps/api/src/routes/eventWs.ts`

**Endpoints:**
- `POST /api/v1/events/ws-ticket` — JWT-authenticated, returns a one-time ticket (Redis, TTL 30s)
- `GET /api/v1/events/ws?ticket=<ticket>` — WebSocket upgrade, ticket-based auth

**Auth flow** (same pattern as terminalWs/desktopWs):
1. Frontend calls `POST /api/v1/events/ws-ticket` via `fetchWithAuth`
2. API creates ticket in Redis with `{ userId, orgId }`, TTL 30s, returns ticket ID
3. Frontend opens WebSocket with `?ticket=xxx`
4. `onOpen` consumes ticket atomically (Lua GET+DEL), extracts userId/orgId
5. Registers client with EventDispatcher

**Client -> Server messages:**
```typescript
{ action: "subscribe", types: ["device.*", "alert.*"] }
{ action: "unsubscribe", types: ["device.*"] }
{ action: "ping" }
```

**Server -> Client messages:**
```typescript
{ type: "event", data: { type: "device.online", orgId, payload, metadata } }
{ type: "subscribed", types: ["device.*", "alert.*"] }
{ type: "pong" }
{ type: "error", message: "Invalid event type pattern" }
```

**Connection lifecycle:**
- Idle timeout: 5 minutes with no messages; client should ping every 60s
- `onClose` / `onError`: unregister from EventDispatcher

**Route mounting** in `index.ts`: alongside other WS routes, before auth middleware (ticket-based auth).

### 3. Event Publishing Gaps

Currently several state changes update the DB but don't publish events:

**In `agentWs.ts` — agent connects (~line 1356):**
```typescript
publishEvent('device.online', orgId, {
  deviceId, hostname, agentVersion, status: 'online'
}, 'agent-ws');
```

**In `agentWs.ts` — agent disconnects (~line 1732):**
```typescript
publishEvent('device.offline', orgId, {
  deviceId, hostname
}, 'agent-ws');
```
The offline detector already publishes `device.offline` on its 5-min timeout. The WS disconnect event gives instant offline detection. The offline detector becomes a fallback for unclean disconnects.

**In `agents/heartbeat.ts` — version change only:**
Compare incoming `agentVersion` to existing `device.agentVersion`. Only publish when different:
```typescript
publishEvent('device.updated', orgId, {
  deviceId, fields: ['agentVersion'], agentVersion: newVersion
}, 'heartbeat');
```
Avoids spamming on every heartbeat.

**No changes to existing events** — alert, policy, script, automation events already publish correctly.

### 4. Frontend — useEventStream Hook

**File:** `apps/web/src/hooks/useEventStream.ts`

```typescript
const { connected, subscribe, unsubscribe } = useEventStream({
  onEvent: (event) => { /* handle event */ },
  autoConnect: true,
});
```

**Connection lifecycle:**
1. On mount: `POST /api/v1/events/ws-ticket` via `fetchWithAuth` to get ticket
2. Open WebSocket to `/api/v1/events/ws?ticket=xxx`
3. On connect: send initial subscriptions
4. On close/error: reconnect with exponential backoff (1s, 2s, 4s, 8s, cap 30s)
5. On reconnect: fetch fresh ticket, re-send subscriptions
6. Ping every 60s

**`subscribe` / `unsubscribe`:** Update local subscription set and send to server. If not yet connected, queue until connection opens.

No global state store — low-level hook. Components decide how to handle events.

### 5. Frontend Integration Points

**`DevicesPage.tsx`:**
- Subscribe: `device.online`, `device.offline`, `device.updated`, `device.enrolled`, `device.decommissioned`
- `device.online` / `device.offline`: patch status + `lastSeenAt` in local state (direct mutation)
- `device.updated` with `agentVersion` field: patch version in local state (direct mutation)
- `device.enrolled` / `device.decommissioned`: re-fetch device list (invalidation)

**`DeviceDetailPage.tsx`:**
- Same subscriptions, filtered client-side to viewed device's ID
- Direct mutation for status/version, invalidation for complex changes

Future pages (alerts, scripts, etc.) subscribe to relevant event types — no backend changes needed.

### 6. Agent — Immediate Heartbeat After Self-Update

**Marker file approach:**

1. **Before restart** (`agent/internal/updater/updater.go`, in `UpdateTo()`): Write marker file `<config-dir>/.update-restart` containing the new version string
2. **On startup** (`agent/internal/heartbeat/heartbeat.go`, in `Start()`): Check for marker file. If present, delete it and skip jitter — send first heartbeat immediately
3. File location: same dir as agent config (`config.Dir()`), already 0700 permissions. Marker is transient — deleted on first read.

Why a file: restart goes through systemd/launchd which spawns a fresh process. Env vars would require modifying service units. Command-line flags would require modifying service definitions. A file persists across the process boundary cleanly.

## Scope Summary

| Component | File | Change | ~Lines |
|-----------|------|--------|--------|
| EventDispatcher | `apps/api/src/services/eventDispatcher.ts` | New singleton — Redis sub, fan-out, glob matching | 150 |
| Event WS route | `apps/api/src/routes/eventWs.ts` | New WS route + ticket endpoint | 200 |
| App bootstrap | `apps/api/src/index.ts` | Mount route, init dispatcher | 5 |
| Agent WS events | `apps/api/src/routes/agentWs.ts` | Publish device.online/offline on connect/disconnect | 10 |
| Heartbeat events | `apps/api/src/routes/agents/heartbeat.ts` | Publish device.updated on version change | 10 |
| Event stream hook | `apps/web/src/hooks/useEventStream.ts` | New React hook — connect, subscribe, reconnect | 120 |
| Devices page | `apps/web/src/components/devices/DevicesPage.tsx` | Wire up hook, handle events | 30 |
| Device detail | `apps/web/src/components/devices/DeviceDetailPage.tsx` | Wire up hook, handle events | 20 |
| Updater marker | `agent/internal/updater/updater.go` | Write marker file before restart | 10 |
| Heartbeat jitter | `agent/internal/heartbeat/heartbeat.go` | Check marker, skip jitter | 15 |

**Total:** ~570 lines across 10 files (3 new, 7 modified)
