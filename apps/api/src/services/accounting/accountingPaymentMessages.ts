/**
 * Provider-labelled operator text for payment pull, payment push and the
 * reconcile worker (Xero W05; W01d deferral R3). `label` is the provider's
 * display name (`accountingProviderDisplayName`). With 'QuickBooks' every
 * function returns the exact literal the code held before W05 — these strings
 * are persisted in `last_error` / `accounting_connections.last_error`, and
 * `accountingPaymentMessages.test.ts` pins each one.
 *
 * No provider-id literal lives here (neutral-core guard).
 */

/** The reconcile worker's connection-level run error when a change window could not be fully enumerated. */
export function reconcileWindowTruncatedMessage(label: string): string {
  return `${label} truncated the last change window and the backfill did not complete; payments may be missing`;
}

/** The matching thrown/Sentry text. */
export function reconcileWindowTruncatedError(connectionId: string, label: string): string {
  return `accounting reconcile for connection ${connectionId} could not be fully enumerated `
    + `(${label} truncated the change window and the /query backfill did not complete)`;
}
