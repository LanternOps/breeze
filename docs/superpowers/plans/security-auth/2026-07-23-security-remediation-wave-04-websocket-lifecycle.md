# WebSocket Authentication and Lifecycle Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `P1-WS-001` and `P1-WS-002` without introducing a rollout regression: bind every remote-session event to an exact, cross-replica socket generation; validate one-time tickets before HTTP upgrade; preserve a narrowly bounded legacy-viewer compatibility ticket; reject concurrent owners; and make desktop teardown durably recoverable after queue retention or process loss.

**Architecture:** The first lease-aware release is a maintenance cutover, never a rolling deployment. A route-specific barrier in the external Caddy tier blocks every terminal/desktop/tunnel ticket issuer, every WebSocket upgrade, and the entire `/api/v1/tunnel-http/*` ticket/cookie consumer surface, then the old pool is drained and force-closed, verified absent, and replaced in full before admission reopens. The barrier stays closed for two independently proved V0 sub-drains: 60 seconds for WebSocket tickets and 300 seconds for tunnel-HTTP tickets/cookies. Terminal, desktop, and tunnel routes then share an atomic Redis owner lease keyed by transport and session ID. All owner, per-session generation, and desktop-finalization keys use one `{kind:sessionId}` hash tag, so every Lua operation is valid on Redis Cluster even though the supported production store for this wave remains standalone single-primary Redis with AOF and `noeviction`. A process-local map still stores the `WSContext`, but it is never the cross-replica authority. Ticket intake recognizes the truthful unversioned pre-wave V0 shape, explicit legacy-viewer V1, and normal V2; V0/V1 are compatibility inputs only in `post_upgrade` and never assert MFA. Legacy viewer JWTs may use only their same-session compatibility exchange; both viewer-token session-transition routes reject them before mutation. An assured descendant viewer JWT carries `mfaSatisfied: true` and the original lineage's absolute expiry, so a transition cannot launder assurance or extend the access window. Every event and agent relay verifies the exact local socket and an unexpired conservative forwarding deadline. Desktop teardown first makes forwarding inert and writes the exact non-expiring finalization intent while the shared owner is held, then detaches the socket/callback and durably requests an agent-sink-idempotent stop. Normal, worker, orphan, and operator paths may finalize the database or delete the intent pair only after the stable stop command has a terminal-safe agent acknowledgement. If Redis is unavailable, detach still wins for safety, but the inert closing lease is retained and admission/background reconciliation treats a nonterminal database row with no shared owner as an orphan that must be stopped and conditionally finalized before the session can be admitted again. Persisted nonterminal intents are recoverable—not contradictory—and the MFA/platform-admin operator surface can inspect the server-side ID/payload/stop state by session ID before exact audited reconciliation.

**Tech Stack:** Hono/TypeScript, `@hono/node-ws`, PostgreSQL, Drizzle ORM, Redis-backed one-time tickets and finalization fences, BullMQ, browser WebSocket clients, Astro/React, Tauri/React viewer, Vitest, raw-socket integration tests.

## Global Constraints

- Approved design: `docs/superpowers/specs/security-auth/2026-07-23-full-security-review-remediation-design.md`.
- Implementation branch: `fix/security-review-websocket-lifecycle`, created from a freshly fetched `origin/main` after Wave 1 is merged.
- Install and validate the external remote-admission maintenance barrier before deploying any lease-aware API binary. The barrier is outside the API process and covers all remote ticket issuers, terminal/desktop/tunnel upgrades, and every `/api/v1/tunnel-http/*` request that can consume a V0 HTTP ticket or scoped cookie, so an old binary or browser-held cookie cannot bypass it.
- Never admit remote traffic to a mixed pre-lease/lease-aware pool. Close the barrier, prove every covered issuer/upgrade/tunnel-HTTP consumer path returns bounded `503`, drain and force-close old sockets, stop the entire old API pool, prove zero old processes/containers and zero old upgraded connections, record the last old credential-writer time, wait both the complete 60-second V0 WebSocket-ticket sub-drain and complete 300-second V0 tunnel-HTTP ticket/cookie sub-drain, replace the whole pool with lease-aware `post_upgrade`, verify every instance, then reopen. The later of the two independently computed deadlines governs reopen; there is no initial rolling/canary exception.
- A message, pong, close, error, timer, agent callback, revocation callback, or cleanup call may act only when session ID, expected `WSContext`, connection ID, generation, API-instance ID, and lease token all match and the local monotonic clock is strictly before the latest conservative forwarding deadline.
- Redis is the cross-replica owner authority; the process-local map is only an exact socket/callback registry. A second valid connection never replaces an opening, active, or closing shared owner and receives HTTP `409` before `101` in both rollout modes.
- Shared owner acquisition, renewal, and release use atomic Lua scripts and exact opaque-value comparison. Generation comes from a persistent per-`kind/sessionId` Redis `INCR`, not a process or global key. Owner, generation, fence, and payload keys use the identical `{kind:sessionId}` hash tag; a desktop acquire atomically checks both finalization keys and orphan state before installing an owner.
- The shared lease TTL is 30 seconds, renewal begins every 5 seconds, the forwarding safety margin is 10 seconds, and a Redis round trip taking more than 2 seconds fails closed. A successful acquire/renew sets `safeForwardingUntil = requestStartMonotonic + TTL - safetyMargin`; therefore an old owner stops forwarding at least 10 seconds before Redis can admit a replacement, even after a long event-loop pause.
- Any acquire/renew/release result that is missing, malformed, slow, indeterminate, or owner-mismatched fails closed. Teardown first expires forwarding and enters `closing`. A normal close with an exact safe owner writes intent before detach/stop. A lease-loss/missed-deadline path first uses `beginClose`; definite mismatch performs stale local-only detach and may not stop/finalize a newer owner. If intent/Redis proof is unavailable, safety detach/stop occurs after that failed attempt and the inert closing entry is retained for retry/orphan recovery. No ordinary event path performs Redis I/O; it checks exact local owner and safe deadline.
- In both modes, missing, expired, caller-binding-mismatched, consumed, path/type/session-mismatched tickets and second owners never reach `upgradeWebSocket`. In `pre_upgrade`, inactive, unauthorized, site-denied, MFA-unassured, policy-denied, or rate-limited requests also never reach it. `post_upgrade` defers only those live DB checks for rollout compatibility and closes/releases the exact owner on failure.
- Ticket and reservation failures are fail closed. The client must mint a new ticket after any failed handshake; tickets are never reused.
- Pre-wave ticket records are truthfully modeled as unversioned V0 with no JTI and no MFA assertion. New readers accept V0 only in `post_upgrade`; they never rewrite or report it as V1/V2. All normal lease-aware issuers emit V2 with `mfaSatisfied: true`. During `post_upgrade` only, a legacy viewer JWT that predates the MFA claim may mint explicit V1 with no MFA assertion. `pre_upgrade` rejects V0 and V1 categorically; no compatibility path may coerce MFA.
- A legacy viewer JWT lacking `mfaSatisfied: true` is accepted only at the same-session compatibility ticket endpoint in `post_upgrade`. `/api/v1/vnc-viewer/upgrade-to-webrtc` and `/api/v1/vnc-viewer/downgrade-to-vnc` reject it with stable `403 legacy_viewer_transition_forbidden` before database mutation, agent command, audit, ticket issuance, or viewer-JWT issuance. Assured transitions propagate `mfaSatisfied: true` and cap the descendant `exp` at the root lineage's signed absolute expiry; neither transition can refresh the two-hour window.
- Preserve the existing terminal, desktop, tunnel, agent, viewer, and proxy wire protocols. New authorization/connection fields are internal server context only.
- Remote session creation remains gated by `PERMISSIONS.REMOTE_ACCESS` and `requireMfa()`. Pre-upgrade validation re-proves current remote permission/site/session state and verifies ticket-carried MFA assurance.
- Teardown writes are conditional on active states and may not overwrite an already terminal session status.
- The production viewer JWT lifetime has one source of truth: `VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS` in `apps/api/src/services/jwt.ts`, currently `7_200` seconds (two hours). Do not replace the drain gate or revocation TTL with a hand-written duration.
- `post_upgrade` remains mandatory until the last legacy viewer-token issuer has drained, one complete production viewer-token lifetime has elapsed from that recorded drain time, and then one complete WebSocket ticket TTL has elapsed. The waits are sequential and may not be inferred from deployment completion.
- Desktop teardown synchronously publishes one cleanup promise, sets `closing`, expires forwarding, clears timers, and freezes the exact counters/input. While the shared owner is still exact, it then persists the write-ahead fence/payload **before** socket/callback detach or the agent stop command. After intent acknowledgement, detach/stop immediately and continue inline finalization.
- Every persisted-intent path uses one stable durable `device_commands` row whose ID is the finalization UUID and whose `desktop_stream_stop` payload binds the session, device, and finalization IDs. The agent executes this stop idempotently on every delivery and acknowledges `stopped|already_absent`; generic pre-execution duplicate suppression may not turn it into an unproved `duplicate`. Database finalization and intent-pair deletion are forbidden until that exact durable row contains a validated terminal-safe agent result. A disconnected agent leaves the command pending/retryable and the session/intent fail closed; disconnection alone is never a terminal-safe acknowledgement.
- If intent persistence is unavailable or indeterminate, still detach and make a best-effort immediate stop request for safety, retain an inert shared/local `closing` lease, retry `beginClose`/intent persistence without restoring forwarding, and surface the failure. If the process dies before intent acknowledgement, next admission and the background reconciler fail closed on a nonterminal desktop row with absent shared owner/intent, atomically claim a synthesized `orphan_recovery` intent, durably enqueue and confirm the same agent-sink-idempotent stop, and only then conditionally finalize it. No orphan session is reopened.
- The desktop-finalization fence and payload are persistent and have no Redis TTL. Time passage, retry exhaustion, job retention cleanup, API restart, and Redis reconnect may not remove either key. Only `finalized|already_finalized` or explicit audited operator reconciliation may compare-delete both exact values in one Lua operation.
- The operator recovery surface is an MFA/platform-admin-protected inspect GET plus reconcile POST called by one repository CLI. The server re-loads the active user/current admin state, derives actor identity from authentication, discovers the exact server-side finalization ID/payload by session ID, requires exact confirmation plus a bounded private change-ticket string, and provides no direct Redis, age, or force option.
- Supported production coordination for this wave is Redis standalone single-primary, AOF enabled, `maxmemory-policy noeviction`, no automatic replica promotion, and known topology. Admission freezes on failover/restart/unknown topology. Asynchronous HA promotion cannot prove lease linearizability; do not enable remote admission on it unless a future protocol adds fencing enforcement at the agent sink.
- Audit/log fields contain bounded reason codes and truncated session/connection identifiers, never ticket values, query strings, input contents, frame contents, or credentials.
- No database migration is required. Do not introduce a table for owner leases or finalization payloads; use the existing Redis/BullMQ/PostgreSQL facilities described here, including the existing system-scoped `device_commands` table for durable stop delivery and acknowledgement.
- Rollback may switch pre-upgrade mode back to `post_upgrade` only on a lease-aware Wave 4 binary. It may not restore identifier-only event dispatch, implicit owner replacement, or duplicate desktop teardown.
- Obtain one independent security/concurrency review after the wave passes, with special attention to async races, reservation expiry, callbacks captured by stale generations, cleanup ordering, and HTTP-before-101 behavior.

---

## Canonical Interfaces

Create `apps/api/src/services/remoteWsOwnership.ts`:

```typescript
export type RemoteWsKind = 'terminal' | 'desktop' | 'tunnel';
export type RemoteWsLeaseState = 'opening' | 'active' | 'closing';

export interface RemoteConnectionLease {
  connectionId: string;
  generation: number;
  instanceId: string;
  leaseToken: string;
  state: RemoteWsLeaseState;
  userWs: WSContext | null;
  safeForwardingUntilMonotonicMs: number;
  cleanupPromise?: Promise<void>;
}

export interface RemoteConnectionIdentity {
  connectionId: string;
  generation: number;
  instanceId: string;
  leaseToken: string;
}

export type InstallLocalConnectionResult =
  | { ok: true }
  | { ok: false; reason: 'already_owned' };

export function installLocalRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  shared: RemoteWsSharedLeaseClaim,
  build: (shared: RemoteWsSharedLeaseClaim) => T
): InstallLocalConnectionResult;
export function bindRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
  ws: WSContext
): boolean;
export function ownsSafeRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
  ws: WSContext,
  monotonicNowMs?: number
): boolean;
export function removeExactLocalRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity
): boolean;
```

Create `apps/api/src/services/remoteWsSharedLease.ts`:

```typescript
export const REMOTE_WS_SHARED_LEASE_TTL_MS = 30_000;
export const REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS = 5_000;
export const REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS = 10_000;
export const REMOTE_WS_SHARED_LEASE_MAX_ROUND_TRIP_MS = 2_000;

export interface RemoteWsSharedLeaseClaim extends RemoteConnectionIdentity {
  kind: RemoteWsKind;
  sessionId: string;
  ownerValue: string;
  safeForwardingUntilMonotonicMs: number;
}

export type AcquireRemoteWsSharedLeaseResult =
  | { ok: true; claim: RemoteWsSharedLeaseClaim }
  | {
      ok: false;
      reason:
        | 'already_owned'
        | 'desktop_finalizing'
        | 'desktop_orphan_recovery'
        | 'unsupported_topology'
        | 'unavailable';
    };
export type BeginRemoteWsSharedCloseResult =
  | { ok: true; ownership: 'still_owner' }
  | { ok: false; reason: 'owner_mismatch' | 'unavailable' };

export function createRemoteWsSharedLeaseManager(input: {
  redis: Redis;
  instanceId: string;
  requiredTopology: 'standalone-single-primary';
  monotonicNow?: () => number;
}): {
  acquire(kind: RemoteWsKind, sessionId: string): Promise<AcquireRemoteWsSharedLeaseResult>;
  renew(claim: RemoteWsSharedLeaseClaim): Promise<RemoteWsSharedLeaseClaim>;
  beginClose(claim: RemoteWsSharedLeaseClaim): Promise<BeginRemoteWsSharedCloseResult>;
  release(claim: RemoteWsSharedLeaseClaim): Promise<boolean>;
};
```

`instanceId` is one `randomUUID()` per API-process boot, while `connectionId` and `leaseToken` are independent `randomUUID()` values per claim. For one ownership resource define `slot = {${kind}:${sessionId}}` and use only:

- `remote:ws:${slot}:generation` — persistent per-resource `INCR`;
- `remote:ws:${slot}:owner` — expiring exact owner;
- for desktop, `remote:ws:${slot}:finalizing` and `remote:ws:${slot}:finalization-payload`.

Generation allocation and owner installation occur in the same Lua script and same cluster slot. A failed acquisition does not reset or reuse a generation across release/API restart. The canonical owner value contains version, instance ID, connection ID, generation, and lease token and is never logged. Desktop acquisition atomically checks the owner and both finalization keys. It also performs the orphan preflight described below before any `101`; there is no check/acquire gap and no global key in a multi-key script.

Renewal exact-compares and applies `PEXPIRE 30000`. Deadline math uses the monotonic timestamp captured before the Redis call; slow/indeterminate/mismatch expires forwarding. `beginClose` exact-compares and extends a 30-second **non-forwarding** close window without changing the forwarding deadline. For desktop, `still_owner` proceeds to write-ahead intent before detach/stop; for terminal/tunnel it may perform their normal close. `owner_mismatch` does stale local-only detach with no agent stop/finalization. `unavailable` leaves the entry inert; desktop performs safety detach/stop after the failed write-ahead attempt and relies on retry/orphan recovery. Release is exact compare-delete only after forwarding is expired.

A topology monitor checks `INFO replication`, `INFO persistence`, `CONFIG GET maxmemory-policy`, and `INFO cluster` before admission and periodically thereafter. Only role `master`, AOF enabled, `noeviction`, `cluster_enabled:0`, and configured `standalone-single-primary` are supported in production. Unknown state, Redis restart/failover, replica promotion, a topology transition, or stale monitor data freezes acquire with `unsupported_topology|unavailable` and expires existing forwarding. Cluster mode exists only in integration to prove hash-slot/Lua correctness; enabling it for production requires an explicit future design with agent-sink fencing.

