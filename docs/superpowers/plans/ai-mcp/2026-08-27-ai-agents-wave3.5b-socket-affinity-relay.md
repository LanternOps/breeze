---
tracking_issue: LanternOps/breeze#3821
wave: W08 (#4084)
---

# Wave 3.5b — Socket-Affinity Command Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent command dispatch that works from a process that does NOT hold the agent's WebSocket — unblocking the 3.5d `BREEZE_ROLE` split — via a fenced Redis presence registry, one api-role-consumed BullMQ relay queue, and a `dispatchCommandToAgent()` facade, with zero behavior change in today's all-in-one topology.

**Architecture:** The WS lifecycle maintains a token-fenced presence lease per agent in Redis (`agent-presence:<agentId>`, 90s TTL, refreshed on pong). Workers call a new facade: local socket → direct send (today's path, unchanged); no local socket → presence check → enqueue an **encrypted** relay job on `agent-command-relay`, consumed only by processes that own sockets (`BREEZE_ROLE !== 'worker'`). The consumer validates owner/expiry, takes an at-most-once send claim (Redis CAS), performs the local send (which keeps `orphanedResultExpectations` on the socket-owning process), and writes a typed ack the producer polls for. Result routing needs no work: `command_result` → DB writes → `waitForCommandResult` DB polling is already cross-process-safe.

**Tech Stack:** Hono/TypeScript, BullMQ (`createInstrumentedQueue`), ioredis Lua CAS (`redis.eval`), `secretCrypto` AAD-bound envelopes, Vitest (unit + real-PG/Redis integration). **No new DB migrations** — presence, claims, and acks live in Redis; commands already persist in `device_commands`.

**Design authority:** Issue #4084 + advisor quorum 2026-08-27 (Claude position "2-lite", codex `xhigh` independent review; both picked the same shape; codex hardenings adopted = "2-lite+"): (1) typed delivery outcomes — enqueue success is NOT "sent"; (2) relay job payloads are sealed with an AAD-bound envelope, never plaintext (SNMP/discovery/backup commands carry decrypted credentials); (3) at-most-once send claims — a BullMQ stalled-job redelivery must not double-send; (4) presence is an admission hint only, the consumer's local socket map is authoritative; (5) ship UNFLAGGED — in `BREEZE_ROLE=all` the relay path is unreachable for online agents, topology is the rollout control, rollback is `BREEZE_ROLE=all` (never a mode that silently reports agents offline). **Do not relitigate:** no worker pinning (defeats 3.5d); no per-instance queue sharding or multi-replica API support (follow-up — compose runs exactly one api container); no cross-process `agentCommandAwait` (its callers never leave the api role); no durable orphaned-result expectations (single API replica keeps them correct).

## Global Constraints

- **No new migrations in this wave.** If you believe you need one, stop — the design keeps all new state in Redis. (For reference, newest committed migration is `2026-09-11-g-drop-event-bus-events.sql`; a new one would need to sort after it.)
- Every Redis/BullMQ enqueue from a code path that may hold a DB context runs via `runOutsideDbContext` (#1105). Use `createInstrumentedQueue` (`apps/api/src/services/bullmqQueue.ts:41`), never bare `new Queue`. The facade does Redis I/O — callers must invoke it outside held DB contexts (snmpWorker's phase-split comment at `snmpWorker.ts:400-407` is the pattern).
- BullMQ jobIds are hyphen-only — a `:` in a custom jobId is rejected (`apps/api/src/jobs/aiAgentRunner.ts:54`). Relay jobIds are `relay-<uuid>`.
- Never call blocking Redis commands on the shared connection (#3299). This plan uses NO blocking commands — ack waiting is a `GET` poll loop; do not "improve" it to BRPOP/`QueueEvents`/`waitUntilFinished` (no repo precedent; `QueueEvents` grep = zero hits).
- New env vars land in `apps/api/src/config/env.ts` + `apps/api/src/config/validate.ts` + `.env.example` + `docker-compose.yml` api `environment:` + `deploy/docker-compose.prod.yml` in the SAME task (`envComposeParity.test.ts` enforces). This wave adds exactly one: `BREEZE_ROLE` (default `all`).
- New integration test files MUST be added to the explicit `include` list in `apps/api/vitest.integration.config.ts` (~line 11) — a misplaced file is collected by ZERO CI jobs and reads green.
- Run single test files as `cd apps/api && npx vitest run <path>` (never `pnpm --filter ... test -- --run <path>`). Integration: `npx vitest run --config vitest.integration.config.ts <path>` with real PG+Redis (`docker compose -f docker-compose.test.yml up`).
- The agent wire frame is exactly `{id, type, payload}` (`agentWs.ts:3067` comment; `toAgentCommandFrame`, `sensitiveCommandPayload.ts:184`) — the relay must deliver byte-identical frames to what a local send would produce.
- Stable names (never rename once shipped): queue `agent-command-relay`; Redis key prefixes `agent-presence:`, `agent-relay-claim:`, `agent-relay-ack:`.
- Commit after every task (checkpoint commits; context loss must be cheap).

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/instanceIdentity.ts` (new) | Leaf module: per-boot `INSTANCE_ID`. No imports. |
| `apps/api/src/services/agentPresence.ts` (new) | Token-fenced presence leases: set / Lua compare-refresh / Lua compare-delete / read. |
| `apps/api/src/services/agentCommandRelay.ts` (new) | `DispatchOutcome`, sealed envelope (seal/open), send-claim CAS, ack write/poll, relay queue singleton, `dispatchCommandToAgent()` + `isAgentConnectedAnywhere()` facade. |
| `apps/api/src/jobs/agentCommandRelayWorker.ts` (new) | Api-role relay consumer: expiry/owner validation → claim → local send → ack. |
| `apps/api/src/routes/agentWs.ts` (modify) | Presence lifecycle wiring (onOpen/pong/onClose/onError/evict); worker-role runtime assertion on socket-local exports; test-only socket installer. |
| `apps/api/src/services/agentCommandAwait.ts` (modify) | Worker-role runtime assertion + api-role-affinity doc comment. |
| `apps/api/src/config/env.ts` / `validate.ts` (modify) | `breezeRole(): 'all'\|'api'\|'worker'`. |
| `apps/api/src/index.ts` (modify) | Register relay worker gated on `breezeRole() !== 'worker'`. |
| 4 × `apps/api/src/jobs/{monitor,snmp,backup,discovery}Worker.ts` (modify) | Migrate to the facade; type-only `AgentCommand` imports. |
| `apps/api/src/jobs/agentDispatchBoundary.contract.test.ts` (new) | Static contract: `jobs/**` may not value-import socket-local dispatch. |
| `apps/api/src/__tests__/integration/agentCommandRelay.integration.test.ts` (new) | Real-Redis relay E2E, presence lifecycle, fencing, no-plaintext, at-most-once. |

---

### Task 1: `BREEZE_ROLE` env helper + `INSTANCE_ID` leaf module

**Files:**
- Create: `apps/api/src/services/instanceIdentity.ts`
- Modify: `apps/api/src/config/env.ts` (append near `eventDispatchMode`, ~line 217)
- Modify: `apps/api/src/config/validate.ts` (optional enum entry, mirror how `EVENT_DISPATCH_MODE` is declared)
- Modify: `.env.example`, `docker-compose.yml` (api `environment:`), `deploy/docker-compose.prod.yml` (api `environment:`)
- Test: `apps/api/src/config/env.breezeRole.test.ts`

**Interfaces:**
- Produces: `breezeRole(): BreezeRole` (`'all'|'api'|'worker'`, default `'all'`), `INSTANCE_ID: string`.

- [x] **Step 1: Write the leaf identity module** (const-only, no test):

```ts
// apps/api/src/services/instanceIdentity.ts
import { randomUUID } from 'crypto';

// Identity of this process instance (wave 3.5b, #4084). Regenerated every
// boot — a presence lease naming a dead instance simply ages out via TTL, so
// there is deliberately no persistence and no bootId beyond this.
export const INSTANCE_ID = randomUUID();
```

- [x] **Step 2: Write the failing env-helper tests**

```ts
// apps/api/src/config/env.breezeRole.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { breezeRole } from './env';

describe('breezeRole()', () => {
  const original = process.env.BREEZE_ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.BREEZE_ROLE;
    else process.env.BREEZE_ROLE = original;
    vi.restoreAllMocks();
  });

  it.each([
    [undefined, 'all'],
    ['', 'all'],
    ['all', 'all'],
    ['api', 'api'],
    ['worker', 'worker'],
    ['API', 'api'],
    ['  worker  ', 'worker'],
  ])('BREEZE_ROLE=%s → %s', (raw, expected) => {
    if (raw === undefined) delete process.env.BREEZE_ROLE;
    else process.env.BREEZE_ROLE = raw;
    expect(breezeRole()).toBe(expected);
  });

  it('unknown value warns and falls back to all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BREEZE_ROLE = 'banana';
    expect(breezeRole()).toBe('all');
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 3: Run to verify failure** — `cd apps/api && npx vitest run src/config/env.breezeRole.test.ts` → FAIL (`breezeRole` not exported).

- [x] **Step 4: Implement in `env.ts`** (mirror `eventDispatchMode`, env.ts:217):

```ts
export type BreezeRole = 'all' | 'api' | 'worker';

/**
 * Process role for the 3.5d split (#4086). `all` (default) = today's
 * all-in-one process. Introduced in 3.5b (#4084) so socket-local dispatch can
 * fail LOUDLY in a worker-role process instead of silently reporting every
 * agent offline.
 */
export function breezeRole(): BreezeRole {
  const raw = (process.env.BREEZE_ROLE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'all') return 'all';
  if (raw === 'api' || raw === 'worker') return raw;
  console.warn(`[config] BREEZE_ROLE="${raw}" is not all|api|worker — treating as all`);
  return 'all';
}
```

Add the matching optional-enum entry in `config/validate.ts` exactly the way `EVENT_DISPATCH_MODE` is declared there (same optionality — absent means `all`; do NOT make it required-in-production in this wave).

- [x] **Step 5: Env parity plumbing** — add to `.env.example` (`# BREEZE_ROLE=all — process role; 'worker' disables socket-local agent dispatch (wave 3.5d)`), and `BREEZE_ROLE: ${BREEZE_ROLE:-all}` to the api service `environment:` block in `docker-compose.yml` AND `deploy/docker-compose.prod.yml`. Run `cd apps/api && npx vitest run src/config/envComposeParity.test.ts` → PASS.

- [x] **Step 6: Run tests** — `npx vitest run src/config/env.breezeRole.test.ts` → PASS. Commit: `feat(api): BREEZE_ROLE env helper + per-boot INSTANCE_ID (wave 3.5b #4084)`

---

### Task 2: Fenced presence leases — `agentPresence.ts`

**Files:**
- Create: `apps/api/src/services/agentPresence.ts`
- Test: `apps/api/src/services/agentPresence.test.ts` (unit, mocked redis; real-Redis behavior lands in Task 9's integration suite)

**Interfaces:**
- Produces: `AgentPresenceLease { instanceId: string; connectionToken: string }`, `AGENT_PRESENCE_TTL_MS = 90_000`, `setAgentPresence(agentId, lease): Promise<void>`, `refreshAgentPresence(agentId, connectionToken): Promise<boolean>`, `clearAgentPresence(agentId, connectionToken): Promise<boolean>`, `readAgentPresence(agentId): Promise<AgentPresenceLease | null>`. All best-effort: Redis unavailable → no-op / `null` / `false`, never throw (presence is an admission hint; missing presence fails closed as "offline").

- [x] **Step 1: Write the failing unit tests** — mock `getRedis` (pattern: existing `services/*.test.ts` that `vi.mock('./redis', ...)`):

```ts
// apps/api/src/services/agentPresence.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = {
  set: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
};
vi.mock('./redis', () => ({ getRedis: vi.fn(() => redisMock) }));

import { getRedis } from './redis';
import {
  AGENT_PRESENCE_TTL_MS,
  clearAgentPresence,
  readAgentPresence,
  refreshAgentPresence,
  setAgentPresence,
} from './agentPresence';

describe('agentPresence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setAgentPresence SETs JSON with PX TTL', async () => {
    await setAgentPresence('agent-1', { instanceId: 'i-1', connectionToken: 't-1' });
    expect(redisMock.set).toHaveBeenCalledWith(
      'agent-presence:agent-1',
      JSON.stringify({ instanceId: 'i-1', connectionToken: 't-1' }),
      'PX',
      AGENT_PRESENCE_TTL_MS,
    );
  });

  it('refreshAgentPresence evals the compare-refresh Lua with token + TTL and maps 1→true, 0→false', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await refreshAgentPresence('agent-1', 't-1')).toBe(true);
    expect(await refreshAgentPresence('agent-1', 't-2')).toBe(false);
    const [script, numKeys, key, token, ttl] = redisMock.eval.mock.calls[0];
    expect(script).toContain('PEXPIRE');
    expect(numKeys).toBe(1);
    expect(key).toBe('agent-presence:agent-1');
    expect(token).toBe('t-1');
    expect(ttl).toBe(String(AGENT_PRESENCE_TTL_MS));
  });

  it('clearAgentPresence deletes only when the token matches (Lua DEL script)', async () => {
    redisMock.eval.mockResolvedValueOnce(1);
    expect(await clearAgentPresence('agent-1', 't-1')).toBe(true);
    expect(redisMock.eval.mock.calls[0][0]).toContain("redis.call('DEL', KEYS[1])");
  });

  it('readAgentPresence parses the lease and returns null on missing/corrupt', async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ instanceId: 'i-1', connectionToken: 't-1' }));
    expect(await readAgentPresence('agent-1')).toEqual({ instanceId: 'i-1', connectionToken: 't-1' });
    redisMock.get.mockResolvedValueOnce(null);
    expect(await readAgentPresence('agent-1')).toBeNull();
    redisMock.get.mockResolvedValueOnce('{not json');
    expect(await readAgentPresence('agent-1')).toBeNull();
  });

  it('every helper is a safe no-op when Redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValue(null as never);
    await expect(setAgentPresence('a', { instanceId: 'i', connectionToken: 't' })).resolves.toBeUndefined();
    await expect(refreshAgentPresence('a', 't')).resolves.toBe(false);
    await expect(clearAgentPresence('a', 't')).resolves.toBe(false);
    await expect(readAgentPresence('a')).resolves.toBeNull();
  });

  it('helpers swallow Redis errors (log, never throw)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisMock.set.mockRejectedValueOnce(new Error('boom'));
    await expect(setAgentPresence('a', { instanceId: 'i', connectionToken: 't' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run to verify failure** — `npx vitest run src/services/agentPresence.test.ts` → FAIL (module missing).

- [x] **Step 3: Implement**:

```ts
// apps/api/src/services/agentPresence.ts
import { getRedis } from './redis';

// Fenced presence leases for agent WebSockets (wave 3.5b, #4084).
// A lease is an ADMISSION HINT for the command relay — the socket-owning
// process's in-memory map stays authoritative. Fencing: every mutation is
// token-guarded server-side (Lua), so an old socket's delayed onClose can
// never delete a newer connection's lease.
const PRESENCE_KEY_PREFIX = 'agent-presence:';
export const AGENT_PRESENCE_TTL_MS = 90_000;

export interface AgentPresenceLease {
  instanceId: string;
  connectionToken: string;
}

// Runs server-side in Redis (ioredis Lua API, not JS eval); token comes in as
// ARGV, never interpolated into the script.
const REFRESH_IF_TOKEN_MATCHES_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, lease = pcall(cjson.decode, raw)
if not ok or lease.connectionToken ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const DELETE_IF_TOKEN_MATCHES_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, lease = pcall(cjson.decode, raw)
if not ok or lease.connectionToken ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

function presenceKey(agentId: string): string {
  return `${PRESENCE_KEY_PREFIX}${agentId}`;
}

export async function setAgentPresence(agentId: string, lease: AgentPresenceLease): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    // Unconditional SET: onOpen installs the newest socket as authoritative
    // (mirrors the activeConnections/epoch model), so the newest lease wins.
    await redis.set(presenceKey(agentId), JSON.stringify(lease), 'PX', AGENT_PRESENCE_TTL_MS);
  } catch (err) {
    console.warn(`[AgentPresence] set failed for ${agentId.slice(0, 12)}:`, err);
  }
}

export async function refreshAgentPresence(agentId: string, connectionToken: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const res = await redis.eval(
      REFRESH_IF_TOKEN_MATCHES_LUA, 1, presenceKey(agentId), connectionToken, String(AGENT_PRESENCE_TTL_MS),
    );
    return res === 1;
  } catch (err) {
    console.warn(`[AgentPresence] refresh failed for ${agentId.slice(0, 12)}:`, err);
    return false;
  }
}

export async function clearAgentPresence(agentId: string, connectionToken: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const res = await redis.eval(DELETE_IF_TOKEN_MATCHES_LUA, 1, presenceKey(agentId), connectionToken);
    return res === 1;
  } catch (err) {
    console.warn(`[AgentPresence] clear failed for ${agentId.slice(0, 12)}:`, err);
    return false;
  }
}

export async function readAgentPresence(agentId: string): Promise<AgentPresenceLease | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(presenceKey(agentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentPresenceLease;
    if (typeof parsed?.instanceId !== 'string' || typeof parsed?.connectionToken !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
```

- [x] **Step 4: Run tests** — `npx vitest run src/services/agentPresence.test.ts` → PASS. Commit: `feat(api): fenced agent presence leases in Redis (wave 3.5b #4084)`

---

### Task 3: Wire presence into the agent WS lifecycle

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts` — onOpen (~1918), pong/heartbeat handler (~2071-2088), onClose/onError (~2615-2698), `evictAgentSocket` (~224)
- Test: extend the existing agentWs handler test file (find it: `cd apps/api && ls src/routes/agentWs*.test.ts`) with presence-lifecycle assertions using `vi.mock('../services/agentPresence')`

**Interfaces:**
- Consumes: Task 2's four presence helpers, Task 1's `INSTANCE_ID`.
- Produces: presence keys maintained for every live agent socket; a per-connection `connectionToken` (closure variable next to `socketEpoch` in `createAgentWsHandlers`).

- [x] **Step 1: Write failing tests** — mock `../services/agentPresence` and assert, via the existing handler-test harness for `createAgentWsHandlers`:
  - onOpen calls `setAgentPresence(agentId, { instanceId: INSTANCE_ID, connectionToken: <uuid> })` (capture the token; assert it is a non-empty string).
  - a `pong` message calls `refreshAgentPresence(agentId, <same token>)`.
  - when `refreshAgentPresence` resolves `false` AND this ws is still the mapped connection, the handler re-calls `setAgentPresence` with the same token (self-heal after an errant delete).
  - onClose (current socket) calls `clearAgentPresence(agentId, <same token>)`; onClose for a superseded socket does NOT clear (token mismatch is also guarded server-side, but don't even issue the call when `activeConnections.get(agentId) !== ws`).

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement** — all calls fire-and-forget (`void ...` or `.catch(() => {})` consistent with surrounding style; the handlers must never await Redis on the hot path):
  - In `createAgentWsHandlers`, next to `socketEpoch`, add `const connectionToken = randomUUID();` (add the `crypto` import if absent).
  - onOpen, immediately after `activeConnections.set(agentId, ws); socketEpoch = installAgentSocketEpoch(agentId);`:
    ```ts
    void setAgentPresence(agentId, { instanceId: INSTANCE_ID, connectionToken });
    ```
  - In the pong branch (and the heartbeat liveness branch) after `state.lastPongAt = Date.now();`:
    ```ts
    void refreshAgentPresence(agentId, connectionToken).then((refreshed) => {
      // Self-heal: an evict-path unconditional delete may have raced a
      // reconnect; if we are still the live socket, re-establish the lease.
      if (!refreshed && activeConnections.get(agentId) === ws) {
        return setAgentPresence(agentId, { instanceId: INSTANCE_ID, connectionToken });
      }
    });
    ```
  - onClose/onError, inside the existing `if (activeConnections.get(agentId) === ws)` block:
    ```ts
    void clearAgentPresence(agentId, connectionToken);
    ```
  - `evictAgentSocket` (module-level, no token in scope) — clear unconditionally, best-effort; the pong self-heal above bounds the collateral window:
    ```ts
    function evictAgentSocket(agentId: string): void {
      activeConnections.delete(agentId);
      agentSocketEpochs.delete(agentId);
      void clearAgentPresenceUnfenced(agentId);
    }
    ```
    Add `clearAgentPresenceUnfenced(agentId)` to `agentPresence.ts` (plain `DEL`, same never-throw contract, one-line unit test in the Task 2 file).

- [x] **Step 4: Run the agentWs test file(s) + typecheck** — PASS. Commit: `feat(api): maintain fenced presence leases from the agent WS lifecycle (wave 3.5b #4084)`

---

### Task 4: Relay primitives — sealed envelope, send claims, acks (`agentCommandRelay.ts`, part 1)

**Files:**
- Create: `apps/api/src/services/agentCommandRelay.ts`
- Test: `apps/api/src/services/agentCommandRelay.test.ts`

**Interfaces:**
- Consumes: `encryptSecret(value, { aad })` from `./secretCrypto` and its decrypt counterpart — **check the actual export names first** (`grep '^export' apps/api/src/services/secretCrypto.ts`); the code below assumes `encryptSecret`/`decryptSecret(value, { aad })` — adjust to the real signatures, the roundtrip test locks them in.
- Produces (consumed by Tasks 5-6):
  - `type DispatchOutcome = { status: 'sent'; via: 'local' | 'relay' } | { status: 'offline' } | { status: 'expired' } | { status: 'owner_mismatch' } | { status: 'indeterminate' } | { status: 'infrastructure_error'; message: string }`
  - `interface RelayJobData { relayId: string; agentId: string; commandId: string; targetInstanceId: string; connectionToken: string; expiresAt: number; sealedCommand: string }`
  - `sealRelayCommand(command: AgentCommand, binding: RelayEnvelopeBinding): string` / `openRelayCommand(sealed: string, binding: RelayEnvelopeBinding): AgentCommand` (throws on tamper/wrong key)
  - `claimRelaySend(agentId, commandId): Promise<'claimed' | 'already-sent' | 'in-flight'>`, `markRelaySendComplete(agentId, commandId): Promise<void>`
  - `writeRelayAck(relayId, outcome): Promise<void>`, `awaitRelayAck(relayId, deadlineMs): Promise<DispatchOutcome>` (deadline exceeded → `{ status: 'indeterminate' }`)
  - `AGENT_COMMAND_RELAY_QUEUE = 'agent-command-relay'`, `RELAY_DELIVERY_DEADLINE_MS = 5_000`

- [x] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/agentCommandRelay.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = { set: vi.fn(), get: vi.fn(), eval: vi.fn() };
vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
  getRedisConnection: vi.fn(() => redisMock),
  getBullMQConnection: vi.fn(() => redisMock),
}));

// Key setup so secretCrypto can do real AES roundtrips in unit tests — mirror
// whatever existing secretCrypto/sensitiveCommandPayload unit tests do for
// key env vars (see services/remoteAccessLauncher.test.ts:211 for the idiom).
process.env.APP_ENCRYPTION_KEY ??= 'test-only-app-encryption-key-32chars!';

import {
  awaitRelayAck,
  claimRelaySend,
  markRelaySendComplete,
  openRelayCommand,
  sealRelayCommand,
  writeRelayAck,
} from './agentCommandRelay';

const BINDING = {
  agentId: 'agent-1',
  commandId: 'cmd-1',
  targetInstanceId: 'inst-1',
  expiresAt: 1_700_000_000_000,
};

describe('relay envelope', () => {
  const command = {
    id: 'cmd-1',
    type: 'snmp_poll',
    payload: { community: 'sup3r-s3cret', oids: ['1.3.6.1'] },
  };

  it('roundtrips a command and produces NO plaintext payload in the sealed string', () => {
    const sealed = sealRelayCommand(command, BINDING);
    expect(sealed).not.toContain('sup3r-s3cret');
    expect(sealed).not.toContain('snmp_poll');
    expect(openRelayCommand(sealed, BINDING)).toEqual(command);
  });

  it('fails closed when any bound field is tampered', () => {
    const sealed = sealRelayCommand(command, BINDING);
    expect(() => openRelayCommand(sealed, { ...BINDING, agentId: 'agent-2' })).toThrow();
    expect(() => openRelayCommand(sealed, { ...BINDING, expiresAt: BINDING.expiresAt + 1 })).toThrow();
    expect(() => openRelayCommand(`${sealed}x`, BINDING)).toThrow();
  });
});

describe('send claims (at-most-once)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps Lua results: fresh claim → claimed, sent marker → already-sent, live claim → in-flight', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    expect(await claimRelaySend('agent-1', 'cmd-1')).toBe('claimed');
    expect(await claimRelaySend('agent-1', 'cmd-1')).toBe('already-sent');
    expect(await claimRelaySend('agent-1', 'cmd-1')).toBe('in-flight');
    expect(redisMock.eval.mock.calls[0][2]).toBe('agent-relay-claim:agent-1:cmd-1');
  });

  it('claim helpers throw on Redis failure (the consumer must NOT treat unknown claim state as claimable)', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('down'));
    await expect(claimRelaySend('agent-1', 'cmd-1')).rejects.toThrow();
  });

  it('markRelaySendComplete promotes the claim to sent with a long TTL', async () => {
    await markRelaySendComplete('agent-1', 'cmd-1');
    expect(redisMock.set).toHaveBeenCalledWith('agent-relay-claim:agent-1:cmd-1', 'sent', 'PX', 600_000);
  });
});

