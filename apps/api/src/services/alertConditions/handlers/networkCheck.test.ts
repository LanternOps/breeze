import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));

vi.mock('../../../db', () => ({ db: mockDb }));

vi.mock('../../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  networkMonitors: {
    id: 'networkMonitors.id',
    managedByMonitorId: 'networkMonitors.managedByMonitorId',
  },
  networkMonitorResults: {
    monitorId: 'networkMonitorResults.monitorId',
    orgId: 'networkMonitorResults.orgId',
    status: 'networkMonitorResults.status',
    timestamp: 'networkMonitorResults.timestamp',
  },
}));

import { networkCheckHandler } from './networkCheck';

const DEVICE_ID = 'device-1';
const MONITOR_ID = 'monitor-1';

/**
 * Three reads in order: the managed `network_monitors` row (by
 * managed_by_monitor_id), the evaluated DEVICE (for its org), then the newest N
 * results narrowed to that org.
 *
 * `resultsWhere` captures the predicate the results read is actually built
 * with, so the org narrowing can be asserted rather than assumed — the sweep
 * runs under system scope, where RLS narrows nothing.
 */
let resultsWhereArgs: unknown;

function setReads(
  managed: Array<Record<string, unknown>>,
  results: Array<Record<string, unknown>>,
  device: Array<Record<string, unknown>> = [{ orgId: 'org-a' }],
) {
  resultsWhereArgs = undefined;
  mockDb.select
    .mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(managed) }) }),
    } as never)
    .mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(device) }) }),
    } as never)
    .mockReturnValueOnce({
      from: () => ({
        where: (...args: unknown[]) => {
          resultsWhereArgs = args;
          return { orderBy: () => ({ limit: () => Promise.resolve(results) }) };
        },
      }),
    } as never);
}

function offline(n: number) {
  return Array.from({ length: n }, () => ({ status: 'offline', timestamp: new Date() }));
}

describe('networkCheckHandler (#5291 W04)', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
  });

  it('breaches once the leading results are offline at least consecutiveFailures times', async () => {
    setReads([{ id: 'nm-1' }], offline(2));

    const result = await networkCheckHandler.evaluate(
      { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
      DEVICE_ID,
    );

    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(2);
  });

  it('does NOT breach when a recovery result sits in front of the failures', async () => {
    // Newest-first: online, then two offline. The streak is broken, so the
    // check has recovered even though two failures exist in the window.
    setReads([{ id: 'nm-1' }], [
      { status: 'online', timestamp: new Date() },
      ...offline(2),
    ]);

    const result = await networkCheckHandler.evaluate(
      { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
      DEVICE_ID,
    );

    expect(result.passed).toBe(false);
    expect(result.actualValue).toBe(0);
  });

  it('does NOT breach on a SHORT history: one offline result under a threshold of three', async () => {
    // A check that has only run once has not yet failed three times. Treating a
    // short history as a breach would page on every newly created monitor.
    setReads([{ id: 'nm-1' }], offline(1));

    const result = await networkCheckHandler.evaluate(
      { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 3 },
      DEVICE_ID,
    );

    expect(result.passed).toBe(false);
  });

  it('does not breach when the managed row has produced no results yet', async () => {
    setReads([{ id: 'nm-1' }], []);

    const result = await networkCheckHandler.evaluate(
      { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
      DEVICE_ID,
    );

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/no network check results/i);
  });

  it('does not breach when the compiler has not provisioned the managed row', async () => {
    // Absence of evidence is not a breach — and the second read must not even
    // be attempted, since there is no monitor id to scope it to.
    setReads([], []);

    const result = await networkCheckHandler.evaluate(
      { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
      DEVICE_ID,
    );

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/not provisioned/i);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('defaults consecutiveFailures to 2 when the condition omits it', async () => {
    setReads([{ id: 'nm-1' }], offline(1));
    expect(
      (await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID }, DEVICE_ID)).passed,
    ).toBe(false);

    setReads([{ id: 'nm-1' }], offline(2));
    expect(
      (await networkCheckHandler.evaluate({ type: 'network_check', monitorId: MONITOR_ID }, DEVICE_ID)).passed,
    ).toBe(true);
  });

  it('validate rejects a missing monitorId and a non-positive threshold', () => {
    expect(networkCheckHandler.validate!({ consecutiveFailures: 2 }, 'c')).not.toEqual([]);
    expect(networkCheckHandler.validate!({ monitorId: MONITOR_ID, consecutiveFailures: 0 }, 'c')).not.toEqual([]);
    expect(networkCheckHandler.validate!({ monitorId: MONITOR_ID, consecutiveFailures: 2 }, 'c')).toEqual([]);
  });

  it('NARROWS the results read to the evaluated device\'s own org, not just the managed monitor', async () => {
    // The alert sweep runs this handler under system scope (jobs/alertWorker.ts),
    // where breeze_current_scope() = 'system' short-circuits
    // network_monitor_results_isolation to always-true. A partner-wide check
    // writes results for EVERY org under the partner against the SAME managed
    // row, so without an explicit org predicate the streak would be a blended
    // cross-tenant timeline.
    setReads([{ id: 'nm-1' }], offline(2), [{ orgId: 'org-b' }]);

    await networkCheckHandler.evaluate(
      { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
      DEVICE_ID,
    );

    const predicate = JSON.stringify(resultsWhereArgs);
    expect(predicate).toContain('networkMonitorResults.orgId');
    expect(predicate).toContain('org-b');
  });

  it('does not breach when the evaluated device cannot be read — a miss is a deny, not an all-clear', async () => {
    setReads([{ id: 'nm-1' }], offline(5), []);

    const result = await networkCheckHandler.evaluate(
      { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
      DEVICE_ID,
    );

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/device not found/i);
  });
});
