import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbExecuteMock, withSystemDbAccessContextMock, runOutsideDbContextMock, captureMessageMock } = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>, _label?: string) => fn()),
  runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
  captureMessageMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => dbExecuteMock(...(args as [])) },
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) =>
    withSystemDbAccessContextMock(fn, label),
  runOutsideDbContext: (fn: () => unknown) => runOutsideDbContextMock(fn),
}));

vi.mock('../services/sentry', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...(args as [])),
}));

import { SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  __resetBacklogCaptureThrottle,
  countEligibleRows,
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  retentionEnforceFromEnv,
  updateInCtidBatches,
  utcWallTime,
  warnOnRetentionBacklog,
} from './retentionBatch';

const CUTOFF = '2026-08-01T00:00:00.000Z';
const dialect = new PgDialect();

/**
 * Compile a captured `db.execute` argument into the REAL statement + params.
 *
 * `JSON.stringify(mock.calls)` is not good enough: it dumps Drizzle's
 * queryChunks tree, in which a bound `$1` and an inlined `'literal'` render as
 * the same substring — so an assertion on it cannot tell a parameterised query
 * from a string-concatenated one, nor prove the LIMIT tracks batchSize.
 */
function compiled(callIndex = 0): { sql: string; params: unknown[] } {
  const arg = dbExecuteMock.mock.calls[callIndex]?.[0] as SQL;
  const query = dialect.sqlToQuery(arg);
  return { sql: query.sql, params: query.params as unknown[] };
}

