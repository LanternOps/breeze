import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../../db';
import { exchangeRates } from '../../db/schema';
import {
  upsertFeedRates,
  setManualRate,
  deleteManualRate,
  resolveReportingRate,
  convertForReporting,
  REPORTING_RATE_BASE_CODE,
} from '../../services/exchangeRateService';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

/**
 * Real-DB proof of the three exchangeRateService invariants that are SQL
 * behaviour, not TypeScript (multi-currency spec §8, wave 7 / #3779):
 *
 *  1. MANUAL PRECEDENCE — `upsertFeedRates` carries
 *     `WHERE exchange_rates.source <> 'manual'` on its conflict target, so the
 *     daily feed can never clobber an operator override in EITHER commit
 *     ordering. Proven here under two FORCED transaction-barrier interleavings;
 *     a `Promise.all` proves nothing (both statements can serialize without
 *     ever contending, so the test passes while never touching the contested
 *     path).
 *  2. LATEST-ON-OR-BEFORE + the 7-day staleness ceiling — index-backed
 *     `DISTINCT ON` ordering, UTC calendar-day age, `stale` / `missing`
 *     unavailability, and never a silent 1:1.
 *  3. EUR-PIVOT CROSS RATES — computed in Postgres `numeric` off a SINGLE leg
 *     snapshot, so a commit landing mid-resolution can never yield a hybrid
 *     rate that existed at no instant.
 *
 * Fixture dates are fixed literals — never `new Date()` — so the staleness
 * boundary is deterministic. `exchange_rates` is in CLEANUP_TABLES
 * (setup.ts), so every test starts against a truncated table; each block still
 * uses its OWN quote currency so no two cases can contend for a cell.
 */

const BASE = REPORTING_RATE_BASE_CODE; // 'EUR' — the fixed reporting pivot.

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

type Key = { rateDate: string; baseCode: string; quoteCode: string };

async function readRow(key: Key) {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select().from(exchangeRates).where(
        and(
          eq(exchangeRates.rateDate, key.rateDate),
          eq(exchangeRates.baseCode, key.baseCode),
          eq(exchangeRates.quoteCode, key.quoteCode),
        ),
      ),
    ),
  );
  return row;
}

async function seedFeed(rateDate: string, quoteCode: string, rate: string, fetchedAt = new Date('2026-09-03T06:00:00.000Z')) {
  return upsertFeedRates([{ rateDate, baseCode: BASE, quoteCode, rate, fetchedAt }]);
}

/** The expected cross rate, computed by Postgres exactly as the service does —
 *  never re-derived in a JavaScript double. */
async function pgCross(fromRate: string, toRate: string): Promise<string> {
  const rows = (await getTestDb().execute(
    sql`select round(${toRate}::numeric / ${fromRate}::numeric, 8) as rate`,
  )) as unknown as Array<{ rate: string }>;
  return String(rows[0]!.rate);
}

/**
 * Block until some backend is parked on a lock it cannot get — i.e. the second
 * writer in a barrier case has genuinely reached the contested row. Integration
 * files run sequentially (`fileParallelism: false`), so an ungranted lock is
 * ours. Throwing on timeout is deliberate: if the writer never blocks, the
 * barrier proved nothing and the test must FAIL rather than pass vacuously.
 */
async function waitForBlockedWriter(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await getTestDb().execute(
      sql`select count(*)::int as n from pg_locks where not granted`,
    )) as unknown as Array<{ n: number }>;
    if (Number(rows[0]!.n) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('barrier never engaged: the second writer never blocked on the held row lock');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('exchangeRateService — manual precedence (real DB)', () => {
  it('feed then manual on the same cell leaves the manual rate', async () => {
    const key = { rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'USD' };
    await seedFeed(key.rateDate, key.quoteCode, '1.09000000');
    await setManualRate({ ...key, rate: '1.15000000' });

    expect(await readRow(key)).toMatchObject({ source: 'manual', rate: '1.15000000' });
  });

  it('manual then feed protects the manual rate and reports it', async () => {
    const key = { rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'GBP' };
    await setManualRate({ ...key, rate: '0.90000000' });

    const result = await seedFeed(key.rateDate, key.quoteCode, '0.85000000');
    expect(result).toEqual({ submitted: 1, stored: 0, manualProtected: 1 });
    expect(await readRow(key)).toMatchObject({ source: 'manual', rate: '0.90000000' });
  });

  it('a feed refresh updates an existing ecb cell rate and fetched_at', async () => {
    const key = { rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'CHF' };
    await seedFeed(key.rateDate, key.quoteCode, '0.94000000', new Date('2026-09-03T06:00:00.000Z'));
    const before = await readRow(key);

    const result = await seedFeed(key.rateDate, key.quoteCode, '0.96000000', new Date('2026-09-03T18:30:00.000Z'));
    expect(result).toEqual({ submitted: 1, stored: 1, manualProtected: 0 });

    const after = await readRow(key);
    expect(after).toMatchObject({ source: 'ecb', rate: '0.96000000' });
    expect(new Date(after!.fetchedAt as unknown as string).toISOString()).toBe('2026-09-03T18:30:00.000Z');
    expect(new Date(after!.fetchedAt as unknown as string).getTime())
      .toBeGreaterThan(new Date(before!.fetchedAt as unknown as string).getTime());
  });

  it('deleteManualRate refuses to delete an ecb cell', async () => {
    const key = { rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'CAD' };
    await seedFeed(key.rateDate, key.quoteCode, '1.48000000');

    expect(await deleteManualRate(key)).toBe(false);
    expect(await readRow(key)).toMatchObject({ source: 'ecb', rate: '1.48000000' });
  });

  it('setManualRate succeeds when called from inside an org-scoped request context', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const key = { rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'AUD' };

    // The runOutsideDbContext + system-context escape inside the service is what
    // makes a request-path caller able to write a global table at all.
    const row = await withDbAccessContext(orgContext(org.id), () =>
      setManualRate({ ...key, rate: '1.66000000' }),
    );
    expect(row).toMatchObject({ source: 'manual', rate: '1.66000000' });
    expect(await readRow(key)).toMatchObject({ source: 'manual', rate: '1.66000000' });
  });
});

