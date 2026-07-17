import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stagePax8OrderFromQuoteMock, createContractMock, createExecutedDocumentsMock, callLog } = vi.hoisted(() => ({
  stagePax8OrderFromQuoteMock: vi.fn(),
  createContractMock: vi.fn(),
  createExecutedDocumentsMock: vi.fn(),
  // Shared ordered log so a test can assert the billing-contract loop runs BEFORE
  // the executed-document snapshot (the atomicity ordering requirement).
  callLog: [] as string[],
}));

vi.mock('./quoteToPax8Order', () => ({
  stagePax8OrderFromQuote: stagePax8OrderFromQuoteMock,
}));

vi.mock('./contractService', () => ({
  createContractWithLinesDetailed: createContractMock,
}));

// Spy createExecutedDocuments (keeps assertContractRenderDataComplete +
// buildContractHashParts REAL so the guard/hash folding are genuinely exercised).
vi.mock('./contractDocumentService', async (importActual) => {
  const actual = await importActual<typeof import('./contractDocumentService')>();
  return { ...actual, createExecutedDocuments: createExecutedDocumentsMock };
});

// Controllable Drizzle chain mock (same pattern as quoteService.test.ts /
// invoiceService.test.ts): every builder method returns the same chain; a
// query resolves when awaited (the chain is a thenable that yields the next
// queued result). Tests queue the rows each db call should resolve to, in
// call order.
//
// acceptQuote has no dedicated org/RLS layer to stub around (it runs inside
// the caller's already-scoped transaction), so this harness drives the
// function's own literal db call sequence directly rather than mocking a
// sibling service. See the per-test comment blocks for the exact call order.
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
import { computeQuoteSha256 } from './quoteContentHash';
import { buildContractHashParts } from './contractDocumentService';
import type { ContractBlockRenderData } from './contractTemplateRender';

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

/**
 * Queues the full db call sequence acceptQuote makes for a quote with exactly
 * one one-time, customer-visible line (so the invoice auto-issues) and NO
 * recurring lines (so buildContractSpecsFromQuote yields zero contract specs
 * and the contract-creation loop never touches the db — keeping this harness
 * to acceptQuote's own calls):
 *   1. select quotes ... for('update')      -> [quote]
 *   2. select quoteBlocks                    -> []
 *   3. select quoteLines                     -> [line]
 *   4. insert quoteAcceptances .returning()  -> [{id}]
 *   5. insert invoices .returning()          -> [{id}]
 *   6. insert invoiceLines (1x, unused)      -> []
 *   7. select partners (prefix/termsDays)    -> [{...}]
 *   8. execute (counter upsert)              -> [{counter}]
 *   9. update invoices .set(issueFields)     -> [] (unused)
 *  10. update quotes .set(converted)         -> [] (unused)
 *  11. select quotes (final re-select)       -> [updated quote]
 */
function queueAcceptHappyPath(quoteOverrides: Record<string, unknown> = {}) {
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
  };

  queueResult([quote]);                              // 1
  queueResult([]);                                    // 2 blocks
  queueResult([line]);                                // 3 lines
  queueResult([{ id: 'acc1' }]);                       // 4 quote_acceptances insert
  queueResult([{ id: 'inv1' }]);                       // 5 invoices insert
  queueResult([]);                                    // 6 invoiceLines insert
  queueResult([{ prefix: 'INV', termsDays: 30 }]);     // 7 partners select
  queueResult([{ counter: 1 }]);                       // 8 counter upsert
  queueResult([]);                                    // 9 invoices update
  queueResult([]);                                    // 10 quotes update
  queueResult([{ ...quote, status: 'converted' }]);    // 11 final re-select

  return { quote, line };
}

describe('acceptQuote deposit snapshot', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
  });

  it('snapshots quote.depositAmount onto the issued invoice as depositDue when a deposit is configured', async () => {
    queueAcceptHappyPath({ depositType: 'percent', depositPercent: '30.00', depositAmount: '300.00' });

    await acceptQuote(baseParams);

    const setMock = (db as unknown as Chain).set;
    // calls[0] is the invoices update (issueFields); calls[1] is the quotes
    // status->converted update. See queueAcceptHappyPath's call-order doc above.
    expect(setMock.mock.calls[0]![0]).toMatchObject({ depositDue: '300.00' });
  });

  it('leaves depositDue unset on the invoice when the quote has no deposit configured', async () => {
    queueAcceptHappyPath(); // depositType: 'none', depositAmount: null (defaults)

    await acceptQuote(baseParams);

    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).not.toHaveProperty('depositDue');
  });

  it('stages Phase 5 before the final quote read and exposes the order id', async () => {
    const { quote, line } = queueAcceptHappyPath();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: 'pax8-order-1', lineCount: 1 });

    const result = await acceptQuote(baseParams);

    expect(stagePax8OrderFromQuoteMock).toHaveBeenCalledWith({
      quoteId: quote.id,
      orgId: quote.orgId,
      partnerId: quote.partnerId,
      contractIds: [],
      contractLineLinks: [],
      lines: [{
        id: line.id,
        catalogItemId: null,
        quantity: line.quantity,
        recurrence: line.recurrence,
        customerVisible: line.customerVisible,
      }],
      actorUserId: null,
    });
    expect(result.pax8OrderId).toBe('pax8-order-1');
  });
});

