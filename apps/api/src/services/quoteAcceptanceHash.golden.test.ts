// DO NOT regenerate. These were recorded at origin/main 3cb835cee1 before freezeSignedAgreement existed.
//
// Characterization vectors for the quote acceptance hash (#8865 W1a, Task 1).
// Every later refactor of the contract-document freeze path (AgreementRenderContext,
// freezeSignedAgreement, the W1b request-aware freeze) must keep these passing
// byte-for-byte: a changed constant means every recorded acceptance on that path
// would fail re-verification. Hash compatibility is an INPUT property — the
// quote-context variable map, the accepted-date pin, the persisted locale
// (NULL → 'en') and the v1/v2 canonical forms. If one of these fails, fix the
// refactor; never re-harvest the constant. Real-row verification is
// scripts/verify-acceptance-hashes.ts.
import { describe, it, expect, vi } from 'vitest';

// Mock only '../db' (contractTemplateRender.test.ts idiom) — the resolver and the
// hash builder are pure and must run for real.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { buildContractHashParts } from './contractDocumentService';
import { computeQuoteSha256 } from './quoteContentHash';
import { renderContextFromQuote, resolveAutoVariables, resolveQuoteAutoVariables } from './contractTemplateRender';
import type { ContractBlockRenderData, QuoteRow } from './contractTemplateRender';

