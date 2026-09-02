import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (invoiceService.test.ts / contractService.test.ts
// pattern) plus a call LOG, because the transaction's statement ORDER is part of
// this service's contract: `organizations FOR UPDATE` must be its first query.
const results: unknown[][] = [];
const log: string[] = [];
/** Field names of every `select({...})` projection, in call order — the shape
 *  proof for "the preflight never materialises billable ROWS" (review 4). */
const selectProjections: string[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'for', 'update', 'set', 'insert', 'values', 'returning', 'groupBy', 'orderBy', 'innerJoin', 'leftJoin'];
    for (const m of methods) chain[m] = vi.fn((...args: unknown[]) => {
      log.push(m === 'for' ? `for(${String(args[0])})` : m);
      if (m === 'select') selectProjections.push(Object.keys((args[0] ?? {}) as Record<string, unknown>));
      return chain;
    });
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => { log.push('transaction'); return run(chain); });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(resolve);
    return chain;
  };
  const db = makeChain();
  return { db, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});

import { db } from '../db';
import { changeOrgCurrency, getOrgCurrencyImpact } from './orgCurrencyService';

type Chain = { update: { mock: { calls: unknown[][] } }; set: { mock: { calls: unknown[][] } } };

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

/** The ten reads `getOrgCurrencyImpact` performs, in order. Callers override the
 *  interesting ones; everything else resolves empty. Billable rows arrive
 *  PRE-AGGREGATED (one row per currency), never one row per time entry/part. */
