import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { getRedis, rateLimiter } from '../services';
import { type AgentTokenSuspendReason } from '../services/agentTokenSuspension';
import { enforceAgentCertificateBinding, readAgentCertificateAssertion } from '../services/agentCertificateBinding';
import { createAuditLogAsync } from '../services/auditService';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { getAgentTenantState } from '../services/tenantStatus';
import { isDeviceUninstallDraining } from '../services/deviceUninstallDrain';
import {
  AGENT_ORG_RATE_WINDOW_SECONDS,
  computeReservedIngestLimit,
  isReservedIngestPath,
  resolveOrgRateLimit,
} from '../services/agentOrgRateLimit';

export interface AgentAuthContext {
  deviceId: string;
  agentId: string;
  orgId: string;
  siteId: string;
  role: AgentCredentialRole;
  /**
   * SHA-256 hex of the bearer token that actually authenticated this request —
   * i.e. the CURRENT-token hash the middleware matched (rotation-required
   * previous-token callers are still surfaced via `agentTokenRotationRequired`,
   * but must be rejected before any credential mint; see token.ts rotate-token).
   * Used by rotate-token to compare-and-swap the rotation against the exact
   * hash that authenticated, so a superseded/racing token cannot mint durable
   * credentials. Never log or return this value.
   *
   * Optional at the type level so existing callers that build a partial agent
   * context (tests, non-rotation routes) still typecheck; the real middleware
   * ALWAYS populates it, and rotate-token fails closed if it is ever absent.
   */
  authTokenHash?: string;
  /**
   * #2774 — true when the tenant is in the `offboarding` drain window. The
   * middleware has already restricted the route surface; handlers that claim
   * commands additionally narrow the claim to `self_uninstall` only.
   */
  tenantDraining?: boolean;
  /**
   * #3986 — true when THIS DEVICE (not its tenant) is inside the device-remove
   * uninstall drain window: `status='decommissioned'` AND a non-terminal
   * `self_uninstall` carrying the `device_remove` reason AND an unexpired
   * `device_remove_expires_at`. The single source of that predicate is
   * `services/deviceUninstallDrain.isDeviceUninstallDraining` — never re-derive
   * it, and never widen it to "decommissioned + any pending self_uninstall":
   * abuse-suspension queues `self_uninstall` onto already-decommissioned rows
   * with no reason and no deadline, and admitting those would resurrect a
   * suspended partner's agent channel.
   *
   * Distinct from `tenantDraining` on purpose. Both narrow the ROUTE surface
   * and the claim allowlist identically, but only this one means "the machine
   * itself is being removed", which is what the heartbeat's minimal drain
   * branch keys on.
   */
  deviceUninstallDraining?: boolean;
  /**
   * The ONE derived command-type allowlist for every `device_commands` claim
   * site on this request. `undefined` means unrestricted — which is also
   * `claimPendingCommandsForDevice`'s default for a missing `typeAllowlist`,
   * so a claim site that forgets to consult a drain flag silently claims
   * EVERYTHING. Deriving the value once here and passing it through is what
   * removes that trap: the only thing a claim site has to remember is to pass
   * `agent.claimTypeAllowlist`.
   */
  claimTypeAllowlist?: readonly string[];
}

export type AgentCredentialRole = 'agent' | 'watchdog';

declare module 'hono' {
  interface ContextVariableMap {
    agent: AgentAuthContext;
    agentTokenRotationRequired: boolean;
    /** Issue #2621 — caller authenticated with a staged (pending) rotation credential. */
    agentPendingTokenPresented: boolean;
  }
}

// 120 requests per 60-second window per agent
const AGENT_RATE_LIMIT = 120;
const AGENT_RATE_WINDOW_SECONDS = 60;
// Task 19: per-(agent, source-IP) bucket. A stolen token used from a second
// IP can no longer eat the legit agent's 120/min budget — it has its own
// smaller 30/min ceiling, and the legit agent keeps its own.
const AGENT_PER_IP_RATE_LIMIT = 30;
const AGENT_PER_IP_RATE_WINDOW_SECONDS = 60;
// Dedup TTL for `agent.source.ip.changed` audits: log a given (device, IP)
// pair at most once per day so noisy mobile/roaming agents don't drown ops
// in events.
const AGENT_IP_CHANGE_AUDIT_DEDUP_SECONDS = 24 * 60 * 60;
// Per-org budget. Previously a flat 600/min for every tenant regardless of
// fleet size, which silently dropped patch inventory on any org past ~100-300
// devices (#2728). Now scaled by enrolled device count between a floor and a
// hard ceiling — see services/agentOrgRateLimit.ts for the sizing rationale.
const DEFAULT_AGENT_TOKEN_ROTATION_MAX_AGE_DAYS = 30;

function tokenHashMatches(storedHash: string, tokenHash: string): boolean {
  const storedBuf = Buffer.from(storedHash, 'hex');
  const computedBuf = Buffer.from(tokenHash, 'hex');
  if (storedBuf.length !== computedBuf.length) {
    return false;
  }

  return timingSafeEqual(storedBuf, computedBuf);
}

