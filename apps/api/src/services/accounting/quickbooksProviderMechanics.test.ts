import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env so configError()/connectEnvironment() can be driven per case.
// Getters keep the imported bindings live (vitest reads them off the module
// namespace at access time).
const envState = vi.hoisted(() => ({
  clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://breeze.example/cb', environment: 'sandbox',
}));
vi.mock('../../config/env', () => ({
  get QBO_CLIENT_ID() { return envState.clientId; },
  get QBO_CLIENT_SECRET() { return envState.clientSecret; },
  get QBO_REDIRECT_URI() { return envState.redirectUri; },
  get QBO_ENVIRONMENT() { return envState.environment; },
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { mapQboCdcPayment, quickbooksProvider } from './quickbooksProvider';
import { buildPaymentPrivateNote } from './accountingPaymentMarker';
import type { AccountingConnection } from './accountingConnectionService';

const PAYMENT_ID = '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

beforeEach(() => {
  Object.assign(envState, {
    clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://breeze.example/cb', environment: 'sandbox',
  });
});

describe('QuickbooksProvider mechanics (Xero W01)', () => {
  it('declares QuickBooks limits: 21-char PaymentRefNum and Intuit per-realm throttles', () => {
    expect(quickbooksProvider.limits).toEqual({
      paymentRefMax: 21,
      rate: {
        perConnection: { limit: 500, windowSeconds: 60 },
        maxConcurrentPerConnection: 10,
        appWide: null,
        dailyPerConnection: null,
      },
    });
  });

  it('embeds the marker alone (PrivateNote) and extracts it with the anchored Breeze parser', () => {
    const marker = buildPaymentPrivateNote(PAYMENT_ID);
    expect(quickbooksProvider.paymentMarker.embed('ch_123', marker)).toBe(marker);
    expect(quickbooksProvider.paymentMarker.embed(null, marker)).toBe(marker);
    expect(quickbooksProvider.paymentMarker.extract(marker)).toBe(PAYMENT_ID);
    expect(quickbooksProvider.paymentMarker.extract(`see ${marker}`)).toBeNull();
    expect(quickbooksProvider.paymentMarker.extract(null)).toBeNull();
  });

  it('connectEnvironment() reports QBO_ENVIRONMENT', () => {
    expect(quickbooksProvider.connectEnvironment()).toBe('sandbox');
    envState.environment = 'production';
    expect(quickbooksProvider.connectEnvironment()).toBe('production');
  });

  it('configError() matches the connect route\'s QuickBooks validation text byte for byte', () => {
    expect(quickbooksProvider.configError()).toBeNull();
    envState.environment = 'production';
    expect(quickbooksProvider.configError()).toBeNull();

    for (const key of ['clientId', 'clientSecret', 'redirectUri', 'environment'] as const) {
      Object.assign(envState, {
        clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://breeze.example/cb', environment: 'sandbox',
      });
      envState[key] = '';
      expect(quickbooksProvider.configError()).toBe('QuickBooks OAuth is not configured on this instance');
    }

    envState.environment = 'staging';
    expect(quickbooksProvider.configError()).toBe('QBO_ENVIRONMENT must be sandbox or production');
  });

  it('maps the CDC PaymentMethodRef onto Breeze\'s enum as line.method (unknown or absent => other)', () => {
    const conn = { homeCurrency: 'USD' } as AccountingConnection;
    const raw = (name?: string) => ({
      Id: '180', SyncToken: '2', TxnDate: '2026-09-02', TotalAmt: 150,
      CurrencyRef: { value: 'USD' },
      ...(name === undefined ? {} : { PaymentMethodRef: { name } }),
      Line: [{ Amount: 150, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    });
    expect(mapQboCdcPayment(raw('Visa'), conn)[0]).toMatchObject({
      method: 'card', paymentMethodName: 'Visa', remotePaymentVersion: '2',
    });
    expect(mapQboCdcPayment(raw('ACH'), conn)[0]!.method).toBe('other');
    expect(mapQboCdcPayment(raw(), conn)[0]).toMatchObject({ method: 'other', paymentMethodName: null });
  });
});