// Copied from contractTemplateRender.test.ts (test files do not export fixtures).
// Full quotes row fixture — resolveAutoVariables takes the whole row (see
// contractTemplateRender.ts's QuoteRow comment), so every column needs a value.
function fixtureQuote(overrides: Partial<QuoteRow> = {}): QuoteRow {
  const base: QuoteRow = {
    id: 'quote-1',
    partnerId: 'partner-1',
    orgId: 'org-1',
    siteId: null,
    quoteNumber: 'Q-1001',
    title: 'Managed Services Proposal',
    status: 'draft',
    currencyCode: 'USD',
    issueDate: '2026-07-01',
    expiryDate: '2026-08-01',
    acceptedAt: null,
    declinedAt: null,
    convertedAt: null,
    publicTokenVersion: 0,
    publicResponseJti: null,
    publicResponseConsumedAt: null,
    publicResponseOutcome: null,
    publicLinkRevokedAt: null,
    revisionOfQuoteId: null,
    revisionNumber: 1,
    acceptTokenJti: null,
    acceptTokenIssuedAt: null,
    acceptTokenExpiresAt: null,
    acceptTokenKid: null,
    subtotal: '810.00',
    taxRate: null,
    taxTotal: '0.00',
    total: '810.00',
    oneTimeTotal: '810.00',
    monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00',
    depositType: 'none',
    depositPercent: null,
    depositAmount: null,
    billToName: 'Acme Co',
    billToAddress: { line1: '1 Main St', line2: null, city: 'Springfield', region: 'IL', postalCode: '62701', country: 'USA' },
    billToTaxId: null,
    introNotes: null,
    terms: null,
    sellerSnapshot: { name: 'Breeze MSP', address: null, phone: null, email: null, website: null },
    coverPage: null,
    termsAndConditions: null,
    presentationSnapshot: null,
    documentLocale: null,
    declineReason: null,
    convertedInvoiceId: null,
    pdfDocumentRef: null,
    pdfSha256: null,
    sentAt: null,
    sendScheduledAt: null,
    sendJobId: null,
    sendEmailReason: null,
    firstViewedAt: null,
    viewedAt: null,
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
  return { ...base, ...overrides };
}

// Fixed ids, fixed money, fixed dates — nothing from Date.now().
const quote = fixtureQuote({
  id: '11111111-1111-4111-8111-111111111111', orgId: 'org-1', partnerId: 'p-1',
  currencyCode: 'EUR', documentLocale: 'fr-FR', billToName: 'Société Exemple',
  billToAddress: { line1: '1 rue A', city: 'Paris', postalCode: '75001', country: 'FR' },
  sellerSnapshot: { name: 'MSP SARL' }, quoteNumber: 'Q-2026-0042', title: 'BAA',
  subtotal: '1234.50', taxTotal: '0.00', total: '1234.50',
  oneTimeTotal: '234.50', monthlyRecurringTotal: '1000.00', annualRecurringTotal: '0.00',
  expiryDate: '2026-11-30', acceptedAt: new Date('2026-10-01T10:00:00.000Z'),
} as Partial<QuoteRow>);
const block = { id: 'blk-1', blockType: 'contract', sortOrder: 0,
  content: { templateId: 't-1', templateVersionId: 'v-1', variableValues: { 'client.name': 'Override Co', 'custom.po': 'PO-7' } } };
const line = { id: 'ln-1', description: 'Managed services', quantity: '10', unitPrice: '100.00', lineTotal: '1000.00',
  recurrence: 'monthly', taxable: true, customerVisible: true, sortOrder: 0,
  contractLineType: 'per_device', deviceRoles: ['workstation', 'server'], deviceGroupName: null, siteName: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null };
const renderData: ContractBlockRenderData[] = [{
  blockId: 'blk-1', templateId: 't-1', templateVersionId: 'v-1', sourceType: 'authored',
  bodyHtml: '<p>{{client.name}} {{totals.monthly}} {{dates.effective}} {{custom.po}}</p>', fileData: null,
  versionSha256: 'b'.repeat(64), declaredVariables: [], templateName: 'BAA', versionNumber: 3 }];
const EFFECTIVE = '2026-10-01';

// The resolver's output for the quote context (11 keys). `client.name` is the
// bill-to name, NOT the block's manual override — buildContractHashParts applies
// manual values on top, the resolver never sees them. Non-ASCII is escaped so the
// fr-FR U+202F (narrow no-break space) group separator and U+00A0 before the
// currency symbol are visible in review.
const HTML_MAP = {
  'client.name': 'Soci\u00e9t\u00e9 Exemple',
  'client.address': '1 rue A, Paris, 75001, FR',
  'seller.name': 'MSP SARL',
  'quote.number': 'Q-2026-0042',
  'quote.title': 'BAA',
  'totals.one_time': '234,50\u00a0\u20ac',
  'totals.monthly': '1\u202f000,00\u00a0\u20ac',
  'totals.annual': '0,00\u00a0\u20ac',
  'totals.total': '1\u202f234,50\u00a0\u20ac',
  'dates.effective': 'Oct 01, 2026',
  'dates.expiry': 'Nov 30, 2026',
};
// pdf: true — identical keys; money groupers U+202F → U+00A0 (WinAnsi-safe).
const PDF_MAP = {
  ...HTML_MAP,
  'totals.monthly': '1\u00a0000,00\u00a0\u20ac',
  'totals.total': '1\u00a0234,50\u00a0\u20ac',
};

const hash = (locale: string, version: 1 | 2) =>
  computeQuoteSha256(quote as any, [block] as any, [line] as any,
    buildContractHashParts([block], renderData, quote, EFFECTIVE, locale), version);

describe('acceptance hash golden vectors (characterization — recorded on main before the freeze extraction)', () => {
  it('v2 fr-FR', () => expect(hash('fr-FR', 2)).toBe('332c207864b5e8f7fe56d295c09bf8fe0e524845458cf46f3a8ba21f18cf3e61'));
  it('v1 fr-FR', () => expect(hash('fr-FR', 1)).toBe('89e91e218903630b674dbe9ffa269ab18ec234101f78556e3711f4f99d1aaee2'));
  it("v2 'en' (explicit)", () => expect(hash('en', 2)).toBe('0d00c38b0bb26b1ed0fc423fa3635750bad29efb5388211c250e209634de2a53'));
  it("v1 legacy NULL render_locale → 'en'", () => expect(hash('en', 1)).toBe('d1d12c529f5e335c289ab57be1725a90325a8e4ad05a7e3c8399efe60c6ee760'));
  it('v2 with no contract parts (pre-contract acceptance)', () =>
    expect(computeQuoteSha256(quote as any, [block] as any, [line] as any, [], 2)).toBe('45871af38131e3ff5c1ecbc5f96b98257e92c78ca9136686b5726bf82c819d10'));
  // #9221: acceptance now stamps quote_lines.unit_cost onto the invoice line's
  // cost_basis. Internal cost is NOT part of what the customer signs, so a line
  // carrying a unit cost must hash byte-for-byte like the recorded vectors.
  it('a line unit cost (cost basis) is not a hash input — vectors unchanged (#9221)', () => {
    const costed = { ...line, unitCost: '61.24' };
    const costedHash = (locale: string, version: 1 | 2) =>
      computeQuoteSha256(quote as any, [block] as any, [costed] as any,
        buildContractHashParts([block], renderData, quote, EFFECTIVE, locale), version);
    expect(costedHash('fr-FR', 2)).toBe('332c207864b5e8f7fe56d295c09bf8fe0e524845458cf46f3a8ba21f18cf3e61');
    expect(costedHash('fr-FR', 1)).toBe('89e91e218903630b674dbe9ffa269ab18ec234101f78556e3711f4f99d1aaee2');
    expect(costedHash('en', 2)).toBe('0d00c38b0bb26b1ed0fc423fa3635750bad29efb5388211c250e209634de2a53');
    expect(costedHash('en', 1)).toBe('d1d12c529f5e335c289ab57be1725a90325a8e4ad05a7e3c8399efe60c6ee760');
    expect(computeQuoteSha256(quote as any, [block] as any, [costed] as any, [], 2))
      .toBe('45871af38131e3ff5c1ecbc5f96b98257e92c78ca9136686b5726bf82c819d10');
  });
  it('quote-context HTML map is key- and value-stable', () => {
    expect(resolveQuoteAutoVariables(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR' })).toEqual(HTML_MAP);
    // Same map through the context path the freeze uses (#8865 W1a Task 3+).
    expect(resolveAutoVariables(renderContextFromQuote(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR' }))).toEqual(HTML_MAP);
    expect(resolveAutoVariables(renderContextFromQuote(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR' }), { pdf: true })).toEqual(PDF_MAP);
  });
  it('pdf map differs from the HTML map only in money formatting', () => {
    const html = resolveQuoteAutoVariables(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR' });
    const pdf = resolveQuoteAutoVariables(quote, { effectiveDate: EFFECTIVE, renderLocale: 'fr-FR', pdf: true });
    expect(Object.keys(pdf).sort()).toEqual(Object.keys(html).sort());
    expect(pdf['client.name']).toBe(html['client.name']);
    expect(pdf['totals.monthly']).not.toBe(html['totals.monthly']); // U+202F → NBSP
    expect(pdf).toEqual(PDF_MAP);
  });
});

// Null-heavy fixture (#8865 W1a review): unset bill-to, seller, title, expiry
// and document locale. Same DO-NOT-regenerate rule — these were computed with
// origin/main 3cb835cee1's contractTemplateRender + contractDocumentService
// (copied verbatim into a scratch module), not with the refactored code.
describe('acceptance hash golden vectors — null parties / unstamped quote (recorded against origin/main)', () => {
  const nullQuote = fixtureQuote({
    ...quote, billToName: null, billToAddress: null, sellerSnapshot: null, title: null, expiryDate: null, documentLocale: null,
  } as Partial<QuoteRow>);
  const nullHash = (version: 1 | 2) =>
    computeQuoteSha256(nullQuote as any, [block] as any, [line] as any,
      buildContractHashParts([block], renderData, nullQuote, EFFECTIVE, 'en'), version);

  it("v2 'en'", () => expect(nullHash(2)).toBe('17068479c90371c0d12fdb708a514137545f875d0faa43aabc22d72ca30f1469'));
  it("v1 'en'", () => expect(nullHash(1)).toBe('65b13add2d113186c6579eb61edc5ff0c37c781b6254f31ea1e0ee036432803d'));
  it('null fields resolve to empty strings, keys still present', () => {
    expect(resolveAutoVariables(renderContextFromQuote(nullQuote, { effectiveDate: EFFECTIVE, renderLocale: 'en' }))).toEqual({
      'client.name': '',
      'client.address': '',
      'seller.name': '',
      'quote.number': 'Q-2026-0042',
      'quote.title': '',
      'totals.one_time': '€234.50',
      'totals.monthly': '€1,000.00',
      'totals.annual': '€0.00',
      'totals.total': '€1,234.50',
      'dates.effective': 'Oct 01, 2026',
      'dates.expiry': '',
    });
  });
});
