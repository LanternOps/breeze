import { runOutsideDbContext } from '../db';
import type { DispatchScriptResult } from './scriptDispatch';
import { captureException } from './sentry';

/**
 * #7103 — delivers a `deferDelivery` dispatch once the transaction that
 * created its rows has committed. Pass-through for a refusal or an immediate
 * dispatch (no `deliver`).
 *
 * MUST be called after that transaction committed: `runOutsideDbContext` only
 * hides an ambient context from the ALS lookup, it does not commit one.
 *
 * A throw from deliver() never escapes. The committed command is either
 * still `pending` (a throw before the claim) or claimed and kept: a relay
 * facade rejection means the frame may be out, so the claim is NOT released
 * and the agent's result or the stale reaper settles the row (#4142). Pending
 * runs at the agent's next check-in; claimed and kept runs if the frame reached
 * the agent, otherwise the reaper settles it. Either way the row is settled, so
 * the result says `send_failed` instead of failing the caller.
 */
export async function deliverDeferredDispatch(
  dispatch: DispatchScriptResult,
  context: Record<string, unknown> = {},
): Promise<DispatchScriptResult> {
  if (!dispatch.ok || !dispatch.deliver) return dispatch;
  try {
    return await runOutsideDbContext(dispatch.deliver);
  } catch (err) {
    console.error('[scriptDispatch] deferred delivery threw; leaving the committed command to its result or the reaper', {
      ...context,
      commandId: dispatch.commandId,
      executionId: dispatch.executionId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err);
    return { ...dispatch, deliver: undefined, delivered: false, deliveryOutcome: 'send_failed' };
  }
}
