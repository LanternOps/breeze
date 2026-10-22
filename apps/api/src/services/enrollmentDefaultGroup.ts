import { and, eq } from 'drizzle-orm';
import type { db } from '../db';
import {
  deviceGroupMemberships,
  deviceGroups,
  groupMembershipLog,
  organizations,
} from '../db/schema';
import { captureException } from './sentry';

type Tx = Pick<typeof db, 'select' | 'insert' | 'transaction'>;

export type DefaultGroupOutcome = 'added' | 'none' | 'skipped';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Org default device group (#9617). Called inside the enrollment transaction for
 * a freshly inserted device: reads `organizations.settings.defaults.deviceGroup`
 * and, when it is the id of one of THIS org's static groups, adds the device.
 *
 * Never fails enrollment. Legacy values (the old picker stored display strings
 * like "Contractors") are not UUIDs and are treated as unset. A deleted,
 * foreign-org, or dynamic group is skipped. The write runs in a savepoint so a
 * failed insert cannot abort the surrounding enrollment transaction.
 */
export async function applyOrgDefaultDeviceGroup(
  tx: Tx,
  input: { orgId: string; deviceId: string },
): Promise<DefaultGroupOutcome> {
  const { orgId, deviceId } = input;
  try {
    const [org] = await tx
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const defaults = (org?.settings as { defaults?: { deviceGroup?: unknown } } | null)?.defaults;
    const configured = defaults?.deviceGroup;
    if (typeof configured !== 'string' || !UUID_RE.test(configured)) return 'none';

    return await tx.transaction(async (sp) => {
      const [group] = await sp
        .select({ id: deviceGroups.id })
        .from(deviceGroups)
        .where(
          and(
            eq(deviceGroups.id, configured),
            eq(deviceGroups.orgId, orgId),
            eq(deviceGroups.type, 'static'),
          ),
        )
        .limit(1);

      if (!group) {
        console.warn(`[enroll] org ${orgId}: default device group ${configured} not found/eligible; skipping`);
        return 'skipped' as const;
      }

      await sp
        .insert(deviceGroupMemberships)
        .values({ deviceId, groupId: group.id, orgId, addedBy: 'manual' })
        .onConflictDoNothing();
      await sp.insert(groupMembershipLog).values({
        groupId: group.id,
        deviceId,
        orgId,
        action: 'added',
        reason: 'manual',
      });
      return 'added' as const;
    });
  } catch (err) {
    console.error(`[enroll] org ${orgId}: applying default device group failed; continuing`, err);
    captureException(err);
    return 'skipped';
  }
}
