/**
 * Regression tests for issue #3217 — the SNMP scheduler ignored pollingInterval
 * for devices that never succeed.
 *
 * `last_polled` is stamped only when poll results are persisted, so a device
 * that never succeeds kept it NULL forever and matched the scheduler's
 * `IS NULL` branch on every 60s tick, no matter what pollingInterval said.
 *
 * These tests use the REAL drizzle schema (not a string stub) so the emitted
 * SQL can be rendered through a real Postgres dialect and asserted on directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { addMock, getJobMock, closeMock, sendCommandToAgentMock, isAgentConnectedMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  closeMock: vi.fn(),
  sendCommandToAgentMock: vi.fn(),
  isAgentConnectedMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {},
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: sendCommandToAgentMock,
  isAgentConnected: isAgentConnectedMock,
}));

/** Captured calls against the mocked drizzle `db`. */
interface Captured {
  selectWheres: unknown[];
  updateSets: Record<string, unknown>[];
  insertValues: unknown[];
  order: string[];
}
const captured: Captured = { selectWheres: [], updateSets: [], insertValues: [], order: [] };

/** Results handed back, in order, to successive `db.select()` chains. */
let selectResults: unknown[][] = [];
/** When set, the next `db.update(...).set(...).where(...)` rejects with this. */
let updateError: Error | null = null;
/** When set, `db.insert(...).values(...)` rejects with this. */
let insertError: Error | null = null;

vi.mock('../db', () => {
  const selectChain = () => {
    const rows = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (condition: unknown) => {
      captured.selectWheres.push(condition);
      return chain;
    };
    chain.limit = () => Promise.resolve(rows);
    // Thenable so a chain awaited without `.limit()` (the scheduler) resolves.
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected);
    return chain;
  };

  return {
    db: {
      select: () => {
        captured.order.push('select');
        return selectChain();
      },
      update: () => {
        captured.order.push('update');
        return {
          set: (values: Record<string, unknown>) => {
            captured.updateSets.push(values);
            return {
              where: () => (updateError ? Promise.reject(updateError) : Promise.resolve()),
            };
          },
        };
      },
      insert: () => {
        captured.order.push('insert');
        return {
          values: (rows: unknown) => {
            captured.insertValues.push(rows);
            return insertError ? Promise.reject(insertError) : Promise.resolve();
          },
        };
      },
    },
    withSystemDbAccessContext: undefined,
  };
});

import { __testables } from './snmpWorker';

const { processScheduler, processPollDevice, processPollResults, FAILURE_STATUS_THRESHOLD, MAX_BACKOFF_SHIFT, MAX_BACKOFF_SECONDS } = __testables;

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

