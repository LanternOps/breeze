import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { backupProviderConnections, backupProviderCustomers, organizations } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { RemapCustomerError, remapCustomer } from '../../services/backupProviders/mapping';
import { isGateFailure, requireProviderPartnerAdmin, resolveProviderPartnerId } from './providerAccess';

export const backupProviderCustomerRoutes = new Hono();

const connectionIdParamSchema = z.object({ id: z.string().guid() });
const customerIdParamSchema = z.object({ id: z.string().guid() });

/**
 * `orgId` is REQUIRED as a key and nullable as a value. `{}` and
 * `{ orgId: null }` must not mean the same thing: the first is a malformed
 * request, the second a deliberate "leave this customer unmapped", which stamps
 * `manual_unmapped` and is never undone by auto-mapping.
 */
const mappingSchema = z.object({ orgId: z.string().guid().nullable() });

// ---------------------------------------------------------------------------
// GET /backup/providers/connections/:id/customers
// ---------------------------------------------------------------------------
backupProviderCustomerRoutes.get(
  '/connections/:id/customers',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', connectionIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = resolveProviderPartnerId(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const [connection] = await db
      .select({ id: backupProviderConnections.id })
      .from(backupProviderConnections)
      .where(and(
        eq(backupProviderConnections.id, id),
        eq(backupProviderConnections.partnerId, gate.partnerId),
      ))
      .limit(1);
    if (!connection) return c.json({ error: 'Backup provider connection not found' }, 404);

    const rows = await db
      .select({
        id: backupProviderCustomers.id,
        vendorCustomerId: backupProviderCustomers.vendorCustomerId,
        vendorCustomerName: backupProviderCustomers.vendorCustomerName,
        vendorLevel: backupProviderCustomers.vendorLevel,
        vendorExternalCode: backupProviderCustomers.vendorExternalCode,
        orgId: backupProviderCustomers.orgId,
        orgName: organizations.name,
        mappingSource: backupProviderCustomers.mappingSource,
        deviceCount: backupProviderCustomers.deviceCount,
        lastSeenAt: backupProviderCustomers.lastSeenAt,
      })
      .from(backupProviderCustomers)
      .leftJoin(organizations, eq(backupProviderCustomers.orgId, organizations.id))
      .where(eq(backupProviderCustomers.connectionId, id))
      .orderBy(backupProviderCustomers.vendorCustomerName);

    // The unmapped summary is load-bearing, not decoration: devices under an
    // unmapped customer are NOT stored (spec D8), so without this a
    // partner-wide view silently implies complete vendor coverage.
    const unmapped = rows.filter((row) => row.orgId === null);
    return c.json({
      data: rows,
      summary: {
        customers: rows.length,
        unmappedCustomers: unmapped.length,
        unmappedDeviceCount: unmapped.reduce((sum, row) => sum + (row.deviceCount ?? 0), 0),
      },
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /backup/providers/customers/:id/mapping
// ---------------------------------------------------------------------------
backupProviderCustomerRoutes.put(
  '/customers/:id/mapping',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', customerIdParamSchema),
  zValidator('json', mappingSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { orgId } = c.req.valid('json');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    try {
      // Atomic: resolve the customer's alerts, delete its device + ledger rows,
      // update the mapping, enqueue a sync. Nothing stays visible to the old
      // org until the next poll.
      const result = await remapCustomer(id, orgId, {
        userId: auth.user?.id ?? null,
        partnerId: gate.partnerId,
      });

      writeRouteAudit(c, {
        orgId,
        action: orgId ? 'backup_provider.customer.map' : 'backup_provider.customer.unmap',
        resourceType: 'backup_provider_customer',
        resourceId: id,
        details: {
          partnerId: gate.partnerId,
          connectionId: result.connectionId,
          mappingSource: result.mappingSource,
          deletedDevices: result.deletedDevices,
          resolvedAlerts: result.resolvedAlerts,
        },
      });

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof RemapCustomerError) {
        return c.json({ error: error.message }, error.code === 'NOT_FOUND' ? 404 : 422);
      }
      throw error;
    }
  },
);
