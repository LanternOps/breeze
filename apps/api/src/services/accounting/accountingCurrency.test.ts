import { describe, expect, it } from 'vitest';
import {
  AccountingCurrencyContractError,
  assertAccountingInvoicePushCurrency,
  normalizeAccountingPayment,
} from './accountingCurrency';
import type { AccountingProvider, ChangeSet } from './types';
import type { AccountingConnection } from './accountingConnectionService';

// Bind the fixture to the TYPED provider interface so this contract can never
// drift from the shape pushInvoice actually receives (B8, multi-currency §11).
type PushInvoiceArgs = Parameters<AccountingProvider['pushInvoice']>;

function invoicePayload(currencyCode: string): PushInvoiceArgs[1] {
  return {
    invoiceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    docNumber: 'INV-2026-0001',
    txnDate: '2026-09-04',
    dueDate: '2026-10-04',
    customerRef: { id: '42' },
    currencyCode,
    subtotal: '100.00',
    taxTotal: '0.00',
    total: '100.00',
    lines: [],
    mapping: null,
  };
}

function connection(homeCurrency: string | null): Pick<AccountingConnection, 'provider' | 'homeCurrency'> {
  return { provider: 'quickbooks', homeCurrency };
}

function payment(overrides: Partial<ChangeSet['payments'][number]> = {}): ChangeSet['payments'][number] {
  return {
    remoteInvoiceId: '999',
    remotePaymentId: '1234',
    amountMinor: 1234,
    currency: 'USD',
    txnDate: '2026-09-04',
    ...overrides,
  };
}

describe('assertAccountingInvoicePushCurrency', () => {
  it('passes when the invoice currency equals the realm home currency', () => {
    expect(() => assertAccountingInvoicePushCurrency(connection('USD'), invoicePayload('USD'))).not.toThrow();
  });

  it('normalizes case and whitespace on both sides', () => {
    expect(() => assertAccountingInvoicePushCurrency(connection(' usd '), invoicePayload('Usd'))).not.toThrow();
  });

  it('BLOCKS a currency mismatch and names both codes', () => {
    try {
      assertAccountingInvoicePushCurrency(connection('USD'), invoicePayload('EUR'));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingCurrencyContractError);
      const e = err as AccountingCurrencyContractError;
      expect(e.code).toBe('ACCOUNTING_INVOICE_CURRENCY_MISMATCH');
      expect(e.status).toBe(409);
      expect(e.message).toContain('EUR');
      expect(e.message).toContain('USD');
      // Foreign-currency push (CurrencyRef/ExchangeRate) is deferred beyond this
      // program — the message must not promise it.
      expect(e.message).not.toMatch(/exchange rate|will be converted/i);
    }
  });

  it('FAILS CLOSED when the home currency was never captured', () => {
    for (const unknown of [null, '', '   ']) {
      try {
        assertAccountingInvoicePushCurrency(connection(unknown), invoicePayload('USD'));
        throw new Error('expected a throw');
      } catch (err) {
        const e = err as AccountingCurrencyContractError;
        expect(e.code).toBe('ACCOUNTING_HOME_CURRENCY_UNKNOWN');
        expect(e.status).toBe(409);
        expect(e.message).toMatch(/reconnect/i);
      }
    }
  });
});

describe('normalizeAccountingPayment', () => {
  it('converts two-decimal minor units to a major-unit string', () => {
    const out = normalizeAccountingPayment(payment({ amountMinor: 1234, currency: 'USD' }), {
      invoiceId: 'inv-1',
      currencyCode: 'USD',
    });
    expect(out).toEqual({
      invoiceId: 'inv-1',
      remoteInvoiceId: '999',
      remotePaymentId: '1234',
      amount: '12.34',
      currencyCode: 'USD',
      txnDate: '2026-09-04',
    });
  });

  it('does NOT divide a zero-decimal currency', () => {
    const out = normalizeAccountingPayment(payment({ amountMinor: 1234, currency: 'JPY' }), {
      invoiceId: 'inv-2',
      currencyCode: 'JPY',
    });
    expect(out.amount).toBe('1234.00');
    expect(out.currencyCode).toBe('JPY');
  });

  it('normalizes a lowercase provider code', () => {
    const out = normalizeAccountingPayment(payment({ currency: 'usd' }), { invoiceId: 'inv-3', currencyCode: 'USD' });
    expect(out.currencyCode).toBe('USD');
  });

  it('asserts currency equality BEFORE converting (cross-currency payments are a non-goal)', () => {
    try {
      normalizeAccountingPayment(payment({ currency: 'USD' }), { invoiceId: 'inv-4', currencyCode: 'EUR' });
      throw new Error('expected a throw');
    } catch (err) {
      const e = err as AccountingCurrencyContractError;
      expect(e.code).toBe('ACCOUNTING_PAYMENT_CURRENCY_MISMATCH');
      expect(e.status).toBe(409);
      expect(e.message).toContain('USD');
      expect(e.message).toContain('EUR');
    }
  });

  it('rejects a non-positive, non-integer, non-finite or unsafe minor amount', () => {
    // 0 is not a payment; a negative amount is a refund/credit memo, which spec
    // §12 puts out of scope — applying one through this path would INCREASE the
    // invoice balance.
    for (const bad of [Number.NaN, 12.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, 0, -1, -1234]) {
      try {
        normalizeAccountingPayment(payment({ amountMinor: bad }), { invoiceId: 'inv-5', currencyCode: 'USD' });
        throw new Error(`expected a throw for ${bad}`);
      } catch (err) {
        const e = err as AccountingCurrencyContractError;
        expect(e.code).toBe('ACCOUNTING_PAYMENT_MINOR_UNITS_INVALID');
        expect(e.status).toBe(502);
      }
    }
  });
});