beforeEach(() => {
  captured.selectWheres = [];
  captured.updateSets = [];
  captured.insertValues = [];
  captured.order = [];
  selectResults = [];
  updateError = null;
  insertError = null;
  addMock.mockReset();
  getJobMock.mockReset();
  sendCommandToAgentMock.mockReset();
  isAgentConnectedMock.mockReset();
  addMock.mockResolvedValue({ id: 'job-1' });
  getJobMock.mockResolvedValue(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('processScheduler due-check (#3217)', () => {
  it('keys the due-check off the last attempt, not the last success', async () => {
    selectResults = [[]];

    await processScheduler();

    const { sql: text } = render(captured.selectWheres[0]);

    // The attempt timestamp is now part of the due-check...
    expect(text).toContain('last_poll_attempted_at');
    // ...and `last_polled` survives only inside GREATEST, never as a bare
    // `last_polled IS NULL` branch. That branch is the whole bug: it made every
    // never-succeeding device due on every single 60s tick.
    expect(text).not.toMatch(/"last_polled"\s+is null/i);
    expect(text).toMatch(/greatest\(\s*"snmp_devices"\."last_poll_attempted_at",\s*"snmp_devices"\."last_polled"\s*\)/i);
  });

  it('scales the interval by consecutive failures, shift- and absolute-capped', async () => {
    selectResults = [[]];

    await processScheduler();

    const { sql: text, params } = render(captured.selectWheres[0]);

    expect(text).toContain('consecutive_failures');
    expect(text).toContain('POWER(2');
    expect(text).toContain('make_interval');
    // Both caps are wired in, and the floor keeps backoff from ever polling a
    // device FASTER than its configured interval.
    expect(params).toContain(MAX_BACKOFF_SHIFT);
    expect(params).toContain(MAX_BACKOFF_SECONDS);
    expect(text).toMatch(/greatest\(\s*"snmp_devices"\."polling_interval",\s*least\(/i);
  });

  it('still enqueues devices that come back due', async () => {
    selectResults = [[{ id: 'dev-1', orgId: 'org-1', pollingInterval: 300, lastPolled: null }]];

    await expect(processScheduler()).resolves.toEqual({ enqueued: 1 });
    expect(addMock).toHaveBeenCalledTimes(1);
  });
});

describe('processPollDevice attempt marking (#3217)', () => {
  it('stamps the attempt and increments failures before loading the device', async () => {
    selectResults = [[]]; // device lookup finds nothing

    await processPollDevice({ type: 'poll-device', deviceId: 'dev-1', orgId: 'org-1' });

    // The stamp must be the FIRST db call — every early return below it would
    // otherwise leave last_poll_attempted_at NULL and re-poll in 60s.
    expect(captured.order[0]).toBe('update');
    expect(captured.updateSets).toHaveLength(1);

    const set = captured.updateSets[0]!;
    expect(set.lastPollAttemptedAt).toBeInstanceOf(Date);
    expect(render(set.consecutiveFailures).sql).toMatch(/"consecutive_failures"\s*\+\s*1/i);
  });

  it('marks the attempt even when no online agent exists to dispatch to', async () => {
    selectResults = [
      [{ id: 'dev-1', orgId: 'org-1', templateId: 'tpl-1', ipAddress: '10.0.0.1', port: 161, snmpVersion: 'v2c' }],
      [{ oids: [{ oid: '1.3.6.1.2.1.1.1.0' }] }],
      [], // no online agent
    ];

    const result = await processPollDevice({ type: 'poll-device', deviceId: 'dev-1', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: false, agentId: null });
    expect(captured.updateSets).toHaveLength(1);
    expect(captured.updateSets[0]!.lastPollAttemptedAt).toBeInstanceOf(Date);
  });

  it('only surfaces the device as offline once it has failed repeatedly', async () => {
    selectResults = [[]];

    await processPollDevice({ type: 'poll-device', deviceId: 'dev-1', orgId: 'org-1' });

    const { sql: text, params } = render(captured.updateSets[0]!.lastStatus);
    expect(text).toMatch(/case when .* then 'offline' else "snmp_devices"\."last_status" end/i);
    expect(params).toContain(FAILURE_STATUS_THRESHOLD);
  });

  it('fails the job loudly when the attempt stamp cannot be written', async () => {
    updateError = new Error('db down');
    selectResults = [[]];

    // Swallowing this would silently restore the every-60s hammering the fix
    // exists to stop, so the error must propagate.
    await expect(
      processPollDevice({ type: 'poll-device', deviceId: 'dev-1', orgId: 'org-1' })
    ).rejects.toThrow('db down');
  });
});

describe('processPollResults failure accounting (#3217)', () => {
  const job = {
    type: 'process-poll-results' as const,
    deviceId: 'dev-1',
    metrics: [{ oid: '1.3.6.1.2.1.1.1.0', name: 'sysDescr', value: 'switch', timestamp: '2026-08-15T00:00:00.000Z' }],
  };

  it('clears the failure count only after metrics are persisted', async () => {
    selectResults = [[{ orgId: 'org-1' }]];

    await expect(processPollResults(job)).resolves.toEqual({ metricsWritten: 1 });

    // Insert must land before the reset, or a persistence failure would still
    // clear the backoff.
    expect(captured.order.indexOf('insert')).toBeLessThan(captured.order.indexOf('update'));
    expect(captured.updateSets[0]!).toMatchObject({ consecutiveFailures: 0, lastStatus: 'online' });
    expect(captured.updateSets[0]!.lastPollAttemptedAt).toBeInstanceOf(Date);
  });

  it('leaves the failure count intact when metric persistence throws', async () => {
    // The production incident behind #3217: the poll dispatched fine and the
    // agent replied, but results could not be written. Nothing must reset the
    // counter, so the device backs off instead of being re-polled every 60s.
    selectResults = [[{ orgId: 'org-1' }]];
    insertError = new Error('insert failed');

    await expect(processPollResults(job)).rejects.toThrow('insert failed');
    expect(captured.updateSets).toHaveLength(0);
  });

  it('leaves the failure count intact when the device row is gone', async () => {
    selectResults = [[]];

    await expect(processPollResults(job)).resolves.toEqual({ metricsWritten: 0 });
    expect(captured.updateSets).toHaveLength(0);
  });
});
