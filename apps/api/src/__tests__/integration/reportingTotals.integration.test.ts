import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { upsertFeedRates, REPORTING_RATE_BASE_CODE } from '../../services/exchangeRateService';
import { computeReportingTotal } from '../../services/reportingTotals';
import { getTestDb } from './setup';

/**
 * Real-DB proof that a reporting TOTAL is assembled from ONE database snapshot
 * (multi-currency spec §8, wave 7 / #3779).
 *
 * `computeReportingTotal` used to call the single-pair conversion primitive
 * once per merged group, and each of those ran its own "latest leg" query.
 * Under READ COMMITTED every statement takes a FRESH snapshot, so a feed or
 * manual-rate commit landing mid-request produced a total whose legs came from
 * two different database states — a figure that existed at no instant. That is
 * the hybrid cross-rate failure the leg loader exists to prevent, reappearing
 * one layer up in the totaller.
 *
 * The fixture moves BOTH legs together in one transaction, so the only honest
 * totals are the two intra-snapshot ones; a fixture where a single leg moves
 * could not detect a straddle at all. FX here is reporting-only — nothing this
 * test computes is written to any document.
 */

const BASE = REPORTING_RATE_BASE_CODE; // 'EUR' — the fixed reporting pivot.
const DATE = '2026-09-03';
const SNAP_A = { usd: '1.10000000', gbp: '0.85000000' };
const SNAP_B = { usd: '1.20000000', gbp: '0.95000000' };
const GROUPS = [
  { currencyCode: 'USD', amount: '100.00' },
  { currencyCode: 'GBP', amount: '100.00' },
];

async function writeSnapshot(snap: { usd: string; gbp: string }): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL breeze.scope = 'system'`);
    await tx.execute(sql`
      update exchange_rates set rate = ${snap.usd}::numeric
      where rate_date = ${DATE}::date and base_code = ${BASE} and quote_code = 'USD'`);
    await tx.execute(sql`
      update exchange_rates set rate = ${snap.gbp}::numeric
      where rate_date = ${DATE}::date and base_code = ${BASE} and quote_code = 'GBP'`);
  });
}

describe('computeReportingTotal — single-snapshot totalling (real DB)', () => {
  it('never sums legs read from two different database snapshots', async () => {
    await upsertFeedRates([
      { rateDate: DATE, baseCode: BASE, quoteCode: 'USD', rate: SNAP_A.usd, fetchedAt: new Date('2026-09-03T06:00:00.000Z') },
      { rateDate: DATE, baseCode: BASE, quoteCode: 'GBP', rate: SNAP_A.gbp, fetchedAt: new Date('2026-09-03T06:00:00.000Z') },
    ]);

    // The two honest totals, measured with the table HELD STILL — computed by
    // the service itself rather than re-derived in a JavaScript double.
    const settled = await computeReportingTotal(GROUPS, 'EUR', DATE);
    expect(settled.status).toBe('available');
    const legsA = settled.groups.map((g) => g.convertedAmount!);
    await writeSnapshot(SNAP_B);
    const settledB = await computeReportingTotal(GROUPS, 'EUR', DATE);
    expect(settledB.status).toBe('available');
    const legsB = settledB.groups.map((g) => g.convertedAmount!);

    const sum = (a: string, b: string) => (Number(a) + Number(b)).toFixed(2);
    const honest = [sum(legsA[0]!, legsA[1]!), sum(legsB[0]!, legsB[1]!)];
    const straddled = [sum(legsA[0]!, legsB[1]!), sum(legsB[0]!, legsA[1]!)];
    // Non-vacuity: a straddle is observable — all four candidate totals differ.
    expect(new Set([...honest, ...straddled]).size).toBe(4);
    expect(honest).toContain(settled.total);
    expect(honest).toContain(settledB.total);

    // Now flip the whole table back and forth on a SECOND connection (the
    // superuser test client, not the app pool the service reads through) while
    // totals are computed.
    let stop = false;
    let commits = 0;
    const writer = (async () => {
      for (let i = 0; !stop; i++) {
        await writeSnapshot(i % 2 === 0 ? SNAP_A : SNAP_B);
        commits++;
      }
    })();

    const observed = new Set<string>();
    try {
      for (let i = 0; i < 300; i++) {
        const total = await computeReportingTotal(GROUPS, 'EUR', DATE);
        expect(total.status).toBe('available');
        observed.add(total.total!);
      }
    } finally {
      stop = true;
      await writer;
    }

    // The barrier must have actually run, or the loop proved nothing.
    expect(commits).toBeGreaterThan(1);
    expect(observed.size).toBeGreaterThan(0);
    for (const total of observed) {
      expect(honest).toContain(total);
    }
  });
});
