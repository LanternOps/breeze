import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Param, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// Controllable Drizzle chain mock — same pattern as quoteLifecycle.test.ts.
// Tests queue the rows each db call resolves to, in call order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

const setCalls: Array<Record<string, unknown>> = [];
const insertValueCalls: unknown[] = [];
/** Every `.where(...)` argument, in call order, for predicate assertions. */
const whereCalls: unknown[] = [];
/** Every `.for(...)` mode and the number of preceding `.where(...)` calls. */
const forCalls: Array<{ mode: unknown; afterWhereIndex: number }> = [];

// #3905 — the RLS scope sendQuote captures and the deferred email re-enters.
// vi.hoisted so it exists before the hoisted vi.mock('../db') factory runs.
const { TEST_DB_CONTEXT } = vi.hoisted(() => ({
  TEST_DB_CONTEXT: {
    scope: 'partner' as const,
    orgId: null,
    accessibleOrgIds: ['org-1'],
    accessiblePartnerIds: ['partner-1'],
    userId: 'user-1',
    currentPartnerId: 'partner-1',
  },
}));

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'limit', 'orderBy', 'returning', 'update', 'delete', 'innerJoin', 'execute', 'transaction'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.where = vi.fn((predicate: unknown) => { whereCalls.push(predicate); return chain; });
    chain.for = vi.fn((mode: unknown) => {
      forCalls.push({ mode, afterWhereIndex: whereCalls.length });
      return chain;
    });
    chain.set = vi.fn((payload: Record<string, unknown>) => { setCalls.push(payload); return chain; });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  db.insert = vi.fn(() => {
    const insertChain: Record<string, unknown> = {};
    insertChain.values = vi.fn((payload: unknown) => { insertValueCalls.push(payload); return insertChain; });
    insertChain.onConflictDoNothing = vi.fn(() => insertChain);
    (insertChain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
    return insertChain;
  });
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    // #3905 — sendQuote/resendQuote assert an ambient context and capture its
    // metadata so the deferred email can re-enter the SAME RLS scope. The stub
    // context is what the deferred's DB phases are asserted to run under.
    assertInTransaction: () => {},
    getCurrentDbAccessContext: () => TEST_DB_CONTEXT,
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

const sendEmailMock = vi.fn().mockResolvedValue(undefined);
let capturedEmailArgs: Record<string, unknown> | null = null;

vi.mock('./quotePdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quotePdf')>();
  return { ...actual, renderQuotePdf: vi.fn(() => Promise.resolve(Buffer.from('%PDF-fake'))) };
});

vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./email')>();
  return {
    ...actual,
    getEmailService: vi.fn(() => ({
      sendEmail: vi.fn((args: Record<string, unknown>) => { capturedEmailArgs = args; return sendEmailMock(args); }),
      fromWithDisplayName: (name: string) => `"${name}" <no-reply@test.example>`,
    })),
  };
});

import { sendQuote } from './quoteLifecycle';

const dialect = new PgDialect();
/**
 * Compile a captured predicate to its SQL text + bound params. The bag-of-values
 * walker below is operator-blind: it cannot tell `and` from `or`, `in` from
 * `not in`, or `=` from `<>`, so an assertion built only on bound values stays
 * green while the predicate inverts. Asserting the compiled SQL closes that.
 */
function compilePredicate(node: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(node as SQL);
  return { sql: q.sql, params: q.params as unknown[] };
}

/** Walk a Drizzle predicate for its bound (column, value) pairs. */
function collectBoundParams(node: unknown): { column: string; value: unknown }[] {
  const found: { column: string; value: unknown }[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (value == null || typeof value !== 'object' || seen.has(value as object)) return;
    seen.add(value as object);
    // inArray(...) binds its list as an ARRAY of Params inside a query chunk.
    // Without this branch the walker silently misses every IN (...) value, so a
    // predicate assertion on a status set would look empty and pass vacuously.
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value instanceof Param) {
      const encoder = (value as { encoder?: { name?: string } }).encoder;
      found.push({ column: encoder?.name ?? '<unknown>', value: (value as { value: unknown }).value });
      return;
    }
    if (value instanceof SQL) {
      for (const chunk of (value as unknown as { queryChunks: unknown[] }).queryChunks) visit(chunk);
    }
  };
  visit(node);
  return found;
}

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

const draftRevision = (over: Record<string, unknown> = {}) => ({
  id: 'q2', partnerId: 'p1', orgId: 'org1', siteId: null,
  quoteNumber: 'Q-2026-0042-R2', title: 'Proposal', status: 'draft',
  currencyCode: 'USD', taxRate: null, depositType: 'none', depositPercent: null,
  billToName: null, billToAddress: null, billToTaxId: null, coverPage: null,
  expiryDate: null, presentationSnapshot: null, documentLocale: null,
  termsAndConditions: null, terms: null,
  revisionOfQuoteId: 'q1', revisionNumber: 2,
  ...over,
});

