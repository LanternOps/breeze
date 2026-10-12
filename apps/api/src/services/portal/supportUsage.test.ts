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

// Block hours W04: only the DB-backed coverage helper is mocked; the pure
// allocation helpers are real.
const { coverageMock } = vi.hoisted(() => ({ coverageMock: vi.fn() }));
vi.mock('./hourBlockCoverage', () => ({ hourBlockCoverageForOrg: coverageMock }));

import {
  supportUsageForOrg,
} from './supportUsage';

// Every pre-existing test runs with the Support hours flag off.
beforeEach(() => coverageMock.mockResolvedValue(null));

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

describe('billed quantity in the portal buckets (#4628 W03)', () => {
  beforeEach(() => {
    state.rows = [];
    state.columns = undefined;
  });

  it('the billed bucket reports the BILLED quantity, so it matches the invoice', async () => {
    state.rows = [{
      ticketNumber: 'T-1', title: 'Visible',
      durationMinutes: 20, billableMinutes: 60,
      billingStatus: 'billed', isApproved: true,
    }];
    const result = await supportUsageForOrg(args);
    expect(result.totals.billed).toEqual({ minutes: 60, hours: 1 });
    expect(result.tickets[0]!.billedMinutes).toBe(60);
  });

  it('toBeBilled reports the billed quantity too', async () => {
    state.rows = [{
      ticketNumber: 'T-1', title: null,
      durationMinutes: 20, billableMinutes: 60,
      billingStatus: 'not_billed', isApproved: true,
    }];
    const result = await supportUsageForOrg(args);
    expect(result.totals.toBeBilled).toEqual({ minutes: 60, hours: 1 });
    expect(result.tickets[0]!.toBeBilledMinutes).toBe(60);
  });

  it('a pre-feature portal row falls back to the actual duration', async () => {
    state.rows = [{
      ticketNumber: 'T-1', title: null,
      durationMinutes: 30, billableMinutes: null,
      billingStatus: 'billed', isApproved: true,
    }];
    const result = await supportUsageForOrg(args);
    expect(result.totals.billed).toEqual({ minutes: 30, hours: 0.5 });
  });

  it('pendingReview and coveredByContract stay ACTUAL minutes (scope pin)', async () => {
    state.rows = [
      {
        ticketNumber: 'T-1', title: null,
        durationMinutes: 20, billableMinutes: 60,
        billingStatus: 'not_billed', isApproved: false,
      },
      {
        ticketNumber: 'T-2', title: null,
        durationMinutes: 20, billableMinutes: 60,
        billingStatus: 'contract', isApproved: true,
      },
    ];
    const result = await supportUsageForOrg(args);
    expect(result.totals.pendingReview.minutes).toBe(20);
    expect(result.totals.coveredByContract.minutes).toBe(20);
  });

  it('selects billable_minutes from the database', async () => {
    await supportUsageForOrg(args);
    expect(state.columns).toHaveProperty('billableMinutes');
  });
});

