/**
 * Linked device profiles for multi-boot systems (#2138).
 *
 * A physical machine that dual/multi-boots runs one Breeze agent per OS and so
 * appears as several device records — only one online at a time. A
 * `device_link_groups` row plus the `devices.link_group_id` column groups those
 * records as boot profiles of one machine. This is a NON-destructive overlay:
 * device records stay fully separate. Membership is the column on `devices`
 * (one group per device), so there is no child membership table — a group is
 * dissolved by nulling its members and deleting the group row.
 *
 * These helpers run through a `DbExecutor` (the request `db` OR a transaction
 * handle) so callers — the link routes and the move-org path — can compose them
 * inside their own transactions. The composite FK
 * devices(link_group_id, org_id) -> device_link_groups(id, org_id) means a
 * group row can only be deleted once every member's `link_group_id` is cleared,
 * which is exactly the order these helpers use.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { deviceLinkGroups, devices } from '../db/schema';

/** db instance or an open transaction — both expose the query builders used here. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A linked group only makes sense with two or more boot profiles. */
export const MIN_LINK_GROUP_SIZE = 2;

/** Upper bound on members in one physical-machine group (generous headroom). */
export const MAX_LINK_GROUP_SIZE = 10;

/** Clear `link_group_id` on the given devices (unlink), leaving the group row. */
export async function unlinkDevices(exec: DbExecutor, deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  for (const id of deviceIds) {
    await exec
      .update(devices)
      .set({ linkGroupId: null, updatedAt: new Date() })
      .where(eq(devices.id, id));
  }
}

/**
 * If a group has fallen below {@link MIN_LINK_GROUP_SIZE} members, unlink any
 * survivor and delete the (now-meaningless) group row. Returns true when the
 * group was dissolved. A group at or above the minimum is left untouched.
 */
export async function dissolveLinkGroupIfBelowMinimum(
  exec: DbExecutor,
  groupId: string,
): Promise<boolean> {
  const members = await exec
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.linkGroupId, groupId));

  if (members.length >= MIN_LINK_GROUP_SIZE) return false;

  // Null any lone survivor first — the composite FK forbids deleting the group
  // while a device still references it.
  await unlinkDevices(exec, members.map((m) => m.id));
  await exec.delete(deviceLinkGroups).where(eq(deviceLinkGroups.id, groupId));
  return true;
}

/** Delete a group outright: unlink all members, then remove the group row. */
export async function deleteLinkGroup(exec: DbExecutor, groupId: string): Promise<void> {
  const members = await exec
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.linkGroupId, groupId));
  await unlinkDevices(exec, members.map((m) => m.id));
  await exec.delete(deviceLinkGroups).where(eq(deviceLinkGroups.id, groupId));
}
