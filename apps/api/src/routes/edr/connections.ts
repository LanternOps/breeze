import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext } from '../../db';
import { edrConnections, edrDetections, edrEndpoints, edrTenants } from '../../db/schema';
import {
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { getEdrProvider } from '../../services/edrProviders/registry';
import { decryptEdrSecret, encryptEdrSecret } from '../../services/edrProviders/credentials';
import { validateVendorUrl } from '../../services/edrProviders/guardedFetch';
import { buildEdrAdapterContext } from '../../services/edrProviders/context';
import { capabilitySnapshot } from '../../services/edrProviders/capabilities';
import type { EdrProviderAdapter } from '../../services/edrProviders/types';
import { enqueueEdrSync } from '../../jobs/edrProviderSync';
import {
  EDR_CONNECTION_PUBLIC_SELECT,
  isGateFailure,
  pgErrorCode,
  requireEdrPartnerAdmin,
  resolveEdrPartnerId,
} from './access';

export const edrConnectionRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().guid() });
const intervalSchema = z.number().int().min(1).max(1440);

const createConnectionSchema = z.object({
  provider: z.string().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().max(300).optional(),
  /** Shape is owned by the adapter's own schema, validated after the registry lookup. */
  credentials: z.record(z.string(), z.unknown()),
  detectionIntervalMinutes: intervalSchema.optional(),
  inventoryIntervalMinutes: intervalSchema.optional(),
});

const patchConnectionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  detectionIntervalMinutes: intervalSchema.nullable().optional(),
  inventoryIntervalMinutes: intervalSchema.nullable().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  baseUrl: z.string().max(300).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be supplied' });

const OPEN_STATUSES = ['open', 'in_progress', 'unknown'] as const;

