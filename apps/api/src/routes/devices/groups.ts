import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, asc, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceGroups, deviceGroupMemberships, sites } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, hasPermission, type UserPermissions } from '../../services/permissions';
import { getPagination, ensureOrgAccess } from './helpers';
import { PG_UUID_REGEX } from '../../utils/uuid';
import { createGroupSchema, updateGroupSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { pruneGroupMembershipsOutsideSite } from '../../services/groupMembership';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { deleteDeviceGroup, DeviceGroupDeleteError } from '../../services/deviceGroupDelete';

export const groupsRoutes = new Hono();

groupsRoutes.use('*', authMiddleware);

function groupSiteAllowed(group: { siteId: string | null }, perms: UserPermissions | undefined): boolean {
  if (!perms?.allowedSiteIds) return true;
  return typeof group.siteId === 'string' && canAccessSite(perms, group.siteId);
}

/**
 * Resolve a group by its `:id` path param.
 *
 * `device_groups.id` is uuid-typed, so a malformed `:id` reaches Postgres as a
 * 22P02 and surfaces through the global error handler as a 500 (plus a Sentry
 * event) instead of a 404 — the same defect class #2968 fixed for `devices.id`,
 * on the sibling table. Returning `null` puts it on the not-found path all four
 * `:id` handlers already translate to 404.
 */
async function getGroupById(groupId: string) {
  if (!PG_UUID_REGEX.test(groupId)) {
    return null;
  }

  const [group] = await db
    .select()
    .from(deviceGroups)
    .where(eq(deviceGroups.id, groupId))
    .limit(1);

  return group ?? null;
}

// GET /devices/groups - List device groups
groupsRoutes.get(
  '/groups',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, page = '1', limit = '50' } = c.req.query();
    const pagination = getPagination({ page, limit });
    const perms = c.get('permissions') as UserPermissions | undefined;

    if (!orgId) {
      return c.json({ error: 'orgId query parameter required' }, 400);
    }

    const hasAccess = await ensureOrgAccess(orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    if (perms?.allowedSiteIds && perms.allowedSiteIds.length === 0) {
      return c.json({ data: [], pagination: { page: pagination.page, limit: pagination.limit, total: 0 } });
    }
    const conditions: SQL[] = [eq(deviceGroups.orgId, orgId)];
    if (perms?.allowedSiteIds) conditions.push(inArray(deviceGroups.siteId, perms.allowedSiteIds));
    const whereCondition = and(...conditions);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceGroups)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const groups = await db
      .select()
      .from(deviceGroups)
      .where(whereCondition)
      .orderBy(asc(deviceGroups.name), asc(deviceGroups.id))
      .limit(pagination.limit)
      .offset(pagination.offset);

    // Site-restricted callers are narrowed in SQL so denied and org-wide groups
    // do not affect either the page contents or total count.
    return c.json({
      data: groups,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total
      }
    });
  }
);

