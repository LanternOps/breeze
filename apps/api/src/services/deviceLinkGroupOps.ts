/**
 * Device link group (#2138, #2308) operations behind routes/devices/links.ts,
 * shared with the AI device-link tools. Moved verbatim from the route handlers
 * (after their middleware: scope, permission, MFA and body validation) so both
 * callers run the same code. Every operation returns `{ status, body }` —
 * exactly what the route sends.
 *
 * This module is Hono-free: the device lookup (org + site check), the group org
 * check, the audit writer and the dangling-reference reporter are injected.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { deviceLinkGroups, devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import {
  MAX_LINK_GROUP_SIZE,
  LinkGroupSiteAccessError,
  deleteLinkGroup,
  dissolveLinkGroupIfBelowMinimum,
  lockAndAuthorizeLinkGroupMutation,
} from './deviceLinkGroups';

export type DeviceRow = typeof devices.$inferSelect;

export interface LinkGroupOpResult {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
}

/** Org + site checked device lookup: the row, 'site_denied', or null (not found). */
export type CheckDevice = (deviceId: string) => Promise<DeviceRow | 'site_denied' | null>;

export type LinkGroupAuth = Pick<
  AuthContext,
  'allowedSiteIds' | 'canAccessSite' | 'orgCondition'
>;

export interface LinkGroupOpDeps {
  auth: LinkGroupAuth;
  audit: (event: RouteAuditInput) => void;
}

export interface LinkGroupDeviceDeps extends LinkGroupOpDeps {
  checkDevice: CheckDevice;
}

export interface LinkGroupOrgDeps extends LinkGroupOpDeps {
  /** Whether the caller may access the given org (route: ensureOrgAccess). */
  hasOrgAccess: (orgId: string) => Promise<boolean>;
}

/** Mirrors createLinkGroupSchema's parsed shape. */
export interface CreateLinkGroupInput {
  kind: 'multiboot' | 'vm_host';
  name?: string;
  deviceIds: string[];
  hostDeviceId?: string;
}

/** Mirrors updateLinkGroupSchema's parsed shape. */
export interface UpdateLinkGroupInput {
  name?: string | null;
  addDeviceIds?: string[];
  removeDeviceIds?: string[];
}

/**
 * Thrown inside a link/patch transaction when the guarded membership UPDATE
 * claims fewer rows than expected — i.e. a concurrent request linked one of
 * the devices between the pre-check and the transaction. Aborts (rolls back)
 * the whole operation; mapped to a 409.
 */
export class LinkRaceError extends Error {
  constructor() {
    super('link group membership changed concurrently');
    this.name = 'LinkRaceError';
  }
}

/** Client-facing shape of one member (boot profile / host / guest) in a link group. */
export interface LinkGroupMember {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  agentVersion: string;
  status: string;
  lastSeenAt: Date | null;
  /** 'host' | 'guest' within a vm_host group (#2308); null for multiboot peers. */
  role: string | null;
}

/**
 * Fetch the boot-profile members of one or more groups, honoring the caller's
 * site-scope restriction. A site-restricted caller only sees members in sites
 * they can access — so a group can render with a subset of its profiles, never
 * with devices from a forbidden site.
 */
export async function loadMembers(
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
      role: devices.linkGroupRole,
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
      role: r.role ?? null,
    });
    byGroup.set(r.linkGroupId, list);
  }
  return byGroup;
}

/** Load a group and enforce org access. Returns null (→ 404) when hidden. */
async function getGroupWithOrgCheck(
  groupId: string,
  hasOrgAccess: (orgId: string) => Promise<boolean>,
) {
  const [group] = await db
    .select()
    .from(deviceLinkGroups)
    .where(eq(deviceLinkGroups.id, groupId))
    .limit(1);
  if (!group) return null;
  if (!(await hasOrgAccess(group.orgId))) return null;
  return group;
}