describe('acks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writeRelayAck stores the outcome JSON with a TTL', async () => {
    await writeRelayAck('r-1', { status: 'sent', via: 'relay' });
    expect(redisMock.set).toHaveBeenCalledWith(
      'agent-relay-ack:r-1', JSON.stringify({ status: 'sent', via: 'relay' }), 'PX', 30_000,
    );
  });

  it('awaitRelayAck polls GET until the ack appears', async () => {
    redisMock.get.mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify({ status: 'offline' }));
    await expect(awaitRelayAck('r-1', 1_000)).resolves.toEqual({ status: 'offline' });
  });

  it('awaitRelayAck returns indeterminate at the deadline', async () => {
    redisMock.get.mockResolvedValue(null);
    await expect(awaitRelayAck('r-1', 250)).resolves.toEqual({ status: 'indeterminate' });
  });
});
```

- [x] **Step 2: Run to verify failure** — module missing.

- [x] **Step 3: Implement part 1 of the module** (the facade + queue singleton come in Task 5 — keep this commit to primitives):

```ts
// apps/api/src/services/agentCommandRelay.ts
import { getRedis } from './redis';
import { decryptSecret, encryptSecret } from './secretCrypto'; // adjust to real exports (see Interfaces note)
import type { AgentCommand } from '../routes/agentWs';

