import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Param, SQL } from 'drizzle-orm';

// Controllable Drizzle chain mock (same pattern as quoteService.test.ts): every
// builder method returns the same chain; a query resolves when awaited. The
// error variant lets the insert race test surface a Postgres-shaped rejection.
const results: Array<unknown[] | Error> = [];
function queueResult(rows: unknown[]) { results.push(rows); }
function queueError(error: Error) { results.push(error); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute'];
    for (const method of methods) chain[method] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) => {
      const result = results.shift() ?? [];
      return result instanceof Error
        ? Promise.reject(result).then(resolve, reject)
        : Promise.resolve(result).then(resolve, reject);
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

vi.mock('./quoteNumbers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quoteNumbers')>();
  return { ...actual, allocateQuoteCounter: vi.fn() };
});

import { db } from '../db';
import { allocateQuoteCounter } from './quoteNumbers';
import * as svc from './quoteService';

type Chain = {
  set: { mock: { calls: unknown[][] } };
  values: { mock: { calls: unknown[][] } };
  where: { mock: { calls: unknown[][] } };
};

function collectBoundParams(node: unknown): { column: string; value: unknown }[] {
  const found: { column: string; value: unknown }[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (value == null || typeof value !== 'object' || seen.has(value as object)) return;
    seen.add(value as object);
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
const quote = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  partnerId: 'p1',
  orgId: 'org1',
  siteId: null,
  quoteNumber: 'Q-2026-0042',
  title: 'Proposal',
  status: 'sent',
  currencyCode: 'USD',
  taxRate: null,
  depositType: 'none',
  depositPercent: null,
  billToName: 'Customer',
  billToAddress: null,
  billToTaxId: null,
  coverPage: null,
  revisionOfQuoteId: null,
  revisionNumber: 1,
  ...over,
});

/** Queue the complete read shape issued by getQuote for an empty quote. */
function queueGetQuote(row: Record<string, unknown>) {
  queueResult([row]);
  queueResult([]); // blocks
  queueResult([]); // lines
  queueResult([]); // no staged Pax8 order
  if (row.revisionOfQuoteId) {
    queueResult([{ id: row.revisionOfQuoteId, quoteNumber: null }]); // immediate parent
    queueResult([]); // parent recipients
  }
  queueResult([]); // no successor
  queueResult([]); // quote order headers
  queueResult([]); // quote order lines
  if (row.status === 'draft') queueResult([{ name: 'Customer' }]); // draft bill-to org
}

function queueSuccessfulClone(source: Record<string, unknown>, inserted: Record<string, unknown>) {
  queueGetQuote(source);
  queueResult([]); // images
  queueResult([inserted]); // quote insert returning
}

