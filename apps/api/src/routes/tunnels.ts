import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { tunnelSessions, tunnelAllowlists, devices, users, remoteSessions } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { createWsTicket, createVncConnectCode, consumeVncConnectCode, getViewerAccessTokenExpirySeconds } from '../services/remoteSessionAuth';
import { createViewerAccessToken, verifyViewerAccessToken } from '../services/jwt';
import { getRedis } from '../services/redis';
import { isViewerJtiRevoked, revokeViewerJti } from '../services/viewerTokenRevocation';
import type { AuthContext } from '../middleware/auth';

export const tunnelRoutes = new Hono();

// Apply auth middleware to all tunnel routes
tunnelRoutes.use('*', authMiddleware);

// --- Schemas ---

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({ siteId: z.string().uuid().optional().nullable() });
const allowlistIdParamSchema = idParamSchema;

const createTunnelSchema = z.discriminatedUnion('type', [
  z.object({ deviceId: z.string().uuid(), type: z.literal('vnc') }),
  z.object({
    deviceId: z.string().uuid(),
    type: z.literal('proxy'),
    targetHost: z.string().max(255),
    targetPort: z.number().int().min(1).max(65535),
  }),
]);

const allowlistRuleSchema = z.object({
  direction: z.enum(['destination', 'source']),
  pattern: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  siteId: z.string().uuid().optional(),
  source: z.enum(['manual', 'discovery', 'policy']).optional(),
  discoveredAssetId: z.string().uuid().optional(),
});

const updateAllowlistSchema = z.object({
  pattern: z.string().min(1).max(255).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});

// --- Helpers ---

// Hardcoded blocked CIDRs (mirrors agent-side allowlist.go)
const BLOCKED_CIDRS = [
  { cidr: '127.0.0.0/8', reason: 'localhost' },
  { cidr: '169.254.0.0/16', reason: 'link-local / cloud metadata (SSRF prevention)' },
];

function ipInCidr(ip: string, cidr: string): boolean {
  const [network, bits] = cidr.split('/');
  const mask = ~(0xFFFFFFFF >>> parseInt(bits!, 10));
  const ipNum = ipToInt(ip);
  const netNum = ipToInt(network!);
  if (ipNum === null || netNum === null) return false;
  return (ipNum & mask) === (netNum & mask);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0; // unsigned
}

function isTargetBlocked(host: string, port: number, isVNC: boolean): { blocked: boolean; reason?: string } {
  if (host === '0.0.0.0' || host === '::') {
    return { blocked: true, reason: 'Wildcard bind address' };
  }

  for (const { cidr, reason } of BLOCKED_CIDRS) {
    if (ipInCidr(host, cidr)) {
      // VNC exception: allow 127.0.0.1:5900 only
      if (isVNC && cidr === '127.0.0.0/8' && host === '127.0.0.1' && port === 5900) {
        continue;
      }
      return { blocked: true, reason };
    }
  }

  return { blocked: false };
}

async function isTargetAllowed(host: string, port: number, orgId: string): Promise<boolean> {
  const rules = await db
    .select()
    .from(tunnelAllowlists)
    .where(and(
      eq(tunnelAllowlists.orgId, orgId),
      eq(tunnelAllowlists.direction, 'destination'),
      eq(tunnelAllowlists.enabled, true),
    ));

  if (rules.length === 0) return false; // Default deny

  for (const rule of rules) {
    const parts = rule.pattern.split(':');
    if (parts.length !== 2) continue;
    const [cidr, portRange] = parts;

    if (!ipInCidr(host, cidr!)) continue;

    if (portRange === '*') return true;
    if (portRange!.includes('-')) {
      const [min, max] = portRange!.split('-').map(Number);
      if (port >= min! && port <= max!) return true;
    } else {
      if (port === parseInt(portRange!, 10)) return true;
    }
  }

  return false;
}