export const AGENT_COMMAND_RELAY_QUEUE = 'agent-command-relay';
export const RELAY_DELIVERY_DEADLINE_MS = 5_000;
const ACK_POLL_INTERVAL_MS = 100;
const ACK_TTL_MS = 30_000;
const CLAIM_TTL_MS = 60_000;
const SENT_MARKER_TTL_MS = 600_000; // outlives any BullMQ stalled-job redelivery window

export type DispatchOutcome =
  | { status: 'sent'; via: 'local' | 'relay' }
  | { status: 'offline' }
  | { status: 'expired' }
  | { status: 'owner_mismatch' }
  | { status: 'indeterminate' }
  | { status: 'infrastructure_error'; message: string };

export interface RelayEnvelopeBinding {
  agentId: string;
  commandId: string;
  targetInstanceId: string;
  expiresAt: number;
}

export interface RelayJobData {
  relayId: string;
  agentId: string;
  commandId: string;
  targetInstanceId: string;
  connectionToken: string;
  expiresAt: number;
  sealedCommand: string;
}

// The BullMQ payload persists in Redis (and its AOF/snapshots, failed-job
// tooling) — SNMP/discovery/backup commands carry DECRYPTED credentials, so
// the whole command is sealed and the AAD binds the routing metadata: any
// tamper of agentId/commandId/target/expiry makes decryption fail closed.
function relayAad(b: RelayEnvelopeBinding): string {
  return `agent_command_relay:${b.agentId}:${b.commandId}:${b.targetInstanceId}:${b.expiresAt}`;
}