function queueImpact(over: {
  org?: unknown[]; invoices?: unknown[]; quotes?: unknown[]; contracts?: unknown[];
  time?: unknown[]; missingRate?: unknown[]; parts?: unknown[];
  rateSettings?: unknown[]; categories?: unknown[]; overrides?: unknown[];
} = {}) {
  queueResult(over.org ?? [{ id: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
  queueResult(over.invoices ?? []);
  queueResult(over.quotes ?? []);
  queueResult(over.contracts ?? []);
  queueResult(over.time ?? []);
  queueResult(over.missingRate ?? []);
  queueResult(over.parts ?? []);
  queueResult(over.rateSettings ?? []);
  queueResult(over.categories ?? [{ n: 0 }]);
  queueResult(over.overrides ?? [{ n: 0 }]);
}

beforeEach(() => { results.length = 0; log.length = 0; selectProjections.length = 0; vi.clearAllMocks(); });

describe('changeOrgCurrency (#3778)', () => {
  it('takes the organizations FOR UPDATE lock as the transaction FIRST query', async () => {
    queueResult([{ id: 'org1', currencyCode: 'EUR' }]); // the locked row
    queueResult([]); // the UPDATE
    queueImpact();
    await changeOrgCurrency('org1', { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true }, actor);
    const firstFor = log.indexOf('for(update)');
    expect(firstFor).toBeGreaterThan(-1);
    // Nothing but the first select/from/where/limit precedes the lock: the lock
    // belongs to the FIRST statement of the transaction.
    expect(log.slice(0, firstFor + 1)).toEqual(['transaction', 'select', 'from', 'where', 'limit', 'for(update)']);
    // …and it is the ONLY row this transaction locks (never a second edge of a cycle).
    expect(log.filter((e) => e.startsWith('for('))).toEqual(['for(update)']);
  });

  it('computes the advisory impact OUTSIDE the lock — the locked section is the lock plus the UPDATE only', async () => {
    queueResult([{ id: 'org1', currencyCode: 'EUR' }]);
    queueResult([]); // the UPDATE
    queueImpact();
    await changeOrgCurrency('org1', { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true }, actor);
    // Everything between opening the transaction and the UPDATE: the lock read
    // and nothing else. The impact scan must not hold `organizations FOR UPDATE`,
    // which every default-derived writer's FOR SHARE barrier blocks on.
    const start = log.indexOf('transaction');
    const upd = log.indexOf('update');
    expect(upd).toBeGreaterThan(-1);
    expect(log.slice(start, upd)).toEqual(['transaction', 'select', 'from', 'where', 'limit', 'for(update)']);
  });

  it('still reports a fresh impact on the 409 stale precondition, computed after the lock is released', async () => {
    queueResult([{ id: 'org1', currencyCode: 'GBP' }]);
    queueImpact({ org: [{ id: 'org1', partnerId: 'p1', currencyCode: 'GBP' }] });
    await expect(
      changeOrgCurrency('org1', { currencyCode: 'USD', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true }, actor)
    ).rejects.toMatchObject({ code: 'ORG_CURRENCY_CHANGED', status: 409 });
    const start = log.indexOf('transaction');
    // No impact read happened before the lock read finished the transaction.
    expect(log.slice(start, start + 6)).toEqual(['transaction', 'select', 'from', 'where', 'limit', 'for(update)']);
  });

  it('writes the new currency and reports the previous one', async () => {
    queueResult([{ id: 'org1', currencyCode: 'EUR' }]);
    queueResult([]); // the UPDATE
    queueImpact();
    const out = await changeOrgCurrency('org1', { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true }, actor);
    expect(out).toMatchObject({ orgId: 'org1', previousCurrencyCode: 'EUR', currencyCode: 'GBP' });
    expect((db as unknown as Chain).update.mock.calls.length).toBe(1);
    expect((db as unknown as Chain).set.mock.calls[0]?.[0]).toMatchObject({ currencyCode: 'GBP' });
  });

  it('is an idempotent no-op for a same-currency request — no UPDATE, no confirmation needed', async () => {
    queueResult([{ id: 'org1', currencyCode: 'EUR' }]);
    queueImpact();
    const out = await changeOrgCurrency('org1', { currencyCode: 'EUR', expectedCurrentCurrencyCode: 'EUR' }, actor);
    expect(out).toMatchObject({ previousCurrencyCode: 'EUR', currencyCode: 'EUR' });
    expect((db as unknown as Chain).update.mock.calls.length).toBe(0);
  });

  it('throws ORG_CURRENCY_CHANGED (409) with a fresh impact summary on a stale precondition', async () => {
    queueResult([{ id: 'org1', currencyCode: 'GBP' }]); // someone already changed it
    queueImpact({ org: [{ id: 'org1', partnerId: 'p1', currencyCode: 'GBP' }] });
    await expect(
      changeOrgCurrency('org1', { currencyCode: 'USD', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true }, actor)
    ).rejects.toMatchObject({
      code: 'ORG_CURRENCY_CHANGED', status: 409,
      details: { currentCurrencyCode: 'GBP', impact: { currentCurrencyCode: 'GBP', targetCurrencyCode: 'USD' } },
    });
    expect((db as unknown as Chain).update.mock.calls.length).toBe(0);
  });

  it('throws CONFIRMATION_REQUIRED (400) when a REAL change carries no confirmation', async () => {
    queueResult([{ id: 'org1', currencyCode: 'EUR' }]);
    await expect(
      changeOrgCurrency('org1', { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR' }, actor)
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 400 });
    expect((db as unknown as Chain).update.mock.calls.length).toBe(0);
  });

  it('throws ORG_DENIED (403) for a cross-org actor before opening a transaction', async () => {
    await expect(
      changeOrgCurrency('org1', { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true },
        { ...actor, accessibleOrgIds: ['other'] })
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403, name: 'InvoiceServiceError' });
    expect(log).not.toContain('transaction');
  });

  it('throws ORG_NOT_FOUND (404) when the locked row is absent', async () => {
    queueResult([]);
    await expect(
      changeOrgCurrency('missing', { currencyCode: 'GBP', expectedCurrentCurrencyCode: 'EUR', confirmSnapshotRetention: true },
        { ...actor, accessibleOrgIds: null })
    ).rejects.toMatchObject({ code: 'ORG_NOT_FOUND', status: 404 });
  });
});

describe('getOrgCurrencyImpact (#3778)', () => {
  it('groups rows by their OWN stamp and never sums across currencies', async () => {
    queueImpact({
      invoices: [{ currencyCode: 'EUR', n: 2 }, { currencyCode: 'USD', n: 1 }],
      quotes: [{ currencyCode: 'EUR', status: 'sent', n: 3 }],
      contracts: [{ currencyCode: 'EUR', status: 'active', n: 1 }],
      time: [
        { currencyCode: 'EUR', monetary: 1, running: 0, nonBillable: 0, ready: 1, labor2: '150.00', labor0: '150' },
        { currencyCode: 'USD', monetary: 1, running: 1, nonBillable: 1, ready: 0, labor2: '50.00', labor0: '50' },
      ],
      parts: [{ currencyCode: 'USD', monetary: 1, ready: 1, nonBillable: 0, amount2: '20.00', amount0: '20' }],
    });
    const impact = await getOrgCurrencyImpact('org1', 'GBP', actor);

    expect(impact).toMatchObject({ orgId: 'org1', currentCurrencyCode: 'EUR', targetCurrencyCode: 'GBP', changeRequired: true });
    expect(impact.impactsByCurrency.map((g) => g.currencyCode)).toEqual(['EUR', 'USD']);

    const eur = impact.impactsByCurrency[0]!;
    expect(eur.documents).toMatchObject({ draftInvoices: 2, sentQuotes: 3 });
    expect(eur.contracts.active).toBe(1);
    expect(eur.billables).toMatchObject({ monetaryTimeSnapshots: 1, readyTimeEntries: 1, laborAmount: '150.00' });
    expect(eur.recovery).toEqual({ kind: 'assemble_draft', currencyCode: 'EUR' });

    const usd = impact.impactsByCurrency[1]!;
    expect(usd.documents.draftInvoices).toBe(1);
    // The USD entry is running AND non-billable — counted, never merged into EUR.
    expect(usd.billables).toMatchObject({
      runningTimeEntries: 1, currentlyNonBillableTimeEntries: 1, readyTimeEntries: 0,
      laborAmount: '50.00', monetaryPartSnapshots: 1, readyParts: 1, partAmount: '20.00',
    });
  });

  it('rounds JPY labor at the ZERO-decimal minor unit (20 min x 1000 = 330, never 333)', async () => {
    queueImpact({
      org: [{ id: 'org1', partnerId: 'p1', currencyCode: 'JPY' }],
      time: [{ currencyCode: 'JPY', monetary: 1, running: 0, nonBillable: 0, ready: 1, labor2: '333.33', labor0: '330' }],
    });
    const impact = await getOrgCurrencyImpact('org1', 'USD', actor);
    expect(impact.impactsByCurrency[0]!.billables.laborAmount).toBe('330.00');
  });

  it('reports the configuration warnings (org default rate stops applying, skipped rates/overrides)', async () => {
    queueImpact({
      rateSettings: [{ defaultHourlyRate: '85.50', rateCurrency: 'EUR' }],
      categories: [{ n: 4 }],
      overrides: [{ n: 2 }],
    });
    const impact = await getOrgCurrencyImpact('org1', 'GBP', actor);
    expect(impact.configurationWarnings).toEqual({
      orgDefaultRate: { configured: true, rateCurrency: 'EUR', willStopApplying: true },
      categoryRatesSkipped: 4,
      orgCatalogOverridesSkipped: 2,
      rateLessTimeEntries: 0,
    });
  });

  it('does not warn when the org default rate is already in the target currency', async () => {
    queueImpact({ rateSettings: [{ defaultHourlyRate: '85.50', rateCurrency: 'GBP' }] });
    const impact = await getOrgCurrencyImpact('org1', 'GBP', actor);
    expect(impact.configurationWarnings.orgDefaultRate).toEqual({ configured: true, rateCurrency: 'GBP', willStopApplying: false });
  });

  it('never materialises billable ROWS — every billable read is a per-currency aggregate', async () => {
    queueImpact();
    await getOrgCurrencyImpact('org1', 'GBP', actor);
    // Per-row billable columns must never appear in a projection: a few hundred
    // thousand unbilled entries would otherwise be pulled into JS to be summed.
    const perRowColumns = ['hourlyRate', 'durationMinutes', 'endedAt', 'isBillable', 'quantity', 'unitPrice'];
    const offenders = selectProjections.filter((keys) => keys.some((k) => perRowColumns.includes(k)));
    expect(offenders).toEqual([]);
    // …and the sums genuinely come back aggregated, per currency.
    expect(selectProjections.some((keys) => keys.includes('labor2') && keys.includes('labor0'))).toBe(true);
    expect(selectProjections.some((keys) => keys.includes('amount2') && keys.includes('amount0'))).toBe(true);
  });

  it('picks the ZERO-decimal sum for a zero-decimal currency (JPY labor is not a 2dp sum)', async () => {
    queueImpact({
      org: [{ id: 'org1', partnerId: 'p1', currencyCode: 'JPY' }],
      time: [{ currencyCode: 'JPY', monetary: 2, running: 0, nonBillable: 0, ready: 2, labor2: '666.66', labor0: '660' }],
    });
    const impact = await getOrgCurrencyImpact('org1', 'USD', actor);
    expect(impact.impactsByCurrency[0]!.billables.laborAmount).toBe('660.00');
  });

  it('never emits a group keyed on the TARGET currency for rate-less entries (review 6)', async () => {
    // A EUR time entry with a null rate, in an org moving USD -> EUR. It is not
    // stranded: telling the operator to assemble a EUR draft is nonsense.
    queueImpact({
      org: [{ id: 'org1', partnerId: 'p1', currencyCode: 'USD' }],
      missingRate: [{ currencyCode: 'EUR', n: 3 }],
    });
    const impact = await getOrgCurrencyImpact('org1', 'EUR', actor);
    expect(impact.impactsByCurrency).toEqual([]);
    expect(impact.configurationWarnings.rateLessTimeEntries).toBe(3);
  });

  it('never emits an UNKNOWN recovery currency for unstamped rate-less entries (review 6)', async () => {
    queueImpact({ missingRate: [{ currencyCode: null, n: 2 }] });
    const impact = await getOrgCurrencyImpact('org1', 'GBP', actor);
    expect(impact.impactsByCurrency).toEqual([]);
    expect(impact.configurationWarnings.rateLessTimeEntries).toBe(2);
  });

  it('counts rate-less entries stranded in an OLD currency inside that currency group', async () => {
    queueImpact({
      missingRate: [{ currencyCode: 'EUR', n: 4 }, { currencyCode: 'GBP', n: 1 }, { currencyCode: null, n: 1 }],
    });
    const impact = await getOrgCurrencyImpact('org1', 'GBP', actor);
    expect(impact.impactsByCurrency.map((g) => g.currencyCode)).toEqual(['EUR']);
    const eur = impact.impactsByCurrency[0]!;
    expect(eur.billables.missingRateTimeEntries).toBe(4);
    expect(eur.recovery).toEqual({ kind: 'assemble_draft', currencyCode: 'EUR' });
    // The target-stamped and unstamped ones need a RATE, not an assemble-draft.
    expect(impact.configurationWarnings.rateLessTimeEntries).toBe(2);
  });

  it('throws ORG_DENIED (403) for a cross-org actor', async () => {
    await expect(getOrgCurrencyImpact('org1', 'GBP', { ...actor, accessibleOrgIds: ['other'] }))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });

  it('throws ORG_NOT_FOUND (404) for an unknown org', async () => {
    queueResult([]);
    await expect(getOrgCurrencyImpact('org1', 'GBP', actor)).rejects.toMatchObject({ code: 'ORG_NOT_FOUND', status: 404 });
  });
});