async function isSourceIpAllowed(sourceIp: string, orgId: string): Promise<boolean> {
  const rules = await db
    .select()
    .from(tunnelAllowlists)
    .where(and(
      eq(tunnelAllowlists.orgId, orgId),
      eq(tunnelAllowlists.direction, 'source'),
      eq(tunnelAllowlists.enabled, true),
    ));

  // No source rules = no restriction
  if (rules.length === 0) return true;

  for (const rule of rules) {
    if (ipInCidr(sourceIp, rule.pattern)) return true;
  }

  return false;
}

function getClientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || '127.0.0.1';
}

async function getDeviceForTunnel(deviceId: string, auth: AuthContext) {
  const conditions = [eq(devices.id, deviceId)];

  // Scope by org for non-system users
  if (auth.orgId) {
    conditions.push(eq(devices.orgId, auth.orgId));
  }

  const [device] = await db
    .select()
    .from(devices)
    .where(and(...conditions))
    .limit(1);

  return device;
}

async function getActiveAllowlistPatterns(orgId: string): Promise<string[]> {
  const rules = await db
    .select({ pattern: tunnelAllowlists.pattern })
    .from(tunnelAllowlists)
    .where(and(
      eq(tunnelAllowlists.orgId, orgId),
      eq(tunnelAllowlists.direction, 'destination'),
      eq(tunnelAllowlists.enabled, true),
    ));
  return rules.map(r => r.pattern);
}

// --- Routes ---

// POST /tunnels — Create a new tunnel session
tunnelRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createTunnelSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const sourceIp = getClientIp(c);

    const device = await getDeviceForTunnel(body.deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    if (device.status !== 'online') {
      return c.json({ error: 'Device is not online' }, 400);
    }

    if (!device.agentId || !isAgentConnected(device.agentId)) {
      return c.json({ error: 'Agent is not connected' }, 400);
    }

    // Remote access policy enforcement
    const tunnelCapability = body.type === 'vnc' ? 'vncRelay' as const : 'proxy' as const;
    const policyCheck = await checkRemoteAccess(body.deviceId, tunnelCapability);
    if (!policyCheck.allowed) {
      return c.json({
        error: policyCheck.reason,
        code: 'REMOTE_ACCESS_POLICY_DENIED',
        capability: tunnelCapability,
        policyName: policyCheck.policyName,
      }, 403);
    }

    const isVNC = body.type === 'vnc';
    const targetHost = isVNC ? '127.0.0.1' : body.targetHost;
    const targetPort = isVNC ? 5900 : body.targetPort;

    // Source IP check
    if (!(await isSourceIpAllowed(sourceIp, device.orgId))) {
      return c.json({ error: 'Source IP not permitted' }, 403);
    }

    // Destination check (skip for VNC — always localhost:5900)
    if (!isVNC) {
      const blockResult = isTargetBlocked(targetHost, targetPort, false);
      if (blockResult.blocked) {
        return c.json({ error: `Target blocked: ${blockResult.reason}` }, 403);
      }

      if (!(await isTargetAllowed(targetHost, targetPort, device.orgId))) {
        return c.json({ error: 'Target not permitted by allowlist. Add a destination rule first.' }, 403);
      }
    }

    // Create session record
    const [session] = await db
      .insert(tunnelSessions)
      .values({
        deviceId: device.id,
        userId: auth.user.id,
        orgId: device.orgId,
        type: body.type,
        status: 'pending',
        targetHost,
        targetPort,
        sourceIp: sourceIp,
      })
      .returning();

    // Send tunnel_open command to agent
    const allowlistPatterns = isVNC ? [] : await getActiveAllowlistPatterns(device.orgId);
    const sent = sendCommandToAgent(device.agentId!, {
      id: `tun-open-${session!.id}`,
      type: 'tunnel_open',
      payload: {
        tunnelId: session!.id,
        targetHost,
        targetPort,
        tunnelType: body.type,
        allowlistRules: allowlistPatterns,
      },
    });
    if (!sent) {
      await db.update(tunnelSessions)
        .set({ status: 'failed', errorMessage: 'Agent disconnected before tunnel could be opened', endedAt: new Date() })
        .where(eq(tunnelSessions.id, session!.id));
      return c.json({ error: 'Agent disconnected before tunnel could be opened' }, 503);
    }

    return c.json(session, 201);
  }
);

