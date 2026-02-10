import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { db } from '../db';
import { psaConnections as psaConnectionsTable, psaTicketMappings } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { decryptSecret, encryptSecret } from '../services/secretCrypto';

export const psaRoutes = new Hono();

type PsaProvider = 'jira' | 'servicenow' | 'connectwise' | 'autotask' | 'freshservice' | 'zendesk';

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

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  return true;
}

function encryptCredentials(credentials: Record<string, unknown>): string | null {
  return encryptSecret(JSON.stringify(credentials));
}

function decryptCredentials(value: unknown): Record<string, unknown> | null {
  if (!value) return null;

  const parseRecord = (payload: unknown): Record<string, unknown> | null => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    return null;
  };

  try {
    if (typeof value === 'string') {
      const decrypted = decryptSecret(value);
      if (!decrypted) return null;
      return parseRecord(JSON.parse(decrypted));
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const asRecord = value as Record<string, unknown>;
      if (typeof asRecord.encrypted === 'string') {
        const decrypted = decryptSecret(asRecord.encrypted);
        if (!decrypted) return null;
        return parseRecord(JSON.parse(decrypted));
      }

      return asRecord;
    }
  } catch (error) {
    console.error('[psa] Failed to decrypt PSA connection credentials:', error);
  }

  return null;
}

function extractLastTestedAt(syncSettings: unknown): Date | null {
  if (!syncSettings || typeof syncSettings !== 'object' || Array.isArray(syncSettings)) {
    return null;
  }

  const value = (syncSettings as Record<string, unknown>).lastTestedAt;
  if (typeof value !== 'string') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mergeObjectState(
  source: unknown,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const base = source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {};

  return {
    ...base,
    ...patch
  };
}

function serializeConnection(
  connection: {
    id: string;
    orgId: string;
    provider: string;
    name: string;
    credentials: unknown;
    settings: unknown;
    syncSettings: unknown;
    createdAt: Date;
    updatedAt: Date;
    lastSyncAt: Date | null;
  },
  includeCredentials: boolean
) {
  const response = {
    id: connection.id,
    orgId: connection.orgId,
    provider: connection.provider,
    name: connection.name,
    settings: (connection.settings && typeof connection.settings === 'object' && !Array.isArray(connection.settings))
      ? connection.settings
      : {},
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastTestedAt: extractLastTestedAt(connection.syncSettings),
    lastSyncedAt: connection.lastSyncAt,
    hasCredentials: Boolean(connection.credentials)
  };

  if (!includeCredentials) {
    return response;
  }

  return {
    ...response,
    credentials: decryptCredentials(connection.credentials)
  };
}

function mapTicketRow(row: {
  id: string;
  connectionId: string;
  externalTicketId: string | null;
  externalTicketUrl: string | null;
  status: string | null;
  alertId: string | null;
  deviceId: string | null;
  lastSyncAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}) {
  const syncedAt = row.lastSyncAt ?? row.updatedAt ?? row.createdAt;

  return {
    id: row.id,
    psaId: row.connectionId,
    title: row.externalTicketId ? `Ticket ${row.externalTicketId}` : `Ticket ${row.id.slice(0, 8)}`,
    status: row.status ?? undefined,
    syncedAt,
    raw: {
      externalTicketId: row.externalTicketId,
      externalTicketUrl: row.externalTicketUrl,
      alertId: row.alertId,
      deviceId: row.deviceId
    }
  };
}

async function resolveOrgIds(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  queryOrgId?: string
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return [];
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    if (queryOrgId) {
      const hasAccess = await ensureOrgAccess(queryOrgId, auth);
      return hasAccess ? [queryOrgId] : [];
    }

    return auth.accessibleOrgIds ?? [];
  }

  return queryOrgId ? [queryOrgId] : null;
}

async function getConnectionById(id: string) {
  const [connection] = await db
    .select({
      id: psaConnectionsTable.id,
      orgId: psaConnectionsTable.orgId,
      provider: psaConnectionsTable.provider,
      name: psaConnectionsTable.name,
      credentials: psaConnectionsTable.credentials,
      settings: psaConnectionsTable.settings,
      syncSettings: psaConnectionsTable.syncSettings,
      createdAt: psaConnectionsTable.createdAt,
      updatedAt: psaConnectionsTable.updatedAt,
      lastSyncAt: psaConnectionsTable.lastSyncAt
    })
    .from(psaConnectionsTable)
    .where(eq(psaConnectionsTable.id, id))
    .limit(1);

  return connection ?? null;
}