export function sealRelayCommand(command: AgentCommand, binding: RelayEnvelopeBinding): string {
  return encryptSecret(JSON.stringify(command), { aad: relayAad(binding) });
}

export function openRelayCommand(sealed: string, binding: RelayEnvelopeBinding): AgentCommand {
  const plain = decryptSecret(sealed, { aad: relayAad(binding) });
  return JSON.parse(plain) as AgentCommand;
}

const CLAIM_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing == 'sent' then return 2 end
if existing then return 0 end
redis.call('SET', KEYS[1], 'claimed', 'PX', ARGV[1])
return 1
`;

function claimKey(agentId: string, commandId: string): string {
  return `agent-relay-claim:${agentId}:${commandId}`;
}

export async function claimRelaySend(
  agentId: string, commandId: string,
): Promise<'claimed' | 'already-sent' | 'in-flight'> {
  const redis = getRedis();
  if (!redis) throw new Error('[AgentRelay] Redis unavailable — cannot take send claim');
  const res = await redis.eval(CLAIM_LUA, 1, claimKey(agentId, commandId), String(CLAIM_TTL_MS));
  if (res === 2) return 'already-sent';
  if (res === 1) return 'claimed';
  return 'in-flight';
}

export async function markRelaySendComplete(agentId: string, commandId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(claimKey(agentId, commandId), 'sent', 'PX', SENT_MARKER_TTL_MS);
}

function ackKey(relayId: string): string {
  return `agent-relay-ack:${relayId}`;
}

export async function writeRelayAck(relayId: string, outcome: DispatchOutcome): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(ackKey(relayId), JSON.stringify(outcome), 'PX', ACK_TTL_MS);
}

// Plain GET polling on the shared connection — deliberately NOT BRPOP /
// QueueEvents / waitUntilFinished (blocking commands on the shared connection
// stall every enqueue, #3299; QueueEvents has no repo precedent).
export async function awaitRelayAck(relayId: string, deadlineMs: number): Promise<DispatchOutcome> {
  const redis = getRedis();
  if (!redis) return { status: 'indeterminate' };
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const raw = await redis.get(ackKey(relayId));
      if (raw) return JSON.parse(raw) as DispatchOutcome;
    } catch {
      // transient read failure — keep polling until the deadline
    }
    if (Date.now() >= deadline) return { status: 'indeterminate' };
    await new Promise((resolve) => setTimeout(resolve, ACK_POLL_INTERVAL_MS));
  }
}
```

- [x] **Step 4: Run tests** — PASS (fix the `decryptSecret` import to the real secretCrypto export if the roundtrip fails to compile). Commit: `feat(api): relay envelope, at-most-once send claims, ack channel (wave 3.5b #4084)`

