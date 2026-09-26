import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { topologyDiagnosticRuns, topologyMonitoringPolicies } from '../../db/schema';

type PolicyRow = typeof topologyMonitoringPolicies.$inferSelect;
const scoped = (scope: TopologyScope, table: { orgId: typeof topologyMonitoringPolicies.orgId; siteId: typeof topologyMonitoringPolicies.siteId } | { orgId: typeof topologyDiagnosticRuns.orgId; siteId: typeof topologyDiagnosticRuns.siteId }) =>
  and(eq(table.orgId, scope.orgId), eq(table.siteId, scope.siteId));

/**
 * Shared disarm write (route, diff-aware compiler, scheduler fences). Clears
 * the authority and contexts in one update and settles the policy's queued,
 * not-yet-dispatched scheduled runs. Runs already bound to a command are left
 * to delivery revalidation, which refuses them once the arm is gone.
 */
export async function disarmPolicyRow(
  scope: TopologyScope,
  row: Pick<PolicyRow, 'id'>,
  reason: string,
  extra: Partial<typeof topologyMonitoringPolicies.$inferInsert> = {},
): Promise<PolicyRow> {
  const now = new Date();
  const [updated] = await db
    .update(topologyMonitoringPolicies)
    .set({
      enabled: false,
      blockedReason: reason.slice(0, 64),
      authorityActor: null,
      authorityPermissionVersion: null,
      authorityDigest: null,
      armedAt: null,
      routingContexts: [],
      nextScheduledAt: null,
      authorityGeneration: sql`${topologyMonitoringPolicies.authorityGeneration}+1`,
      revision: sql`${topologyMonitoringPolicies.revision}+1`,
      updatedAt: now,
      ...extra,
    })
    .where(and(scoped(scope, topologyMonitoringPolicies), eq(topologyMonitoringPolicies.id, row.id)))
    .returning();
  if (!updated) throw new Error('topology monitoring policy disappeared while disarming');
  await db
    .update(topologyDiagnosticRuns)
    .set({ state: 'cancelled', finishedAt: now, failureReason: 'policy_disarmed', updatedAt: now })
    .where(and(
      scoped(scope, topologyDiagnosticRuns),
      eq(topologyDiagnosticRuns.policyId, row.id),
      eq(topologyDiagnosticRuns.state, 'queued'),
      isNull(topologyDiagnosticRuns.commandId),
    ));
  return updated;
}

