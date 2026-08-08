import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { psaProviderIdSchema, type PsaProviderId } from '@breeze/shared';
import {
  authMiddleware,
  dbAccessContextFromAuth,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext
} from '../middleware/auth';
import { db, runOutsideDbContext, withDbAccessContext } from '../db';
import { devices, psaConnections as psaConnectionsTable, psaTicketMappings } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { createPSAProvider } from '../services/psa';
import {
  PsaConfigError,
  decryptCredentials,
  encryptCredentials,
  validatePsaCredentialBaseUrl
} from '../services/psa/credentials';

export const psaRoutes = new Hono();

type PsaProvider = PsaProviderId;

// Single-source provider list — @breeze/shared PSA_PROVIDERS. The DB enum is
// intentionally wider (halo/syncro/kaseya/other are dead values); this schema
// is the gate.
const providerSchema = psaProviderIdSchema;

const listConnectionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().guid().optional(),
  provider: providerSchema.optional()
});

const createConnectionSchema = z.object({
  orgId: z.string().guid().optional(),
  provider: providerSchema,
  name: z.string().min(1).max(255),
  credentials: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ),
  settings: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional().default({})
});

const updateConnectionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  credentials: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional(),
  settings: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional()
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

// Round-trip contract with the web form (PsaConnectionsPage/PsaConnectionForm):
// non-secret credential fields are returned for edit prefill; secrets are NEVER
// returned — only per-field presence flags so the form can show "keep existing".
const PSA_PUBLIC_CREDENTIAL_KEYS = ['baseUrl', 'username', 'clientId'] as const;
const PSA_SECRET_CREDENTIAL_KEYS = ['password', 'apiToken', 'clientSecret'] as const;

function deriveConnectionStatus(settings: unknown): 'active' | 'paused' | 'error' {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const status = (settings as Record<string, unknown>).status;
    if (status === 'paused' || status === 'error') return status;
  }
  return 'active';
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
  includeCredentialInfo: boolean
) {
  const settings = (connection.settings && typeof connection.settings === 'object' && !Array.isArray(connection.settings))
    ? connection.settings as Record<string, unknown>
    : {};

  const response = {
    id: connection.id,
    orgId: connection.orgId,
    provider: connection.provider,
    name: connection.name,
    status: deriveConnectionStatus(settings),
    settings,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastTestedAt: extractLastTestedAt(connection.syncSettings)
  };

  if (!includeCredentialInfo) {
    return response;
  }

  const decrypted = decryptCredentials(connection.credentials) ?? {};
  const credentials: Record<string, string> = {};
  for (const key of PSA_PUBLIC_CREDENTIAL_KEYS) {
    const value = decrypted[key];
    if (typeof value === 'string' && value.length > 0) {
      credentials[key] = value;
    }
  }

  const hasCredentials = Object.fromEntries(
    PSA_SECRET_CREDENTIAL_KEYS.map((key) => {
      const value = decrypted[key];
      return [key, typeof value === 'string' ? value.length > 0 : Boolean(value)];
    })
  ) as Record<(typeof PSA_SECRET_CREDENTIAL_KEYS)[number], boolean>;

  return {
    ...response,
    credentials,
    hasCredentials
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
  requireMfa(),
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
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required for system scope' }, 400);
    }

    const baseUrlError = validatePsaCredentialBaseUrl(data.credentials);
    if (baseUrlError) {
      return c.json({ error: baseUrlError }, 400);
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
    const connectionId = c.req.param('id')!;

    const connection = await getConnectionById(connectionId);
    if (!connection) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(connection.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // includeCredentialInfo: non-secret prefill fields + per-field secret
    // presence flags for the edit form. Secrets themselves are never returned.
    return c.json({ data: serializeConnection(connection, true) });
  }
);

psaRoutes.patch(
  '/connections/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', updateConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;
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
      // Merge-with-existing semantics: keys present in the patch overwrite,
      // `null` deletes a key, absent keys keep their stored value. This lets
      // the edit form omit untouched secrets without wiping them.
      const existingCredentials = decryptCredentials(existing.credentials) ?? {};
      const merged: Record<string, unknown> = { ...existingCredentials };
      for (const [key, value] of Object.entries(data.credentials)) {
        if (value === null) {
          delete merged[key];
        } else {
          merged[key] = value;
        }
      }

      const baseUrlError = validatePsaCredentialBaseUrl(merged);
      if (baseUrlError) {
        return c.json({ error: baseUrlError }, 400);
      }

      const encrypted = encryptCredentials(merged);
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
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

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

/**
 * POST /connections/:id/test is registered in SELF_MANAGED_DB_CONTEXT_ROUTES
 * (#1448 / #1105 class) — it makes a REAL outbound HTTP call to the PSA
 * (psaFetch, 20s timeout, tenant-controlled baseUrl), so the auth middleware
 * does NOT wrap this route in the usual request transaction. Reads/writes run
 * in short explicit contexts built from the same fields the middleware would
 * have used, with the network call between them. Mirrors
 * `withChannelsDbContext` in routes/alerts/channels.ts.
 */
function withPsaDbContext<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), fn));
}

