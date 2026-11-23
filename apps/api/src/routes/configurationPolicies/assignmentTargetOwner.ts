/**
 * Who owns an assignment target (#12466, plan W02b G5): the organization a
 * site, device, org-owned device group or organization target lives in, or the
 * partner of a partner-owned device group or of the partner target itself.
 *
 * `GET /assignments/target` (the Site page listing) uses it to decide whether a
 * partner-scope caller may see the MSP-managed policies assigned to the target:
 * every row of one listing shares the target, so it runs at most one select.
 *
 * The read runs on the ambient `db`, in the caller's own RLS context: a target
 * the caller cannot read resolves to null, and the caller then sees no
 * MSP-managed row on it (fail closed).
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceGroups, devices, sites } from '../../db/schema';
import type { ConfigAssignmentLevel } from '../../services/configurationPolicy';

export type AssignmentTargetOwner =
  | { kind: 'organization'; orgId: string }
  | { kind: 'partner_group'; partnerId: string }
  | { kind: 'partner'; partnerId: string };

export async function resolveAssignmentTargetOwner(
  level: ConfigAssignmentLevel,
  targetId: string,
): Promise<AssignmentTargetOwner | null> {
  switch (level) {
    case 'partner':
      return { kind: 'partner', partnerId: targetId };
    case 'organization':
      return { kind: 'organization', orgId: targetId };
    case 'site': {
      const [site] = await db.select({ orgId: sites.orgId }).from(sites).where(eq(sites.id, targetId)).limit(1);
      return site ? { kind: 'organization', orgId: site.orgId } : null;
    }
    case 'device': {
      const [device] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, targetId)).limit(1);
      return device ? { kind: 'organization', orgId: device.orgId } : null;
    }
    case 'device_group': {
      // org_id XOR partner_id (#10521): a NULL org_id is a partner-owned group.
      const [group] = await db
        .select({ orgId: deviceGroups.orgId, partnerId: deviceGroups.partnerId })
        .from(deviceGroups)
        .where(eq(deviceGroups.id, targetId))
        .limit(1);
      if (!group) return null;
      if (group.orgId) return { kind: 'organization', orgId: group.orgId };
      return group.partnerId ? { kind: 'partner_group', partnerId: group.partnerId } : null;
    }
    default:
      return null;
  }
}