// GET /tunnels — List tunnels (org-scoped users see only their own)
tunnelRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const status = c.req.query('status');

    const conditions: ReturnType<typeof eq>[] = [];
    if (auth.orgId) {
      conditions.push(eq(tunnelSessions.orgId, auth.orgId));
    }
    // Org-scope users can only see their own tunnels.
    // Partner/system admins can see all tunnels in the org.
    if (auth.scope === 'organization') {
      conditions.push(eq(tunnelSessions.userId, auth.user.id));
    }
    if (status) {
      const validStatuses = ['pending', 'connecting', 'active', 'disconnected', 'failed'] as const;
      if (validStatuses.includes(status as any)) {
        conditions.push(eq(tunnelSessions.status, status as any));
      }
    }

    const sessions = await db
      .select()
      .from(tunnelSessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tunnelSessions.createdAt))
      .limit(100);

    return c.json(sessions);
  }
);

// --- Allowlist routes (must come BEFORE /:id routes for route matching) ---

// GET /tunnels/allowlist — List allowlist rules for the org
tunnelRoutes.get(
  '/allowlist',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.orgId) {
      return c.json({ error: 'Org context required' }, 400);
    }

    const { siteId } = c.req.valid('query');
    const conditions: ReturnType<typeof eq>[] = [eq(tunnelAllowlists.orgId, auth.orgId)];
    if (siteId) {
      conditions.push(eq(tunnelAllowlists.siteId, siteId));
    }

    const rules = await db
      .select()
      .from(tunnelAllowlists)
      .where(and(...conditions))
      .orderBy(desc(tunnelAllowlists.createdAt));

    return c.json(rules);
  }
);

// POST /tunnels/allowlist — Add an allowlist rule
tunnelRoutes.post(
  '/allowlist',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', allowlistRuleSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.orgId) {
      return c.json({ error: 'Org context required' }, 400);
    }

    const body = c.req.valid('json');

    const [rule] = await db
      .insert(tunnelAllowlists)
      .values({
        orgId: auth.orgId,
        siteId: body.siteId || null,
        direction: body.direction,
        pattern: body.pattern,
        description: body.description || null,
        source: body.source || 'manual',
        discoveredAssetId: body.discoveredAssetId || null,
        createdBy: auth.user.id,
      })
      .returning();

    return c.json(rule, 201);
  }
);

// PUT /tunnels/allowlist/:id — Update a rule
tunnelRoutes.put(
  '/allowlist/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', allowlistIdParamSchema),
  zValidator('json', updateAllowlistSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    if (!auth.orgId) {
      return c.json({ error: 'Org context required' }, 400);
    }

    const body = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(tunnelAllowlists)
      .where(and(eq(tunnelAllowlists.id, id), eq(tunnelAllowlists.orgId, auth.orgId)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Rule not found' }, 404);
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.pattern !== undefined) updates.pattern = body.pattern;
    if (body.description !== undefined) updates.description = body.description;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    const [updated] = await db
      .update(tunnelAllowlists)
      .set(updates)
      .where(and(eq(tunnelAllowlists.id, id), eq(tunnelAllowlists.orgId, auth.orgId)))
      .returning();

    return c.json(updated);
  }
);

// DELETE /tunnels/allowlist/:id — Remove a rule
tunnelRoutes.delete(
  '/allowlist/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', allowlistIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    if (!auth.orgId) {
      return c.json({ error: 'Org context required' }, 400);
    }

    const [existing] = await db
      .select()
      .from(tunnelAllowlists)
      .where(and(eq(tunnelAllowlists.id, id), eq(tunnelAllowlists.orgId, auth.orgId)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Rule not found' }, 404);
    }

    await db
      .delete(tunnelAllowlists)
      .where(and(eq(tunnelAllowlists.id, id), eq(tunnelAllowlists.orgId, auth.orgId)));

    return c.json({ deleted: true });
  }
);