/**
 * Queues the db call sequence for a quote that has ONE contract block + ONE
 * monthly recurring line (no one-time line, so the invoice is not issued: no
 * partner select / counter upsert). The billing-contract loop and the executed-
 * document snapshot are MOCKED (createContractMock / createExecutedDocumentsMock),
 * so neither touches the db — keeping this harness to acceptQuote's own calls:
 *   1. select quotes ... for('update')      -> [quote]
 *   2. select quoteBlocks                    -> [contractBlock]
 *   3. select quoteLines                     -> [monthlyLine]
 *   4. insert quoteAcceptances .returning()  -> [{id:'acc1'}]
 *   5. insert invoices .returning()          -> [{id:'inv1'}]
 *   6. update invoices .set(issueFields)     -> [] (unused)   (no one-time lines)
 *   7. update quotes .set(converted)         -> [] (unused)
 *   8. select quotes (final re-select)       -> [updated quote]
 */
const contractBlock = { id: 'cb1', blockType: 'contract', content: { templateId: 't1', templateVersionId: 'v1', variableValues: {} } };
const monthlyLine = {
  id: 'l1', quoteId: 'q1', recurrence: 'monthly', customerVisible: true,
  taxable: false, quantity: '1', unitPrice: '99.00', catalogItemId: null,
  description: 'Managed services', name: 'Managed services', termMonths: null, sortOrder: 0,
};
const contractQuote = {
  id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent',
  expiryDate: null, quoteNumber: 'Q-2026-0002', taxRate: null,
  currencyCode: 'USD', siteId: null,
  billToName: 'Acme Co', billToAddress: null, billToTaxId: null,
  sellerSnapshot: { name: 'MSP LLC' }, termsAndConditions: null, terms: null,
  title: 'Proposal', oneTimeTotal: '0.00', monthlyRecurringTotal: '99.00',
  annualRecurringTotal: '0.00', subtotal: '99.00', taxTotal: '0.00', total: '99.00',
  depositType: 'none', depositPercent: null, depositAmount: null,
};
const renderData: ContractBlockRenderData[] = [{
  blockId: 'cb1', templateId: 't1', templateVersionId: 'v1', sourceType: 'authored',
  bodyHtml: '<p>Effective {{dates.effective}}.</p>', fileData: null,
  versionSha256: 'a'.repeat(64), declaredVariables: [], templateName: 'MSA', versionNumber: 1,
}];

function queueContractAcceptPath() {
  queueResult([contractQuote]);              // 1 select quote FOR UPDATE
  queueResult([contractBlock]);              // 2 blocks
  queueResult([monthlyLine]);                // 3 lines
  queueResult([{ id: 'acc1' }]);             // 4 quote_acceptances insert
  queueResult([{ id: 'inv1' }]);             // 5 invoices insert
  queueResult([]);                           // 6 invoices update (issueFields)
  queueResult([]);                           // 7 quotes update -> converted
  queueResult([{ ...contractQuote, status: 'converted' }]); // 8 final re-select
}

describe('acceptQuote contract document snapshot', () => {
  beforeEach(() => {
    results.length = 0;
    callLog.length = 0;
    vi.clearAllMocks();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
    createContractMock.mockImplementation(async () => {
      callLog.push('createContract');
      return { contract: { id: 'contractA' }, lines: [] };
    });
    createExecutedDocumentsMock.mockImplementation(async () => {
      callLog.push('createExecutedDocuments');
      return ['doc-1'];
    });
  });

  it('folds contractParts into the acceptance hash and snapshots documents AFTER the contract loop', async () => {
    queueContractAcceptPath();

    const result = await acceptQuote({ ...baseParams, contractRenderData: renderData });

    // The billing-contract loop runs BEFORE the executed-document snapshot, so
    // createExecutedDocuments receives the created contract ids (deterministic
    // first-created link) — the transaction-ordering requirement.
    expect(callLog).toEqual(['createContract', 'createExecutedDocuments']);
    const snapshotArgs = createExecutedDocumentsMock.mock.calls[0]!;
    expect(snapshotArgs[2]).toEqual(['contractA']); // contractIds
    expect(snapshotArgs[3]).toBe(renderData);       // renderData
    expect(result.contractDocumentIds).toEqual(['doc-1']);

    // The quote_acceptances insert (first .values call) carries a hash that folds
    // in the contract parts — recompute it with the same real helpers.
    const acceptanceValues = (db as unknown as Chain).values.mock.calls[0]![0] as { quoteSha256: string };
    const effectiveDate = new Date().toISOString().slice(0, 10);
    const expected = computeQuoteSha256(
      contractQuote as any, [contractBlock] as any, [monthlyLine] as any,
      buildContractHashParts([contractBlock], renderData, contractQuote as any, effectiveDate),
    );
    expect(acceptanceValues.quoteSha256).toBe(expected);
    // And that hash genuinely differs from the no-contract hash (proves folding).
    const withoutContracts = computeQuoteSha256(contractQuote as any, [contractBlock] as any, [monthlyLine] as any, []);
    expect(acceptanceValues.quoteSha256).not.toBe(withoutContracts);
  });

  it('throws CONTRACT_RENDER_DATA_MISSING and writes NOTHING when a contract block has no render data', async () => {
    // Guard runs right after the block/line reads, before any insert.
    queueResult([contractQuote]);   // 1 select quote FOR UPDATE
    queueResult([contractBlock]);   // 2 blocks (contract block present)
    queueResult([monthlyLine]);     // 3 lines

    await expect(acceptQuote({ ...baseParams })).rejects.toMatchObject({
      status: 500, code: 'CONTRACT_RENDER_DATA_MISSING',
    });

    // No acceptance / invoice was inserted, no contract created, no snapshot taken.
    expect((db as unknown as Chain).insert.mock.calls).toHaveLength(0);
    expect(createContractMock).not.toHaveBeenCalled();
    expect(createExecutedDocumentsMock).not.toHaveBeenCalled();
  });
});