async function loadConnection(id: string, partnerId: string) {
  const [row] = await db
    .select(EDR_CONNECTION_PUBLIC_SELECT)
    .from(edrConnections)
    .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

/** The ciphertext, loaded ONLY where a vendor call needs it. */
async function loadSecretRow(id: string, partnerId: string) {
  const [row] = await db
    .select({
      id: edrConnections.id,
      provider: edrConnections.provider,
      baseUrl: edrConnections.baseUrl,
      region: edrConnections.region,
      vendorRootId: edrConnections.vendorRootId,
      credentialsEncrypted: edrConnections.credentialsEncrypted,
      isActive: edrConnections.isActive,
    })
    .from(edrConnections)
    .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

/** Operator-supplied base URL vs the adapter policy; returns a friendly 400 message or null. */
function checkBaseUrl(adapter: EdrProviderAdapter, baseUrl: string | undefined | null): string | null {
  const policy = adapter.baseUrlPolicy;
  if (!baseUrl) {
    return policy?.required ? `${adapter.label} requires an Access URL` : null;
  }
  if (!policy) return `${adapter.label} does not accept a custom URL`;
  const v = validateVendorUrl(baseUrl, adapter.hostAllowlist, { pathPrefix: policy.pathPrefix });
  return v.ok ? null : `Invalid Access URL: ${v.reason}`;
}

async function enqueueBoth(connectionId: string): Promise<string[]> {
  // Outside every DB context: the queue is instrumented with assertOutsideHeldDbContext.
  return runOutsideDbContext(async () => [
    await enqueueEdrSync(connectionId, 'inventory'),
    await enqueueEdrSync(connectionId, 'detections'),
  ]);
}

// GET /edr/connections
edrConnectionRoutes.get(
  '/connections',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const gate = resolveEdrPartnerId(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const rows = await db
      .select(EDR_CONNECTION_PUBLIC_SELECT)
      .from(edrConnections)
      .where(eq(edrConnections.partnerId, gate.partnerId))
      .orderBy(edrConnections.name);
    return c.json({ data: rows });
  },
);

// POST /edr/connections
// Registered in SELF_MANAGED_DB_CONTEXT_ROUTES: testConnection is a real vendor
// round-trip, so no request transaction may be held across it (#1105).
edrConnectionRoutes.post(
  '/connections',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', createConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    let adapter: EdrProviderAdapter;
    try {
      adapter = getEdrProvider(body.provider);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown EDR provider' }, 400);
    }

    const creds = adapter.credentialsSchema.safeParse(body.credentials);
    if (!creds.success) return c.json({ error: `Invalid ${adapter.label} credentials` }, 400);

    const urlError = checkBaseUrl(adapter, body.baseUrl);
    if (urlError) return c.json({ error: urlError }, 400);
    const baseUrl = body.baseUrl ?? null;

    // Generated here, not defaulted by the database: the credential blob is
    // sealed with an AAD bound to the row id (aadBinding: 'row').
    const connectionId = randomUUID();

    // Outside any DB context — this route holds none.
    const test = await adapter.testConnection(
      buildEdrAdapterContext(adapter, { creds: creds.data, baseUrl, region: null, vendorRootId: null }),
    );
    if (!test.ok) {
      return c.json({ success: false, error: test.error, reauth: test.reauth }, 422);
    }

    let created;
    try {
      created = await withAuthDbAccessContext(auth, async () => {
        const [row] = await db
          .insert(edrConnections)
          .values({
            id: connectionId,
            partnerId: gate.partnerId,
            provider: adapter.key,
            name: body.name,
            baseUrl,
            credentialsEncrypted: encryptEdrSecret('connection_credentials', connectionId, creds.data),
            vendorRootId: test.rootId,
            vendorRootName: test.rootName,
            vendorRootType: test.rootType,
            isActive: true,
            status: 'connected',
            detectionIntervalMinutes: body.detectionIntervalMinutes ?? null,
            inventoryIntervalMinutes: body.inventoryIntervalMinutes ?? null,
            capabilitiesSnapshot: capabilitySnapshot(adapter, test.capabilityNotes),
            createdBy: auth.user?.id ?? null,
          })
          .returning({ id: edrConnections.id });
        if (!row) return null;
        return loadConnection(row.id, gate.partnerId);
      });
    } catch (error) {
      if (pgErrorCode(error) === '23505') {
        return c.json({
          error: `A connection named "${body.name}" already exists for this provider.`,
          code: 'DUPLICATE_CONNECTION_NAME',
        }, 409);
      }
      throw error;
    }
    if (!created) return c.json({ error: 'Failed to store the EDR connection' }, 500);

    let syncJobId: string | null = null;
    let syncWarning: string | null = null;
    try {
      syncJobId = await runOutsideDbContext(() => enqueueEdrSync(connectionId, 'inventory'));
    } catch (error) {
      console.error('[edrProvider] failed to queue the first sync:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      syncWarning = 'Initial sync could not be queued. Data will sync on the next scheduled cycle.';
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.create',
      resourceType: 'edr_connection',
      resourceId: connectionId,
      resourceName: body.name,
      details: { provider: adapter.key, partnerId: gate.partnerId, tenantCount: test.tenantCount },
    });

    return c.json({
      data: created,
      tenantCount: test.tenantCount,
      capabilityNotes: test.capabilityNotes,
      syncJobId,
      ...(syncWarning ? { syncWarning } : {}),
    }, 201);
  },
);

// PATCH /edr/connections/:id  (self-managed — may re-test)
edrConnectionRoutes.patch(
  '/connections/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', patchConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await withAuthDbAccessContext(auth, () => loadSecretRow(id, gate.partnerId));
    if (!existing) return c.json({ error: 'EDR connection not found' }, 404);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.detectionIntervalMinutes !== undefined) updates.detectionIntervalMinutes = body.detectionIntervalMinutes;
    if (body.inventoryIntervalMinutes !== undefined) updates.inventoryIntervalMinutes = body.inventoryIntervalMinutes;

    const retest = body.credentials !== undefined || body.baseUrl !== undefined;
    if (retest) {
      let adapter: EdrProviderAdapter;
      try {
        adapter = getEdrProvider(existing.provider);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Unknown EDR provider' }, 400);
      }

      let creds: unknown;
      if (body.credentials !== undefined) {
        const parsed = adapter.credentialsSchema.safeParse(body.credentials);
        if (!parsed.success) return c.json({ error: `Invalid ${adapter.label} credentials` }, 400);
        creds = parsed.data;
      } else {
        try {
          creds = decryptEdrSecret('connection_credentials', existing.id, existing.credentialsEncrypted);
        } catch {
          return c.json({ error: 'Stored credentials could not be read' }, 409);
        }
      }

      const baseUrl = body.baseUrl ?? existing.baseUrl;
      const urlError = checkBaseUrl(adapter, baseUrl);
      if (urlError) return c.json({ error: urlError }, 400);

      const test = await adapter.testConnection(
        buildEdrAdapterContext(adapter, { creds, baseUrl, region: existing.region, vendorRootId: existing.vendorRootId }),
      );
      if (!test.ok) {
        // The stored credential is untouched — a failed rotation must never
        // leave the connection with no working credential at all.
        return c.json({ success: false, error: test.error, reauth: test.reauth }, 422);
      }

      if (body.credentials !== undefined) {
        // Re-sealed under the EXISTING row id: the AAD is bound to it.
        updates.credentialsEncrypted = encryptEdrSecret('connection_credentials', existing.id, creds);
      }
      if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
      updates.vendorRootId = test.rootId;
      updates.vendorRootName = test.rootName;
      updates.vendorRootType = test.rootType;
      updates.capabilitiesSnapshot = capabilitySnapshot(adapter, test.capabilityNotes);
      // A successful re-test is the ONLY thing that clears reauth_required.
      updates.status = 'connected';
      updates.lastInventorySyncError = null;
      updates.lastDetectionSyncError = null;
    }

    let updated;
    try {
      // Nested transaction = SAVEPOINT inside the short auth context.
      updated = await withAuthDbAccessContext(auth, () => db.transaction(async (tx) => {
        const [row] = await tx
          .update(edrConnections)
          .set(updates)
          .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, gate.partnerId)))
          .returning({ id: edrConnections.id });
        if (!row) return null;
        return loadConnection(id, gate.partnerId);
      }));
    } catch (error) {
      if (pgErrorCode(error) === '23505') {
        return c.json({
          error: `A connection named "${body.name}" already exists for this provider.`,
          code: 'DUPLICATE_CONNECTION_NAME',
        }, 409);
      }
      throw error;
    }
    if (!updated) return c.json({ error: 'EDR connection not found' }, 404);

    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.update',
      resourceType: 'edr_connection',
      resourceId: id,
      details: {
        partnerId: gate.partnerId,
        fields: Object.keys(body),
        credentialsRotated: body.credentials !== undefined,
      },
    });

    return c.json({ data: updated });
  },
);

