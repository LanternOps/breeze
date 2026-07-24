import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { getRedis, rateLimiter } from '../services';
import { type AgentTokenSuspendReason } from '../services/agentTokenSuspension';
import { createAuditLogAsync } from '../services/auditService';
import { getTrustedClientIp } from '../services/clientIp';
import { isAgentTenantActive } from '../services/tenantStatus';

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
// Default per-org budget: 5x the per-agent budget — supports up to ~5 active
// agents per org without rate-limiting. Configurable via env var.
const DEFAULT_AGENT_ORG_RATE_LIMIT = 600;
const AGENT_ORG_RATE_WINDOW_SECONDS = 60;
const DEFAULT_AGENT_TOKEN_ROTATION_MAX_AGE_DAYS = 30;

function getAgentOrgRateLimit(): number {
  const raw = Number.parseInt(process.env.AGENT_ORG_RATE_LIMIT_PER_MIN ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AGENT_ORG_RATE_LIMIT;
  }
  return raw;
}

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
 * Final path segment of routes that open their own withDbAccessContext around
 * their DB work instead of relying on the request-long wrap in
 * agentAuthMiddleware. See the #1105 note at the wrap site. Auth still runs in
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

  if (device.status === 'decommissioned') {
    throw new HTTPException(403, { message: 'Device has been decommissioned' });
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
    const perIpKey = `agent_rate_ip:${device.id}:${sourceIp}`;
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
  const orgRateCheck = await rateLimiter(
    redis,
    orgRateKey,
    getAgentOrgRateLimit(),
    AGENT_ORG_RATE_WINDOW_SECONDS,
  );

  if (!orgRateCheck.allowed) {
    console.warn('[agentAuth] org rate limit exceeded', {
      orgId: device.orgId,
      deviceId: device.id,
    });
    c.header('Retry-After', '60');
    return c.json({ error: 'org_rate_limit_exceeded' }, 429);
  }

  // Tenant-status gate: a suspended/churned/soft-deleted org or partner must
  // not keep authenticating its agent fleet. The device-level checks above
  // (token suspension, decommission, quarantine) don't cover the org/partner
  // lifecycle; mirror the API-key path (apiKeyAuth → getActiveOrgTenant) and
  // fail closed. Runs after the rate limiters so a flood from an inactive
  // tenant can't drive uncached lookups, and returns the same opaque 401 as a
  // stale token so the agent cannot distinguish suspension from a bad token.
  if (!(await isAgentTenantActive(device.orgId))) {
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
  });

  // #1105 — high-frequency, high-concurrency routes that self-manage their DB
  // context to avoid holding ONE transaction across the whole request (which
  // pins a pooled connection idle-in-transaction across non-DB work and
  // self-deadlocks the pool under a mass agent reconnect). These routes MUST
  // open withDbAccessContext themselves around their DB work. Everything else
  // keeps the convenient request-long wrap below.
  const pathSegments = (c.req.path ?? '').split('/').filter(Boolean);
  const action = pathSegments[pathSegments.length - 1] ?? '';
  if (SELF_MANAGED_DB_CONTEXT_ACTIONS.has(action)) {
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