// --- Parameterized tunnel routes ---

// GET /tunnels/:id — Get tunnel details (ownership enforced)
tunnelRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const conditions = [eq(tunnelSessions.id, id)];
    if (auth.orgId) {
      conditions.push(eq(tunnelSessions.orgId, auth.orgId));
    }
    if (auth.scope === 'organization') {
      conditions.push(eq(tunnelSessions.userId, auth.user.id));
    }

    const [session] = await db
      .select()
      .from(tunnelSessions)
      .where(and(...conditions))
      .limit(1);

    if (!session) {
      return c.json({ error: 'Tunnel session not found' }, 404);
    }

    return c.json(session);
  }
);

// DELETE /tunnels/:id — Close a tunnel (ownership enforced)
tunnelRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const conditions = [eq(tunnelSessions.id, id)];
    if (auth.orgId) {
      conditions.push(eq(tunnelSessions.orgId, auth.orgId));
    }
    if (auth.scope === 'organization') {
      conditions.push(eq(tunnelSessions.userId, auth.user.id));
    }

    const [session] = await db
      .select()
      .from(tunnelSessions)
      .where(and(...conditions))
      .limit(1);

    if (!session) {
      return c.json({ error: 'Tunnel session not found' }, 404);
    }

    // Get device to find agent
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, session.deviceId))
      .limit(1);

    if (device?.agentId && isAgentConnected(device.agentId)) {
      sendCommandToAgent(device.agentId, {
        id: `tun-close-${Date.now()}`,
        type: 'tunnel_close',
        payload: { tunnelId: id },
      });
    }

    await db
      .update(tunnelSessions)
      .set({ status: 'disconnected', endedAt: new Date() })
      .where(eq(tunnelSessions.id, id));

    // Revoke any viewer JWTs minted for this tunnel. Stamp a per-sessionId
    // revoke key so that requireViewerToken rejects lingering tokens even if
    // the jti itself is not individually tracked. TTL matches the viewer token
    // max TTL so the key auto-expires. Best-effort: if Redis is down the DB
    // status='disconnected' write already happened, so we don't fail the close.
    const redis = getRedis();
    if (redis) {
      await redis.set(`viewer-session-revoked:${id}`, '1', 'EX', 2 * 60 * 60);
    }

    return c.json({ closed: true });
  }
);

// POST /tunnels/:id/ws-ticket — Issue a one-time WebSocket ticket
tunnelRoutes.post(
  '/:id/ws-ticket',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const conditions = [eq(tunnelSessions.id, id)];
    if (auth.orgId) {
      conditions.push(eq(tunnelSessions.orgId, auth.orgId));
    }

    const [session] = await db
      .select()
      .from(tunnelSessions)
      .where(and(...conditions))
      .limit(1);

    if (!session) {
      return c.json({ error: 'Tunnel session not found' }, 404);
    }

    if (session.userId !== auth.user.id) {
      return c.json({ error: 'Not the session owner' }, 403);
    }

    const ticket = await createWsTicket({
      sessionId: id,
      sessionType: 'tunnel',
      userId: auth.user.id,
    });

    return c.json({ ticket });
  }
);

