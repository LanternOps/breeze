import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// The DB-backed behaviour (the helper analyzes, skips a locked table, is the
// only way breeze_app can) is proved against real Postgres in
// __tests__/integration/backupSnapshotFilesStatistics.integration.test.ts.
// This covers what the caller does with each answer, and that it never throws.

const { executeMock, contexts, recordMock, captureMock } = vi.hoisted(() => ({
  executeMock: vi.fn<(query: SQL) => Promise<unknown>>(),
  contexts: { system: 0, outside: 0 },
  recordMock: vi.fn(),
  captureMock: vi.fn(),
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
vi.mock('./sentry', () => ({ captureException: captureMock }));

import {
  refreshSnapshotFileIndexStatistics,
  STATISTICS_REFRESH_ATTEMPTS,
  STATISTICS_REFRESH_MIN_ROWS,
  STATISTICS_REFRESH_TIMEOUT_MS,
} from './backupSnapshotFileIndexStatistics';

const dialect = new PgDialect();
const statementsRun = () => executeMock.mock.calls.map(([query]) => dialect.sqlToQuery(query));

/**
 * Answers the statement_timeout tightening, then each helper call with the next
 * of `answers` (the last one repeats).
 */
function helperAnswers(...answers: unknown[]) {
  let call = 0;
  executeMock.mockImplementation(async (query) => {
    const { sql: text } = dialect.sqlToQuery(query);
    if (text.includes('statement_timeout')) return [{ prior_ms: 0, applied: `${STATISTICS_REFRESH_TIMEOUT_MS}ms` }];
    if (text.includes('breeze_analyze_backup_snapshot_files')) {
      const analyzed = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return [{ analyzed }];
    }
    throw new Error(`unexpected statement: ${text}`);
  });
}

const helperCalls = () => statementsRun().filter((q) => q.sql.includes('breeze_analyze_backup_snapshot_files')).length;
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  executeMock.mockReset();
  recordMock.mockReset();
  captureMock.mockReset();
  contexts.system = 0;
  contexts.outside = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  info.mockRestore();
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

  it('tries again while the table is busy, and reports analyzed once an attempt gets it', async () => {
    helperAnswers(false, true);
    expect(await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS, { retryDelayMs: 1 })).toBe('analyzed');
    expect(helperCalls()).toBe(2);
    expect(contexts).toEqual({ system: 2, outside: 2 });
    expect(recordMock).toHaveBeenCalledWith('statistics', 'analyzed');
  });

  it('reports busy, with a log line, when every attempt found the table locked', async () => {
    helperAnswers(false);
    expect(await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS, { retryDelayMs: 1 })).toBe('busy');
    expect(helperCalls()).toBe(STATISTICS_REFRESH_ATTEMPTS);
    expect(recordMock).toHaveBeenCalledWith('statistics', 'busy');
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws: a transient failure is logged as a warning, counted and reported as error', async () => {
    const failure = pgError('57014');
    executeMock.mockRejectedValue(failure);

    await expect(refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS + 5)).resolves.toBe('error');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`after publishing ${STATISTICS_REFRESH_MIN_ROWS + 5} rows`);
    expect(warn.mock.calls[0]![1]).toBe(failure);
    expect(captureMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledWith('statistics', 'error');
  });

  it.each([
    ['42883', 'the helper is missing (migration not applied)'],
    ['42501', 'the helper may not run (grant or ownership)'],
  ])('sends a configuration fault (%s: %s) to Sentry as an error', async (code) => {
    const failure = pgError(code);
    executeMock.mockRejectedValue(failure);

    await expect(refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS)).resolves.toBe('error');

    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledWith(failure);
  });

  it('treats an answer that is not a boolean as an error, not as busy', async () => {
    helperAnswers(null);
    expect(await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS)).toBe('error');
    expect(helperCalls()).toBe(1);
    expect(String(warn.mock.calls[0]![1])).toContain('not a boolean');
  });
});
