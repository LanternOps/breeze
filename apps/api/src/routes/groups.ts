import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroups, deviceGroupMemberships, devices, organizations, groupMembershipLog } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { evaluateFilterWithPreview, extractFieldsFromFilter, validateFilter } from '../services/filterEngine';
import { evaluateGroupMembership, pinDeviceToGroup } from '../services/groupMembership';
import type { FilterConditionGroup } from '../services/filterEngine';

export const groupRoutes = new Hono();

type DeviceGroup = {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string;
  type: 'static' | 'dynamic';
  rules: unknown;
  filterConditions: FilterConditionGroup | null;
  filterFieldsUsed: string[];
  parentId: string | null;
  deviceCount: number;
  createdAt: string;
  updatedAt: string;
};

type GroupMembership = {
  deviceId: string;
  groupId: string;
  isPinned: boolean;
  addedAt: string;
  addedBy: 'manual' | 'dynamic_rule' | 'policy';
};

// Helper to validate filter condition groups
// Using a more permissive schema since deep validation is done by validateFilter
const filterConditionSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.any()
});

const filterConditionGroupSchema: z.ZodType<FilterConditionGroup> = z.lazy(() =>
  z.object({
    operator: z.enum(['AND', 'OR']),
    conditions: z.array(z.union([filterConditionSchema, filterConditionGroupSchema]))
  })
) as z.ZodType<FilterConditionGroup>;

const listGroupsQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  type: z.enum(['static', 'dynamic']).optional(),
  parentId: z.string().uuid().optional(),
  search: z.string().optional()
});

const createGroupSchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['static', 'dynamic']).default('static'),
  rules: z.any().optional(),
  filterConditions: filterConditionGroupSchema.optional(),
  parentId: z.string().uuid().optional()
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  siteId: z.string().uuid().nullable().optional(),
  type: z.enum(['static', 'dynamic']).optional(),
  rules: z.any().optional(),
  filterConditions: filterConditionGroupSchema.nullable().optional(),
  parentId: z.string().uuid().nullable().optional()
});

const addDevicesSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1)
});

const groupIdParamSchema = z.object({
  id: z.string().uuid()
});

const deviceIdParamSchema = z.object({
  id: z.string().uuid(),
  deviceId: z.string().uuid()
});

groupRoutes.use('*', authMiddleware);

async function ensureOrgAccess(
  orgId: string,
  auth: { scope: string; partnerId: string | null; orgId: string | null }
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, auth.partnerId as string)))
      .limit(1);

    return Boolean(org);
  }

  return true;
}

async function getOrgIdsForAuth(
  auth: { scope: string; partnerId: string | null; orgId: string | null }
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId as string));
    return partnerOrgs.map((org) => org.id);
  }

  return null;
}

async function getGroupWithAccess(
  groupId: string,
  auth: { scope: string; partnerId: string | null; orgId: string | null }
) {
  const [group] = await db
    .select()
    .from(deviceGroups)
    .where(eq(deviceGroups.id, groupId))
    .limit(1);

  if (!group) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(group.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return group;
}

async function getDeviceCountForGroup(groupId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.groupId, groupId));

  return Number(result?.count ?? 0);
}

function mapGroupRow(
  group: typeof deviceGroups.$inferSelect,
  deviceCount: number
): DeviceGroup {
  return {
    id: group.id,
    orgId: group.orgId,
    siteId: group.siteId,
    name: group.name,
    type: group.type,
    rules: group.rules,
    filterConditions: group.filterConditions as FilterConditionGroup | null,
    filterFieldsUsed: group.filterFieldsUsed ?? [],
    parentId: group.parentId,
    deviceCount,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString()
  };
}

// GET / - List groups for the org
groupRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listGroupsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0 });
    }

    const conditions = [] as ReturnType<typeof eq>[];
    if (orgIds) {
      conditions.push(inArray(deviceGroups.orgId, orgIds));
    }
    if (query.siteId) {
      conditions.push(eq(deviceGroups.siteId, query.siteId));
    }
    if (query.type) {
      conditions.push(eq(deviceGroups.type, query.type));
    }
    if (query.parentId) {
      conditions.push(eq(deviceGroups.parentId, query.parentId));
    }

    const whereCondition = conditions.length ? and(...conditions) : undefined;

    const groups = await db
      .select()
      .from(deviceGroups)
      .where(whereCondition)
      .orderBy(desc(deviceGroups.createdAt));

    let results = groups;
    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((group) => group.name.toLowerCase().includes(term));
    }

    // Get device counts for all groups
    const groupIds = results.map((g) => g.id);
    const countRows = groupIds.length
      ? await db
          .select({
            groupId: deviceGroupMemberships.groupId,
            count: sql<number>`count(*)`
          })
          .from(deviceGroupMemberships)
          .where(inArray(deviceGroupMemberships.groupId, groupIds))
          .groupBy(deviceGroupMemberships.groupId)
      : [];

    const countMap = new Map(countRows.map((row) => [row.groupId, Number(row.count)]));

    const data = results.map((group) => mapGroupRow(group, countMap.get(group.id) ?? 0));

    return c.json({ data, total: data.length });
  }
);

