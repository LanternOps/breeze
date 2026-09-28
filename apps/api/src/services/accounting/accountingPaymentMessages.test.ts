import { describe, expect, it } from 'vitest';
import {
  paymentAmountExceedsDueMessage,
  paymentCurrencyMismatchSuffix,
  paymentCustomerNotMappedMessage,
  paymentDeleteRecordFailedMessage,
  paymentInvoiceNotSyncedMessage,
  paymentInvoiceVoidMessage,
  paymentNotConnectedMessage,
  paymentPushDisabledMessage,
  paymentPushGaveUpMessageFor,
  paymentRecordConflictRetryMessage,
  paymentRecordFailedOrphanMessage,
  paymentRecordFailedRetryMessage,
  paymentRemoteAmbiguousMessage,
  paymentRemoteDeletedMessage,
  paymentRemoteLockedMessage,
  paymentRemoteMissingMessage,
  paymentSyncInProgressMessage,
  reconcileWindowTruncatedError,
  reconcileWindowTruncatedMessage,
} from './accountingPaymentMessages';

// Every function below must return, for 'QuickBooks', the EXACT literal the
// code held before Xero W05. These strings are persisted (last_error) and
// asserted by operators' saved searches; a drift is a QuickBooks regression.
describe('payment and reconcile operator text — QuickBooks byte-identical (Xero W05)', () => {
  it('reconcile truncated-window run error', () => {
    expect(reconcileWindowTruncatedMessage('QuickBooks')).toBe(
      'QuickBooks truncated the last change window and the backfill did not complete; payments may be missing',
    );
  });
  it('reconcile truncated-window Sentry/throw text', () => {
    expect(reconcileWindowTruncatedError('c-1', 'QuickBooks')).toBe(
      'accounting reconcile for connection c-1 could not be fully enumerated '
      + '(QuickBooks truncated the change window and the /query backfill did not complete)',
    );
  });
  it('labels Xero', () => {
    expect(reconcileWindowTruncatedMessage('Xero')).toBe(
      'Xero truncated the last change window and the backfill did not complete; payments may be missing',
    );
  });
});

describe('payment push operator text — QuickBooks byte-identical (Xero W05 refinement 22)', () => {
  const Q = 'QuickBooks';
  it.each<[string, string, string]>([
    ['push disabled', paymentPushDisabledMessage(Q), 'Payment push is disabled for this QuickBooks connection'],
    ['invoice not synced', paymentInvoiceNotSyncedMessage(Q), 'The invoice is not synced to QuickBooks yet; push the invoice first'],
    ['record failed orphan', paymentRecordFailedOrphanMessage(Q),
      'QuickBooks accepted the payment but Breeze could not record it; the QuickBooks Payment may be orphaned — contact support'],
    ['record failed retry', paymentRecordFailedRetryMessage('181', Q),
      'QuickBooks accepted the payment (remote id 181) but Breeze could not record it yet; '
      + 'Breeze is retrying briefly and will stop rather than create a second payment'],
    ['not connected', paymentNotConnectedMessage(Q), 'QuickBooks is not connected'],
    ['gave up', paymentPushGaveUpMessageFor('boom', Q),
      'QuickBooks payment push gave up after 100 attempts: boom. Fix the cause and push the invoice again.'],
    ['currency suffix', paymentCurrencyMismatchSuffix('USD', Q), ' Record this payment in USD or reconcile it in QuickBooks by hand.'],
    ['currency suffix, no home', paymentCurrencyMismatchSuffix(null, Q),
      ' Record this payment in the connected home currency or reconcile it in QuickBooks by hand.'],
    ['sync in progress', paymentSyncInProgressMessage(Q, 'sync'),
      'Another QuickBooks payment sync for this payment is already in flight; it will be retried'],
    ['delete in progress', paymentSyncInProgressMessage(Q, 'delete'),
      'Another QuickBooks payment delete for this payment is already in flight; it will be retried'],
    ['invoice void', paymentInvoiceVoidMessage(Q), 'Invoice was voided in Breeze; QuickBooks payments are not pushed to a void invoice'],
    ['customer not mapped', paymentCustomerNotMappedMessage(Q),
      'This organization is not mapped to a QuickBooks customer yet — confirm or create a mapping first'],
    ['record conflict retry', paymentRecordConflictRetryMessage(Q),
      'A database conflict interrupted recording the QuickBooks payment; it will be retried'],
    ['delete record failed', paymentDeleteRecordFailedMessage('181', Q),
      'QuickBooks removed the payment (remote id 181) but Breeze could not clear its mapping; the reconcile sweep will retry'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('the new refusal texts name the provider and the fix', () => {
    expect(paymentRemoteMissingMessage('Xero')).toBe(
      'The Xero invoice this payment belongs to is no longer approved there (voided, deleted or back to draft), '
      + 'so the payment cannot be recorded against it — check the invoice in Xero');
    expect(paymentAmountExceedsDueMessage('Xero')).toBe(
      'Xero refused the payment because it is more than the amount still due on the invoice there — '
      + 'check for a payment or credit already recorded in Xero, then push the invoice to Xero again');
    expect(paymentRemoteAmbiguousMessage('Xero')).toBe(
      'Xero holds a payment for this Breeze payment that Breeze cannot match (a duplicate, or a different amount) — '
      + 'delete the wrong one in Xero, then push the invoice to Xero again');
    expect(paymentRemoteDeletedMessage('Xero')).toBe(
      'This payment was deleted in Xero after Breeze sent it — push the invoice to Xero again to send it again');
    expect(paymentRemoteLockedMessage('Xero')).toBe(
      'Xero will not delete this payment because it is reconciled to a bank transaction — unreconcile it in Xero and delete it there');
  });
});
