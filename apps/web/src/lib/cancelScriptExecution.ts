import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';

/**
 * Single client-side path for stopping a script execution (#4767, #5318).
 *
 * ScriptExecutionsPage and the device page's Scripts tab both offer Stop; this
 * keeps them on one request shape, one runAction contract and one translation
 * of the route's dynamic 409 body, rather than a second cancel path that
 * drifts. The API re-checks scripts:execute — the UI gate is UX only.
 */

/**
 * Mirrors the API's own default (apps/api/src/services/scriptCancellation.ts).
 * Force stop always sends 0 regardless of this constant.
 */
export const SCRIPT_CANCEL_DEFAULT_GRACE_SECONDS = 5;

export type CancelScriptExecutionOptions = {
  executionId: string;
  graceSeconds: number;
  /** Toast copy for any failure without a friendlier mapping below. */
  errorFallback: string;
  /** Toast copy for the route's "already finished" 409. */
  noLongerCancellableMessage: string;
  onUnauthorized?: () => void;
};

export function requestScriptExecutionCancel({
  executionId,
  graceSeconds,
  errorFallback,
  noLongerCancellableMessage,
  onUnauthorized,
}: CancelScriptExecutionOptions): Promise<unknown> {
  return runAction({
    request: () =>
      fetchWithAuth(`/scripts/executions/${executionId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ graceSeconds }),
      }),
    errorFallback,
    // The route's 409 body is a dynamic message ("Cannot cancel execution with
    // status: completed"), not a machine token — matched by prefix rather than
    // exact-equality against a `code` field the route never sends.
    friendly: (token) =>
      typeof token === 'string' && token.startsWith('Cannot cancel execution with status')
        ? noLongerCancellableMessage
        : undefined,
    onUnauthorized,
  });
}