describe('exchangeRateService — forced commit-order barriers', () => {
  // Barrier A — the feed upsert is IN FLIGHT and uncommitted when the manual
  // write arrives. The manual write blocks on the feed's row lock, then applies
  // on top: final state manual.
  it('manual wins when it arrives while an uncommitted feed upsert holds the row', async () => {
    const key = { rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'NOK' };
    const held = deferred();
    const feedWrote = deferred();

    const feedTx = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL breeze.scope = 'system'`);
      await tx.execute(sql`
        insert into exchange_rates (rate_date, base_code, quote_code, rate, source, fetched_at)
        values (${key.rateDate}::date, ${key.baseCode}, ${key.quoteCode}, '11.10000000', 'ecb', now())
        on conflict (rate_date, base_code, quote_code)
        do update set rate = excluded.rate, source = 'ecb', fetched_at = excluded.fetched_at
        where exchange_rates.source <> 'manual'`);
      feedWrote.resolve();
      await held.promise; // keep the row locked until the manual write is queued
    });

    await feedWrote.promise;
    const manual = setManualRate({ ...key, rate: '11.99000000' });
    await waitForBlockedWriter(); // the manual write is now parked on the feed's lock
    held.resolve();
    await Promise.all([feedTx, manual]);

    expect(await readRow(key)).toMatchObject({ source: 'manual', rate: '11.99000000' });
  });

  // Barrier B — the reverse: an uncommitted MANUAL write holds the row when the
  // feed upsert arrives. The feed blocks, re-evaluates `setWhere` against the
  // COMMITTED manual row, and updates zero rows.
  it('feed cannot clobber a manual row it had to wait for', async () => {
    const key = { rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'SEK' };
    const held = deferred();
    const manualWrote = deferred();

    const manualTx = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL breeze.scope = 'system'`);
      await tx.execute(sql`
        insert into exchange_rates (rate_date, base_code, quote_code, rate, source, fetched_at)
        values (${key.rateDate}::date, ${key.baseCode}, ${key.quoteCode}, '10.50000000', 'manual', now())`);
      manualWrote.resolve();
      await held.promise;
    });

    await manualWrote.promise;
    const feed = upsertFeedRates([{ ...key, rate: '10.00000000', fetchedAt: new Date('2026-09-03T06:00:00.000Z') }]);
    await waitForBlockedWriter();
    held.resolve();
    const [, result] = await Promise.all([manualTx, feed]);

    expect(result).toEqual({ submitted: 1, stored: 0, manualProtected: 1 });
    expect(await readRow(key)).toMatchObject({ source: 'manual', rate: '10.50000000' });
  });
});

describe('exchangeRateService — latest-on-or-before and staleness', () => {
  it('selects the latest row on or before the requested date and ignores future rows', async () => {
    const quoteCode = 'USD';
    await seedFeed('2026-09-01', quoteCode, '1.05000000');
    await seedFeed('2026-09-03', quoteCode, '1.10000000');
    await seedFeed('2026-09-05', quoteCode, '1.20000000'); // future relative to both lookups

    const onDate = await resolveReportingRate(BASE, quoteCode, '2026-09-03');
    expect(onDate).toMatchObject({ status: 'available', rate: '1.10000000', rateDate: '2026-09-03' });

    const between = await resolveReportingRate(BASE, quoteCode, '2026-09-02');
    expect(between).toMatchObject({ status: 'available', rate: '1.05000000', rateDate: '2026-09-01' });
  });

  it('a leg exactly 7 UTC days old is still available', async () => {
    await seedFeed('2026-09-03', 'SEK', '11.20000000');
    const result = await resolveReportingRate(BASE, 'SEK', '2026-09-10');
    expect(result).toMatchObject({ status: 'available', rate: '11.20000000', rateDate: '2026-09-03' });
  });

  it('a leg 8 UTC days old is unavailable with reason stale and the last rate date', async () => {
    await seedFeed('2026-09-02', 'NOK', '11.60000000');
    const result = await resolveReportingRate(BASE, 'NOK', '2026-09-10');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.unavailableLegs).toEqual([
      { currencyCode: 'NOK', reason: 'stale', lastRateDate: '2026-09-02' },
    ]);
    // Never a silent fallback rate.
    expect(result as Record<string, unknown>).not.toHaveProperty('rate');
  });

  it('a pair with no rows at all is unavailable with reason missing — never rate 1', async () => {
    const result = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.unavailableLegs.map((l) => l.reason)).toEqual(['missing', 'missing']);
    expect(result.unavailableLegs.every((l) => l.lastRateDate === undefined)).toBe(true);
    expect(result as Record<string, unknown>).not.toHaveProperty('rate');
  });
});

