import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PublicQuoteHeader } from '@breeze/shared';
import type { QuoteTotals } from './quoteMath';
import { toPublicQuoteHeader } from './publicQuoteDto';

const HEADER_KEYS = [
  'id',
  'quoteNumber',
  'title',
  'status',
  'currencyCode',
  'issueDate',
  'expiryDate',
  'subtotal',
  'taxRate',
  'taxTotal',
  'total',
  'oneTimeTotal',
  'monthlyRecurringTotal',
  'annualRecurringTotal',
  'depositType',
  'depositAmount',
  'dueOnAcceptanceTotal',
  'depositDueTotal',
  'categoryBreakdown',
  'billToName',
  'introNotes',
  'terms',
  'sellerSnapshot',
  'coverPage',
  'termsAndConditions',
] as const;

const TOTALS: QuoteTotals = {
  subtotal: '400.00',
  taxTotal: '32.00',
  total: '432.00',
  oneTimeTotal: '300.00',
  monthlyRecurringTotal: '75.00',
  annualRecurringTotal: '25.00',
  dueOnAcceptanceTotal: '324.00',
  depositDueTotal: '97.20',
  categoryBreakdown: [{
    category: 'hardware',
    oneTimeTotal: '300.00',
    monthlyTotal: '75.00',
    annualTotal: '25.00',
  }],
};

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    partnerId: 'internal-partner-sentinel',
    orgId: 'internal-org-sentinel',
    siteId: 'internal-site-sentinel',
    quoteNumber: 'Q-2026-0042',
    title: 'Managed Services',
    status: 'sent',
    currencyCode: 'USD',
    issueDate: '2026-07-01',
    expiryDate: '2026-08-01',
    acceptedAt: 'internal-accepted-sentinel',
    declinedAt: 'internal-declined-sentinel',
    convertedAt: 'internal-converted-sentinel',
    subtotal: '400.00',
    taxRate: '0.08000',
    taxTotal: '32.00',
    total: '432.00',
    oneTimeTotal: '300.00',
    monthlyRecurringTotal: '75.00',
    annualRecurringTotal: '25.00',
    depositType: 'percent',
    depositPercent: '30.00',
    depositAmount: '97.20',
    billToName: 'Acme Co',
    billToAddress: { internalAddressSentinel: 'do-not-serialize' },
    billToTaxId: 'internal-tax-sentinel',
    introNotes: 'Welcome to the proposal.',
    terms: 'Net 30',
    sellerSnapshot: {
      name: 'Lantern IT',
      address: {
        line1: '1 Main Street',
        line2: 'Suite 2',
        city: 'Denver',
        region: 'CO',
        postalCode: '80202',
        country: 'US',
        internalAddressSentinel: 'do-not-serialize',
      },
      phone: '555-0100',
      email: 'sales@example.test',
      website: 'https://example.test',
      internalSellerSentinel: 'do-not-serialize',
    },
    coverPage: {
      enabled: true,
      title: 'A Better IT Plan',
      coverImageId: '22222222-2222-4222-8222-222222222222',
      preparedForName: 'Acme Co',
      showPreparedBy: false,
      internalCoverSentinel: 'do-not-serialize',
    },
    termsAndConditions: 'Customer-facing legal terms.',
    declineReason: 'internal-decline-reason-sentinel',
    convertedInvoiceId: 'internal-invoice-sentinel',
    pdfDocumentRef: 'internal-document-sentinel',
    pdfSha256: 'internal-sha-sentinel',
    sentAt: 'internal-sent-at-sentinel',
    sendScheduledAt: 'internal-scheduled-at-sentinel',
    sendJobId: 'internal-job-sentinel',
    sendEmailReason: 'internal-email-failure-sentinel',
    firstViewedAt: 'internal-first-viewed-sentinel',
    viewedAt: 'internal-viewed-sentinel',
    createdBy: 'internal-creator-sentinel',
    createdAt: 'internal-created-sentinel',
    updatedAt: 'internal-updated-sentinel',
    ...overrides,
  };
}

describe('toPublicQuoteHeader', () => {
  it('returns the exact public key order and strips internal and nested sentinels', () => {
    const result = toPublicQuoteHeader(sourceRow() as never, TOTALS);

    expect(Object.keys(result)).toEqual(HEADER_KEYS);
    expect(Object.keys(result.sellerSnapshot!)).toEqual([
      'name', 'address', 'phone', 'email', 'website',
    ]);
    expect(Object.keys(result.sellerSnapshot!.address!)).toEqual([
      'line1', 'line2', 'city', 'region', 'postalCode', 'country',
    ]);
    expect(Object.keys(result.coverPage!)).toEqual([
      'enabled', 'title', 'coverImageId', 'preparedForName', 'showPreparedBy',
    ]);
    expect(JSON.stringify(result)).not.toContain('do-not-serialize');
    expect(JSON.stringify(result)).not.toContain('internal-');
  });

  it('satisfies the shared contract, maps totals, and normalizes sent to viewed', () => {
    const result = toPublicQuoteHeader(sourceRow() as never, TOTALS);
    const typedResult: PublicQuoteHeader = result;
    void typedResult;

    expectTypeOf(result).toMatchTypeOf<PublicQuoteHeader>();
    expect(result).toMatchObject({
      status: 'viewed',
      dueOnAcceptanceTotal: '324.00',
      depositDueTotal: '97.20',
      categoryBreakdown: TOTALS.categoryBreakdown,
      billToName: 'Acme Co',
      issueDate: '2026-07-01',
      expiryDate: '2026-08-01',
      terms: 'Net 30',
      monthlyRecurringTotal: '75.00',
      annualRecurringTotal: '25.00',
    });
  });

  it.each(['viewed', 'accepted', 'declined', 'expired', 'converted'] as const)(
    'preserves the public %s status',
    (status) => {
      expect(toPublicQuoteHeader(sourceRow({ status }) as never, TOTALS).status).toBe(status);
    },
  );

  it('fails closed if a draft row ever reaches the public mapper', () => {
    expect(() => toPublicQuoteHeader(sourceRow({ status: 'draft' }) as never, TOTALS))
      .toThrow('Draft quotes cannot be serialized for public access');
  });

  it('normalizes legacy, null, and malformed nested values without passthrough', () => {
    expect(toPublicQuoteHeader(sourceRow({
      sellerSnapshot: 'malformed',
      coverPage: null,
    }) as never, TOTALS)).toMatchObject({
      sellerSnapshot: null,
      coverPage: null,
    });

    const partial = toPublicQuoteHeader(sourceRow({
      sellerSnapshot: {
        name: 42,
        address: { line1: '1 Main', city: 99, extra: 'secret' },
        email: 'sales@example.test',
      },
      coverPage: {
        enabled: 'yes',
        title: 99,
        showPreparedBy: 'legacy',
        extra: 'secret',
      },
    }) as never, TOTALS);

    expect(partial.sellerSnapshot).toEqual({
      name: null,
      address: {
        line1: '1 Main',
        line2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
      phone: null,
      email: 'sales@example.test',
      website: null,
    });
    expect(partial.coverPage).toEqual({
      enabled: false,
      title: null,
      coverImageId: null,
      preparedForName: null,
      showPreparedBy: true,
    });
  });
});
