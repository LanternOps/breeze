import { describe, it, expect } from 'vitest';
import {
  assembleFromOrgSchema, manualLineSchema, recordPaymentSchema,
  partnerBillingSettingsSchema, orgBillingSettingsSchema
} from './invoices';

describe('assembleFromOrgSchema', () => {
  it('accepts a valid org-run window', () => {
    const r = assembleFromOrgSchema.safeParse({ orgId: '11111111-1111-1111-1111-111111111111', from: '2026-06-01', to: '2026-06-30' });
    expect(r.success).toBe(true);
  });
  it('rejects missing orgId', () => {
    expect(assembleFromOrgSchema.safeParse({ from: '2026-06-01', to: '2026-06-30' }).success).toBe(false);
  });
});

describe('manualLineSchema', () => {
  it('requires positive quantity and non-negative price at 2dp', () => {
    expect(manualLineSchema.safeParse({ description: 'Onsite', quantity: 1, unitPrice: 150, taxable: false }).success).toBe(true);
    expect(manualLineSchema.safeParse({ description: 'x', quantity: -1, unitPrice: 1, taxable: false }).success).toBe(false);
    expect(manualLineSchema.safeParse({ description: 'x', quantity: 1, unitPrice: 1.005, taxable: false }).success).toBe(false);
  });
});

describe('recordPaymentSchema', () => {
  it('requires positive amount and a method', () => {
    expect(recordPaymentSchema.safeParse({ amount: 50, method: 'check', receivedAt: '2026-06-14' }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ amount: 0, method: 'check', receivedAt: '2026-06-14' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: 50, method: 'crypto', receivedAt: '2026-06-14' }).success).toBe(false);
  });
});

describe('partnerBillingSettingsSchema', () => {
  it('accepts currency, tax rate, prefix, terms', () => {
    expect(partnerBillingSettingsSchema.safeParse({ currencyCode: 'USD', defaultTaxRate: 0.085, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }).success).toBe(true);
  });
});