const basePrune = (overrides: Partial<Parameters<typeof pruneInCtidBatches>[0]> = {}) =>
  pruneInCtidBatches({
    table: 'agent_logs',
    where: sql`"timestamp" < ${CUTOFF}`,
    batchSize: 100,
    maxBatches: 50,
    label: 'test.prune',
    ...overrides,
  });

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

  // Silently shortening a self-hosted deployment's configured 1095-day window
  // to 365 deletes two years of history on the first run after upgrade.
  it('warns when it reduces a configured value below what was asked for', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveRetentionDays('1095', 90, 365, '[ChangeLogRetention]')).toBe(365);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('1095');
    expect(message).toContain('365');
    warn.mockRestore();
  });

  it('stays quiet when the configured value is honoured as-is', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRetentionDays('90', 90, 365, '[ChangeLogRetention]')).toBe(90);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  });

  it('emits a bounded ctid DELETE against the requested table', async () => {
    await basePrune();

    const { sql: text } = compiled();
    expect(text).toContain('DELETE FROM agent_logs');
    expect(text).toContain('SELECT ctid');
    expect(text).toContain('FROM agent_logs');
    expect(text).toContain('"timestamp" <');
    expect(text).toContain('LIMIT');
  });

  // Asserting the LIMIT *keyword* survives is worthless — the bug that matters
  // is a LIMIT decoupled from batchSize, which restores the unbounded delete
  // this whole module exists to prevent. So assert the compiled placeholders
  // and the actual bound values.
  it('binds the cutoff and the batch size as parameters, never inlined literals', async () => {
    await basePrune({ batchSize: 250 });

    const { sql: text, params } = compiled();
    expect(text).toMatch(/"timestamp" < \$\d+/);
    expect(text).toMatch(/LIMIT \$\d+/);
    expect(params).toContain(CUTOFF);
    expect(params).toContain(250);
    // No literal made it into the statement text.
    expect(text).not.toContain(CUTOFF);
    expect(text).not.toContain('250');
  });

  // THE point of batching. `withDbAccessContext` opens a transaction and
  // early-returns inside an existing context, so one outer context would hold
  // every lock until the last batch commits — strictly worse than the single
  // unbounded DELETE this replaced.
  it('opens a fresh escaped system context per batch, so each batch commits alone', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 4 });

    await basePrune({ batchSize: 100 });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(3);
    // Escaping first is what makes the nested context actually open a new one.
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(3);
    expect(withSystemDbAccessContextMock.mock.calls[0]?.[1]).toBe('test.prune');
  });

  it('keeps looping while batches come back full and stops on the first short batch', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 7 });

    const result = await basePrune({ batchSize: 100 });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ deleted: 207, batches: 3, hasMore: false });
  });

  it('issues exactly one statement and reports no backlog when the table is already clean', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });

    const result = await basePrune({ table: 'snmp_metrics', batchSize: 100 });

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 0, batches: 1, hasMore: false });
  });

  it('stops at maxBatches and reports hasMore when every allowed batch was full', async () => {
    dbExecuteMock.mockResolvedValue({ rowCount: 100 });

    const result = await basePrune({ table: 'device_change_log', batchSize: 100, maxBatches: 3 });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ deleted: 300, batches: 3, hasMore: true });
  });

  // The second conjunct of `hasMore`. A sweep that reaches the cap on a SHORT
  // final batch drained the table exactly — reporting a backlog there produces
  // a nightly false alarm, which trains operators to ignore the real one.
  it('reports NO backlog when the last allowed batch came back short', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 7 });

    const result = await basePrune({ batchSize: 100, maxBatches: 3 });

    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ deleted: 207, batches: 3, hasMore: false });
  });

  // Production's postgres-js Result carries `.count`, NOT node-postgres'
  // `.rowCount` — and extractRowCount checks `.rowCount` first. Every other
  // test here uses the `.rowCount` shape, so without this one the loop is never
  // exercised against the shape it actually meets in production.
  it('counts rows from a postgres-js Result carrying .count', async () => {
    const pgResult = (count: number) => Object.assign([], { count });
    dbExecuteMock
      .mockResolvedValueOnce(pgResult(100))
      .mockResolvedValueOnce(pgResult(3));

    const result = await basePrune({ batchSize: 100 });

    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ deleted: 103, batches: 2, hasMore: false });
  });

  // extractRowCount is deliberately not null-safe; a broken driver must not
  // read as "0 rows deleted", which would silently end the loop.
  it('propagates a broken driver result instead of treating it as an empty batch', async () => {
    dbExecuteMock.mockResolvedValueOnce(null);

    await expect(basePrune()).rejects.toThrow();
  });

  // The table name is the ONE piece that cannot be a bound parameter, so the
  // helper must refuse anything that is not a bare identifier.
  it('rejects a table name that is not a bare SQL identifier', async () => {
    for (const table of ['agent_logs; DROP TABLE devices', 'public.agent_logs', 'agent logs', '"agent_logs"', '']) {
      await expect(basePrune({ table })).rejects.toThrow(/identifier/i);
    }
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive batch size rather than looping forever on an empty LIMIT', async () => {
    await expect(basePrune({ batchSize: 0 })).rejects.toThrow(/batchSize/i);
    await expect(basePrune({ batchSize: 1.5 })).rejects.toThrow(/batchSize/i);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });

  // `while (batches < 0)` never runs, so the job would report a clean sweep
  // forever while deleting nothing.
  it('rejects a non-positive maxBatches rather than silently deleting nothing', async () => {
    await expect(basePrune({ maxBatches: 0 })).rejects.toThrow(/maxBatches/i);
    await expect(basePrune({ maxBatches: Number.NaN })).rejects.toThrow(/maxBatches/i);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });
});