// POST /edr/connections/:id/test  (self-managed)
edrConnectionRoutes.post(
  '/connections/:id/test',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await withAuthDbAccessContext(auth, () => loadSecretRow(id, gate.partnerId));
    if (!existing) return c.json({ error: 'EDR connection not found' }, 404);

    let adapter: EdrProviderAdapter;
    try {
      adapter = getEdrProvider(existing.provider);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown EDR provider' }, 400);
    }

    let creds: unknown;
    try {
      creds = decryptEdrSecret('connection_credentials', existing.id, existing.credentialsEncrypted);
    } catch {
      return c.json({ success: false, error: 'Stored credentials could not be read' }, 200);
    }

    const result = await adapter.testConnection(
      buildEdrAdapterContext(adapter, {
        creds, baseUrl: existing.baseUrl, region: existing.region, vendorRootId: existing.vendorRootId,
      }),
    );

    // Only a REAUTH failure changes `status`; a transient failure persists nothing.
    if (result.ok || result.reauth) {
      await withAuthDbAccessContext(auth, async () => {
        await db
          .update(edrConnections)
          .set(result.ok
            ? {
              status: 'connected',
              vendorRootId: result.rootId,
              vendorRootName: result.rootName,
              vendorRootType: result.rootType,
              capabilitiesSnapshot: capabilitySnapshot(adapter, result.capabilityNotes),
              updatedAt: new Date(),
            }
            : { status: 'reauth_required', updatedAt: new Date() })
          .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, gate.partnerId)));
      }).catch((error) => {
        console.error('[edrProvider] failed to persist a connection test outcome:', error);
      });
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.test',
      resourceType: 'edr_connection',
      resourceId: id,
      details: { partnerId: gate.partnerId, success: result.ok },
      result: result.ok ? 'success' : 'failure',
    });

    if (!result.ok) {
      return c.json({ success: false, error: result.error, reauth: result.reauth });
    }
    return c.json({
      success: true,
      message: `Connected to ${result.rootName}`,
      rootName: result.rootName,
      tenantCount: result.tenantCount,
      capabilityNotes: result.capabilityNotes,
    });
  },
);

