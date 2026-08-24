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
 *   4. select partners (prefix/termsDays/settings) -> [{...}]  (read BEFORE the
 *      hash: the render locale falls back to the partner language)
 *   5. insert quoteAcceptances .returning()  -> [{id}]
 *   6. insert invoices .returning()          -> [{id}]
 *   7. insert invoiceLines (1x, unused)      -> []
 *   8. execute (counter upsert)              -> [{counter}]
 *   9. update invoices .set(issueFields)     -> [] (unused)
 *  10. update quotes .set(converted)         -> [] (unused)
 *  11. select quotes (final re-select)       -> [updated quote]
 */
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

  queueResult([quote]);                              // 1
  queueResult([]);                                    // 2 blocks
  queueResult([line]);                                // 3 lines
  queueResult([{ prefix: 'INV', termsDays: 30, settings: {}, ...partnerOverrides }]); // 4 partners select
  queueResult([{ id: 'acc1' }]);                       // 5 quote_acceptances insert
  queueResult([{ id: 'inv1' }]);                       // 6 invoices insert
  queueResult([]);                                    // 7 invoiceLines insert
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

  // #3777 review finding 1: the auto-issued invoice and the acceptance hash
  // share ONE render locale — the quote stamp, else the partner language.
  it('stamps the auto-issued invoice with the partner language when the quote is unstamped', async () => {
    queueAcceptHappyPath({}, {}, { settings: { language: 'de-DE' } });

    await acceptQuote(baseParams);

    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ documentLocale: 'de-DE' });
  });

  it('leaves depositDue unset on the invoice when the quote has no deposit configured', async () => {
    queueAcceptHappyPath(); // depositType: 'none', depositAmount: null (defaults)

    await acceptQuote(baseParams);

    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).not.toHaveProperty('depositDue');
  });

  // #2875: token-based (public) accepts must claim + consume the durable
  // response capability (2026-08-06-c columns) in the same quotes update that
  // flips status→converted; portal accepts (no jti) must leave them untouched.
  it('public accept (acceptanceTokenJti set) consumes the durable response capability in the quotes update', async () => {
    queueAcceptHappyPath();

    await acceptQuote({ ...baseParams, acceptanceTokenJti: 'jti-durable-1' });

    const setMock = (db as unknown as Chain).set;
    // calls[0] = invoices issueFields update; calls[1] = quotes status update.
    const quotesSet = setMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(quotesSet).toMatchObject({
      status: 'converted',
      publicResponseJti: 'jti-durable-1',
      publicResponseOutcome: 'accepted',
    });
    expect(quotesSet.publicResponseConsumedAt).toBeInstanceOf(Date);
  });

  it('portal accept (no acceptanceTokenJti) leaves the durable response columns untouched', async () => {
    queueAcceptHappyPath();

    await acceptQuote(baseParams); // acceptanceTokenJti: null

    const setMock = (db as unknown as Chain).set;
    const quotesSet = setMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(quotesSet).toMatchObject({ status: 'converted' });
    expect(quotesSet).not.toHaveProperty('publicResponseJti');
    expect(quotesSet).not.toHaveProperty('publicResponseConsumedAt');
    expect(quotesSet).not.toHaveProperty('publicResponseOutcome');
  });

  // #2875 durable replay backstop: a jti already consumed on the row is
  // rejected 401 BEFORE the status guard and before any write — this is what
  // holds when the Redis revocation marker has been flushed.
  it('throws 401 RESPONSE_CONSUMED and writes nothing when the jti was already durably consumed', async () => {
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'converted',
      expiryDate: null, quoteNumber: 'Q-2026-0001', taxRate: null,
      currencyCode: 'USD', siteId: null,
      publicResponseJti: 'jti-durable-1',
      publicResponseConsumedAt: new Date('2026-07-27T00:00:00Z'),
      publicResponseOutcome: 'accepted',
    }]); // 1: select quote FOR UPDATE — nothing further should run

    await expect(acceptQuote({ ...baseParams, acceptanceTokenJti: 'jti-durable-1' }))
      .rejects.toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });

    const chain = db as unknown as Chain;
    expect(chain.insert.mock.calls).toHaveLength(0); // no acceptance/invoice written
    expect(chain.set.mock.calls).toHaveLength(0);    // no update issued
  });

  // v1 forward-compat guard: once public_token_version=1 rows exist (jti
  // persisted at send), only the issued jti may consume — a different signed
  // token must never claim/rewrite the stored jti.
  it('v1 row with a mismatched jti → 401 RESPONSE_CONSUMED, nothing written', async () => {
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent',
      expiryDate: null, quoteNumber: 'Q-2026-0001', taxRate: null,
      currencyCode: 'USD', siteId: null,
      publicTokenVersion: 1, publicResponseJti: 'jti-issued-at-send',
      publicResponseConsumedAt: null, publicResponseOutcome: null,
    }]);

    await expect(acceptQuote({ ...baseParams, acceptanceTokenJti: 'jti-forged' }))
      .rejects.toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });

    const chain = db as unknown as Chain;
    expect(chain.insert.mock.calls).toHaveLength(0);
    expect(chain.set.mock.calls).toHaveLength(0);
  });

  it('v1 row with the ISSUED jti proceeds and consumes normally', async () => {
    queueAcceptHappyPath({ publicTokenVersion: 1, publicResponseJti: 'jti-issued-at-send', publicResponseConsumedAt: null });

    await acceptQuote({ ...baseParams, acceptanceTokenJti: 'jti-issued-at-send' });

    const setMock = (db as unknown as Chain).set;
    const quotesSet = setMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(quotesSet).toMatchObject({
      status: 'converted',
      publicResponseJti: 'jti-issued-at-send',
      publicResponseOutcome: 'accepted',
    });
  });

  it('a consumed row with a DIFFERENT jti does not trip the backstop (falls through to the status guard)', async () => {
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'converted',
      expiryDate: null, quoteNumber: 'Q-2026-0001', taxRate: null,
      currencyCode: 'USD', siteId: null,
      publicResponseJti: 'jti-someone-else',
      publicResponseConsumedAt: new Date('2026-07-27T00:00:00Z'),
      publicResponseOutcome: 'declined',
    }]);

    await expect(acceptQuote({ ...baseParams, acceptanceTokenJti: 'jti-durable-1' }))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
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