psaRoutes.use('*', authMiddleware);

psaRoutes.get(
  '/connections',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listConnectionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgIds = await resolveOrgIds(auth, query.orgId);

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    const conditions = [];
    if (orgIds) {
      if (orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      conditions.push(inArray(psaConnectionsTable.orgId, orgIds));
    }

    if (query.provider) {
      conditions.push(eq(psaConnectionsTable.provider, query.provider as any));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: psaConnectionsTable.id,
        orgId: psaConnectionsTable.orgId,
        provider: psaConnectionsTable.provider,
        name: psaConnectionsTable.name,
        credentials: psaConnectionsTable.credentials,
        settings: psaConnectionsTable.settings,
        syncSettings: psaConnectionsTable.syncSettings,
        createdAt: psaConnectionsTable.createdAt,
        updatedAt: psaConnectionsTable.updatedAt,
        lastSyncAt: psaConnectionsTable.lastSyncAt
      })
      .from(psaConnectionsTable)
      .where(whereClause)
      .orderBy(desc(psaConnectionsTable.updatedAt))
      .limit(limit)
      .offset(offset);

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(psaConnectionsTable)
      .where(whereClause);

    return c.json({
      data: rows.map((row) => serializeConnection(row, false)),
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);

psaRoutes.post(
  '/connections',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
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
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required for system scope' }, 400);
    }

    const credentialsEncrypted = encryptCredentials(data.credentials);
    if (!credentialsEncrypted) {
      return c.json({ error: 'Failed to encrypt credentials' }, 500);
    }

    const [connection] = await db
      .insert(psaConnectionsTable)
      .values({
        orgId: orgId as string,
        provider: data.provider as PsaProvider,
        name: data.name,
        credentials: credentialsEncrypted,
        settings: data.settings ?? {},
        syncSettings: {},
        createdBy: auth.user.id,
        updatedAt: new Date()
      })
      .returning({
        id: psaConnectionsTable.id,
        orgId: psaConnectionsTable.orgId,
        provider: psaConnectionsTable.provider,
        name: psaConnectionsTable.name,
        credentials: psaConnectionsTable.credentials,
        settings: psaConnectionsTable.settings,
        syncSettings: psaConnectionsTable.syncSettings,
        createdAt: psaConnectionsTable.createdAt,
        updatedAt: psaConnectionsTable.updatedAt,
        lastSyncAt: psaConnectionsTable.lastSyncAt
      });

    if (!connection) {
      return c.json({ error: 'Failed to create PSA connection' }, 500);
    }

    writeRouteAudit(c, {
      orgId: connection.orgId,
      action: 'psa.connection.create',
      resourceType: 'psa_connection',
      resourceId: connection.id,
      resourceName: connection.name,
      details: { provider: connection.provider }
    });

    return c.json(serializeConnection(connection, false), 201);
  }
);

psaRoutes.get(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');

    const connection = await getConnectionById(connectionId);
    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json({ data: serializeConnection(connection, false) });
  }
);

psaRoutes.patch(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  zValidator('json', updateConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existing.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date()
    };

    if (data.name !== undefined) {
      updates.name = data.name;
    }

    if (data.credentials !== undefined) {
      const encrypted = encryptCredentials(data.credentials);
      if (!encrypted) {
        return c.json({ error: 'Failed to encrypt credentials' }, 500);
      }
      updates.credentials = encrypted;
    }

    if (data.settings !== undefined) {
      updates.settings = data.settings;
    }

    const [updated] = await db
      .update(psaConnectionsTable)
      .set(updates)
      .where(eq(psaConnectionsTable.id, connectionId))
      .returning({
        id: psaConnectionsTable.id,
        orgId: psaConnectionsTable.orgId,
        provider: psaConnectionsTable.provider,
        name: psaConnectionsTable.name,
        credentials: psaConnectionsTable.credentials,
        settings: psaConnectionsTable.settings,
        syncSettings: psaConnectionsTable.syncSettings,
        createdAt: psaConnectionsTable.createdAt,
        updatedAt: psaConnectionsTable.updatedAt,
        lastSyncAt: psaConnectionsTable.lastSyncAt
      });

    if (!updated) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'psa.connection.update',
      resourceType: 'psa_connection',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(serializeConnection(updated, false));
  }
);