psaRoutes.post(
  '/connections/:id/test',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

    // Short, explicit DB context — no ambient request transaction here (#1448).
    const existing = await withPsaDbContext(auth, () => getConnectionById(connectionId));
    if (!existing) {
      return c.json({ error: 'PSA connection not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existing.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const credentials = decryptCredentials(existing.credentials);
    if (!credentials) {
      return c.json({ error: 'PSA connection has no usable credentials' }, 400);
    }

    const settings = (existing.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings))
      ? existing.settings as Record<string, unknown>
      : {};

    let providerClient;
    try {
      providerClient = createPSAProvider(existing.provider, credentials, settings);
    } catch (error) {
      if (error instanceof PsaConfigError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    // Real connectivity test — runs OUTSIDE any DB context (adapters return
    // {success, message} instead of throwing, but guard anyway).
    let result: { success: boolean; message?: string };
    try {
      result = await providerClient.testConnection();
    } catch (error) {
      result = {
        success: false,
        message: error instanceof Error ? error.message : 'Connection test failed'
      };
    }

    // Persist the outcome in a second short context. Best-effort: a DB hiccup
    // here must not mask the actual test result.
    try {
      await withPsaDbContext(auth, () =>
        db
          .update(psaConnectionsTable)
          .set({
            syncSettings: mergeObjectState(existing.syncSettings, {
              lastTestedAt: new Date().toISOString(),
              status: result.success ? 'verified' : 'failed'
            }),
            updatedAt: new Date()
          })
          .where(eq(psaConnectionsTable.id, existing.id))
      );
    } catch (persistError) {
      console.error('[psa] Failed to persist connection test outcome', { connectionId: existing.id, persistError });
    }

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'psa.connection.test',
      resourceType: 'psa_connection',
      resourceId: existing.id,
      resourceName: existing.name,
      details: { success: result.success },
      result: result.success ? 'success' : 'failure'
    });

    if (!result.success) {
      // HTTP 200 with success:false — the web page's TestResult consumer keys
      // off the body, and runAction-style callers treat {success:false} as failure.
      return c.json({
        success: false,
        error: result.message || 'Connection test failed'
      });
    }

    return c.json({
      success: true,
      message: result.message || 'Credentials verified'
    });
  }
);

psaRoutes.post(
  '/connections/:id/sync',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
    // Honest 501: no PSA sync worker exists. The previous implementation wrote
    // lastSyncStatus='queued' that nothing ever consumed. The route stays
    // registered so clients get a clear "not implemented" instead of a 404.
    return c.json({ error: 'PSA ticket sync is not implemented yet' }, 501);
  }
);

psaRoutes.post(
  '/connections/:id/status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const connectionId = c.req.param('id')!;

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
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgIds = await resolveOrgIds(auth);
    if (orgIds && orgIds.length === 0) {
      return c.json({ data: [], pagination: { page, limit, total: 0 } });
    }

    const conditions: SQL[] = [];
    if (orgIds) {
      conditions.push(inArray(psaConnectionsTable.orgId, orgIds));
    }
    if (perms?.allowedSiteIds) {
      conditions.push(or(
        isNull(psaTicketMappings.deviceId),
        inArray(devices.siteId, perms.allowedSiteIds)
      )!);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rowsQuery = db
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
      .innerJoin(psaConnectionsTable, eq(psaTicketMappings.connectionId, psaConnectionsTable.id));
    const rows = await (perms?.allowedSiteIds
      ? rowsQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : rowsQuery.where(whereClause))
      .orderBy(desc(psaTicketMappings.updatedAt))
      .limit(limit)
      .offset(offset);

    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(psaTicketMappings)
      .innerJoin(psaConnectionsTable, eq(psaTicketMappings.connectionId, psaConnectionsTable.id));
    const countRows = await (perms?.allowedSiteIds
      ? countQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : countQuery.where(whereClause));

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
    const perms = c.get('permissions') as UserPermissions | undefined;
    const connectionId = c.req.param('id')!;
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

    const conditions: SQL[] = [eq(psaTicketMappings.connectionId, connectionId)];
    if (perms?.allowedSiteIds) {
      conditions.push(or(
        isNull(psaTicketMappings.deviceId),
        inArray(devices.siteId, perms.allowedSiteIds)
      )!);
    }
    const whereClause = and(...conditions);

    const rowsQuery = db
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
      .from(psaTicketMappings);
    const rows = await (perms?.allowedSiteIds
      ? rowsQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : rowsQuery.where(whereClause))
      .orderBy(desc(psaTicketMappings.updatedAt))
      .limit(limit)
      .offset(offset);

    const countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(psaTicketMappings);
    const countRows = await (perms?.allowedSiteIds
      ? countQuery.leftJoin(devices, eq(psaTicketMappings.deviceId, devices.id)).where(whereClause)
      : countQuery.where(whereClause));

    return c.json({
      data: rows.map(mapTicketRow),
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);
