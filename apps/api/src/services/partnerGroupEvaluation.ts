/**
 * Partner membership lock order, shared by both evaluators:
 * 1. ALL partner group rows, ordered by id, FOR KEY SHARE.
 * 2. ALL distinct (group, org) advisory keys in signed bigint order.
 * 3. Read/evaluate the diff. Only for a nonempty diff, acquire the org export
 *    lock BEFORE any membership/log/device row write, then recheck insert orgs.
 * 4. Write memberships/logs. No group/advisory lock follows a membership write.
 *
 * Per-device writers hold shared advisory keys; whole-org writers hold ONE
 * exclusive key. Sorted keys, shared-only multi-lock holders and single-lock
 * exclusive holders prevent advisory cycles. KEY SHARE protects deletion/key
 * changes without conflicting with non-key filter revision updates.
 *
 * Export locks precede membership row locks, matching orgMerge.ts:1308 and
 * moveDeviceOrgInTransaction's breeze_rehome_device_custom_field_values call.
 * Those lifecycle writers can therefore finish while an evaluator waits on
 * export admission: it holds no membership/device row locks yet. A moved
 * device is excluded by the post-lock org recheck; deletes include the org.
 * One org per fresh transaction prevents descending export locks across orgs.
 * Discovery closes its context before evaluation; finalization has its own
 * short transaction. Never acquire advisory keys inside an org export context.
 */
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceGroupMemberships, deviceGroups, devices, groupMembershipLog, organizations } from '../db/schema';
import { acquireGroupOrgMembershipLocks, acquireMembershipExportOrgLock, acquirePartnerGroupRowLocks } from './deviceGroupOwnership';
import { resolveEffectiveGroupMembers, schedulePeripheralMembershipChanges } from './groupMembership';
import { excludeQuickSupportOrgs } from './quickSupportOrg';
import { notHoldingOrgCondition } from './unassignedPool/selectorPredicate';

export const PARTNER_GROUP_ORG_PAGE_SIZE = 50;

export interface PartnerGroupOrgResult {
  orgId: string;
  ok: boolean;
  status: 'evaluated' | 'failed' | 'superseded' | 'gone' | 'skipped';
  added: number;
  removed: number;
  matched: number;
  filterMs: number;
  error?: string;
}

/** Cursor pagination deliberately has no partner-wide organization count cap. */
export async function listPartnerGroupEvaluationOrgIds(
  partnerId: string,
  afterOrgId: string | null,
  limit = PARTNER_GROUP_ORG_PAGE_SIZE,
): Promise<string[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({ id: organizations.id }).from(organizations).where(and(
      eq(organizations.partnerId, partnerId),
      excludeQuickSupportOrgs(),
      notHoldingOrgCondition(),
      afterOrgId ? gt(organizations.id, afterOrgId) : undefined,
    )).orderBy(asc(organizations.id)).limit(limit);
    return rows.map(({ id }) => id);
  }, 'partnerGroupEvaluation.discover'));
}

/** Always opens a fresh transaction, never an ambient transaction's savepoint. */
export async function evaluatePartnerGroupForOrg(
  groupId: string,
  orgId: string,
  opts: { expectedRevision?: number } = {},
): Promise<PartnerGroupOrgResult> {
  const empty = { orgId, added: 0, removed: 0, matched: 0, filterMs: 0 };
  let filterMs = 0;
  try {
    return await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<PartnerGroupOrgResult> => {
      await acquirePartnerGroupRowLocks([groupId]);
      const [group] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, groupId)).limit(1);
      if (!group || group.orgId !== null || group.partnerId === null || group.type !== 'dynamic') {
        return { ...empty, ok: true, status: 'gone' };
      }
      if (opts.expectedRevision !== undefined && group.filterRevision !== opts.expectedRevision) {
        return { ...empty, ok: true, status: 'superseded' };
      }
      const [org] = await db.select({ id: organizations.id }).from(organizations).where(and(
        eq(organizations.id, orgId), eq(organizations.partnerId, group.partnerId),
        excludeQuickSupportOrgs(), notHoldingOrgCondition(),
      )).limit(1);
      if (!org) return { ...empty, ok: true, status: 'skipped' };

      await acquireGroupOrgMembershipLocks([{ groupId, orgId }], 'exclusive');
      const started = performance.now();
      let effective;
      try {
        effective = await resolveEffectiveGroupMembers(group, orgId);
      } finally {
        filterMs = performance.now() - started;
      }
      filterMs = effective.filterMs;
      const current = await db.select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
        .from(deviceGroupMemberships).where(and(
          eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, orgId),
        ));
      const existingIds = new Set(current.map(({ deviceId }) => deviceId));
      const toAdd = [...effective.matched].filter((id) => !existingIds.has(id));
      const toRemove = current.filter(({ deviceId, isPinned }) => !isPinned && !effective.matched.has(deviceId))
        .map(({ deviceId }) => deviceId);
      const added: string[] = [];
      const removed: string[] = [];
      if (toAdd.length > 0 || toRemove.length > 0) {
        await acquireMembershipExportOrgLock(orgId);
      }
      if (toAdd.length > 0) {
        // Export admission may have waited for an org move/merge. Its commits
        // are now visible; never reinsert the old org from the filter snapshot.
        const eligible = await db.select({ id: devices.id }).from(devices).where(and(
          eq(devices.orgId, orgId), inArray(devices.id, toAdd),
        ));
        if (eligible.length > 0) {
          const inserted = await db.insert(deviceGroupMemberships).values(eligible.map(({ id }): typeof deviceGroupMemberships.$inferInsert => ({
            deviceId: id, groupId, orgId, addedBy: 'dynamic_rule',
          }))).onConflictDoNothing().returning({ deviceId: deviceGroupMemberships.deviceId });
          added.push(...inserted.map(({ deviceId }) => deviceId));
        }
      }
      if (toRemove.length > 0) {
        const deleted = await db.delete(deviceGroupMemberships).where(and(
          eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, orgId),
          inArray(deviceGroupMemberships.deviceId, toRemove),
        )).returning({ deviceId: deviceGroupMemberships.deviceId });
        removed.push(...deleted.map(({ deviceId }) => deviceId));
      }
      const logs: (typeof groupMembershipLog.$inferInsert)[] = [
        ...added.map((deviceId): typeof groupMembershipLog.$inferInsert => ({
          deviceId, groupId, orgId, action: 'added', reason: 'filter_match',
        })),
        ...removed.map((deviceId): typeof groupMembershipLog.$inferInsert => ({
          deviceId, groupId, orgId, action: 'removed', reason: 'filter_unmatch',
        })),
      ];
      if (logs.length > 0) {
        await db.insert(groupMembershipLog).values(logs);
        await schedulePeripheralMembershipChanges([...added, ...removed], 'dynamic_membership_changed');
      }
      return { orgId, ok: true, status: 'evaluated', added: added.length, removed: removed.length,
        matched: effective.matched.size, filterMs };
    }, 'partnerGroupEvaluation.org'));
  } catch (error) {
    // Catch OUTSIDE the context so any partial write rolls back before reporting.
    return { ...empty, filterMs, ok: false, status: 'failed',
      error: error instanceof Error ? error.message : String(error) };
  }
}
