import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import {
  completeExecutableScopePredicate,
  findDueReports,
  isReportOccurrenceDue,
  lastOccurrenceKey,
} from './reportScheduleWorker';
import { pgOffsetlessTimestamp } from '../testUtils/pgOffsetlessTimestamp';

// #3198 W01 — `findDueReports` owner-axis cases below. Only `db.select` is
// faked (the chain records its projection, joins and WHERE); the schema and
// drizzle-orm are REAL, so the recorded predicates compile to the exact SQL
// Postgres would receive. The pure #4059 cases above never touch the db.
const selectCalls = vi.hoisted(() => [] as Array<{
  fields: Record<string, unknown> | undefined;
  joins: Array<{ kind: string; on: unknown }>;
  where: unknown;
}>);
const selectResults = vi.hoisted(() => [] as unknown[][]);
vi.mock('../db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => {
      const call = { fields, joins: [] as Array<{ kind: string; on: unknown }>, where: undefined as unknown };
      selectCalls.push(call);
      const rows = selectResults.shift() ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = (_t: unknown, on: unknown) => { call.joins.push({ kind: 'inner', on }); return chain; };
      chain.leftJoin = (_t: unknown, on: unknown) => { call.joins.push({ kind: 'left', on }); return chain; };
      chain.where = (w: unknown) => { call.where = w; return chain; };
      chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    },
  },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
}));

/**
 * #4059 gap 2 — scheduled-report due detection on a non-UTC API host.
 *
 * `reports.last_generated_at` is `timestamp('last_generated_at')` with no
 * `withTimezone: true` (`db/schema/reports.ts:82`), so postgres.js hands
 * `findDueReports` a Date carrying the UTC wall clock re-read as the API
 * process's LOCAL time. `isDue` converts that Date to wall-clock parts in the
 * ORG's zone and compares it against the occurrence key, so without the
 * correction in `isReportOccurrenceDue` the comparison is wrong by the API
 * host's offset:
 *
 * - **East of UTC**: an occurrence that already ran reads as older than it is
 *   and re-fires → the same scheduled report is generated and emailed twice.
 * - **West of UTC**: an occurrence that has NOT run reads as newer than it is
 *   and is suppressed → a silently missed scheduled report.
 *
 * Same defect class as #4018 (gap 1 of this issue, PR #4878).
 *
 * **These assertions only have teeth under a non-UTC TZ**, which is the whole
 * point: `pgOffsetlessTimestamp` reproduces the driver's misparse using the
 * PROCESS's own zone, so under a UTC runner it is the identity function and
 * these cases collapse to trivially-true — exactly the vacuity #4046 exists to
 * prevent. That is why this file is registered in `vitest.config.tz.ts`
 * (`pnpm test:tz`, `TZ=America/Denver` in CI), guarded by
 * `__tests__/tzPinCanary.test.ts`. A fabricated arbitrary offset would NOT
 * work here: the production correction reads `getTimezoneOffset()` off the real
 * process, so only a real host offset can be recovered.
 *
 * Verified red against the pre-fix code under `TZ=America/Denver`.
 */

const TZ = 'UTC';
/** A daily 09:00 schedule; 2026-06-10T09:00Z is the occurrence boundary. */
const DAILY = { time: '09:00' } as const;
const NOW = new Date('2026-06-10T09:30:00Z');

const keyForNow = () => lastOccurrenceKey(NOW, 'daily', DAILY, TZ);

describe('isReportOccurrenceDue — offsetless last_generated_at (#4059)', () => {
  it('does not re-fire an occurrence that already ran', () => {
    // Genuinely ran at 09:05Z, five minutes AFTER the 09:00 occurrence.
    const ranAt = pgOffsetlessTimestamp(Date.parse('2026-06-10T09:05:00Z'));
    expect(isReportOccurrenceDue(ranAt, keyForNow(), TZ)).toBe(false);
  });

  it('still fires an occurrence that has not run yet', () => {
    // Genuinely ran at 08:55Z, five minutes BEFORE the 09:00 occurrence.
    const ranAt = pgOffsetlessTimestamp(Date.parse('2026-06-10T08:55:00Z'));
    expect(isReportOccurrenceDue(ranAt, keyForNow(), TZ)).toBe(true);
  });

  it('fires when the last run was the previous day', () => {
    const ranAt = pgOffsetlessTimestamp(Date.parse('2026-06-09T09:05:00Z'));
    expect(isReportOccurrenceDue(ranAt, keyForNow(), TZ)).toBe(true);
  });

  it('matches the verdict computed from the true instant, whatever the host zone', () => {
    // The invariant the correction exists to restore: a Date that came off the
    // wire must produce the same verdict as the true instant it represents.
    // `expectedVerdict` is derived from the ISO text independently of the
    // function under test, so this cannot be satisfied by the correction being
    // skipped (or applied twice) on both sides of an equality.
    for (const iso of [
      '2026-06-09T00:00:00Z',
      '2026-06-10T08:55:00Z',
      '2026-06-10T09:00:00Z',
      '2026-06-10T09:05:00Z',
      '2026-06-10T23:59:00Z',
    ]) {
      const ms = Date.parse(iso);
      expect(
        isReportOccurrenceDue(pgOffsetlessTimestamp(ms), keyForNow(), TZ),
        `offsetless parse of ${iso} must agree with its true instant`,
      ).toBe(expectedVerdict(iso));
    }
  });

  it('never ran is always due', () => {
    expect(isReportOccurrenceDue(null, keyForNow(), TZ)).toBe(true);
  });
});