The process-local map never generates identity. `installLocalRemoteConnection` accepts only a successful shared claim. Every event/callback/timer first calls `ownsSafeRemoteConnection`, which requires the exact map entry, all four identity fields, object-identical `WSContext`, and `monotonicNow < safeForwardingUntilMonotonicMs`. Renewal may update only the matching entry's deadline. When the event loop resumes after a pause beyond the deadline, old callbacks are inert before any forwarding. Opening setup must bind within 15 seconds; its exact expiry callback closes locally and compare-releases the shared claim only when the same opening identity remains.

Create `apps/api/src/services/remoteWsAuthorization.ts`:

```typescript
export interface ValidatedRemoteWsContext {
  sessionId: string;
  sessionType: RemoteWsKind;
  userId: string;
  orgId: string;
  siteId: string | null;
  deviceId: string;
  agentId: string;
  permission: {
    resource: typeof PERMISSIONS.REMOTE_ACCESS.resource;
    action: typeof PERMISSIONS.REMOTE_ACCESS.action;
  };
  ticketAssurance:
    | { kind: 'mfa_v2'; mfaSatisfied: true }
    | { kind: 'legacy_viewer_compatibility'; mfaSatisfied?: never }
    | { kind: 'legacy_unversioned_v0'; mfaSatisfied?: never };
  ticketJti: string | null;
  connection: RemoteConnectionIdentity;
}

export interface ConsumedRemoteWsTicketContext {
  sessionId: string;
  sessionType: RemoteWsKind;
  userId: string;
  ticketAssurance: ValidatedRemoteWsContext['ticketAssurance'];
  ticketJti: string | null;
}

export type RemoteWsTicketIntakeResult =
  | { ok: true; ticket: ConsumedRemoteWsTicketContext }
  | {
      ok: false;
      status: 401 | 403 | 503;
      reason:
        | 'ticket_missing'
        | 'ticket_invalid'
        | 'ticket_mismatch'
        | 'ticket_version_not_allowed'
        | 'mfa_unassured'
        | 'authorization_unavailable';
    };

export type RemoteWsAuthorizationResult =
  | { ok: true; context: Omit<ValidatedRemoteWsContext, 'connection'> }
  | {
      ok: false;
      status: 403 | 404 | 429 | 503;
      reason:
        | 'user_inactive'
        | 'session_missing'
        | 'session_inactive'
        | 'session_not_owned'
        | 'site_denied'
        | 'permission_denied'
        | 'device_offline'
        | 'policy_denied'
        | 'rate_limited'
        | 'authorization_unavailable';
    };

export async function consumeRemoteWsUpgradeTicket(input: {
  sessionId: string;
  expectedType: RemoteWsKind;
  ticket: string | undefined;
  mode: RemoteWsAuthMode;
  caller: { ip: string; userAgent: string };
}): Promise<RemoteWsTicketIntakeResult>;
export async function authorizeConsumedRemoteWsTicket(
  consumed: ConsumedRemoteWsTicketContext
): Promise<RemoteWsAuthorizationResult>;
```

Extend the one-time ticket record in `apps/api/src/services/remoteSessionAuth.ts`:

```typescript
export const WS_TICKET_TTL_SECONDS = 60;
export const HTTP_TUNNEL_TICKET_TTL_SECONDS = 300;
export const HTTP_TUNNEL_COOKIE_TTL_SECONDS = 300;

export interface RemoteWsTicketRecordV0 {
  version?: never;
  sessionId: string;
  sessionType: 'terminal' | 'desktop' | 'tunnel' | 'tunnel-http';
  userId: string;
  expiresAt: number;
  ip?: string;
  uaHash?: string;
}

export interface RemoteWsTicketRecordV1 {
  version: 1;
  jti: string;
  sessionId: string;
  sessionType: 'desktop' | 'tunnel';
  userId: string;
  expiresAt: number;
  ip?: string;
  uaHash?: string;
}

export interface RemoteWsTicketRecordV2 {
  version: 2;
  jti: string;
  sessionId: string;
  sessionType: 'terminal' | 'desktop' | 'tunnel' | 'tunnel-http';
  userId: string;
  mfaSatisfied: boolean;
  expiresAt: number;
  ip?: string;
  uaHash?: string;
}

export type RemoteWsTicketRecord =
  | RemoteWsTicketRecordV0
  | RemoteWsTicketRecordV1
  | RemoteWsTicketRecordV2;
```

The ticket secret remains the Redis/map key and is never copied into context. `ConsumedRemoteWsTicketContext.ticketJti` is canonically `string | null`: a consumed V0 record returns literal `null`, with no cast, derived placeholder, hash, or fabricated version; V1/V2 return their stored random JTI. `tunnel-http` keeps its existing HTTP path and is not accepted by remote WebSocket validation. Its ticket and scoped cookie lifetimes both come from the exported 300-second constants; the WebSocket ticket remains 60 seconds. Every lease-aware normal issuer creates V2 with `mfaSatisfied: true`. The only V1 writer is a `post_upgrade` same-session legacy-viewer JWT exchange. V0/V1 intentionally have no MFA field and are accepted only by `post_upgrade`; both are rejected in `pre_upgrade` even if unknown/forged fields are present.

Compatibility tests use an immutable `RemoteWsTicketRecordV0` fixture matching the pre-wave writer exactly. They run both directions: old unversioned writer → new reader succeeds only in `post_upgrade`, and new V2 writer → the frozen old reader tolerates additive fields and consumes the record. The external cutover still drains all old writers behind the closed barrier for both `WS_TICKET_TTL_SECONDS` and `max(HTTP_TUNNEL_TICKET_TTL_SECONDS, HTTP_TUNNEL_COOKIE_TTL_SECONDS)`; parser compatibility is rollback defense, not authorization to mix binaries.

Extend the signed viewer-token claims in `apps/api/src/services/jwt.ts`:

```typescript
export type ViewerTokenAssurance =
  | {
      mfaSatisfied: true;
      assuranceAbsoluteExpiresAt: number;
    }
  | {
      mfaSatisfied?: never;
      assuranceAbsoluteExpiresAt?: never;
    };
```

A root viewer JWT minted from a live `requireMfa()` request sets `mfaSatisfied: true` and `assuranceAbsoluteExpiresAt` equal to its signed `exp`. A descendant minted by `/api/v1/vnc-viewer/upgrade-to-webrtc` or `/api/v1/vnc-viewer/downgrade-to-vnc` requires an input with true MFA assurance, copies the same root `assuranceAbsoluteExpiresAt`, and signs `exp = min(now + VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS, assuranceAbsoluteExpiresAt)`. It must reject a missing/false claim, an invalid absolute-expiry claim, or an already exhausted lineage before any side effect. A legacy no-claim token remains usable only for a same-session `post_upgrade` compatibility ticket; it may never enter either transition or mint a descendant viewer JWT.

Create `apps/api/src/services/remoteWsUpgrade.ts`:

```typescript
export type RemoteWsAuthMode = 'post_upgrade' | 'pre_upgrade';

export type RemoteWsUpgradeContext =
  | {
      authorizationPhase: 'ticket_only';
      ticket: ConsumedRemoteWsTicketContext;
      connection: RemoteConnectionIdentity;
    }
  | {
      authorizationPhase: 'complete';
      authorization: ValidatedRemoteWsContext;
    };

export function requireRemoteWsUpgrade(
  options: {
    expectedType: RemoteWsKind;
    sharedLeases: ReturnType<typeof createRemoteWsSharedLeaseManager>;
    installLocal: (
      sessionId: string,
      claim: RemoteWsSharedLeaseClaim
    ) => InstallLocalConnectionResult;
  }
): MiddlewareHandler;
```

In both modes the middleware consumes and verifies the one-time ticket record, caller binding, path, session ID, and type before owner acquisition; an unauthenticated or mismatched request cannot reserve. In `pre_upgrade`, it accepts only V2 true, completes live authorization, acquires/installs ownership, and stores `complete` context before upgrade. In `post_upgrade`, it may accept truthful V0 or V1 compatibility, acquires before `101`, stores `ticket_only`, and performs remaining live DB authorization in `onOpen`. Failure closes/releases only the exact owner.

Create `apps/api/src/services/remoteWsDrainGate.ts`:

```typescript
export interface RemoteWsDrainDeadlines {
  legacyV0WsTicketsExpireAtMs: number;
  legacyV0HttpCredentialsExpireAtMs: number;
  admissionReopenNotBeforeMs: number;
  viewerTokensExpireAtMs: number;
  preUpgradeNotBeforeMs: number;
}

export function getRemoteWsDrainDeadlines(
  legacyTicketWriterDrainedAtMs: number,
  legacyViewerIssuerDrainedAtMs: number
): RemoteWsDrainDeadlines;
export function assertRemoteWsPreUpgradeDrainComplete(input: {
  mode: RemoteWsAuthMode;
  legacyTicketWriterDrainedAt: string | undefined;
  legacyViewerIssuerDrainedAt: string | undefined;
  nowMs?: number;
}): void;
```

The helper derives two independent V0 deadlines from the same verified last-old-writer timestamp: WebSocket records use `WS_TICKET_TTL_SECONDS` (60 seconds), while tunnel-HTTP one-time tickets and already minted scoped cookies use `max(HTTP_TUNNEL_TICKET_TTL_SECONDS, HTTP_TUNNEL_COOKIE_TTL_SECONDS)` (300 seconds). Clock tolerance is fixed at zero for both cookie signing verification and this gate; if implementation introduces a nonzero verifier tolerance, add that exported tolerance to the HTTP deadline rather than relying on an operator estimate. `admissionReopenNotBeforeMs` is the later V0 deadline, so production/staging refuses to reopen the external barrier until both have elapsed. The helper separately derives the legacy-viewer deadline from `legacyViewerIssuerDrainedAt + VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS + WS_TICKET_TTL_SECONDS`; `pre_upgrade` requires the admission deadline and viewer deadline. Missing, invalid, future, or unverified timestamps fail closed. `post_upgrade` remains the only compatible mode during the viewer drain, but it does not authorize reopening before both V0 sub-drains.

Desktop lifecycle:

```typescript
export async function closeDesktopSessionLifecycle(
  sessionId: string,
  options: {
    expectedWs: WSContext;
    connection: RemoteConnectionIdentity;
    reason: 'client_close' | 'socket_error' | 'pong_timeout' | 'revoked' | 'setup_failed';
    terminalStatus: 'disconnected' | 'failed';
    notifyAgent: boolean;
  }
): Promise<void>;
```

The function returns the existing in-flight promise for duplicate matching calls and does nothing for a foreign/stale socket. It synchronously makes the exact entry non-forwarding and freezes input, then attempts write-ahead persistence. With acknowledgement, socket/callback detach and stop follow the intent; with Redis unavailable/indeterminate, safety detach/stop still follows the failed attempt and orphan recovery covers process loss.

Create `apps/api/src/services/desktopSessionFinalization.ts`:

```typescript
export interface DesktopSessionFinalizationInput {
  version: 1;
  finalizationId: string;
  sessionId: string;
  connection: RemoteConnectionIdentity;
  orgId: string;
  userId: string;
  deviceId: string;
  reason:
    | 'client_close'
    | 'socket_error'
    | 'pong_timeout'
    | 'revoked'
    | 'setup_failed'
    | 'orphan_recovery';
  terminalStatus: 'disconnected' | 'failed';
  endedAt: string;
  startedAt: string;
  inputEvents: number;
  frameBytes: number;
}

export interface PersistedDesktopFinalizationIntent {
  input: DesktopSessionFinalizationInput;
  canonicalPayload: string;
  payloadSha256: string;
}

export async function persistDesktopFinalizationIntent(input: {
  finalization: DesktopSessionFinalizationInput;
  sharedOwner: RemoteWsSharedLeaseClaim;
}): Promise<PersistedDesktopFinalizationIntent>;
export async function getDesktopFinalizationIntent(
  sessionId: string
): Promise<PersistedDesktopFinalizationIntent | null>;
export async function recoverDesktopFinalizationOrphan(input: {
  sessionId: string;
  trigger: 'admission' | 'background' | 'operator';
}): Promise<'not_orphaned' | 'finalized' | 'already_finalized' | 'retained'>;
export async function inspectDesktopFinalization(
  sessionId: string
): Promise<
  | { state: 'persisted'; intent: PersistedDesktopFinalizationIntent; jobState: string | null }
  | { state: 'orphan_candidate'; sessionId: string; sessionStatus: string }
  | { state: 'none'; sessionId: string; sessionStatus: string }
>;
export async function releaseDesktopFinalizationIntent(
  sessionId: string,
  finalizationId: string,
  expectedCanonicalPayload: string
): Promise<boolean>;
export async function reconcileDesktopFinalizationFence(input: {
  sessionId: string;
  expectedFinalizationId: string;
  operatorUserId: string;
  operatorEmail: string;
  changeTicket: string;
}): Promise<'released' | 'retained'>;
export async function finalizeDesktopSessionOnce(
  input: DesktopSessionFinalizationInput
): Promise<'stop_pending' | 'finalized' | 'already_finalized'>;
```

Create `apps/api/src/services/desktopSessionStop.ts`:

```typescript
export type DesktopStopProof =
  | {
      state: 'confirmed';
      commandId: string;
      outcome: 'stopped' | 'already_absent';
    }
  | {
      state: 'pending';
      commandId: string;
      reason: 'agent_disconnected' | 'delivery_unacknowledged' | 'result_unavailable';
    };

export async function ensureDesktopStreamStopped(
  input: DesktopSessionFinalizationInput
): Promise<DesktopStopProof>;
```

The command ID is exactly the finalization UUID. In a system DB transaction, `ensureDesktopStreamStopped` inserts an existing-table `device_commands` row with that ID, exact device ID, type `desktop_stream_stop`, and bounded payload `{ sessionId, finalizationId }`, or on conflict proves every immutable field matches. It never replaces a conflicting row. Pending/sent/failed-without-terminal-proof rows are safely re-armed for delivery with the same ID; the existing WebSocket/heartbeat command-delivery paths may race because the agent sink is idempotent. `agent/internal/heartbeat/handlers_desktop.go` executes `StopSession(sessionId)` on every delivery of this type and returns a bounded result naming the same session/finalization ID plus `stopped|already_absent`; `desktop_stream_stop` bypasses the generic mark-seen-before-execute shortcut, because a crash after marking but before stop is not proof. Repeated delivery after an API or agent restart is a safe no-op that returns `already_absent`.

Only an exact completed `device_commands` row whose validated agent result proves `stopped|already_absent` is terminal-safe. A `duplicate`, timeout, send success, disconnected agent, stale agent connection, missing result, or API-side observation that the session is absent is not terminal-safe. Those states return `stop_pending`, retain the non-expiring intent, keep admission blocked, and retry through the durable row. This wave does not infer safety from agent disconnection or delete the stop row as cleanup.

`finalizeDesktopSessionOnce` calls `ensureDesktopStreamStopped` before viewer-session revocation or any remote-session database update. On `pending`, it returns `stop_pending` without finalization, summary audit, or intent deletion. After confirmed stop, it performs idempotent viewer-session revocation, then opens one system DB transaction. In that transaction it conditionally updates only `pending|connecting|active` rows and uses `RETURNING`; only the transaction that receives a row inserts `desktop.session.summary`. The update and audit insert commit or roll back together. A duplicate worker invocation that receives no row still requires confirmed stop before it returns `already_finalized` and permits pair deletion. Audit details include bounded reason/status/counters, stop-command ID/outcome, and a fingerprint of `finalizationId`, never a ticket or raw connection ID.

`persistDesktopFinalizationIntent` is write-ahead. After the local entry becomes inert `closing` and its immutable input is frozen—but before socket/callback detach or agent stop—it canonicalizes/validates the complete input and uses one Lua script while the exact shared desktop owner is still stored. The script compares the full owner value, requires both finalization keys to be absent or already contain the exact same values, and writes:

- `remote:ws:{desktop:${sessionId}}:finalizing` = exact random `finalizationId`;
- `remote:ws:{desktop:${sessionId}}:finalization-payload` = `finalizationId`, SHA-256 fingerprint, and the complete canonical payload.

