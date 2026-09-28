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

import { providerPermissionMessage } from './accountingProviderError';

/** The reconcile worker's connection-level run error when a change window could not be fully enumerated. */
export function reconcileWindowTruncatedMessage(label: string): string {
  return `${label} truncated the last change window and the backfill did not complete; payments may be missing`;
}

/** The matching thrown/Sentry text. */
export function reconcileWindowTruncatedError(connectionId: string, label: string): string {
  return `accounting reconcile for connection ${connectionId} could not be fully enumerated `
    + `(${label} truncated the change window and the /query backfill did not complete)`;
}

// ---------------------------------------------------------------------------
// Payment push coordinator (accountingPaymentPush.ts). Persisted text: each is
// pinned byte-identical for 'QuickBooks' in accountingPaymentMessages.test.ts.
// ---------------------------------------------------------------------------

/**
 * How many failed attempts a `pending_op = 'push'` row gets before Breeze stops
 * asking. Lives here because the give-up text quotes it; `accountingPaymentPush`
 * re-exports it and documents the arithmetic.
 */
export const PAYMENT_PUSH_MAX_ATTEMPTS = 100;

/** Stamped when the connection's payment push setting is off. */
export function paymentPushDisabledMessage(label: string): string {
  return `Payment push is disabled for this ${label} connection`;
}

/** Stamped when a payment's own invoice has not reached the provider yet. */
export function paymentInvoiceNotSyncedMessage(label: string): string {
  return `The invoice is not synced to ${label} yet; push the invoice first`;
}

/** The retired `record_failed` state: the provider holds a Payment Breeze cannot name. */
export function paymentRecordFailedOrphanMessage(label: string): string {
  return `${label} accepted the payment but Breeze could not record it; `
    + `the ${label} Payment may be orphaned — contact support`;
}

/** The WHILE-RETRYING `record_failed` state. */
export function paymentRecordFailedRetryMessage(remoteId: string, label: string): string {
  return `${label} accepted the payment (remote id ${remoteId}) but Breeze could not record it yet; `
    + 'Breeze is retrying briefly and will stop rather than create a second payment';
}

/** Stamped by the sync worker when a payment job finds no connected connection. */
export function paymentNotConnectedMessage(label: string): string {
  return `${label} is not connected`;
}

/** A push row that burned through `PAYMENT_PUSH_MAX_ATTEMPTS`, quoting the last failure. */
export function paymentPushGaveUpMessageFor(previous: string, label: string): string {
  return `${label} payment push gave up after ${PAYMENT_PUSH_MAX_ATTEMPTS} attempts: ${previous}. `
    + 'Fix the cause and push the invoice again.';
}

/** Appended to a currency-contract message on a `currency_mismatch` refusal (leading space included). */
export function paymentCurrencyMismatchSuffix(home: string | null, label: string): string {
  return ` Record this payment in ${home ?? 'the connected home currency'} or reconcile it in ${label} by hand.`;
}

/** A lease CAS miss on a row that still owes the operation. Thrown, never persisted. */
export function paymentSyncInProgressMessage(label: string, op: 'sync' | 'delete'): string {
  return `Another ${label} payment ${op} for this payment is already in flight; it will be retried`;
}

/** A payment whose invoice was voided in Breeze. */
export function paymentInvoiceVoidMessage(label: string): string {
  return `Invoice was voided in Breeze; ${label} payments are not pushed to a void invoice`;
}

/** The invoice's organization has no confirmed customer mapping. */
export function paymentCustomerNotMappedMessage(label: string): string {
  return `This organization is not mapped to a ${label} customer yet — confirm or create a mapping first`;
}

/** A deadlock/serialization failure while recording an accepted create. */
export function paymentRecordConflictRetryMessage(label: string): string {
  return `A database conflict interrupted recording the ${label} payment; it will be retried`;
}

/** The provider deleted the Payment but Breeze could not drop its mapping row. */
export function paymentDeleteRecordFailedMessage(remoteId: string, label: string): string {
  return `${label} removed the payment (remote id ${remoteId}) but Breeze could not clear its mapping; the reconcile sweep will retry`;
}

// ---- Provider refusals (Xero W05 refinement 16): terminal, operator-resolved ----

/** Create refused with `remote_missing`: the remote invoice is no longer approved. */
export function paymentRemoteMissingMessage(label: string): string {
  return `The ${label} invoice this payment belongs to is no longer approved there (voided, deleted or back to draft), `
    + `so the payment cannot be recorded against it — check the invoice in ${label}`;
}

/** Create refused with `amount_exceeds_due`: an over-application on the remote invoice. */
export function paymentAmountExceedsDueMessage(label: string): string {
  return `${label} refused the payment because it is more than the amount still due on the invoice there — `
    + `check for a payment or credit already recorded in ${label}, then push the invoice to ${label} again`;
}

/** Create refused with `duplicate_key`: a remote payment carries Breeze's key but does not match. */
export function paymentRemoteAmbiguousMessage(label: string): string {
  return `${label} holds a payment for this Breeze payment that Breeze cannot match (a duplicate, or a different amount) — `
    + `delete the wrong one in ${label}, then push the invoice to ${label} again`;
}

/** Create refused with `remote_deleted`: the payment Breeze sent was deleted remotely. */
export function paymentRemoteDeletedMessage(label: string): string {
  return `This payment was deleted in ${label} after Breeze sent it — push the invoice to ${label} again to send it again`;
}

/**
 * Create refused with `insufficient_scope`. The owed push is cleared on a
 * create refusal, so reconnecting alone never sends the payment — the text adds
 * the re-push step. A DELETE refusal keeps the plain `providerPermissionMessage`:
 * that row stays owed and the sweep retries it after the reconnect.
 */
export function paymentProviderPermissionMessage(label: string): string {
  return `${providerPermissionMessage(label)}, then push the invoice to ${label} again`;
}

/** Delete refused with `remote_locked`: the remote payment is reconciled to a bank transaction. */
export function paymentRemoteLockedMessage(label: string): string {
  return `${label} will not delete this payment because it is reconciled to a bank transaction — unreconcile it in ${label} and delete it there`;
}

/**
 * Delete refused with `remote_batched` (#7300): the remote payment is one member
 * of a batch payment, which the provider changes only as a whole. The text does
 * not claim what deleting the batch does to its other members — the bookkeeper
 * checks them, since they may be other Breeze payments.
 */
export function paymentRemoteBatchedMessage(label: string): string {
  return `${label} will not delete this payment on its own because it is part of a batch payment there — `
    + `delete it through the batch payment in ${label}, and check the other payments in that batch first`;
}
