import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { getRedis, rateLimiter } from '../services';

export interface AgentAuthContext {
  deviceId: string;
  agentId: string;
  orgId: string;
  siteId: string;
  role: AgentCredentialRole;
}

export type AgentCredentialRole = 'agent' | 'watchdog';

declare module 'hono' {
  interface ContextVariableMap {
    agent: AgentAuthContext;
    agentTokenRotationRequired: boolean;
  }
}

// 120 requests per 60-second window per agent
const AGENT_RATE_LIMIT = 120;
const AGENT_RATE_WINDOW_SECONDS = 60;
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
  tokenHash: string;
  now?: Date;
}): { tokenRotationRequired: boolean } | null {
  const {
    agentTokenHash,
    previousTokenHash,
    previousTokenExpiresAt,
    tokenHash,
    now = new Date(),
  } = params;

  if (agentTokenHash && tokenHashMatches(agentTokenHash, tokenHash)) {
    return { tokenRotationRequired: false };
  }

  if (
    previousTokenHash &&
    previousTokenExpiresAt &&
    previousTokenExpiresAt > now &&
    tokenHashMatches(previousTokenHash, tokenHash)
  ) {
    return { tokenRotationRequired: true };
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
  tokenHash: string;
  now?: Date;
}): ({ role: AgentCredentialRole; tokenRotationRequired: boolean }) | null {
  const {
    agentTokenHash,
    previousTokenHash,
    previousTokenExpiresAt,
    watchdogTokenHash,
    previousWatchdogTokenHash,
    previousWatchdogTokenExpiresAt,
    tokenHash,
    now = new Date(),
  } = params;

  const agentMatch = matchAgentTokenHash({
    agentTokenHash,
    previousTokenHash,
    previousTokenExpiresAt,
    tokenHash,
    now,
  });
  if (agentMatch) {
    return { role: 'agent', tokenRotationRequired: agentMatch.tokenRotationRequired };
  }

  const watchdogMatch = matchAgentTokenHash({
    agentTokenHash: watchdogTokenHash,
    previousTokenHash: previousWatchdogTokenHash,
    previousTokenExpiresAt: previousWatchdogTokenExpiresAt,
    tokenHash,
    now,
  });
  if (watchdogMatch) {
    return { role: 'watchdog', tokenRotationRequired: watchdogMatch.tokenRotationRequired };
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
        status: devices.status,
      })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);
    return row ?? null;
  });

  if (!device) {
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

  // Rate limiting per agent
  const redis = getRedis();
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

  if (match.tokenRotationRequired) {
    c.header('x-token-rotation-required', 'true');
  }
  c.set('agentTokenRotationRequired', match.tokenRotationRequired);

  c.set('agent', {
    deviceId: device.id,
    agentId: device.agentId,
    orgId: device.orgId,
    siteId: device.siteId,
    role: match.role,
  });

  await withDbAccessContext(
    {
      scope: 'organization',
      orgId: device.orgId,
      accessibleOrgIds: [device.orgId],
      // Agents are org-scoped; they have no access to partner-level tables.
      accessiblePartnerIds: []
    },
    async () => {
      await next();
    }
  );
}