Neither write receives an expiry option. A same-ID/same-payload retry is idempotent; a different ID, different payload, partial key pair, or owner mismatch fails closed and is never overwritten. `releaseDesktopFinalizationIntent` passes the exact ID and exact canonical payload to one Lua script that compare-deletes **both** keys or neither. Intent age comes from the validated persisted `endedAt`, not mutable Redis metadata. Missing Redis connectivity or an indeterminate reply rejects rather than pretending either key is absent.

If Redis is unavailable before write-ahead acknowledgement, the server still detaches and attempts an immediate safety stop but keeps the local/shared entry inert and closing while retrying. A crash can erase that local evidence. `recoverDesktopFinalizationOrphan` therefore treats `connecting|active`, or `pending` older than a documented 90-second grace, as an orphan candidate only when the shared owner and both intent keys are absent on two Redis observations separated by one full lease TTL and the database row remains nonterminal. One Lua script then claims a synthesized `orphan_recovery` intent in the same desktop hash slot. Admission returns `409 orphan_recovery` and never opens the stale session; the background reconciler or admission path calls `ensureDesktopStreamStopped` and conditionally finalizes only after terminal-safe agent acknowledgement. A disconnected agent leaves the durable stop pending and the intent/admission block in place. Redis/topology uncertainty returns `503`, never “not orphaned.”

Normal code may release only after `finalizeDesktopSessionOnce` returns `finalized|already_finalized`, which itself proves the exact durable stop acknowledgement. A persisted intent whose database row is still nonterminal is the primary valid recovery case and **must** be stopped and finalized from its exact payload; it is not grounds for reconciliation refusal. The inspect GET loads intent/job/session/stop-command state by session ID and returns a bounded schema containing the server-side finalization ID, validated payload fields, and `pending|confirmed` stop state, never Redis owner values/tokens or raw agent output. Explicit reconciliation proves no reusable job exists, compares the operator-confirmed ID to the current persisted ID, calls `ensureDesktopStreamStopped`, and returns `retained` without finalization/audit/delete while the stop is pending. After confirmed stop it finalizes a nonterminal row or observes an already terminal row, synchronously writes `desktop.session.finalization_reconciled` with exact payload fingerprint/change ticket/operator/stop proof, and only then compare-deletes both values. Any mismatch, missing stop proof, audit failure, or Redis compare failure returns `retained`. Never release by age.

Create `apps/api/src/jobs/desktopSessionFinalizationWorker.ts`:

```typescript
export async function enqueueDesktopSessionFinalization(
  input: { sessionId: string; finalizationId: string }
): Promise<{ acknowledged: true; jobId: string }>;
export async function initializeDesktopSessionFinalizationWorker(): Promise<void>;
export async function shutdownDesktopSessionFinalizationWorker(): Promise<void>;
```

Use stable job ID `desktop-finalize-${sessionId}-${finalizationId}`, five attempts, exponential backoff beginning at one second, and bounded completed/failed retention. `queue.add(...)` returning that exact stable job ID is the acknowledgement boundary. The job contains only the lookup identity; the worker loads and validates the non-expiring canonical payload, calls `finalizeDesktopSessionOnce`, and treats `stop_pending` as retryable without database finalization or pair deletion. It compare-deletes both Redis values only after `finalized|already_finalized`, which includes confirmed stop proof. Missing/mismatched payload, disconnected/unacknowledged agent, retry exhaustion, and retention removal all leave both values and the durable stop row in place for worker/operator recovery. Desktop shared-owner acquisition checks both durable keys atomically before installing an owner, so a process restart cannot allow a new owner while stop/finalization is pending.

Create the callable recovery surface:

- `apps/api/src/routes/admin/desktopFinalization.ts` exposes MFA-protected `GET /api/v1/admin/desktop-finalizations/:sessionId` for bounded inspection and `POST /api/v1/admin/desktop-finalizations/:sessionId/reconcile` for mutation, both under existing `platformAdminMiddleware`.
- GET validates the session UUID and returns only the discriminated inspection schema: persisted exact ID plus validated bounded payload/job/session/stop-proof state, orphan-candidate state, or none. It never returns owner values, lease tokens, ticket material, Redis keys, raw agent results, or arbitrary raw JSON.
- POST validates session/expected-finalization UUIDs and a trimmed 3–128 character change-ticket identifier containing only letters, digits, `.`, `_`, `:`, `/`, or `-`. It derives operator ID/email from `auth`; immediately before reconciliation, standard authentication has reloaded an active user and `platformAdminMiddleware` has re-proved live `isPlatformAdmin=true`.
- `scripts/security/reconcile-desktop-finalization.ts` is the only CLI. `inspect` discovers the server-side ID/payload by session ID. `reconcile` first performs that GET, requires `--expected-finalization-id` to match, then calls POST. Output is bounded/redacted; there is no `--force`, `--age`, direct Redis, or direct database mode.
- `internal/operations/desktop-finalization-reconciliation.md` is the private, gitignored runbook. It documents authorization, queue inspection, exact command invocation, approval/change-ticket handling, evidence capture, and abort conditions; never stage or commit it.

The callable form is exact; the access token is read from the named environment variable and must never appear in argv:

```bash
BREEZE_OPERATOR_ACCESS_TOKEN='<short-lived-token>' pnpm exec tsx \
  scripts/security/reconcile-desktop-finalization.ts \
  inspect \
  --api-base-url 'https://<api-host>/api/v1' \
  --session-id '<session-uuid>'

BREEZE_OPERATOR_ACCESS_TOKEN='<short-lived-token>' pnpm exec tsx \
  scripts/security/reconcile-desktop-finalization.ts \
  reconcile \
  --api-base-url 'https://<api-host>/api/v1' \
  --session-id '<session-uuid>' \
  --expected-finalization-id '<id-returned-by-inspect>' \
  --change-ticket '<private-change-ticket>'
```

## Configuration, Deployment, and Drain Contract

Add:

```dotenv
REMOTE_ACCESS_ADMISSION_MODE=open
REMOTE_WS_AUTH_MODE=post_upgrade
REMOTE_WS_REDIS_TOPOLOGY=standalone-single-primary
REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT=
REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT=
```

Validate all enumerations and require explicit production/staging values. Map the auth/topology/drain values into API and `REMOTE_ACCESS_ADMISSION_MODE` into Caddy in `docker-compose.yml` and `deploy/docker-compose.prod.yml`. Add them to `.env.example`, `deploy/.env.example`, `deploy/compose-config-test.env`, and the required-variable/enum checks in `scripts/prod/deploy.sh`. The deploy check prints and independently verifies the 60-second WebSocket V0 deadline and 300-second tunnel-HTTP ticket/cookie V0 deadline, then uses their maximum as the only permitted barrier-reopen timestamp.

In `docker/Caddyfile.prod`, place the maintenance handler before the general API proxy. When mode is `closed`, return bounded `503` plus `Retry-After` for every ticket issuer and upgrade route:

```text
/api/v1/remote/sessions/*/ws-ticket
/api/v1/desktop-ws/*/viewer/ws-ticket
/api/v1/tunnels/*/ws-ticket
/api/v1/tunnels/*/http-ticket
/api/v1/vnc-exchange/*
/api/v1/vnc-viewer/downgrade-to-vnc
/api/v1/remote/sessions/*/ws
/api/v1/desktop-ws/*/ws
/api/v1/tunnel-ws/*/ws
/api/v1/tunnel-http/*
```

The final matcher is intentionally broad for `/api/v1/tunnel-http/*`: it blocks first-navigation `?__bzt=` ticket consumption, the redirect target, and all later scoped-cookie subresource/proxy requests. There is no cookie-auth bypass while admission is closed. This Caddy gate is the authoritative cutover barrier because a pre-wave API does not know any new in-process flag. Add a contract test that enumerates every `createWsTicket` callsite, every mounted remote upgrade, the tunnel-HTTP wildcard route, and its ticket/cookie authentication branches; it fails if any externally mounted path is absent from the matcher. Changing the environment requires Caddy recreation/reload; the deploy script verifies the effective Caddy config and probes issuer, upgrade, V0 HTTP ticket, and valid-cookie requests through the proxy, not merely the env file.

Deployment phases:

1. **Barrier prerequisite release:** deploy only the Caddy barrier capability and deploy-script/tests while the whole API pool remains pre-wave. Close it, prove all enumerated issuer/upgrade paths and `/api/v1/tunnel-http/*` with both a V0 ticket and a previously valid scoped cookie return `503` while unrelated API health remains available, then reopen. Do not deploy lease code in this phase.
2. **Begin lease cutover:** close the external barrier and verify it from outside the proxy. Stop new ticket issuance and tunnel-HTTP cookie mint/consumption, drain for a bounded operator window, force-close remaining remote WebSockets, and stop the complete old API pool.
3. Enumerate containers/processes/image digests and proxy connection state. Require zero old API processes, zero old upgraded remote connections, and zero reachable ticket issuer/upgrade/tunnel-HTTP consumer path. Record `legacy_ticket_writer_drained_at` only now; `/health` and desired replica count are insufficient.
4. Keep the barrier closed while independently proving `legacy_ticket_writer_drained_at + WS_TICKET_TTL_SECONDS` (60 seconds) and `legacy_ticket_writer_drained_at + max(HTTP_TUNNEL_TICKET_TTL_SECONDS, HTTP_TUNNEL_COOKIE_TTL_SECONDS)` (300 seconds). Do not reopen before the later deadline. At the 60-second boundary prove old WebSocket tickets are dead while both V0 HTTP ticket and cookie probes remain blocked by the barrier; at the 300-second boundary prove both HTTP credentials are expired even if the barrier were opened in the harness. Run the Redis preflight: standalone single primary, AOF on, `noeviction`, cluster disabled, no promotion/failover in progress, and topology monitor fresh. Any unknown/HA topology or either incomplete sub-drain aborts with the barrier closed.
5. Start the **entire** API pool on the same lease-aware artifact with V0/V1/V2 reader, V2 writers, shared lease/orphan recovery, and `post_upgrade`. Require every expected instance to report the exact image digest and lease protocol version; reject any old/unknown process. Run old-binary/new-binary two-process tests behind the still-closed barrier.
6. Reopen the barrier only after all prior evidence passes. Observe stale/deadline/orphan counters and prove no cross-replica forwarding overlap for a full remote-session window. Deploy client handshake retry if not already present.
7. Separately drain every legacy viewer-JWT issuer. Keep all instances `post_upgrade` for `VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS` (7,200 seconds) from verified removal and one subsequent `WS_TICKET_TTL_SECONDS` (60 seconds).
8. Only then canary `pre_upgrade` within the already lease-aware pool at one instance, 10%, 50%, and 100%; mixed auth modes are allowed, mixed lease protocols are not. After 100%, drain `post_upgrade` instances and keep mode explicit.

Every rollback starts by closing/probing the external barrier, including `/api/v1/tunnel-http/*` under both ticket and cookie authentication. Stop the full current pool, force-close sockets, prove zero processes/connections, and start only the first shared-lease-aware Wave 4 binary in `post_upgrade`; never roll back to pre-lease admission. Reopen only after whole-pool/version/topology checks and fresh independent 60-second WebSocket plus 300-second tunnel-HTTP credential sub-drains from the last writer/consumer-capable old process, using the later deadline. V0/V1/V2 records remain discriminated; the frozen compatibility test proves a lease-aware V2 record is readable by the historical reader, but rollback never uses parser tolerance to justify mixed live pools.

---

## Task Execution Order (corrected 2026-07-25 — read before starting any task)

**Execute in this order, NOT in numeric order:** 1 → 2 → 3 → **[5+6 as ONE combined slice]** → **7** → **4** → 8 → 9 → 10.

Dependency evidence (each edge verified against this document, not inferred):

| Edge | Evidence |
|---|---|
| 5 before 7 | Task 5 **Creates** `desktopSessionFinalization.ts` and `desktopSessionOrphanRecovery.ts` (+ their tests); Task 7 lists the same four files as **Modify**. They do not exist in `HEAD`. |
| 5 before 6 | Task 6's `Consumes` line names "desktop lifecycle"; Task 5's `Produces` line supplies `closeDesktopSessionLifecycle` / `ensureDesktopStreamStopped` / `finalizeDesktopSessionOnce`. |
| 6 before 7 | Task 7 also modifies `desktopWs.ts` and `tunnelWs.ts`, which Task 6 binds to exact ownership. Running 6 first avoids rewriting those routes twice. |
| 7 before 4 | Task 4 requires the lease to be acquired before the `101` upgrade; the pre-upgrade validate-and-reserve seam (`remoteWsUpgrade.ts`) is created by Task 7. |

A previous revision of this note ordered Task 7 before 5 and 6. That was wrong: it left Task 7
modifying files that no task had yet created. The 5 → 6 → 7 → 4 chain is the only order in which
every task's declared inputs exist when it runs.

Note that Task 5 spans the Go agent (`agent/internal/heartbeat/`,
`agent/internal/remote/desktop/`) as well as the API, so it must also satisfy
`cd agent && go test -race ./...`.

## Coordinator Decisions (2026-07-25) — both APPROVED, implement as written

**D1 — Legacy stop-command compatibility is REQUIRED, not optional.** Strict `finalizationId`
validation would make a new agent reject the current API's legacy `{sessionId}` stop command,
breaking the mixed old/new fleet. The program's global constraints already mandate maintaining the
documented old/new API and agent compatibility window and draining old instances before declaring
enforcement complete, so a compatibility branch is obligatory here.

Implement: accept and execute a legacy stop command when `finalizationId` is ABSENT, but reserve
durable stop proof exclusively for exact ID-bound results. A legacy stop may terminate the stream;
it may never satisfy `ensureDesktopStreamStopped`'s durable-proof requirement or stand in for exact
acknowledgement. Cover both branches with tests, and make the legacy branch's non-proof explicit in
an assertion rather than implied.

**D2 — Fix the success-audit-before-denial defect in `platformAdminMiddleware`; the file-list
exception is APPROVED.** `apps/api/src/middleware/platformAdmin.ts` calls `createAuditLogAsync({...
result: 'success' })` before `await next()`, so a downstream denial (route-level MFA enforcement)
is recorded as a SUCCESSFUL platform-admin action. This violates the global invariant that a denied
request performs no mutation, queue submission, system-context transition, external call, snapshot,
email, or success audit.

Implement: record the success audit only after downstream authorization actually succeeds. Do not
drop the denial from the record — a denied attempt should still be auditable, but never as
`result: 'success'`. Add a regression test proving a downstream 403 does not emit a success audit.

`platformAdmin.ts` is assigned to WAVE 4 for this fix. Wave 7 must not modify that file, to avoid a
cross-wave merge conflict on a security-audit path.

**D4 — `apps/web/src/components/remote/VncViewer.tsx` is added to Task 8's file list (approved
2026-07-26).** Task 8 requires that a pre-open rejection become a distinct recoverable state while
"after `open`, preserve existing disconnected behavior". Those cannot both hold with the file list as
written: `VncViewer` reports only a bare `onDisconnect()`, so `VncViewerPage` cannot tell a refused
handshake from a post-open drop. Implementing Task 8 within the original list forced every viewer
disconnect to become recoverable — which stops the page from releasing the tunnel on an ordinary
post-open disconnect, leaving a live network path to a customer device open until it times out. That
is a worse outcome than the defect the task exists to fix.

`VncViewer` already has both facts: it registers a `connect` listener and reads `detail.clean` on
disconnect. It simply does not forward them. Implement: widen `onDisconnect` to carry whether the
session had opened and whether the close was clean, and have `VncViewerPage` present the
rejected/Retry state ONLY when the session never opened, restoring the previous
release-tunnel-and-navigate behavior for post-open disconnects. Cover both branches with tests.

Task numbering is retained so every existing cross-reference stays valid; only the execution sequence
changes.

