import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
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
  }
}

// 120 requests per 60-second window per agent
const AGENT_RATE_LIMIT = 120;
const AGENT_RATE_WINDOW_SECONDS = 60;

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

  const [device] = await db
    .select({
      id: devices.id,
      agentId: devices.agentId,
      orgId: devices.orgId,
      siteId: devices.siteId,
      agentTokenHash: devices.agentTokenHash,
      status: devices.status,
    })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device || !device.agentTokenHash) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  if (device.agentTokenHash !== tokenHash) {
    throw new HTTPException(401, { message: 'Invalid agent credentials' });
  }

  if (device.status === 'decommissioned') {
    throw new HTTPException(403, { message: 'Device has been decommissioned' });
  }

  // Rate limiting per agent
  const redis = getRedis();
  const rateKey = `agent_rate:${agentId}`;
  const rateCheck = await rateLimiter(redis, rateKey, AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_SECONDS);

  if (!rateCheck.allowed) {
    c.header('Retry-After', String(Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)));
    throw new HTTPException(429, { message: 'Agent rate limit exceeded' });
  }

  c.set('agent', {
    deviceId: device.id,
    agentId: device.agentId,
    orgId: device.orgId,
    siteId: device.siteId,
  });

  await next();
}
