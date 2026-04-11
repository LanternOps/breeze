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
}

declare module 'hono' {
  interface ContextVariableMap {
    agent: AgentAuthContext;
    agentTokenRotationRequired: boolean;
  }
}

// 120 requests per 60-second window per agent
const AGENT_RATE_LIMIT = 120;
const AGENT_RATE_WINDOW_SECONDS = 60;
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
        status: devices.status,
      })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);
    return row ?? null;
  });

  if (!device || !device.agentTokenHash) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  const match = matchAgentTokenHash({
    agentTokenHash: device.agentTokenHash,
    previousTokenHash: device.previousTokenHash,
    previousTokenExpiresAt: device.previousTokenExpiresAt,
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

  if (match.tokenRotationRequired) {
    c.header('x-token-rotation-required', 'true');
  }
  c.set('agentTokenRotationRequired', match.tokenRotationRequired);

  c.set('agent', {
    deviceId: device.id,
    agentId: device.agentId,
    orgId: device.orgId,
    siteId: device.siteId,
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
