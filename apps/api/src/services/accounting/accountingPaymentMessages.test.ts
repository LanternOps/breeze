import { describe, expect, it } from 'vitest';
import { reconcileWindowTruncatedError, reconcileWindowTruncatedMessage } from './accountingPaymentMessages';

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