// GET /:id - Get single group
groupRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', groupIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const deviceCount = await getDeviceCountForGroup(id);

    return c.json({ data: mapGroupRow(group, deviceCount) });
  }
);

// POST / - Create group
groupRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    let orgId = payload.orgId;
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
      return c.json({ error: 'orgId is required' }, 400);
    }

    // Validate parent group if provided
    if (payload.parentId) {
      const parent = await getGroupWithAccess(payload.parentId, auth);
      if (!parent) {
        return c.json({ error: 'Parent group not found' }, 400);
      }
      if (parent.orgId !== orgId) {
        return c.json({ error: 'Parent group must belong to the same organization' }, 400);
      }
    }

    // Validate filter conditions for dynamic groups
    let filterFieldsUsed: string[] = [];
    if (payload.type === 'dynamic' && payload.filterConditions) {
      const validation = validateFilter(payload.filterConditions);
      if (!validation.valid) {
        return c.json({ error: 'Invalid filter conditions', details: validation.errors }, 400);
      }
      filterFieldsUsed = extractFieldsFromFilter(payload.filterConditions);
    }

    const [group] = await db
      .insert(deviceGroups)
      .values({
        orgId: orgId!,
        siteId: payload.siteId,
        name: payload.name,
        type: payload.type,
        rules: payload.rules,
        filterConditions: payload.filterConditions ?? null,
        filterFieldsUsed,
        parentId: payload.parentId
      })
      .returning();

    if (!group) {
      return c.json({ error: 'Failed to create group' }, 500);
    }

    // If dynamic group with filter, evaluate membership
    if (group.type === 'dynamic' && group.filterConditions) {
      // Run membership evaluation asynchronously (don't block the response)
      evaluateGroupMembership(group.id).catch((err) => {
        console.error(`Failed to evaluate membership for new group ${group.id}:`, err);
      });
    }

    return c.json({ data: mapGroupRow(group, 0) }, 201);
  }
);

// PATCH /:id - Update group
groupRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', groupIdParamSchema),
  zValidator('json', updateGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    // Validate parent group if provided
    if (payload.parentId) {
      if (payload.parentId === id) {
        return c.json({ error: 'Group cannot be its own parent' }, 400);
      }
      const parent = await getGroupWithAccess(payload.parentId, auth);
      if (!parent) {
        return c.json({ error: 'Parent group not found' }, 400);
      }
      if (parent.orgId !== group.orgId) {
        return c.json({ error: 'Parent group must belong to the same organization' }, 400);
      }
    }

    // Determine the effective type (updated or existing)
    const effectiveType = payload.type ?? group.type;

    // Validate filter conditions if provided
    let filterFieldsUsed: string[] | undefined;
    const filterChanged = payload.filterConditions !== undefined;

    if (filterChanged && payload.filterConditions !== null && payload.filterConditions !== undefined) {
      const validation = validateFilter(payload.filterConditions);
      if (!validation.valid) {
        return c.json({ error: 'Invalid filter conditions', details: validation.errors }, 400);
      }
      filterFieldsUsed = extractFieldsFromFilter(payload.filterConditions);
    } else if (filterChanged && payload.filterConditions === null) {
      // Clearing filter conditions
      filterFieldsUsed = [];
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.siteId !== undefined) updates.siteId = payload.siteId;
    if (payload.type !== undefined) updates.type = payload.type;
    if (payload.rules !== undefined) updates.rules = payload.rules;
    if (payload.parentId !== undefined) updates.parentId = payload.parentId;
    if (filterChanged) {
      updates.filterConditions = payload.filterConditions ?? null;
      updates.filterFieldsUsed = filterFieldsUsed;
    }

    const [updated] = await db
      .update(deviceGroups)
      .set(updates)
      .where(eq(deviceGroups.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update group' }, 500);
    }

    // If dynamic group filter changed, re-evaluate membership
    if (effectiveType === 'dynamic' && filterChanged && updated.filterConditions) {
      // Run membership evaluation asynchronously (don't block the response)
      evaluateGroupMembership(updated.id).catch((err) => {
        console.error(`Failed to re-evaluate membership for group ${updated.id}:`, err);
      });
    }

    const deviceCount = await getDeviceCountForGroup(id);

    return c.json({ data: mapGroupRow(updated, deviceCount) });
  }
);

