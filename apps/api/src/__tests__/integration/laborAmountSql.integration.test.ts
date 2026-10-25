/**
 * #9561 characterisation, SQL side: the labour rule as Postgres evaluates it.
 *
 * Three readers aggregate labour money in SQL (ticket billing summary,
 * technician time report, org-currency preflight). Before #9561 each carried
 * its own copy of the formula; the two LEGACY_* expressions below are those
 * copies verbatim (bound to parameters instead of columns). They pin the
 * by-design figures (25 min at 135.00/h = 0.42 h = 56.70), and the sweep
 * proves the shared `laborAmountSql` helper is value-identical to both copies
 * — and to the JS `laborAmount` — over every minute count in a working day.
 * The last block runs the three REAL readers against seeded rows and asserts
 * literal figures, so a call site that passed the wrong minutes term or scale
 * to the helper would fail here too.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { sql, type SQL } from 'drizzle-orm';
import { laborAmount, laborHours } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { laborAmountSql, laborHoursSql, minorUnitScaleSql } from '../../services/currencySql';
import { getTicketBillingSummary } from '../../services/timeEntryService';
import { getOrgCurrencyImpact } from '../../services/orgCurrencyService';
import { generateTechnicianTimeBillabilityReport } from '../../services/businessReports/technicianTimeReport';
import type { TechnicianTimeSummary } from '@breeze/shared';
import { ctx, insertSettledEntry, seedApprovalFixture } from './ticketApprovalFixtures';

const RUN = !!process.env.DATABASE_URL;

/** getTicketBillingSummary / technicianTimeReport MONEY, pre-#9561. */
const LEGACY_SUMMARY = (minutes: SQL, rate: SQL) =>
  sql`ROUND(ROUND(${minutes}::numeric / 60, 2) * ${rate}, 2)`;
/** orgCurrencyService.laborSumSql, pre-#9561 (note `/ 60.0` and the `, 0` fallback). */
const LEGACY_PREFLIGHT = (minutes: SQL, rate: SQL) =>
  sql`round(round(coalesce(${minutes}, 0) / 60.0, 2) * ${rate}, 2)`;

/** [minutes, amount at 135.00/h, amount at 100.00/h] */
const TABLE: ReadonlyArray<readonly [number, string, string]> = [
  [1, '2.70', '2.00'],
  [20, '44.55', '33.00'],
  [25, '56.70', '42.00'],
  [30, '67.50', '50.00'],
  [59, '132.30', '98.00'],
  [61, '137.70', '102.00'],
];

const one = async (expr: SQL): Promise<string> => {
  const res = await withSystemDbAccessContext(() => db.execute(sql`SELECT (${expr})::numeric(12,2)::text AS v`));
  return String((res as unknown as Array<{ v: string }>)[0]!.v);
};

describe.skipIf(!RUN)('labour rule in SQL (#9561)', () => {
  it.each(TABLE)('%i min: legacy SQL copies bill the 2-dp-hours figure', async (minutes, at135, at100) => {
    const m = sql`COALESCE(NULL::int, ${minutes}::int)`;
    for (const [rate, expected] of [['135.00', at135], ['100.00', at100]] as const) {
      const r = sql`${rate}::numeric(10,2)`;
      expect(await one(LEGACY_SUMMARY(m, r)), `summary ${minutes}@${rate}`).toBe(expected);
      expect(await one(LEGACY_PREFLIGHT(m, r)), `preflight ${minutes}@${rate}`).toBe(expected);
      expect(await one(laborAmountSql(m, r, 2)), `helper ${minutes}@${rate}`).toBe(expected);
      expect(await one(laborAmountSql(m, r, minorUnitScaleSql(sql`'USD'::text`))), `helper/scale ${minutes}@${rate}`).toBe(expected);
    }
  });

  it('helper = both legacy copies = JS laborAmount for every minute in a day, at awkward rates', async () => {
    const m = sql`g.m`;
    const r = sql`v.r`;
    const res = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT g.m::int AS m, v.r::text AS r,
        (${LEGACY_SUMMARY(m, r)})::numeric(12,2)::text AS legacy_summary,
        (${LEGACY_PREFLIGHT(m, r)})::numeric(12,2)::text AS legacy_preflight,
        (${laborAmountSql(m, r, 2)})::numeric(12,2)::text AS helper,
        (${laborHoursSql(m)})::numeric(12,2)::text AS hours
      FROM generate_series(0, 1440) AS g(m)
      CROSS JOIN (VALUES (135.00::numeric(10,2)), (99.99::numeric(10,2)), (0.01::numeric(10,2)), (7.25::numeric(10,2))) AS v(r)`));
    const rows = res as unknown as Array<{ m: number; r: string; legacy_summary: string; legacy_preflight: string; helper: string; hours: string }>;
    expect(rows).toHaveLength(1441 * 4);
    const mismatches = rows.filter((row) =>
      row.helper !== row.legacy_summary
      || row.helper !== row.legacy_preflight
      || row.helper !== laborAmount(Number(row.m), row.r, 'USD')
      || row.hours !== laborHours(Number(row.m)));
    expect(mismatches).toEqual([]);
  });

  it('zero-decimal scale: 20 min × 1,000 JPY = 330 in SQL as in JS', async () => {
    const m = sql`${20}::int`;
    const r = sql`${'1000.00'}::numeric(10,2)`;
    expect(await one(laborAmountSql(m, r, minorUnitScaleSql(sql`'JPY'::text`)))).toBe('330.00');
    expect(await one(laborAmountSql(m, r, 0))).toBe('330.00');
    expect(laborAmount(20, '1000.00', 'JPY')).toBe('330.00');
  });
});

describe.skipIf(!RUN)('labour rule through the real SQL readers (#9561)', () => {
  const CASES = TABLE.flatMap(([minutes, at135, at100]) => [
    { minutes, rate: '135.00', amount: at135 },
    { minutes, rate: '100.00', amount: at100 },
  ]);

  it.each(CASES)('$minutes min at $rate/h → $amount in the ticket summary, org-currency preflight and technician report', async (c) => {
    const f = await seedApprovalFixture({ enabled: false });
    await insertSettledEntry(f, c.minutes, { hourlyRate: c.rate });
    const asTech = <T>(fn: () => Promise<T>) => withDbAccessContext(ctx(f), fn);

    const summary = await asTech(() => getTicketBillingSummary(f.ticketId));
    expect(summary.time.billableAmounts, 'ticket billing summary').toEqual([{ currencyCode: 'USD', amount: c.amount }]);

    const impact = await asTech(() => getOrgCurrencyImpact(f.orgId, 'EUR', {
      userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId, f.otherOrgId],
    }));
    const usd = impact.impactsByCurrency.find((g) => g.currencyCode === 'USD');
    expect(usd?.billables.laborAmount, 'org-currency preflight').toBe(c.amount);

    const report = await generateTechnicianTimeBillabilityReport(
      { kind: 'organization', orgId: f.orgId },
      { period: { kind: 'last_30_days' } },
      { principalKind: 'system', scope: { version: 1, kind: 'unrestricted', orgId: f.orgId }, fingerprint: 'test', capturedAt: new Date() },
    );
    const s = report.summary as unknown as TechnicianTimeSummary;
    expect(s.overall.billableValue, 'technician time report').toEqual([{ currencyCode: 'USD', amount: c.amount }]);
  });
});