Why: Tasks 4 and 6 require a lease to be acquired *before* the `101` upgrade, but ticket validation
in the current code happens *after* upgrade, and the pre-upgrade validate-and-reserve machinery
(`remoteWsUpgrade.ts`) is created by Task 7. Attempting Task 4 first forces one of two unacceptable
outcomes: acquire the lease before validating the ticket — which lets an INVALID ticket reserve
session ownership and violates the global invariant that a denied request performs no mutation,
queue submission, or reservation — or leave acquisition after upgrade, which is the very defect the
wave exists to close. Task 7 also modifies `terminalWs.ts` and `desktopWs.ts`, the same files Tasks
4 and 6 own, so running it first avoids re-litigating those routes twice.

**Tasks 5 and 6 are ONE combined execution slice — implement them together.** An earlier revision of
this note said Task 5 "runs after both" 6 and 7 while the order line put 5 first. That was a
self-contradiction, and resolving it exposed a genuine cycle rather than a wrong sequence:

- Task 5 **creates** `desktopSessionFinalization.ts` / `desktopSessionOrphanRecovery.ts`, which
  Task 7 **modifies** — so 5 precedes 7.
- Task 6's `Consumes` names the desktop lifecycle that Task 5 **produces** — so 5 precedes 6.
- But Task 5's `beginClose` and write-ahead-before-detach require an exact desktop shared owner, and
  `apps/api/src/routes/desktopWs.ts` today has NO shared lease claim and NO owner acquisition
  (verified: zero references to the lease manager). Task 6 introduces that — so 6 precedes 5.

5 and 6 are therefore mutually dependent. Splitting them requires inventing a weaker interim
ownership design, which is forbidden. Implement the desktop ownership binding and the desktop
teardown lifecycle in a single slice, satisfying both tasks' step lists and both tasks' red-green
gates. Effective order: 1 → 2 → 3 → **[5+6 together]** → 7 → 4 → 8 → 9 → 10.

**File-list exceptions APPROVED for the combined 5+6 slice** (each is required by the slice and
belongs to no other in-flight wave):

- `apps/api/src/services/remoteWsSharedLease.ts` (+ its test) — safe intent observation.
- `apps/api/src/services/viewerTokenRevocation.ts` (+ its test) — fail-closed viewer revocation.

Keep the delete-last and idempotency guarantees intact across the merged slice; a combined slice is
not licence to relax either.

**D3 — `remote/sessions.ts` is in scope for the 5+6 slice (approved 2026-07-25).** Task 2 made
`revokeViewerSession` fail closed: it now throws `viewer session revocation unavailable` when Redis
is down. That is correct — never report a token revoked when it was not. But
`apps/api/src/routes/remote/sessions.ts` awaits it unguarded at two call sites (~:1087, ~:1225), so
a Redis outage during a consent-deny now aborts the rest of the handler, skipping both the denial
audit and the desktop safety stop.

Fail-closed on the TOKEN must not become fail-open on the STREAM. Ensure the desktop safety stop is
attempted and the denial is audited even when viewer revocation throws, and that the request still
fails closed to the caller. Do not "fix" this by making revocation swallow its error.

**Out of scope here, deferred to Task 4:** `apps/api/src/routes/agentWs.ts`, where stale or
superseded agent sockets can still submit stop results and need exact delivery-epoch proof. That
file is already assigned to Task 4, which runs after Task 7 in the corrected order.

Two scope corrections, folded into Task 4:

- `apps/api/src/routes/agentWs.ts` has an identifier-only late terminal-start failure callback that
  must be bound to the exact lease. It was missing from Task 4's file list; add it.
- `apps/api/src/services/remoteSessionTeardown.ts` expects a synchronous
  `closeTerminalSession(...): boolean`, but the exact `beginClose` is asynchronous. Reconcile the
  caller rather than making `beginClose` synchronous — teardown must remain idempotent and
  delete-last.

Task 4 Step 1's "two route instances with separate local maps" is satisfied against the shared lease
manager using two distinct instance identities. Route maps are module-global, so do NOT attempt to
instantiate the route module twice; drive the second identity through the lease manager directly.

---

### Task 1: Lock socket lease identity and reservation semantics

**Files:**
- Create: `apps/api/src/services/remoteWsOwnership.ts`
- Create: `apps/api/src/services/remoteWsOwnership.test.ts`
- Create: `apps/api/src/services/remoteWsSharedLease.ts`
- Create: `apps/api/src/services/remoteWsSharedLease.test.ts`
- Create: `apps/api/src/services/remoteWsRedisTopology.ts`
- Create: `apps/api/src/services/remoteWsRedisTopology.test.ts`

**Interfaces:**
- Produces: Redis-generated `RemoteWsSharedLeaseClaim`, exact Lua acquire/renew/release, `RemoteConnectionLease`, local install/bind/safe-ownership/removal helpers, and lease-loss callbacks.

- [ ] **Step 1: Write failing lease tests**

Cover:

- first Redis acquisition succeeds with independent nonempty connection/instance/lease UUIDs and a per-kind/session Redis-monotonic generation;
- a second manager instance sharing Redis receives `already_owned` while the first owner is opening/active/closing;
- desktop acquisition checks owner, exact-ID fence, and payload key in the same Lua script;
- only an exact owner value renews or releases; stale generations/tokens cannot extend or delete a new owner;
- acquire/renew calculates `safeForwardingUntilMonotonicMs` from request start and rejects replies slower than two seconds;
- renewal timeout, Redis error, malformed reply, or owner mismatch expires local forwarding before cleanup;
- exact-owner close proof permits stop/finalization only for `still_owner`; a mismatch or replacement performs local-only stale detach with no agent stop/session write;
- a simulated event-loop pause beyond the forwarding deadline makes the old owner inert even while the Redis key has remaining TTL;
- a partitioned owner stops at least ten seconds before another manager can acquire after Redis expiry;
- every Lua key for terminal, desktop, and tunnel shares the exact `{kind:sessionId}` hash tag, including generation/fence/payload, and no script references a global key;
- topology accepts only fresh standalone primary + AOF + `noeviction` + cluster-disabled evidence; unknown/stale/failover/replica/cluster/eviction states freeze admission;
- only the matching identity can bind;
- ownership requires exact map entry, all identity fields, object-identical `WSContext`, and an unexpired safe deadline;
- a stale close cannot release a newer generation;
- opening expiry releases only the same unbound local and shared generation;
- generation continues increasing across manager instances and API-process restart.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/remoteWsOwnership.test.ts \
  src/services/remoteWsSharedLease.test.ts \
  src/services/remoteWsRedisTopology.test.ts
```

Expected: FAIL because the local and shared ownership services do not exist.

- [ ] **Step 3: Implement Redis fencing and synchronous map operations**

Use a service factory so tests can construct two managers with different fixed instance IDs against the same Redis. Allocate per-kind/session generation and install the owner in one hash-slot-local Lua script, then implement renew, `beginClose`, orphan claim, intent write, and release with exact canonical comparison. No Lua script may reference a global/cross-slot key. Never log `ownerValue` or `leaseToken`. Compute the forwarding deadline from the pre-call monotonic timestamp and reject a slow/indeterminate reply.

Implement the production topology monitor separately from lease scripts. Cache evidence for at most five seconds, require it synchronously before acquire, and fail closed while refresh is in flight/failed. An existing owner treats unknown topology like renewal failure. Do not claim Redis Cluster production support merely because integration executes the Lua scripts there.

Keep local install/check/set synchronous with no `await` between them. The opening-expiry and lease-loss callbacks must re-read the map and compare state, socket object, instance ID, connection ID, generation, and lease token before detaching or deleting. Update an entry's forwarding deadline only after an exact successful renewal.

- [ ] **Step 4: Run the green tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/remoteWsOwnership.test.ts \
  src/services/remoteWsSharedLease.test.ts \
  src/services/remoteWsRedisTopology.test.ts
```

Expected: PASS, including cross-instance exclusion, conservative forwarding deadlines, partition/pause behavior, stale expiry, and generation-reuse regressions.

- [ ] **Step 5: Commit the lease primitive**

```bash
git add apps/api/src/services/remoteWsOwnership.ts apps/api/src/services/remoteWsOwnership.test.ts apps/api/src/services/remoteWsSharedLease.ts apps/api/src/services/remoteWsSharedLease.test.ts apps/api/src/services/remoteWsRedisTopology.ts apps/api/src/services/remoteWsRedisTopology.test.ts
git commit -m "fix(remote): define cross-replica websocket ownership"
```

---

### Task 2: Carry one-time ticket JTI and MFA assurance

**Files:**
- Modify: `apps/api/src/services/remoteSessionAuth.ts`
- Modify: `apps/api/src/services/remoteSessionAuth.test.ts`
- Create: `apps/api/src/__tests__/fixtures/legacyRemoteWsTicketCodec.ts`
- Modify: `apps/api/src/routes/remote/sessions.ts`
- Modify: `apps/api/src/routes/remote/sessions.test.ts`
- Modify: `apps/api/src/services/jwt.ts`
- Modify: `apps/api/src/services/jwt.test.ts`
- Modify: `apps/api/src/services/viewerTokenTtl.test.ts`
- Modify: `apps/api/src/services/viewerTokenRevocation.ts`
- Modify: `apps/api/src/services/viewerTokenRevocation.test.ts`
- Modify: `apps/api/src/routes/desktopWs.ts`
- Modify: `apps/api/src/routes/desktopWs_utils_http.test.ts`
- Modify: `apps/api/src/routes/tunnels.ts`
- Modify: `apps/api/src/routes/tunnels.test.ts`
- Modify: `apps/api/src/routes/tunnelHttp.ts`
- Modify: `apps/api/src/routes/tunnelHttp.test.ts`

**Interfaces:**
- Consumes: authenticated request MFA state or desktop viewer JWT assurance.
- Produces: truthful unversioned `RemoteWsTicketRecordV0` reads with nullable JTI, normal V2 writes, narrowly scoped V1 legacy-viewer writes, MFA-assured viewer-token lineages with non-extendable absolute expiry, and a discriminated consume result that never treats compatibility as MFA.

- [ ] **Step 1: Add failing ticket assurance tests**

Freeze the exact pre-wave unversioned encoder/reader in `legacyRemoteWsTicketCodec.ts` with the reviewed base SHA in its header. Prove:

- legacy writer → new reader yields `legacy_unversioned_v0`, `ticketJti: null`, and no MFA only in `post_upgrade`;
- compile/runtime guards prove `ConsumedRemoteWsTicketContext.ticketJti` is `string | null`, V0 is literal `null`, and no cast/hash/session ID is substituted;
- the same V0 record is rejected in `pre_upgrade`, including one carrying forged unknown version/JTI/MFA-like fields;
- new V2 writer → frozen old reader remains readable because additive fields are ignored and the original session/user/type/expiry/IP/UA bindings remain;
- every normal lease-aware issuer writes V2 with unique JTI and `mfaSatisfied: true`;
- only a same-session legacy-viewer exchange writes V1 in `post_upgrade`;
- V0 WebSocket tickets retain exactly 60 seconds, while V0 `tunnel-http` tickets and their scoped cookies retain exactly 300 seconds from exported constants.

- [ ] **Step 2: Add failing desktop deep-link assurance tests**

The desktop connect code is minted behind the existing `requireMfa()` gate. Carry `mfaSatisfied: true` and a signed root `assuranceAbsoluteExpiresAt` into every newly rooted viewer access JWT. `/desktop-ws/:sessionId/viewer/ws-ticket` maps a new assured viewer JWT to V2 true. In `post_upgrade` only, that same-session endpoint maps a valid pre-wave viewer JWT lacking the claim to a V1 compatibility ticket without making an MFA assertion. In `pre_upgrade`, reject that legacy JWT and every V1 ticket. Test the exact last-legacy-JWT/last-compatibility-ticket boundary used by the drain gate.

For both `POST /api/v1/vnc-viewer/upgrade-to-webrtc` and `POST /api/v1/vnc-viewer/downgrade-to-vnc`, add the assurance check immediately after cryptographic viewer-token validation and before any lookup or mutation. A legacy no-claim token returns exact `403 { "error": "legacy_viewer_transition_forbidden" }`; assert zero new session row, agent command, WebSocket ticket, viewer JWT, and audit. An assured input produces a descendant with `mfaSatisfied: true`, the unchanged root `assuranceAbsoluteExpiresAt`, and `exp` no later than both that absolute boundary and the input's remaining lineage window. Repeated upgrade/downgrade cannot extend the original root expiry. Missing/false MFA, malformed/future absolute-bound claims, or an exhausted lineage fail closed with no side effect. The same-session compatibility exchange remains available only in `post_upgrade`; it cannot change session type.

- [ ] **Step 3: Add failing viewer-lifetime boundary tests**

Keep `VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS` exported from `apps/api/src/services/jwt.ts` and make it the only numeric source for the signed viewer JWT, exchange `expiresInSeconds`, viewer JTI/session revocation TTL, and deployment drain evidence. Production remains exactly `7_200` seconds; the existing E2E-mode override remains explicit and derives from the same constant.

With `vi.useFakeTimers()` and `vi.setSystemTime()`:

- mint a viewer token at `t0`, verify it at `t0 + VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS * 1000 - 1`, and reject it at the first instant after expiry;
- assert both viewer JTI and session revocation writes use Redis `EX VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS`, not a duplicated literal;

Reset real timers after each case. Task 7 separately tests the sequential deployment drain gate.

- [ ] **Step 4: Run the red suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/remoteSessionAuth.test.ts \
  src/routes/remote/sessions.test.ts \
  src/services/jwt.test.ts \
  src/services/viewerTokenTtl.test.ts \
  src/services/viewerTokenRevocation.test.ts \
  src/routes/desktopWs_utils_http.test.ts \
  src/routes/tunnels.test.ts \
  src/routes/tunnelHttp.test.ts
```

Expected: FAIL because truthful V0 compatibility, V1/V2 separation, JTI/MFA assurance, and both drain boundaries are absent.

- [ ] **Step 5: Implement additive ticket fields and shared lifetimes**

Parse the discriminant without normalization: absent `version` is V0, `1` is V1, and `2` is V2. V0 has no JTI/MFA and its consumed context assigns `ticketJti: null` without coercion. Generate V1/V2 JTI separately from the ticket secret. Require explicit `mfaSatisfied: true` at every normal callsite. Give the same-session legacy-viewer exchange a separate `createLegacyViewerCompatibilityWsTicket` API that can only write V1 in `post_upgrade`; transition routes may not call it. Preserve Redis `GET+DEL` and in-memory synchronous consume. Never log/return the JTI or ticket.

Replace `viewerTokenRevocation.ts`'s duplicated two-hour literal with `VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS`. Add a viewer descendant-token helper that requires true parent assurance and uses the signed root absolute-expiry cap; root issuance and descendant issuance are separate typed APIs so a transition cannot accidentally call the root helper. Export the WebSocket, tunnel-HTTP ticket, and tunnel-HTTP cookie TTLs in seconds from their owning services for the drain gate/tests while keeping 60/300/300 seconds. Do not add a configurable production shortcut for any wait.

- [ ] **Step 6: Run the green suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/remoteSessionAuth.test.ts \
  src/routes/remote/sessions.test.ts \
  src/services/jwt.test.ts \
  src/services/viewerTokenTtl.test.ts \
  src/services/viewerTokenRevocation.test.ts \
  src/routes/desktopWs_utils_http.test.ts \
  src/routes/tunnels.test.ts \
  src/routes/tunnelHttp.test.ts
```

Expected: PASS; both old→new and new→old compatibility fixtures pass, V0 remains unversioned/non-MFA with null JTI, normal issuers are V2 true, legacy viewer JWTs create only same-session post-upgrade V1, both transitions reject legacy input without side effects, assured descendant expiry never extends its root lineage, and all 60/300/7,200-second lifetime boundaries cannot drift.

- [ ] **Step 7: Commit assurance propagation**

```bash
git add apps/api/src/services/remoteSessionAuth.ts apps/api/src/services/remoteSessionAuth.test.ts apps/api/src/__tests__/fixtures/legacyRemoteWsTicketCodec.ts apps/api/src/routes/remote/sessions.ts apps/api/src/routes/remote/sessions.test.ts apps/api/src/services/jwt.ts apps/api/src/services/jwt.test.ts apps/api/src/services/viewerTokenTtl.test.ts apps/api/src/services/viewerTokenRevocation.ts apps/api/src/services/viewerTokenRevocation.test.ts apps/api/src/routes/desktopWs.ts apps/api/src/routes/desktopWs_utils_http.test.ts apps/api/src/routes/tunnels.ts apps/api/src/routes/tunnels.test.ts apps/api/src/routes/tunnelHttp.ts apps/api/src/routes/tunnelHttp.test.ts
git commit -m "fix(remote): bind tickets to MFA assurance"
```