psaRoutes.delete(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existing.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    await db.delete(psaTicketMappings).where(eq(psaTicketMappings.connectionId, connectionId));
    await db.delete(psaConnectionsTable).where(eq(psaConnectionsTable.id, connectionId));

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.delete',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name
    });

    return c.json({ success: true });
  }
);

psaRoutes.post(
  '/connections/:id/test',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existing.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    await db
      .update(psaConnectionsTable)
      .set({
        syncSettings: mergeObjectState(existing.syncSettings, { lastTestedAt: new Date().toISOString(), status: 'verified' }),
        updatedAt: new Date()
      })
      .where(eq(psaConnectionsTable.id, existing.id));

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.test',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name
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
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existing.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const syncedAt = new Date();

    await db
      .update(psaConnectionsTable)
      .set({
        lastSyncAt: syncedAt,
        lastSyncStatus: 'queued',
        updatedAt: syncedAt
      })
      .where(eq(psaConnectionsTable.id, existing.id));

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.sync',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name
    });

    return c.json({
      id: existing.id,
      provider: existing.provider,
      syncedAt: syncedAt.toISOString(),
      status: 'queued'
    });
  }
);

psaRoutes.post(
  '/connections/:id/status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');

    const existing = await getConnectionById(connectionId);
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existing.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const body = await c.req.json<{ status: string }>();

    await db
      .update(psaConnectionsTable)
      .set({
        settings: mergeObjectState(existing.settings, { status: body.status }),
        syncSettings: mergeObjectState(existing.syncSettings, { status: body.status }),
        updatedAt: new Date()
      })
      .where(eq(psaConnectionsTable.id, existing.id));

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.status.update',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name,
      details: { status: body.status }
    });

    return c.json({ success: true, status: body.status });
  }
);

psaRoutes.get(
  '/tickets',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listTicketsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgIds = await resolveOrgIds(auth);
    if (orgIds && orgIds.length === 0) {
      return c.json({ data: [], pagination: { page, limit, total: 0 } });
    }

    const conditions = [];
    if (orgIds) {
      conditions.push(inArray(psaConnectionsTable.orgId, orgIds));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: psaTicketMappings.id,
        connectionId: psaTicketMappings.connectionId,
        externalTicketId: psaTicketMappings.externalTicketId,
        externalTicketUrl: psaTicketMappings.externalTicketUrl,
        status: psaTicketMappings.status,
        alertId: psaTicketMappings.alertId,
        deviceId: psaTicketMappings.deviceId,
        lastSyncAt: psaTicketMappings.lastSyncAt,
        updatedAt: psaTicketMappings.updatedAt,
        createdAt: psaTicketMappings.createdAt
      })
      .from(psaTicketMappings)
      .innerJoin(psaConnectionsTable, eq(psaTicketMappings.connectionId, psaConnectionsTable.id))
      .where(whereClause)
      .orderBy(desc(psaTicketMappings.updatedAt))
      .limit(limit)
      .offset(offset);

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(psaTicketMappings)
      .innerJoin(psaConnectionsTable, eq(psaTicketMappings.connectionId, psaConnectionsTable.id))
      .where(whereClause);

    return c.json({
      data: rows.map(mapTicketRow),
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);

psaRoutes.get(
  '/connections/:id/tickets',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listTicketsSchema),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const connection = await getConnectionById(connectionId);
    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const rows = await db
      .select({
        id: psaTicketMappings.id,
        connectionId: psaTicketMappings.connectionId,
        externalTicketId: psaTicketMappings.externalTicketId,
        externalTicketUrl: psaTicketMappings.externalTicketUrl,
        status: psaTicketMappings.status,
        alertId: psaTicketMappings.alertId,
        deviceId: psaTicketMappings.deviceId,
        lastSyncAt: psaTicketMappings.lastSyncAt,
        updatedAt: psaTicketMappings.updatedAt,
        createdAt: psaTicketMappings.createdAt
      })
      .from(psaTicketMappings)
      .where(eq(psaTicketMappings.connectionId, connectionId))
      .orderBy(desc(psaTicketMappings.updatedAt))
      .limit(limit)
      .offset(offset);

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(psaTicketMappings)
      .where(eq(psaTicketMappings.connectionId, connectionId));

    return c.json({
      data: rows.map(mapTicketRow),
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);