/** Every link group in the caller's accessible orgs, each with its (site-scoped) members. */
export async function listLinkGroups(deps: LinkGroupOpDeps): Promise<LinkGroupOpResult> {
  const { auth } = deps;

  const orgFilter = auth.orgCondition(deviceLinkGroups.orgId);
  const groups = await db
    .select()
    .from(deviceLinkGroups)
    .where(orgFilter ?? undefined);

  const members = await loadMembers(groups.map((g) => g.id), auth);

  return {
    status: 200,
    body: {
      data: groups
        .filter((g) => auth.allowedSiteIds === undefined || members.has(g.id))
        .map((g) => ({
          id: g.id,
          orgId: g.orgId,
          kind: g.kind,
          name: g.name,
          createdBy: g.createdBy,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          members: members.get(g.id) ?? [],
        })),
    },
  };
}

/**
 * Link 2+ devices as boot profiles of one machine (kind='multiboot') or as one
 * host server plus its guest VMs (kind='vm_host', #2308: hostDeviceId names the
 * host; every other member becomes a guest).
 */
export async function createLinkGroup(
  deps: LinkGroupDeviceDeps & { actorUserId: string | null },
  input: CreateLinkGroupInput,
): Promise<LinkGroupOpResult> {
  const { auth, checkDevice, audit, actorUserId } = deps;
  const { kind, name, deviceIds, hostDeviceId } = input;

  const uniqueIds = [...new Set(deviceIds)];
  if (uniqueIds.length < 2) {
    return { status: 400, body: { error: 'A link group needs at least two distinct devices' } };
  }

  // Validate every device: org + site access, existence, not already linked,
  // and collect the rows so we can enforce the same-org invariant.
  const resolved: DeviceRow[] = [];
  for (const id of uniqueIds) {
    const device = await checkDevice(id);
    if (device === 'site_denied') {
      return { status: 403, body: { error: 'Access to a device site denied' } };
    }
    if (!device) {
      return { status: 404, body: { error: `Device ${id} not found` } };
    }
    if (device.linkGroupId) {
      return { status: 409, body: { error: `Device ${id} is already part of a link group` } };
    }
    resolved.push(device);
  }

  // Same-org invariant — the DB composite FK enforces it too, but a clean 400
  // beats a raw constraint error. All boot profiles are one physical machine
  // in one org.
  const orgId = resolved[0]!.orgId;
  if (resolved.some((d) => d.orgId !== orgId)) {
    return {
      status: 400,
      body: { error: 'All linked devices must belong to the same organization' },
    };
  }

  let groupId: string;
  try {
    await db.transaction(async (tx) => {
      // The friendly checks above precede this transaction. Lock and
      // re-authorize every unique target before inserting the group: a site
      // move committed in that window must not let the subsequent claim run
      // with stale authority. The insert follows the check so denial leaves
      // neither an empty group nor partial membership behind.
      await lockAndAuthorizeLinkGroupMutation(
        tx,
        null,
        auth.allowedSiteIds,
        uniqueIds,
      );
      const [group] = await tx
        .insert(deviceLinkGroups)
        .values({ orgId, kind, name: name ?? null, createdBy: actorUserId })
        .returning({ id: deviceLinkGroups.id });
      groupId = group!.id;
      // Self-guarding claim: only devices STILL unlinked take the group id.
      // The pre-check above ran outside this transaction, so a concurrent
      // link could have claimed a device in between (TOCTOU) — without the
      // guard the winner's group would silently lose the device. A row-count
      // mismatch aborts the whole link with a 409 instead.
      //
      // vm_host (#2308) claims in two batches purely because the role value
      // differs per member (host vs guests); the guard semantics are the
      // same — total claimed rows must equal the requested membership.
      // Multiboot members are peers, so role stays NULL (set explicitly to
      // self-heal any stale value, though unlink paths always clear it).
      const batches: Array<{ ids: string[]; role: string | null }> =
        kind === 'vm_host'
          ? [
              { ids: [hostDeviceId!], role: 'host' },
              { ids: uniqueIds.filter((id) => id !== hostDeviceId), role: 'guest' },
            ]
          : [{ ids: uniqueIds, role: null }];
      for (const batch of batches) {
        const claimed = await tx
          // own-device-row-allowlisted: link-group-membership
          .update(devices)
          .set({ linkGroupId: groupId, linkGroupRole: batch.role, updatedAt: new Date() })
          .where(and(inArray(devices.id, batch.ids), isNull(devices.linkGroupId)))
          .returning({ id: devices.id });
        if (claimed.length !== batch.ids.length) {
          throw new LinkRaceError();
        }
      }
    });
  } catch (err) {
    if (err instanceof LinkGroupSiteAccessError) {
      return { status: 403, body: { error: 'Access to a device site denied' } };
    }
    if (err instanceof LinkRaceError) {
      return { status: 409, body: { error: 'A device was linked by another request — retry' } };
    }
    throw err;
  }

  audit({
    orgId,
    action: 'device_link_group.create',
    resourceType: 'device_link_group',
    resourceId: groupId!,
    resourceName: name ?? null,
    details: { kind, deviceIds: uniqueIds, ...(hostDeviceId ? { hostDeviceId } : {}) },
  });

  const members = await loadMembers([groupId!], auth);
  return {
    status: 201,
    body: { id: groupId!, orgId, kind, name: name ?? null, members: members.get(groupId!) ?? [] },
  };
}

