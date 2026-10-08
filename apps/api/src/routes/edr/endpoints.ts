import { Hono } from 'hono';
import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { devices, edrDetections, edrEndpoints, edrTenants } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { pgErrorCode } from './access';

export const edrEndpointRoutes = new Hono();

const OPEN_STATUSES = ['open', 'in_progress', 'unknown'] as const;

const listQuerySchema = z.object({
  connectionId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  // A malformed value is a 400, never a silently-ignored filter.
  state: z.enum(['unlinked', 'ambiguous', 'linked', 'all']).default('all'),
});

const rowIdParamSchema = z.object({ id: z.string().guid() });
/** `deviceId` is a required KEY with a nullable VALUE — `{}` must not unlink. */
const linkSchema = z.object({ deviceId: z.string().guid().nullable() });

// GET /edr/endpoints?connectionId&state=unlinked|ambiguous|linked|all
// Org OR partner scope: the rows are org-scoped (shape 1), RLS narrows them.
edrEndpointRoutes.get(
  '/endpoints',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');

    const conditions: SQL[] = [];
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(edrEndpoints.orgId, query.orgId));
    } else {
      const scoped = auth.orgCondition(edrEndpoints.orgId);
      if (scoped) conditions.push(scoped);
    }
    if (query.connectionId) conditions.push(eq(edrEndpoints.connectionId, query.connectionId));

    if (query.state === 'linked') conditions.push(isNotNull(edrEndpoints.breezeDeviceId));
    if (query.state === 'unlinked' || query.state === 'ambiguous') {
      conditions.push(isNull(edrEndpoints.breezeDeviceId));
    }
    if (query.state === 'ambiguous') {
      // Ambiguity is not stored: it is "unlinked, and more than one device in
      // the org carries this hostname" — the case the matcher refused to guess.
      conditions.push(sql`${edrEndpoints.hostname} IS NOT NULL AND (
        SELECT count(*) FROM devices d
        WHERE d.org_id = ${edrEndpoints.orgId} AND lower(d.hostname) = lower(${edrEndpoints.hostname})
      ) > 1`);
    }

    // Site ceiling: a site-restricted caller must not see a row linked to a
    // device outside their allowed sites. Unlinked rows carry no site.
    const allowed = perms?.allowedSiteIds;
    if (Array.isArray(allowed)) {
      conditions.push(
        allowed.length > 0
          ? sql`(${edrEndpoints.breezeDeviceId} IS NULL OR ${edrEndpoints.breezeDeviceId} IN (
              SELECT d.id FROM devices d WHERE d.site_id IN (${sql.join(allowed.map((s) => sql`${s}::uuid`), sql`, `)})
            ))`
          : isNull(edrEndpoints.breezeDeviceId),
      );
    }

    const rows = await db
      .select({
        id: edrEndpoints.id,
        orgId: edrEndpoints.orgId,
        connectionId: edrEndpoints.connectionId,
        tenantId: edrEndpoints.tenantId,
        tenantName: edrTenants.vendorTenantName,
        provider: edrEndpoints.provider,
        vendorEndpointId: edrEndpoints.vendorEndpointId,
        hostname: edrEndpoints.hostname,
        fqdn: edrEndpoints.fqdn,
        osPlatform: edrEndpoints.osPlatform,
        osName: edrEndpoints.osName,
        agentVersion: edrEndpoints.agentVersion,
        health: edrEndpoints.health,
        online: edrEndpoints.online,
        isolationState: edrEndpoints.isolationState,
        lastSeenAt: edrEndpoints.lastSeenAt,
        breezeDeviceId: edrEndpoints.breezeDeviceId,
        deviceMatchSource: edrEndpoints.deviceMatchSource,
      })
      .from(edrEndpoints)
      .leftJoin(edrTenants, eq(edrEndpoints.tenantId, edrTenants.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(edrEndpoints.hostname);

    return c.json({ data: rows });
  },
);

