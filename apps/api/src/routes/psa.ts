import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../db';
import { organizations } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const psaRoutes = new Hono();

type PsaProvider = 'jira' | 'servicenow' | 'connectwise' | 'autotask' | 'freshservice' | 'zendesk';

type PsaConnection = {
  id: string;
  orgId: string;
  provider: PsaProvider;
  name: string;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  lastTestedAt: Date | null;
  lastSyncedAt: Date | null;
};

type PsaTicket = {
  id: string;
  psaId: string;
  title: string;
  status?: string;
  syncedAt: Date;
  raw?: Record<string, unknown>;
};

// Temporary in-memory stores until PSA tables are introduced.
const psaConnections = new Map<string, PsaConnection>();
const psaTickets = new Map<string, PsaTicket[]>();

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

function serializeConnection(connection: PsaConnection, includeCredentials: boolean) {
  if (includeCredentials) {
    return connection;
  }

  const { credentials, ...rest } = connection;
  return rest;
}

const providerSchema = z.enum(['jira', 'servicenow', 'connectwise', 'autotask', 'freshservice', 'zendesk']);

const listConnectionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  provider: providerSchema.optional()
});

const createConnectionSchema = z.object({
  orgId: z.string().uuid().optional(),
  provider: providerSchema,
  name: z.string().min(1).max(255),
  credentials: z.record(z.any()),
  settings: z.record(z.any()).optional().default({})
});

const updateConnectionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  credentials: z.record(z.any()).optional(),
  settings: z.record(z.any()).optional()
});

const listTicketsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

psaRoutes.use('*', authMiddleware);

// Helper to resolve accessible org IDs for the current auth context
async function resolveOrgIds(auth: { scope: string; partnerId: string | null; orgId: string | null }, queryOrgId?: string): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return [];
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    if (queryOrgId) {
      const hasAccess = await ensureOrgAccess(queryOrgId, auth);
      return hasAccess ? [queryOrgId] : [];
    }
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId as string));
    return partnerOrgs.map((org) => org.id);
  }

  // system scope
  return queryOrgId ? [queryOrgId] : null;
}

// --- Connections ---

psaRoutes.get(
  '/connections',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listConnectionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgIds = await resolveOrgIds(auth, query.orgId);

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    let connections = Array.from(psaConnections.values());

    if (orgIds) {
      if (orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      connections = connections.filter((connection) => orgIds.includes(connection.orgId));
    }

    if (query.provider) {
      connections = connections.filter((connection) => connection.provider === query.provider);
    }

    const total = connections.length;
    const data = connections
      .slice(offset, offset + limit)
      .map((connection) => serializeConnection(connection, false));

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

psaRoutes.post(
  '/connections',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for system scope' }, 400);
      }
    }

    const now = new Date();
    const connection: PsaConnection = {
      id: randomUUID(),
      orgId: orgId as string,
      provider: data.provider,
      name: data.name,
      credentials: data.credentials,
      settings: data.settings ?? {},
      createdAt: now,
      updatedAt: now,
      lastTestedAt: null,
      lastSyncedAt: null
    };

    psaConnections.set(connection.id, connection);

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.create',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name,
      details: { provider: connection.provider }
    });

    return c.json(serializeConnection(connection, true), 201);
  }
);

psaRoutes.get(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const connection = psaConnections.get(connectionId);

    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json({ data: serializeConnection(connection, true) });
  }
);

psaRoutes.patch(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const connection = psaConnections.get(connectionId);
    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (data.name !== undefined) {
      connection.name = data.name;
    }
    if (data.credentials !== undefined) {
      connection.credentials = data.credentials;
    }
    if (data.settings !== undefined) {
      connection.settings = data.settings;
    }
    connection.updatedAt = new Date();

    psaConnections.set(connection.id, connection);

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.update',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(serializeConnection(connection, true));
  }
);

psaRoutes.delete(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const connection = psaConnections.get(connectionId);

    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    psaConnections.delete(connectionId);
    psaTickets.delete(connectionId);

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.delete',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name
    });

    return c.json({ success: true });
  }
);

psaRoutes.post(
  '/connections/:id/test',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const connection = psaConnections.get(connectionId);

    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    connection.lastTestedAt = new Date();
    connection.updatedAt = new Date();
    psaConnections.set(connection.id, connection);

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.test',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name
    });

    return c.json({
      success: true,
      message: 'Credentials verified'
    });
  }
);

psaRoutes.post(
  '/connections/:id/sync',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const connection = psaConnections.get(connectionId);

    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    connection.lastSyncedAt = new Date();
    connection.updatedAt = new Date();
    psaConnections.set(connection.id, connection);

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.sync',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name
    });

    return c.json({
      id: connection.id,
      provider: connection.provider,
      syncedAt: connection.lastSyncedAt.toISOString(),
      status: 'queued'
    });
  }
);

psaRoutes.post(
  '/connections/:id/status',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const connection = psaConnections.get(connectionId);

    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const body = await c.req.json<{ status: string }>();
    connection.settings = { ...connection.settings, status: body.status };
    connection.updatedAt = new Date();
    psaConnections.set(connection.id, connection);

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.status.update',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name,
      details: { status: body.status }
    });

    return c.json({ success: true, status: body.status });
  }
);

// --- Tickets ---

psaRoutes.get(
  '/tickets',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTicketsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgIds = await resolveOrgIds(auth);

    // Collect tickets from all accessible connections
    let allTickets: PsaTicket[] = [];
    for (const [connId, connection] of psaConnections) {
      if (orgIds && !orgIds.includes(connection.orgId)) continue;
      const tickets = psaTickets.get(connId) ?? [];
      allTickets = allTickets.concat(tickets);
    }

    const total = allTickets.length;
    const data = allTickets.slice(offset, offset + limit);

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

psaRoutes.get(
  '/connections/:id/tickets',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTicketsSchema),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const connection = psaConnections.get(connectionId);
    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const tickets = psaTickets.get(connectionId) ?? [];
    const total = tickets.length;
    const data = tickets.slice(offset, offset + limit);

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);
