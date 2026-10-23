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
  input: { orgId: string; deviceId: string; siteId?: string | null },
): Promise<DefaultGroupOutcome> {
  const { orgId, deviceId, siteId } = input;
  try {
    return await tx.transaction(async (sp) => {
      const [org] = await sp
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      const defaults = (org?.settings as { defaults?: { deviceGroup?: unknown } } | null)?.defaults;
      const configured = defaults?.deviceGroup;
      if (typeof configured !== 'string' || !UUID_RE.test(configured)) return 'none' as const;

      const [group] = await sp
        .select({ id: deviceGroups.id, siteId: deviceGroups.siteId })
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

      // A site-scoped group only takes devices from its own site (same rule as
      // the manual add path in routes/groups.ts).
      if (group.siteId && group.siteId !== siteId) {
        console.warn(`[enroll] org ${orgId}: default device group ${configured} is scoped to another site; skipping`);
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