// PUT /edr/endpoints/:id/link
edrEndpointRoutes.put(
  '/endpoints/:id/link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('param', rowIdParamSchema),
  zValidator('json', linkSchema),
  async (c) => {
    const perms = c.get('permissions') as UserPermissions | undefined;
    const { id } = c.req.valid('param');
    const { deviceId } = c.req.valid('json');

    // RLS hides another org's row, so empty == "not visible to you" == 404.
    const [row] = await db
      .select({
        id: edrEndpoints.id,
        orgId: edrEndpoints.orgId,
        connectionId: edrEndpoints.connectionId,
        breezeDeviceId: edrEndpoints.breezeDeviceId,
      })
      .from(edrEndpoints)
      .where(eq(edrEndpoints.id, id))
      .limit(1);
    if (!row) return c.json({ error: 'EDR endpoint not found' }, 404);

    // Site ceiling on the PREVIOUS device: a site-restricted caller must not
    // unlink, or move the link away from, a device outside their sites.
    if (row.breezeDeviceId) {
      const [previous] = await db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.id, row.breezeDeviceId))
        .limit(1);
      // Fail closed: unresolved `permissions` refuses a site-carrying device.
      if (previous?.siteId && (!perms || !canAccessSite(perms, previous.siteId))) {
        return c.json({ error: 'Access to this device site denied' }, 403);
      }
    }

    if (deviceId !== null) {
      // PRE-CHECK: the composite FK's 23503 would otherwise abort the ambient
      // request transaction. The savepointed catch below is only the backstop.
      const [device] = await db
        .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!device) return c.json({ error: 'Device not found' }, 404);
      if (device.orgId !== row.orgId) {
        return c.json({
          error: 'That device belongs to a different organization than this EDR endpoint',
          code: 'DEVICE_ORG_MISMATCH',
        }, 422);
      }
      if (device.siteId && (!perms || !canAccessSite(perms, device.siteId))) {
        return c.json({ error: 'Access to this device site denied' }, 403);
      }
    }

    try {
      // Nested db.transaction = SAVEPOINT: a Postgres error rolls back only to
      // here, so the mapped 4xx reaches the client.
      const updated = await db.transaction(async (tx) => {
        const [endpoint] = await tx
          .update(edrEndpoints)
          .set({
            breezeDeviceId: deviceId,
            // Cleared WITH the link, set WITH it: a 'manual' source without a
            // link would be skipped by the matcher forever.
            deviceMatchSource: deviceId === null ? null : 'manual',
            updatedAt: new Date(),
          })
          .where(eq(edrEndpoints.id, id))
          .returning({
            id: edrEndpoints.id,
            breezeDeviceId: edrEndpoints.breezeDeviceId,
            deviceMatchSource: edrEndpoints.deviceMatchSource,
          });
        if (!endpoint) return null;

        // Spec 4.2: the detection feed's site predicate reads the denormalized
        // device on the detection, so OPEN, non-detached detections follow the
        // link in the same transaction (closed history keeps what it had).
        await tx
          .update(edrDetections)
          .set({ breezeDeviceId: deviceId, updatedAt: new Date() })
          .where(and(
            eq(edrDetections.endpointId, id),
            isNull(edrDetections.detachedAt),
            sql`${edrDetections.status} IN (${sql.join(OPEN_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
          ));
        return endpoint;
      });
      if (!updated) return c.json({ error: 'EDR endpoint not found' }, 404);

      writeRouteAudit(c, {
        orgId: row.orgId,
        action: deviceId ? 'edr.endpoint.link' : 'edr.endpoint.unlink',
        resourceType: 'edr_endpoint',
        resourceId: id,
        details: { deviceId, previousDeviceId: row.breezeDeviceId, connectionId: row.connectionId },
      });

      return c.json({ data: updated });
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === '23503') {
        return c.json({
          error: 'That device belongs to a different organization than this EDR endpoint',
          code: 'DEVICE_ORG_MISMATCH',
        }, 422);
      }
      if (code === '23505') {
        // Partial unique index (connection_id, breeze_device_id): one endpoint
        // per device per connection.
        return c.json({
          error: 'That device is already linked to another endpoint of this connection',
          code: 'DEVICE_ALREADY_LINKED',
        }, 409);
      }
      throw error;
    }
  },
);
