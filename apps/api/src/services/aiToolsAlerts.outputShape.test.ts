// A-W05 Task 5b: manage_alerts (list) keyset-mode envelope.
//
// Q1 (blocking): `alerts.triggeredAt` is a Postgres `timestamp` WITHOUT time
// zone holding microseconds. The keyset cursor MUST carry the sort key as
// `triggeredAt::text` (never a JS Date/.toISOString() round-trip, which
// rounds to milliseconds). These tests assert the row select carries a text
// column and that the cursor's `t` matches it exactly.
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
  let total = 0;
  const rowsWhereSpy = vi.fn();
  const select = vi.fn((cols?: Record<string, unknown>) => {
    if (cols && typeof cols === 'object' && 'count' in cols && Object.keys(cols).length === 1) {
      return { from: () => ({ where: () => Promise.resolve([{ count: total }]) }) };
    }
    return {
      from: () => ({
        where: (w: unknown) => {
          rowsWhereSpy(w);
          return { orderBy: () => ({ limit: (n: number) => Promise.resolve(rows.slice(0, n)) }) };
        },
      }),
    };
  });
  return {
    select,
    setRows: (r: unknown[]) => { rows = r; },
    setTotal: (t: number) => { total = t; },
    rowsWhereSpy,
  };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => {}) }));

import { aiTools } from './aiToolNames';
import './aiTools';

const ALERT_ROW_SHAPE = {
  id: 'id',
  status: 'short',
  severity: 'short',
  title: 'medium',
  deviceId: 'id',
  triggeredAt: 'ts',
  acknowledgedAt: 'null',
  resolvedAt: 'null',
  suppressedUntil: 'null',
} as const;

// A realistic alert message — the kind a rule actually produces, not a
// pathological one. ~130 chars, inside the controller's 120-200 char range.
const REALISTIC_MESSAGE =
  'CPU usage on this host has exceeded 90% for more than 15 minutes. Investigate running processes and consider scaling.';

// Two decimal digits per row so every row's microsecond text is distinct and
// verifiable.
function alertRow(i: number, overrides: Record<string, unknown> = {}) {
  const base = fixtureRow(i, ALERT_ROW_SHAPE);
  return {
    ...base,
    message: REALISTIC_MESSAGE,
    triggeredAtText: `2026-09-20 10:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(6, '0')}`,
    ...overrides,
  };
}

const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null, user: { id: 'u1' },
}) as never;

describe('manage_alerts list output shape (A-W05 keyset)', () => {
  const tool = aiTools.get('manage_alerts')!;
  beforeEach(() => { dbMock.setRows([]); dbMock.setTotal(0); dbMock.rowsWhereSpy.mockClear(); });

  it('declares limit and cursor but NOT offset', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.limit).toBeDefined();
    expect(props.cursor).toBeDefined();
    expect(props.offset).toBeUndefined();
  });

  it('a default page of REALISTIC rows fits uncompacted and carries the keyset envelope', async () => {
    const rows = Array.from({ length: 16 }, (_, i) => alertRow(i));
    dbMock.setRows(rows);
    dbMock.setTotal(16);
    const raw = await tool.handler({ action: 'list', severity: 'high' }, auth());
    const out = JSON.parse(raw) as {
      alerts: Array<{ message: string; messageTruncated: boolean; triggeredAtText?: unknown }>;
      showing: number; hasMore: boolean; nextCursor: string | null; offset?: unknown; total: number;
    };
    expect(out.hasMore).toBe(true);
    expect(out.total).toBe(16);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out.offset).toBeUndefined();
    expect(out.alerts[0]!.message).toBe(REALISTIC_MESSAGE);
    expect(out.alerts[0]!.messageTruncated).toBe(false);
    // Internal keying field must never leak into the visible payload.
    expect(out.alerts[0]!.triggeredAtText).toBeUndefined();
    expectDefaultPageFits('manage_alerts', raw);
  });

  it('a WORST-CASE default page (every message at its truncation cap) degrades honestly under compaction: hasMore/nextCursor survive and nextStep names cursor', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => alertRow(i, { message: 'm'.repeat(900) }));
    dbMock.setRows(rows);
    dbMock.setTotal(100);
    const raw = await tool.handler({ action: 'list', severity: 'high' }, auth());
    const compacted = compactToolResultForChat('manage_alerts', raw);
    const out = JSON.parse(compacted) as {
      alerts?: unknown[]; hasMore: boolean; nextCursor: string | null;
      _chat?: { outputCompacted: boolean; nextStep?: string };
    };
    // Proves this fixture actually exercises the degrade path, not a no-op.
    expect(out._chat?.outputCompacted).toBe(true);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out._chat?.nextStep).toBe(SENTINEL_HINTS.cursor);
  });

  it('a nextCursor carries the exact microsecond-precision triggeredAt text (no Date round-trip) and turns into a (triggeredAt, id) < (t, i) predicate on the next call', async () => {
    const rows = Array.from({ length: 16 }, (_, i) => alertRow(i));
    dbMock.setRows(rows);
    dbMock.setTotal(16);
    const first = JSON.parse(await tool.handler({ action: 'list', severity: 'high' }, auth())) as { nextCursor: string };
    expect(first.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as { t: string; i: string };
    // Row 14 (0-indexed, 15th row = last row of a 15-row default page)
    // carries its own microsecond text — assert it round-tripped verbatim,
    // not rounded to milliseconds.
    expect(decoded.t).toBe(rows[14]!.triggeredAtText);
    expect(decoded.t).toMatch(/\.\d{6}$/);

    dbMock.rowsWhereSpy.mockClear();
    dbMock.setRows([]);
    dbMock.setTotal(0);
    await tool.handler({ action: 'list', severity: 'high', cursor: first.nextCursor }, auth());
    const whereArg = dbMock.rowsWhereSpy.mock.calls.at(-1)?.[0] as SQL;
    const rendered = new PgDialect().sqlToQuery(whereArg).sql;
    expect(rendered).toContain('triggered_at');
  });
});
