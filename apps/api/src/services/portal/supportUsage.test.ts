import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  join: undefined as SQL | undefined,
  where: undefined as SQL | undefined,
  columns: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((columns: Record<string, unknown>) => {
      state.columns = columns;
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn((_table, join: SQL) => {
            state.join = join;
            return {
              where: vi.fn(async (where: SQL) => {
                state.where = where;
                return state.rows;
              }),
            };
          }),
        })),
      };
    }),
  },
  runOutsideDbContext: vi.fn(async (
    fn: () => Promise<unknown>,
  ) => fn()),
  withSystemDbAccessContext: vi.fn(async (
    fn: () => Promise<unknown>,
  ) => fn()),
}));

import {
  supportUsageForOrg,
} from './supportUsage';

const args = {
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  month: '2026-09',
  timezone: 'America/Denver',
  portalUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

describe('supportUsageForOrg', () => {
  beforeEach(() => {
    state.rows = [];
    state.join = undefined;
    state.where = undefined;
    state.columns = undefined;
  });

  it('places minutes into the four approved buckets', async () => {
    state.rows = [
      {
        ticketNumber: 'T-1',
        title: 'Visible',
        durationMinutes: 15,
        billingStatus: 'billed',
        isApproved: true,
      },
      {
        ticketNumber: 'T-2',
        title: null,
        durationMinutes: 30,
        billingStatus: 'not_billed',
        isApproved: true,
      },
      {
        ticketNumber: 'T-3',
        title: null,
        durationMinutes: 45,
        billingStatus: 'contract',
        isApproved: true,
      },
      {
        ticketNumber: 'T-4',
        title: null,
        durationMinutes: 60,
        billingStatus: 'not_billed',
        isApproved: false,
      },
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals).toEqual({
      billed: { minutes: 15, hours: 0.25 },
      toBeBilled: { minutes: 30, hours: 0.5 },
      coveredByContract: { minutes: 45, hours: 0.75 },
      pendingReview: { minutes: 60, hours: 1 },
    });
  });

  it('contains both organization predicates in compiled SQL', async () => {
    await supportUsageForOrg(args);

    const dialect = new PgDialect();
    const join = dialect.sqlToQuery(state.join as SQL);
    const where = dialect.sqlToQuery(state.where as SQL);

    expect(join.sql).toContain('"tickets"."org_id" = $');
    expect(join.params).toContain(args.orgId);
    expect(where.sql).toContain('"time_entries"."org_id" = $');
    expect(where.params).toContain(args.orgId);
  });

  it('binds portalUserId into the compiled title-mask CASE expression', async () => {
    await supportUsageForOrg(args);

    const dialect = new PgDialect();
    const title = dialect.sqlToQuery(
      (state.columns as { title: SQL }).title,
    );

    // The title is only revealed when the ticket was submitted by the
    // requesting portal user — dropping the portalUserId binding would
    // leak every ticket's subject (or mask every one), so the compiled
    // SQL must reference submitted_by and actually bind portalUserId.
    expect(title.sql).toContain('"tickets"."submitted_by" = $');
    expect(title.params).toContain(args.portalUserId);
  });

  it('compares the naive started_at column against the timezone-aware boundary via AT TIME ZONE', async () => {
    await supportUsageForOrg(args);

    const dialect = new PgDialect();
    const where = dialect.sqlToQuery(state.where as SQL);

    // time_entries.started_at is `timestamp` (no tz). Comparing it directly
    // to make_timestamptz(...) would coerce through the session TimeZone GUC
    // (which the app never sets) instead of the caller's requested timezone.
    expect(where.sql).toContain(
      '"time_entries"."started_at" AT TIME ZONE \'UTC\'',
    );
  });

  it('rejects an invalid month before querying', async () => {
    await expect(supportUsageForOrg({
      ...args,
      month: 'September',
    })).rejects.toThrow('month must use YYYY-MM');
  });
});
