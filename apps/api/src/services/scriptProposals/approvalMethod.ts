import type { AiApprovalScope, ScriptApprovalMethod } from '@breeze/shared';

/**
 * The part of a released `action_intents` row that determines HOW a
 * proposal-backed run was authorised (spec §4.6 decision record). Carried to
 * the `run_script` handler on `ToolExecutionContext.releaseDecision` by both
 * release paths (jobs/intentReleaseWorker.ts, services/aiAgentSdk.ts).
 */
export interface ReleaseDecision {
  approvalScope: AiApprovalScope;
  decidedVia: string | null;
}

/**
 * Spec §4.1 — the `approval_method` provenance value for a run released by
 * `intent` (#5645). Derived, never a constant:
 *
 *  - `decided_via = 'script_reviewer'` → `unattended_reviewer_gated`: the lane's
 *    reviewer decided it, whatever scope the classifier assigned (the lane only
 *    admits supervised intents today, but the decision record is the truth);
 *  - otherwise the intent's scope: `supervised` → `supervised_self` (the
 *    requester decided their own intent), `four_eyes` → `four_eyes`.
 *
 * The W06 risk dashboard's "unattended runs" metric, the device-activity audit
 * row and the library provenance panel all read the stored value, so a wrong
 * constant here is a wrong audit trail — the bug this replaces.
 */
export function approvalMethodForRelease(intent: ReleaseDecision): ScriptApprovalMethod {
  if (intent.decidedVia === 'script_reviewer') return 'unattended_reviewer_gated';
  return intent.approvalScope === 'supervised' ? 'supervised_self' : 'four_eyes';
}
