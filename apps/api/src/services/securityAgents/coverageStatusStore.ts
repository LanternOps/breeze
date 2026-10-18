import { and, eq, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { securityAgentDeviceStatus } from '../../db/schema';
import type { ReadinessReason } from './installerReadiness';
import type { VendorKey } from './securityAgentVendors';

/**
 * Compliance-worker half of `security_agent_device_status` (#6960 W03).
 *
 * The software compliance worker evaluates a generated (security agents)
 * policy's rules against every device it reaches. For each (device, vendor) it
 * records here whether the vendor can serve the device:
 *
 *  - not ready → `not_applicable` with the readiness reason (org not mapped,
 *    platform unsupported, …). This REPLACES whatever state the row had.
 *  - ready     → a row that was `not_applicable` (or new) becomes `pending`
 *    for the coverage reconciler to classify. Any other state belongs to the
 *    reconciler and is left alone.
 *
 * `org_id` is always the DEVICE's org (the caller passes the org it read from
 * `devices` in this pass), never the policy owner's: a partner-wide policy has
 * `org_id` NULL and reaches many orgs.
 *
 * A full pass also prunes the policy's rows for devices it no longer reaches
 * and vendors it no longer has, so coverage never reports a device the policy
 * dropped. A device-filtered pass prunes nothing.
 *
 * Runs in its OWN system-scope transaction: the compliance worker's context is
 * a single transaction, and a failed statement here must not abort it (a
 * swallowed error inside a shared transaction still poisons the commit).
 */

export interface ManagedApplicabilityEntry {
  deviceId: string;
  orgId: string;
  vendor: VendorKey;
  notApplicableReason: ReadinessReason | null;
}

export interface RecordManagedApplicabilityParams {
  policyId: string;
  entries: readonly ManagedApplicabilityEntry[];
  /** Full pass only: every device the pass reached and every vendor the policy has. */
  prune: { deviceIds: readonly string[]; vendors: readonly VendorKey[] } | null;
}

const UPSERT_CHUNK = 1000;

const t = securityAgentDeviceStatus;

export async function recordManagedPolicyApplicability(
  params: RecordManagedApplicabilityParams,
): Promise<{ upserted: number; pruned: number }> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      let upserted = 0;
      for (let i = 0; i < params.entries.length; i += UPSERT_CHUNK) {
        const chunk = params.entries.slice(i, i + UPSERT_CHUNK);
        const rows = await db
          .insert(t)
          .values(chunk.map((entry) => ({
            orgId: entry.orgId,
            deviceId: entry.deviceId,
            vendor: entry.vendor,
            state: entry.notApplicableReason ? 'not_applicable' as const : 'pending' as const,
            reasonCode: entry.notApplicableReason,
            detail: null,
            policyId: params.policyId,
          })))
          .onConflictDoUpdate({
            target: [t.deviceId, t.vendor],
            targetWhere: isNotNull(t.deviceId),
            set: {
              orgId: sql`excluded.org_id`,
              policyId: sql`excluded.policy_id`,
              lastEvaluatedAt: sql`now()`,
              state: sql`CASE
                WHEN excluded.state = 'not_applicable' THEN 'not_applicable'
                WHEN ${t.state} = 'not_applicable' THEN 'pending'
                ELSE ${t.state}
              END`,
              reasonCode: sql`CASE
                WHEN excluded.state = 'not_applicable' THEN excluded.reason_code
                WHEN ${t.state} = 'not_applicable' THEN NULL
                ELSE ${t.reasonCode}
              END`,
              detail: sql`CASE
                WHEN excluded.state = 'not_applicable' OR ${t.state} = 'not_applicable' THEN NULL
                ELSE ${t.detail}
              END`,
              stateChangedAt: sql`CASE
                WHEN (excluded.state = 'not_applicable') <> (${t.state} = 'not_applicable') THEN now()
                WHEN excluded.state = 'not_applicable' AND excluded.reason_code IS DISTINCT FROM ${t.reasonCode} THEN now()
                ELSE ${t.stateChangedAt}
              END`,
            },
          })
          .returning({ id: t.id });
        upserted += rows.length;
      }

      let pruned = 0;
      if (params.prune) {
        const outOfScope = [
          params.prune.deviceIds.length > 0 ? notInArray(t.deviceId, [...params.prune.deviceIds]) : sql`true`,
          params.prune.vendors.length > 0 ? notInArray(t.vendor, [...params.prune.vendors]) : sql`true`,
        ];
        const rows = await db
          .delete(t)
          .where(and(
            eq(t.policyId, params.policyId),
            isNotNull(t.deviceId),
            or(...outOfScope),
          ))
          .returning({ id: t.id });
        pruned = rows.length;
      }
      return { upserted, pruned };
    }, 'securityAgentCoverage.recordApplicability'),
  );
}

/** Delete every device row a policy owns (a full pass that reached no device). */
export function pruneAllForPolicy(policyId: string): Promise<{ upserted: number; pruned: number }> {
  return recordManagedPolicyApplicability({ policyId, entries: [], prune: { deviceIds: [], vendors: [] } });
}
