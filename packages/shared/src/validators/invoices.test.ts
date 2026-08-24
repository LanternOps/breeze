import { describe, it, expect } from 'vitest';
import {
  assembleFromOrgSchema, assembleFromTicketQuerySchema, manualLineSchema, recordPaymentSchema,
  partnerBillingSettingsSchema, orgBillingSettingsSchema,
  orgCurrencyImpactQuerySchema, createManualInvoiceSchema, updateInvoiceSchema, listInvoicesQuerySchema
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
  it('accepts an optional currencyCode override, normalized via currencyCodeSchema (#3776)', () => {
    const base = { orgId: '11111111-1111-1111-1111-111111111111', from: '2026-06-01', to: '2026-06-30' };
    const r = assembleFromOrgSchema.safeParse({ ...base, currencyCode: 'eur' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.currencyCode).toBe('EUR');
    expect(assembleFromOrgSchema.safeParse({ ...base, currencyCode: 'ZZZ' }).success).toBe(false);
    const none = assembleFromOrgSchema.safeParse(base);
    expect(none.success && none.data.currencyCode).toBeUndefined();
  });
});

describe('assembleFromTicketQuerySchema', () => {
  it('is empty-safe and normalizes currencyCode (#3776)', () => {
    expect(assembleFromTicketQuerySchema.safeParse({}).success).toBe(true);
    const r = assembleFromTicketQuerySchema.safeParse({ currencyCode: 'eur' });
    expect(r.success && r.data.currencyCode).toBe('EUR');
    expect(assembleFromTicketQuerySchema.safeParse({ currencyCode: 'ZZZ' }).success).toBe(false);
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

  // #3430 — billingWebsite was a bare z.string() while the twin field on
  // partner settings (contact.website) was already http/https-only. It is
  // snapshotted onto every issued invoice/quote and rendered in branded PDFs
  // and the customer portal, so it gets the same guard.
  describe('billingWebsite scheme validation', () => {
    const base = { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 };

    it.each(['https://acme.com', 'http://acme.com', 'https://acme.com/support?a=1', ''])(
      'accepts %j',
      (billingWebsite) => {
        expect(partnerBillingSettingsSchema.safeParse({ ...base, billingWebsite }).success).toBe(true);
      }
    );

    it('accepts null and undefined (field is clearable/optional)', () => {
      expect(partnerBillingSettingsSchema.safeParse({ ...base, billingWebsite: null }).success).toBe(true);
      expect(partnerBillingSettingsSchema.safeParse({ ...base }).success).toBe(true);
    });

    it.each([
      'javascript:alert(1)',
      'JavaScript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'acme.com',
    ])('rejects %j', (billingWebsite) => {
      expect(partnerBillingSettingsSchema.safeParse({ ...base, billingWebsite }).success).toBe(false);
    });

    it('keeps the 255-char cap', () => {
      const long = `https://acme.com/${'a'.repeat(300)}`;
      expect(partnerBillingSettingsSchema.safeParse({ ...base, billingWebsite: long }).success).toBe(false);
    });
  });
});


describe('partnerBillingSettingsSchema — contact fields', () => {
  it('accepts the new seller contact + T&C fields', () => {
    const parsed = partnerBillingSettingsSchema.parse({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingCompanyName: 'Acme MSP LLC', billingPhone: '+1 555 0100', billingWebsite: 'https://acme.test',
      billingAddressLine1: '1 Main St', billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
      billingTermsAndConditions: 'Net 30. Late fee 1.5%/mo.',
    });
    expect(parsed.billingCompanyName).toBe('Acme MSP LLC');
    expect(parsed.billingAddressCountry).toBe('US');
    expect(parsed.billingWebsite).toBe('https://acme.test');
  });

  // Behaviour change from #3430, called out explicitly: a scheme-less hostname
  // is no longer accepted on write. This matches the already-shipped rule on
  // the twin `contact.website` field (PATCH /partners/me) rather than silently
  // guessing a scheme. Existing stored values still READ back fine; only a
  // re-save of the billing profile requires correcting the field.
  it('rejects a scheme-less hostname rather than assuming https', () => {
    const result = partnerBillingSettingsSchema.safeParse({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      billingWebsite: 'acme.test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a 3-letter country code', () => {
    expect(() => partnerBillingSettingsSchema.parse({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, billingAddressCountry: 'USA',
    })).toThrow();
  });
});

describe('orgBillingSettingsSchema — billing contact', () => {
  it('accepts a billing contact email + name', () => {
    const parsed = orgBillingSettingsSchema.parse({
      billingContactEmail: 'billing@customer.example', billingContactName: 'AP Dept',
    });
    expect(parsed.billingContactEmail).toBe('billing@customer.example');
    expect(parsed.billingContactName).toBe('AP Dept');
  });

  it('accepts null to clear the recipient', () => {
    const parsed = orgBillingSettingsSchema.parse({ billingContactEmail: null, billingContactName: null });
    expect(parsed.billingContactEmail).toBeNull();
  });

  it('rejects a malformed email', () => {
    expect(() => orgBillingSettingsSchema.parse({ billingContactEmail: 'not-an-email' })).toThrow();
  });

  it('rejects an empty-string email (UI must send null, not "")', () => {
    expect(() => orgBillingSettingsSchema.parse({ billingContactEmail: '' })).toThrow();
  });
});

describe('orgBillingSettingsSchema — guarded currency changes', () => {
  it('continues to accept a tax-rate-only patch', () => {
    const parsed = orgBillingSettingsSchema.parse({ taxRate: 0.085 });
    expect(parsed.taxRate).toBe(0.085);
  });

  it('accepts guarded currency changes and normalizes both currency codes', () => {
    const parsed = orgBillingSettingsSchema.parse({
      currencyCode: 'eur',
      expectedCurrentCurrencyCode: 'usd',
      confirmSnapshotRetention: true,
    });

    expect(parsed.currencyCode).toBe('EUR');
    expect(parsed.expectedCurrentCurrencyCode).toBe('USD');
    expect(parsed.confirmSnapshotRetention).toBe(true);
  });

  it('requires expectedCurrentCurrencyCode when currencyCode is supplied', () => {
    const result = orgBillingSettingsSchema.safeParse({ currencyCode: 'EUR' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['expectedCurrentCurrencyCode'] }),
      ]));
    }
  });

  it('accepts a same-currency no-op without confirmation', () => {
    const parsed = orgBillingSettingsSchema.parse({
      currencyCode: 'USD',
      expectedCurrentCurrencyCode: 'USD',
    });

    expect(parsed.currencyCode).toBe('USD');
    expect(parsed.expectedCurrentCurrencyCode).toBe('USD');
    expect(parsed.confirmSnapshotRetention).toBeUndefined();
  });

  it('rejects an unsupported target currency', () => {
    const result = orgBillingSettingsSchema.safeParse({
      currencyCode: 'ZZZ',
      expectedCurrentCurrencyCode: 'USD',
      confirmSnapshotRetention: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['currencyCode'], message: 'Unsupported currency code' }),
      ]));
    }
  });

  // .strict() is a behaviour change on an already-shipped PATCH body, so pin
  // both halves: the real web payload still parses, and a mis-keyed flag
  // (convert / restamp / revalue) is a 400 rather than a silent default.
  it('still accepts the full payload the org billing settings form sends', () => {
    const parsed = orgBillingSettingsSchema.parse({
      taxId: 'DE123456789', taxExempt: false, taxRate: 0.19,
      billingContactEmail: 'ap@example.com', billingContactName: 'Accounts Payable',
      billingAddressLine1: 'Line 1', billingAddressLine2: null, billingAddressCity: 'Berlin',
      billingAddressRegion: null, billingAddressPostalCode: '10115', billingAddressCountry: 'DE',
    });
    expect(parsed.billingAddressCountry).toBe('DE');
  });

  it('rejects an unknown key such as a conversion flag', () => {
    for (const key of ['convert', 'restamp', 'revalue']) {
      const result = orgBillingSettingsSchema.safeParse({
        currencyCode: 'EUR', expectedCurrentCurrencyCode: 'USD', confirmSnapshotRetention: true,
        [key]: true,
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects currency preconditions without currencyCode', () => {
    const result = orgBillingSettingsSchema.safeParse({ expectedCurrentCurrencyCode: 'USD' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['currencyCode'] }),
      ]));
    }
  });
});

describe('orgCurrencyImpactQuerySchema', () => {
  it('normalizes currencyCode and rejects unknown query keys', () => {
    const parsed = orgCurrencyImpactQuerySchema.safeParse({ currencyCode: 'jpy' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.currencyCode).toBe('JPY');
    expect(orgCurrencyImpactQuerySchema.safeParse({ currencyCode: 'JPY', convert: true }).success).toBe(false);
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