/** One group with its members. */
export async function getLinkGroup(
  deps: LinkGroupOrgDeps,
  groupId: string,
): Promise<LinkGroupOpResult> {
  const { auth, hasOrgAccess } = deps;

  const group = await getGroupWithOrgCheck(groupId, hasOrgAccess);
  if (!group) return { status: 404, body: { error: 'Link group not found' } };

  const members = await loadMembers([groupId], auth);
  if (auth.allowedSiteIds !== undefined && !members.has(groupId)) {
    return { status: 404, body: { error: 'Link group not found' } };
  }
  return {
    status: 200,
    body: {
      id: group.id,
      orgId: group.orgId,
      kind: group.kind,
      name: group.name,
      createdBy: group.createdBy,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      members: members.get(groupId) ?? [],
    },
  };
}

/** Rename and/or add/remove profiles. */
export async function updateLinkGroup(
  deps: LinkGroupDeviceDeps & LinkGroupOrgDeps,
  groupId: string,
  input: UpdateLinkGroupInput,
): Promise<LinkGroupOpResult> {
  const { auth, checkDevice, hasOrgAccess, audit } = deps;
  const { name, addDeviceIds, removeDeviceIds } = input;

  const group = await getGroupWithOrgCheck(groupId, hasOrgAccess);
  if (!group) return { status: 404, body: { error: 'Link group not found' } };

  // Validate additions up front (org + site + not-already-linked-elsewhere)
  // before mutating anything.
  const toAdd = [...new Set(addDeviceIds ?? [])];
  for (const id of toAdd) {
    const device = await checkDevice(id);
    if (device === 'site_denied') {
      return { status: 404, body: { error: 'Link group not found' } };
    }
    if (!device) {
      return { status: 404, body: { error: `Device ${id} not found` } };
    }
    if (device.orgId !== group.orgId) {
      return {
        status: 400,
        body: { error: 'All linked devices must belong to the same organization' },
      };
    }
    if (device.linkGroupId && device.linkGroupId !== groupId) {
      return {
        status: 409,
        body: { error: `Device ${id} is already part of another link group` },
      };
    }
  }

  // Validate removals through the SAME org+site chokepoint as additions and
  // reads (loadMembers), so a site-restricted caller cannot unlink a boot
  // profile in a site they can't access just by knowing its id.
  const toRemove = [...new Set(removeDeviceIds ?? [])];
  for (const id of toRemove) {
    const device = await checkDevice(id);
    if (device === 'site_denied') {
      return { status: 404, body: { error: 'Link group not found' } };
    }
    if (!device) {
      return { status: 404, body: { error: `Device ${id} not found` } };
    }
    // Removing a device that is NOT a member of this group would silently
    // no-op (the tx update is scoped to this group) while returning 200 and
    // recording a false audit entry. Reject it instead.
    if (device.linkGroupId !== groupId) {
      return {
        status: 409,
        body: { error: `Device ${id} is not a member of this link group` },
      };
    }
  }

  // Enforce the size ceiling on the resulting membership.
  const currentMembers = await db
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.linkGroupId, groupId));
  const currentIds = new Set(currentMembers.map((m) => m.id));
  for (const id of toRemove) currentIds.delete(id);
  for (const id of toAdd) currentIds.add(id);
  if (currentIds.size > MAX_LINK_GROUP_SIZE) {
    return {
      status: 400,
      body: { error: `A link group may contain at most ${MAX_LINK_GROUP_SIZE} devices` },
    };
  }

  let dissolved = false;
  try {
    await db.transaction(async (tx) => {
      await lockAndAuthorizeLinkGroupMutation(
        tx,
        groupId,
        auth.allowedSiteIds,
        [...toAdd, ...toRemove],
      );
      if (name !== undefined || toAdd.length > 0 || toRemove.length > 0) {
        await tx
          .update(deviceLinkGroups)
          .set({ ...(name !== undefined ? { name } : {}), updatedAt: new Date() })
          .where(eq(deviceLinkGroups.id, groupId));
      }
      if (toRemove.length > 0) {
        // Only unlink devices actually in THIS group. Role is cleared with
        // the membership — it is meaningless outside a group (#2308).
        await tx
          // own-device-row-allowlisted: link-group-membership
          .update(devices)
          .set({ linkGroupId: null, linkGroupRole: null, updatedAt: new Date() })
          .where(and(inArray(devices.id, toRemove), eq(devices.linkGroupId, groupId)));
      }
      if (toAdd.length > 0) {
        // Self-guarding claim (same TOCTOU rationale as the create path):
        // only devices still unlinked — or already in this group — take the
        // group id. A concurrent link stealing one of them aborts with 409
        // instead of silently succeeding with fewer members.
        //
        // Two batches so a no-op RE-add of an existing member keeps its role
        // (#2308: overwriting would demote a vm_host group's host to guest
        // and dissolve the group). Batch 1 touches only rows already in this
        // group; batch 2 only still-unlinked rows — disjoint by WHERE, so
        // the combined row count is the same guard as the single update.
        const reAdded = await tx
          // own-device-row-allowlisted: link-group-membership
          .update(devices)
          .set({ linkGroupId: groupId, updatedAt: new Date() })
          .where(and(inArray(devices.id, toAdd), eq(devices.linkGroupId, groupId)))
          .returning({ id: devices.id });
        // vm_host (#2308): a group's host is fixed at create time, so every
        // newly linked member is a guest. Multiboot members are peers (NULL).
        const claimed = await tx
          // own-device-row-allowlisted: link-group-membership
          .update(devices)
          .set({
            linkGroupId: groupId,
            linkGroupRole: group.kind === 'vm_host' ? 'guest' : null,
            updatedAt: new Date(),
          })
          .where(and(inArray(devices.id, toAdd), isNull(devices.linkGroupId)))
          .returning({ id: devices.id });
        if (reAdded.length + claimed.length !== toAdd.length) {
          throw new LinkRaceError();
        }
      }
      // A group that fell below the minimum after removals is meaningless —
      // dissolve it (unlink the lone survivor, delete the row). For vm_host
      // this also dissolves a group whose HOST was just removed: guests
      // without their nesting anchor are a headless group (#2308).
      dissolved = await dissolveLinkGroupIfBelowMinimum(tx, groupId, auth.allowedSiteIds);
    });
  } catch (err) {
    if (err instanceof LinkGroupSiteAccessError) {
      return { status: 404, body: { error: 'Link group not found' } };
    }
    if (err instanceof LinkRaceError) {
      return { status: 409, body: { error: 'A device was linked by another request — retry' } };
    }
    throw err;
  }

  audit({
    orgId: group.orgId,
    action: dissolved ? 'device_link_group.dissolve' : 'device_link_group.update',
    resourceType: 'device_link_group',
    resourceId: groupId,
    resourceName: name ?? group.name,
    details: { addDeviceIds: toAdd, removeDeviceIds: toRemove, dissolved },
  });

  if (dissolved) {
    return { status: 200, body: { id: groupId, dissolved: true, members: [] } };
  }

  const members = await loadMembers([groupId], auth);
  return {
    status: 200,
    body: {
      id: group.id,
      orgId: group.orgId,
      kind: group.kind,
      name: name !== undefined ? name : group.name,
      members: members.get(groupId) ?? [],
    },
  };
}

