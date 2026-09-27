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
 * A throw from deliver() never escapes. deliver() already handed the claimed
 * command back to `pending`, so the committed command runs at the device's
 * next check-in; the result says `send_failed` instead of failing the caller
 * for a run that is still going to happen.
 */
export async function deliverDeferredDispatch(
  dispatch: DispatchScriptResult,
  context: Record<string, unknown> = {},
): Promise<DispatchScriptResult> {
  if (!dispatch.ok || !dispatch.deliver) return dispatch;
  try {
    return await runOutsideDbContext(dispatch.deliver);
  } catch (err) {
    console.error('[scriptDispatch] deferred delivery threw; leaving the committed command queued', {
      ...context,
      commandId: dispatch.commandId,
      executionId: dispatch.executionId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err);
    return { ...dispatch, deliver: undefined, delivered: false, deliveryOutcome: 'send_failed' };
  }
}