// POST /edr/connections/:id/sync  (no outbound call — ambient tx)
edrConnectionRoutes.post(
  '/connections/:id/sync',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = requireEdrPartnerAdmin(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await loadConnection(id, gate.partnerId);
    if (!existing) return c.json({ error: 'EDR connection not found' }, 404);
    if (existing.isActive === false) {
      return c.json({ error: 'This connection is disabled. Re-enable it before syncing.' }, 409);
    }
    // A reauth_required connection is DELIBERATELY allowed: "Sync now" is how it is retried.

    let syncJobIds: string[];
    try {
      syncJobIds = await enqueueBoth(id);
    } catch (error) {
      console.error('[edrProvider] failed to queue a manual sync:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      return c.json({ success: false, error: 'Could not queue the sync. Try again shortly.' }, 503);
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.sync',
      resourceType: 'edr_connection',
      resourceId: id,
      details: { partnerId: gate.partnerId, syncJobIds },
    });

    return c.json({ success: true, syncJobIds }, 202);
  },
);

// DELETE /edr/connections/:id — the only hard-delete path (D13).
edrConnectionRoutes.delete(
  '/connections/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const confirm = c.req.query('confirm');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await loadConnection(id, gate.partnerId);
    if (!existing) return c.json({ error: 'EDR connection not found' }, 404);

    const [detRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(edrDetections)
      .where(and(
        eq(edrDetections.connectionId, id),
        isNull(edrDetections.detachedAt),
        sql`${edrDetections.status} IN (${sql.join(OPEN_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
      ));
    const [endRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(edrEndpoints)
      .where(eq(edrEndpoints.connectionId, id));
    const [tenRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(edrTenants)
      .where(eq(edrTenants.connectionId, id));
    const detections = Number(detRow?.n ?? 0);
    const endpoints = Number(endRow?.n ?? 0);
    const tenants = Number(tenRow?.n ?? 0);

    // Deleting cascades tenants, endpoints, detections (incl. tombstoned history) and actions.
    if (confirm !== `${detections}:${endpoints}`) {
      return c.json({
        error: 'Deleting this connection permanently removes its synced data. Confirm the counts to proceed.',
        code: 'CONFIRM_COUNTS',
        detections,
        endpoints,
        tenants,
      }, 409);
    }

    await db
      .delete(edrConnections)
      .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, gate.partnerId)));

    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.delete',
      resourceType: 'edr_connection',
      resourceId: id,
      resourceName: String(existing.name ?? ''),
      details: { partnerId: gate.partnerId, openDetections: detections, endpoints, tenants },
    });

    return c.json({ success: true, deleted: { detections, endpoints, tenants } });
  },
);
