/**
 * The stable operation key (#5205 W06), spec §6.5.
 *
 * "Its identity includes task, step, target, workflow version, approved plan
 * revision, and semantic operation ordinal; delivery retries do not change
 * it." Task and org are the row's other unique columns
 * (`ai_operator_operations_org_task_op_uq`), so this string carries the rest.
 *
 * TWO OMISSIONS ARE THE DESIGN, not oversights:
 *
 *  - `attemptOrdinal` is NOT in the key. A continuation run re-proposing the
 *    SAME operation must converge on the EXISTING row — that convergence is
 *    what makes attempt 2 attach to attempt 1's approved intent instead of
 *    minting a second one for a human to approve twice (spec §6.5, and the
 *    reason `actionIntentTaskContextSchema` carries `attemptOrdinal` as
 *    lineage rather than identity).
 *  - Nothing model-authored is in the key. The tool name and the resolved
 *    target come from server-side values; the ARGUMENTS are covered
 *    separately by `argument_digest`, so two proposals that differ only in
 *    their arguments collide on the key and are caught as the conflict spec
 *    §6.5 says they are ("the same key with different arguments is a
 *    conflict"), rather than silently becoming two operations.
 *
 * `planRevision` IS in the key, and that is what makes a genuine plan change
 * (a new reasoning attempt admitted after FAILED verification) a new
 * operation needing its own approval, rather than a silent replay of an
 * approval granted for the previous plan.
 */

/** Max length of `ai_operator_operations.operation_key` (CHECK, W03 migration). */
export const OPERATION_KEY_MAX_LENGTH = 200;

export interface TaskOperationKeyParts {
  /** `ai_operator_tasks.current_step_key` at proposal time. */
  taskStepKey: string;
  /** `ai_operator_tasks.revision` READ IN THE SAME PASS as the proposal. */
  planRevision: number;
  /** The tool being proposed, e.g. `manage_services`. */
  toolName: string;
  /** The resolved target id (device), or `'none'` for a non-targeted op. */
  targetId: string | null;
  /** Semantic ordinal within (step, plan revision). Almost always 0. */
  ordinal: number;
}

/**
 * Build the key. Every component is `:`-joined and individually sanitised so
 * a component containing a colon cannot shift the meaning of the ones after
 * it — the key is compared for equality, so an ambiguous encoding would let
 * two different identities produce one string.
 */
export function buildTaskOperationKey(parts: TaskOperationKeyParts): string {
  const segment = (value: string): string =>
    value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48) || '_';

  const key = [
    segment(parts.taskStepKey),
    segment(parts.toolName),
    segment(parts.targetId ?? 'none'),
    `r${Math.max(0, Math.trunc(parts.planRevision))}`,
    `n${Math.max(0, Math.trunc(parts.ordinal))}`,
  ].join(':');

  // Truncation would silently merge two identities, so refuse instead. The
  // components are all bounded above, so this is unreachable in practice and
  // is here as an assertion rather than as a runtime branch anyone expects.
  if (key.length > OPERATION_KEY_MAX_LENGTH) {
    throw new Error(`[aiOperator] operation key exceeds ${OPERATION_KEY_MAX_LENGTH} chars: ${key.length}`);
  }
  return key;
}