/** Unlink every profile and remove the group. */
export async function dissolveLinkGroup(
  deps: LinkGroupOrgDeps,
  groupId: string,
): Promise<LinkGroupOpResult> {
  const { auth, hasOrgAccess, audit } = deps;

  const group = await getGroupWithOrgCheck(groupId, hasOrgAccess);
  if (!group) return { status: 404, body: { error: 'Link group not found' } };

  try {
    await db.transaction(async (tx) => {
      await deleteLinkGroup(tx, groupId, auth.allowedSiteIds);
    });
  } catch (err) {
    if (err instanceof LinkGroupSiteAccessError) {
      return { status: 404, body: { error: 'Link group not found' } };
    }
    throw err;
  }

  audit({
    orgId: group.orgId,
    action: 'device_link_group.delete',
    resourceType: 'device_link_group',
    resourceId: groupId,
    resourceName: group.name,
  });

  return { status: 200, body: { success: true } };
}

/**
 * The boot-profile group a device belongs to, with its sibling profiles (agent
 * version + last seen). Returns `{ group: null }` when unlinked.
 * `reportDanglingReference` is how the caller surfaces the loud-failure case
 * (route: Sentry with the request context).
 */
export async function getDeviceLinkGroup(
  deps: Pick<LinkGroupDeviceDeps, 'auth' | 'checkDevice'> & {
    reportDanglingReference: (err: Error) => void;
  },
  deviceId: string,
): Promise<LinkGroupOpResult> {
  const { auth, checkDevice, reportDanglingReference } = deps;

  const device = await checkDevice(deviceId);
  if (device === 'site_denied') {
    return { status: 403, body: { error: 'Access to this site denied' } };
  }
  if (!device) {
    return { status: 404, body: { error: 'Device not found' } };
  }

  if (!device.linkGroupId) {
    return { status: 200, body: { group: null, members: [] } };
  }

  const [group] = await db
    .select()
    .from(deviceLinkGroups)
    .where(eq(deviceLinkGroups.id, device.linkGroupId))
    .limit(1);
  if (!group) {
    // Dangling reference — impossible under the composite FK, so if it ever
    // fires something bypassed the constraint (manual fix-up, bad migration,
    // RLS filtering the group row while the device stays visible). Be LOUD:
    // silently rendering "not linked" would mask data corruption.
    console.error(
      `Device ${deviceId} references link group ${device.linkGroupId} which is not visible/present`,
    );
    reportDanglingReference(
      new Error(`device link group dangling reference: device ${deviceId} -> group ${device.linkGroupId}`),
    );
    return { status: 200, body: { group: null, members: [] } };
  }

  const members = await loadMembers([group.id], auth);
  return {
    status: 200,
    body: {
      group: {
        id: group.id,
        orgId: group.orgId,
        kind: group.kind,
        name: group.name,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      },
      members: members.get(group.id) ?? [],
    },
  };
}
