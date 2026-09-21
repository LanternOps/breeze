import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { stagePax8OrderFromQuoteMock, createContractMock, createExecutedDocumentsMock } = vi.hoisted(() => ({
  stagePax8OrderFromQuoteMock: vi.fn(),
  createContractMock: vi.fn(),
  createExecutedDocumentsMock: vi.fn(),
}));

vi.mock('./quoteToPax8Order', () => ({
  stagePax8OrderFromQuote: stagePax8OrderFromQuoteMock,
}));

vi.mock('./contractService', () => ({
  createContractWithLinesDetailed: createContractMock,
}));

vi.mock('./contractDocumentService', async (importActual) => {
  const actual = await importActual<typeof import('./contractDocumentService')>();
  return { ...actual, createExecutedDocuments: createExecutedDocumentsMock };
});

// The draft claim and the revision-parent lock are quoteLifecycle's, not this
// service's — mock both so this harness stays on acceptQuote's own db calls.
const { claimQuoteSentMock, resolveParentToSupersedeMock } = vi.hoisted(() => ({
  claimQuoteSentMock: vi.fn(),
  resolveParentToSupersedeMock: vi.fn(),
}));
vi.mock('./quoteLifecycle', () => ({
  claimQuoteSent: claimQuoteSentMock,
  resolveParentToSupersede: resolveParentToSupersedeMock,
}));

// Controllable Drizzle chain mock — same harness as quoteAcceptService.test.ts.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute', 'transaction'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { acceptQuote } from './quoteAcceptService';
import { db } from '../db';
import { getAcceptanceProvider } from './acceptanceProvider';

type Chain = {
  set: { mock: { calls: unknown[][] } };
  values: { mock: { calls: unknown[][] } };
  insert: { mock: { calls: unknown[][] } };
};

const baseParams = {
  quoteId: 'q1',
  signerName: 'Jane Doe',
  signerEmail: 'jane@example.com',
  ipAddress: '1.2.3.4',
  userAgent: 'test-agent',
  acceptanceTokenJti: null,
  actorUserId: null,
};

/** See quoteAcceptService.test.ts for the annotated call sequence. */
function queueAcceptHappyPath(
  quoteOverrides: Record<string, unknown> = {},
  lineOverrides: Record<string, unknown> = {},
  partnerOverrides: Record<string, unknown> = {},
) {
  const quote = {
    id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent',
    expiryDate: null, quoteNumber: 'Q-2026-0001', taxRate: null,
    currencyCode: 'USD', siteId: null,
    billToName: null, billToAddress: null, billToTaxId: null,
    sellerSnapshot: null, termsAndConditions: null, terms: null,
    depositType: 'none', depositPercent: null, depositAmount: null,
    ...quoteOverrides,
  };
  const line = {
    id: 'l1', quoteId: 'q1', recurrence: 'one_time', customerVisible: true,
    taxable: true, quantity: '1', unitPrice: '1000.00', catalogItemId: null,
    description: 'Widget', name: 'Widget', termMonths: null, sortOrder: 0,
    ...lineOverrides,
  };

  queueResult([quote]);                              // 1 quote FOR UPDATE
  queueResult([]);                                    // 2 blocks
  queueResult([line]);                                // 3 lines
  queueResult([{ prefix: 'INV', termsDays: 30, settings: {}, ...partnerOverrides }]); // 4 partners
  queueResult([{ id: 'acc1' }]);                       // 5 quote_acceptances insert
  queueResult([{ id: 'inv1' }]);                       // 6 invoices insert
  queueResult([]);                                    // 7 invoiceLines insert
  queueResult([{ counter: 1 }]);                       // 8 counter upsert
  queueResult([]);                                    // 9 invoices update
  queueResult([]);                                    // 10 quotes update
  queueResult([{ ...quote, status: 'converted' }]);    // 11 final re-select

  return { quote, line };
}

function resetHarness() {
  results.length = 0;
  vi.clearAllMocks();
  stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
  createExecutedDocumentsMock.mockResolvedValue([]);
  claimQuoteSentMock.mockResolvedValue({ quoteNumber: 'Q-2026-0001', superseded: undefined });
  resolveParentToSupersedeMock.mockResolvedValue(null);
}

const onBehalfParams = {
  quoteId: 'q1',
  signerName: 'Dana Buyer',
  signerEmail: 'dana@customer.example',
  ipAddress: '10.0.0.7',
  userAgent: 'Mozilla/5.0 tech-browser',
  acceptanceTokenJti: null,
  actorUserId: 'tech-1',
  origin: 'on_behalf' as const,
  method: 'purchase_order',
  reference: 'PO 4471',
};