export function matchAgentTokenHash(params: {
  agentTokenHash: string | null | undefined;
  previousTokenHash: string | null | undefined;
  previousTokenExpiresAt: Date | null | undefined;
  pendingTokenHash?: string | null | undefined;
  pendingTokenExpiresAt?: Date | null | undefined;
  tokenHash: string;
  now?: Date;
}): { tokenRotationRequired: boolean; pendingTokenPresented: boolean } | null {
  const {
    agentTokenHash,
    previousTokenHash,
    previousTokenExpiresAt,
    pendingTokenHash,
    pendingTokenExpiresAt,
    tokenHash,
    now = new Date(),
  } = params;

  if (agentTokenHash && tokenHashMatches(agentTokenHash, tokenHash)) {
    return { tokenRotationRequired: false, pendingTokenPresented: false };
  }

  // Issue #2621 — a staged (pending) credential authenticates for real while the
  // rotation is unconfirmed. This is what makes two-phase rotation crash-safe:
  // between the agent's durable disk write and its confirm call, EITHER
  // credential on disk is accepted, so a crash at any point in that window
  // cannot strand the endpoint. Presenting it is also proof the agent holds the
  // new token, which /rotate-token/confirm converts into a promotion.
  if (
    pendingTokenHash &&
    pendingTokenExpiresAt &&
    pendingTokenExpiresAt > now &&
    tokenHashMatches(pendingTokenHash, tokenHash)
  ) {
    return { tokenRotationRequired: false, pendingTokenPresented: true };
  }

  if (
    previousTokenHash &&
    previousTokenExpiresAt &&
    previousTokenExpiresAt > now &&
    tokenHashMatches(previousTokenHash, tokenHash)
  ) {
    return { tokenRotationRequired: true, pendingTokenPresented: false };
  }

  return null;
}

export function matchRoleScopedAgentTokenHash(params: {
  agentTokenHash: string | null | undefined;
  previousTokenHash: string | null | undefined;
  previousTokenExpiresAt: Date | null | undefined;
  watchdogTokenHash: string | null | undefined;
  previousWatchdogTokenHash: string | null | undefined;
  previousWatchdogTokenExpiresAt: Date | null | undefined;
  pendingTokenHash?: string | null | undefined;
  pendingWatchdogTokenHash?: string | null | undefined;
  pendingTokenExpiresAt?: Date | null | undefined;
  tokenHash: string;
  now?: Date;
}): ({ role: AgentCredentialRole; tokenRotationRequired: boolean; pendingTokenPresented: boolean }) | null {
  const {
    agentTokenHash,
    previousTokenHash,
    previousTokenExpiresAt,
    watchdogTokenHash,
    previousWatchdogTokenHash,
    previousWatchdogTokenExpiresAt,
    pendingTokenHash,
    pendingWatchdogTokenHash,
    pendingTokenExpiresAt,
    tokenHash,
    now = new Date(),
  } = params;

  const agentMatch = matchAgentTokenHash({
    agentTokenHash,
    previousTokenHash,
    previousTokenExpiresAt,
    pendingTokenHash,
    pendingTokenExpiresAt,
    tokenHash,
    now,
  });
  if (agentMatch) {
    return {
      role: 'agent',
      tokenRotationRequired: agentMatch.tokenRotationRequired,
      pendingTokenPresented: agentMatch.pendingTokenPresented,
    };
  }

  const watchdogMatch = matchAgentTokenHash({
    agentTokenHash: watchdogTokenHash,
    previousTokenHash: previousWatchdogTokenHash,
    previousTokenExpiresAt: previousWatchdogTokenExpiresAt,
    // The watchdog's staged credential shares the agent rotation's expiry —
    // both are minted and promoted by the same two-phase rotation.
    pendingTokenHash: pendingWatchdogTokenHash,
    pendingTokenExpiresAt,
    tokenHash,
    now,
  });
  if (watchdogMatch) {
    return {
      role: 'watchdog',
      tokenRotationRequired: watchdogMatch.tokenRotationRequired,
      pendingTokenPresented: watchdogMatch.pendingTokenPresented,
    };
  }

  return null;
}

function getAgentTokenRotationMaxAgeDays(): number {
  const raw = Number.parseInt(process.env.AGENT_TOKEN_ROTATION_MAX_AGE_DAYS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AGENT_TOKEN_ROTATION_MAX_AGE_DAYS;
  }
  return Math.min(raw, 365);
}

export function isAgentTokenRotationDue(tokenIssuedAt: Date | null | undefined, now = new Date()): boolean {
  if (!tokenIssuedAt) {
    return true;
  }

  const maxAgeMs = getAgentTokenRotationMaxAgeDays() * 24 * 60 * 60 * 1000;
  return now.getTime() - tokenIssuedAt.getTime() >= maxAgeMs;
}