// #3319: quote_lines and invoice_lines BOTH carry a `name` (title) alongside
// `description` (sub-line blurb) since migration 2026-07-03-quote-invoice-line-name;
// renderers treat the title as `name ?? description`. The conversion mapping
// dropped `name`, so every converted invoice rendered as a legacy line and the
// customer-facing item title vanished from the invoice detail and the PDF.
/**
 * Multi-currency wave 5 (#3777): accept ISSUES the converted invoice inline
 * (never via issueInvoice), so it is the invoice's issue-time stamp. The
 * accepted quote's own stamp is the natural value — the same rule
 * sellerSnapshot follows — falling back to the partner language only for a
 * quote that somehow carries none.
 */
describe('acceptQuote document_locale stamp', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
  });

  it("stamps the issued invoice with the quote's documentLocale, not the partner's current language", async () => {
    queueAcceptHappyPath({ documentLocale: 'pt-BR' }, {}, { settings: { language: 'de-DE' } });
    await acceptQuote(baseParams);
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ status: 'sent', documentLocale: 'pt-BR' });
  });

  it('falls back to the partner language when the quote carries no stamp', async () => {
    queueAcceptHappyPath({ documentLocale: null }, {}, { settings: { language: 'de-DE' } });
    await acceptQuote(baseParams);
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ status: 'sent', documentLocale: 'de-DE' });
  });
});

