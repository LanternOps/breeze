import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { deviceLinkGroups, devices } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  ensureOrgAccess,
  getDeviceWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
} from './helpers';
import { createLinkGroupSchema, updateLinkGroupSchema } from './schemas';
import {
  MAX_LINK_GROUP_SIZE,
  deleteLinkGroup,
  dissolveLinkGroupIfBelowMinimum,
} from '../../services/deviceLinkGroups';
import type { AuthContext } from '../../middleware/auth';

/**
 * Linked device profiles for multi-boot systems (#2138).
 *
 * Manual link/unlink of 2+ device records as boot profiles of one physical
 * machine. NON-destructive: each device keeps its own inventory/history. The
 * device-list and device-detail UI use these to collapse a linked group into a
 * single primary row (active OS surfaced, siblings de-emphasized) and to flag a
 * link as conflicting when more than one profile reports online at once.
 *
 * Mounted BEFORE coreRoutes so the static `/link-groups` paths are not eaten by
 * the core `/:id` matcher.
 */
export const linksRoutes = new Hono();

linksRoutes.use('*', authMiddleware);

/** Client-facing shape of one boot profile in a link group. */
interface LinkGroupMember {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  agentVersion: string;
  status: string;
  lastSeenAt: Date | null;
}

/**
 * Fetch the boot-profile members of one or more groups, honoring the caller's
 * site-scope restriction. A site-restricted caller only sees members in sites
 * they can access — so a group can render with a subset of its profiles, never
 * with devices from a forbidden site.
 */
async function loadMembers(
  groupIds: string[],
  auth: Pick<AuthContext, 'canAccessSite'>,
): Promise<Map<string, LinkGroupMember[]>> {
  const byGroup = new Map<string, LinkGroupMember[]>();
  if (groupIds.length === 0) return byGroup;

  const rows = await db
    .select({
      deviceId: devices.id,
      linkGroupId: devices.linkGroupId,
      siteId: devices.siteId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(inArray(devices.linkGroupId, groupIds));

  for (const r of rows) {
    if (!r.linkGroupId) continue;
    if (auth.canAccessSite && !auth.canAccessSite(r.siteId)) continue;
    const list = byGroup.get(r.linkGroupId) ?? [];
    list.push({
      deviceId: r.deviceId,
      hostname: r.hostname,
      displayName: r.displayName,
      osType: r.osType,
      osVersion: r.osVersion,
      agentVersion: r.agentVersion,
      status: r.status,
      lastSeenAt: r.lastSeenAt,
    });
    byGroup.set(r.linkGroupId, list);
  }
  return byGroup;
}

// GET /devices/link-groups — every link group in the caller's accessible orgs,
// each with its (site-scoped) members. Powers the device list's grouping.
linksRoutes.get(
  '/link-groups',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');

    const orgFilter = auth.orgCondition(deviceLinkGroups.orgId);
    const groups = await db
      .select()
      .from(deviceLinkGroups)
      .where(orgFilter ?? undefined);

    const members = await loadMembers(groups.map((g) => g.id), auth);

    return c.json({
      data: groups.map((g) => ({
        id: g.id,
        orgId: g.orgId,
        name: g.name,
        createdBy: g.createdBy,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        members: members.get(g.id) ?? [],
      })),
    });
  },
);

// POST /devices/link-groups — link 2+ devices as boot profiles of one machine.
linksRoutes.post(
  '/link-groups',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', createLinkGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const { name, deviceIds } = c.req.valid('json');

    const uniqueIds = [...new Set(deviceIds)];
    if (uniqueIds.length < 2) {
      return c.json({ error: 'A link group needs at least two distinct devices' }, 400);
    }

    // Validate every device: org + site access, existence, not already linked,
    // and collect the rows so we can enforce the same-org invariant.
    const resolved: (typeof devices.$inferSelect)[] = [];
    for (const id of uniqueIds) {
      const device = await getDeviceWithOrgAndSiteCheck(c, id, auth);
      if (device === SITE_ACCESS_DENIED) {
        return c.json({ error: 'Access to a device site denied' }, 403);
      }
      if (!device) {
        return c.json({ error: `Device ${id} not found` }, 404);
      }
      if (device.linkGroupId) {
        return c.json({ error: `Device ${id} is already part of a link group` }, 409);
      }
      resolved.push(device);
    }

    // Same-org invariant — the DB composite FK enforces it too, but a clean 400
    // beats a raw constraint error. All boot profiles are one physical machine
    // in one org.
    const orgId = resolved[0]!.orgId;
    if (resolved.some((d) => d.orgId !== orgId)) {
      return c.json({ error: 'All linked devices must belong to the same organization' }, 400);
    }

    let groupId: string;
    await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(deviceLinkGroups)
        .values({ orgId, name: name ?? null, createdBy: auth.user.id })
        .returning({ id: deviceLinkGroups.id });
      groupId = group!.id;
      await tx
        .update(devices)
        .set({ linkGroupId: groupId, updatedAt: new Date() })
        .where(inArray(devices.id, uniqueIds));
    });

    writeRouteAudit(c, {
      orgId,
      action: 'device_link_group.create',
      resourceType: 'device_link_group',
      resourceId: groupId!,
      resourceName: name ?? null,
      details: { deviceIds: uniqueIds },
    });

    const members = await loadMembers([groupId!], auth);
    return c.json(
      { id: groupId!, orgId, name: name ?? null, members: members.get(groupId!) ?? [] },
      201,
    );
  },
);