// DELETE /:id - Delete group
groupRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', groupIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    // Check for child groups
    const [childCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceGroups)
      .where(eq(deviceGroups.parentId, id));

    if (Number(childCount?.count ?? 0) > 0) {
      return c.json({ error: 'Cannot delete group with child groups' }, 400);
    }

    // Delete memberships first
    await db.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, id));

    // Delete the group
    await db.delete(deviceGroups).where(eq(deviceGroups.id, id));

    return c.json({ data: mapGroupRow(group, 0) });
  }
);

// GET /:id/devices - List devices in a group
groupRoutes.get(
  '/:id/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', groupIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const memberships = await db
      .select({
        deviceId: deviceGroupMemberships.deviceId,
        isPinned: deviceGroupMemberships.isPinned,
        addedAt: deviceGroupMemberships.addedAt,
        addedBy: deviceGroupMemberships.addedBy,
        hostname: devices.hostname,
        displayName: devices.displayName,
        status: devices.status,
        osType: devices.osType
      })
      .from(deviceGroupMemberships)
      .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
      .where(eq(deviceGroupMemberships.groupId, id))
      .orderBy(desc(deviceGroupMemberships.addedAt));

    const data = memberships.map((m) => ({
      deviceId: m.deviceId,
      hostname: m.hostname,
      displayName: m.displayName,
      status: m.status,
      osType: m.osType,
      isPinned: m.isPinned,
      addedAt: m.addedAt.toISOString(),
      addedBy: m.addedBy
    }));

    return c.json({ data, total: data.length });
  }
);

// POST /:id/devices - Add devices to group
groupRoutes.post(
  '/:id/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', groupIdParamSchema),
  zValidator('json', addDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (group.type === 'dynamic') {
      return c.json({ error: 'Cannot manually add devices to a dynamic group' }, 400);
    }

    // Verify all devices exist and belong to the same org
    const deviceRows = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(inArray(devices.id, payload.deviceIds));

    const deviceMap = new Map(deviceRows.map((d) => [d.id, d]));
    const invalidDevices = payload.deviceIds.filter((deviceId) => {
      const device = deviceMap.get(deviceId);
      return !device || device.orgId !== group.orgId;
    });

    if (invalidDevices.length > 0) {
      return c.json({
        error: 'Some devices are invalid or belong to a different organization',
        invalidDevices
      }, 400);
    }

    // Get existing memberships to avoid duplicates
    const existingMemberships = await db
      .select({ deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, id),
          inArray(deviceGroupMemberships.deviceId, payload.deviceIds)
        )
      );

    const existingSet = new Set(existingMemberships.map((m) => m.deviceId));
    const newDeviceIds = payload.deviceIds.filter((deviceId) => !existingSet.has(deviceId));

    if (newDeviceIds.length > 0) {
      await db.insert(deviceGroupMemberships).values(
        newDeviceIds.map((deviceId) => ({
          deviceId,
          groupId: id,
          addedBy: 'manual' as const
        }))
      );
    }

    const deviceCount = await getDeviceCountForGroup(id);

    return c.json({
      data: {
        added: newDeviceIds.length,
        skipped: existingMemberships.length,
        total: deviceCount
      }
    }, 201);
  }
);

// DELETE /:id/devices/:deviceId - Remove device from group
groupRoutes.delete(
  '/:id/devices/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, deviceId } = c.req.valid('param');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (group.type === 'dynamic') {
      return c.json({ error: 'Cannot manually remove devices from a dynamic group' }, 400);
    }

    const [membership] = await db
      .select()
      .from(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, id),
          eq(deviceGroupMemberships.deviceId, deviceId)
        )
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: 'Device is not a member of this group' }, 404);
    }

    await db
      .delete(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, id),
          eq(deviceGroupMemberships.deviceId, deviceId)
        )
      );

    return c.json({ data: { deviceId, groupId: id, removed: true } });
  }
);