/**
 * Task 18: Persistently suspend an agent token. Called when the WS layer
 * detects a cross-tenant probe pattern (token spraying foreign session IDs).
 * Idempotent — only writes on the first call per device.
 *
 * Unsuspending requires manual operator action (clear the columns directly
 * or via a future admin endpoint); the agent will retry forever and produce
 * a loud reconnect-loop signal that surfaces the suspension to ops.
 */
export async function suspendAgentToken(deviceId: string, reason: AgentTokenSuspendReason): Promise<void> {
  try {
    await withSystemDbAccessContext(async () => {
      await db
        .update(devices)
        .set({
          agentTokenSuspendedAt: new Date(),
          agentTokenSuspendedReason: reason.slice(0, 100),
        })
        .where(and(eq(devices.id, deviceId), isNull(devices.agentTokenSuspendedAt)));
    });
  } catch (err) {
    // Best-effort: the auth gate is the source of truth. A failed suspension
    // write just means the next probe will try again.
    console.error('[agentAuth] suspendAgentToken failed', {
      deviceId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Action segment of the CORE `/api/v1/agents/<agentId>/<action>` routes that
 * open their own withDbAccessContext around their DB work instead of relying
 * on the request-long wrap in agentAuthMiddleware. Matched through
 * `isCoreAgentPath`, so a same-named segment anywhere else (an extension
 * gateway route, a nested sub-path) does NOT opt out. See the #1105 note at the wrap site. Auth still runs in
 * full for these routes — only the org-context transaction wrap is skipped.
 *
 * `commands` (the GET command poll) is here because its handler claims commands
 * inside its own `withSystemDbAccessContext` — the same claim+decrypt path the
 * self-managed heartbeat route already runs context-free. Keeping the
 * request-long org wrap on top made every poll hold TWO pooled connections at
 * once (`runOutsideDbContext` does not release the outer transaction), which
 * self-deadlocked the pool under load: all slots pinned by outer transactions
 * parked idle-in-transaction waiting for an inner connection, reaped at the
 * 60s idle_in_transaction_session_timeout as `500 @60s`, re-polled by agents,
 * repeat (US prod outage, 2026-07-24).
 */
const SELF_MANAGED_DB_CONTEXT_ACTIONS = new Set(['heartbeat', 'reliability', 'commands']);

/**
 * Single-segment actions allowed during a TENANT (`offboarding`) drain:
 * `/api/v1/agents/<agentId>/<action>`. #2774's original set.
 */
const TENANT_DRAIN_ALLOWED_ACTIONS = new Set(['heartbeat', 'commands', 'logs', 'rotate-token']);

/**
 * #3986 — the DEVICE-remove drain's set, which is deliberately NARROWER than
 * the tenant one: `rotate-token` is dropped.
 *
 * `routes/agents/token.ts` has no independent `devices.status` guard, and the
 * credentials it mints OUTLIVE the drain window — nothing revokes a staged or
 * promoted rotation when the deadline passes, and `POST /devices/:id/restore`
 * does not touch a single token hash. So a stolen agent token on a removed
 * device could be rotated into a fresh agent + watchdog + helper credential
 * set that lies dormant through the 403 after expiry and becomes the LIVE
 * credential the moment an operator restores the device — which this very
 * feature supports. Rotation also DEMOTES the legitimate token, so a thief can
 * deny the real machine the uninstall the window exists to deliver.
 *
 * Dropping it costs nothing. A staged-but-unconfirmed rotation still
 * authenticates as `role: 'agent'` through `matchRoleScopedAgentTokenHash`, so
 * an agent mid-rotation passes the Layer 1b role gate and can heartbeat and
 * collect its uninstall without ever calling `rotate-token`. #2774's
 * "don't strand a mid-stage rotation" rationale covers the CONFIRM half (the
 * machines there are legitimately alive and must stay manageable); it never
 * justified the MINT half for a machine we are actively uninstalling.
 *
 * `rotate-token/confirm` is NOT in this set because it never was in either set
 * — it is matched by its own two-segment branch below, and stays allowed for
 * both drain kinds so an agent that already persisted a staged credential can
 * finish and avoid being locked out mid-drain.
 */
const DEVICE_UNINSTALL_DRAIN_ALLOWED_ACTIONS = new Set(['heartbeat', 'commands', 'logs']);

/**
 * Both drains at once (a removed device inside an offboarding tenant): the
 * INTERSECTION of the two sets, never either one whole.
 *
 * Two independent narrowing gates compose by intersection, full stop. The
 * earlier "whichever drain is the tenant one wins" form composed by union in
 * the only case that mattered: it handed `rotate-token` back to exactly the
 * device the DEVICE drain had just taken it away from, silently reopening
 * HIGH-1 (a stolen token on a removed machine minting a durable agent +
 * watchdog + helper credential set that outlives the window and goes live on
 * restore, while demoting the legitimate token and denying the real machine
 * its uninstall). A tenant drain is not evidence that a removed device is
 * safer; it is a second, independent reason to trust it less.
 *
 * Computed once at module load — this is a fixed set, not per-request state.
 */
const BOTH_DRAINS_ALLOWED_ACTIONS = new Set(
  [...DEVICE_UNINSTALL_DRAIN_ALLOWED_ACTIONS].filter((action) =>
    TENANT_DRAIN_ALLOWED_ACTIONS.has(action),
  ),
);

/**
 * The ONLY command type a drained agent — tenant-offboarding (#2774) or
 * device-remove (#3986) — may claim, ack, or have delivered.
 *
 * Exported so no handler has to restate the literal. `claimPendingCommandsForDevice`'s
 * `typeAllowlist` parameter is OPTIONAL and defaults to unrestricted, so every
 * restatement is a place a future edit can silently drop the narrowing and
 * hand a departing (or removed) machine the full command surface. There is
 * exactly one definition, surfaced on the agent context as `claimTypeAllowlist`.
 */
export const DRAIN_CLAIM_TYPE_ALLOWLIST = ['self_uninstall'] as const;

/**
 * The CORE agent mount, as absolute leading path segments.
 *
 * `index.ts` mounts `app.route('/api/v1', api)` and `api.route('/agents', agentRoutes)`,
 * so every core agent route is exactly `/api/v1/agents/<agentId>/...`.
 * `agentAuth.test.ts` pins this against those two mount lines in `index.ts`, so
 * a mount move is caught by a unit test rather than by drain mode silently
 * refusing the whole fleet.
 */
const CORE_AGENT_MOUNT_SEGMENTS = ['api', 'v1', 'agents'] as const;

/**
 * True when `pathSegments` is EXACTLY `/api/v1/agents/<agentId>/…` with
 * `expectedLength` segments in total.
 *
 * ABSOLUTE anchoring — indexed from the FRONT, with an exact length. The
 * previous implementation indexed from the END (`at(3) === 'agents'`), which
 * matched any path whose TAIL happened to look like `agents/<id>/<action>`.
 * That was a real hole with a false comment on it: this middleware also serves
 * the extension gateway, which mounts agent routes at `<prefix>/agent/<id>/*`
 * (singular) and at `/api/v1/<routeNamespace>/agent/<id>/*`, and extension
 * route paths are copied verbatim with no validation
 * (extensions/contributionRegistry.ts). A crafted request such as
 *
 *   /api/v1/ext/acme/agent/<id>/agents/<id>/rotate-token
 *
 * has a matching tail and would have joined the drain surface. Nothing shipped
 * registers such a route today, but the AGENT supplies the tail, so it needed
 * no extension-author complicity — and the old comment claiming "no extension
 * route can join the drain surface" is exactly what would have licensed
 * someone to write one.
 *
 * Fails CLOSED in both directions: an unrecognised shape is refused during a
 * drain, and if the core mount ever moves, drain mode blocks rather than
 * admits.
 */
function isCoreAgentPath(
  pathSegments: string[],
  agentId: string,
  expectedLength: number,
): boolean {
  if (pathSegments.length !== expectedLength) return false;
  for (const [index, segment] of CORE_AGENT_MOUNT_SEGMENTS.entries()) {
    if (pathSegments[index] !== segment) return false;
  }
  return pathSegments[CORE_AGENT_MOUNT_SEGMENTS.length] === agentId;
}

/** Index of the `<action>` segment in `/api/v1/agents/<agentId>/<action>`. */
const CORE_AGENT_ACTION_INDEX = CORE_AGENT_MOUNT_SEGMENTS.length + 1;

/**
 * #2774 / #3986 — the narrowed agent surface during a drain window.
 * Only what self_uninstall delivery needs survives:
 * - heartbeat: the primary command carrier (claims device_commands) + liveness
 * - commands / commands/:id/result: the poll + ack pair
 * - rotate-token/confirm: lets an agent that already persisted a staged
 *   credential finish, so a mid-stage rotation can't lock it out mid-drain.
 *   The MINT half (`rotate-token`) is allowed for a TENANT drain only — see
 *   DEVICE_UNINSTALL_DRAIN_ALLOWED_ACTIONS for why a removed device must not
 *   be able to mint credentials that outlive its window.
 * - logs: post-mortem evidence for devices that never drain
 * Everything else (inventory, patches, WS-adjacent, extension gateway) is
 * refused with an explicit 403 so a departing customer's — or a removed
 * machine's — agent doesn't keep feeding a fully-capable RMM channel. The WS
 * upgrade is refused outright in agentWs.validateAgentToken; its push path
 * bypasses device_commands, so no type allowlist can see it.
 *
 * `allowedActions` is the drain-KIND-specific single-segment set. The two
 * multi-segment shapes below are identical for both kinds.
 */
function isDrainAllowedAgentPath(
  pathSegments: string[],
  agentId: string,
  allowedActions: ReadonlySet<string>,
): boolean {
  // /api/v1/agents/<agentId>/<action>
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 1)
    && allowedActions.has(pathSegments[CORE_AGENT_ACTION_INDEX] ?? '')
  ) {
    return true;
  }
  // /api/v1/agents/<agentId>/rotate-token/confirm
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 2)
    && pathSegments[CORE_AGENT_ACTION_INDEX] === 'rotate-token'
    && pathSegments[CORE_AGENT_ACTION_INDEX + 1] === 'confirm'
  ) {
    return true;
  }
  // /api/v1/agents/<agentId>/commands/<commandId>/result
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 3)
    && pathSegments[CORE_AGENT_ACTION_INDEX] === 'commands'
    && pathSegments[CORE_AGENT_ACTION_INDEX + 2] === 'result'
  ) {
    return true;
  }
  return false;
}