describe('acceptQuote quote-line -> invoice-line label mapping (#3319)', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
    createContractMock.mockResolvedValue({ contract: { id: 'contractA' }, lines: [] });
    createExecutedDocumentsMock.mockResolvedValue([]);
  });

  // .values call order (see queueAcceptHappyPath): [0] quote_acceptances,
  // [1] invoices, [2] invoice_lines.
  const invoiceLineValues = () =>
    (db as unknown as Chain).values.mock.calls[2]![0] as Record<string, unknown>;

  it('carries the quote line name onto the invoice line, distinct from the description', async () => {
    queueAcceptHappyPath({}, {
      name: 'Onboarding & network setup',
      description: 'Network audit, agent deployment, endpoint enrollment',
    });

    await acceptQuote(baseParams);

    expect(invoiceLineValues()).toMatchObject({
      name: 'Onboarding & network setup',
      description: 'Network audit, agent deployment, endpoint enrollment',
    });
  });

  it('writes name: null for a legacy quote line that has no name, leaving description as the title', async () => {
    // Legacy pre-2026-07-03 line: description holds the title, name is NULL.
    // The invoice line must mirror that shape (NOT fabricate a name) so the
    // renderer's `name ?? description` fallback keeps showing the title once.
    queueAcceptHappyPath({}, { name: null, description: 'Legacy widget' });

    await acceptQuote(baseParams);

    expect(invoiceLineValues()).toMatchObject({ name: null, description: 'Legacy widget' });
  });

  it('carries a name-only line (no description) without inventing a blurb', async () => {
    // The most common catalog shape: a title and no separate blurb.
    queueAcceptHappyPath({}, { name: 'Firewall replacement', description: null });

    await acceptQuote(baseParams);

    expect(invoiceLineValues()).toMatchObject({ name: 'Firewall replacement', description: null });
  });

  it.each([['', 'empty'], ['   ', 'whitespace-only']])(
    'normalizes a %s name to null so the renderer cannot lose BOTH labels',
    async (blankName) => {
      // The renderers derive blurb from `name` being truthy, so a '' name would
      // render the title as '—' and suppress the description entirely.
      queueAcceptHappyPath({}, { name: blankName, description: 'Real description survives' });

      await acceptQuote(baseParams);

      expect(invoiceLineValues()).toMatchObject({
        name: null,
        description: 'Real description survives',
      });
    },
  );

  it('normalizes an undefined name to null rather than omitting the column', async () => {
    const { line } = queueAcceptHappyPath();
    delete (line as Record<string, unknown>).name;

    await acceptQuote(baseParams);

    const values = invoiceLineValues();
    expect(values).toHaveProperty('name', null);
  });

  it('preserves the name on the Phase 4 contract line by composing it into the single label', async () => {
    // The sibling mapping, asserted here so the two conversion paths stay
    // honest together. Contract lines deliberately carry ONE label
    // (NewContractLineSpec has no `name`), so quoteToContract composes
    // "name — description"; invoice lines have a real `name` column and must
    // keep the two fields separate instead. Both must preserve the title. A
    // monthly-only
    // quote has no one-time lines, so the invoice is never issued — the call
    // sequence skips the invoice_lines insert and the counter upsert (the
    // partners select still runs: it feeds the render-locale fallback):
    //   1 quote FOR UPDATE, 2 blocks, 3 lines, 4 partners select,
    //   5 acceptances insert, 6 invoices insert, 7 invoices update,
    //   8 quotes update, 9 re-select.
    const quote = {
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent',
      expiryDate: null, quoteNumber: 'Q-2026-0003', taxRate: null,
      currencyCode: 'USD', siteId: null, terms: null,
      depositType: 'none', depositPercent: null, depositAmount: null,
    };
    queueResult([quote]);
    queueResult([]);
    queueResult([{
      id: 'l1', quoteId: 'q1', recurrence: 'monthly', customerVisible: true,
      taxable: false, quantity: '1', unitPrice: '99.00', catalogItemId: null,
      name: 'Managed EDR', description: '24/7 monitoring', termMonths: null, sortOrder: 0,
    }]);
    queueResult([{ prefix: 'INV', termsDays: 30, settings: {} }]);
    queueResult([{ id: 'acc1' }]);
    queueResult([{ id: 'inv1' }]);
    queueResult([]);
    queueResult([]);
    queueResult([{ ...quote, status: 'converted' }]);

    await acceptQuote(baseParams);

    expect(createContractMock).toHaveBeenCalledTimes(1);
    const spec = createContractMock.mock.calls[0]![0] as { lines: Array<Record<string, unknown>> };
    expect(spec.lines[0]).toMatchObject({ description: 'Managed EDR — 24/7 monitoring' });
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
 *   4. select partners (settings)            -> [{...}]  (render-locale fallback)
 *   5. insert quoteAcceptances .returning()  -> [{id:'acc1'}]
 *   6. insert invoices .returning()          -> [{id:'inv1'}]
 *   7. update invoices .set(issueFields)     -> [] (unused)   (no one-time lines)
 *   8. update quotes .set(converted)         -> [] (unused)
 *   9. select quotes (final re-select)       -> [updated quote]
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

function queueContractAcceptPath(partnerSettings: Record<string, unknown> = {}) {
  queueResult([contractQuote]);              // 1 select quote FOR UPDATE
  queueResult([contractBlock]);              // 2 blocks
  queueResult([monthlyLine]);                // 3 lines
  queueResult([{ prefix: 'INV', termsDays: 30, settings: partnerSettings }]); // 4 partners select
  queueResult([{ id: 'acc1' }]);             // 5 quote_acceptances insert
  queueResult([{ id: 'inv1' }]);             // 6 invoices insert
  queueResult([]);                           // 7 invoices update (issueFields)
  queueResult([]);                           // 8 quotes update -> converted
  queueResult([{ ...contractQuote, status: 'converted' }]); // 9 final re-select
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
      buildContractHashParts([contractBlock], renderData, contractQuote as any, effectiveDate, 'en'),
    );
    expect(acceptanceValues.quoteSha256).toBe(expected);
    // The locale the hash was computed under travels with it (#3777 follow-up):
    // an unstamped quote falls back to the partner language, 'en' here.
    expect((acceptanceValues as { renderLocale?: string }).renderLocale).toBe('en');
    expect(snapshotArgs[6]).toBe('en'); // createExecutedDocuments renders under the same locale
    // And that hash genuinely differs from the no-contract hash (proves folding).
    const withoutContracts = computeQuoteSha256(contractQuote as any, [contractBlock] as any, [monthlyLine] as any, []);
    expect(acceptanceValues.quoteSha256).not.toBe(withoutContracts);
  });

  // #3777 post-merge review, finding 1: an UNSTAMPED quote is rendered to the
  // customer in the PARTNER's language (portal/public render, quote branding),
  // so the accept-time hash and the executed PDF must use that same locale — a
  // bare 'en' fallback would hash and PDF in English what the signer read in
  // German. Historical acceptances are unaffected: 2026-09-01-b persisted
  // render_locale on every one of them.
  it('hashes an unstamped quote under the PARTNER language, not en, and persists that locale', async () => {
    queueContractAcceptPath({ language: 'de-DE' });

    await acceptQuote({ ...baseParams, contractRenderData: renderData });

    const acceptanceValues = (db as unknown as Chain).values.mock.calls[0]![0] as { quoteSha256: string; renderLocale?: string };
    const effectiveDate = new Date().toISOString().slice(0, 10);
    const underDe = computeQuoteSha256(
      contractQuote as any, [contractBlock] as any, [monthlyLine] as any,
      buildContractHashParts([contractBlock], renderData, contractQuote as any, effectiveDate, 'de-DE'),
    );
    expect(acceptanceValues.quoteSha256).toBe(underDe);
    expect(acceptanceValues.renderLocale).toBe('de-DE');
    // createExecutedDocuments renders the signed PDF under the same locale.
    expect(createExecutedDocumentsMock.mock.calls[0]![6]).toBe('de-DE');
    // The invoice this accept creates is stamped with the same locale.
    const invoiceSet = (db as unknown as Chain).set.mock.calls[0]![0] as Record<string, unknown>;
    expect(invoiceSet.documentLocale).toBeUndefined(); // recurring-only: invoice stays draft, stamped at issue
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

describe('acceptQuote superseded public-link guard', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    stagePax8OrderFromQuoteMock.mockResolvedValue({ orderId: null, lineCount: 0 });
  });

  function queueGuardQuote(overrides: Record<string, unknown>) {
    queueResult([{
      id: 'q1',
      orgId: 'org1',
      partnerId: 'p1',
      quoteNumber: 'Q-2026-0001',
      currencyCode: 'USD',
      expiryDate: null,
      publicResponseConsumedAt: null,
      publicResponseJti: null,
      publicTokenVersion: 0,
      ...overrides,
    }]);
  }

  it('rejects a superseded quote with 410 QUOTE_SUPERSEDED', async () => {
    queueGuardQuote({ status: 'superseded', publicLinkRevokedAt: null });

    await expect(acceptQuote(baseParams)).rejects.toMatchObject({
      status: 410,
      code: 'QUOTE_SUPERSEDED',
    });
  });

  it('rejects a sent quote whose publicLinkRevokedAt is set with 410 QUOTE_SUPERSEDED', async () => {
    queueGuardQuote({ status: 'sent', publicLinkRevokedAt: new Date('2026-08-23T12:00:00.000Z') });

    await expect(acceptQuote(baseParams)).rejects.toMatchObject({
      status: 410,
      code: 'QUOTE_SUPERSEDED',
    });
  });

  it('reports QUOTE_SUPERSEDED before the generic non-sent INVALID_STATE guard', async () => {
    queueGuardQuote({ status: 'superseded', publicLinkRevokedAt: new Date('2026-08-23T12:00:00.000Z') });

    let thrown: unknown;
    try {
      await acceptQuote(baseParams);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ status: 410, code: 'QUOTE_SUPERSEDED' });
    expect(thrown).not.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
});
