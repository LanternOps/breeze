// A-W05 Task 5b: search_agent_logs keyset-mode envelope.
//
// Q1 (blocking): `agentLogs.createdAt` is a Postgres `timestamp` WITHOUT time
// zone holding microseconds — the keyset cursor carries `createdAt::text`
// verbatim, never a JS Date/.toISOString() round-trip (ms precision only).
//
// Controller sizing correction (post-review): the DEFAULT page is sized
// against REALISTIC rows (short message, no truncation), not the worst case.
// A worst-case page (every message at its truncation cap) is allowed to hit
// the compactor — the separate "worst case" test below proves that still
// degrades honestly (hasMore/nextCursor/nextStep survive) rather than
// silently.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { compactToolResultForChat, SENTINEL_HINTS } from './aiToolOutput';
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
  agentVersion: 'short',
} as const;

// A realistic agent-log line — ~140 chars, inside the controller's
// 120-200 char range.
const REALISTIC_MESSAGE =
  'Heartbeat check succeeded: agent reachable, CPU 12%, memory 512MB used of 8192MB, uptime 4d 3h 12m, last check-in 2s ago.';

function logRow(i: number, overrides: Record<string, unknown> = {}) {
  const base = fixtureRow(i, LOG_ROW_SHAPE);
  const createdAtText = `2026-09-20 10:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(6, '0')}`;
  return {
    ...base,
    message: REALISTIC_MESSAGE,
    timestamp: new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)),
    createdAt: new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)),
    createdAtText,
    fields: { retries: i, host: 'agent-host' },
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

  it('a default page of REALISTIC rows fits uncompacted, carries the keyset envelope, and omits fields by default', async () => {
    const rows = Array.from({ length: 19 }, (_, i) => logRow(i));
    dbMock.setRows(rows);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as {
      logs: Array<{ message: string; messageTruncated: boolean; fields?: unknown; createdAtText?: unknown }>;
      count: number; showing: number; hasMore: boolean; nextCursor: string | null; offset?: unknown;
    };
    expect(out.hasMore).toBe(true);
    expect(out.offset).toBeUndefined();
    expect(out.logs[0]!.message).toBe(REALISTIC_MESSAGE);
    expect(out.logs[0]!.messageTruncated).toBe(false);
    expect(out.logs[0]!.fields).toBeUndefined();
    expect(out.logs[0]!.createdAtText).toBeUndefined();
    expectDefaultPageFits('search_agent_logs', raw);
  });

  it('a WORST-CASE default page (every message at its truncation cap) degrades honestly under compaction: hasMore/nextCursor survive and nextStep names cursor', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => logRow(i, { message: 'm'.repeat(1500) }));
    dbMock.setRows(rows);
    const raw = await tool.handler({}, auth());
    const compacted = compactToolResultForChat('search_agent_logs', raw);
    const out = JSON.parse(compacted) as {
      logs?: unknown[]; hasMore: boolean; nextCursor: string | null;
      _chat?: { outputCompacted: boolean; nextStep?: string };
    };
    expect(out._chat?.outputCompacted).toBe(true);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out._chat?.nextStep).toBe(SENTINEL_HINTS.cursor);
  });

  it('includeFields: true returns the structured fields object', async () => {
    dbMock.setRows(Array.from({ length: 2 }, (_, i) => logRow(i)));
    const raw = await tool.handler({ includeFields: true }, auth());
    const out = JSON.parse(raw) as { logs: Array<{ fields?: unknown }> };
    expect(out.logs[0]!.fields).toEqual({ retries: 0, host: 'agent-host' });
  });

  it('a nextCursor carries the exact microsecond-precision createdAt text and turns into a (createdAt, id) < (t, i) predicate on the next call', async () => {
    const rows = Array.from({ length: 19 }, (_, i) => logRow(i));
    dbMock.setRows(rows);
    const first = JSON.parse(await tool.handler({}, auth())) as { nextCursor: string };
    expect(first.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as { t: string; i: string };
    expect(decoded.t).toBe(rows[17]!.createdAtText);
    expect(decoded.t).toMatch(/\.\d{6}$/);

    dbMock.rowsWhereSpy.mockClear();
    dbMock.setRows([]);
    await tool.handler({ cursor: first.nextCursor }, auth());
    const whereArg = dbMock.rowsWhereSpy.mock.calls.at(-1)?.[0] as SQL;
    const rendered = new PgDialect().sqlToQuery(whereArg).sql;
    expect(rendered).toContain('created_at');
  });
});