// POST /devices/groups - Create device group
groupsRoutes.post(
  '/groups',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', createGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');
    const perms = c.get('permissions') as UserPermissions | undefined;

    const hasAccess = await ensureOrgAccess(data.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    if (perms?.allowedSiteIds && (!data.siteId || !canAccessSite(perms, data.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Verify site belongs to org if provided
    if (data.siteId) {
      const [site] = await db
        .select()
        .from(sites)
        .where(
          and(
            eq(sites.id, data.siteId),
            eq(sites.orgId, data.orgId)
          )
        )
        .limit(1);

      if (!site) {
        return c.json({ error: 'Site not found or belongs to different organization' }, 400);
      }
    }

    // Verify parent group exists and belongs to same org
    if (data.parentId) {
      const [parent] = await db
        .select()
        .from(deviceGroups)
        .where(
          and(
            eq(deviceGroups.id, data.parentId),
            eq(deviceGroups.orgId, data.orgId)
          )
        )
        .limit(1);

      if (!parent) {
        return c.json({ error: 'Parent group not found or belongs to different organization' }, 400);
      }
      if (!groupSiteAllowed(parent, perms)) {
        return c.json({ error: 'Access to parent group site denied' }, 403);
      }
    }

    const [group] = await db
      .insert(deviceGroups)
      .values({
        orgId: data.orgId,
        name: data.name,
        siteId: data.siteId,
        type: data.type,
        rules: data.rules,
        parentId: data.parentId
      })
      .returning();

    writeRouteAudit(c, {
      orgId: group?.orgId ?? data.orgId,
      action: 'device_group.create',
      resourceType: 'device_group',
      resourceId: group?.id,
      resourceName: group?.name
    });

    return c.json(group, 201);
  }
);

// PATCH /devices/groups/:id - Update device group
groupsRoutes.patch(
  '/groups/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', updateGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id')!;
    const data = c.req.valid('json');
    const perms = c.get('permissions') as UserPermissions | undefined;

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const group = await getGroupById(groupId);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (!groupSiteAllowed(group, perms)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (data.siteId !== undefined && perms?.allowedSiteIds
      && (data.siteId === null || !canAccessSite(perms, data.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    if (data.siteId) {
      const [site] = await db
        .select()
        .from(sites)
        .where(
          and(
            eq(sites.id, data.siteId),
            eq(sites.orgId, group.orgId)
          )
        )
        .limit(1);

      if (!site) {
        return c.json({ error: 'Site not found or belongs to different organization' }, 400);
      }
    }

    if (data.parentId) {
      if (data.parentId === groupId) {
        return c.json({ error: 'Group cannot be its own parent' }, 400);
      }

      const [parent] = await db
        .select()
        .from(deviceGroups)
        .where(
          and(
            eq(deviceGroups.id, data.parentId),
            eq(deviceGroups.orgId, group.orgId)
          )
        )
        .limit(1);

      if (!parent) {
        return c.json({ error: 'Parent group not found or belongs to different organization' }, 400);
      }
      if (!groupSiteAllowed(parent, perms)) {
        return c.json({ error: 'Access to parent group site denied' }, 403);
      }
    }

    const siteChanged = data.siteId !== undefined && data.siteId !== group.siteId;

    let prunedDeviceIds: string[] = [];
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(deviceGroups)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(deviceGroups.id, groupId))
        .returning();

      if (siteChanged && row?.siteId) {
        const pruned = await pruneGroupMembershipsOutsideSite(
          groupId,
          row.siteId,
          group.orgId,
          tx,
          { deferPeripheralReconciliation: true },
        );
        prunedDeviceIds = pruned.deviceIds ?? [];
      }

      return row;
    });

    await Promise.all(prunedDeviceIds.map((deviceId) =>
      schedulePeripheralPolicyDevice(deviceId, 'dynamic_membership_changed').catch((error) => {
        console.error(`[deviceGroups] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      })
    ));

    writeRouteAudit(c, {
      orgId: group.orgId,
      action: 'device_group.update',
      resourceType: 'device_group',
      resourceId: updated?.id ?? groupId,
      resourceName: updated?.name ?? group.name,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(updated);
  }
);

// DELETE /devices/groups/:id - Delete device group
groupsRoutes.delete(
  '/groups/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id')!;

    const group = await getGroupById(groupId);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (!groupSiteAllowed(group, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    let result: Awaited<ReturnType<typeof deleteDeviceGroup>>;
    try {
      result = await deleteDeviceGroup(groupId, group.orgId);
    } catch (err) {
      if (err instanceof DeviceGroupDeleteError) {
        if (err.code === 'NOT_FOUND') return c.json({ error: 'Group not found' }, 404);
        if (err.code === 'HAS_CHILDREN') return c.json({ error: 'Cannot delete group with child groups' }, 400);
        // Contract and quote names/numbers are billing data — disclose each
        // list only to a caller with that domain's read permission.
        const perms = c.get('permissions') as UserPermissions | undefined;
        const canReadContracts = !!perms && hasPermission(perms, PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
        const canReadQuotes = !!perms && hasPermission(perms, PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
        return c.json({
          error: err.message,
          code: err.code === 'QUOTED_BY_QUOTES' ? 'GROUP_IN_USE_BY_QUOTES' : 'GROUP_IN_USE_BY_CONTRACTS',
          ...(err.contractCount ? { contractCount: err.contractCount } : {}),
          ...(err.quoteCount ? { quoteCount: err.quoteCount } : {}),
          ...(canReadContracts && err.contracts ? { contracts: err.contracts } : {}),
          ...(canReadQuotes && err.quotes ? { quotes: err.quotes } : {}),
        }, 409);
      }
      throw err;
    }

    await Promise.all(result.affectedDeviceIds.map((deviceId) =>
      schedulePeripheralPolicyDevice(deviceId, 'group_deleted').catch((error) => {
        console.error(`[deviceGroups] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      })
    ));

    writeRouteAudit(c, {
      orgId: group.orgId,
      action: 'device_group.delete',
      resourceType: 'device_group',
      resourceId: group.id,
      resourceName: group.name
    });

    return c.json({ success: true });
  }
);

// POST /devices/groups/:id/members - Add devices to group
groupsRoutes.post(
  '/groups/:id/members',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id')!;
    const { deviceIds } = await c.req.json<{ deviceIds: string[] }>();

    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return c.json({ error: 'deviceIds array required' }, 400);
    }

    const group = await getGroupById(groupId);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (!groupSiteAllowed(group, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Verify all devices belong to the same org and intersect with the
    // caller's allowedSiteIds (if any). Site-restricted users must not be
    // able to add cross-site devices via the group membership endpoint.
    const validDevices = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(
        and(
          inArray(devices.id, deviceIds),
          eq(devices.orgId, group.orgId)
        )
      );

    const uniqueDeviceIds = Array.from(new Set(deviceIds));
    if (validDevices.length !== uniqueDeviceIds.length) {
      return c.json({ error: 'No valid devices found' }, 400);
    }
    const userPerms = c.get('permissions') as UserPermissions | undefined;
    const siteDenied = validDevices.some((device) =>
      (group.siteId !== null && device.siteId !== group.siteId)
      || !groupSiteAllowed({ siteId: device.siteId }, userPerms)
    );
    if (siteDenied) return c.json({ error: 'Access to these device sites denied' }, 403);
    const validDeviceIds = validDevices.map(d => d.id);

    // Insert memberships (ignore duplicates)
    const insertedMemberships = await db
      .insert(deviceGroupMemberships)
      .values(
        validDeviceIds.map(deviceId => ({
          deviceId,
          groupId,
          orgId: group.orgId,
          addedBy: 'manual' as const
        }))
      )
      .onConflictDoNothing()
      .returning({ deviceId: deviceGroupMemberships.deviceId });

    await Promise.all(insertedMemberships.map(({ deviceId }) =>
      schedulePeripheralPolicyDevice(deviceId, 'manual_membership_changed').catch((error) => {
        console.error(`[deviceGroups] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      })
    ));

    writeRouteAudit(c, {
      orgId: group.orgId,
      action: 'device_group.members.add',
      resourceType: 'device_group',
      resourceId: group.id,
      resourceName: group.name,
      details: {
        requestedCount: deviceIds.length,
        addedCount: insertedMemberships.length
      }
    });

    return c.json({
      success: true,
      added: insertedMemberships.length
    });
  }
);

// DELETE /devices/groups/:id/members - Remove devices from group
groupsRoutes.delete(
  '/groups/:id/members',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id')!;
    const { deviceIds } = await c.req.json<{ deviceIds: string[] }>();

    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return c.json({ error: 'deviceIds array required' }, 400);
    }

    const group = await getGroupById(groupId);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (!groupSiteAllowed(group, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    let targetDeviceIds = deviceIds;
    const userPerms = c.get('permissions') as UserPermissions | undefined;
    if (userPerms?.allowedSiteIds || group.siteId !== null) {
      const uniqueDeviceIds = Array.from(new Set(deviceIds));
      const targetDevices = await db
        .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
        .from(devices)
        .where(
          and(
            inArray(devices.id, uniqueDeviceIds),
            eq(devices.orgId, group.orgId),
          )
        );
      const siteDenied = targetDevices.length !== uniqueDeviceIds.length
        || targetDevices.some((device) =>
          (group.siteId !== null && device.siteId !== group.siteId)
          || !groupSiteAllowed({ siteId: device.siteId }, userPerms)
        );
      if (siteDenied) {
        return c.json({ error: 'Access to these device sites denied' }, 403);
      }
      targetDeviceIds = uniqueDeviceIds;
    }

    const removedMemberships = await db
      .delete(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, groupId),
          inArray(deviceGroupMemberships.deviceId, targetDeviceIds)
        )
      )
      .returning({ deviceId: deviceGroupMemberships.deviceId });

    await Promise.all(removedMemberships.map(({ deviceId }) =>
      schedulePeripheralPolicyDevice(deviceId, 'manual_membership_changed').catch((error) => {
        console.error(`[deviceGroups] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      })
    ));

    writeRouteAudit(c, {
      orgId: group.orgId,
      action: 'device_group.members.remove',
      resourceType: 'device_group',
      resourceId: group.id,
      resourceName: group.name,
      details: { requestedCount: deviceIds.length }
    });

    return c.json({ success: true });
  }
);
