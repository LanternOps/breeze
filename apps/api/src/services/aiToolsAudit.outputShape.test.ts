// A-W05 Task 5b: query_audit_log / query_change_log keyset-mode envelopes.
//
// Q1 (blocking): `auditLogs.timestamp` / `deviceChangeLog.timestamp` are
// Postgres `timestamp` WITHOUT time zone columns holding microseconds — the
// keyset cursor carries `timestamp::text` verbatim, never a JS
// Date/.toISOString() round-trip (ms precision only).
//
// Controller sizing correction (post-review): the DEFAULT page is sized
// against REALISTIC rows (a handful of detail/changed keys, typical-length
// resourceName/subject), not the worst case. A worst-case page (max-length
// varchar fields, a details/afterValue object with many keys) is allowed to
// hit the compactor — the separate "worst case" test below proves that still
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
  function rowsChain() {
    return {
      where: (w: unknown) => {
        rowsWhereSpy(w);
        return { orderBy: () => ({ limit: (n: number) => Promise.resolve(rows.slice(0, n)) }) };
      },
    };
  }
  const select = vi.fn((cols?: Record<string, unknown>) => {
    if (cols && typeof cols === 'object' && 'count' in cols && Object.keys(cols).length === 1) {
      return { from: () => ({ where: () => Promise.resolve([{ count: total }]) }) };
    }
    return {
      from: () => ({
        ...rowsChain(),
        leftJoin: () => rowsChain(),
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

import { aiTools } from './aiToolNames';
import './aiTools';

const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: 'org-1', accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null,
  canAccessSite: () => true, user: { id: 'u1' },
}) as never;

function tsText(i: number): string {
  return `2026-09-20 10:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(6, '0')}`;
}

// A details/resourceName/subject big enough to genuinely force compaction —
// long (a resource path, a verbose installer name) and a details/afterValue
// object with many keys, but sized so the TIGHTEST compaction tier (10
// items, 300-char strings) can still bring it under budget: this must land
// in outcome 2 (compacted, rows survive) to prove the honest-degrade
// contract, not outcome 3 (replaced by a digest with no rows at all) — an
// even more extreme fixture (every field at its schema max) demonstrably
// falls through to the digest instead, which is DIFFERENT behavior from what
// this test is proving.
const WORST_CASE_RESOURCE_NAME = 'r'.repeat(180);
const WORST_CASE_DETAILS = Object.fromEntries(
  Array.from({ length: 10 }, (_, k) => [`detailKey${k}`, `value-${k}`])
);
const WORST_CASE_SUBJECT = 's'.repeat(300);
const WORST_CASE_AFTER_VALUE = Object.fromEntries(
  Array.from({ length: 10 }, (_, k) => [`field${k}`, `value-${k}`])
);

describe('query_audit_log output shape (A-W05 keyset)', () => {
  const tool = aiTools.get('query_audit_log')!;
  beforeEach(() => { dbMock.setRows([]); dbMock.setTotal(0); dbMock.rowsWhereSpy.mockClear(); });

  const AUDIT_ROW_SHAPE = {
    id: 'id', actorType: 'short', action: 'short', resourceType: 'short',
  } as const;
  function auditRow(i: number, overrides: Record<string, unknown> = {}) {
    return {
      ...fixtureRow(i, AUDIT_ROW_SHAPE),
      actorEmail: 'jane.doe@example.com',
      resourceName: 'WIN-DESKTOP-042',
      timestamp: new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)),
      timestampText: tsText(i),
      result: 'success',
      details: { scriptId: 'sc-1', exitCode: 0, durationMs: 842 },
      ...overrides,
    };
  }

  it('declares limit and cursor but NOT offset, and adds includeDetails', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.limit).toBeDefined();
    expect(props.cursor).toBeDefined();
    expect(props.offset).toBeUndefined();
    expect(props.includeDetails).toBeDefined();
  });

  it('a default page of REALISTIC rows fits uncompacted, carries the keyset envelope, and replaces details with detailsKeys by default', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => auditRow(i));
    dbMock.setRows(rows);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as {
      entries: Array<{ details?: unknown; detailsKeys?: string[]; timestampText?: unknown }>;
      showing: number; hasMore: boolean; nextCursor: string | null; offset?: unknown;
    };
    expect(out.hasMore).toBe(true);
    expect(out.offset).toBeUndefined();
    expect(out.entries[0]!.details).toBeUndefined();
    expect(out.entries[0]!.detailsKeys).toEqual(['scriptId', 'exitCode', 'durationMs']);
    expect(out.entries[0]!.timestampText).toBeUndefined();
    expectDefaultPageFits('query_audit_log', raw);
  });

  it('a WORST-CASE default page (a long resourceName, a 10-key details object) degrades honestly under compaction: hasMore/nextCursor survive and nextStep names cursor', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => auditRow(i, {
      resourceName: WORST_CASE_RESOURCE_NAME,
      details: WORST_CASE_DETAILS,
    }));
    dbMock.setRows(rows);
    const raw = await tool.handler({}, auth());
    const compacted = compactToolResultForChat('query_audit_log', raw);
    const out = JSON.parse(compacted) as {
      entries?: unknown[]; hasMore: boolean; nextCursor: string | null;
      _chat?: { outputCompacted: boolean; nextStep?: string };
    };
    expect(out._chat?.outputCompacted).toBe(true);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out._chat?.nextStep).toBe(SENTINEL_HINTS.cursor);
  });

  it('includeDetails: true returns the details object', async () => {
    dbMock.setRows(Array.from({ length: 2 }, (_, i) => auditRow(i)));
    const raw = await tool.handler({ includeDetails: true }, auth());
    const out = JSON.parse(raw) as { entries: Array<{ details?: unknown }> };
    expect(out.entries[0]!.details).toEqual({ scriptId: 'sc-1', exitCode: 0, durationMs: 842 });
  });

  it('a nextCursor carries the exact microsecond-precision timestamp text and turns into a (timestamp, id) < (t, i) predicate on the next call', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => auditRow(i));
    dbMock.setRows(rows);
    const first = JSON.parse(await tool.handler({}, auth())) as { nextCursor: string };
    expect(first.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as { t: string; i: string };
    expect(decoded.t).toBe(rows[24]!.timestampText);
    expect(decoded.t).toMatch(/\.\d{6}$/);

    dbMock.rowsWhereSpy.mockClear();
    dbMock.setRows([]);
    await tool.handler({ cursor: first.nextCursor }, auth());
    const whereArg = dbMock.rowsWhereSpy.mock.calls.at(-1)?.[0] as SQL;
    const rendered = new PgDialect().sqlToQuery(whereArg).sql;
    expect(rendered).toContain('"timestamp"');
  });
});

