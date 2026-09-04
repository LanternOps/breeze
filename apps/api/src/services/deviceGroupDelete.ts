/**
 * The one way to delete a device group (#3205 W02). Three surfaces call it:
 * DELETE /groups/:id, DELETE /devices/groups/:id, and the AI manage_groups tool.
 * Callers keep their own auth/site checks, audit write and peripheral-policy
 * scheduling; this module owns the transactional part.
 *
 * Refuses while a draft/active/paused contract or draft/sent/viewed quote has
 * a per_device_group line on the group. Terminal documents do not block: the
 * FK nulls their device_group_id and the stamped device_group_name keeps the
 * history.
 *
 * FOR UPDATE on the group row makes the check race-safe: a concurrent line
 * insert takes FOR KEY SHARE on the same row (its composite FK), so one side
 * waits for the other and the loser fails cleanly.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, deviceGroups, deviceGroupMemberships, groupMembershipLog, quotes, quoteLines } from '../db/schema';

export type DeviceGroupDeleteCode = 'NOT_FOUND' | 'HAS_CHILDREN' | 'BILLED_BY_CONTRACTS' | 'QUOTED_BY_QUOTES';

export class DeviceGroupDeleteError extends Error {
  constructor(
    public readonly code: DeviceGroupDeleteCode,
    message: string,
    public readonly contracts?: Array<{ id: string; name: string; status: string }>,
    public readonly quotes?: Array<{ id: string; quoteNumber: string | null; status: string }>,
  ) {
    super(message);
    this.name = 'DeviceGroupDeleteError';
  }
  get contractCount(): number | undefined { return this.contracts?.length; }
  get quoteCount(): number | undefined { return this.quotes?.length; }
}

type Executor = Pick<typeof db, 'select'>;
const BLOCKING_STATUSES = ['draft', 'active', 'paused'] as const;
/** Quotes that still PRICE the group. Accepted, declined, expired, converted
 *  and superseded quotes do NOT block: their lines are historical, the stamp
 *  survives the FK's SET NULL, and a converted quote's contract line is already
 *  guarded by BILLED_BY_CONTRACTS. */
const QUOTE_BLOCKING_STATUSES = ['draft', 'sent', 'viewed'] as const;

/** Contracts that still bill the group. Terminated contracts are not listed. */
export async function listContractsBillingGroup(executor: Executor, groupId: string) {
  return executor
    .select({ id: contracts.id, name: contracts.name, status: contracts.status })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(eq(contractLines.deviceGroupId, groupId), inArray(contracts.status, [...BLOCKING_STATUSES] as never)))
    .groupBy(contracts.id, contracts.name, contracts.status)
    .orderBy(contracts.name);
}

export async function listQuotesPricingGroup(executor: Executor, groupId: string) {
  return executor
    .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, status: quotes.status })
    .from(quoteLines)
    .innerJoin(quotes, eq(quotes.id, quoteLines.quoteId))
    .where(and(eq(quoteLines.deviceGroupId, groupId), inArray(quotes.status, [...QUOTE_BLOCKING_STATUSES] as never)))
    .groupBy(quotes.id, quotes.quoteNumber, quotes.status)
    .orderBy(quotes.quoteNumber);
}

export interface DeleteDeviceGroupResult {
  group: { id: string; name: string; orgId: string };
  affectedDeviceIds: string[];
}

export async function deleteDeviceGroup(groupId: string, orgId: string): Promise<DeleteDeviceGroupResult> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: deviceGroups.id, name: deviceGroups.name, orgId: deviceGroups.orgId })
      .from(deviceGroups)
      .where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, orgId)))
      .for('update');
    if (!group) throw new DeviceGroupDeleteError('NOT_FOUND', 'Group not found');

    const [child] = await tx.select({ id: deviceGroups.id }).from(deviceGroups).where(eq(deviceGroups.parentId, groupId)).limit(1);
    if (child) throw new DeviceGroupDeleteError('HAS_CHILDREN', 'Cannot delete group with child groups');

    const billing = await listContractsBillingGroup(tx, groupId);
    const quoted = await listQuotesPricingGroup(tx, groupId);
    // Report contracts FIRST, then quotes, and never collapse them: the two
    // lists send the operator to two different places.
    if (billing.length > 0 || quoted.length > 0) {
      throw new DeviceGroupDeleteError(
        billing.length > 0 ? 'BILLED_BY_CONTRACTS' : 'QUOTED_BY_QUOTES',
        [
          billing.length > 0 ? `Group is billed by ${billing.length} contract(s); remove those contract lines first` : null,
          quoted.length > 0 ? `Group is priced by ${quoted.length} open quote(s); remove those quote lines first` : null,
        ].filter(Boolean).join('. '),
        billing.length > 0 ? billing.map((b) => ({ id: b.id, name: b.name, status: String(b.status) })) : undefined,
        quoted.length > 0 ? quoted.map((q) => ({ id: q.id, quoteNumber: q.quoteNumber, status: String(q.status) })) : undefined,
      );
    }

    const affected = await tx.select({ deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, groupId));
    await tx.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, groupId));
    // group_membership_log FKs device_groups with no ON DELETE (#3313).
    await tx.delete(groupMembershipLog).where(eq(groupMembershipLog.groupId, groupId));
    await tx.delete(deviceGroups).where(eq(deviceGroups.id, groupId));

    return { group, affectedDeviceIds: affected.map((a) => a.deviceId) };
  });
}
