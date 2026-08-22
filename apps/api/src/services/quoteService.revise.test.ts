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
const siteRestrictedActor = {
  ...actor,
  allowedSiteIds: ['site-allowed'],
};
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
    queueResult([{ id: row.revisionOfQuoteId, quoteNumber: null, siteId: row.siteId ?? null }]); // immediate parent
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
    queueResult([{ status: 'draft' }]); // reviseQuote: parent status row lock

    await expect(svc.reviseQuote('q1', actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('rejects a converted parent with PARENT_CONVERTED', async () => {
    queueGetQuote(quote({ status: 'converted' }));
    queueResult([{ status: 'converted' }]); // reviseQuote: parent status row lock

    await expect(svc.reviseQuote('q1', actor))
      .rejects.toMatchObject({ code: 'PARENT_CONVERTED', status: 409 });
  });

  it('rejects an accepted parent with PARENT_CONVERTED', async () => {
    queueGetQuote(quote({ status: 'accepted' }));
    queueResult([{ status: 'accepted' }]); // reviseQuote: parent status row lock

    await expect(svc.reviseQuote('q1', actor))
      .rejects.toMatchObject({ code: 'PARENT_CONVERTED', status: 409 });
  });

  it('rejects a superseded parent and reports its successor id', async () => {
    queueGetQuote(quote({ status: 'superseded' }));
    queueResult([{ status: 'superseded' }]); // reviseQuote: parent status row lock
    queueResult([{ id: 'q2' }]);

    await expect(svc.reviseQuote('q1', actor)).rejects.toMatchObject({
      code: 'ALREADY_SUPERSEDED',
      status: 409,
      meta: { successorQuoteId: 'q2' },
    });

    // Pin THIS lookup's predicate (the last where before the throw). A
    // toContainEqual would also be satisfied by getQuote's internal successor
    // query, staying green even if this branch queried the wrong column.
    const predicates = (db as unknown as Chain).where.mock.calls
      .map(([where]) => collectBoundParams(where));
    expect(predicates.at(-1)).toEqual([{ column: 'revision_of_quote_id', value: 'q1' }]);
  });

  it('uses a distinct error when a superseded parent has no successor row', async () => {
    queueGetQuote(quote({ status: 'superseded' }));
    queueResult([{ status: 'superseded' }]); // reviseQuote: parent status row lock
    queueResult([]);

    await expect(svc.reviseQuote('q1', actor)).rejects.toMatchObject({
      code: 'ALREADY_SUPERSEDED',
      status: 409,
      message: 'This quote is marked as superseded, but its replacement could not be found',
    });
  });

  it('rejects a parent with an existing draft successor', async () => {
    queueGetQuote(quote());
    queueResult([{ status: 'sent' }]); // reviseQuote: parent status row lock
    queueResult([{ id: 'q2', status: 'draft' }]);

    await expect(svc.reviseQuote('q1', actor)).rejects.toMatchObject({
      code: 'REVISION_IN_PROGRESS',
      status: 409,
      meta: { revisionQuoteId: 'q2' },
    });

    // Pin the PRE-CHECK's own predicate (the last where before the throw), not
    // merely "some query somewhere used revision_of_quote_id" — getQuote's
    // internal successor lookup also matches that, so a toContainEqual here
    // stays green even when this pre-check queries the wrong column.
    const predicates = (db as unknown as Chain).where.mock.calls
      .map(([where]) => collectBoundParams(where));
    expect(predicates.at(-1)).toEqual([{ column: 'revision_of_quote_id', value: 'q1' }]);
  });

  it('creates R2 from a sent root without allocating a new quote counter', async () => {
    const parent = quote();
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueSuccessfulClone(parent, quote({ id: 'q2', status: 'draft', quoteNumber: 'Q-2026-0042-R2', revisionOfQuoteId: 'q1', revisionNumber: 2 }));

    await svc.reviseQuote('q1', actor);

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
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueResult([quote({ id: 'q1' })]); // lineage root read
    queueSuccessfulClone(parent, quote({ id: 'q3', status: 'draft', quoteNumber: 'Q-2026-0042-R3', revisionOfQuoteId: 'q2', revisionNumber: 3 }));

    await svc.reviseQuote('q2', actor);

    const inserted = (db as unknown as Chain).values.mock.calls[0]![0];
    expect(inserted).toMatchObject({
      quoteNumber: 'Q-2026-0042-R3',
      revisionOfQuoteId: 'q2',
      revisionNumber: 3,
    });
    // Pin the WALK's direction: the lineage read is the query immediately after
    // the successor pre-check, and it must look the parent up BY ID. A bare
    // toContainEqual passes even when the walk is inverted to
    // `revision_of_quote_id = current.id`, which would climb the wrong way and
    // derive the number from the wrong root.
    const predicates = (db as unknown as Chain).where.mock.calls
      .map(([where]) => collectBoundParams(where));
    // `revision_of_quote_id = q2` occurs three times here (getQuote's own
    // successor field, this pre-check, then clone's getQuote), so neither the
    // first nor the last match is the pre-check. Assert the ADJACENT PAIR
    // instead: the pre-check must be followed immediately by the walk looking
    // the parent up BY ID. Inverting the walk to `revision_of_quote_id =
    // current.id` breaks the pair, which a bare toContainEqual would not catch.
    const seq = predicates.map((p) => JSON.stringify(p));
    const preCheck = JSON.stringify([{ column: 'revision_of_quote_id', value: 'q2' }]);
    const walk = JSON.stringify([{ column: 'id', value: 'q1' }]);
    const pairFound = seq.some((p, i) => p === preCheck && seq[i + 1] === walk);
    expect(pairFound).toBe(true);
  });

  it.each(['viewed', 'declined', 'expired'])('creates a revision from a %s parent', async (status) => {
    const parent = quote({ status });
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueSuccessfulClone(parent, quote({
      id: 'q2',
      status: 'draft',
      quoteNumber: 'Q-2026-0042-R2',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    }));

    await svc.reviseQuote('q1', actor);

    expect((db as unknown as Chain).values.mock.calls[0]![0]).toMatchObject({
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    });
  });

  it('rejects a legacy parent without a quote number', async () => {
    queueGetQuote(quote({ quoteNumber: null }));
    queueResult([{ status: 'sent' }]); // reviseQuote: parent status row lock

    await expect(svc.reviseQuote('q1', actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('maps a wrapped unique-successor insert race to REVISION_IN_PROGRESS with the winner id', async () => {
    const parent = quote();
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueGetQuote(parent); // clone source read
    queueResult([]); // images
    queueError(Object.assign(new Error('Failed query: insert into quotes'), {
      cause: {
        code: '23505',
        constraint_name: 'quotes_revision_of_uq',
        message: 'duplicate key value violates unique constraint "quotes_revision_of_uq"',
      },
    }));
    queueResult([{ id: 'q-race-winner' }]);

    await expect(svc.reviseQuote('q1', actor)).rejects.toMatchObject({
      code: 'REVISION_IN_PROGRESS',
      status: 409,
      meta: { revisionQuoteId: 'q-race-winner' },
    });
  });

  it('propagates a wrapped 23505 from a different constraint unchanged', async () => {
    const parent = quote();
    const error = Object.assign(new Error('Failed query: insert into quotes'), {
      cause: {
        code: '23505',
        constraint_name: 'quotes_partner_number_uq',
        message: 'duplicate key value violates unique constraint "quotes_partner_number_uq"',
      },
    });
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueGetQuote(parent); // clone source read
    queueResult([]); // images
    queueError(error);

    await expect(svc.reviseQuote('q1', actor)).rejects.toBe(error);
  });

  it('propagates a generic clone insert error unchanged', async () => {
    const parent = quote();
    const error = new Error('boom');
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueGetQuote(parent); // clone source read
    queueResult([]); // images
    queueError(error);

    await expect(svc.reviseQuote('q1', actor)).rejects.toBe(error);
  });

  it('rejects a corrupt lineage whose parent row is missing', async () => {
    const parent = quote({ id: 'q2', revisionOfQuoteId: 'q1', revisionNumber: 2 });
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueResult([]); // lineage parent missing

    await expect(svc.reviseQuote('q2', actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('rejects a lineage that exhausts the 100-hop cycle guard', async () => {
    const parent = quote({ id: 'q101', revisionOfQuoteId: 'q100', revisionNumber: 101 });
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    for (let id = 100; id >= 1; id -= 1) {
      queueResult([quote({ id: `q${id}`, revisionOfQuoteId: `q${id - 1}`, revisionNumber: id })]);
    }

    await expect(svc.reviseQuote('q101', actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it.each([
    ['a revision number below 2', quote({ revisionNumber: 0 })],
    ['a non-integer revision number', quote({ revisionNumber: 1.5 })],
    ['an empty parent id', quote({ id: '' })],
  ])('rejects clone lineage with %s', async (_label, parent) => {
    queueGetQuote(parent);
    queueResult([{ status: parent.status }]); // reviseQuote: parent status row lock
    queueResult([]); // no successor
    queueGetQuote(parent); // clone source read
    queueResult([]); // images

    await expect(svc.reviseQuote(String(parent.id), actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });
});

describe('cloneQuote revision boundary', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
  });

  it('rejects retargeting when an internal revision override is supplied', async () => {
    const cloneWithInternalOverride = svc.cloneQuote as unknown as (
      id: string,
      quoteActor: typeof actor,
      input: { orgId: string },
      revision: { quoteNumber: string; revisionOfQuoteId: string; revisionNumber: number },
    ) => Promise<unknown>;
    queueGetQuote(quote());
    queueResult([]); // images

    await expect(cloneWithInternalOverride('q1', actor, { orgId: 'org2' }, {
      quoteNumber: 'Q-2026-0042-R2',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    })).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
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
    queueResult([{ id: 'q1', quoteNumber: 'Q-2026-0042', siteId: null }]);
    queueResult([{ email: 'buyer@example.com' }, { email: 'cfo@example.com' }]);
    queueResult([{ id: 'q3', quoteNumber: 'Q-2026-0042-R3', status: 'draft', siteId: null }]);
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

  it('hides revisionOf and parent recipients when the parent site is denied', async () => {
    const child = quote({
      id: 'q2',
      siteId: 'site-allowed',
      revisionOfQuoteId: 'q1',
      revisionNumber: 2,
    });
    queueResult([child]);
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([{ id: 'q1', quoteNumber: 'Q-2026-0042', siteId: 'site-denied' }]);
    queueResult([]); // no successor
    queueResult([]); // quote order headers
    queueResult([]); // quote order lines

    const detail = await svc.getQuote('q2', siteRestrictedActor);

    expect(detail.revisionOf).toBeNull();
    const predicates = (db as unknown as Chain).where.mock.calls
      .map(([where]) => collectBoundParams(where));
    expect(predicates).not.toContainEqual([{ column: 'quote_id', value: 'q1' }]);
  });

  it('hides successor when the successor site is denied', async () => {
    const parent = quote({ siteId: 'site-allowed' });
    queueResult([parent]);
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([{ id: 'q2', quoteNumber: 'Q-2026-0042-R2', status: 'draft', siteId: 'site-denied' }]);
    queueResult([]); // quote order headers
    queueResult([]); // quote order lines

    const detail = await svc.getQuote('q1', siteRestrictedActor);

    expect(detail.successor).toBeNull();
  });

  it('logs a stable error id and stays non-fatal when a linked parent is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const child = quote({ id: 'q2', revisionOfQuoteId: 'q1', revisionNumber: 2 });
    queueResult([child]);
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([]); // corrupt missing parent
    queueResult([]); // no successor
    queueResult([]); // quote order headers
    queueResult([]); // quote order lines

    const detail = await svc.getQuote('q2', actor);

    expect(detail.revisionOf).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('QUOTE_LINEAGE_PARENT_MISSING'),
      expect.objectContaining({ quoteId: 'q2', revisionOfQuoteId: 'q1' }),
    );
    errorSpy.mockRestore();
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