const lineRow = {
  id: 'ql-1', quoteId: 'q2', description: 'Widget', quantity: '1', unitPrice: '100.00',
  taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false,
  itemType: 'hardware', sortOrder: 0,
};

const ORG = { id: 'org1', name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } };
const PARTNER = { id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null };

/**
 * Queue every read sendQuote issues for a REVISION draft, up to and including
 * the child's draft→sent claim. `parentStatus` drives the locked parent read.
 */
function queueRevisionThroughClaim(opts: {
  parentStatus?: string | null;
  parentRecipients?: { email: string }[];
  claimed?: unknown[];
  quote?: Record<string, unknown>;
} = {}) {
  const quote = opts.quote ?? draftRevision();
  queueResult([{ id: quote.id }]);            // child row lock (FOR UPDATE)
  queueResult([quote]);                        // getQuote: quote row
  queueResult([]);                             // getQuote: blocks
  queueResult([lineRow]);                      // getQuote: lines
  queueResult([]);                             // getQuote: no staged Pax8 order
  if (quote.revisionOfQuoteId) {
    queueResult([{ id: quote.revisionOfQuoteId, quoteNumber: 'Q-2026-0042', siteId: null }]); // parent
    queueResult([]);                           // parent recipients (lineage field)
  }
  queueResult([]);                             // getQuote: no successor
  queueResult([]);                             // getQuote: order headers
  queueResult([]);                             // getQuote: order lines
  queueResult([ORG]);                          // getQuote: draft billTo org lookup
  // Parent lock (FOR UPDATE) — only when the quote is a revision.
  if (quote.revisionOfQuoteId) {
    queueResult(opts.parentStatus === null ? [] : [{ id: quote.revisionOfQuoteId, status: opts.parentStatus ?? 'sent' }]);
  }
  queueResult([PARTNER]);                      // partner row
  queueResult([ORG]);                          // org (billing snapshot + recipient)
  if (quote.revisionOfQuoteId) {
    queueResult(opts.parentRecipients ?? []);  // parent recipients for the send fallback
  }
  queueResult(opts.claimed ?? [{ id: quote.id }]); // draft→sent claim ... returning
}

/** Everything after the claim for a send that reaches the email + re-select. */
function queueAfterClaim(over: Record<string, unknown> = {}) {
  queueResult([]); // portalBranding — none configured
  queueResult([]); // outcome-marker update
  queueResult([{ id: 'q2', orgId: 'org1', partnerId: 'p1', status: 'sent', revisionNumber: 2, ...over }]);
}

beforeEach(() => {
  results.length = 0;
  setCalls.length = 0;
  insertValueCalls.length = 0;
  whereCalls.length = 0;
  forCalls.length = 0;
  capturedEmailArgs = null;
  vi.clearAllMocks();
  sendEmailMock.mockResolvedValue(undefined);
});

