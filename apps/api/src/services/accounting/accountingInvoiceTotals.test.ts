import { describe, expect, it } from 'vitest';
import {
  assertPushedLinesMatchSubtotal,
  computeRemoteVariance,
  pushedLineAmounts,
} from './accountingInvoiceTotals';
import { AccountingInvoicePushError } from './accountingInvoicePushErrors';

// Provider-neutral home of the #7161 totals invariant (Xero W01 Task 11). The
// full push-flow tests for the same behaviour stay in
// accountingInvoicePush.test.ts; these pin the helpers in isolation so every
// provider shares one contract.

const line = (lineTotal: string) => ({ lineTotal });

describe('accountingInvoiceTotals (provider-neutral, #7161 moved)', () => {
  describe('pushedLineAmounts', () => {
    it('pushes a hidden priced line at zero', () => {
      expect(pushedLineAmounts({ customerVisible: false, unitPrice: '50.00', lineTotal: '50.00' }))
        .toEqual({ unitPrice: '0.00', lineTotal: '0.00' });
    });

    it('passes a visible line through at its stored amounts', () => {
      expect(pushedLineAmounts({ customerVisible: true, unitPrice: '25.00', lineTotal: '50.00' }))
        .toEqual({ unitPrice: '25.00', lineTotal: '50.00' });
    });
  });

  describe('assertPushedLinesMatchSubtotal', () => {
    it('passes when the pushed lines sum to the subtotal exactly', () => {
      expect(() => assertPushedLinesMatchSubtotal({ subtotal: '100.00' }, [line('100.00'), line('0.00')], 'Xero'))
        .not.toThrow();
    });

    it('compares in exact cents, not floats (0.10 + 0.20 equals 0.30)', () => {
      expect(() => assertPushedLinesMatchSubtotal({ subtotal: '0.30' }, [line('0.10'), line('0.20')], 'Xero'))
        .not.toThrow();
    });

    it('refuses with invoice_totals_mismatch (409) when they do not', () => {
      let caught: unknown;
      try {
        assertPushedLinesMatchSubtotal({ subtotal: '100.00' }, [line('100.00'), line('50.00')], 'Xero');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AccountingInvoicePushError);
      expect(caught).toMatchObject({ code: 'invoice_totals_mismatch', status: 409 });
    });

    it('fails closed on an amount that is not a plain 2-decimal number, even if a float sum would match', () => {
      expect(() => assertPushedLinesMatchSubtotal({ subtotal: '100.00' }, [line('1e2')], 'Xero'))
        .toThrow(expect.objectContaining({ code: 'invoice_totals_mismatch', status: 409 }));
    });

    it('keeps the QuickBooks message byte-identical to #7161 when labelled QuickBooks', () => {
      expect(() => assertPushedLinesMatchSubtotal({ subtotal: '100.00' }, [line('100.00'), line('50.00')], 'QuickBooks'))
        .toThrow(
          "The invoice lines sent to QuickBooks would total 150.00, but this invoice's subtotal is 100.00. "
            + 'Breeze refused the push so QuickBooks does not record a different amount than the customer was billed. '
            + 'Review the invoice lines and totals, then push again.',
        );
    });

    it('names the provider it is given, and reports an unreadable sum as such', () => {
      expect(() => assertPushedLinesMatchSubtotal({ subtotal: '100.00' }, [line('abc')], 'Xero'))
        .toThrow(
          "The invoice lines sent to Xero would total an unreadable amount, but this invoice's subtotal is 100.00. "
            + 'Breeze refused the push so Xero does not record a different amount than the customer was billed. '
            + 'Review the invoice lines and totals, then push again.',
        );
    });
  });

  describe('computeRemoteVariance', () => {
    const inv = { taxTotal: '7.00', total: '107.00' };

    it('is plain synced with null variances when both figures match', () => {
      expect(computeRemoteVariance({ remoteTaxTotal: '7.00', remoteTotal: '107.00' }, inv))
        .toEqual({ syncStatus: 'synced', taxVarianceCents: null, totalVarianceCents: null });
    });

    it('reports a 50.00 total drift as 5000 cents and marks it synced_with_tax_variance', () => {
      expect(computeRemoteVariance({ remoteTaxTotal: '7.00', remoteTotal: '157.00' }, inv))
        .toEqual({ syncStatus: 'synced_with_tax_variance', taxVarianceCents: null, totalVarianceCents: 5000 });
    });

    it('treats a 1-cent drift as within tolerance', () => {
      expect(computeRemoteVariance({ remoteTaxTotal: '7.01', remoteTotal: '107.01' }, inv))
        .toEqual({ syncStatus: 'synced', taxVarianceCents: null, totalVarianceCents: null });
    });

    it('reports a 2-cent drift (absolute difference, either direction)', () => {
      expect(computeRemoteVariance({ remoteTaxTotal: '6.98', remoteTotal: '107.02' }, inv))
        .toEqual({ syncStatus: 'synced_with_tax_variance', taxVarianceCents: 2, totalVarianceCents: 2 });
    });

    it('treats an absent remote figure as no drift', () => {
      expect(computeRemoteVariance({ remoteTaxTotal: null, remoteTotal: null }, inv))
        .toEqual({ syncStatus: 'synced', taxVarianceCents: null, totalVarianceCents: null });
    });
  });
});
