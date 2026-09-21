import { Hono } from 'hono';
import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { backupProviderCustomers, backupProviderDevices, devices } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { pgErrorCode } from './providerAccess';

export const backupProviderDeviceRoutes = new Hono();

const listQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  connectionId: z.string().guid().optional(),
  // A malformed value is a 400, never a silently-ignored filter — "show me the
  // unlinked rows" returning every row is how an operator concludes everything
  // is linked.
  linked: z.enum(['true', 'false']).optional(),
});

const rowIdParamSchema = z.object({ id: z.string().guid() });
/** `deviceId` is a required KEY with a nullable VALUE — `{}` must not unlink. */
const linkSchema = z.object({ deviceId: z.string().guid().nullable() });

// ---------------------------------------------------------------------------
// GET /backup/providers/devices
// ---------------------------------------------------------------------------
backupProviderDeviceRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions: SQL[] = [];
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(backupProviderDevices.orgId, query.orgId));
    } else {
      // No orgId = every accessible org (the devices-list pattern). `undefined`
      // for system scope, an equality for one org, an IN list otherwise.
      const scoped = auth.orgCondition(backupProviderDevices.orgId);
      if (scoped) conditions.push(scoped);
    }
    if (query.deviceId) conditions.push(eq(backupProviderDevices.breezeDeviceId, query.deviceId));
    if (query.connectionId) conditions.push(eq(backupProviderDevices.connectionId, query.connectionId));
    if (query.linked === 'true') conditions.push(isNotNull(backupProviderDevices.breezeDeviceId));
    if (query.linked === 'false') conditions.push(isNull(backupProviderDevices.breezeDeviceId));

    const rows = await db
      .select({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        connectionId: backupProviderDevices.connectionId,
        provider: backupProviderDevices.provider,
        customerId: backupProviderDevices.customerId,
        customerName: backupProviderCustomers.vendorCustomerName,
        vendorDeviceId: backupProviderDevices.vendorDeviceId,
        vendorDeviceName: backupProviderDevices.vendorDeviceName,
        computerName: backupProviderDevices.computerName,
        osType: backupProviderDevices.osType,
        accountType: backupProviderDevices.accountType,
        dataSources: backupProviderDevices.dataSources,
        status: backupProviderDevices.status,
        lastSessionAt: backupProviderDevices.lastSessionAt,
        lastSuccessAt: backupProviderDevices.lastSuccessAt,
        selectedBytes: backupProviderDevices.selectedBytes,
        usedBytes: backupProviderDevices.usedBytes,
        errorsCount: backupProviderDevices.errorsCount,
        breezeDeviceId: backupProviderDevices.breezeDeviceId,
        deviceMatchSource: backupProviderDevices.deviceMatchSource,
      })
      .from(backupProviderDevices)
      .leftJoin(backupProviderCustomers, eq(backupProviderDevices.customerId, backupProviderCustomers.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(backupProviderDevices.vendorDeviceName);

    // Health is DERIVED, never stored: W03's read model applies
    // `deriveBackupHealth` over these rows. This endpoint is the raw view (the
    // device-tab card and diagnostics).
    return c.json({ data: rows });
  },
);

// ---------------------------------------------------------------------------
// PUT /backup/providers/devices/:id/link
// ---------------------------------------------------------------------------
backupProviderDeviceRoutes.put(
  '/devices/:id/link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  zValidator('param', rowIdParamSchema),
  zValidator('json', linkSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { deviceId } = c.req.valid('json');

    // RLS already hides another org's provider row, so an empty result here is
    // "not visible to you", which is exactly a 404.
    const [providerRow] = await db
      .select({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        breezeDeviceId: backupProviderDevices.breezeDeviceId,
      })
      .from(backupProviderDevices)
      .where(eq(backupProviderDevices.id, id))
      .limit(1);
    if (!providerRow) return c.json({ error: 'Backup provider device not found' }, 404);

    if (deviceId !== null) {
      // PRE-CHECK, because the composite FK's 23503 would otherwise abort the
      // ambient request transaction and turn the friendly 422 into a raw 500 at
      // COMMIT. The savepointed catch below is the concurrent-writer backstop,
      // not the primary control.
      const [device] = await db
        .select({ id: devices.id, orgId: devices.orgId, hostname: devices.hostname })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!device) return c.json({ error: 'Device not found' }, 404);
      if (device.orgId !== providerRow.orgId) {
        return c.json({
          error: 'That device belongs to a different organization than this provider row',
          code: 'DEVICE_ORG_MISMATCH',
        }, 422);
      }
    }

    try {
      // A nested db.transaction is a SAVEPOINT: a Postgres error raised inside
      // it rolls back only to the savepoint, leaving the ambient request
      // transaction usable so the mapped 4xx actually reaches the client.
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(backupProviderDevices)
          .set({
            breezeDeviceId: deviceId,
            // The provenance column is cleared WITH the link and set WITH it:
            // a row carrying 'manual' but no link would be skipped forever by
            // W02's matcher, which never re-matches a manual link.
            deviceMatchSource: deviceId === null ? null : 'manual',
            updatedAt: new Date(),
          })
          .where(eq(backupProviderDevices.id, id))
          .returning({
            id: backupProviderDevices.id,
            breezeDeviceId: backupProviderDevices.breezeDeviceId,
            deviceMatchSource: backupProviderDevices.deviceMatchSource,
          });
        return row ?? null;
      });
      if (!updated) return c.json({ error: 'Backup provider device not found' }, 404);

      writeRouteAudit(c, {
        orgId: providerRow.orgId,
        action: deviceId ? 'backup_provider.device.link' : 'backup_provider.device.unlink',
        resourceType: 'backup_provider_device',
        resourceId: id,
        details: { deviceId, previousDeviceId: providerRow.breezeDeviceId },
      });

      return c.json({ data: updated });
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === '23503') {
        return c.json({
          error: 'That device belongs to a different organization than this provider row',
          code: 'DEVICE_ORG_MISMATCH',
        }, 422);
      }
      if (code === '23505') {
        // The partial unique index on breeze_device_id: one provider row per
        // Breeze device. Post-acquisition, a device backed up by two
        // connections links to the first.
        return c.json({
          error: 'That device is already linked to another backup provider row',
          code: 'DEVICE_ALREADY_LINKED',
        }, 409);
      }
      throw error;
    }
  },
);