---

### Task 5: The dispatch facade (`agentCommandRelay.ts`, part 2)

**Files:**
- Modify: `apps/api/src/services/agentCommandRelay.ts`
- Test: extend `apps/api/src/services/agentCommandRelay.test.ts`

**Interfaces:**
- Consumes: Task 2 `readAgentPresence`, Task 1 `breezeRole`, `createInstrumentedQueue` (`services/bullmqQueue.ts:41`), socket-local `isAgentConnected`/`sendCommandToAgent` (`routes/agentWs.ts`).
- Produces (consumed by the four workers in Tasks 7-8):
  - `dispatchCommandToAgent(agentId: string, command: AgentCommand, opts?: { priority?: 'probe' | 'normal'; forceRelay?: boolean }): Promise<DispatchOutcome>`
  - `isAgentConnectedAnywhere(agentId: string): Promise<boolean>`
  - `getAgentCommandRelayQueue(): Queue<RelayJobData>` / `shutdownAgentCommandRelayQueue(): Promise<void>` (mirror `eventDispatchQueue.ts:55-62`)

- [x] **Step 1: Write the failing tests** — add a mocked `../routes/agentWs` (`isAgentConnected`, `sendCommandToAgent`), mocked `./agentPresence`, mocked `./bullmqQueue` (capture `queue.add` calls). Cases:
  - local socket + send ok → `{ status: 'sent', via: 'local' }`, **no** presence read, **no** enqueue.
  - local socket + `sendCommandToAgent` returns false → `{ status: 'offline' }`, no enqueue (the local map was authoritative and the socket died mid-send).
  - no local socket + no presence → `{ status: 'offline' }`, no enqueue.
  - no local socket + presence exists → enqueues one job on `agent-command-relay` with `jobId` matching `/^relay-[0-9a-f-]{36}$/`, `attempts: 1`, sealed payload (assert `job.data.sealedCommand` does not contain the payload secret string), `expiresAt ≈ now + RELAY_DELIVERY_DEADLINE_MS`, priority 1 for `'probe'` / 10 default — then resolves with whatever `awaitRelayAck` yields (stub the ack GET to return `{ status: 'sent', via: 'relay' }`).
  - `queue.add` throws → `{ status: 'infrastructure_error' }` (message includes the error), and NOT `'offline'`.
  - `forceRelay: true` skips the local-first branch even when the local socket exists (staging/integration verification hook).
  - `isAgentConnectedAnywhere`: local hit → true without presence read; local miss + presence → true; both miss → false; under `BREEZE_ROLE=worker` the socket-local check is skipped entirely (assert `isAgentConnected` never called — it would throw in that role after Task 6).

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement** (append to the module):

```ts
import { randomUUID } from 'crypto';
import type { Queue } from 'bullmq';
import { breezeRole } from '../config/env';
import { createInstrumentedQueue } from './bullmqQueue';
import { readAgentPresence } from './agentPresence';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';

let relayQueue: Queue<RelayJobData> | null = null;

export function getAgentCommandRelayQueue(): Queue<RelayJobData> {
  if (!relayQueue) {
    relayQueue = createInstrumentedQueue<RelayJobData>(AGENT_COMMAND_RELAY_QUEUE);
  }
  return relayQueue;
}

export async function shutdownAgentCommandRelayQueue(): Promise<void> {
  if (relayQueue) {
    await relayQueue.close();
    relayQueue = null;
  }
}

export async function isAgentConnectedAnywhere(agentId: string): Promise<boolean> {
  if (breezeRole() !== 'worker' && isAgentConnected(agentId)) return true;
  return (await readAgentPresence(agentId)) !== null;
}

/**
 * Cross-process-safe agent command dispatch (wave 3.5b, #4084).
 *
 * Local-first: on a process that may own sockets, a locally-connected agent
 * gets today's direct send — zero Redis, zero behavior change. Otherwise the
 * presence lease admits (or refuses) a relay enqueue, and the api-role
 * consumer performs the actual socket write. `sent` means the frame reached
 * ws.send() successfully — it says nothing about execution; results flow
 * through device_commands exactly as before.
 */
export async function dispatchCommandToAgent(
  agentId: string,
  command: AgentCommand,
  opts: { priority?: 'probe' | 'normal'; forceRelay?: boolean } = {},
): Promise<DispatchOutcome> {
  if (!opts.forceRelay && breezeRole() !== 'worker' && isAgentConnected(agentId)) {
    return sendCommandToAgent(agentId, command)
      ? { status: 'sent', via: 'local' }
      : { status: 'offline' };
  }

  const lease = await readAgentPresence(agentId);
  if (!lease) return { status: 'offline' };

  const relayId = randomUUID();
  const expiresAt = Date.now() + RELAY_DELIVERY_DEADLINE_MS;
  const binding: RelayEnvelopeBinding = {
    agentId, commandId: command.id, targetInstanceId: lease.instanceId, expiresAt,
  };
  const data: RelayJobData = {
    relayId, agentId, commandId: command.id,
    targetInstanceId: lease.instanceId, connectionToken: lease.connectionToken,
    expiresAt, sealedCommand: sealRelayCommand(command, binding),
  };
  try {
    await getAgentCommandRelayQueue().add('relay-send', data, {
      jobId: `relay-${relayId}`,
      attempts: 1, // at-most-once: claims (not BullMQ retries) guard the send
      priority: opts.priority === 'probe' ? 1 : 10,
      removeOnComplete: true,
      removeOnFail: 100,
    });
  } catch (err) {
    return {
      status: 'infrastructure_error',
      message: `relay enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return awaitRelayAck(relayId, RELAY_DELIVERY_DEADLINE_MS);
}
```

- [x] **Step 4: Run tests + typecheck** — PASS. Commit: `feat(api): dispatchCommandToAgent facade — local-first with presence-admitted relay (wave 3.5b #4084)`

**Post-landing review fix (Tasks 4/5, `fix(api): review fixes for wave 3.5b relay-core (#4084)`):** `sealRelayCommand` throws when `APP_ENCRYPTION_KEY_ID` is unset (the AAD binding is the tamper defense, so it must never silently fall back to unbound v1 ciphertext) — but that made the whole relay path boot-time-invisible-dead on a stock deployment (`.env.example` ships the key id empty). Fixed by (a) moving the seal call inside the facade's guarded region so a throw maps to `{ status: 'infrastructure_error' }` instead of escaping as an unhandled exception, and (b) a new `validate.ts` superRefine pairing rule: `BREEZE_ROLE` of `api`/`worker` now requires a non-blank `APP_ENCRYPTION_KEY_ID` at boot. **Task 6 does not need to add this pairing rule — it already exists.**

---

### Task 6: Relay consumer worker + boot registration + runtime role assertions

**Files:**
- Create: `apps/api/src/jobs/agentCommandRelayWorker.ts`
- Modify: `apps/api/src/routes/agentWs.ts` (role assertion + test-only socket installer), `apps/api/src/services/agentCommandAwait.ts` (role assertion), `apps/api/src/index.ts` (registration)
- Test: `apps/api/src/jobs/agentCommandRelayWorker.test.ts`, plus role-assertion cases appended to the agentWs test file

**Interfaces:**
- Consumes: Task 4 primitives, Task 2 `readAgentPresence`, Task 1 `INSTANCE_ID`, socket-local `isAgentConnected`/`sendCommandToAgent`.
- Produces: `createAgentCommandRelayWorker(): Worker`, `initializeAgentCommandRelayWorker(): Promise<void>`; agentWs test-only export `__installAgentSocketForTest(agentId: string, ws: { send(data: string): void }): void`.

- [x] **Step 1: Write the failing processor tests** (mock agentWs, agentPresence, and the relay primitives; drive the exported processor function directly with a fake `Job`):
  - expired job (`expiresAt` in the past) → ack `{ status: 'expired' }`, no claim taken, no send.
  - no local socket → ack `{ status: 'offline' }`, no claim.
  - lease missing / `instanceId` ≠ job's `targetInstanceId` / `connectionToken` mismatch / `targetInstanceId` ≠ `INSTANCE_ID` → ack `{ status: 'owner_mismatch' }`, no send. (Strict fencing per quorum: a routing decision made against a superseded lease is never executed, even if the agent reconnected here — the caller's next cycle re-routes.)
  - claim `'already-sent'` → ack `{ status: 'sent', via: 'relay' }`, **no** second send.
  - claim `'in-flight'` → ack `{ status: 'indeterminate' }`, no send.
  - claim `'claimed'` + `openRelayCommand` throws → ack `{ status: 'infrastructure_error' }`, no send.
  - claim `'claimed'` + send ok → `sendCommandToAgent` called with the decrypted command, `markRelaySendComplete` called, ack `{ status: 'sent', via: 'relay' }`.
  - claim `'claimed'` + `sendCommandToAgent` returns false → ack `{ status: 'offline' }`, `markRelaySendComplete` NOT called.

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement the worker**:

```ts
// apps/api/src/jobs/agentCommandRelayWorker.ts
import { Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { INSTANCE_ID } from '../services/instanceIdentity';
import { readAgentPresence } from '../services/agentPresence';
import {
  AGENT_COMMAND_RELAY_QUEUE,
  claimRelaySend,
  markRelaySendComplete,
  openRelayCommand,
  writeRelayAck,
  type DispatchOutcome,
  type RelayJobData,
} from '../services/agentCommandRelay';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';

// Runs ONLY on socket-owning roles (registration is gated in index.ts).
// Presence admitted the job; this process's in-memory socket map is the
// authority. The local send path also records orphanedResultExpectations HERE
// — the process that will receive the command_result — which is why the
// consumer must call sendCommandToAgent and never re-implement the send.
export async function processAgentCommandRelayJob(job: Job<RelayJobData>): Promise<void> {
  const d = job.data;
  const ack = (outcome: DispatchOutcome) => writeRelayAck(d.relayId, outcome);

  if (Date.now() > d.expiresAt) return ack({ status: 'expired' });
  if (!isAgentConnected(d.agentId)) return ack({ status: 'offline' });

  const lease = await readAgentPresence(d.agentId);
  if (
    !lease
    || lease.instanceId !== d.targetInstanceId
    || lease.connectionToken !== d.connectionToken
    || d.targetInstanceId !== INSTANCE_ID
  ) {
    return ack({ status: 'owner_mismatch' });
  }

  let claim: Awaited<ReturnType<typeof claimRelaySend>>;
  try {
    claim = await claimRelaySend(d.agentId, d.commandId);
  } catch (err) {
    return ack({
      status: 'infrastructure_error',
      message: `send claim failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (claim === 'already-sent') return ack({ status: 'sent', via: 'relay' });
  if (claim === 'in-flight') return ack({ status: 'indeterminate' });

  let command;
  try {
    command = openRelayCommand(d.sealedCommand, {
      agentId: d.agentId, commandId: d.commandId,
      targetInstanceId: d.targetInstanceId, expiresAt: d.expiresAt,
    });
  } catch {
    return ack({ status: 'infrastructure_error', message: 'relay envelope failed to open (tamper or key mismatch)' });
  }

  if (!sendCommandToAgent(d.agentId, command)) return ack({ status: 'offline' });
  await markRelaySendComplete(d.agentId, d.commandId);
  return ack({ status: 'sent', via: 'relay' });
}

