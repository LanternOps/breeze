// A-W05 Task 5a: query_devices offset-mode envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

// Q11: the mock differentiates the COUNT query from the row query by column
// shape (same trick as aiToolsDevice.siteScope.test.ts) — a single `then`
// resolving to `rows` for BOTH calls would make the COUNT query resolve to
// the row array instead of a `[{ count }]` row.
const dbMock = vi.hoisted(() => {
  let rows: unknown[] = [];
  let total = 0;
  let lastOrderByArgs: unknown[] = [];
  const select = vi.fn((cols?: Record<string, unknown>) => {
    if (cols && typeof cols === 'object' && 'count' in cols) {
      return { from: () => ({ where: () => Promise.resolve([{ count: total }]) }) };
    }
    return {
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: (...args: unknown[]) => {
              lastOrderByArgs = args;
              return {
                // Slice by the real limit/offset the handler requested, so a
                // fixture set larger than the page still exercises hasMore/
                // nextCursor honestly instead of always returning everything.
                limit: (n: number) => ({
                  offset: (o: number) => Promise.resolve(rows.slice(o, o + n)),
                }),
              };
            },
          }),
        }),
      }),
    };
  });
  return {
    select,
    setRows: (r: unknown[]) => { rows = r; },
    setTotal: (t: number) => { total = t; },
    getLastOrderByArgs: () => lastOrderByArgs,
  };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));

import { aiTools } from './aiToolNames';
import './aiTools';

const DEVICE_ROW = {
  id: 'id', hostname: 'short', displayName: 'medium', osType: 'short', osVersion: 'short',
  status: 'short', agentVersion: 'short', lastSeenAt: 'ts', siteName: 'short',
} as const;
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, user: { id: 'u1' },
}) as never;

describe('query_devices output shape (A-W05)', () => {
  const tool = aiTools.get('query_devices')!;
  beforeEach(() => { dbMock.setRows([]); dbMock.setTotal(0); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 25, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => fixtureRow(i, DEVICE_ROW));
    dbMock.setRows(rows);
    dbMock.setTotal(25);
    const raw = await tool.handler({ status: 'online' }, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['devices', 'total', 'totalMode', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(25);
    expect(out.offset).toBe(0);
    expect(out.total).toBe(25);
    expectDefaultPageFits('query_devices', raw);
  });

  it('orders by a stable, unique key so offset pagination cannot skip or duplicate rows under heartbeat churn', async () => {
    dbMock.setRows([]);
    dbMock.setTotal(0);
    await tool.handler({}, auth());
    // Fix 2: `lastSeenAt` alone is not a tiebreaker-safe sort key — a device
    // heartbeat between page requests can shift rows across the offset
    // boundary. Ordering by (hostname, id) is stable and unique.
    expect(dbMock.getLastOrderByArgs().length).toBe(2);
  });

  it('refuses a cursor minted for different filters', async () => {
    dbMock.setRows(Array.from({ length: 26 }, (_, i) => fixtureRow(i, DEVICE_ROW)));
    dbMock.setTotal(26);
    const first = JSON.parse(await tool.handler({ status: 'online' }, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ status: 'offline', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});