/**
 * The due verdict for an instant, derived straight from its UTC ISO text
 * (the occurrence key is `YYYYMMDDHHmm` in the schedule's zone, which is UTC
 * in these fixtures). Independent of the production code path.
 */
function expectedVerdict(iso: string): boolean {
  const asKey = Number(
    `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}`,
  );
  return asKey < keyForNow();
}

// ─── #3198 W01: partner-owned definitions in the due scan ───────────────────

const dialect = new PgDialect();
const compile = (predicate: unknown) => dialect.sqlToQuery(predicate as SQL);

/** The complete-executable-scope predicate, compiled. Pinned as a whole so a
 *  partner_wide disjunct that escapes the user/fingerprint/captured-at
 *  requirements (or loses its owner guard) cannot pass a substring match. */
const EXPECTED_COMPLETE_SCOPE_SQL =
  '("reports"."execution_scope_version" = $1'
  + ' and "reports"."execution_scope_kind" in ($2, $3, $4)'
  + ' and "reports"."execution_scope_user_id" is not null'
  + ' and "reports"."execution_scope_fingerprint" is not null'
  + ' and "reports"."execution_scope_captured_at" is not null'
  + ' and (("reports"."execution_scope_kind" = $5 and "reports"."execution_scope_site_ids" is null and "reports"."org_id" is not null)'
  + ' or ("reports"."execution_scope_kind" = $6 and "reports"."execution_scope_site_ids" is not null and "reports"."org_id" is not null)'
  + ' or ("reports"."execution_scope_kind" = $7 and "reports"."execution_scope_site_ids" is null and "reports"."partner_id" is not null)))';

describe('findDueReports — partner-owned definitions (#3198 W01)', () => {
  beforeEach(() => {
    selectCalls.length = 0;
    selectResults.length = 0;
  });

  it('admits a partner-owned definition with a complete partner_wide scope and resolves its timezone from the partner row', async () => {
    // 07:30Z = 09:30 in Berlin (CEST): a monthly 1st-at-09:00 occurrence has
    // passed in Berlin but NOT in UTC, so the key proves which zone was used.
    const now = new Date('2026-07-01T07:30:00Z');
    selectResults.push(
      [{
        id: 'partner-report-1',
        schedule: 'monthly',
        lastGeneratedAt: null,
        config: { schedule: { time: '09:00', date: '1' } },
        orgSettings: null,
        partnerTimezone: 'Europe/Berlin',
        partnerSettings: {},
      }],
      [{ count: 0 }],
    );

    const due = await findDueReports(now);

    expect(due).toEqual([
      { id: 'partner-report-1', occurrenceKey: 202607010900, lastGeneratedAt: null },
    ]);

    const [dueQuery, skippedQuery] = selectCalls;
    // WHERE = pollable AND completeExecutableScope, with partner_wide admitted.
    const where = compile(dueQuery!.where);
    expect(where.sql).toContain(EXPECTED_COMPLETE_SCOPE_SQL.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 3}`));
    expect(where.params.slice(3)).toEqual([
      1, 'unrestricted', 'restricted', 'partner_wide', 'unrestricted', 'restricted', 'partner_wide',
    ]);

    // Timezone chain: the org join is OUTER (a partner-owned row has no org),
    // and the partner row is the owner's partner, else the org's partner.
    expect(dueQuery!.joins.map((j) => j.kind)).toEqual(['left', 'left']);
    expect(compile(dueQuery!.joins[0]!.on).sql).toBe('"reports"."org_id" = "organizations"."id"');
    expect(compile(dueQuery!.joins[1]!.on).sql).toBe(
      '"partners"."id" = coalesce("reports"."partner_id", "organizations"."partner_id")',
    );
    expect(compile(drizzleSql`${dueQuery!.fields!.partnerTimezone}`).sql).toBe('"partners"."timezone"');

    // The reauthorization count is the exact complement of the same predicate.
    expect(compile(skippedQuery!.where).sql).toContain(
      `not ${EXPECTED_COMPLETE_SCOPE_SQL.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 3}`)}`,
    );
  });

  it('still skips a partner-owned definition whose scope is incomplete (no user id)', () => {
    const { sql, params } = compile(completeExecutableScopePredicate());

    expect(sql).toBe(EXPECTED_COMPLETE_SCOPE_SQL);
    expect(params).toEqual([
      1, 'unrestricted', 'restricted', 'partner_wide', 'unrestricted', 'restricted', 'partner_wide',
    ]);
    // The user-id requirement is a top-level conjunct, OUTSIDE the per-kind
    // disjunction: no partner_wide branch can admit a row without a user.
    const disjunction = sql.indexOf(' and ((');
    expect(sql.indexOf('"reports"."execution_scope_user_id" is not null')).toBeLessThan(disjunction);
    expect(sql.slice(disjunction)).not.toContain('execution_scope_user_id');
  });
});
