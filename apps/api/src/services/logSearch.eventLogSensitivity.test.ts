// Stored `device_event_logs` rows in category 'security' carry the same class
// of sensitive content as the live Security/PowerShell/Sysmon channel reads
// gated behind devices:execute in routes/systemTools. This suite proves the
// three shared read paths (search, aggregation, trends) apply the same rule.
import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SensitiveEventLogAccessError } from './eventLogSensitivity';

const dbMocks = vi.hoisted(() => ({ select: vi.fn(), wheres: [] as unknown[] }));

describe('buildSearchConditions category sensitivity gate', () => {
  const dialect = new PgDialect();
  const auth = { orgCondition: () => undefined } as never;
  const timeRange = { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-01-02T00:00:00.000Z') };

  it('excludes security-category rows for a caller without devices:execute and no explicit category filter', async () => {
    const { buildSearchConditions } = await import('./logSearch');
    const rendered = dialect.sqlToQuery(
      and(...buildSearchConditions(auth, { canReadSensitiveCategory: false }, timeRange, 'like'))!,
    );
    expect(rendered.sql.toLowerCase()).toContain("!= $");
    expect(rendered.params).toContain('security');
  });

  it('does not exclude security rows for a caller with devices:execute', async () => {
    const { buildSearchConditions } = await import('./logSearch');
    const rendered = dialect.sqlToQuery(
      and(...buildSearchConditions(auth, { canReadSensitiveCategory: true }, timeRange, 'like'))!,
    );
    expect(rendered.params).not.toContain('security');
  });

  it('drops the security category out of a mixed explicit filter, keeping the rest', async () => {
    const { buildSearchConditions } = await import('./logSearch');
    const rendered = dialect.sqlToQuery(
      and(...buildSearchConditions(
        auth,
        { category: ['security', 'hardware'], canReadSensitiveCategory: false },
        timeRange,
        'like',
      ))!,
    );
    expect(rendered.params).toContain('hardware');
    expect(rendered.params).not.toContain('security');
  });

  it('throws when a devices:read-only caller explicitly asks only for the security category', async () => {
    const { buildSearchConditions } = await import('./logSearch');
    expect(() => buildSearchConditions(
      auth,
      { category: ['security'], canReadSensitiveCategory: false },
      timeRange,
      'like',
    )).toThrow(SensitiveEventLogAccessError);
  });

  it('allows an explicit security-only filter for a devices:execute caller', async () => {
    const { buildSearchConditions } = await import('./logSearch');
    const rendered = dialect.sqlToQuery(
      and(...buildSearchConditions(
        auth,
        { category: ['security'], canReadSensitiveCategory: true },
        timeRange,
        'like',
      ))!,
    );
    expect(rendered.params).toContain('security');
  });
});

describe('getLogAggregation / getLogTrends category sensitivity gate', () => {
  const mocks = dbMocks;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../db', () => ({
      db: { select: mocks.select },
      runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
      withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
      withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    }));
    mocks.wheres.length = 0;
    mocks.select.mockImplementation(() => {
      const c: Record<string, unknown> = {};
      for (const m of ['from', 'leftJoin', 'groupBy', 'orderBy']) c[m] = vi.fn(() => c);
      c.where = vi.fn((w: unknown) => { mocks.wheres.push(w); return c; });
      c.limit = vi.fn(() => c);
      c.then = (ok?: (v: unknown) => unknown, bad?: (r: unknown) => unknown) => Promise.resolve([]).then(ok, bad);
      return c;
    });
  });

  const dialect = new PgDialect();
  const auth = { orgCondition: () => undefined } as never;

  it('getLogAggregation excludes security rows without devices:execute', async () => {
    const { getLogAggregation } = await import('./logSearch');
    await getLogAggregation(auth, { canReadSensitiveCategory: false });
    const rendered = dialect.sqlToQuery(mocks.wheres[0] as never);
    expect(rendered.params).toContain('security');
  });

  it('getLogAggregation does not exclude security rows with devices:execute', async () => {
    const { getLogAggregation } = await import('./logSearch');
    await getLogAggregation(auth, { canReadSensitiveCategory: true });
    const rendered = dialect.sqlToQuery(mocks.wheres[0] as never);
    expect(rendered.params).not.toContain('security');
  });

  it('getLogTrends excludes security rows without devices:execute', async () => {
    const { getLogTrends } = await import('./logSearch');
    await getLogTrends(auth, { canReadSensitiveCategory: false });
    const rendered = dialect.sqlToQuery(mocks.wheres[0] as never);
    expect(rendered.params).toContain('security');
  });

  it('getLogTrends does not exclude security rows with devices:execute', async () => {
    const { getLogTrends } = await import('./logSearch');
    await getLogTrends(auth, { canReadSensitiveCategory: true });
    const rendered = dialect.sqlToQuery(mocks.wheres[0] as never);
    expect(rendered.params).not.toContain('security');
  });
});