---

### Task 3: Centralize live pre-upgrade authorization

**Files:**
- Create: `apps/api/src/services/remoteWsAuthorization.ts`
- Create: `apps/api/src/services/remoteWsAuthorization.test.ts`
- Read: `apps/api/src/routes/terminalWs.ts`
- Read: `apps/api/src/routes/desktopWs.ts`
- Read: `apps/api/src/routes/tunnelWs.ts`
- Read: `apps/api/src/routes/remote/index.ts`
- Read: `apps/api/src/services/permissions.ts`

**Interfaces:**
- Consumes: `consumeWsTicket`, live user/session/device/membership/role/site state, remote-access policy, and connection rate limit.
- Produces: ticket-only `consumeRemoteWsUpgradeTicket` plus live-state `authorizeConsumedRemoteWsTicket`, allowing rollout mode to change authorization timing without consuming a ticket twice.

- [ ] **Step 1: Add failing authorization matrix tests**

For terminal, desktop, and tunnel, cover valid access plus every `RemoteWsValidationResult` reason. Include:

- ticket path/type/session mismatch;
- unversioned V0 and explicit V1 compatibility accepted only in `post_upgrade`, never represented as `mfaSatisfied`, and categorically rejected in `pre_upgrade`;
- inactive user and session ownership mismatch;
- current `PERMISSIONS.REMOTE_ACCESS` removal;
- current site removal, including `allowedSiteIds: []`;
- V2 false/missing MFA assurance;
- ended session, offline device, and policy denial;
- Redis/DB failure;
- rate limit;
- tunnel VNC versus proxy policy capability.

Assert no system query occurs for a missing/invalid ticket and no agent command occurs during validation.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/remoteWsAuthorization.test.ts
```

Expected: FAIL because validation is duplicated inside `onOpen`.

- [ ] **Step 3: Implement split ticket intake and live authorization**

`consumeRemoteWsUpgradeTicket` consumes the ticket and verifies truthful record shape, rollout mode, caller/path/type/session binding first. It accepts V2 only when `mfaSatisfied === true`; in `post_upgrade` it may return distinct `legacy_unversioned_v0` or `legacy_viewer_compatibility` assurance, neither with MFA/JTI fabrication. It never queries the database.

`authorizeConsumedRemoteWsTicket` uses the already consumed result. In one narrowly scoped system DB callback, load indexed active user, session joined to device, ownership, active state, and device online state. Resolve current permissions directly from authoritative membership/role rows, require remote access, and apply site access without treating empty as unrestricted. Recheck `checkRemoteAccess` with `remoteTools`, `webrtcDesktop`, `vncRelay`, or `proxy` according to route/session type.

Translate database inability to `503 authorization_unavailable`. Return only bounded reason/status; never include whether a different user's session exists until a valid bound ticket has already proved the expected user.

- [ ] **Step 4: Run the green authorization matrix**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/remoteWsAuthorization.test.ts
```

Expected: PASS for all three transports and restricted-empty.

- [ ] **Step 5: Commit shared authorization**

```bash
git add apps/api/src/services/remoteWsAuthorization.ts apps/api/src/services/remoteWsAuthorization.test.ts
git commit -m "fix(remote): centralize websocket authorization"
```

---

### Task 4: Bind terminal handlers and agent callbacks to the exact lease

**Files:**
- Modify: `apps/api/src/routes/terminalWs.ts`
- Modify: `apps/api/src/routes/terminalWs_onmessage_lifecycle.test.ts`
- Modify: `apps/api/src/routes/terminalWs_close_revocation.test.ts`
- Modify: `apps/api/src/routes/terminalWs_utils_onopen.test.ts`
- Modify: `apps/api/src/routes/terminalWs_multitenant.test.ts`
- Modify: `apps/api/src/routes/terminalWs_rate_limit.test.ts`

**Interfaces:**
- Consumes: `RemoteWsSharedLeaseClaim`, renewal/loss hooks, and `ownsSafeRemoteConnection`.
- Produces: cross-replica lease-aware terminal message, timer, agent output, close, error, and revocation paths.

- [ ] **Step 1: Add failing foreign/stale socket tests**

Register an owner and a foreign socket for the same session ID. Prove the foreign socket cannot send terminal data/resize, update pong time, close/error the owner, delete callbacks, update DB state, write audit, or send `terminal_stop`. Repeat with an old socket from a replaced generation.

Construct two route instances with separate local maps against the same shared lease manager Redis. Prove the second instance cannot install or upgrade an owner; after forced renewal failure, prove every old event/callback is inert before the Redis TTL expires and a new owner is admitted only after expiry.

- [ ] **Step 2: Add failing callback/timer tests**

Capture an old terminal output callback and ping/revocation timer, remove/reopen the session, then invoke the old closures. Assert no output reaches the new owner and no new session is closed or mutated.

- [ ] **Step 3: Run the red terminal suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/routes/terminalWs_onmessage_lifecycle.test.ts \
  src/routes/terminalWs_close_revocation.test.ts \
  src/routes/terminalWs_utils_onopen.test.ts \
  src/routes/terminalWs_multitenant.test.ts \
  src/routes/terminalWs_rate_limit.test.ts
```

Expected: FAIL because handlers look up ownership by session ID only.

- [ ] **Step 4: Add lease identity to `TerminalSession`**

Install the already acquired shared claim and bind on open. Start renewal only for the exact installed entry. At the first line of every event and captured callback, require exact `ownsSafeRemoteConnection(...)`; foreign, stale, expired-deadline, and lease-lost paths return without mutation. Timer callbacks capture the immutable identity and expected socket. Renewal failure first expires forwarding. If exact-owner close proof returns `still_owner`, stop/close the terminal before lease expiry and enter normal cleanup; if it returns mismatch, detach stale local state only and never send `terminal_stop` or mutate the session. Delete the map entry and compare-release Redis only after final matching ownership checks.

- [ ] **Step 5: Reject implicit replacement**

If a shared owner is opening, active, or closing, reject the request before `101` rather than overwriting `activeTerminalSessions`. Both rollout modes return HTTP `409`; no replica may rely on a post-upgrade `4009` close as ownership enforcement.

- [ ] **Step 6: Run the green terminal suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/routes/terminalWs_onmessage_lifecycle.test.ts \
  src/routes/terminalWs_close_revocation.test.ts \
  src/routes/terminalWs_utils_onopen.test.ts \
  src/routes/terminalWs_multitenant.test.ts \
  src/routes/terminalWs_rate_limit.test.ts
```

Expected: PASS; stale callbacks and sockets are inert.

- [ ] **Step 7: Commit terminal ownership**

```bash
git add apps/api/src/routes/terminalWs.ts apps/api/src/routes/terminalWs_onmessage_lifecycle.test.ts apps/api/src/routes/terminalWs_close_revocation.test.ts apps/api/src/routes/terminalWs_utils_onopen.test.ts apps/api/src/routes/terminalWs_multitenant.test.ts apps/api/src/routes/terminalWs_rate_limit.test.ts
git commit -m "fix(remote): bind terminal events to socket ownership"
```

---

### Task 5: Converge desktop teardown on one idempotent lifecycle

**Files:**
- Modify: `apps/api/src/routes/desktopWs.ts`
- Modify: `apps/api/src/routes/desktopWs_lifecycle.test.ts`
- Modify: `apps/api/src/routes/desktopWs_rate_limit_cleanup.test.ts`
- Modify: `apps/api/src/routes/desktopWs_onopen.test.ts`
- Create: `apps/api/src/services/desktopSessionFinalization.ts`
- Create: `apps/api/src/services/desktopSessionFinalization.test.ts`
- Create: `apps/api/src/services/desktopSessionOrphanRecovery.ts`
- Create: `apps/api/src/services/desktopSessionOrphanRecovery.test.ts`
- Create: `apps/api/src/services/desktopSessionStop.ts`
- Create: `apps/api/src/services/desktopSessionStop.test.ts`
- Modify: `apps/api/src/services/commandQueue.ts`
- Modify: `apps/api/src/services/commandQueue.test.ts`
- Create: `apps/api/src/jobs/desktopSessionFinalizationWorker.ts`
- Create: `apps/api/src/jobs/desktopSessionFinalizationWorker.test.ts`
- Modify: `apps/api/src/jobs/queueSchemas.ts`
- Modify: `apps/api/src/jobs/queueSchemas.test.ts`
- Create: `apps/api/src/routes/admin/desktopFinalization.ts`
- Create: `apps/api/src/routes/admin/desktopFinalization.test.ts`
- Create: `apps/api/src/routes/admin/desktopFinalizationCli.test.ts`
- Modify: `apps/api/src/routes/admin/index.ts`
- Create: `scripts/security/reconcile-desktop-finalization.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_audit_test.go`
- Modify: `agent/internal/heartbeat/handlers_desktop.go`
- Modify: `agent/internal/heartbeat/handlers_desktop_test.go`
- Modify: `agent/internal/remote/desktop/ws_manager.go`
- Create: `agent/internal/remote/desktop/ws_manager_test.go`
- Create after implementation: `internal/operations/desktop-finalization-reconciliation.md` (gitignored; never stage or commit)

**Interfaces:**
- Produces: write-ahead teardown via `closeDesktopSessionLifecycle`, durable agent-sink-idempotent stop proof via `ensureDesktopStreamStopped`, stop-gated atomic `finalizeDesktopSessionOnce`, non-expiring exact intent, admission/background orphan recovery, bounded BullMQ retry, and inspect/reconcile operator commands.

- [ ] **Step 1: Add failing concurrent cleanup tests**

Invoke client close, socket error, pong timeout, revocation, and setup failure concurrently for one exact owner. Assert:

- one stable durable `desktop_stream_stop` row/delivery identity and any number of safe same-ID redeliveries, with exactly one terminal-safe stop effect;
- one callback unregister;
- one viewer revocation;
- one conditional final DB update;
- one summary audit;
- state becomes inert `closing`, timers clear, and immutable counters/input freeze synchronously before the first `await`;
- when Redis is available, exact fence/payload persist while the owner still matches and **before** callback/socket detach or stop;
- when intent persistence is unavailable/indeterminate, callback/socket detach and one immediate idempotent stop attempt still occur for safety, but ownership remains inert `closing` and no finalization is falsely acknowledged;
- shared/local entries remain `closing` until atomic finalization succeeds or durable queue acknowledgement is returned;
- every caller receives the same cleanup promise;
- a foreign/stale cleanup call does nothing.

Also cover these failure and retry boundaries:

- DB or audit failure proves callback/socket detachment and terminal-safe agent stop acknowledgement already occurred;
- crash/restart at each boundary—before intent, after intent before stop-row creation, after durable stop-row creation before agent acknowledgement, after confirmed stop, after detach, during inline finalization, and before/after enqueue acknowledgement—leaves either an exact recoverable intent or a detectable orphan, never an admitted stale session;
- `SIGKILL` immediately after intent and before stop proves restart creates/reuses the exact durable command, keeps DB/intent/admission blocked while the agent is disconnected, and finalizes only after an exact `stopped|already_absent` acknowledgement;
- `SIGKILL` immediately after confirmed stop and before DB finalization proves restart recognizes the persisted exact result, does not need an unsafe new identity, finalizes once, and only then compare-deletes the intent pair;
- a generic duplicate result, send success without command result, lost result, timeout, stale agent epoch, and disconnected agent never count as stop proof;
- repeated same-ID delivery across API restart and agent restart executes the idempotent sink and returns `stopped|already_absent`, never a pre-execution `duplicate`;
- atomic intent persistence rejects a stale/different shared owner, partial key pair, same ID with changed payload, or any Redis indeterminate result;
- inline finalization failure followed by stable `queue.add` acknowledgement compare-releases only the matching shared/local lease while the durable intent continues to deny a second reserve;
- intent-persistence or queue-enqueue failure retains the matching shared/local lease in `closing`, renews it safely, leaves `cleanupPromise` retryable, and a second replica receives `already_owned|desktop_finalizing`;
- process restart before intent plus absent owner makes the next desktop admission/background sweep return `orphan_recovery`, synthesize/claim an exact recovery intent after two observations, durably stop and confirm the agent sink, and conditionally finalize rather than reopen;
- process restart after intent/queue acknowledgement leaves both Redis values, so a second API instance denies reservation while recovery is waiting/running;
- duplicate cleanup calls and duplicate BullMQ processor invocations produce one conditional DB transition and one summary audit;
- a transaction failure after the conditional update but before audit insertion rolls back both, so retry can produce both exactly once;
- a stale finalizer cannot release a newer/different fence or payload;
- retry exhaustion leaves the exact payload and fence present and emits worker failure telemetry;
- both Redis keys have `PTTL = -1`, and advancing fake time by 30 days leaves both present;
- BullMQ completed/failed job retention cleanup never deletes the intent, and the worker/reconciler can still load the exact payload after the job record is gone;
- inspect GET refuses inactive/demoted/non-MFA callers and returns bounded persisted ID/payload/job/session/stop-proof state by session ID;
- reconciliation refuses mismatched expected ID, reusable queue job, invalid/missing change ticket, payload mismatch, missing terminal-safe stop proof, or failed audit, but a persisted nonterminal session is valid and must be stopped then finalized;
- the endpoint ignores no caller-supplied actor identity because none is accepted; it derives the live operator from `auth`;
- successful operator reconciliation writes its bounded audit before exact pair compare-delete; any audit/delete failure retains both keys;
- CLI parsing has no `--force`, `--age`, direct-Redis, or direct-DB option and redacts bearer tokens.

- [ ] **Step 2: Run the red lifecycle tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/routes/desktopWs_lifecycle.test.ts \
  src/routes/desktopWs_rate_limit_cleanup.test.ts \
  src/routes/desktopWs_onopen.test.ts \
  src/services/desktopSessionFinalization.test.ts \
  src/services/desktopSessionOrphanRecovery.test.ts \
  src/services/desktopSessionStop.test.ts \
  src/services/commandQueue.test.ts \
  src/jobs/desktopSessionFinalizationWorker.test.ts \
  src/jobs/queueSchemas.test.ts \
  src/routes/admin/desktopFinalization.test.ts \
  src/routes/admin/desktopFinalizationCli.test.ts