// POST /:id/preview - Preview devices matching the group's filter
const previewQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(10)
});

groupRoutes.post(
  '/:id/preview',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', groupIdParamSchema),
  zValidator('query', previewQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (group.type !== 'dynamic') {
      return c.json({ error: 'Preview is only available for dynamic groups' }, 400);
    }

    if (!group.filterConditions) {
      return c.json({ error: 'Group has no filter conditions defined' }, 400);
    }

    const filter = group.filterConditions as FilterConditionGroup;
    const preview = await evaluateFilterWithPreview(filter, {
      orgId: group.orgId,
      previewLimit: limit
    });

    return c.json({
      data: {
        totalCount: preview.totalCount,
        devices: preview.devices.map((d) => ({
          id: d.id,
          hostname: d.hostname,
          displayName: d.displayName,
          osType: d.osType,
          status: d.status,
          lastSeenAt: d.lastSeenAt?.toISOString() ?? null
        })),
        evaluatedAt: preview.evaluatedAt.toISOString()
      }
    });
  }
);

// POST /:id/devices/:deviceId/pin - Pin a device to the group (prevents dynamic removal)
groupRoutes.post(
  '/:id/devices/:deviceId/pin',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, deviceId } = c.req.valid('param');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (group.type !== 'dynamic') {
      return c.json({ error: 'Pinning is only supported for dynamic groups' }, 400);
    }

    // Verify device exists and belongs to the same org
    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (!device || device.orgId !== group.orgId) {
      return c.json({ error: 'Device not found or belongs to a different organization' }, 404);
    }

    await pinDeviceToGroup(id, deviceId, true);

    return c.json({
      data: {
        groupId: id,
        deviceId,
        isPinned: true,
        pinnedAt: new Date().toISOString()
      }
    }, 201);
  }
);

// DELETE /:id/devices/:deviceId/pin - Unpin a device from the group
groupRoutes.delete(
  '/:id/devices/:deviceId/pin',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, deviceId } = c.req.valid('param');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    if (group.type !== 'dynamic') {
      return c.json({ error: 'Unpinning is only supported for dynamic groups' }, 400);
    }

    // Check if device is a member of this group
    const [membership] = await db
      .select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
      .from(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, id),
          eq(deviceGroupMemberships.deviceId, deviceId)
        )
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: 'Device is not a member of this group' }, 404);
    }

    if (!membership.isPinned) {
      return c.json({ error: 'Device is not pinned to this group' }, 400);
    }

    await pinDeviceToGroup(id, deviceId, false);

    return c.json({
      data: {
        groupId: id,
        deviceId,
        isPinned: false,
        unpinnedAt: new Date().toISOString()
      }
    });
  }
);

// GET /:id/membership-log - Get audit log of membership changes
const membershipLogQuerySchema = z.object({
  deviceId: z.string().uuid().optional(),
  action: z.enum(['added', 'removed']).optional(),
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0)
});

groupRoutes.get(
  '/:id/membership-log',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', groupIdParamSchema),
  zValidator('query', membershipLogQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');

    const group = await getGroupWithAccess(id, auth);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    // Build conditions
    const conditions = [eq(groupMembershipLog.groupId, id)];
    if (query.deviceId) {
      conditions.push(eq(groupMembershipLog.deviceId, query.deviceId));
    }
    if (query.action) {
      conditions.push(eq(groupMembershipLog.action, query.action));
    }

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(groupMembershipLog)
      .where(and(...conditions));

    const total = Number(countResult?.count ?? 0);

    // Get log entries with device info
    const logEntries = await db
      .select({
        id: groupMembershipLog.id,
        groupId: groupMembershipLog.groupId,
        deviceId: groupMembershipLog.deviceId,
        action: groupMembershipLog.action,
        reason: groupMembershipLog.reason,
        createdAt: groupMembershipLog.createdAt,
        hostname: devices.hostname,
        displayName: devices.displayName
      })
      .from(groupMembershipLog)
      .leftJoin(devices, eq(groupMembershipLog.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(desc(groupMembershipLog.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const data = logEntries.map((entry) => ({
      id: entry.id,
      groupId: entry.groupId,
      deviceId: entry.deviceId,
      hostname: entry.hostname,
      displayName: entry.displayName,
      action: entry.action,
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString()
    }));

    return c.json({
      data,
      total,
      limit: query.limit,
      offset: query.offset
    });
  }
);