/** Load a group and enforce org access. Returns null (→ 404) when hidden. */
async function getGroupWithOrgCheck(groupId: string, auth: AuthContext) {
  const [group] = await db
    .select()
    .from(deviceLinkGroups)
    .where(eq(deviceLinkGroups.id, groupId))
    .limit(1);
  if (!group) return null;
  if (!(await ensureOrgAccess(group.orgId, auth))) return null;
  return group;
}

// GET /devices/link-groups/:groupId — one group with its members.
linksRoutes.get(
  '/link-groups/:groupId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('groupId')!;

    const group = await getGroupWithOrgCheck(groupId, auth);
    if (!group) return c.json({ error: 'Link group not found' }, 404);

    const members = await loadMembers([groupId], auth);
    return c.json({
      id: group.id,
      orgId: group.orgId,
      name: group.name,
      createdBy: group.createdBy,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      members: members.get(groupId) ?? [],
    });
  },
);

// PATCH /devices/link-groups/:groupId — rename and/or add/remove profiles.
linksRoutes.patch(
  '/link-groups/:groupId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', updateLinkGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('groupId')!;
    const { name, addDeviceIds, removeDeviceIds } = c.req.valid('json');

    const group = await getGroupWithOrgCheck(groupId, auth);
    if (!group) return c.json({ error: 'Link group not found' }, 404);

    // Validate additions up front (org + site + not-already-linked-elsewhere)
    // before mutating anything.
    const toAdd = [...new Set(addDeviceIds ?? [])];
    for (const id of toAdd) {
      const device = await getDeviceWithOrgAndSiteCheck(c, id, auth);
      if (device === SITE_ACCESS_DENIED) {
        return c.json({ error: 'Access to a device site denied' }, 403);
      }
      if (!device) {
        return c.json({ error: `Device ${id} not found` }, 404);
      }
      if (device.orgId !== group.orgId) {
        return c.json({ error: 'All linked devices must belong to the same organization' }, 400);
      }
      if (device.linkGroupId && device.linkGroupId !== groupId) {
        return c.json({ error: `Device ${id} is already part of another link group` }, 409);
      }
    }

    const toRemove = [...new Set(removeDeviceIds ?? [])];

    // Enforce the size ceiling on the resulting membership.
    const currentMembers = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.linkGroupId, groupId));
    const currentIds = new Set(currentMembers.map((m) => m.id));
    for (const id of toRemove) currentIds.delete(id);
    for (const id of toAdd) currentIds.add(id);
    if (currentIds.size > MAX_LINK_GROUP_SIZE) {
      return c.json({ error: `A link group may contain at most ${MAX_LINK_GROUP_SIZE} devices` }, 400);
    }

    let dissolved = false;
    await db.transaction(async (tx) => {
      if (name !== undefined || toAdd.length > 0) {
        await tx
          .update(deviceLinkGroups)
          .set({ ...(name !== undefined ? { name } : {}), updatedAt: new Date() })
          .where(eq(deviceLinkGroups.id, groupId));
      }
      if (toRemove.length > 0) {
        // Only unlink devices actually in THIS group.
        await tx
          .update(devices)
          .set({ linkGroupId: null, updatedAt: new Date() })
          .where(and(inArray(devices.id, toRemove), eq(devices.linkGroupId, groupId)));
      }
      if (toAdd.length > 0) {
        await tx
          .update(devices)
          .set({ linkGroupId: groupId, updatedAt: new Date() })
          .where(inArray(devices.id, toAdd));
      }
      // A group that fell below the minimum after removals is meaningless —
      // dissolve it (unlink the lone survivor, delete the row).
      dissolved = await dissolveLinkGroupIfBelowMinimum(tx, groupId);
    });

    writeRouteAudit(c, {
      orgId: group.orgId,
      action: dissolved ? 'device_link_group.dissolve' : 'device_link_group.update',
      resourceType: 'device_link_group',
      resourceId: groupId,
      resourceName: name ?? group.name,
      details: { addDeviceIds: toAdd, removeDeviceIds: toRemove, dissolved },
    });

    if (dissolved) {
      return c.json({ id: groupId, dissolved: true, members: [] });
    }

    const members = await loadMembers([groupId], auth);
    return c.json({
      id: group.id,
      orgId: group.orgId,
      name: name !== undefined ? name : group.name,
      members: members.get(groupId) ?? [],
    });
  },
);

// DELETE /devices/link-groups/:groupId — unlink every profile and remove the group.
linksRoutes.delete(
  '/link-groups/:groupId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('groupId')!;

    const group = await getGroupWithOrgCheck(groupId, auth);
    if (!group) return c.json({ error: 'Link group not found' }, 404);

    await db.transaction(async (tx) => {
      await deleteLinkGroup(tx, groupId);
    });

    writeRouteAudit(c, {
      orgId: group.orgId,
      action: 'device_link_group.delete',
      resourceType: 'device_link_group',
      resourceId: groupId,
      resourceName: group.name,
    });

    return c.json({ success: true });
  },
);

// GET /devices/:id/link-group — the boot-profile group a device belongs to,
// with its sibling profiles (agent version + last seen). Powers the device
// detail "Linked Profiles" panel. Returns { group: null } when unlinked.
linksRoutes.get(
  '/:id/link-group',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (!device.linkGroupId) {
      return c.json({ group: null, members: [] });
    }

    const [group] = await db
      .select()
      .from(deviceLinkGroups)
      .where(eq(deviceLinkGroups.id, device.linkGroupId))
      .limit(1);
    if (!group) {
      // Defensive: dangling reference (should be impossible under the FK).
      return c.json({ group: null, members: [] });
    }

    const members = await loadMembers([group.id], auth);
    return c.json({
      group: {
        id: group.id,
        orgId: group.orgId,
        name: group.name,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      },
      members: members.get(group.id) ?? [],
    });
  },
);