cd agent && go test -race ./internal/heartbeat/...
```

Expected: FAIL because close and error perform duplicate independent cleanup and no durable stop-gated finalization path exists.

- [ ] **Step 3: Implement inert write-ahead teardown ordering**

For a matching owner:

1. if `cleanupPromise` exists, return it;
2. set state `closing`;
3. create/store the promise before any `await`;
4. expire its forwarding deadline and clear ping/revalidation timers so every callback is inert;
5. build/store one immutable `finalizationInput` from the captured session;
6. call `beginClose` and attempt atomic write-ahead intent;
7. after acknowledged intent—or after an unavailable/indeterminate error that is recorded for orphan recovery—detach/close only the exact socket, unregister the exact callback, and set `detachComplete=true`;
8. create/reuse the exact durable `device_commands` stop row and trigger delivery; set `stopCommandId=finalizationId`;
9. record `stopConfirmed=true` only after re-reading the exact row and validating the agent's bounded `stopped|already_absent` result.

Add `detachComplete`, `stopCommandId`, `stopConfirmed`, `intentAcknowledged`, and `finalizationInput` to `DesktopSession`. Keep counters from the captured object. A matching retry never detaches/unregisters twice and always reuses the same stop ID. Redelivery may execute `StopSession` again because that sink operation is idempotent; it may not allocate a new command identity. If write-ahead failed, retain the inert closing entry and retry exact `beginClose`/persistence; if the process dies, orphan recovery supplies the durable barrier.

- [ ] **Step 4: Implement atomic, idempotent finalization**

In `desktopSessionStop.ts`, insert/reuse the stable `device_commands.id = finalizationId` row and prove its exact device/type/payload before any resend. Extend the existing command queue with a compare-and-set re-arm helper scoped to this intrinsically idempotent command. On the agent, change `WsSessionManager.StopSession(id)` to return whether it removed an active session while preserving its lock-before-stop ordering; map true to `stopped` and false to `already_absent`. Exclude only `desktop_stream_stop` from generic mark-before-execute suppression and make its handler require matching payload finalization ID, then return exact bounded `sessionId`, `finalizationId`, and outcome. Tests must simulate a crash after mark-seen but before handler dispatch and prove redelivery still reaches `StopSession`.

In `desktopSessionFinalization.ts`, call `ensureDesktopStreamStopped` first; return `stop_pending` with no further side effect until exact acknowledgement. Then make viewer-session revocation idempotent and fail closed. Run the conditional remote-session update and `desktop.session.summary` insert in one `withSystemDbAccessContext` transaction. The update predicate is `id = sessionId AND status IN ('pending', 'connecting', 'active')`; derive duration from validated ISO timestamps and clamp counters/duration to nonnegative bounds. Insert the audit only when `UPDATE ... RETURNING` returns the row.

Two concurrent calls must both observe the same terminal-safe stop proof, then serialize through the conditional update: one returns `finalized`; the other returns `already_finalized`. Do not use the existing fire-and-forget audit retry queue because it cannot make the state transition and audit atomic.

- [ ] **Step 5: Add the durable finalization intent and worker**

Add a versioned Zod schema to `jobs/queueSchemas.ts`. Follow the repository's privileged-worker pattern: `createInstrumentedQueue`, `parseQueueJobData`, `assertQueueJobName`, `attachWorkerObservability`, system DB context, explicit initialize/shutdown, stable job ID, five attempts, exponential one-second backoff, and bounded retention.

Before detach/stop, call `persistDesktopFinalizationIntent`. Its Lua script must prove the exact shared owner and atomically write the exact-ID fence plus complete canonical payload with no TTL. The persisted record is the source of truth; the BullMQ schema/job carries only `{ sessionId, finalizationId }`. The worker loads and validates the payload, calls the centralized finalizer, and retries `stop_pending`. Compare-delete both keys only when both exact values match and finalization returned `finalized|already_finalized` after confirmed stop.

`enqueueDesktopSessionFinalization` returns `{ acknowledged: true, jobId }` only after BullMQ returns the exact stable ID `desktop-finalize-${sessionId}-${finalizationId}`. A duplicate add must resolve to that same job; a failed/ambiguous add rejects and never fabricates acknowledgement or removes either key. Job `removeOnComplete`/`removeOnFail` retention is independent of the persisted intent. Register `initializeDesktopSessionFinalizationWorker` in `initializeWorkers()` and `shutdownDesktopSessionFinalizationWorker` in `shutdownRuntime()` in `apps/api/src/index.ts`.

Implement background orphan reconciliation with startup scan plus bounded periodic batches. It only considers `connecting|active`, or `pending` older than 90 seconds, and requires two owner/intent-absent observations separated by the full lease TTL while the DB row remains nonterminal. It atomically claims a synthesized `orphan_recovery` payload, creates/reuses the durable stop row even when the agent is disconnected, and uses the normal stop-gated finalizer/queue. Next admission runs the same check and returns `409` until stop and finalization complete; Redis/topology uncertainty returns `503`.

Implement inspect GET and reconcile POST exactly as the canonical surface. Reconciliation loads the exact persisted payload, creates/reuses and reports the durable stop, and **finalizes nonterminal state only after confirmed agent acknowledgement**; only then writes the synchronous reconciliation audit and compare-deletes. A disconnected agent returns retained/pending, never force-safe. Export side-effect-free CLI parsing/request construction for tests. Add both exact invocations and human evidence/abort sequence to the private runbook.

- [ ] **Step 6: Complete lifecycle ownership ordering**

After making the session inert and freezing input:

1. `beginClose` and persist/confirm the exact durable intent while the owner matches;
2. detach callback/socket and create/reuse the stable durable stop row;
3. attempt `finalizeDesktopSessionOnce` inline; `stop_pending` leaves DB and intent untouched while delivery/retry continues;
4. on `finalized|already_finalized`, compare-delete intent, remove exact local entry, and compare-release owner;
5. on failure, enqueue by stable session/finalization ID; after acknowledgement release exact ownership while intent remains;
6. if write-ahead is unavailable, detach and attempt the immediate safety stop, retain inert closing ownership, retry, and rely on orphan recovery plus durable stop after a crash;
7. if enqueue fails after intent, retain closing ownership/intent and retry without allocating a new stop identity.

Never place local or shared release in an unconditional `finally`. Desktop acquisition must atomically reject an owner or either finalization key.

- [ ] **Step 7: Route every close path through the lifecycle**

Replace direct map deletion, callback unregister, stop command, DB update, viewer revocation, and audit logic in `onClose`, `onError`, ping timeout, revocation, and on-open catch with this function.

- [ ] **Step 8: Run the green lifecycle and worker tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/routes/desktopWs_lifecycle.test.ts \
  src/routes/desktopWs_rate_limit_cleanup.test.ts \
  src/routes/desktopWs_onopen.test.ts \
  src/services/desktopSessionFinalization.test.ts \
  src/services/desktopSessionOrphanRecovery.test.ts \
  src/services/desktopSessionStop.test.ts \
  src/services/commandQueue.test.ts \
  src/jobs/desktopSessionFinalizationWorker.test.ts \
  src/jobs/queueSchemas.test.ts \
  src/routes/admin/desktopFinalization.test.ts \
  src/routes/admin/desktopFinalizationCli.test.ts
cd agent && go test -race ./internal/heartbeat/...
```

Expected: PASS with write-ahead-before-detach when available, safety detach on Redis failure, crash-boundary orphan recovery, one stable durable stop identity with terminal-safe sink acknowledgement, persistent exact intent, stop-gated nonterminal reconciliation, and only exact audited release.

- [ ] **Step 9: Commit idempotent durable teardown**

```bash
git add apps/api/src/routes/desktopWs.ts apps/api/src/routes/desktopWs_lifecycle.test.ts apps/api/src/routes/desktopWs_rate_limit_cleanup.test.ts apps/api/src/routes/desktopWs_onopen.test.ts apps/api/src/services/desktopSessionFinalization.ts apps/api/src/services/desktopSessionFinalization.test.ts apps/api/src/services/desktopSessionOrphanRecovery.ts apps/api/src/services/desktopSessionOrphanRecovery.test.ts apps/api/src/services/desktopSessionStop.ts apps/api/src/services/desktopSessionStop.test.ts apps/api/src/services/commandQueue.ts apps/api/src/services/commandQueue.test.ts apps/api/src/jobs/desktopSessionFinalizationWorker.ts apps/api/src/jobs/desktopSessionFinalizationWorker.test.ts apps/api/src/jobs/queueSchemas.ts apps/api/src/jobs/queueSchemas.test.ts apps/api/src/routes/admin/desktopFinalization.ts apps/api/src/routes/admin/desktopFinalization.test.ts apps/api/src/routes/admin/desktopFinalizationCli.test.ts apps/api/src/routes/admin/index.ts scripts/security/reconcile-desktop-finalization.ts apps/api/src/index.ts agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_audit_test.go agent/internal/heartbeat/handlers_desktop.go agent/internal/heartbeat/handlers_desktop_test.go agent/internal/remote/desktop/ws_manager.go agent/internal/remote/desktop/ws_manager_test.go
git commit -m "fix(remote): make desktop teardown idempotent"
```

Create/update `internal/operations/desktop-finalization-reconciliation.md` after the implementation, but verify `git check-ignore` reports it ignored and never add it to the commit.

---

### Task 6: Bind desktop and tunnel relays to exact ownership

**Files:**
- Modify: `apps/api/src/routes/desktopWs.ts`
- Modify: `apps/api/src/routes/desktopWs_onmessage.test.ts`
- Modify: `apps/api/src/routes/desktopWs_multitenant.test.ts`
- Modify: `apps/api/src/routes/desktopWs.test.ts`
- Modify: `apps/api/src/routes/tunnelWs.ts`
- Modify: `apps/api/src/routes/tunnelWs.test.ts`

**Interfaces:**
- Consumes: shared Redis lease manager, safe local ownership checks, lease-loss hooks, and desktop lifecycle.
- Produces: exact, deadline-bounded ownership for browser events, frames, tunnel bytes, timers, revocation, close, and error across replicas.

- [ ] **Step 1: Add failing desktop identity tests**

Prove foreign and stale sockets cannot send input/config/pong, receive an agent frame through a captured callback, mutate counters, close/error the owner, or invoke lifecycle side effects. Prove a second valid owner is not installed.

Pause the first desktop route instance past its safe forwarding deadline and invoke every captured callback before Redis owner expiry; all are inert. After expiry, let a second instance acquire and prove late first-instance callbacks cannot affect it.

- [ ] **Step 2: Add failing tunnel identity tests**

Prove foreign and stale sockets cannot forward base64/binary tunnel bytes, flush an early frame buffer, update pong state, invoke revocation cleanup, delete agent ownership, close the live tunnel, or send `tunnel_close`. Include a stale captured `tunnelDataCallbacks` closure.

Repeat against two route instances sharing Redis with renewal partition/mismatch. Prove the old instance stops forwarding before the new one can acquire and that the safety gap prevents overlap.

- [ ] **Step 3: Run the red suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/routes/desktopWs_onmessage.test.ts \
  src/routes/desktopWs_multitenant.test.ts \
  src/routes/desktopWs.test.ts \
  src/routes/tunnelWs.test.ts
```

Expected: FAIL on identifier-only handlers and callbacks.

- [ ] **Step 4: Bind desktop events and callbacks**

Add the complete shared lease fields and safe deadline to `DesktopSession`. Exact-and-deadline-check `onMessage`, ping/pong, frame callback, revocation, close, and error. Route matching normal paths through `closeDesktopSessionLifecycle`. A lease-loss path may enter that lifecycle only after exact-owner close proof returns `still_owner`; owner mismatch performs socket/callback local detach only and may not send `desktop_stream_stop`, persist an intent, or finalize. Foreign/stale/expired event paths do nothing.

- [ ] **Step 5: Bind tunnel events and lifecycle**

Add the complete shared lease fields, safe deadline, and `cleanupPromise` to `TunnelConnection`. Make tunnel cleanup accept expected socket/identity and preserve ownership until conditional DB finalization, viewer revocation, callback cleanup, and one optional `tunnel_close` complete. Exact-and-deadline-check every browser event, early-buffer flush, agent-data callback, revalidation timer, and close/error. On renewal loss, expire forwarding synchronously; send `tunnel_close`/finalize only after `still_owner` proof, otherwise perform local-only stale detach. Compare-release only the matching shared value.

- [ ] **Step 6: Run the green suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/routes/desktopWs_onmessage.test.ts \
  src/routes/desktopWs_multitenant.test.ts \
  src/routes/desktopWs.test.ts \
  src/routes/tunnelWs.test.ts
```

Expected: PASS; all three transports now reject foreign/stale state mutation.

- [ ] **Step 7: Commit relay ownership**

```bash
git add apps/api/src/routes/desktopWs.ts apps/api/src/routes/desktopWs_onmessage.test.ts apps/api/src/routes/desktopWs_multitenant.test.ts apps/api/src/routes/desktopWs.test.ts apps/api/src/routes/tunnelWs.ts apps/api/src/routes/tunnelWs.test.ts
git commit -m "fix(remote): bind desktop and tunnel relays"
```

---

### Task 7: Validate and reserve before HTTP upgrade

**Files:**
- Create: `apps/api/src/services/remoteWsUpgrade.ts`
- Create: `apps/api/src/services/remoteWsUpgrade.test.ts`
- Create: `apps/api/src/services/remoteWsDrainGate.ts`
- Create: `apps/api/src/services/remoteWsDrainGate.test.ts`
- Modify: `apps/api/src/services/remoteWsSharedLease.ts`
- Modify: `apps/api/src/services/remoteWsSharedLease.test.ts`
- Modify: `apps/api/src/services/desktopSessionFinalization.ts`
- Modify: `apps/api/src/services/desktopSessionFinalization.test.ts`
- Modify: `apps/api/src/services/desktopSessionOrphanRecovery.ts`
- Modify: `apps/api/src/services/desktopSessionOrphanRecovery.test.ts`
- Modify: `apps/api/src/routes/terminalWs.ts`
- Modify: `apps/api/src/routes/desktopWs.ts`
- Modify: `apps/api/src/routes/tunnelWs.ts`
- Modify: `apps/api/src/routes/tunnelHttp.ts`
- Modify: `apps/api/src/routes/tunnelHttp.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Modify: `deploy/.env.example`
- Modify: `deploy/compose-config-test.env`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`
- Modify: `docker/Caddyfile.prod`
- Modify: `scripts/prod/deploy.sh`
- Create: `scripts/prod/remote-access-cutover.test.sh`
- Modify: `apps/docs/src/content/docs/deploy/upgrades.mdx`

**Interfaces:**
- Consumes: ticket intake, mode-specific live authorization, atomic shared acquire (including desktop intent keys), local install, and `REMOTE_WS_AUTH_MODE`.
- Produces: Hono context `remoteWs: ValidatedRemoteWsContext` plus an exact shared opening claim before `upgradeWebSocket`.

- [ ] **Step 1: Add failing middleware tests**

Use an upgrade spy and assert:

- missing/invalid/expired/consumed/mismatched ticket returns `401` and never calls upgrade;
- inactive/permission/site/MFA/policy denial returns `403` and never calls upgrade;
- missing valid-bound session returns `404`;
- rate limit returns `429`;
- DB inability returns `503`;
- existing opening/active/closing owner on another manager/API instance returns `409`;
- `post_upgrade` accepts bound unversioned V0 and explicit V1 without MFA; `pre_upgrade` rejects both before `101`;
- V0 consumption returns `ticketJti: null` through the entire middleware/context path, with no fabricated string;
- a normal/new V2 ticket must contain `mfaSatisfied: true` in both modes;
- an acknowledged desktop-finalization job with no local map entry still returns `409` while either its Redis fence or payload exists;
- a partial/mismatched desktop finalization key pair or Redis acquisition failure returns `503` and never upgrades;
- desktop key absence and owner installation happen in one Lua script, with no check/acquire gap;
- a completed finalization whose matching intent pair was compare-deleted may acquire normally;
- a nonterminal desktop row with no owner/intent returns `409 orphan_recovery` (or `503` if topology cannot be proved), triggers recovery, and never upgrades;
- success acquires shared ownership once, installs locally once, stores context, and invokes upgrade once;
- upgrade setup failure expires forwarding and compare-releases only its exact local/shared opening claim.

- [ ] **Step 2: Add failing fake-time drain-gate tests**

Use `vi.useFakeTimers()`/`vi.setSystemTime()` with a fixed `legacyViewerIssuerDrainedAt` and the exported production TTLs. Assert:

- `post_upgrade` is accepted before, at, and after both deadlines;
- `pre_upgrade` is rejected with a missing, malformed, or future drain timestamp;
- `pre_upgrade` is rejected one millisecond before the full viewer lifetime;
- at the viewer-token deadline it remains rejected for the additional ticket lifetime;
- one millisecond before the ticket deadline it remains rejected;
- exactly at `legacyViewerIssuerDrainedAt + VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS + WS_TICKET_TTL_SECONDS`, `pre_upgrade` is accepted;
- the calculated milestones are exactly 7,200 seconds and then 60 seconds in production mode.

Also mint a legacy viewer JWT one second before the recorded issuer drain, exchange it for an explicit V1 compatibility ticket one millisecond before viewer-JWT expiry, and prove the gate remains closed until that final V1 ticket's complete 60-second lifetime has elapsed. No V2 control ticket may substitute for this worst-case compatibility boundary.

With a separate `legacyTicketWriterDrainedAt`, prove the WebSocket V0 sub-drain remains incomplete until one full 60-second ticket lifetime has elapsed. This is only the earlier sub-deadline: it neither permits barrier reopen nor replaces or shortens the independent V1 viewer-token 7,200+60 drain.

From that same verified timestamp, independently prove:

- the WebSocket V0 deadline is exactly 60 seconds;
- the tunnel-HTTP credential deadline is exactly `max(HTTP_TUNNEL_TICKET_TTL_SECONDS, HTTP_TUNNEL_COOKIE_TTL_SECONDS) = 300` seconds with zero clock tolerance;
- at 60 seconds the external barrier still may not reopen, because V0 HTTP tickets/cookies remain within their maximum lifetime;
- one millisecond before 300 seconds, barrier reopen fails;
- exactly at 300 seconds, both V0 sub-drains are complete and only then may a fully verified pool reopen;
- if cookie verification ever configures nonzero clock tolerance, the gate includes the exact exported tolerance and tests its final millisecond.

Restore real timers after every test.

- [ ] **Step 3: Run the red middleware and drain-gate tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/remoteWsUpgrade.test.ts \
  src/services/remoteWsDrainGate.test.ts
```

Expected: FAIL because route validation begins after `101` and no exact drain gate exists.

- [ ] **Step 4: Add validated configuration**

Validate/map every configuration from the deployment contract: admission mode, auth mode, supported Redis topology, legacy V0 writer drain time, and legacy viewer issuer drain time. `pre_upgrade` startup calls the full drain assertion. Add values to root/deploy examples, compose test env, both compose files, and `scripts/prod/deploy.sh` required/enum checks. The deployment script independently computes and displays the 60-second WS and 300-second HTTP/cookie deadlines, refuses to reopen before their maximum, and also requires whole-pool digest parity, zero old processes/sockets, no reachable tunnel-HTTP consumer, and supported Redis preflight.

Add the Caddy matcher before general API proxying and tests that run Caddy/Compose configuration in both `closed` and `open`. The contract test derives coverage from all ticket issuers, WebSocket mounts, and the `tunnelHttpRoutes.all('/:tunnelId/*')` consumer, then probes both `?__bzt=<V0>` and a valid `bz_tunnel_<id>` cookie. `remote-access-cutover.test.sh` uses mocked process/container/proxy evidence to prove close → probe all issuer/upgrade/HTTP-consumer paths → stop/zero → independent 60-second WS sub-drain → independent 300-second HTTP/cookie sub-drain → uniform new pool → reopen ordering; every premature or failed check leaves the gate closed. Update hosted and self-hosted upgrade docs with the downtime/barrier procedure and the explicit prohibition on rolling this first lease-aware release.

- [ ] **Step 5: Implement middleware and route ordering**

Follow the existing agent WebSocket ordering:

```typescript
app.get(
  '/:id/ws',
  requireRemoteWsUpgrade({ expectedType: 'terminal', reserve }),
  upgradeWebSocket((c) => createTerminalWsHandlers(c.get('remoteWs')))
);
```

Use equivalent desktop and tunnel routes. In both modes, first consume and validate the ticket record/path/type/caller binding so an unauthenticated request cannot hold a shared lease. In `pre_upgrade`, complete live authorization next and reject V0/V1; in `post_upgrade`, accept correctly bound V0/V1 compatibility and defer only remaining live DB authorization to `onOpen`.

Then call the atomic Redis acquire before `upgradeWebSocket`, followed by synchronous local install. Desktop flow first resolves persisted intent/orphan recovery; owner or recovery returns `409`, inconsistent intent or Redis/topology inability returns `503`, and only a clean, authorized, nonterminal, non-orphan session may acquire. If setup fails, expire/release exact ownership. `pre_upgrade` performs no duplicate validation; `post_upgrade` authorizes already-consumed V0/V1/V2 without consuming again.

- [ ] **Step 6: Run the green middleware and drain-gate tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/remoteWsUpgrade.test.ts \
  src/services/remoteWsDrainGate.test.ts
bash scripts/prod/remote-access-cutover.test.sh
docker compose --env-file deploy/compose-config-test.env config >/dev/null
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/compose-config-test.env config >/dev/null
```

Expected: PASS; denials never upgrade, both modes acquire cross-replica ownership before `101`, V0/V1 never become MFA assurance, V0 JTI remains null, orphan admission fails closed, all issuer/upgrade/tunnel-HTTP consumers close together, and the 60-second WS, 300-second HTTP/cookie, and legacy-viewer drains are exact.

- [ ] **Step 7: Run all route-focused suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/routes/terminalWs_onmessage_lifecycle.test.ts \
  src/routes/terminalWs_close_revocation.test.ts \
  src/routes/terminalWs_utils_onopen.test.ts \
  src/routes/terminalWs_multitenant.test.ts \
  src/routes/terminalWs_rate_limit.test.ts \
  src/routes/desktopWs_lifecycle.test.ts \
  src/routes/desktopWs_onmessage.test.ts \
  src/routes/desktopWs_onopen.test.ts \
  src/routes/desktopWs_rate_limit_cleanup.test.ts \
  src/routes/desktopWs_multitenant.test.ts \
  src/routes/desktopWs_utils_http.test.ts \
  src/routes/desktopWs.test.ts \
  src/routes/tunnelWs.test.ts
```

Expected: PASS in both configured modes.

- [ ] **Step 8: Commit pre-upgrade authorization**

```bash
git add apps/api/src/services/remoteWsUpgrade.ts apps/api/src/services/remoteWsUpgrade.test.ts apps/api/src/services/remoteWsDrainGate.ts apps/api/src/services/remoteWsDrainGate.test.ts apps/api/src/services/remoteWsSharedLease.ts apps/api/src/services/remoteWsSharedLease.test.ts apps/api/src/services/desktopSessionFinalization.ts apps/api/src/services/desktopSessionFinalization.test.ts apps/api/src/services/desktopSessionOrphanRecovery.ts apps/api/src/services/desktopSessionOrphanRecovery.test.ts apps/api/src/routes/terminalWs.ts apps/api/src/routes/desktopWs.ts apps/api/src/routes/tunnelWs.ts apps/api/src/routes/tunnelHttp.ts apps/api/src/routes/tunnelHttp.test.ts apps/api/src/config/env.ts .env.example deploy/.env.example deploy/compose-config-test.env docker-compose.yml deploy/docker-compose.prod.yml docker/Caddyfile.prod scripts/prod/deploy.sh scripts/prod/remote-access-cutover.test.sh apps/docs/src/content/docs/deploy/upgrades.mdx
git commit -m "fix(remote): authenticate before websocket upgrade"
```

---

### Task 8: Make browser and viewer clients tolerate rejected handshakes

**Files:**
- Modify: `apps/web/src/components/remote/RemoteTerminal.tsx`
- Modify: `apps/web/src/components/remote/RemoteTerminal.test.tsx`
- Modify: `apps/web/src/components/remote/VncViewerPage.tsx`
- Create: `apps/web/src/components/remote/VncViewerPage.test.tsx`
- Modify: `apps/viewer/src/lib/transports/websocket.ts`
- Create: `apps/viewer/src/lib/transports/websocket.test.ts`
- Modify: `apps/viewer/src/components/DesktopViewer.tsx`
- Modify: `apps/viewer/src/lib/tunnel.ts`
- Modify: `apps/viewer/src/lib/tunnel.test.ts`

**Interfaces:**
- Consumes: WebSocket `error`/`close` before `open`, without relying on browser exposure of the HTTP status.
- Produces: safe cleanup plus an explicit retry that mints a new one-time ticket.

- [ ] **Step 1: Add failing pre-open rejection tests**

For terminal, desktop fallback viewer, and VNC:

- fire `error`/`close` before `open`;
- assert no terminal input, desktop input, ping, or tunnel byte is sent;
- assert timers/listeners are cleared;
- assert the used ticket URL is discarded;
- assert the user sees a connection-rejected/retry state;
- trigger retry and assert a fresh ticket request precedes a new WebSocket.

Do not assert the client can read `401/403/409/429`; the browser WebSocket API does not expose handshake status.

- [ ] **Step 2: Run the red client tests**

```bash
pnpm --filter=@breeze/web exec vitest run \
  src/components/remote/RemoteTerminal.test.tsx \
  src/components/remote/VncViewerPage.test.tsx
pnpm --filter=@breeze/viewer exec vitest run \
  src/lib/transports/websocket.test.ts \
  src/lib/tunnel.test.ts
```

Expected: FAIL because pre-open errors are not a distinct recoverable state.

- [ ] **Step 3: Implement one-shot handshake ownership**

Track `hasOpened` and an attempt generation. Before `open`, any error/close disposes only that attempt and presents retry. Retry remints through the existing authenticated HTTP ticket endpoint; it never reuses the WebSocket URL. After `open`, preserve existing disconnected behavior and wire messages.

Change `connectWebSocket` to resolve a usable wrapper only after successful open, or resolve `null` after a pre-open failure. Update `DesktopViewer` to ignore results from stale attempts.

- [ ] **Step 4: Run the green client tests**

```bash
pnpm --filter=@breeze/web exec vitest run \
  src/components/remote/RemoteTerminal.test.tsx \
  src/components/remote/VncViewerPage.test.tsx
pnpm --filter=@breeze/viewer exec vitest run \
  src/lib/transports/websocket.test.ts \
  src/lib/tunnel.test.ts
