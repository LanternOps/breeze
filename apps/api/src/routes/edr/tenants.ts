import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext } from '../../db';
import { edrConnections, edrTenants, organizations } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { listNameSuggestions, RemapEdrTenantError, remapEdrTenant } from '../../services/edrProviders/mapping';
import { enqueueEdrSync } from '../../jobs/edrProviderSync';
import {
  EDR_TENANT_PUBLIC_SELECT,
  isGateFailure,
  requireEdrPartnerAdmin,
  resolveEdrPartnerId,
} from './access';

export const edrTenantRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().guid() });

/**
 * `orgId` is REQUIRED as a key and nullable as a value: `{}` is malformed,
 * `{ orgId: null }` is a deliberate "leave this tenant unmapped" that stamps
 * `manual_unmapped` and is never undone by auto-mapping.
 */
const mappingSchema = z.object({ orgId: z.string().guid().nullable() });

// GET /edr/connections/:id/tenants
edrTenantRoutes.get(
  '/connections/:id/tenants',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = resolveEdrPartnerId(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const [connection] = await db
      .select({ id: edrConnections.id })
      .from(edrConnections)
      .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, gate.partnerId)))
      .limit(1);
    if (!connection) return c.json({ error: 'EDR connection not found' }, 404);

    const rows = await db
      .select({ ...EDR_TENANT_PUBLIC_SELECT, orgName: organizations.name })
      .from(edrTenants)
      .leftJoin(organizations, eq(edrTenants.orgId, organizations.id))
      .where(and(eq(edrTenants.connectionId, id), eq(edrTenants.partnerId, gate.partnerId)))
      .orderBy(edrTenants.vendorTenantName);

    const suggestions = await listNameSuggestions(db, id);

    // Endpoints of an unmapped tenant are counted, never stored (D5): without
    // this summary a partner-wide view silently implies complete coverage.
    const unmapped = rows.filter((r) => r.orgId === null && r.vendorMissingSince === null);
    return c.json({
      data: rows,
      suggestions,
      summary: {
        tenants: rows.length,
        unmappedTenants: unmapped.length,
        unmappedEndpointCount: unmapped.reduce((sum, r) => sum + (r.endpointCount ?? 0), 0),
      },
    });
  },
);

// PUT /edr/tenants/:id/mapping
edrTenantRoutes.put(
  '/tenants/:id/mapping',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', mappingSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { orgId } = c.req.valid('json');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const [tenant] = await db
      .select({ connectionId: edrTenants.connectionId })
      .from(edrTenants)
      .where(and(eq(edrTenants.id, id), eq(edrTenants.partnerId, gate.partnerId)))
      .limit(1);
    if (!tenant) return c.json({ error: 'EDR tenant not found' }, 404);

    let result;
    try {
      // A nested db.transaction is a SAVEPOINT inside the request transaction, so
      // a RemapEdrTenantError rolls back only the remap. The advisory lock is the
      // one sync Phase 3 takes: the remap serializes with an in-flight sync and
      // is released when the request transaction commits.
      result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('edr-provider-sync'), hashtext(${tenant.connectionId}))`,
        );
        return remapEdrTenant(
          tx,
          { partnerId: gate.partnerId, userId: auth.user?.id ?? null },
          id,
          orgId,
        );
      });
    } catch (error) {
      if (error instanceof RemapEdrTenantError) {
        return c.json({ error: error.message, code: error.code }, error.code === 'NOT_FOUND' ? 404 : 422);
      }
      throw error;
    }

    writeRouteAudit(c, {
      orgId: result.orgId ?? result.previousOrgId,
      action: result.orgId ? 'edr.tenant.map' : 'edr.tenant.unmap',
      resourceType: 'edr_tenant',
      resourceId: id,
      details: {
        partnerId: gate.partnerId,
        connectionId: tenant.connectionId,
        previousOrgId: result.previousOrgId,
        orgId: result.orgId,
        endpointsDeleted: result.endpointsDeleted,
        detectionsDetached: result.detectionsDetached,
        actionsDetached: result.actionsDetached,
      },
    });

    // After the remap, outside every DB context. A queue failure must not undo a
    // committed-looking mapping; the next scheduled cycle picks it up.
    let syncWarning: string | null = null;
    try {
      await runOutsideDbContext(async () => {
        await enqueueEdrSync(tenant.connectionId, 'inventory');
        await enqueueEdrSync(tenant.connectionId, 'detections');
      });
    } catch (error) {
      console.error('[edrProvider] failed to queue a sync after a tenant remap:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      syncWarning = 'Sync could not be queued. Data will refresh on the next scheduled cycle.';
    }

    return c.json({ data: result, ...(syncWarning ? { syncWarning } : {}) });
  },
);
