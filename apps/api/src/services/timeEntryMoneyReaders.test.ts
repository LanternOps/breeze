import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { queryMocks } = vi.hoisted(() => ({
  queryMocks: {
    results: [] as unknown[][],
    selections: [] as Record<string, unknown>[],
    conditions: [] as SQL[],
  },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn((selection: Record<string, unknown>) => {
      queryMocks.selections.push(selection);
      const result = queryMocks.results.shift() ?? [];
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        where: (condition: SQL) => { queryMocks.conditions.push(condition); return chain; },
        groupBy: () => chain,
        orderBy: () => chain,
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    }),
  },
}));
vi.mock('./timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn() }));
vi.mock('./sensitiveReadAudit', () => ({ auditSensitiveRead: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { getTicketBillingSummary, getTimesheet, listBillables } from './timeEntryService';
import { ticketExportRoutes } from '../routes/tickets/export';

const from = new Date('2026-09-14T00:00:00Z');
const to = new Date('2026-09-21T00:00:00Z');
const included = {
  id: 'included', startedAt: new Date('2026-09-14T09:00:00Z'),
  endedAt: new Date('2026-09-14T10:30:00Z'), durationMinutes: 90,
  description: 'Included support', isBillable: true, hourlyRate: null,
  coverage: 'included', currencyCode: 'USD', billingStatus: 'contract', isApproved: true,
};
const normal = {
  ...included, id: 'normal', startedAt: new Date('2026-09-14T11:00:00Z'),
  endedAt: new Date('2026-09-14T12:00:00Z'), durationMinutes: 60,
  description: 'Billable support', coverage: 'billable', hourlyRate: '225.00', billingStatus: 'not_billed',
};
const billableRows = () => [included, normal].map(entry => ({
  date: entry.startedAt, orgName: 'Customer', ticketNumber: 'T-1',
  description: entry.description, technician: 'Technician', minutes: entry.durationMinutes,
  rate: entry.hourlyRate, currencyCode: entry.currencyCode,
  billingStatus: entry.billingStatus, isApproved: entry.isApproved,
}));
const query = (value: unknown) => new PgDialect().sqlToQuery(value as SQL);

beforeEach(() => {
  queryMocks.results.length = 0;
  queryMocks.selections.length = 0;
  queryMocks.conditions.length = 0;
});

describe('included time never adds money', () => {
  it('timesheet retains included minutes but totals exactly the normal entry amount', async () => {
    queryMocks.results.push([included, normal]);
    const result = await getTimesheet('user-1', from);
    expect(result.totals).toEqual({
      totalMinutes: 150, billableMinutes: 150,
      billableAmounts: [{ currencyCode: 'USD', amount: '225.00' }],
    });
    expect(result.days[0]!.entries).toHaveLength(2);
  });

  it('billables retain the contract row at zero and total exactly the normal entry amount', async () => {
    queryMocks.results.push(billableRows(), []);
    const result = await listBillables(from, to);
    expect(result.rows.map(row => ({ description: row.description, rate: row.rate, amount: row.amount })))
      .toEqual([
        { description: 'Included support', rate: null, amount: '0.00' },
        { description: 'Billable support', rate: '225.00', amount: '225.00' },
      ]);
    expect(result.totalsByCurrency).toEqual([{ currencyCode: 'USD', amount: '225.00' }]);
  });

  it('billing CSV through the real list service exports included time with no rate and zero money', async () => {
    queryMocks.results.push(billableRows(), []);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { accessibleOrgIds: null, canAccessOrg: () => true } as any);
      await next();
    });
    app.route('/', ticketExportRoutes);
    const response = await app.request('/export/billables.csv?from=2026-09-14&to=2026-09-21');
    expect(response.status).toBe(200);
    const lines = (await response.text()).split('\n').map(line => line.split(',').map(cell => cell.slice(1, -1)));
    expect(lines).toHaveLength(3);
    expect(lines[1]!.slice(6, 11)).toEqual(['1.50', '', '0.00', 'USD', 'contract']);
    expect(lines[2]!.slice(6, 11)).toEqual(['1.00', '225.00', '225.00', 'USD', 'not_billed']);
    expect(lines.slice(1).reduce((amount, row) => amount + Number(row[8]), 0)).toBe(225);
  });

  it('ticket summary counts coverage-stamped included minutes while SQL excludes null rates from money', async () => {
    // Aggregate results returned by Postgres for the same 90-minute included
    // plus 60-minute normal pair. Check the actual SQL below as well: returning
    // a mocked total alone would not prove its rate predicate or coverage key.
    queryMocks.results.push(
      [{ totalMinutes: 150, billableMinutes: 150, includedMinutes: 90 }],
      [{ currencyCode: 'USD', amount: '225.00' }], [{ partsCount: 0 }], [],
    );
    const result = await getTicketBillingSummary('ticket-1');
    expect(result.time).toEqual({ totalMinutes: 150, billableMinutes: 150, includedMinutes: 90,
      billableAmounts: [{ currencyCode: 'USD', amount: '225.00' }] });
    expect(queryMocks.selections[0]).toHaveProperty('includedMinutes');
    const minutesSql = query(queryMocks.selections[0]!.includedMinutes);
    expect(minutesSql.sql).toMatch(/SUM\("time_entries"\."duration_minutes"\).*FILTER.*"time_entries"\."coverage"/i);
    expect(minutesSql.params.includes('included') || minutesSql.sql.includes("'included'")).toBe(true);
    expect(minutesSql.sql).not.toContain('billing_status');
    const moneySql = query(queryMocks.conditions[1]);
    expect(moneySql.sql).toContain('"time_entries"."is_billable" =');
    expect(moneySql.params).toContain(true);
    expect(moneySql.sql).toContain('"time_entries"."hourly_rate" is not null');
    expect(moneySql.sql).not.toContain('billing_status');
  });

  it('empty ticket summaries report zero included minutes', async () => {
    queryMocks.results.push([], [], [], []);
    expect((await getTicketBillingSummary('empty-ticket')).time).toEqual({
      totalMinutes: 0, billableMinutes: 0, includedMinutes: 0, billableAmounts: [],
    });
  });
});
