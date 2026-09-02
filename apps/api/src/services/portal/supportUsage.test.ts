import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  join: undefined as SQL | undefined,
  where: undefined as SQL | undefined,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
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
    })),
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

  it('rejects an invalid month before querying', async () => {
    await expect(supportUsageForOrg({
      ...args,
      month: 'September',
    })).rejects.toThrow('month must use YYYY-MM');
  });
});