/**
 * Middleware to authenticate agent requests via Bearer token.
 * Hashes the token and compares against the stored agentTokenHash.
 * Enforces per-agent rate limiting via Redis.
 * Sets agent context (deviceId, agentId, orgId, siteId) for route handlers.
 */
export async function agentAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  if (!token.startsWith('brz_')) {
    throw new HTTPException(401, { message: 'Invalid agent token format' });
  }

  // Extract agentId from URL param
  const agentId = c.req.param('id');
  if (!agentId) {
    throw new HTTPException(400, { message: 'Missing agent ID' });
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  // Authentication must work even when tenant RLS is deny-by-default.
  // Use system DB context for lookup, then scope all downstream queries to the device org.
  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: devices.id,
        agentId: devices.agentId,
        orgId: devices.orgId,
        siteId: devices.siteId,
        agentTokenHash: devices.agentTokenHash,
        previousTokenHash: devices.previousTokenHash,
        previousTokenExpiresAt: devices.previousTokenExpiresAt,
        watchdogTokenHash: devices.watchdogTokenHash,
        previousWatchdogTokenHash: devices.previousWatchdogTokenHash,
        previousWatchdogTokenExpiresAt: devices.previousWatchdogTokenExpiresAt,
        pendingTokenHash: devices.pendingTokenHash,
        pendingWatchdogTokenHash: devices.pendingWatchdogTokenHash,
        pendingTokenExpiresAt: devices.pendingTokenExpiresAt,
        status: devices.status,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
        hostname: devices.hostname,
        lastSeenIp: devices.lastSeenIp,
      })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);
    return row ?? null;
  });

  if (!device) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  // Task 18: suspended tokens fail closed. We do NOT leak the suspension
  // reason in the response — a compromised agent should see the same 401
  // as a stale token.
  if (device.agentTokenSuspendedAt) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  // A device row exists but neither token hash is populated — this is the
  // pre-hashed-token migration state. Surface a distinct error so the agent
  // can prompt for re-enrollment instead of silently retrying forever.
  if (!device.agentTokenHash && !device.watchdogTokenHash) {
    throw new HTTPException(401, {
      message: 'Re-enrollment required: device predates token-hash migration',
      res: new Response(
        JSON.stringify({ error: 'Re-enrollment required', code: 're_enrollment_required' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    });
  }

  const match = matchRoleScopedAgentTokenHash({
    agentTokenHash: device.agentTokenHash,
    previousTokenHash: device.previousTokenHash,
    previousTokenExpiresAt: device.previousTokenExpiresAt,
    watchdogTokenHash: device.watchdogTokenHash,
    previousWatchdogTokenHash: device.previousWatchdogTokenHash,
    previousWatchdogTokenExpiresAt: device.previousWatchdogTokenExpiresAt,
    pendingTokenHash: device.pendingTokenHash,
    pendingWatchdogTokenHash: device.pendingWatchdogTokenHash,
    pendingTokenExpiresAt: device.pendingTokenExpiresAt,
    tokenHash,
  });
  if (!match) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  // #3986 Layer 1 — a removed device is STILL denied by default. The single
  // exception is the device-remove uninstall drain: `self_uninstall` was queued
  // by DELETE /devices/:id with `uninstallAgent:true`, the deadline has not
  // passed, and the agent has to be able to reach us to collect it. Without
  // this window that command is undeliverable by construction (no heartbeat, no
  // command poll, no result post), which is the whole reason the window exists.
  //
  // Everything else about `decommissioned` is unchanged, and deliberately so:
  //   - `uninstallAgent:false` (no queued uninstall)  -> today's 403
  //   - deadline expired                              -> today's 403
  //   - abuse-suspension's reason-less self_uninstall -> today's 403
  // The reason + deadline clauses live in `isDeviceUninstallDraining`; do not
  // re-derive or relax them here (see its module doc for the incident they
  // prevent).
  //
  // Layer 1b — ONLY the main-agent credential. The watchdog heartbeat branch
  // (routes/agents/heartbeat.ts) writes device state WITHOUT the terminal-status
  // guard the main branch has, and `self_uninstall` is `targetRole='agent'`
  // anyway, so a watchdog has nothing to collect here. Checked BEFORE the
  // predicate query so a watchdog credential costs no extra round trip.
  //
  // System DB context is REQUIRED, not decorative: the predicate joins `devices`,
  // which is RLS-scoped, and a contextless read defaults to scope 'none' — it
  // would return zero rows and silently report "not draining" for every device,
  // making the uninstall permanently undeliverable. No context is active here
  // (the request-long wrap is opened much further down), so this establishes
  // system scope rather than inheriting a narrower one.
  //
  // Runs before the rate limiters, exactly where the old unconditional throw
  // was, so a non-draining removed device sees byte-for-byte today's response.
  // The extra query is reached only by a VALID token on a decommissioned
  // device, and the unconditional device lookup above already costs one query
  // per request, so this adds no meaningful amplification.
  let deviceUninstallDraining = false;
  if (device.status === 'decommissioned') {
    deviceUninstallDraining =
      match.role === 'agent'
      && (await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id)));

    if (!deviceUninstallDraining) {
      throw new HTTPException(403, { message: 'Device has been decommissioned' });
    }
  }

  if (device.status === 'quarantined') {
    throw new HTTPException(403, { message: 'Device is quarantined pending admin approval' });
  }

  const redis = getRedis();

  // Task 19: per-(agent, source-IP) rate limit. A stolen token used from a
  // second IP can't drain the legit agent's per-agent quota — each IP gets
  // its own 30/min bucket. Runs BEFORE the per-agent limit so a spraying
  // attacker doesn't also charge the per-agent bucket on rejected requests.
  const sourceIp = getTrustedClientIp(c);
  if (sourceIp && sourceIp !== 'unknown') {
    // Bucket identity, not the address: rateLimitIpKey folds IPv6 to its /64
    // so a stolen token can't mint a fresh per-IP bucket per request by walking
    // the low 64 bits of a subnet it already owns. `sourceIp` below stays raw —
    // the IP-change audit signal needs the real address.
    const perIpKey = `agent_rate_ip:${device.id}:${rateLimitIpKey(sourceIp)}`;
    const perIpCheck = await rateLimiter(
      redis,
      perIpKey,
      AGENT_PER_IP_RATE_LIMIT,
      AGENT_PER_IP_RATE_WINDOW_SECONDS,
    );
    if (!perIpCheck.allowed) {
      c.header('Retry-After', String(Math.ceil((perIpCheck.resetAt.getTime() - Date.now()) / 1000)));
      throw new HTTPException(429, { message: 'Agent per-source-IP rate limit exceeded' });
    }

    // Task 19: detect source-IP changes. The legit agent typically lives at
    // one fairly stable IP, so a sudden change is a compromise signal worth
    // a security audit. Dedup at one event / device / IP / 24h so noisy
    // mobile or roaming agents don't drown the audit log.
    if (device.lastSeenIp && device.lastSeenIp !== sourceIp) {
      const dedupKey = `agent_ip_change:${device.id}:${sourceIp}`;
      let shouldAudit = false;
      try {
        const result = await redis?.set(
          dedupKey,
          '1',
          'EX',
          AGENT_IP_CHANGE_AUDIT_DEDUP_SECONDS,
          'NX',
        );
        shouldAudit = result === 'OK';
      } catch (err) {
        // Dedup-lookup failure: skip the audit rather than risk a flood.
        // The next request from this IP will retry.
        console.error('[agentAuth] ip-change dedup lookup failed:', err);
      }

      if (shouldAudit) {
        void createAuditLogAsync({
          orgId: device.orgId,
          actorType: 'agent',
          actorId: device.id,
          action: 'agent.source.ip.changed',
          resourceType: 'device',
          resourceId: device.id,
          resourceName: device.hostname ?? undefined,
          details: { previousIp: device.lastSeenIp, newIp: sourceIp },
          ipAddress: sourceIp,
          result: 'success',
        });
      }
    }

    // Persist the new IP fire-and-forget so the request path is never
    // blocked on a write. The next authenticated request will see the
    // updated value. Note: we update even on the first request (when
    // lastSeenIp is NULL) so the first IP-change comparison has something
    // to compare to.
    //
    // #3986 — this runs BEFORE the drain route gate below, so a device inside
    // the device-remove uninstall drain does update `last_seen_ip`. Kept
    // deliberately: the column means "the last source IP we saw this token
    // used from", and that stays literally true (and forensically useful) for
    // a machine collecting its own uninstall. It is NOT a liveness signal —
    // `last_seen_at` is, and that one is guarded on terminal status in the
    // heartbeat handler, so the device still reads as Removed in the UI.
    if (device.lastSeenIp !== sourceIp) {
      void withSystemDbAccessContext(async () => {
        await db
          .update(devices)
          .set({ lastSeenIp: sourceIp })
          .where(eq(devices.id, device.id));
      }).catch((err) => {
        console.error('[agentAuth] last_seen_ip update failed:', err);
      });
    }
  }

  // Rate limiting per agent
  const rateKey = `agent_rate:${agentId}`;
  const rateCheck = await rateLimiter(redis, rateKey, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_SECONDS);

  if (!rateCheck.allowed) {
    c.header('Retry-After', String(Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)));
    throw new HTTPException(429, { message: 'Agent rate limit exceeded' });
  }

  // Rate limiting per org (applied AFTER per-agent so we don't bill the org bucket
  // for requests that already failed the per-agent check). Protects against a
  // large fleet on one MSP saturating shared resources via the per-agent budget.
  const orgRateKey = `agent_org_rate:${device.orgId}`;
  const orgLimit = await resolveOrgRateLimit(redis, device.orgId);
  const orgRateCheck = await rateLimiter(
    redis,
    orgRateKey,
    orgLimit,
    AGENT_ORG_RATE_WINDOW_SECONDS,
  );

  if (!orgRateCheck.allowed) {
    // #2728 — reserved lane. The org bucket is shared with no per-device
    // fairness, so a fleet of chatty heartbeats can drain it and starve the
    // once-per-24h patch/inventory uploads that carry operator-facing posture.
    // Those uploads are far too infrequent to be a load source themselves, so
    // when the main bucket is exhausted we still admit them from a smaller
    // reserved bucket. Only consulted on the overflow path, so the steady-state
    // request path pays no extra Redis round-trip.
    const reserved = isReservedIngestPath(c.req.path);
    const reservedCheck = reserved
      ? await rateLimiter(
          redis,
          `agent_org_rate_reserved:${device.orgId}`,
          computeReservedIngestLimit(orgLimit),
          AGENT_ORG_RATE_WINDOW_SECONDS,
        )
      : null;

    if (!reservedCheck?.allowed) {
      // Per-device detail so a stale-posture report is diagnosable from logs
      // without new tables: which device, which org, which endpoint, and
      // whether the reserved lane was also spent (#2728).
      console.warn('[agentAuth] org rate limit exceeded', {
        orgId: device.orgId,
        deviceId: device.id,
        path: c.req.path,
        orgLimit,
        reservedLane: reserved ? 'exhausted' : 'not-eligible',
      });
      // Advertise the full window. `orgRateCheck.resetAt` is when ONE slot
      // frees (oldest entry + window), which under sustained saturation is
      // ~now — advertising that would tell the whole fleet to come back in a
      // second and turn backoff into a hot loop, amplifying the very overload
      // that caused the rejection. De-synchronizing the herd is the agent's
      // job, via additive jitter on this value (httputil.applyPositiveJitter),
      // not the server's job via a varying header.
      c.header('Retry-After', String(AGENT_ORG_RATE_WINDOW_SECONDS));
      return c.json({ error: 'org_rate_limit_exceeded' }, 429);
    }

    console.warn('[agentAuth] org rate limit exceeded — admitted via reserved ingest lane', {
      orgId: device.orgId,
      deviceId: device.id,
      path: c.req.path,
      orgLimit,
    });
  }

  // Tenant-status gate: a suspended/churned/soft-deleted org or partner must
  // not keep authenticating its agent fleet. The device-level checks above
  // (token suspension, decommission, quarantine) don't cover the org/partner
  // lifecycle; mirror the API-key path (apiKeyAuth → getActiveOrgTenant) and
  // fail closed. Runs after the rate limiters so a flood from an inactive
  // tenant can't drive uncached lookups, and returns the same opaque 401 as a
  // stale token so the agent cannot distinguish suspension from a bad token.
  //
  // #2774 — an `offboarding` tenant resolves to 'draining': still
  // authenticated (that's the whole point — self_uninstall must be
  // deliverable), but only on the narrowed drain surface. Blocked routes get
  // an explicit 403 (distinct from the opaque 401: the tenant state is not a
  // secret from its own fleet, and the agent must not treat this as an auth
  // failure and back off its heartbeat).
  const tenantState = await getAgentTenantState(device.orgId);
  if (!tenantState) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  const pathSegments = (c.req.path ?? '').split('/').filter(Boolean);
  // #3986 Layer 2 — a DEVICE drain narrows the route surface exactly as a
  // TENANT drain does. This is the layer that does the real containment work:
  // Layer 1 only decided the credential still authenticates, and without this
  // a removed machine would keep the whole authenticated agent surface —
  // inventory push, BitLocker/FileVault recovery-key ingest
  // (PUT /:id/security/recovery-keys), PAM elevation requests
  // (POST /:id/elevation-requests), patch/event-log/peripheral ingest, and
  // every third-party extension's `<prefix>/agent/:id/*` namespace
  // (extensions/gateway.ts routes those through THIS middleware). A
  // command-type allowlist alone cannot see any of that.
  //
  // Distinct error codes so the agent (and an operator reading logs) can tell
  // "my tenant is leaving" from "this machine was removed"; tenant drain keeps
  // its established `tenant_offboarding` code when both apply.
  //
  // The two drain kinds do NOT share one action set. A tenant drain keeps
  // #2774's original surface; a DEVICE drain additionally drops `rotate-token`,
  // because the credentials that route mints outlive the drain window and
  // would become live again on restore (see
  // DEVICE_UNINSTALL_DRAIN_ALLOWED_ACTIONS). When BOTH apply they compose by
  // INTERSECTION (BOTH_DRAINS_ALLOWED_ACTIONS) — two narrowing gates can only
  // ever narrow further. Letting the tenant set win instead handed
  // `rotate-token` straight back to a removed device, which is the one case
  // the device set exists to cover.
  //
  // The error CODE still reports the tenant drain when both apply: it is the
  // agent-visible, longer-lived condition, and #2774's clients already parse
  // it. Only the action SET intersects.
  const tenantDraining = tenantState === 'draining';
  const drainNarrowed = tenantDraining || deviceUninstallDraining;
  const drainAllowedActions = tenantDraining
    ? (deviceUninstallDraining ? BOTH_DRAINS_ALLOWED_ACTIONS : TENANT_DRAIN_ALLOWED_ACTIONS)
    : DEVICE_UNINSTALL_DRAIN_ALLOWED_ACTIONS;
  if (drainNarrowed && !isDrainAllowedAgentPath(pathSegments, agentId, drainAllowedActions)) {
    return c.json(
      { error: tenantState === 'draining' ? 'tenant_offboarding' : 'device_uninstall_draining' },
      403,
    );
  }

  // Security remediation Wave 5, Task 6 — shared certificate/device binding
  // decision (services/agentCertificateBinding.ts). Runs AFTER bearer/token
  // auth and the tenant-status gate, BEFORE the request is granted access.
  // `device.id` here is the ALREADY-authenticated device row the bearer
  // token matched — never client-controlled input — so a stolen token can
  // never select a different device's certificate identity to bind against.
  // In the default `off` mode this never touches the DB (no perf cost for
  // the common case).
  const certAssertion = readAgentCertificateAssertion(c);
  const bindingDecision = await enforceAgentCertificateBinding({
    deviceId: device.id,
    assertion: certAssertion,
    pathClass: 'rest',
  });
  if (!bindingDecision.allowed) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  if (match.tokenRotationRequired) {
    c.header('x-token-rotation-required', 'true');
  }
  c.set('agentTokenRotationRequired', match.tokenRotationRequired);
  // Issue #2621 — true when the caller authenticated with the STAGED credential
  // of an unconfirmed rotation. /rotate-token/confirm treats this as proof the
  // agent holds a durable copy of the new token and promotes pending->current.
  c.set('agentPendingTokenPresented', match.pendingTokenPresented);

  c.set('agent', {
    deviceId: device.id,
    agentId: device.agentId,
    orgId: device.orgId,
    siteId: device.siteId,
    role: match.role,
    // The exact hash that authenticated this request (current token). For a
    // rotation-required previous-token match this is still the previous-token
    // hash, but rotate-token rejects those before reaching any CAS, so callers
    // that mint credentials only ever see the current-token hash here.
    authTokenHash: tokenHash,
    tenantDraining: tenantState === 'draining',
    deviceUninstallDraining,
    // #3986 Layer 3 — derived ONCE, here. Three handlers used to each restate
    // `agent.tenantDraining ? ['self_uninstall'] : undefined` at their claim
    // call; a fourth claim site that forgot would have silently claimed every
    // command type, because `claimPendingCommandsForDevice`'s `typeAllowlist`
    // defaults to unrestricted. `undefined` here still means unrestricted, but
    // now there is exactly one place that decides it.
    claimTypeAllowlist: drainNarrowed ? DRAIN_CLAIM_TYPE_ALLOWLIST : undefined,
  });

  // #1105 — high-frequency, high-concurrency routes that self-manage their DB
  // context to avoid holding ONE transaction across the whole request (which
  // pins a pooled connection idle-in-transaction across non-DB work and
  // self-deadlocks the pool under a mass agent reconnect). These routes MUST
  // open withDbAccessContext themselves around their DB work. Everything else
  // keeps the convenient request-long wrap below.
  //
  // ABSOLUTELY anchored, for the same reason as isDrainAllowedAgentPath above:
  // this used to match on the trailing segment alone, so ANY path ending in
  // `heartbeat` / `reliability` / `commands` — including an extension gateway
  // route at `<prefix>/agent/<id>/…` — silently opted out of the request-long
  // org context. Benign today (no shipped extension route does DB work that
  // depends on the ambient context), but it is the same shape as the real hole
  // fixed above, and the failure mode is the worse direction: a handler that
  // ASSUMED the ambient context would run contextless, which under RLS means a
  // silent zero-row read rather than an error. Now only the three core routes
  // that genuinely self-manage their context opt out; everything else,
  // extension routes included, keeps the wrap.
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 1)
    && SELF_MANAGED_DB_CONTEXT_ACTIONS.has(pathSegments[CORE_AGENT_ACTION_INDEX] ?? '')
  ) {
    await next();
    return;
  }

  await withDbAccessContext(
    {
      scope: 'organization',
      orgId: device.orgId,
      accessibleOrgIds: [device.orgId],
      // Agents are org-scoped; they have no access to partner-level tables.
      accessiblePartnerIds: [],
      // Agents don't browse the catalog as org users and partnerId isn't in
      // scope here; null disables the partner-wide read branch (safe).
      currentPartnerId: null
    },
    async () => {
      await next();
    }
  );
}
