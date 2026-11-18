/**
 * Tool Catalog W06 (#5221, plan Decision 5) — the approval scope of a
 * `run_script_on_targets` step is DERIVED from the script, not hard-coded: it
 * is whatever core `run_script` classifies the same script as
 * (`checkGuardrails`; a classification the guardrails do not give falls back
 * to four_eyes, the column default). Shared by the step pin (flowValidator),
 * the fleet lane's eligibility (only `supervised` is pre-approvable) and the
 * parked intent (intentService), so the three never disagree.
 */
import { checkGuardrails } from '../../aiGuardrails';

export function fleetApprovalScope(input: Record<string, unknown>): 'supervised' | 'four_eyes' {
  const deviceIds = Array.isArray(input.deviceIds) ? input.deviceIds : [];
  const check = checkGuardrails('run_script', { scriptId: input.scriptId, deviceIds });
  return check.approvalScope === 'supervised' ? 'supervised' : 'four_eyes';
}
