import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db';
import { tunnelSessions, tunnelAllowlists, devices, users } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { createWsTicket } from '../services/remoteSessionAuth';
import type { AuthContext } from '../middleware/auth';

export const tunnelRoutes = new Hono();

// Apply auth middleware to all tunnel routes
tunnelRoutes.use('*', authMiddleware);

// --- Schemas ---

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

// GET /tunnels/:id — Get tunnel details (ownership enforced)
tunnelRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id');

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
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id');

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

    return c.json({ closed: true });
  }
);

// POST /tunnels/:id/ws-ticket — Issue a one-time WebSocket ticket
tunnelRoutes.post(
  '/:id/ws-ticket',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id');

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

// --- Allowlist routes ---

// GET /tunnels/allowlist — List allowlist rules for the org
tunnelRoutes.get(
  '/allowlist',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.orgId) {
      return c.json({ error: 'Org context required' }, 400);
    }

    const siteId = c.req.query('siteId');
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
const updateAllowlistSchema = z.object({
  pattern: z.string().min(1).max(255).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});

tunnelRoutes.put(
  '/allowlist/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateAllowlistSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id');
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
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id');
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