describe('reviseQuote', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
  });

  it('rejects a draft parent with INVALID_STATE', async () => {
    queueGetQuote(quote({ status: 'draft' }));

    await expect(svc.reviseQuote('q1', actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('rejects a converted parent with PARENT_CONVERTED', async () => {
    queueGetQuote(quote({ status: 'converted' }));

    await expect(svc.reviseQuote('q1', actor))
      .rejects.toMatchObject({ code: 'PARENT_CONVERTED', status: 409 });
  });

  it('rejects a superseded parent and reports its successor id', async () => {
    queueGetQuote(quote({ status: 'superseded' }));
    queueResult([{ id: 'q2' }]);

    await expect(svc.reviseQuote('q1', actor)).rejects.toMatchObject({
      code: 'ALREADY_SUPERSEDED',
      status: 409,
      meta: { successorQuoteId: 'q2' },
    });
  });

  it('rejects a parent with an existing draft successor', async () => {
    queueGetQuote(quote());
    queueResult([{ id: 'q2', status: 'draft' }]);

    await expect(svc.reviseQuote('q1', actor)).rejects.toMatchObject({
      code: 'REVISION_IN_PROGRESS',
      status: 409,
      meta: { revisionQuoteId: 'q2' },
    });
  });

  it('creates R2 from a sent root without allocating a new quote counter', async () => {
    const parent = quote();
    queueGetQuote(parent);
    queueResult([]); // no successor
    queueSuccessfulClone(parent, quote({ id: 'q2', status: 'draft', quoteNumber: 'Q-2026-0042-R2', revisionOfQuoteId: 'q1', revisionNumber: 2 }));

    const revised = await svc.reviseQuote('q1', actor);

    expect(revised).toMatchObject({
      id: 'q2',
      status: 'draft',
      quoteNumber: 'Q-2026-0042-R2',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    });
    expect(allocateQuoteCounter).not.toHaveBeenCalled();
    const inserted = (db as unknown as Chain).values.mock.calls[0]![0];
    expect(inserted).toMatchObject({
      quoteNumber: 'Q-2026-0042-R2',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    });
  });

  it('creates R3 from the root stored number instead of appending to the R2 number', async () => {
    const parent = quote({
      id: 'q2',
      quoteNumber: 'Q-2026-0042-R2',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    });
    queueGetQuote(parent);
    queueResult([]); // no successor
    queueResult([quote({ id: 'q1' })]); // lineage root read
    queueSuccessfulClone(parent, quote({ id: 'q3', status: 'draft', quoteNumber: 'Q-2026-0042-R3', revisionOfQuoteId: 'q2', revisionNumber: 3 }));

    const revised = await svc.reviseQuote('q2', actor);

    expect(revised.quoteNumber).toBe('Q-2026-0042-R3');
    expect(revised.quoteNumber).not.toContain('-R2-R3');
    const inserted = (db as unknown as Chain).values.mock.calls[0]![0];
    expect(inserted).toMatchObject({
      quoteNumber: 'Q-2026-0042-R3',
      revisionOfQuoteId: 'q2',
      revisionNumber: 3,
    });
  });

  it('rejects a legacy parent without a quote number', async () => {
    queueGetQuote(quote({ quoteNumber: null }));

    await expect(svc.reviseQuote('q1', actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('maps the unique-successor insert race to REVISION_IN_PROGRESS', async () => {
    const parent = quote();
    queueGetQuote(parent);
    queueResult([]); // no successor
    queueGetQuote(parent); // clone source read
    queueResult([]); // images
    queueError(Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'quotes_revision_of_uq',
    }));

    await expect(svc.reviseQuote('q1', actor)).rejects.toMatchObject({
      code: 'REVISION_IN_PROGRESS',
      status: 409,
    });
  });
});

describe('getQuote revision lineage', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
  });

  it('populates the immediate parent recipients and immediate successor', async () => {
    const child = quote({
      id: 'q2',
      status: 'sent',
      quoteNumber: 'Q-2026-0042-R2',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    });
    queueResult([child]);
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([{ id: 'q1', quoteNumber: 'Q-2026-0042' }]);
    queueResult([{ email: 'buyer@example.com' }, { email: 'cfo@example.com' }]);
    queueResult([{ id: 'q3', quoteNumber: 'Q-2026-0042-R3', status: 'draft' }]);
    queueResult([]); // quote order headers
    queueResult([]); // quote order lines

    const detail = await svc.getQuote('q2', actor);

    expect(detail.revisionOf).toEqual({
      id: 'q1',
      quoteNumber: 'Q-2026-0042',
      recipients: ['buyer@example.com', 'cfo@example.com'],
    });
    expect(detail.successor).toEqual({
      id: 'q3',
      quoteNumber: 'Q-2026-0042-R3',
      status: 'draft',
    });

    const predicates = (db as unknown as Chain).where.mock.calls
      .map(([where]) => collectBoundParams(where));
    expect(predicates).toContainEqual([{ column: 'id', value: 'q1' }]);
    expect(predicates).toContainEqual([{ column: 'quote_id', value: 'q1' }]);
    expect(predicates).toContainEqual([{ column: 'revision_of_quote_id', value: 'q2' }]);
  });
});

describe('updateQuote revision retarget guard', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
  });

  it('rejects moving a revision draft to another org before any write', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([quote({
      id: 'q2',
      status: 'draft',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    })]);

    await expect(svc.updateQuote('q2', { orgId: 'org2' }, orgActor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
    expect((db as unknown as Chain).set.mock.calls).toEqual([]);
  });
});