// POST /tunnels/:id/connect-code — Issue a short-lived VNC connect code (keeps JWT out of deep links)
tunnelRoutes.post(
  '/:id/connect-code',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const conditions = [eq(tunnelSessions.id, id)];
    if (auth.orgId) {
      conditions.push(eq(tunnelSessions.orgId, auth.orgId));
    }
    if (auth.scope === 'organization') {
      conditions.push(eq(tunnelSessions.userId, auth.user.id));
    }

    const [session] = await db
      .select()
      .from(tunnelSessions)
      .where(and(...conditions))
      .limit(1);

    if (!session) {
      return c.json({ error: 'Tunnel session not found' }, 404);
    }

    if (session.type !== 'vnc') {
      return c.json({ error: 'Connect code only supported for VNC tunnels' }, 400);
    }

    if (session.userId !== auth.user.id) {
      return c.json({ error: 'Not the session owner' }, 403);
    }

    try {
      const result = await createVncConnectCode({
        tunnelId: session.id,
        deviceId: session.deviceId,
        orgId: session.orgId,
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json(result);
    } catch (err) {
      console.error('[tunnels] Failed to create VNC connect code:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Unable to create VNC connect code. Please try again later.' }, 503);
    }
  }
);

// --- VNC exchange route (no auth — the code IS the auth) ---

export const vncExchangeRoutes = new Hono();

const vncExchangeSchema = z.object({
  code: z.string().min(1),
});

// POST /vnc-exchange/:code — Redeem a short-lived VNC connect code for credentials + tunnel info.
// No bearer auth: the one-time code proves identity. Rate-limited at mount point.
vncExchangeRoutes.post(
  '/:code',
  async (c) => {
    const code = c.req.param('code')!;

    const record = await consumeVncConnectCode(code);
    if (!record) {
      return c.json({ error: 'Invalid or expired VNC connect code' }, 404);
    }

    // Fetch tunnel info and build ws-ticket in system context (no RLS context from bearer token).
    const result = await withSystemDbAccessContext(async () => {
      const [session] = await db
        .select()
        .from(tunnelSessions)
        .where(eq(tunnelSessions.id, record.tunnelId))
        .limit(1);
      return session;
    });

    if (!result) {
      return c.json({ error: 'Tunnel session not found' }, 404);
    }

    if (result.userId !== record.userId) {
      // Ownership mismatch — should never happen if code was minted correctly
      return c.json({ error: 'Invalid or expired VNC connect code' }, 404);
    }

    // Build the WebSocket URL from the canonical external base URL. Using
    // c.req.url would yield an internal http://api:3001 in Caddy-fronted
    // deployments; honoring X-Forwarded-Proto doesn't help when Caddy itself
    // sits behind Cloudflare (Caddy overwrites the forwarded header with its
    // own http view). PUBLIC_APP_URL / DASHBOARD_URL is the source of truth.
    const publicBase = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || '').replace(/\/$/, '');
    const baseUrl = publicBase ? new URL(publicBase) : new URL(c.req.url);
    const wsProtocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsTicketResult = await createWsTicket({
      sessionId: record.tunnelId,
      sessionType: 'tunnel',
      userId: record.userId,
    });
    const wsUrl = `${wsProtocol}//${baseUrl.host}/api/v1/tunnel-ws/${record.tunnelId}/ws?ticket=${wsTicketResult.ticket}`;

    const accessToken = await createViewerAccessToken({
      sub: record.userId,
      email: record.email,
      sessionId: record.tunnelId,
    });

    return c.json({
      accessToken,
      expiresInSeconds: getViewerAccessTokenExpirySeconds(),
      tunnelId: record.tunnelId,
      wsUrl,
      deviceId: record.deviceId,
    });
  }
);

// --- Viewer-token endpoints (used by the Breeze Viewer after vnc-exchange) ---
//
// The viewer receives a `purpose: 'viewer'` JWT scoped to a specific tunnel
// sessionId. It can't use the regular authMiddleware (which requires a full
// user access token), so this router verifies viewer tokens directly and
// enforces that the token is bound to the tunnelId being queried.

export const vncViewerRoutes = new Hono();

async function requireViewerToken(c: Context): Promise<{ sessionId: string; jti: string } | Response> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }
  const token = authHeader.slice(7);
  const payload = await verifyViewerAccessToken(token);
  if (!payload || !payload.jti) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
  // Check jti-level revocation (belt — individual token invalidation)
  if (await isViewerJtiRevoked(payload.jti)) {
    return c.json({ error: 'Token revoked' }, 401);
  }
  // Check session-level revocation (suspenders — stamped on tunnel close)
  if (await getRedis()?.get(`viewer-session-revoked:${payload.sessionId}`)) {
    return c.json({ error: 'Session closed' }, 401);
  }
  return { sessionId: payload.sessionId, jti: payload.jti };
}

