import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbExecuteMock } = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => dbExecuteMock(...(args as [])) },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));

import { sql } from 'drizzle-orm';

import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
} from './retentionBatch';

const renderedSql = () => JSON.stringify(dbExecuteMock.mock.calls);

describe('resolveRetentionDays', () => {
  it('uses the configured value when it parses inside the allowed range', () => {
    expect(resolveRetentionDays('45', 30, 365)).toBe(45);
  });

  it('falls back when unset or empty', () => {
    expect(resolveRetentionDays(undefined, 30, 365)).toBe(30);
    expect(resolveRetentionDays('', 30, 365)).toBe(30);
  });

  // A clamp alone cannot save this: Math.max(1, NaN) is NaN, which reaches
  // `new Date(NaN).toISOString()` and throws RangeError on every run.
  it('falls back on unparseable input rather than producing NaN', () => {
    const result = resolveRetentionDays('nonsense', 30, 365);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(30);
  });

  // `0`/negative read as "no retention". Clamping them to the 1-day floor would
  // prune nearly the whole table on the next run, so they must FALL BACK.
  it('falls back on zero and negatives instead of clamping to a one-day window', () => {
    expect(resolveRetentionDays('0', 30, 365)).toBe(30);
    expect(resolveRetentionDays('-5', 30, 365)).toBe(30);
  });

  it('still caps an out-of-range configured value', () => {
    expect(resolveRetentionDays('100000', 30, 365)).toBe(365);
  });

  // BullMQ job payloads carry a number, env carries a string; both must hit the
  // same guard rather than one path quietly skipping the NaN/non-positive check.
  it('applies the identical guard to numeric job-payload input', () => {
    expect(resolveRetentionDays(45, 30, 365)).toBe(45);
    expect(resolveRetentionDays(100000, 30, 365)).toBe(365);
    expect(resolveRetentionDays(0, 30, 365)).toBe(30);
    expect(resolveRetentionDays(-5, 30, 365)).toBe(30);
    expect(resolveRetentionDays(Number.NaN, 30, 365)).toBe(30);
    expect(resolveRetentionDays(undefined, 30, 365)).toBe(30);
  });
});

describe('parsePositiveIntEnv', () => {
  const ENV_NAME = 'RETENTION_BATCH_TEST_VALUE';

  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it('reads a positive integer from the environment', () => {
    process.env[ENV_NAME] = '250';
    expect(parsePositiveIntEnv('[Test]', ENV_NAME, 10)).toBe(250);
  });

  it('falls back when unset', () => {
    expect(parsePositiveIntEnv('[Test]', ENV_NAME, 10)).toBe(10);
  });

  it('falls back and warns on a non-positive or unparseable value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[ENV_NAME] = '0';
    expect(parsePositiveIntEnv('[Test]', ENV_NAME, 10)).toBe(10);
    process.env[ENV_NAME] = 'nonsense';
    expect(parsePositiveIntEnv('[Test]', ENV_NAME, 10)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('pruneInCtidBatches', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
  });

  it('emits a bounded ctid DELETE carrying the caller predicate and LIMIT', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });

    await pruneInCtidBatches({
      table: 'agent_logs',
      where: sql`"timestamp" < ${'2026-08-01T00:00:00.000Z'}`,
      batchSize: 500,
      maxBatches: 50,
    });

    const rendered = renderedSql();
    expect(rendered).toContain('DELETE FROM ');
    expect(rendered).toContain('agent_logs');
    expect(rendered).toContain('SELECT ctid');
    // JSON.stringify escapes the quotes around the quoted column identifier.
    expect(rendered).toContain('\\"timestamp\\" <');
    expect(rendered).toContain('LIMIT');
    // The batch bound and the cutoff must be BOUND PARAMETERS, never inlined.
    expect(rendered).toContain('2026-08-01T00:00:00.000Z');
  });

  it('keeps looping while batches come back full and stops on the first short batch', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 7 });

    const result = await pruneInCtidBatches({
      table: 'agent_logs',
      where: sql`"timestamp" < ${'2026-08-01T00:00:00.000Z'}`,
      batchSize: 100,
      maxBatches: 50,
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ deleted: 207, batches: 3, hasMore: false });
  });

  it('issues exactly one statement and reports no backlog when the table is already clean', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });

    const result = await pruneInCtidBatches({
      table: 'snmp_metrics',
      where: sql`"timestamp" < ${'2026-08-01T00:00:00.000Z'}`,
      batchSize: 100,
      maxBatches: 50,
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 0, batches: 1, hasMore: false });
  });

  // The whole point of the cap: never hold a pooled connection for an unbounded
  // delete. Hitting it must STOP and report a backlog, not keep going.
  it('stops at maxBatches and reports hasMore when every allowed batch was full', async () => {
    dbExecuteMock.mockResolvedValue({ rowCount: 100 });

    const result = await pruneInCtidBatches({
      table: 'device_change_log',
      where: sql`created_at < ${'2026-08-01T00:00:00.000Z'}`,
      batchSize: 100,
      maxBatches: 3,
    });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ deleted: 300, batches: 3, hasMore: true });
  });

  // extractRowCount is deliberately not null-safe; a broken driver/mock must not
  // read as "0 rows deleted", which would silently end the loop.
  it('propagates a broken driver result instead of treating it as an empty batch', async () => {
    dbExecuteMock.mockResolvedValueOnce(null);

    await expect(pruneInCtidBatches({
      table: 'agent_logs',
      where: sql`"timestamp" < ${'2026-08-01T00:00:00.000Z'}`,
      batchSize: 100,
      maxBatches: 5,
    })).rejects.toThrow();
  });

  // The table name is the ONE piece that cannot be a bound parameter, so the
  // helper must refuse anything that is not a bare identifier.
  it('rejects a table name that is not a bare SQL identifier', async () => {
    for (const table of ['agent_logs; DROP TABLE devices', 'public.agent_logs', 'agent logs', '"agent_logs"', '']) {
      await expect(pruneInCtidBatches({
        table,
        where: sql`1 = 1`,
        batchSize: 10,
        maxBatches: 1,
      })).rejects.toThrow(/identifier/i);
    }
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive batch size rather than looping forever on an empty LIMIT', async () => {
    await expect(pruneInCtidBatches({
      table: 'agent_logs',
      where: sql`1 = 1`,
      batchSize: 0,
      maxBatches: 5,
    })).rejects.toThrow(/batchSize/i);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });
});

describe('warnOnRetentionBacklog', () => {
  it('warns loudly when the cap stopped a sweep with rows still eligible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnOnRetentionBacklog('[AgentLogRetention]', 'agent_logs', { deleted: 5000, batches: 50, hasMore: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('[AgentLogRetention]');
    expect(message).toContain('agent_logs');
    expect(message).toContain('50');
    warn.mockRestore();
  });

  it('stays silent when the sweep drained the backlog', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnOnRetentionBacklog('[AgentLogRetention]', 'agent_logs', { deleted: 12, batches: 1, hasMore: false });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