describe('exchangeRateService — EUR-pivot cross rates', () => {
  it('USD to GBP equals round(EUR-to-GBP / EUR-to-USD, 8) computed by Postgres', async () => {
    await seedFeed('2026-09-03', 'USD', '1.09000000');
    await seedFeed('2026-09-03', 'GBP', '0.85000000');

    const expected = await pgCross('1.09000000', '0.85000000');
    const result = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(result).toMatchObject({ status: 'available', rate: expected, source: 'ecb', rateDate: '2026-09-03' });
    // Guard against a vacuous comparison: the pivot must actually have divided.
    expect(expected).not.toBe('1.00000000');
  });

  it('converts into a zero-decimal currency as a whole number of major units', async () => {
    await seedFeed('2026-09-03', 'USD', '1.09000000');
    await seedFeed('2026-09-03', 'JPY', '160.00000000');

    const result = await convertForReporting('100.00', 'USD', 'JPY', '2026-09-03');
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.convertedAmount).toMatch(/^\d+\.00$/);
    expect(Number(result.convertedAmount) % 1).toBe(0);
    expect(result.amount).toBe('100.00');
  });

  it('an ecb leg crossed with a manual leg reports source mixed and the oldest contributing rate date', async () => {
    await seedFeed('2026-09-01', 'USD', '1.09000000');
    await setManualRate({ rateDate: '2026-09-03', baseCode: BASE, quoteCode: 'GBP', rate: '0.88000000' });

    const result = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.source).toBe('mixed');
    // The disclosed date is the OLDEST contributing leg, never the freshest.
    expect(result.rateDate).toBe('2026-09-01');
    expect(result.rate).toBe(await pgCross('1.09000000', '0.88000000'));
  });

  it('an org-scoped request context can resolve a reporting rate without a system escalation', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedFeed('2026-09-03', 'USD', '1.09000000');
    await seedFeed('2026-09-03', 'GBP', '0.85000000');

    const result = await withDbAccessContext(orgContext(org.id), () =>
      resolveReportingRate('USD', 'GBP', '2026-09-03'),
    );
    expect(result).toMatchObject({ status: 'available', rate: await pgCross('1.09000000', '0.85000000') });
  });

  it('never derives a cross rate from two different database snapshots', async () => {
    const date = '2026-09-03';
    await seedFeed(date, 'USD', '1.10000000');
    await seedFeed(date, 'GBP', '0.85000000');

    // Two CONSISTENT snapshots. Both legs move together in one transaction, so
    // the only two honest cross rates are the two intra-snapshot quotients; a
    // resolver that read its legs in two statements would eventually pair
    // snapshot A's `from` leg with snapshot B's `to` leg and surface a third
    // value that existed at no instant. (A fixture where only ONE leg moves
    // cannot detect that at all — every straddle still lands on a valid value.)
    const snapA = { usd: '1.10000000', gbp: '0.85000000' };
    const snapB = { usd: '1.20000000', gbp: '0.95000000' };
    const honest = [await pgCross(snapA.usd, snapA.gbp), await pgCross(snapB.usd, snapB.gbp)];
    const straddled = [await pgCross(snapA.usd, snapB.gbp), await pgCross(snapB.usd, snapA.gbp)];
    expect(new Set([...honest, ...straddled]).size).toBe(4);

    // The writer runs on a second connection (the superuser test client, NOT
    // the app pool the service reads through) and commits each snapshot atomically.
    let stop = false;
    const writer = (async () => {
      for (let i = 0; !stop; i++) {
        const snap = i % 2 === 0 ? snapB : snapA;
        await getTestDb().transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL breeze.scope = 'system'`);
          await tx.execute(sql`
            update exchange_rates set rate = ${snap.usd}::numeric
            where rate_date = ${date}::date and base_code = ${BASE} and quote_code = 'USD'`);
          await tx.execute(sql`
            update exchange_rates set rate = ${snap.gbp}::numeric
            where rate_date = ${date}::date and base_code = ${BASE} and quote_code = 'GBP'`);
        });
      }
    })();

    const observed = new Set<string>();
    try {
      for (let i = 0; i < 400; i++) {
        const r = await resolveReportingRate('USD', 'GBP', date);
        expect(r.status).toBe('available');
        if (r.status === 'available') observed.add(r.rate);
      }
    } finally {
      stop = true;
      await writer;
    }

    expect(observed.size).toBeGreaterThan(0);
    for (const rate of observed) {
      expect(honest).toContain(rate);
    }
  });
});
