/**
 * Tool Catalog W05 (#5220), plan Task B2 / Decision 12 — executing an
 * APPROVED Tier-3 built-in step (an `http_request` write) from the release
 * worker's flow branch. The worker has already taken the flow-aware dispatch
 * claim (run parked on this intent, flow live on the run's publication,
 * delegator still authorized incl. rule 7, step still matching its pin) and
 * revalidated the intent (digest, tier, flow principal, org). What runs is
 * the intent's immutable `arguments` — exactly what the approver saw —
 * through `executeFlowBuiltin` under the run's flow principal; the worker
 * wraps this call in the run's flowExecutionContext frame.
 *
 * The result goes back to the worker as the string it stores and classifies:
 *  - completed ⇒ the step output (JSON);
 *  - failed    ⇒ `{ error, flowStepError: { code, policy } }`, a returned
 *                error (`tool_returned_error`); the run wake keeps the
 *                built-in's code and policy (runLedger.resolveParkedIntent);
 *  - unknown_outcome ⇒ throws `FlowBuiltinMayHaveRunError`, which the
 *                worker records as `execution_error` with `executedAt` set, so
 *                the wake ends the run `unknown_outcome` (never retried).
 */
import { isFlowBuiltin } from '@breeze/shared';
import type { ActionIntent } from '../../../db/schema/actionIntents';
import type { AuthContext } from '../../../middleware/auth';
import type { ToolOwnerRef } from '../../toolSources/resolver';
import { executeFlowBuiltin } from './index';
import { isFlowBuiltinIntent } from './intentKind';
import { loadReleasedBuiltinStep } from './releaseStore';
import { countRunBuiltinCalls } from './runCounters';

export class FlowBuiltinMayHaveRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowBuiltinMayHaveRunError';
  }
}

/** Refused before anything was sent (the worker records a clean failure, never `executed`). */
export class FlowBuiltinNotRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowBuiltinNotRunError';
  }
}

export { isFlowBuiltinIntent };

export async function executeReleasedFlowBuiltin(intent: ActionIntent, auth: AuthContext): Promise<string> {
  const name = intent.actionName;
  if (!isFlowBuiltinIntent(intent) || !isFlowBuiltin(name)) {
    throw new FlowBuiltinNotRunError(`Intent ${intent.id} is not a flow built-in step`);
  }
  const runId = intent.requestingFlowRunId!;
  if (auth.principal?.kind !== 'flow' || auth.principal.runId !== runId || !auth.partnerId) {
    throw new FlowBuiltinNotRunError(`Intent ${intent.id}: the release principal is not this run's flow principal`);
  }
  const loaded = await loadReleasedBuiltinStep(runId, intent.id);
  if (!loaded || loaded.step.tool !== name || loaded.run.orgId !== intent.orgId) {
    throw new FlowBuiltinNotRunError(`Intent ${intent.id}: the parked built-in step no longer exists on its run`);
  }
  const { run, version, step, stepRowId, itemIndex } = loaded;
  const owner: ToolOwnerRef = version.orgId
    ? { orgId: version.orgId, partnerId: auth.partnerId }
    : { orgId: null, partnerId: auth.partnerId };

  const outcome = await executeFlowBuiltin(name, intent.arguments as Record<string, unknown>, {
    run,
    version,
    step,
    owner,
    auth,
    stepRowId,
    itemIndex,
    deadline: Date.now() + step.timeoutSec * 1000,
    counters: await countRunBuiltinCalls(run.id),
    leaseToken: null,
  });

  switch (outcome.kind) {
    case 'completed':
      return JSON.stringify(outcome.output);
    case 'failed':
      return JSON.stringify({ error: outcome.message, flowStepError: { code: outcome.code, policy: outcome.policy } });
    case 'unknown_outcome':
      throw new FlowBuiltinMayHaveRunError(outcome.message);
    default:
      // skipped / parked outcomes are unreachable for an approved Tier-3 built-in.
      throw new Error(`Intent ${intent.id}: unexpected built-in outcome '${outcome.kind}' at release`);
  }
}
