import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, asc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceGroups, deviceGroupMemberships, sites } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getPagination, ensureOrgAccess } from './helpers';
import { createGroupSchema, updateGroupSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';

export const groupsRoutes = new Hono();

groupsRoutes.use('*', authMiddleware);

// GET /devices/groups - List device groups
groupsRoutes.get(
  '/groups',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, page = '1', limit = '50' } = c.req.query();
    const pagination = getPagination({ page, limit });

    if (!orgId) {
      return c.json({ error: 'orgId query parameter required' }, 400);
    }

    const hasAccess = await ensureOrgAccess(orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceGroups)
      .where(eq(deviceGroups.orgId, orgId));
    const total = Number(countResult[0]?.count ?? 0);

    const groups = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.orgId, orgId))
      .orderBy(asc(deviceGroups.name))
      .limit(pagination.limit)
      .offset(pagination.offset);

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
  zValidator('json', createGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const hasAccess = await ensureOrgAccess(data.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access to this organization denied' }, 403);
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
  zValidator('json', updateGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const [updated] = await db
      .update(deviceGroups)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(deviceGroups.id, groupId))
      .returning();

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
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Delete memberships first
    await db
      .delete(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.groupId, groupId));

    // Delete the group
    await db
      .delete(deviceGroups)
      .where(eq(deviceGroups.id, groupId));

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
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');
    const { deviceIds } = await c.req.json<{ deviceIds: string[] }>();

    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return c.json({ error: 'deviceIds array required' }, 400);
    }

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Verify all devices belong to the same org
    const validDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          inArray(devices.id, deviceIds),
          eq(devices.orgId, group.orgId)
        )
      );

    const validDeviceIds = validDevices.map(d => d.id);

    if (validDeviceIds.length === 0) {
      return c.json({ error: 'No valid devices found' }, 400);
    }

    // Insert memberships (ignore duplicates)
    await db
      .insert(deviceGroupMemberships)
      .values(
        validDeviceIds.map(deviceId => ({
          deviceId,
          groupId,
          addedBy: 'manual' as const
        }))
      )
      .onConflictDoNothing();

    writeRouteAudit(c, {
      orgId: group.orgId,
      action: 'device_group.members.add',
      resourceType: 'device_group',
      resourceId: group.id,
      resourceName: group.name,
      details: {
        requestedCount: deviceIds.length,
        addedCount: validDeviceIds.length
      }
    });

    return c.json({
      success: true,
      added: validDeviceIds.length
    });
  }
);

// DELETE /devices/groups/:id/members - Remove devices from group
groupsRoutes.delete(
  '/groups/:id/members',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');
    const { deviceIds } = await c.req.json<{ deviceIds: string[] }>();

    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return c.json({ error: 'deviceIds array required' }, 400);
    }

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    await db
      .delete(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, groupId),
          inArray(deviceGroupMemberships.deviceId, deviceIds)
        )
      );

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