describe('acceptQuote — origin on_behalf', () => {
  beforeEach(resetHarness);
  afterEach(() => { vi.restoreAllMocks(); });

  it('stores the provenance columns on the acceptance row', async () => {
    queueAcceptHappyPath();
    await acceptQuote(onBehalfParams);
    const acceptanceInsert = (db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>;
    expect(acceptanceInsert).toMatchObject({
      origin: 'on_behalf',
      method: 'purchase_order',
      reference: 'PO 4471',
      recordedByUserId: 'tech-1',
      signerName: 'Dana Buyer',
      signerEmail: 'dana@customer.example',
      ipAddress: '10.0.0.7',
    });
  });

  // The provider abstraction represents HOW THE CUSTOMER SIGNED. Routing an
  // MSP-recorded acceptance through a "typed-signature" provider would mislabel
  // it as a signature the customer produced. The spy is on the memoized
  // singleton the service actually calls, so it is a real observation (the
  // brief's spy was on a local copy of the export and could never fire).
  it('bypasses the acceptance provider entirely', async () => {
    const captureSpy = vi.spyOn(getAcceptanceProvider(), 'capture');
    queueAcceptHappyPath();
    await acceptQuote(onBehalfParams);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('still routes the customer path through the provider', async () => {
    const captureSpy = vi.spyOn(getAcceptanceProvider(), 'capture');
    queueAcceptHappyPath();
    await acceptQuote(baseParams);
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it('stamps the customer path with the provider method, not null', async () => {
    queueAcceptHappyPath();
    await acceptQuote(baseParams); // origin defaults to 'customer'
    const acceptanceInsert = (db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>;
    expect(acceptanceInsert).toMatchObject({
      origin: 'customer', method: 'typed-signature', reference: null, recordedByUserId: null,
    });
  });

  it('claims a draft to sent before the acceptance, through claimQuoteSent', async () => {
    queueAcceptHappyPath({ status: 'draft' });
    // The service overlays the frozen values onto the SAME quote object after
    // the claim returns, so mock.calls holds a post-mutation reference —
    // snapshot the argument at call time instead of reading it afterwards.
    let seenAtCallTime: Record<string, unknown> | undefined;
    claimQuoteSentMock.mockImplementation((q: Record<string, unknown>) => {
      seenAtCallTime = { ...q };
      return Promise.resolve({ quoteNumber: 'Q-2026-0001', superseded: undefined });
    });
    await acceptQuote(onBehalfParams);
    expect(claimQuoteSentMock).toHaveBeenCalledTimes(1);
    expect(seenAtCallTime).toMatchObject({ id: 'q1', status: 'draft' });
    // …and the overlay landed, so everything downstream hashes a SENT quote.
    expect(claimQuoteSentMock.mock.calls[0]![0]).toMatchObject({ id: 'q1', status: 'sent' });
    // Delivery-free: no token identity handed to the helper.
    expect(claimQuoteSentMock.mock.calls[0]![1]).not.toHaveProperty('acceptTokenColumns');
  });

  it('does not claim a quote that is already sent', async () => {
    queueAcceptHappyPath({ status: 'sent' });
    await acceptQuote(onBehalfParams);
    expect(claimQuoteSentMock).not.toHaveBeenCalled();
  });

  it('still rejects a draft on the customer path (guard unchanged)', async () => {
    queueAcceptHappyPath({ status: 'draft' });
    await expect(acceptQuote(baseParams)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(claimQuoteSentMock).not.toHaveBeenCalled();
  });

  it.each(['expired', 'declined'])('rejects %s with 409 QUOTE_NOT_ACCEPTABLE', async (status) => {
    queueAcceptHappyPath({ status });
    await expect(acceptQuote(onBehalfParams)).rejects.toMatchObject({
      status: 409, code: 'QUOTE_NOT_ACCEPTABLE',
    });
  });

  it('rejects a superseded quote with 410 (existing guard runs first)', async () => {
    queueAcceptHappyPath({ status: 'superseded' });
    await expect(acceptQuote(onBehalfParams)).rejects.toMatchObject({ status: 410, code: 'QUOTE_SUPERSEDED' });
  });

  it('supersedes the parent when the claimed draft is a revision', async () => {
    queueAcceptHappyPath({ status: 'draft', revisionOfQuoteId: 'parent-1' });
    resolveParentToSupersedeMock.mockResolvedValue({ id: 'parent-1', status: 'sent' });
    claimQuoteSentMock.mockResolvedValue({
      quoteNumber: 'Q-2026-0001-R2',
      superseded: { parentQuoteId: 'parent-1', previousStatus: 'sent' },
    });
    const res = await acceptQuote(onBehalfParams);
    expect(resolveParentToSupersedeMock).toHaveBeenCalledTimes(1);
    // The parent the claim retires is the one the lock resolved.
    expect(claimQuoteSentMock.mock.calls[0]![1]).toMatchObject({
      parentToSupersede: { id: 'parent-1', status: 'sent' },
    });
    expect(res.superseded).toEqual({ parentQuoteId: 'parent-1', previousStatus: 'sent' });
  });

  it('computes the same content hash as the customer path for the same quote', async () => {
    queueAcceptHappyPath();
    await acceptQuote(baseParams);
    const customerHash = ((db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>).quoteSha256;
    resetHarness();
    queueAcceptHappyPath();
    await acceptQuote(onBehalfParams);
    const onBehalfHash = ((db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>).quoteSha256;
    expect(onBehalfHash).toBe(customerHash);
    expect(typeof onBehalfHash).toBe('string');
  });

  it('reports the issued invoice number for the audit trail', async () => {
    queueAcceptHappyPath();
    const res = await acceptQuote(onBehalfParams);
    expect(res.invoiceIssued).toBe(true);
    expect(res.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
  });

  // The whole point of the post-claim overlay: a draft carries NO customer
  // identity (bill-to is frozen from the org's Billing settings at the claim,
  // not before it). Issuing the invoice from the stale pre-claim row would put
  // a blank//wrong bill-to and the wrong locale on a document the customer pays
  // — and the invoice is the artifact that leaves the building.
  it('issues the invoice from the CLAIM\'s frozen values, not the stale draft', async () => {
    queueAcceptHappyPath({
      status: 'draft',
      quoteNumber: 'Q-DRAFT-STALE',
      billToName: 'Stale Draft Co',
      billToAddress: { line1: '0 Stale Street' },
      billToTaxId: 'STALE-TAX-0',
      sellerSnapshot: { name: 'Stale Seller' },
      documentLocale: 'en',
      termsAndConditions: 'stale terms and conditions',
      terms: 'stale terms',
    });
    claimQuoteSentMock.mockResolvedValue({
      quoteNumber: 'Q-2026-0042',
      issueDate: '2026-09-21',
      billToName: 'Frozen Buyer Ltd',
      billToAddress: { line1: '1 Frozen Way' },
      billToTaxId: 'FROZEN-TAX-9',
      sellerSnapshot: { name: 'Frozen Seller' },
      presentationSnapshot: { theme: 'slate' },
      documentLocale: 'fr',
      termsAndConditions: 'frozen terms and conditions',
      terms: 'frozen terms',
      superseded: undefined,
    });

    await acceptQuote(onBehalfParams);

    // set() call 0 is the invoice issue update; call 1 is the quote→converted flip.
    const issueFields = (db as unknown as Chain).set.mock.calls[0]![0] as Record<string, unknown>;
    expect(issueFields).toMatchObject({
      status: 'sent',
      billToName: 'Frozen Buyer Ltd',
      billToAddress: { line1: '1 Frozen Way' },
      billToTaxId: 'FROZEN-TAX-9',
      sellerSnapshot: { name: 'Frozen Seller' },
      documentLocale: 'fr',
      termsAndConditions: 'frozen terms and conditions',
      terms: 'frozen terms',
    });
    // Explicitly: none of the stale draft values survived onto the invoice.
    expect(issueFields.billToName).not.toBe('Stale Draft Co');
    expect(issueFields.billToTaxId).not.toBe('STALE-TAX-0');
    expect(issueFields.documentLocale).not.toBe('en');

    // …and the acceptance row + the invoice's provenance note carry the
    // claim-allocated number, not the draft's placeholder.
    const acceptanceInsert = (db as unknown as Chain).values.mock.calls[0]![0] as Record<string, unknown>;
    expect(acceptanceInsert.renderLocale).toBe('fr');
    const invoiceInsert = (db as unknown as Chain).values.mock.calls[1]![0] as Record<string, unknown>;
    expect(invoiceInsert.notes).toBe('Converted from quote Q-2026-0042');
  });

  it('refuses a blank signer name rather than recording a nameless acceptance', async () => {
    queueAcceptHappyPath();
    await expect(acceptQuote({ ...onBehalfParams, signerName: '   ' })).rejects.toMatchObject({
      status: 400, code: 'INVALID_SIGNER_NAME',
    });
    // Nothing was written: the refusal lands before the acceptance insert.
    expect((db as unknown as Chain).insert.mock.calls.length).toBe(0);
  });
});
