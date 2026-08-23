import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (invoiceService.test.ts / contractService.test.ts
// pattern) plus a call LOG, because the transaction's statement ORDER is part of
// this service's contract: `organizations FOR UPDATE` must be its first query.
const results: unknown[][] = [];
const log: string[] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'for', 'update', 'set', 'insert', 'values', 'returning', 'groupBy', 'orderBy', 'innerJoin', 'leftJoin'];
    for (const m of methods) chain[m] = vi.fn((...args: unknown[]) => { log.push(m === 'for' ? `for(${String(args[0])})` : m); return chain; });
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
 *  interesting ones; everything else resolves empty. */
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

beforeEach(() => { results.length = 0; log.length = 0; vi.clearAllMocks(); });

describe('changeOrgCurrency (#3778)', () => {
  it('takes the organizations FOR UPDATE lock as the transaction FIRST query', async () => {
    queueResult([{ id: 'org1', currencyCode: 'EUR' }]); // the locked row
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

  it('writes the new currency and reports the previous one', async () => {
    queueResult([{ id: 'org1', currencyCode: 'EUR' }]);
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
        { currencyCode: 'EUR', hourlyRate: '100.00', durationMinutes: 90, isBillable: true, endedAt: new Date() },
        { currencyCode: 'USD', hourlyRate: '50.00', durationMinutes: 60, isBillable: false, endedAt: null },
      ],
      parts: [{ currencyCode: 'USD', quantity: '2.00', unitPrice: '10.00', isBillable: true }],
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
      time: [{ currencyCode: 'JPY', hourlyRate: '1000.00', durationMinutes: 20, isBillable: true, endedAt: new Date() }],
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
    });
  });

  it('does not warn when the org default rate is already in the target currency', async () => {
    queueImpact({ rateSettings: [{ defaultHourlyRate: '85.50', rateCurrency: 'GBP' }] });
    const impact = await getOrgCurrencyImpact('org1', 'GBP', actor);
    expect(impact.configurationWarnings.orgDefaultRate).toEqual({ configured: true, rateCurrency: 'GBP', willStopApplying: false });
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