export function createAgentCommandRelayWorker(): Worker {
  return new Worker(AGENT_COMMAND_RELAY_QUEUE, processAgentCommandRelayJob, {
    connection: getBullMQConnection(),
    // ws.send is fast; 25 is deliberately conservative — tune from queue-age
    // measurements after 3.5d rolls out, mirroring eventDispatchWorker's note.
    concurrency: 25,
  });
}
```

Add `initializeAgentCommandRelayWorker` following the shape of the sibling `initialize*Worker` functions in whichever module `index.ts` imports them from (grep one, e.g. `initializeEventDispatchWorker`, and mirror its error handling + shutdown hook). If 3.5c's `attachWorkerObservability` (from `services/bullmqQueue.ts`) is what `eventDispatchWorker` uses for Sentry/error reporting, attach it identically here.

- [x] **Step 4: Boot registration in `index.ts`** — next to the phase-2 event-dispatch start (index.ts:1505-1524), add:

```ts
if (breezeRole() !== 'worker') {
  try {
    await initializeAgentCommandRelayWorker();
    workerStatus['agentCommandRelay'] = true;
  } catch (error) {
    workerStatus['agentCommandRelay'] = false;
    console.error('[CRITICAL] Failed to initialize agentCommandRelay:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}
```

- [x] **Step 5: Runtime role assertions** — in `agentWs.ts`, add at the top of `sendCommandToAgent` AND `isAgentConnected` (and export nothing new for it):

```ts
function assertSocketLocalDispatchAllowed(fn: string): void {
  if (breezeRole() === 'worker') {
    throw new Error(
      `[BREEZE_ROLE] ${fn} is socket-local and cannot run in the worker role — `
      + 'use dispatchCommandToAgent/isAgentConnectedAnywhere (services/agentCommandRelay.ts)',
    );
  }
}
```

Same assertion at the top of `sendCommandToAgentAwaitResult` (`services/agentCommandAwait.ts`), plus a doc comment stating the module is api-role-affine by design (its correlation map cannot resolve cross-process). Throwing — not returning false — is the point: a silent false is exactly the every-agent-reads-offline failure this wave exists to kill. Test: with `BREEZE_ROLE=worker` set (and restored) in the agentWs test file, each of the three throws with a message matching `/BREEZE_ROLE/`.

- [x] **Step 6: Test-only socket installer in `agentWs.ts`** (needed by Task 9's integration suite; mirror `__resetCrossTenantDropsForTest`, agentWs.ts:2993):

```ts
export function __installAgentSocketForTest(agentId: string, ws: { send(data: string): void }): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__installAgentSocketForTest is test-only');
  }
  activeConnections.set(agentId, ws as never);
  installAgentSocketEpoch(agentId);
}
```

- [x] **Step 7: Run the new tests + full typecheck** — PASS. Commit: `feat(api): api-role relay consumer, boot gating, worker-role dispatch assertions (wave 3.5b #4084)`

---

### Task 7: Migrate the fire-and-forget workers — monitorWorker + snmpWorker

**Files:**
- Modify: `apps/api/src/jobs/monitorWorker.ts` (import line 15; dispatch block ~150-177), `apps/api/src/jobs/snmpWorker.ts` (import line 16; dispatch block ~385-420)
- Test: extend the existing `monitorWorker`/`snmpWorker` test files (find them next to the sources)

**Interfaces:**
- Consumes: `dispatchCommandToAgent`, `isAgentConnectedAnywhere` (Task 5); `import type { AgentCommand } from '../routes/agentWs'` (type-only).

**Behavior contract (both workers):** in `BREEZE_ROLE=all` with a locally-connected agent the observable behavior is IDENTICAL to today (local-first path). The only new behavior is the relay branch, unreachable until 3.5d. Preserve each function's exact return shapes.

- [x] **Step 1: Write the failing tests** — mock `../services/agentCommandRelay`. Cases per worker:
  - `isAgentConnectedAnywhere` false → today's "No online agent" warn + `{ dispatched: false, agentId: null }`, and `dispatchCommandToAgent` never called.
  - outcome `{ status: 'sent', via: 'local' }` → `{ dispatched: true, agentId }`.
  - outcome `{ status: 'offline' }` → `{ dispatched: false, agentId }` and the error log includes the outcome status.
  - outcome `{ status: 'indeterminate' }` → `{ dispatched: false, agentId }` (monitor) / `{ dispatched: false, agentId }` (snmp) with a WARN that names `indeterminate` (ops need to distinguish "maybe sent" from "definitely not").
  - snmp only: `markPollDispatched` is still called after the connectivity check and before dispatch (assert call order via mock invocationCallOrder) — an indeterminate dispatch leaves the poll counted, mirroring today's send-false-after-mark semantics.
  - monitor only: dispatch is called with `{ priority: 'probe' }`.

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Migrate `monitorWorker.ts`** — replace the import and the block at ~160-177:

```ts
import { dispatchCommandToAgent, isAgentConnectedAnywhere } from '../services/agentCommandRelay';
import type { AgentCommand } from '../routes/agentWs';
```

```ts
  const agentId = await selectExecutionAgentForMonitor(monitor);

  if (!agentId || !(await isAgentConnectedAnywhere(agentId))) {
    console.warn(`[MonitorWorker] No online agent for org ${data.orgId}`);
    return { dispatched: false, agentId: null };
  }

  const command = buildMonitorCommand(monitor);
  const outcome = await dispatchCommandToAgent(agentId, command, { priority: 'probe' });

  if (outcome.status !== 'sent') {
    console.error(`[MonitorWorker] Check dispatch ${outcome.status} for agent ${agentId}`);
    return { dispatched: false, agentId };
  }

  console.log(`[MonitorWorker] Check dispatched to agent ${agentId} for monitor ${data.monitorId} (${outcome.via})`);
  return { dispatched: true, agentId };
```

(If `monitorWorker.ts` only imported `sendCommandToAgent`/`isAgentConnected` for this block, the agentWs import disappears entirely; keep `AgentCommand` type-only if the file references the type.)

- [x] **Step 4: Migrate `snmpWorker.ts`** — same substitution at ~394-420: `isAgentConnected(agentId)` → `await isAgentConnectedAnywhere(agentId)`; keep the `markPollDispatched` placement and its #1105 phase-split comment intact (the facade's Redis I/O also relies on running outside a held DB context); then:

```ts
  const command = buildSnmpPollCommand(data.deviceId, device, oids);
  const outcome = await dispatchCommandToAgent(agentId, command, { priority: 'probe' });
  if (outcome.status !== 'sent') {
    console.error(`[SnmpWorker] Poll dispatch ${outcome.status} for agent ${agentId}`);
    return { dispatched: false, agentId };
  }

  console.log(`[SnmpWorker] Poll dispatched to agent ${agentId} for device ${data.deviceId} (${outcome.via})`);
  return { dispatched: true, agentId };
```

- [x] **Step 5: Run both worker test files + typecheck** — PASS. Commit: `refactor(api): monitor + snmp workers dispatch via the cross-process facade (wave 3.5b #4084)`

---

### Task 8: Migrate the job-failing workers — backupWorker + discoveryWorker

**Files:**
- Modify: `apps/api/src/jobs/backupWorker.ts` (imports 28-33; blocks ~490-515 and ~645-665), `apps/api/src/jobs/discoveryWorker.ts` (import 28; block ~560-615)
- Test: extend the existing `backupWorker`/`discoveryWorker` test files

**Behavior contract:** offline stays fail-fast (`markJobFailed` with the SAME message strings as today — dashboards and tests key on them). `indeterminate`/`infrastructure_error`/`expired`/`owner_mismatch` mark the job failed with a NEW distinct message naming the outcome — the command may still execute (at-most-once means no duplicate was sent), and a late result hitting a failed-marked job is the same benign race as today's send-succeeded-then-agent-crashed window. Flag this trade-off in the PR body.

- [x] **Step 1: Write the failing tests** — cases per worker:
  - `isAgentConnectedAnywhere` false → `markJobFailed(jobId, 'Agent not connected')` (backup) / `markJobFailed(jobId, 'No online agent available for this site')` (discovery) — byte-identical messages.
  - outcome `sent` → job proceeds exactly as today (backup increments sentCount; discovery flips job to running).
  - outcome `offline` → backup: the existing per-target failure branch runs (warn + child-job failed row); discovery: `markJobFailed(jobId, 'Failed to send command to agent')` (today's message).
  - outcome `indeterminate` → failure branch with a message matching `/dispatch outcome indeterminate/i`.
  - backup only: `recordDispatchedExpectation('backup', deviceId, commandJobId)` still happens BEFORE dispatch (call order assertion) — the expectation-first comment at backupWorker.ts:645-651 stays valid because an unconsumed expectation still just expires via TTL.

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Migrate `backupWorker.ts`**:

```ts
import { dispatchCommandToAgent, isAgentConnectedAnywhere } from '../services/agentCommandRelay';
import type { AgentCommand } from '../routes/agentWs';
```

At ~501: `if (!agentId || !(await isAgentConnectedAnywhere(agentId))) {` (unchanged failure body). At ~653:

```ts
    await recordDispatchedExpectation('backup', data.deviceId, commandJobId);

    const outcome = await dispatchCommandToAgent(agentId, command);
    if (outcome.status === 'sent') {
      sentCount++;
    } else {
      const detail = outcome.status === 'offline'
        ? `Failed to send ${target.commandType} command to agent`
        : `Failed to send ${target.commandType} command to agent (dispatch outcome ${outcome.status})`;
      console.warn(`[BackupWorker] ${detail} for job ${commandJobId}`);
      failedTargets.push(target.commandType);
      if (commandJobId !== data.jobId) {
        await db
          .update(backupJobs)
          .set({ status: 'failed', completedAt: new Date(), updatedAt: new Date(), errorLog: detail })
          .where(eq(backupJobs.id, commandJobId));
      }
    }
```

(Keep the surrounding comment block; it remains accurate.)

- [x] **Step 4: Migrate `discoveryWorker.ts`** — `!isAgentConnected(agentId)` → `!(await isAgentConnectedAnywhere(agentId))` (~571, same failure body); at ~606:

```ts
  const outcome = await dispatchCommandToAgent(agentId, command);
  if (outcome.status !== 'sent') {
    await markJobFailed(
      data.jobId,
      outcome.status === 'offline'
        ? 'Failed to send command to agent'
        : `Failed to send command to agent (dispatch outcome ${outcome.status})`,
    );
    return { dispatched: false, agentId, durationMs: Date.now() - startTime };
  }
```

- [x] **Step 5: Run both worker test files + typecheck** — PASS. Commit: `refactor(api): backup + discovery workers dispatch via the cross-process facade (wave 3.5b #4084)`

---

### Task 9: Integration suite — real-Redis relay E2E

**Files:**
- Create: `apps/api/src/__tests__/integration/agentCommandRelay.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts` (**add the file to the explicit `include` list — a misplaced/unlisted file runs in ZERO CI jobs**)

**Interfaces:**
- Consumes: everything from Tasks 2-6 against real Redis; `__installAgentSocketForTest` (Task 6). Setup pattern: copy the header of `eventDispatchQueue.integration.test.ts` (`import './setup'`, real `REDIS_URL`, `closeRedis` in afterAll, `docker compose -f docker-compose.test.yml up` run instructions in the top comment).

- [x] **Step 1: Write the suite** (each test red-then-green against the already-implemented code is fine here — the suite's job is proving the composition against real Redis; assert precisely):
  1. **Presence lifecycle:** `setAgentPresence` → `readAgentPresence` roundtrip; `refreshAgentPresence` with the right/wrong token → true/false; `clearAgentPresence` with the wrong token leaves the key (fencing); PTTL is ≤ `AGENT_PRESENCE_TTL_MS` and > 0 after a refresh.
  2. **Forced-relay E2E, exactly once:** install a fake socket capturing `send()` frames via `__installAgentSocketForTest('agent-int-1', ...)`; `setAgentPresence('agent-int-1', { instanceId: INSTANCE_ID, connectionToken: 't-int' })`; start `createAgentCommandRelayWorker()`; call `dispatchCommandToAgent('agent-int-1', { id: <uuid>, type: 'network_ping', payload: { probe: true } }, { forceRelay: true })` → resolves `{ status: 'sent', via: 'relay' }` within 5s; the fake socket received EXACTLY one frame; `JSON.parse(frame)` equals the command verbatim (`{id, type, payload}`, no extra keys).
  3. **No plaintext in the queue:** enqueue with a payload containing `'sup3r-s3cret'` (no consumer running); fetch the raw job via `getAgentCommandRelayQueue().getJob('relay-<id>')` and assert `JSON.stringify(job.data)` does NOT contain the secret; then assert `openRelayCommand` with the job's own binding fields DOES recover it.
  4. **Stale presence → offline:** presence set but NO socket installed → forced relay resolves `{ status: 'offline' }`, no frame sent.
  5. **Owner fencing:** presence lease has `connectionToken: 'other-token'` (≠ the enqueued job's token — simulate by setting presence AFTER capturing the lease used for enqueue, i.e. re-set presence with a new token between enqueue and consumer start) → `{ status: 'owner_mismatch' }`, no frame.
  6. **Expired job:** enqueue a job whose `expiresAt` is already past (build `RelayJobData` by hand and `queue.add` it directly), start the consumer → the ack written for that relayId is `{ status: 'expired' }`, no frame.
  7. **At-most-once:** pre-mark `markRelaySendComplete(agentId, commandId)`, then run a relay job for the same `(agentId, commandId)` → ack `{ status: 'sent', via: 'relay' }` and ZERO new frames on the socket.
  8. **Local-first does not touch the queue:** with the fake socket installed and NO `forceRelay`, `dispatchCommandToAgent` resolves `{ status: 'sent', via: 'local' }` and `getAgentCommandRelayQueue().count()` stays 0.
  9. **No presence → no enqueue:** clear all presence for a fresh agentId, `forceRelay: true` → `{ status: 'offline' }` and queue count stays 0.

  Cleanup discipline (3.5c lesson — the integration-DB pollution incident): `afterEach` obliterates the relay queue (`queue.obliterate({ force: true })`), deletes every `agent-presence:*` / `agent-relay-*` key the suite created, closes workers; `afterAll` runs `closeRedis()`. Keys must be namespaced per-test-run (`agent-int-<runUUID>-…` agentIds) so parallel shards can't collide.

- [x] **Step 2: Run** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agentCommandRelay.integration.test.ts` with the test stack up → ALL PASS. Verify the file count in the output is 1 and the suite actually RAN (not skipped).

- [x] **Step 3: Commit** — `test(api): agent command relay integration suite (wave 3.5b #4084)`

---

### Task 10: Static dispatch-boundary contract test

**Files:**
- Create: `apps/api/src/jobs/agentDispatchBoundary.contract.test.ts`

**Interfaces:** none produced — this is the guard #4084's "done when" demands: a test that FAILS if a future change gives a `jobs/**` module socket-local dispatch.

- [x] **Step 1: Write the test** (mechanism mirrors `eventSubscribers.contract.test.ts:1-60` — source-text scan):

```ts
// apps/api/src/jobs/agentDispatchBoundary.contract.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Wave 3.5b (#4084): BullMQ job modules may run in a worker-role process that
// holds NO agent sockets. Socket-local dispatch there silently reports every
// agent offline — the exact incident class this wave exists to prevent. Jobs
// must use dispatchCommandToAgent/isAgentConnectedAnywhere (agentCommandRelay).
const JOBS_DIR = fileURLToPath(new URL('.', import.meta.url));

// The relay consumer is the ONE legitimate socket-local caller under jobs/ —
// its registration is gated to socket-owning roles in index.ts.
const SOCKET_OWNER_ALLOWLIST = new Set(['agentCommandRelayWorker.ts']);

const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ['value import of socket-local agentWs dispatch',
    /import\s+(?!type\s)\{[^}]*\b(sendCommandToAgent|isAgentConnected|disconnectAgent|broadcastToAgents)\b[^}]*\}\s*from\s*['"][^'"]*agentWs['"]/],
  ['value import of in-memory agentCommandAwait',
    /import\s+(?!type\s)\{[^}]*\bsendCommandToAgentAwaitResult\b[^}]*\}\s*from\s*['"][^'"]*agentCommandAwait['"]/],
];

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionSources(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('jobs/** must not use socket-local agent dispatch (#4084)', () => {
  const files = productionSources(JOBS_DIR)
    .filter((f) => !SOCKET_OWNER_ALLOWLIST.has(f.slice(JOBS_DIR.length)));

  it('found job modules to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.slice(JOBS_DIR.length), f]))('%s', (_label, full) => {
    const src = readFileSync(full, 'utf8');
    for (const [what, pattern] of FORBIDDEN_PATTERNS) {
      expect(src, `${what} — route through services/agentCommandRelay instead`).not.toMatch(pattern);
    }
  });
});
```

- [x] **Step 2: Prove it discriminates** — temporarily re-add `import { sendCommandToAgent } from '../routes/agentWs';` to `monitorWorker.ts`, run the test → FAIL naming monitorWorker; revert → PASS. (This is the red step for a guard test.)

- [x] **Step 3: Commit** — `test(api): static contract — jobs may not import socket-local dispatch (wave 3.5b #4084)`

---

### Task 11: Full verification + PR

- [x] **Step 1: Repo-wide sweep** — `grep -rn "sendCommandToAgent\|isAgentConnected" apps/api/src/jobs/` → only the allowlisted relay worker (and type-only `AgentCommand` imports). `grep -rn "BREEZE_ROLE" apps/api/src docker-compose.yml deploy/ .env.example` → env helper + validate + compose parity all present.
- [x] **Step 2: Full unit suite** — `cd apps/api && npx vitest run` → 0 failures. Typecheck via the repo's turbo/CI-equivalent (`pnpm --filter @breeze/api exec tsc --noEmit` if no script exists — match what CI runs).
- [x] **Step 3: Contract + integration suites** (tenancy untouched, but the wave's own integration file must run): RLS coverage + the new relay suite against the test stack — `npx vitest run --config vitest.integration.config.ts` (confirm `agentCommandRelay.integration.test.ts` appears in the run output).
- [x] **Step 4: Update this plan doc's checkboxes**, commit any stragglers.
- [ ] **Step 5: Open the PR** — branch `feature/3821-ai-agents/wave-4084` → `main`, body must include: `Closes #4084`; the quorum decision summary (2-lite+ and why pinning was rejected); "Behavior changes in `all` mode: none for locally-connected agents — new code paths are presence bookkeeping (additive) and the relay branch (unreachable until 3.5d)"; the failed-job message trade-off from Task 8; deferred follow-ups to file as issues: per-instance queue sharding + multi-consumer topology guard (multi-replica API), durable orphaned-result expectations, relay queue-age/owner-mismatch alerting, presence-write load measurement at 10k agents. **Stop after opening the PR** (auto-merge is handled by the run driver, not the implementer).

## Self-Review Notes

- **Spec coverage vs #4084 "done when":** decision recorded (this doc + PR body) ✓; dispatch proven from a non-socket process (Task 9 forced-relay E2E — same-process BullMQ consumer stands in for the api process; the true two-process proof arrives with 3.5d's compose split, noted as accepted scope) ✓; a test fails if a socket-affine call site moves off the socket-owning role (Task 10 static contract + Task 6 runtime assertions) ✓.
- **Type consistency:** `DispatchOutcome`/`RelayJobData`/`RelayEnvelopeBinding` defined once in Task 4 and consumed by name in Tasks 5-9; presence helpers defined in Task 2, consumed in Tasks 3/5/6/9; `__installAgentSocketForTest` defined Task 6, consumed Task 9.
- **Known intentional gaps (do not "fix" during implementation):** `agentCommandAwait` stays api-role-affine; `broadcastToAgents`/`getConnectedAgentIds` remain socket-local (api-role callers only); no flag; no migration; multi-replica API out of scope.
