/**
 * Peripheral reconciliation after a config write that changes which devices a
 * Peripheral Control feature link governs (#9619): the link added / re-pointed /
 * removed, the config policy deactivated or deleted, an assignment added or
 * removed.
 *
 * A linked peripheral policy applies to the devices its config policy resolves
 * to; an unlinked one falls back to its own targeting (see
 * PeripheralConfigLinkResolution). Either transition moves devices in or out of
 * the policy, so each affected device is re-reconciled
 * (`schedulePeripheralPolicyDevice`). Affected devices are the union of
 *   - the devices the config policy (and children inheriting its link) is
 *     assigned to, expanded per assignment level (partner-wide assignments fan
 *     out through the device org's partner), and
 *   - when `standalone` is set, the devices the peripheral policy's own
 *     targeting covers (they enter or leave link governance with the write).
 * Over-approximating is harmless: reconcile is idempotent and digest-gated.
 *
 * Kept apart from configurationPolicy.ts so that module imports nothing but the
 * DB helper; the queue and resolver modules load only after the request's
 * transaction has committed.
 */
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  peripheralPolicies,
} from '../db/schema';

export type PeripheralLinkAssignment = { level: string; targetId: string };

export type PeripheralLinkReconcileScope = {
  /** Config policy whose assignments (and its children's) define the devices. */
  configPolicyId?: string;
  /** Explicit assignments; overrides the lookup from `configPolicyId`. */
  assignments?: PeripheralLinkAssignment[];
  /** Peripheral policies in play beyond the config policy's current links. */
  peripheralPolicyIds?: string[];
  /** Also reconcile the peripheral policies' own standalone target devices. */
  standalone?: boolean;
};

/** Config-policy ids that share `configPolicyId`'s links: itself plus children. */
async function holderPolicyIds(configPolicyId: string): Promise<string[]> {
  const children = await db
    .select({ id: configurationPolicies.id })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.parentPolicyId, configPolicyId));
  return [configPolicyId, ...children.map((c) => c.id)];
}

async function linkedPeripheralPolicyIds(configPolicyId: string): Promise<string[]> {
  const rows = await db
    .select({ featurePolicyId: configPolicyEffectiveFeatureLinks.featurePolicyId })
    .from(configPolicyEffectiveFeatureLinks)
    .where(and(
      eq(configPolicyEffectiveFeatureLinks.featureType, 'peripheral_control'),
      isNotNull(configPolicyEffectiveFeatureLinks.featurePolicyId),
      or(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configPolicyId),
        eq(configPolicyEffectiveFeatureLinks.sourcePolicyId, configPolicyId),
      ),
    ));
  return rows.flatMap((r) => (r.featurePolicyId ? [r.featurePolicyId] : []));
}

/**
 * Snapshot taken BEFORE a config policy is deleted: the cascade removes its
 * links and assignments, after which the affected devices can no longer be
 * derived. Null when the policy carries no peripheral link.
 */
export async function capturePeripheralLinkDeleteScope(
  configPolicyId: string,
): Promise<{ assignments: PeripheralLinkAssignment[]; peripheralPolicyIds: string[] } | null> {
  const peripheralPolicyIds = await linkedPeripheralPolicyIds(configPolicyId);
  if (peripheralPolicyIds.length === 0) return null;
  return { assignments: await assignmentsOfHolders(configPolicyId), peripheralPolicyIds };
}

async function assignmentsOfHolders(configPolicyId: string): Promise<PeripheralLinkAssignment[]> {
  const holders = await holderPolicyIds(configPolicyId);
  return db
    .select({ level: configPolicyAssignments.level, targetId: configPolicyAssignments.targetId })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, holders));
}

export async function resolvePeripheralLinkAffectedDeviceIds(
  scope: PeripheralLinkReconcileScope,
): Promise<string[]> {
  const policyIds = new Set(scope.peripheralPolicyIds ?? []);
  if (scope.configPolicyId) {
    for (const id of await linkedPeripheralPolicyIds(scope.configPolicyId)) policyIds.add(id);
  }
  // Nothing peripheral is linked or was just unlinked: this write is irrelevant.
  if (policyIds.size === 0) return [];

  const assignments = scope.assignments
    ?? (scope.configPolicyId ? await assignmentsOfHolders(scope.configPolicyId) : []);

  const { resolveAssignmentDeviceIds } = await import('./featureConfigResolver');
  const deviceIds = new Set<string>();
  for (const assignment of assignments) {
    for (const id of await resolveAssignmentDeviceIds(assignment.level, assignment.targetId)) deviceIds.add(id);
  }

  if (scope.standalone) {
    const { resolvePeripheralPolicyDeviceIds } = await import('../jobs/peripheralJobs');
    const policies = await db
      .select({
        orgId: peripheralPolicies.orgId,
        partnerId: peripheralPolicies.partnerId,
        targetType: peripheralPolicies.targetType,
        targetIds: peripheralPolicies.targetIds,
        isActive: peripheralPolicies.isActive,
      })
      .from(peripheralPolicies)
      .where(inArray(peripheralPolicies.id, [...policyIds]));
    for (const policy of policies) {
      for (const id of await resolvePeripheralPolicyDeviceIds(policy)) deviceIds.add(id);
    }
  }
  return [...deviceIds].sort();
}

/**
 * Enqueues per-device peripheral reconciliation once the caller's transaction
 * has COMMITTED (a rolled-back link write changes nothing to reconcile). Never
 * throws: the config write must not fail over this; the periodic peripheral
 * reconciliation sweep converges the same devices.
 */
export function schedulePeripheralLinkReconcile(scope: PeripheralLinkReconcileScope, trigger: string): void {
  try {
    runAfterDbContextCommit(`peripheralLinkReconcile.${trigger}`, async () => {
      try {
        const { schedulePeripheralPolicyDevices } = await import('../jobs/peripheralJobs');
        const deviceIds = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() => resolvePeripheralLinkAffectedDeviceIds(scope)));
        if (deviceIds.length === 0) return;
        await schedulePeripheralPolicyDevices(deviceIds, `config_policy_${trigger.replace(/-/g, '_')}`);
      } catch (error) {
        console.error(
          `[peripheralLinkReconcile] could not reconcile after ${trigger}; the periodic sweep will converge:`,
          error,
        );
      }
    });
  } catch (error) {
    console.error(`[peripheralLinkReconcile] could not schedule after ${trigger}:`, error);
  }
}