describe('query_change_log output shape (A-W05 keyset)', () => {
  const tool = aiTools.get('query_change_log')!;
  beforeEach(() => { dbMock.setRows([]); dbMock.setTotal(0); dbMock.rowsWhereSpy.mockClear(); });

  const CHANGE_ROW_SHAPE = {
    id: 'id', changeType: 'short', changeAction: 'short', deviceId: 'id',
  } as const;
  function changeRow(i: number, overrides: Record<string, unknown> = {}) {
    return {
      ...fixtureRow(i, CHANGE_ROW_SHAPE),
      subject: 'Google Chrome',
      hostname: 'WIN-DESKTOP-042',
      timestamp: new Date(Date.UTC(2026, 8, 20, 10, i % 60, 0)),
      timestampText: tsText(i),
      beforeValue: { version: '138.0.7204' },
      afterValue: { version: '139.0.7258', installedAt: '2026-09-20T10:00:00Z' },
      details: null,
      ...overrides,
    };
  }

  it('declares limit and cursor but NOT offset, and adds includeValues', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.limit).toBeDefined();
    expect(props.cursor).toBeDefined();
    expect(props.offset).toBeUndefined();
    expect(props.includeValues).toBeDefined();
  });

  it('a default page of REALISTIC rows fits uncompacted, carries the keyset envelope, total and filters, and replaces values with changedKeys by default', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => changeRow(i));
    dbMock.setRows(rows);
    dbMock.setTotal(60);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as {
      changes: Array<{ beforeValue?: unknown; afterValue?: unknown; details?: unknown; changedKeys?: string[]; timestampText?: unknown }>;
      showing: number; hasMore: boolean; nextCursor: string | null; offset?: unknown; total: number; filters: unknown;
    };
    expect(out.hasMore).toBe(true);
    expect(out.total).toBe(60);
    expect(out.offset).toBeUndefined();
    expect(out.filters).toBeDefined();
    expect(out.changes[0]!.beforeValue).toBeUndefined();
    expect(out.changes[0]!.afterValue).toBeUndefined();
    expect(out.changes[0]!.changedKeys).toEqual(['version', 'installedAt']);
    expect(out.changes[0]!.timestampText).toBeUndefined();
    expectDefaultPageFits('query_change_log', raw);
  });

  it('a WORST-CASE default page (a long subject, a 10-key afterValue) degrades honestly under compaction: hasMore/nextCursor survive and nextStep names cursor', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => changeRow(i, {
      subject: WORST_CASE_SUBJECT,
      afterValue: WORST_CASE_AFTER_VALUE,
    }));
    dbMock.setRows(rows);
    dbMock.setTotal(500);
    const raw = await tool.handler({}, auth());
    const compacted = compactToolResultForChat('query_change_log', raw);
    const out = JSON.parse(compacted) as {
      changes?: unknown[]; hasMore: boolean; nextCursor: string | null;
      _chat?: { outputCompacted: boolean; nextStep?: string };
    };
    expect(out._chat?.outputCompacted).toBe(true);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out._chat?.nextStep).toBe(SENTINEL_HINTS.cursor);
  });

  it('includeValues: true returns before/after/details', async () => {
    dbMock.setRows(Array.from({ length: 2 }, (_, i) => changeRow(i)));
    dbMock.setTotal(2);
    const raw = await tool.handler({ includeValues: true }, auth());
    const out = JSON.parse(raw) as { changes: Array<{ beforeValue?: unknown; afterValue?: unknown }> };
    expect(out.changes[0]!.beforeValue).toEqual({ version: '138.0.7204' });
    expect(out.changes[0]!.afterValue).toEqual({ version: '139.0.7258', installedAt: '2026-09-20T10:00:00Z' });
  });

  it('a nextCursor carries the exact microsecond-precision timestamp text and turns into a (timestamp, id) < (t, i) predicate on the next call', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => changeRow(i));
    dbMock.setRows(rows);
    dbMock.setTotal(60);
    const first = JSON.parse(await tool.handler({}, auth())) as { nextCursor: string };
    expect(first.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as { t: string; i: string };
    expect(decoded.t).toBe(rows[24]!.timestampText);
    expect(decoded.t).toMatch(/\.\d{6}$/);

    dbMock.rowsWhereSpy.mockClear();
    dbMock.setRows([]);
    dbMock.setTotal(0);
    await tool.handler({ cursor: first.nextCursor }, auth());
    const whereArg = dbMock.rowsWhereSpy.mock.calls.at(-1)?.[0] as SQL;
    const rendered = new PgDialect().sqlToQuery(whereArg).sql;
    expect(rendered).toContain('"timestamp"');
  });
});