describe('warnOnRetentionBacklog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetBacklogCaptureThrottle();
  });

  it('warns on stdout AND reports to Sentry when the cap left rows behind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnOnRetentionBacklog('[AgentLogRetention]', 'agent_logs', { deleted: 5000, batches: 50, hasMore: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('[AgentLogRetention]');
    expect(message).toContain('agent_logs');
    expect(message).toContain('50');

    // A stdout line alone is not an alert — this is the only detector for a
    // table growing faster than its sweeper.
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock.mock.calls[0]?.[1]).toMatchObject({
      eventCode: 'retention_backlog_remaining',
      tags: { retentionTarget: 'agent_logs' },
    });
    warn.mockRestore();
  });

  // `detail` carries an org UUID at the eventLogRetention call site. Tag values
  // fork the Sentry issue and are not scrubbed, so an unbounded value there
  // both leaks a tenant id and shatters the issue into one per org.
  it('keeps unbounded detail out of the Sentry tag while still logging it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orgId = '11111111-1111-4111-8111-111111111111';

    warnOnRetentionBacklog('[EventLogRetention]', 'device_event_logs', { deleted: 1, batches: 200, hasMore: true }, `org=${orgId}`);

    // Console keeps the detail — that is what makes the line actionable.
    expect(String(warn.mock.calls[0]?.[0])).toContain(orgId);
    // Sentry gets only the bounded table name.
    const tags = (captureMessageMock.mock.calls[0]?.[1] as { tags: Record<string, string> }).tags;
    expect(tags).toEqual({ retentionTarget: 'device_event_logs' });
    expect(JSON.stringify(tags)).not.toContain(orgId);
    warn.mockRestore();
  });

  // eventLogRetention calls this inside a per-org loop; an incident affecting
  // every org must not emit one Sentry event per org per nightly run.
  it('throttles repeat captures for the same target but keeps logging each one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backlog = { deleted: 1, batches: 200, hasMore: true };

    warnOnRetentionBacklog('[EventLogRetention]', 'device_event_logs', backlog, 'org=a');
    warnOnRetentionBacklog('[EventLogRetention]', 'device_event_logs', backlog, 'org=b');
    warnOnRetentionBacklog('[EventLogRetention]', 'device_event_logs', backlog, 'org=c');

    expect(warn).toHaveBeenCalledTimes(3);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('still reports a DIFFERENT target that backlogs in the same window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backlog = { deleted: 1, batches: 200, hasMore: true };

    warnOnRetentionBacklog('[AgentLogRetention]', 'agent_logs', backlog);
    warnOnRetentionBacklog('[SnmpRetention]', 'snmp_metrics', backlog);

    expect(captureMessageMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('stays silent on both channels when the sweep drained the backlog', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnOnRetentionBacklog('[AgentLogRetention]', 'agent_logs', { deleted: 12, batches: 1, hasMore: false });

    expect(warn).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // The sweep already succeeded; a broken reporter must not turn that into a
  // job failure.
  it('survives a throwing Sentry reporter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureMessageMock.mockImplementation(() => { throw new Error('sentry down'); });

    expect(() =>
      warnOnRetentionBacklog('[AgentLogRetention]', 'agent_logs', { deleted: 1, batches: 50, hasMore: true })
    ).not.toThrow();

    warn.mockRestore();
  });
});

describe('retentionEnforceFromEnv', () => {
  const ENV_NAME = 'RETENTION_BATCH_TEST_ENFORCE';

  afterEach(() => {
    delete process.env[ENV_NAME];
    vi.restoreAllMocks();
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    [' 1 ', true],
    ['True ', true],
    ['false', false],
    ['0', false],
    [' FALSE', false],
  ])('parses %j as %s, whatever the code default', (raw, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[ENV_NAME] = raw;
    expect(retentionEnforceFromEnv('[Test]', ENV_NAME, false)).toBe(expected);
    expect(retentionEnforceFromEnv('[Test]', ENV_NAME, true)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  // Compose maps every knob as `${VAR:-}`, so an unconfigured deployment hands
  // the process an EMPTY string, not an unset variable. Both must mean "the
  // code default" — never "enforce".
  it.each([[undefined], ['']])('uses the code default for %j', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (raw === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = raw;
    expect(retentionEnforceFromEnv('[Test]', ENV_NAME, false)).toBe(false);
    expect(retentionEnforceFromEnv('[Test]', ENV_NAME, true)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  // Review Focus 2: a typo must never enable deletion — not even once the code
  // default is `true` (the Part B flip), because an operator who wrote
  // `ENFORCE=no` meant to turn it OFF.
  it.each([['yes'], ['enforce'], ['2'], ['on'], ['t']])(
    'reports (false) and warns once naming the variable for unrecognised %j',
    (raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env[ENV_NAME] = raw;
      expect(retentionEnforceFromEnv('[Test]', ENV_NAME, false)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain(ENV_NAME);
      expect(message).toContain('[Test]');

      warn.mockClear();
      expect(retentionEnforceFromEnv('[Test]', ENV_NAME, true)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('utcWallTime', () => {
  // Review Focus 5: a bare `::timestamp` cast honours the connection TimeZone,
  // shifting every cutoff on a tz-less column by the server offset.
  it('converts the bound ISO cutoff to UTC wall time explicitly', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    const query = dialect.sqlToQuery(sql`created_at < ${utcWallTime(iso)}`);
    expect(query.sql).toContain("::timestamptz AT TIME ZONE 'UTC'");
    expect(query.sql).not.toContain(iso);
    expect(query.params).toEqual([iso]);
  });
});

describe('countEligibleRows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  });

  const baseCount = (overrides: Partial<Parameters<typeof countEligibleRows>[0]> = {}) =>
    countEligibleRows({
      table: 'agent_logs',
      where: sql`"timestamp" < ${CUTOFF}`,
      cap: 10,
      label: 'test.count',
      ...overrides,
    });

  // The cap is what keeps a report run from becoming a full-table count on a
  // table with a multi-year backlog — the very tables this exists for.
  it('issues one bounded count, binding cap + 1 as the LIMIT', async () => {
    dbExecuteMock.mockResolvedValueOnce([{ n: 3 }]);

    await baseCount({ cap: 10 });

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    const { sql: text, params } = compiled();
    expect(text).toMatch(/count\(\*\)/i);
    expect(text).toContain('FROM agent_logs');
    expect(text).toContain('"timestamp" <');
    expect(text).toMatch(/LIMIT \$\d+/);
    expect(params).toContain(11);
    expect(params).toContain(CUTOFF);
    expect(text).not.toMatch(/\b(DELETE|UPDATE)\b/i);
  });

  it('runs in one fresh escaped system context', async () => {
    dbExecuteMock.mockResolvedValueOnce([{ n: 0 }]);

    await baseCount();

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock.mock.calls[0]?.[1]).toBe('test.count');
  });

  it('reports the cap and capped=true when more than cap rows are eligible', async () => {
    dbExecuteMock.mockResolvedValueOnce([{ n: 11 }]);
    await expect(baseCount({ cap: 10 })).resolves.toEqual({ eligible: 10, capped: true });
  });

  it('reports the exact count when it is at or under the cap', async () => {
    dbExecuteMock.mockResolvedValueOnce([{ n: 3 }]);
    await expect(baseCount({ cap: 10 })).resolves.toEqual({ eligible: 3, capped: false });
    dbExecuteMock.mockResolvedValueOnce([{ n: 10 }]);
    await expect(baseCount({ cap: 10 })).resolves.toEqual({ eligible: 10, capped: false });
  });

  // node-postgres wraps rows in `.rows`; a driver may hand an int back as a
  // numeric string.
  it('accepts a node-postgres { rows } result and a numeric string', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ n: '4' }] });
    await expect(baseCount()).resolves.toEqual({ eligible: 4, capped: false });
  });

  // A broken driver result must not read as "nothing eligible": Gate G1 would
  // then approve an enforce flip on a table whose real count was never seen.
  it.each([[[]], [null], [[{ n: null }]], [[{ n: 'nonsense' }]], [[{}]], [[{ n: -1 }]]])(
    'throws rather than reading %j as zero',
    async (result) => {
      dbExecuteMock.mockResolvedValueOnce(result);
      await expect(baseCount()).rejects.toThrow(/count/i);
    },
  );

  it('rejects a non-identifier table before any query', async () => {
    await expect(baseCount({ table: 'x; drop' })).rejects.toThrow(/identifier/i);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive cap before any query', async () => {
    await expect(baseCount({ cap: 0 })).rejects.toThrow(/cap/i);
    await expect(baseCount({ cap: 2.5 })).rejects.toThrow(/cap/i);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });
});

describe('updateInCtidBatches', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  });

  const baseUpdate = (overrides: Partial<Parameters<typeof updateInCtidBatches>[0]> = {}) =>
    updateInCtidBatches({
      table: 'script_executions',
      set: sql`stdout = NULL`,
      where: sql`created_at < ${CUTOFF} AND stdout IS NOT NULL`,
      batchSize: 100,
      maxBatches: 50,
      label: 'test.update',
      ...overrides,
    });

  it('emits a bounded ctid UPDATE with the SET clause and binds the batch size', async () => {
    await baseUpdate({ batchSize: 250 });

    const { sql: text, params } = compiled();
    expect(text.trim()).toMatch(/^UPDATE script_executions/);
    expect(text).toContain('SET stdout = NULL');
    expect(text).toContain('ctid IN (');
    expect(text).toContain('SELECT ctid');
    expect(text).toContain('FROM script_executions');
    expect(text).toMatch(/LIMIT \$\d+/);
    expect(params).toContain(250);
    expect(params).toContain(CUTOFF);
    expect(text).not.toMatch(/\bDELETE\b/i);
  });

  it('opens a fresh escaped system context per batch', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 4 });

    await baseUpdate();

    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(2);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(2);
    expect(withSystemDbAccessContextMock.mock.calls[0]?.[1]).toBe('test.update');
  });

  it('stops on the first short batch', async () => {
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 7 });

    await expect(baseUpdate()).resolves.toEqual({ deleted: 107, batches: 2, hasMore: false });
  });

  it('stops at maxBatches and reports hasMore only when the final batch was full', async () => {
    dbExecuteMock.mockResolvedValue({ rowCount: 100 });
    await expect(baseUpdate({ maxBatches: 3 })).resolves.toEqual({ deleted: 300, batches: 3, hasMore: true });

    dbExecuteMock.mockReset();
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 9 });
    await expect(baseUpdate({ maxBatches: 3 })).resolves.toEqual({ deleted: 209, batches: 3, hasMore: false });
  });

  // A failing batch must surface, not be retried in a tight loop.
  it('propagates a failing batch after one attempt', async () => {
    dbExecuteMock.mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(baseUpdate()).rejects.toThrow('deadlock detected');
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a broken driver result instead of treating it as an empty batch', async () => {
    dbExecuteMock.mockResolvedValueOnce(null);
    await expect(baseUpdate()).rejects.toThrow();
  });

  it('applies the identifier, batchSize and maxBatches guards before any query', async () => {
    await expect(baseUpdate({ table: 'x; drop' })).rejects.toThrow(/identifier/i);
    await expect(baseUpdate({ batchSize: 0 })).rejects.toThrow(/batchSize/i);
    await expect(baseUpdate({ maxBatches: 0 })).rejects.toThrow(/maxBatches/i);
    expect(dbExecuteMock).not.toHaveBeenCalled();
  });
});

describe('pruneInCtidBatches failure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  });

  it('propagates a failing batch after one attempt rather than looping', async () => {
    dbExecuteMock.mockRejectedValueOnce(new Error('statement timeout'));

    await expect(basePrune()).rejects.toThrow('statement timeout');
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  // Earlier batches have already committed when a later one fails. The error
  // carries no count, so the loop must say what it already removed — otherwise
  // a mid-sweep failure deletes tenant rows with no record of how many.
  it('stops on a later failing batch and logs what earlier batches already committed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbExecuteMock
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockRejectedValueOnce(new Error('lock timeout'));

    await expect(basePrune({ batchSize: 100 })).rejects.toThrow('lock timeout');

    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain('agent_logs');
    expect(message).toContain('100 rows');
    expect(message).toContain('batch 2');
    error.mockRestore();
  });
});
