// A-W05 Task 5b: search_agent_logs keyset-mode envelope.
//
// Q1 (blocking): `agentLogs.createdAt` is a Postgres `timestamp` WITHOUT time
// zone holding microseconds — the keyset cursor carries `createdAt::text`
// verbatim, never a JS Date/.toISOString() round-trip (ms precision only).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  let rows: unknown[] = [];
  const rowsWhereSpy = vi.fn();
  const select = vi.fn(() => ({
    from: () => ({
      where: (w: unknown) => {
        rowsWhereSpy(w);
        return { orderBy: () => ({ limit: (n: number) => Promise.resolve(rows.slice(0, n)) }) };
      },
    }),
  }));
  return { select, setRows: (r: unknown[]) => { rows = r; }, rowsWhereSpy };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn(), aiExecuteCommand: vi.fn() }));

import { aiTools } from './aiToolNames';
import './aiTools';

const LOG_ROW_SHAPE = {
  id: 'id',
  deviceId: 'id',
  level: 'short',
  component: 'short',
  message: 'long',
  agentVersion: 'short',
} as const;

function logRow(i: number, overrides: Record<string, unknown> = {}) {
  const base = fixtureRow(i, LOG_ROW_SHAPE);
  const createdAtText = `2026-09-20 10:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(6, '0')}`;
  return {
    ...base,
    timestamp: new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)),
    createdAt: new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)),
    createdAtText,
    fields: { retries: i },
    ...overrides,
  };
}

const auth = () => ({ user: { id: 'u1' }, orgId: 'org-1', accessibleOrgIds: ['org-1'] }) as never;

describe('search_agent_logs output shape (A-W05 keyset)', () => {
  const tool = aiTools.get('search_agent_logs')!;
  beforeEach(() => { dbMock.setRows([]); dbMock.rowsWhereSpy.mockClear(); });

  it('declares limit and cursor but NOT offset, and adds includeFields', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.limit).toBeDefined();
    expect(props.cursor).toBeDefined();
    expect(props.offset).toBeUndefined();
    expect(props.includeFields).toBeDefined();
  });

  it('a default page fits, carries the keyset envelope, omits fields by default, and long messages are cut with a flag', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => logRow(i, { message: 'm'.repeat(1500) }));
    dbMock.setRows(rows);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as {
      logs: Array<{ message: string; messageTruncated: boolean; fields?: unknown; createdAtText?: unknown }>;
      count: number; showing: number; hasMore: boolean; nextCursor: string | null; offset?: unknown;
    };
    expect(out.showing).toBe(5);
    expect(out.hasMore).toBe(true);
    expect(out.count).toBe(5);
    expect(out.offset).toBeUndefined();
    expect(out.logs[0]!.message).toHaveLength(1000);
    expect(out.logs[0]!.messageTruncated).toBe(true);
    expect(out.logs[0]!.fields).toBeUndefined();
    expect(out.logs[0]!.createdAtText).toBeUndefined();
    expectDefaultPageFits('search_agent_logs', raw);
  });

  it('includeFields: true returns the structured fields object', async () => {
    dbMock.setRows(Array.from({ length: 2 }, (_, i) => logRow(i)));
    const raw = await tool.handler({ includeFields: true }, auth());
    const out = JSON.parse(raw) as { logs: Array<{ fields?: unknown }> };
    expect(out.logs[0]!.fields).toEqual({ retries: 0 });
  });

  it('a nextCursor carries the exact microsecond-precision createdAt text and turns into a (createdAt, id) < (t, i) predicate on the next call', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => logRow(i));
    dbMock.setRows(rows);
    const first = JSON.parse(await tool.handler({}, auth())) as { nextCursor: string };
    expect(first.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as { t: string; i: string };
    expect(decoded.t).toBe(rows[4]!.createdAtText);
    expect(decoded.t).toMatch(/\.\d{6}$/);

    dbMock.rowsWhereSpy.mockClear();
    dbMock.setRows([]);
    await tool.handler({ cursor: first.nextCursor }, auth());
    const whereArg = dbMock.rowsWhereSpy.mock.calls.at(-1)?.[0] as SQL;
    const rendered = new PgDialect().sqlToQuery(whereArg).sql;
    expect(rendered).toContain('created_at');
  });
});