describe('sendQuote — revision supersede', () => {
  it('retires a sent parent atomically with the child claim', async () => {
    queueRevisionThroughClaim({ parentStatus: 'sent' });
    queueResult([{ id: 'q1' }]); // parent flip ... returning
    queueAfterClaim();

    const result = await sendQuote('q2', actor);

    expect(result.superseded).toEqual({ parentQuoteId: 'q1', previousStatus: 'sent' });

    // The parent write must set BOTH the terminal status and the
    // DB-authoritative link revocation — a status flip without the revocation
    // would leave the old public link live.
    const flip = setCalls.find((p) => p.status === 'superseded');
    expect(flip).toBeDefined();
    expect(flip!.publicLinkRevokedAt).toBeInstanceOf(Date);

    const parentWhereIndex = whereCalls.reduce<number>((matchedIndex, predicate, index) => {
      // Exact SQL, not a value bag: this must match the parent's LOCKING READ
      // (id + org scope) and never the flip, whose predicate also binds q1.
      return compilePredicate(predicate).sql === '("quotes"."id" = $1 and "quotes"."org_id" = $2)'
        ? index
        : matchedIndex;
    }, -1);
    // Guard the locator itself: if the parent predicate were never found,
    // parentWhereIndex would be -1 and the assertion below would silently
    // degrade into "some .for() ran before any .where()".
    expect(parentWhereIndex).toBeGreaterThanOrEqual(0);
    // Bind the lock to the parent's own query so the child claim's
    // `.for('update')` cannot satisfy this assertion.
    expect(forCalls).toContainEqual({ mode: 'update', afterWhereIndex: parentWhereIndex + 1 });
  });

  it('predicate-guards the parent flip with the supersedable set, not a bare id', async () => {
    queueRevisionThroughClaim({ parentStatus: 'viewed' });
    queueResult([{ id: 'q1' }]);
    queueAfterClaim();

    await sendQuote('q2', actor);

    // Find the predicate used by the flip: it must bind the parent id AND use
    // an IN status guard. A bare `WHERE id = ?` here would let a stale read
    // stomp a concurrently-settled parent.
    const flipPredicate = whereCalls.map(compilePredicate).find((predicate) =>
      predicate.params.includes('q1') && predicate.sql.includes('"status" in'));
    expect(flipPredicate).toBeDefined();
    // Exact SQL is intentional: and→or, in→not in, and eq→ne must all fail.
    expect(flipPredicate!.sql).toBe(
      '("quotes"."id" = $1 and "quotes"."org_id" = $2 and "quotes"."status" in ($3, $4, $5, $6))',
    );
    expect(flipPredicate!.params).toEqual(['q1', 'org1', 'sent', 'viewed', 'declined', 'expired']);
  });

  it('refuses to supersede an accepted parent (PARENT_CONVERTED) and never claims the child', async () => {
    queueRevisionThroughClaim({ parentStatus: 'accepted' });

    await expect(sendQuote('q2', actor)).rejects.toMatchObject({
      code: 'PARENT_CONVERTED',
      status: 409,
    });
    // Nothing may be written: no claim, no flip.
    expect(setCalls).toEqual([]);
  });

  it('refuses to supersede a converted parent', async () => {
    queueRevisionThroughClaim({ parentStatus: 'converted' });

    await expect(sendQuote('q2', actor)).rejects.toMatchObject({
      code: 'PARENT_CONVERTED',
      status: 409,
    });
    expect(setCalls).toEqual([]);
  });

  it('409s when the parent flip matches zero rows (concurrent settle under the lock)', async () => {
    queueRevisionThroughClaim({ parentStatus: 'sent' });
    queueResult([]); // parent flip matched NOTHING

    await expect(sendQuote('q2', actor)).rejects.toMatchObject({
      code: 'PARENT_CONVERTED',
      status: 409,
    });
  });

  it('does not touch any parent row for a non-revision send', async () => {
    const plainDraft = draftRevision({ id: 'q2', revisionOfQuoteId: null, revisionNumber: 1, quoteNumber: 'Q-2026-0043' });
    queueRevisionThroughClaim({ quote: plainDraft });
    queueAfterClaim({ revisionNumber: 1 });

    const result = await sendQuote('q2', actor);

    expect(result.superseded).toBeUndefined();
    // No write may carry the superseded status.
    expect(setCalls.some((p) => p.status === 'superseded')).toBe(false);
  });

  it("defaults the revision's recipients to the PARENT's, over the org billing contact", async () => {
    queueRevisionThroughClaim({
      parentStatus: 'sent',
      parentRecipients: [{ email: 'ap@customer.example' }, { email: 'cfo@customer.example' }],
    });
    queueResult([{ id: 'q1' }]);
    queueAfterClaim();

    await sendQuote('q2', actor);

    // The persisted recipient authorization set is the parent's, NOT the org
    // billing contact — the people already in the conversation.
    const recipientInsert = insertValueCalls.flat() as Array<{ email: string }>;
    expect(recipientInsert.map((r) => r.email).sort())
      .toEqual(['ap@customer.example', 'cfo@customer.example']);
    expect(recipientInsert.map((r) => r.email)).not.toContain('billing@customer.example');
  });

  it('still honours explicit composer recipients over the parent fallback', async () => {
    queueRevisionThroughClaim({
      parentStatus: 'sent',
      parentRecipients: [{ email: 'ap@customer.example' }],
    });
    queueResult([{ id: 'q1' }]);
    queueAfterClaim();

    await sendQuote('q2', actor, { to: ['chosen@customer.example'] });

    const recipientInsert = insertValueCalls.flat() as Array<{ email: string }>;
    expect(recipientInsert.map((r) => r.email)).toEqual(['chosen@customer.example']);
  });

  it('defaults the subject to an "Updated proposal" line for a revision', async () => {
    queueRevisionThroughClaim({ parentStatus: 'sent', parentRecipients: [{ email: 'ap@customer.example' }] });
    queueResult([{ id: 'q1' }]);
    queueAfterClaim();

    // #3905 — the email is deferred out of the send transaction, so the
    // envelope only exists once the deferred has been run.
    await (await sendQuote('q2', actor)).deliverEmail();

    expect(capturedEmailArgs?.subject).toBe('Updated proposal Q-2026-0042-R2 from Acme MSP');
  });

  it('lets an explicit subject override the revision default', async () => {
    queueRevisionThroughClaim({ parentStatus: 'sent', parentRecipients: [{ email: 'ap@customer.example' }] });
    queueResult([{ id: 'q1' }]);
    queueAfterClaim();

    await (await sendQuote('q2', actor, { subject: 'Bespoke subject' })).deliverEmail();

    expect(capturedEmailArgs?.subject).toBe('Bespoke subject');
  });
});