// GET /vnc-viewer/desktop-access
// Returns the bound device's desktopAccess mode + last_user. Used by the
// viewer's 5s poll to detect login-window → user_session transitions so it
// can auto-hand off from VNC to WebRTC once a user logs in.
vncViewerRoutes.get('/desktop-access', async (c) => {
  const result = await requireViewerToken(c);
  if (result instanceof Response) return result;

  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        desktopAccess: devices.desktopAccess,
        lastUser: devices.lastUser,
      })
      .from(tunnelSessions)
      .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
      .where(eq(tunnelSessions.id, result.sessionId))
      .limit(1);
    return row ?? null;
  });

  if (!device) {
    return c.json({ error: 'Tunnel session not found' }, 404);
  }

  return c.json({
    desktopAccess: device.desktopAccess,
    lastUser: device.lastUser,
  });
});

// POST /vnc-viewer/upgrade-to-webrtc
// Called by the viewer when the poll above reports user_session and we want
// to hand off from VNC to WebRTC. Creates a new `remote_sessions` row (type
// 'desktop') for the tunnel-bound device and issues a fresh viewer access
// token scoped to the new desktop sessionId. The viewer then uses that
// sessionId + token to drive the standard `/desktop-ws/:sessionId/viewer/*`
// endpoints for ICE, offer, ws-ticket, etc.
vncViewerRoutes.post('/upgrade-to-webrtc', async (c) => {
  const auth = await requireViewerToken(c);
  if (auth instanceof Response) return auth;

  const bound = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        tunnelUserId: tunnelSessions.userId,
        tunnelOrgId: tunnelSessions.orgId,
        deviceId: tunnelSessions.deviceId,
        deviceStatus: devices.status,
        agentId: devices.agentId,
        userEmail: users.email,
      })
      .from(tunnelSessions)
      .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
      .innerJoin(users, eq(tunnelSessions.userId, users.id))
      .where(eq(tunnelSessions.id, auth.sessionId))
      .limit(1);
    return row ?? null;
  });

  if (!bound) {
    return c.json({ error: 'Tunnel session not found' }, 404);
  }
  if (bound.deviceStatus !== 'online') {
    return c.json({ error: 'Device is not online' }, 400);
  }

  const policyCheck = await checkRemoteAccess(bound.deviceId, 'webrtcDesktop');
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.reason ?? 'WebRTC desktop access is disabled by policy' }, 403);
  }

  // Reuse the same pattern as /sessions: terminate stragglers first, insert
  // new pending row, return its id.
  const session = await withSystemDbAccessContext(async () => {
    await db
      .update(remoteSessions)
      .set({ status: 'disconnected', endedAt: new Date() })
      .where(
        and(
          eq(remoteSessions.deviceId, bound.deviceId),
          eq(remoteSessions.type, 'desktop'),
          inArray(remoteSessions.status, ['pending', 'connecting', 'active'])
        )
      );
    const [row] = await db
      .insert(remoteSessions)
      .values({
        deviceId: bound.deviceId,
        orgId: bound.tunnelOrgId,
        userId: bound.tunnelUserId,
        type: 'desktop',
        status: 'pending',
        iceCandidates: [],
      })
      .returning();
    return row;
  });

  if (!session) {
    return c.json({ error: 'Failed to create desktop session' }, 500);
  }

  const accessToken = await createViewerAccessToken({
    sub: bound.tunnelUserId,
    email: bound.userEmail,
    sessionId: session.id,
  });

  return c.json({
    sessionId: session.id,
    accessToken,
    expiresInSeconds: getViewerAccessTokenExpirySeconds(),
  });
});