```

Expected: PASS; every retry mints a different ticket and stale attempts are inert.

- [ ] **Step 5: Commit client compatibility**

```bash
git add apps/web/src/components/remote/RemoteTerminal.tsx apps/web/src/components/remote/RemoteTerminal.test.tsx apps/web/src/components/remote/VncViewerPage.tsx apps/web/src/components/remote/VncViewerPage.test.tsx apps/viewer/src/lib/transports/websocket.ts apps/viewer/src/lib/transports/websocket.test.ts apps/viewer/src/components/DesktopViewer.tsx apps/viewer/src/lib/tunnel.ts apps/viewer/src/lib/tunnel.test.ts
git commit -m "fix(remote): recover from rejected websocket handshakes"
```

---

### Task 9: Prove raw pre-upgrade behavior and durable cross-process ownership

**Files:**
- Create: `apps/api/src/__tests__/integration/remote-ws-preupgrade.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/remote-ws-durability.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/remote-ws-redis-cluster.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/remote-ws-cutover.integration.test.ts`
- Create: `apps/api/src/__tests__/fixtures/remoteWsLeaseServer.ts`
- Create: `apps/api/src/__tests__/fixtures/legacyRemoteWsServer.ts`
- Create: `apps/api/src/__tests__/integration/fixtures/docker-compose.redis-cluster.yml`
- Create: `e2e-tests/tests/remote-access.spec.ts`

**Interfaces:**
- Consumes: two real OS processes/HTTP servers, historical/new ticket codecs, external maintenance proxy, standalone Redis plus three-node Redis Cluster, BullMQ, PostgreSQL `device_commands`, kill/restart controls, a restartable agent sink, and browser clients.
- Produces: no mixed admission, no `CROSSSLOT`, no cross-process overlap, two complete V0 sub-drains, and stop-confirmed recovery at every teardown crash boundary.

- [ ] **Step 1: Write raw HTTP upgrade tests**

For all three routes, send Upgrade requests with missing, invalid, consumed, mismatched, unauthorized, and concurrently owned tickets. Parse the first HTTP response line and assert `401`, `403`, `404`, `409`, or `429` as applicable and absence of `101 Switching Protocols`.

- [ ] **Step 2: Add a pipelined-frame regression**

Using `node:net`, write the HTTP upgrade headers and a masked WebSocket input frame in one TCP write. Use an invalid ticket. Assert the response is not `101`, the upgrade handler is never constructed, and the agent command spy receives no terminal input, desktop input, or tunnel data.

- [ ] **Step 3: Add valid interoperability controls**

For each transport, use a valid one-time ticket, complete `101`, exchange the existing connected/ping/data protocol, and close. Add a reverse-proxy E2E control through the deployed API URL proving terminal and VNC/desktop clients still connect without protocol changes.

- [ ] **Step 4: Add real durability and transaction integration tests**

Do not mock Redis, BullMQ, PostgreSQL, process boundaries, or HTTP servers. Spawn two child OS processes with distinct boot UUIDs/listeners; never substitute two manager objects in one process. Use unique keys/queues/rows and deterministic cleanup. Cover:

- two independent server processes sharing Redis: one wins, the other receives `already_owned`, exact renewal works, stale renewal/release fails, and per-kind/session generation increases after process restart;
- pause the winner past `safeForwardingUntilMonotonicMs` while its Redis key still exists; invoke local callbacks and prove no forwarding, then prove the loser cannot acquire until Redis expiry and can acquire afterward with no overlap;
- simulate Redis partition/renew failure; prove forwarding is disabled before cleanup and before a replacement can acquire;
- replace the Redis owner before stale cleanup proof; prove the stale instance performs local-only detach and emits no agent stop, finalization, DB write, or audit against the replacement;
- desktop acquisition versus intent creation concurrently: the atomic scripts permit either the owner or the complete intent pair, never an owner with a pending intent and never a partial pair;
- persisted fence and payload both report `PTTL = -1`, survive a fresh service instance, and deny a new desktop acquisition after the original local map is gone;
- the finalization UUID creates exactly one immutable `device_commands` identity; same-ID retries across API and agent restarts execute the idempotent stop sink and produce validated `stopped|already_absent`, while conflicting device/session/payload reuse fails closed;
- disconnect the agent after durable stop insertion: worker, orphan recovery, and operator reconciliation all return/retain `stop_pending`, the database stays nonterminal, both intent keys remain, and admission stays denied until reconnect/delivery/ack;
- inject send success without result, generic `duplicate`, timeout, malformed result, and a crash after generic mark-seen but before handler dispatch; none permit finalization or pair deletion, and redelivery still invokes the stop sink;
- stable BullMQ job ID acknowledgement, duplicate enqueue identity, worker loading the exact Redis payload, and queue-record removal after completed/failed retention without deleting the payload/fence;
- five-attempt exhaustion retains both exact values; a fresh worker/reconciler can still load and validate the payload;
- send `SIGKILL` to the owning process at before-intent, after-intent-before-stop-row, after-stop-row-before-agent-ack, after-confirmed-stop-before-DB-finalize, after-detach, during-finalize, before-enqueue-ack, and after-enqueue-ack barriers; restart and prove exact-intent recovery or two-observation orphan recovery, stable stop identity, no DB finalization/pair deletion before terminal-safe acknowledgement, and never stale admission;
- real PostgreSQL conditional transition plus summary audit commits exactly once under duplicate workers;
- an injected audit-insert failure rolls back the real session update and audit together, then a retry commits both once;
- authenticated operator reconciliation rejects non-active/demoted/non-MFA callers, live reusable jobs, mismatched IDs/payload, unconfirmed stop, and failed audit; successful reconciliation first proves stop, then audits and compare-deletes both keys.

Against a real three-node Redis Cluster, execute **every** acquire/renew/`beginClose`/release/desktop-acquire/intent-write/pair-delete/orphan-claim Lua script for terminal, desktop, and tunnel. Assert no `CROSSSLOT`, inspect `CLUSTER KEYSLOT` for every script key, and prove the generation key uses the same `{kind:sessionId}` slot. This is compatibility evidence only; the production topology monitor must still reject cluster mode.

Run the historical and lease-aware fixture servers simultaneously behind the real maintenance matcher. With the barrier open, the harness must flag the mixed pool as forbidden; with it closed, every ticket/upgrade path and every `/api/v1/tunnel-http/*` request carrying either a V0 ticket or a previously valid scoped cookie returns `503`, and neither server receives the request. Stop/force-close the old process, prove zero old sockets/processes, record the last writer timestamp, and independently advance through the 60-second WebSocket and 300-second tunnel-HTTP credential deadlines. At 60 seconds reopen must still fail; at 300 seconds old HTTP ticket/cookie probes must be cryptographically expired. Start/verify the complete new pool, then reopen and prove only lease-aware admission. Any premature reopen or HTTP consumer bypass fails.

- [ ] **Step 5: Run focused integration and E2E**

```bash
pnpm --filter=@breeze/api test:docker:up
docker compose -f apps/api/src/__tests__/integration/fixtures/docker-compose.redis-cluster.yml up -d
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/remote-ws-preupgrade.integration.test.ts \
  src/__tests__/integration/remote-ws-durability.integration.test.ts \
  src/__tests__/integration/remote-ws-redis-cluster.integration.test.ts \
  src/__tests__/integration/remote-ws-cutover.integration.test.ts
docker compose -f apps/api/src/__tests__/integration/fixtures/docker-compose.redis-cluster.yml down -v
pnpm --dir e2e-tests exec playwright test tests/remote-access.spec.ts
pnpm --filter=@breeze/api test:docker:down
```

Expected: PASS; barrier prevents mixed admission and old HTTP credential use, invalid frames never reach agents, two OS processes never overlap, all Cluster Lua calls avoid `CROSSSLOT`, unsupported production topology is rejected, and every crash point recovers by exact intent or fail-closed orphan finalization only after terminal-safe stop proof.

- [ ] **Step 6: Commit boundary evidence**

```bash
git add apps/api/src/__tests__/integration/remote-ws-preupgrade.integration.test.ts apps/api/src/__tests__/integration/remote-ws-durability.integration.test.ts apps/api/src/__tests__/integration/remote-ws-redis-cluster.integration.test.ts apps/api/src/__tests__/integration/remote-ws-cutover.integration.test.ts apps/api/src/__tests__/fixtures/remoteWsLeaseServer.ts apps/api/src/__tests__/fixtures/legacyRemoteWsServer.ts apps/api/src/__tests__/integration/fixtures/docker-compose.redis-cluster.yml e2e-tests/tests/remote-access.spec.ts
git commit -m "test(remote): prove upgrade and lease durability"
```

---

### Task 10: Run concurrency, build, canary, and drain gates

**Files:**
- Modify after deployment from the canonical primary checkout: `internal/security-remediation/2026-07-23-execution-ledger.md` (gitignored; never stage or commit)

**Interfaces:**
- Produces: recorded release evidence for both Wave 4 findings.

- [ ] **Step 1: Run all focused API suites repeatedly**

```bash
for run in 1 2 3 4 5; do
  pnpm --filter=@breeze/api exec vitest run \
    src/services/remoteWsOwnership.test.ts \
    src/services/remoteWsSharedLease.test.ts \
    src/services/remoteWsRedisTopology.test.ts \
    src/services/remoteSessionAuth.test.ts \
    src/services/jwt.test.ts \
    src/services/viewerTokenTtl.test.ts \
    src/services/viewerTokenRevocation.test.ts \
    src/services/remoteWsAuthorization.test.ts \
    src/services/remoteWsUpgrade.test.ts \
    src/services/remoteWsDrainGate.test.ts \
    src/services/desktopSessionFinalization.test.ts \
    src/services/desktopSessionOrphanRecovery.test.ts \
    src/services/desktopSessionStop.test.ts \
    src/services/commandQueue.test.ts \
    src/jobs/desktopSessionFinalizationWorker.test.ts \
    src/jobs/queueSchemas.test.ts \
    src/routes/remote/sessions.test.ts \
    src/routes/admin/desktopFinalization.test.ts \
    src/routes/admin/desktopFinalizationCli.test.ts \
    src/routes/terminalWs_onmessage_lifecycle.test.ts \
    src/routes/terminalWs_close_revocation.test.ts \
    src/routes/terminalWs_utils_onopen.test.ts \
    src/routes/terminalWs_multitenant.test.ts \
    src/routes/terminalWs_rate_limit.test.ts \
    src/routes/desktopWs_lifecycle.test.ts \
    src/routes/desktopWs_onmessage.test.ts \
    src/routes/desktopWs_onopen.test.ts \
    src/routes/desktopWs_rate_limit_cleanup.test.ts \
    src/routes/desktopWs_multitenant.test.ts \
    src/routes/desktopWs_utils_http.test.ts \
    src/routes/desktopWs.test.ts \
    src/routes/tunnels.test.ts \
    src/routes/tunnelHttp.test.ts \
    src/routes/tunnelWs.test.ts || exit 1
done
cd agent && go test -race ./internal/heartbeat/...
```

Expected: five PASS API runs plus the agent race suite, with no flaky stop proof, audit, state, queue acknowledgement, payload/fence, ticket-version/JTI, viewer-lineage TTL, HTTP credential TTL, or local/shared ownership assertion; the operator CLI contract also passes.

- [ ] **Step 2: Run real durability, client, and build gates**

```bash
pnpm --filter=@breeze/api test:docker:up
docker compose -f apps/api/src/__tests__/integration/fixtures/docker-compose.redis-cluster.yml up -d
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/remote-ws-preupgrade.integration.test.ts \
  src/__tests__/integration/remote-ws-durability.integration.test.ts \
  src/__tests__/integration/remote-ws-redis-cluster.integration.test.ts \
  src/__tests__/integration/remote-ws-cutover.integration.test.ts
docker compose -f apps/api/src/__tests__/integration/fixtures/docker-compose.redis-cluster.yml down -v
pnpm --filter=@breeze/api test:docker:down
bash scripts/prod/remote-access-cutover.test.sh
docker compose --env-file deploy/compose-config-test.env config >/dev/null
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/compose-config-test.env config >/dev/null
pnpm --filter=@breeze/web exec vitest run \
  src/components/remote/RemoteTerminal.test.tsx \
  src/components/remote/VncViewerPage.test.tsx
pnpm --filter=@breeze/viewer exec vitest run \
  src/lib/transports/websocket.test.ts \
  src/lib/tunnel.test.ts
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web build
pnpm --filter=@breeze/viewer build
pnpm --dir e2e-tests exec playwright test tests/remote-access.spec.ts
```

Expected: all tests and builds exit 0.

- [ ] **Step 3: Execute the no-mixed-pool lease cutover and observe `post_upgrade`**

First validate the barrier-only prerequisite release. For the lease cutover, close/probe the external gate, drain and force-close remote sockets, stop the entire old pool, and record:

- every covered ticket/upgrade path returning `503` while closed;
- `/api/v1/tunnel-http/*` returning `503` for first-navigation V0 tickets, redirects, and already valid scoped-cookie requests while closed;
- zero old API processes/containers and zero old upgraded connections;
- `legacy_ticket_writer_drained_at`, the exact 60-second WebSocket sub-drain, the exact 300-second tunnel-HTTP ticket/cookie sub-drain, and refusal to reopen at the earlier boundary;
- Redis standalone-primary/AOF/`noeviction`/cluster-disabled/topology-fresh evidence;
- exact uniform new image digest and lease protocol version for the complete replacement pool before reopen;
- old/new two-process barrier test evidence and refusal of premature reopen;
- foreign/stale event rejection counts by transport;
- local versus shared second-owner rejection counts;
- lease acquire/renew/release latency and result counts, renewal loss/mismatch counts, safety-deadline expiry counts, and opening expiry counts;
- proof that two replicas never report a forwarding owner for one transport/session at the same time;
- cleanup deduplication counts;
- stable stop-command identity, delivery/redelivery, terminal-safe acknowledgement, state, and audit counts, with no database finalization or pair deletion while stop is pending;
- desktop finalization inline-success, queued-retry, enqueue-failure, exhausted-retry, and fence-depth counts;
- write-ahead success/failure, crash-boundary orphan detection/claim/finalization, and admission-denied-during-recovery counts;
- oldest persistent intent age, fence/payload/job-state mismatch count, retained-payload recovery count, and audited operator-reconciliation success/failure count;
- session completion/error rate compared with the preceding release.

Expected: remote admission is never open to mixed lease protocols or a live V0 HTTP credential; no replicas overlap; every queued retry has exact intent and stop identity; every pre-intent crash becomes a fail-closed orphan recovery; no database finalization precedes agent stop proof; and no unsupported Redis topology admits. Close the barrier immediately if evidence is incomplete.

- [ ] **Step 4: Prove issuer drain and the full viewer-token boundary**

Immediately before removing the last instance capable of minting a viewer JWT without `mfaSatisfied`, mint one legacy canary viewer JWT and record its exact `iat`/`exp`. Then remove that instance, enumerate all running API instances and versions, require zero pre-lease instances and zero remaining legacy viewer-JWT issuers, and record that verified removal time as `legacy_viewer_issuer_drained_at`; do not infer it from `/health`, image intent, or deploy start.

Read and record `VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS` from the deployed artifact; production must report `7_200`. Keep every instance in `post_upgrade` until `legacy_viewer_issuer_drained_at + 7_200 seconds`. With controlled fake-time/integration probes and real deployment timestamps, record:

- the legacy viewer JWT remains a compatibility input immediately before its expiry;
- in the last representable second before that exact JWT expiry, exchange it for the final explicit V1 compatibility ticket, verify the record has no MFA assertion, and record its exact issue/expiry time;
- both `/api/v1/vnc-viewer/upgrade-to-webrtc` and `/api/v1/vnc-viewer/downgrade-to-vnc` reject that legacy token with exact `403 legacy_viewer_transition_forbidden` and create no session, command, ticket, JWT, or audit;
- an MFA-assured transition descendant retains `mfaSatisfied: true` and the root `assuranceAbsoluteExpiresAt`; repeated upgrade/downgrade cannot move `exp` beyond the root boundary;
- at/after the JWT's exact `exp`, it is expired and cannot mint another ticket;
- `pre_upgrade` remains blocked throughout that complete interval.

- [ ] **Step 5: Drain the additional WebSocket ticket lifetime**

Keep `post_upgrade` for one additional `WS_TICKET_TTL_SECONDS` (currently 60 seconds) from the viewer-token deadline. Prove the final V1 compatibility ticket works immediately before its own expiry and fails at/after expiry. In parallel, use a new MFA-assured viewer JWT only as a control to prove normal issuance is V2 true; do not use that V2 control as the drain boundary. Only after the final possible V1 ticket has expired may the fixed drain gate open.

- [ ] **Step 6: Canary `pre_upgrade`**

Progress one instance, 10%, 50%, and 100%. At each ring, run invalid-ticket/no-101 probes, one valid terminal, desktop, and tunnel session, concurrent second-owner probe, and concurrent close/error/revocation probe. Stop on any condition below.

- [ ] **Step 7: Record release and rollback evidence from the canonical primary checkout**

After deployment, update `internal/security-remediation/2026-07-23-execution-ledger.md` from the canonical primary checkout, not this implementation worktree. Record barrier prerequisite/cutover probes including HTTP-ticket/cookie consumers, zero-old-process/socket proof, uniform new digest, Redis topology preflight, `legacy_ticket_writer_drained_at` plus independent 60-second WS and 300-second HTTP/cookie waits, V0 compatibility fixtures/null JTI, `legacy_viewer_issuer_drained_at`, transition rejection/lineage-expiry evidence, final V1 ticket and 7,200+60 wait, process/cluster/crash-boundary tests, durable stop acknowledgements, orphan telemetry, stop-gated inspect/reconcile exercise, final Playwright result, and barrier-first rollback evidence.

- [ ] **Step 8: Request independent review and commit verification**

The reviewer must inspect barrier path completeness including tunnel-HTTP ticket/cookie consumers, independent 60/300-second V0 drains, whole-pool ordering, V0 nullable-JTI and V1/V2 compatibility, legacy transition rejection and descendant absolute-expiry propagation, every hash-tagged Lua key and supported topology check, two-process overlap, forwarding deadlines, write-ahead-before-detach ordering, safety detach on Redis failure, every kill boundary/orphan recovery, durable agent-sink stop proof on normal/worker/orphan/operator paths, nonterminal persisted reconciliation, inspect response bounds, DB/audit transactionality, queue retention, client generations, and final proxy E2E.

No commit is expected for this step because the coordinator ledger is intentionally ignored.

## Enforcement Stop Conditions

Stop the applicable canary immediately if:

- in either mode, any missing/invalid/consumed/path-type-session-mismatched ticket or second-owner request receives `101`;
- any ticket/upgrade path or `/api/v1/tunnel-http/*` V0-ticket/scoped-cookie request bypasses the closed external barrier, the barrier reopens with an old/unknown process/socket, or pre-lease and lease-aware servers admit concurrently;
- in `pre_upgrade`, any V0/V1 compatibility, inactive, unauthorized, site-denied, MFA-unassured, policy-denied, or rate-limited request receives `101`;
- V0 is normalized/versioned or given non-null JTI/MFA, `ConsumedRemoteWsTicketContext.ticketJti` fabricates a string for V0, any normal/new issuer writes V0/V1, V2 lacks true MFA, or either old→new/new→old codec test fails;
- either viewer transition accepts a legacy no-claim JWT, produces any side effect before exact `403 legacy_viewer_transition_forbidden`, drops true MFA assurance, changes the signed root absolute-expiry lineage, or extends a descendant beyond that boundary;
- any pipelined pre-authentication frame reaches an agent;
- two API instances forward for the same transport/session at the same time;
- a generation key is global/process-local, any Lua key lacks the exact `{kind:sessionId}` tag, Redis Cluster reports `CROSSSLOT`, or owner/desktop intent operations are non-atomic;
- production admission opens on replica/cluster/unknown/stale/failover topology, without AOF/`noeviction`, or on async HA without agent-sink fencing;
- an acquire/renew reply beyond the maximum round-trip extends forwarding, or a renewal error/mismatch/partition/event-loop pause leaves the old owner able to forward at or after its safe deadline;
- a lease-loss path sends an agent stop or finalizes after exact-owner proof reports mismatch;
- a foreign or stale socket changes pong state, relays input/data, removes callbacks, changes DB state, audits, or tears down an owner;
- a captured callback/timer from an old generation acts on a new owner;
- concurrent desktop cleanup allocates more than one durable stop identity, a same-ID redelivery is not agent-sink-idempotent, or cleanup emits more than one state transition, viewer revocation, or summary audit;
- when Redis is available, detach/stop precedes acknowledged write-ahead intent; when Redis is unavailable/indeterminate, detach/stop fails to occur promptly for safety;
- worker, admission/background orphan recovery, or operator reconciliation finalizes the DB or deletes either intent key before the exact durable stop result proves `stopped|already_absent`;
- agent disconnection, send success, generic duplicate, timeout, missing/malformed result, or stale connection epoch is treated as terminal-safe stop proof;
- a crash at any teardown boundary, especially after intent-before-stop or after-stop-before-finalization, changes the stop identity, loses the pending durable command, deletes intent, or lets admission reopen instead of stop-gated recovery;
- finalization-intent persistence or enqueue failure removes a closing shared lease or permits a second owner;
- a waiting, delayed, active, failed, exhausted, or retention-removed finalization job lacks its exact durable fence **or** complete canonical payload;
- either finalization key has any Redis expiry, the pair is inconsistent, or either disappears because of elapsed time/job retention;
- inspect/reconcile is callable without live active platform-admin/MFA, inspect leaks unbounded/raw/secret/agent-result state, CLI cannot discover the server ID/stop state by session, or reconciliation refuses a valid persisted nonterminal intent instead of driving stop-gated finalization;
- reconciliation accepts caller actor identity, exposes force/age/direct-storage, or releases without exact ID/payload match, no reusable job, confirmed stop proof, conditional finalization/already-finalized result, synchronous audit, and atomic pair delete;
- duplicate finalization jobs produce a second state transition or summary audit;
- the barrier reopens before both the 60-second V0 WebSocket-ticket deadline and the 300-second V0 tunnel-HTTP ticket/cookie deadline after the last old writer, either sub-drain is inferred rather than proved, or `pre_upgrade` begins before the independent full viewer-token plus V1 ticket drain;
- an opening reservation is stranded beyond its expiry, a stale expiry removes a newer lease, or a shared owner remains locally forwardable without safe renewal;
- legitimate terminal, desktop, tunnel, agent, viewer, or reverse-proxy interoperability regresses;
- a client retries with the same ticket URL;
- logs contain ticket values, query strings, input, frames, or credentials.

Contain by closing the external barrier first, including all `/api/v1/tunnel-http/*` consumers. Keep it closed while force-closing sockets and replacing the entire pool with a known lease-aware `post_upgrade` artifact; reopen only after version/topology checks and fresh independent 60-second WS plus 300-second HTTP/cookie sub-drains from the last old writer. Retain every desktop intent and durable stop row until terminal-safe acknowledgement and conditional finalization. Never roll back to pre-lease admission, mixed pools, identifier-only dispatch, implicit replacement, unproved stop completion, or duplicated teardown.
