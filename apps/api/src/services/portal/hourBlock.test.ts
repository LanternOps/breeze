import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { HourBlockEstimate } from '@breeze/shared';

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  where: undefined as SQL | undefined,
  inSystem: false,
  outsideCalls: 0,
  computeSawSystem: undefined as boolean | undefined,
}));
const { computeMock } = vi.hoisted(() => ({ computeMock: vi.fn() }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn((where: SQL) => {
            state.where = where;
            return { limit: vi.fn(async () => state.rows) };
          }),
        })),
      })),
    })),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
    state.outsideCalls += 1;
    return fn();
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    state.inSystem = true;
    try {
      return await fn();
    } finally {
      state.inSystem = false;
    }
  }),
}));
vi.mock('../contractHourBlockEstimate', () => ({ computeOpenHourBlockPeriod: computeMock }));

import { liveHourBlockForOrg, portalHourBlockForOrg, toPortalHourBlockDto } from './hourBlock';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const estimate: HourBlockEstimate = {
  lineId: 'line-secret',
  periodStart: '2026-12-01',
  periodEnd: '2027-01-01',
  includedHours: 10,
  carriedInHours: 2,
  consumedHours: 6.5,
  unapprovedHours: 1,
  foreignCurrencyHours: 0.5,
  remainingHours: 5.5,
  overageHours: 0,
  overageUnitPrice: '150.00',
  overageValue: '0.00',
  alertPct: 80,
  billingTiming: 'advance',
  lateEntryHours: 3,
};

describe('toPortalHourBlockDto', () => {
  it('whitelists the customer-safe keys and nothing else', () => {
    const dto = toPortalHourBlockDto(estimate, 'USD');

    expect(Object.keys(dto).sort()).toEqual([
      'billingTiming',
      'carriedInHours',
      'currencyCode',
      'includedHours',
      'overageHours',
      'overageRate',
      'periodEnd',
      'periodStart',
      'remainingHours',
      'usedHours',
    ]);
    expect(dto).toEqual({
      periodStart: '2026-12-01',
      periodEnd: '2027-01-01',
      includedHours: 10,
      carriedInHours: 2,
      usedHours: 6.5,
      remainingHours: 5.5,
      overageHours: 0,
      overageRate: '150.00',
      currencyCode: 'USD',
      billingTiming: 'advance',
    });
    // The MSP-side exposure figures never cross the boundary.
    expect(JSON.stringify(dto)).not.toContain('line-secret');
  });
});

describe('portalHourBlockForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows = [];
    state.where = undefined;
    state.inSystem = false;
    state.outsideCalls = 0;
    state.computeSawSystem = undefined;
    computeMock.mockImplementation(async () => {
      state.computeSawSystem = state.inSystem;
      return estimate;
    });
  });

  it('binds the org on BOTH tables and selects only the live block of an active contract', async () => {
    await portalHourBlockForOrg({ orgId: ORG });

    const q = new PgDialect().sqlToQuery(state.where as SQL);
    expect(q.sql).toContain('"contract_lines"."org_id" = $');
    expect(q.sql).toContain('"contracts"."org_id" = $');
    expect(q.sql).toContain('"contract_lines"."line_type" = $');
    expect(q.sql).toContain('"contract_lines"."hour_block_retired_at" is null');
    expect(q.sql).toContain('"contracts"."status" = $');
    expect(q.params.filter((p) => p === ORG)).toHaveLength(2);
    expect(q.params).toEqual(expect.arrayContaining(['hour_block', 'active']));
  });

  it('returns null without computing anything when the org has no live block', async () => {
    state.rows = [];
    await expect(portalHourBlockForOrg({ orgId: ORG })).resolves.toEqual({ hourBlock: null, startsOn: null });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('runs the open-period computation inside a system context entered from outside the request context', async () => {
    state.rows = [{ contract: { id: 'c1', currencyCode: 'EUR' }, line: { id: 'l1' } }];
    const asOf = new Date('2026-12-20T12:00:00Z');

    const res = await portalHourBlockForOrg({ orgId: ORG, asOf });

    expect(state.outsideCalls).toBe(1);
    // The partner-axis trap: an org-scoped read of time_entries returns zero
    // rows, so the computation MUST see a system context.
    expect(state.computeSawSystem).toBe(true);
    expect(computeMock).toHaveBeenCalledWith({ id: 'c1', currencyCode: 'EUR' }, { id: 'l1' }, asOf);
    expect(res.hourBlock?.currencyCode).toBe('EUR');
    expect(res.startsOn).toBeNull();
  });

  it('a block whose open period starts AFTER today yields no card but its start date', async () => {
    state.rows = [{ contract: { id: 'c1', currencyCode: 'USD' }, line: { id: 'l1' } }];
    computeMock.mockResolvedValue({ ...estimate, periodStart: '2026-12-01', periodEnd: '2027-01-01' });

    const res = await portalHourBlockForOrg({ orgId: ORG, asOf: new Date('2026-11-20T12:00:00Z') });

    expect(res).toEqual({ hourBlock: null, startsOn: '2026-12-01' });
  });

  it('a period that starts today is already running: the card shows', async () => {
    state.rows = [{ contract: { id: 'c1', currencyCode: 'USD' }, line: { id: 'l1' } }];
    computeMock.mockResolvedValue({ ...estimate, periodStart: '2026-12-01', periodEnd: '2027-01-01' });

    const res = await portalHourBlockForOrg({ orgId: ORG, asOf: new Date('2026-12-01T00:30:00Z') });

    expect(res.startsOn).toBeNull();
    expect(res.hourBlock?.periodStart).toBe('2026-12-01');
  });
});

describe('liveHourBlockForOrg', () => {
  it('opens no context of its own (the caller already holds one; a second would take a second pooled connection)', async () => {
    vi.clearAllMocks();
    state.outsideCalls = 0;
    state.rows = [{ contract: { id: 'c1', currencyCode: 'USD' }, line: { id: 'l1' } }];
    computeMock.mockResolvedValue(estimate);

    const live = await liveHourBlockForOrg(ORG, new Date('2026-12-20T12:00:00Z'));

    expect(state.outsideCalls).toBe(0);
    expect(live?.currencyCode).toBe('USD');
  });
});