// POST /vnc-viewer/downgrade-to-vnc
// Inverse of upgrade-to-webrtc. Called when the viewer is on WebRTC and
// receives a `desktop_state: 'loginwindow'` broadcast (user locked/logged
// out) and wants to fall back to VNC. The viewer token is desktop-scoped
// (sessionId = remote_sessions.id); we use it to look up the device, spin
// up a fresh VNC tunnel, issue a ws-ticket, and hand back a new viewer
// token scoped to the tunnel id. Mirrors POST /tunnels but for viewer-token
// auth (which can't hit the user-JWT-gated route).
vncViewerRoutes.post('/downgrade-to-vnc', async (c) => {
  const auth = await requireViewerToken(c);
  if (auth instanceof Response) return auth;

  const bound = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        userId: remoteSessions.userId,
        orgId: remoteSessions.orgId,
        deviceId: remoteSessions.deviceId,
        deviceStatus: devices.status,
        agentId: devices.agentId,
        userEmail: users.email,
      })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .innerJoin(users, eq(remoteSessions.userId, users.id))
      .where(eq(remoteSessions.id, auth.sessionId))
      .limit(1);
    return row ?? null;
  });

  if (!bound) {
    return c.json({ error: 'Desktop session not found' }, 404);
  }
  if (bound.deviceStatus !== 'online') {
    return c.json({ error: 'Device is not online' }, 400);
  }
  if (!bound.agentId || !isAgentConnected(bound.agentId)) {
    return c.json({ error: 'Agent is not connected' }, 400);
  }

  const policyCheck = await checkRemoteAccess(bound.deviceId, 'vncRelay');
  if (!policyCheck.allowed) {
    return c.json({ error: policyCheck.reason ?? 'VNC relay is disabled by policy' }, 403);
  }

  // Insert the tunnel session row, then kick the agent off.
  const tunnel = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(tunnelSessions)
      .values({
        deviceId: bound.deviceId,
        userId: bound.userId,
        orgId: bound.orgId,
        type: 'vnc',
        status: 'pending',
        targetHost: '127.0.0.1',
        targetPort: 5900,
        sourceIp: getClientIp(c),
      })
      .returning();
    return row;
  });

  if (!tunnel) {
    return c.json({ error: 'Failed to create tunnel' }, 500);
  }

  const sent = sendCommandToAgent(bound.agentId, {
    id: `tun-open-${tunnel.id}`,
    type: 'tunnel_open',
    payload: {
      tunnelId: tunnel.id,
      targetHost: '127.0.0.1',
      targetPort: 5900,
      tunnelType: 'vnc',
      allowlistRules: [],
    },
  });
  if (!sent) {
    await withSystemDbAccessContext(() =>
      db.update(tunnelSessions)
        .set({ status: 'failed', errorMessage: 'Agent disconnected before tunnel could be opened', endedAt: new Date() })
        .where(eq(tunnelSessions.id, tunnel.id))
    );
    return c.json({ error: 'Agent disconnected before tunnel could be opened' }, 503);
  }

  // Build the ws-ticket + wsUrl the same way /vnc-exchange does. Ticket TTL
  // is short (60s) — the viewer connects immediately after this call.
  const ticket = await createWsTicket({
    sessionId: tunnel.id,
    sessionType: 'tunnel',
    userId: bound.userId,
  });
  const publicBase = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || '').replace(/\/$/, '');
  const baseUrl = publicBase ? new URL(publicBase) : new URL(c.req.url);
  const wsProtocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${baseUrl.host}/api/v1/tunnel-ws/${tunnel.id}/ws?ticket=${ticket.ticket}`;

  const accessToken = await createViewerAccessToken({
    sub: bound.userId,
    email: bound.userEmail,
    sessionId: tunnel.id,
  });

  return c.json({
    tunnelId: tunnel.id,
    wsUrl,
    accessToken,
    expiresInSeconds: getViewerAccessTokenExpirySeconds(),
  });
});
