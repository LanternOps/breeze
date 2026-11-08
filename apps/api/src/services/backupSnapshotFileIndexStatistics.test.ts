import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// The DB-backed behaviour (the helper analyzes, skips a locked table, is the
// only way breeze_app can) is proved against real Postgres in
// __tests__/integration/backupSnapshotFilesStatistics.integration.test.ts.
// This covers what the caller does with each answer, and that it never throws.

const { executeMock, contexts, recordMock } = vi.hoisted(() => ({
  executeMock: vi.fn<(query: SQL) => Promise<unknown>>(),
  contexts: { system: 0, outside: 0 },
  recordMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute: executeMock }),
  },
  runOutsideDbContext: async (fn: () => Promise<unknown>) => {
    contexts.outside += 1;
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    contexts.system += 1;
    return fn();
  },
}));

vi.mock('./backupMetrics', () => ({ recordSnapshotFileIndex: recordMock }));

import {
  refreshSnapshotFileIndexStatistics,
  STATISTICS_REFRESH_MIN_ROWS,
  STATISTICS_REFRESH_TIMEOUT_MS,
} from './backupSnapshotFileIndexStatistics';

const dialect = new PgDialect();
const statementsRun = () => executeMock.mock.calls.map(([query]) => dialect.sqlToQuery(query));

/** Answers the statement_timeout tightening, then the helper call with `analyzed`. */
function helperAnswers(analyzed: boolean | null) {
  executeMock.mockImplementation(async (query) => {
    const { sql: text } = dialect.sqlToQuery(query);
    if (text.includes('statement_timeout')) return [{ prior_ms: 0, applied: `${STATISTICS_REFRESH_TIMEOUT_MS}ms` }];
    if (text.includes('breeze_analyze_backup_snapshot_files')) return [{ analyzed }];
    throw new Error(`unexpected statement: ${text}`);
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  executeMock.mockReset();
  recordMock.mockReset();
  contexts.system = 0;
  contexts.outside = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('refreshSnapshotFileIndexStatistics (#11209)', () => {
  it('does not touch the database below the threshold', async () => {
    expect(await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS - 1)).toBe('below_threshold');
    expect(executeMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('honours a lower threshold when one is passed', async () => {
    helperAnswers(true);
    expect(await refreshSnapshotFileIndexStatistics(10, { minRows: 10 })).toBe('analyzed');
  });

  it('bounds the helper call with statement_timeout, in its own system-scoped transaction outside any request', async () => {
    helperAnswers(true);
    expect(await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS)).toBe('analyzed');

    const [timeout, helper] = statementsRun();
    expect(timeout!.sql).toContain('statement_timeout');
    expect(timeout!.params).toContain(STATISTICS_REFRESH_TIMEOUT_MS);
    expect(helper!.sql).toBe('SELECT public.breeze_analyze_backup_snapshot_files() AS analyzed');
    expect(statementsRun()).toHaveLength(2);
    expect(contexts).toEqual({ system: 1, outside: 1 });
    expect(recordMock).toHaveBeenCalledWith('statistics', 'analyzed');
  });

  it('reports busy when the helper found the table locked', async () => {
    helperAnswers(false);
    expect(await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS)).toBe('busy');
    expect(recordMock).toHaveBeenCalledWith('statistics', 'busy');
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws: a failure is logged, counted and reported as error', async () => {
    const failure = new Error('canceling statement due to statement timeout');
    executeMock.mockRejectedValue(failure);

    await expect(refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS + 5)).resolves.toBe('error');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`after publishing ${STATISTICS_REFRESH_MIN_ROWS + 5} rows`);
    expect(warn.mock.calls[0]![1]).toBe(failure);
    expect(recordMock).toHaveBeenCalledWith('statistics', 'error');
  });
});