describe('block hours coverage (block hours W04)', () => {
  const dec = (overageMinutes = 0) => ({
    windows: [{ start: new Date('2026-12-01T00:00:00Z'), end: null, contractLineId: 'line-1' }],
    periods: [{
      start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z'), overageMinutes,
    }],
  });
  const row = (over: Record<string, unknown>) => ({
    ticketNumber: 'T-1', title: null,
    durationMinutes: 60, billableMinutes: null,
    billingStatus: 'not_billed', isApproved: true,
    endedAt: new Date('2026-12-10T13:00:00Z'), contractLineId: null,
    ...over,
  });

  beforeEach(() => {
    state.rows = [];
    coverageMock.mockReset();
  });

  it('flag OFF: nothing changes — no block keys anywhere, entries stay to-be-billed', async () => {
    coverageMock.mockResolvedValue(null);
    state.rows = [
      row({}),
      row({ ticketNumber: 'T-2', billingStatus: 'contract', contractLineId: 'line-1' }),
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals).toEqual({
      billed: { minutes: 0, hours: 0 },
      toBeBilled: { minutes: 60, hours: 1 },
      coveredByContract: { minutes: 60, hours: 1 },
      pendingReview: { minutes: 0, hours: 0 },
    });
    expect(result.totals).not.toHaveProperty('coveredByBlock');
    expect(result.totals).not.toHaveProperty('overBlock');
    for (const t of result.tickets) {
      expect(t).not.toHaveProperty('coveredByBlockMinutes');
      expect(t).not.toHaveProperty('overBlockMinutes');
    }
  });

  it('flag ON, inside the entitlement: an open-period entry is covered by the block, not to-be-billed', async () => {
    coverageMock.mockResolvedValue(dec(0));
    state.rows = [row({ durationMinutes: 60, billableMinutes: 90 })];

    const result = await supportUsageForOrg(args);

    // Uses the billed quantity (billable ?? duration) so it ties to the card.
    expect(result.totals.coveredByBlock).toEqual({ minutes: 90, hours: 1.5 });
    expect(result.totals.overBlock).toEqual({ minutes: 0, hours: 0 });
    expect(result.totals.toBeBilled).toEqual({ minutes: 0, hours: 0 });
    expect(result.tickets[0]!.coveredByBlockMinutes).toBe(90);
    expect(result.tickets[0]!.overBlockMinutes).toBe(0);
  });

  it('flag ON, past the entitlement: the excess is "over", not "covered" (both sides of the cap)', async () => {
    coverageMock.mockResolvedValue(dec(60)); // the open period is 60 minutes over its block
    state.rows = [
      row({ ticketNumber: 'T-A', endedAt: new Date('2026-12-05T10:00:00Z'), durationMinutes: 120 }),
      row({ ticketNumber: 'T-B', endedAt: new Date('2026-12-10T10:00:00Z'), durationMinutes: 90 }),
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals.coveredByBlock).toEqual({ minutes: 150, hours: 2.5 });
    expect(result.totals.overBlock).toEqual({ minutes: 60, hours: 1 });
    expect(result.totals.toBeBilled).toEqual({ minutes: 0, hours: 0 });
    const byTicket = Object.fromEntries(result.tickets.map((t) => [t.ticketNumber, t]));
    expect(byTicket['T-A']).toMatchObject({ coveredByBlockMinutes: 120, overBlockMinutes: 0 });
    expect(byTicket['T-B']).toMatchObject({ coveredByBlockMinutes: 30, overBlockMinutes: 60 });
  });

  it('flag ON: a drawn entry moves from coveredByContract to the block; a card-included one (no line id) does not', async () => {
    coverageMock.mockResolvedValue({
      windows: [],
      periods: [{ start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z'), overageMinutes: 0 }],
    });
    state.rows = [
      row({ ticketNumber: 'T-1', billingStatus: 'contract', contractLineId: 'line-1', durationMinutes: 30, endedAt: new Date('2026-11-20T10:00:00Z') }),
      row({ ticketNumber: 'T-2', billingStatus: 'contract', contractLineId: null, durationMinutes: 45 }),
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals.coveredByBlock).toEqual({ minutes: 30, hours: 0.5 });
    expect(result.totals.coveredByContract).toEqual({ minutes: 45, hours: 0.75 });
  });

  it('flag ON: a late entry from before the window and a running entry stay to-be-billed', async () => {
    coverageMock.mockResolvedValue(dec(0));
    state.rows = [
      row({ ticketNumber: 'T-1', endedAt: new Date('2026-11-20T10:00:00Z'), durationMinutes: 20 }),
      row({ ticketNumber: 'T-2', endedAt: null, durationMinutes: 10 }),
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals.toBeBilled).toEqual({ minutes: 30, hours: 0.5 });
    expect(result.totals.coveredByBlock).toEqual({ minutes: 0, hours: 0 });
  });

  it('flag ON: unapproved block-eligible time is still pending review (approval gates classification)', async () => {
    coverageMock.mockResolvedValue(dec(0));
    state.rows = [row({ isApproved: false, durationMinutes: 40 })];

    const result = await supportUsageForOrg(args);

    expect(result.totals.pendingReview).toEqual({ minutes: 40, hours: 40 / 60 });
    expect(result.totals.coveredByBlock).toEqual({ minutes: 0, hours: 0 });
  });

  it('flag ON with nothing to bucket still reports zeroed block buckets (the flag, not the data, decides presence)', async () => {
    coverageMock.mockResolvedValue({ windows: [], periods: [] });
    state.rows = [];

    const result = await supportUsageForOrg(args);

    expect(result.totals.coveredByBlock).toEqual({ minutes: 0, hours: 0 });
    expect(result.totals.overBlock).toEqual({ minutes: 0, hours: 0 });
  });

  it('asks for coverage with the same org it queries, and selects the two new columns', async () => {
    coverageMock.mockResolvedValue(null);
    const asOf = new Date('2026-12-20T12:00:00Z');

    await supportUsageForOrg({ ...args, asOf });

    expect(coverageMock).toHaveBeenCalledWith(args.orgId, asOf);
    expect(state.columns).toHaveProperty('endedAt');
    expect(state.columns).toHaveProperty('contractLineId');
  });

  it('reads coverage inside the SAME system context as the usage query (one pooled connection)', async () => {
    const { withSystemDbAccessContext } = await import('../../db');
    vi.mocked(withSystemDbAccessContext).mockClear();
    coverageMock.mockResolvedValue(null);

    await supportUsageForOrg(args);

    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });
});
