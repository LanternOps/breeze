/**
 * Schedules a compliance-alert reconcile (complianceAlertReconcile.ts) after a
 * config write that can make a compliance rule stop applying: a rule set saved
 * or removed, the compliance feature added or removed, a policy deactivated or
 * deleted, an assignment added or removed.
 *
 * Kept apart from the reconcile itself so configurationPolicy.ts pulls in
 * nothing but the DB helper; the queue module is imported only when the
 * request's transaction has settled.
 */
import { runAfterDbContextExit } from '../db';

/**
 * Which alerts a reconcile looks at. A policy id is resolved to its owner when
 * the reconcile runs (the owning org, or every org under the owning partner);
 * a deleted policy passes its owner directly.
 */
export type ComplianceAlertReconcileScope =
  | { configPolicyId: string }
  | { orgId: string }
  | { partnerId: string };

/**
 * Enqueues the reconcile once the caller's transaction has committed (or
 * rolled back; the reconcile only closes alerts whose rule no longer applies,
 * so running it either way is safe). Never throws: the config write must not
 * fail over this, and the periodic sweep closes the same alerts within one
 * interval.
 */
export function scheduleComplianceAlertReconcile(scope: ComplianceAlertReconcileScope, trigger: string): void {
  try {
    runAfterDbContextExit(`complianceAlertReconcile.${trigger}`, async () => {
      const { enqueueComplianceAlertReconcile } = await import('../jobs/policyEvaluationWorker');
      await enqueueComplianceAlertReconcile(scope);
    });
  } catch (error) {
    console.error(
      `[complianceAlertReconcile] could not schedule a reconcile after ${trigger}; the periodic sweep will close the alerts:`,
      error,
    );
  }
}
