import { describe, it, expect } from 'vitest';
import {
  assembleFromOrgSchema, manualLineSchema, recordPaymentSchema,
  partnerBillingSettingsSchema, orgBillingSettingsSchema,
  createManualInvoiceSchema, updateInvoiceSchema, listInvoicesQuerySchema
} from './invoices';
import { INVOICE_STATUSES, PAYMENT_METHODS } from '../types/billing-enums';

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
  it('accepts a name-only line and rejects one with neither name nor description', () => {
    expect(manualLineSchema.safeParse({ name: 'Managed Firewall', quantity: 1, unitPrice: 85, taxable: true }).success).toBe(true);
    expect(manualLineSchema.safeParse({ quantity: 1, unitPrice: 10, taxable: false }).success).toBe(false);
    expect(manualLineSchema.safeParse({ name: '  ', description: '', quantity: 1, unitPrice: 10, taxable: false }).success).toBe(false);
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

  it('accepts autoTaxHardware as a boolean and omits it when absent', () => {
    const withTrue = partnerBillingSettingsSchema.parse({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, autoTaxHardware: true });
    expect(withTrue.autoTaxHardware).toBe(true);
    const withFalse = partnerBillingSettingsSchema.parse({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, autoTaxHardware: false });
    expect(withFalse.autoTaxHardware).toBe(false);
    const omitted = partnerBillingSettingsSchema.parse({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 });
    expect(omitted.autoTaxHardware).toBeUndefined();
  });

  it('bounds defaultMarkupPercent to 0..9999.99 with 2-decimal precision', () => {
    const base = { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 };
    expect(partnerBillingSettingsSchema.safeParse({ ...base, defaultMarkupPercent: 0 }).success).toBe(true);
    expect(partnerBillingSettingsSchema.safeParse({ ...base, defaultMarkupPercent: 150 }).success).toBe(true); // markup > 100% is valid
    expect(partnerBillingSettingsSchema.safeParse({ ...base, defaultMarkupPercent: 9999.99 }).success).toBe(true);
    expect(partnerBillingSettingsSchema.safeParse({ ...base, defaultMarkupPercent: null }).success).toBe(true);
    expect(partnerBillingSettingsSchema.safeParse({ ...base, defaultMarkupPercent: -1 }).success).toBe(false);
    expect(partnerBillingSettingsSchema.safeParse({ ...base, defaultMarkupPercent: 10000 }).success).toBe(false);
    expect(partnerBillingSettingsSchema.safeParse({ ...base, defaultMarkupPercent: 12.345 }).success).toBe(false); // multipleOf 0.01
  });
});


describe('partnerBillingSettingsSchema — contact fields', () => {
  it('accepts the new seller contact + T&C fields', () => {
    const parsed = partnerBillingSettingsSchema.parse({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingCompanyName: 'Acme MSP LLC', billingPhone: '+1 555 0100', billingWebsite: 'acme.test',
      billingAddressLine1: '1 Main St', billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
      billingTermsAndConditions: 'Net 30. Late fee 1.5%/mo.',
    });
    expect(parsed.billingCompanyName).toBe('Acme MSP LLC');
    expect(parsed.billingAddressCountry).toBe('US');
  });

  it('rejects a 3-letter country code', () => {
    expect(() => partnerBillingSettingsSchema.parse({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, billingAddressCountry: 'USA',
    })).toThrow();
  });
});

describe('invoice T&C field', () => {
  it('create accepts termsAndConditions', () => {
    const p = createManualInvoiceSchema.parse({ orgId: '00000000-0000-0000-0000-000000000000', termsAndConditions: 'Net 30' });
    expect(p.termsAndConditions).toBe('Net 30');
  });
  it('update accepts termsAndConditions', () => {
    const p = updateInvoiceSchema.parse({ termsAndConditions: 'Net 15' });
    expect(p.termsAndConditions).toBe('Net 15');
  });
});

describe('invoice validators derive from the enum SSOT', () => {
  it('recordPaymentSchema accepts every canonical payment method', () => {
    for (const method of PAYMENT_METHODS) {
      const parsed = recordPaymentSchema.parse({ amount: 10, method, receivedAt: '2026-06-21' });
      expect(parsed.method).toBe(method);
    }
  });
  it('recordPaymentSchema rejects an unknown method', () => {
    expect(() => recordPaymentSchema.parse({ amount: 10, method: 'crypto', receivedAt: '2026-06-21' })).toThrow();
  });
  it('listInvoicesQuerySchema accepts every canonical status', () => {
    for (const status of INVOICE_STATUSES) {
      const parsed = listInvoicesQuerySchema.parse({ status });
      expect(parsed.status).toBe(status);
    }
  });
  it('listInvoicesQuerySchema rejects an unknown status', () => {
    expect(() => listInvoicesQuerySchema.parse({ status: 'archived' })).toThrow();
  });
});
