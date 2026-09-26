import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb, alertDeviceMock } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  alertDeviceMock: vi.fn(async (_check: { orgId: string; assetId: string | null; monitorId: string }): Promise<string | null> => 'device-1'),
}));

vi.mock('../../../db', () => ({ db: mockDb }));
vi.mock('../../monitors/networkCheckAlertDevice', () => ({
  resolveNetworkCheckAlertDeviceForMonitor: alertDeviceMock,
}));

vi.mock('../../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  networkMonitors: {
    id: 'networkMonitors.id',
    assetId: 'networkMonitors.assetId',
    managedByMonitorId: 'networkMonitors.managedByMonitorId',
  },
  networkMonitorResults: {
    monitorId: 'networkMonitorResults.monitorId',
    orgId: 'networkMonitorResults.orgId',
    status: 'networkMonitorResults.status',
    responseMs: 'networkMonitorResults.responseMs',
    timestamp: 'networkMonitorResults.timestamp',
  },
}));

import { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION, networkCheckHandler } from './networkCheck';

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
  return Array.from({ length: n }, () => ({ status: 'offline', responseMs: null, timestamp: new Date() }));
}

describe('networkCheckHandler (#5291 W04)', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
    alertDeviceMock.mockReset();
    alertDeviceMock.mockResolvedValue('device-1');
  });

  describe('one alert device per check per org (#6353)', () => {
    it('exports the device-independent-evaluation capability W05e gates on', () => {
      expect(NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION).toBe(true);
    });

    it('breaches on the alert device, resolved through the shared legacy rule for the DEVICE org', async () => {
      setReads([{ id: 'nm-1', assetId: 'asset-1' }], offline(2), [{ orgId: 'org-b' }]);

      const result = await networkCheckHandler.evaluate(
        { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
        DEVICE_ID,
      );

      expect(result.passed).toBe(true);
      expect(alertDeviceMock).toHaveBeenCalledWith({ orgId: 'org-b', assetId: 'asset-1', monitorId: MONITOR_ID });
    });

    it('never breaches on any other device the policy reaches, even with an offline streak', async () => {
      alertDeviceMock.mockResolvedValue('device-other');
      setReads([{ id: 'nm-1', assetId: null }], offline(5));

      const result = await networkCheckHandler.evaluate(
        { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
        DEVICE_ID,
      );

      expect(result.passed).toBe(false);
      expect(result.description).toMatch(/not the alert device/i);
      // The results read is not even attempted for a non-alert device.
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });

    it('does not breach when the org has no eligible alert device at all', async () => {
      alertDeviceMock.mockResolvedValue(null);
      setReads([{ id: 'nm-1', assetId: null }], offline(5));

      const result = await networkCheckHandler.evaluate(
        { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2 },
        DEVICE_ID,
      );

      expect(result.passed).toBe(false);
      expect(result.description).toMatch(/not the alert device/i);
    });
  });

  describe('legacy verdicts (W05e)', () => {
    it.each([undefined, false, true])('counts degraded only with degradedIsFailure=%s', async (degradedIsFailure) => {
      setReads([{ id: 'nm-1', assetId: null }], [
        { status: 'degraded', responseMs: 10 },
        { status: 'degraded', responseMs: 10 },
      ]);
      const result = await networkCheckHandler.evaluate(
        { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2, degradedIsFailure },
        DEVICE_ID,
      );
      expect(result.passed).toBe(degradedIsFailure === true);
    });

    it.each([
      [900, 500, true],
      [500, 500, false],
      [499, 500, false],
      [null, 500, false],
      [900, undefined, false],
    ])('evaluates online response %s against threshold %s', async (responseMs, maxResponseMs, passed) => {
      setReads([{ id: 'nm-1', assetId: null }], [{ status: 'online', responseMs }]);
      const result = await networkCheckHandler.evaluate(
        { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 1, maxResponseMs },
        DEVICE_ID,
      );
      expect(result.passed).toBe(passed);
      expect(mockDb.select).toHaveBeenLastCalledWith(expect.objectContaining({
        responseMs: 'networkMonitorResults.responseMs',
      }));
    });

    it('counts mixed failures and stops at the first healthy result', async () => {
      setReads([{ id: 'nm-1', assetId: null }], [
        { status: 'offline', responseMs: null },
        { status: 'degraded', responseMs: 10 },
        { status: 'online', responseMs: 900 },
        { status: 'online', responseMs: 500 },
        { status: 'offline', responseMs: null },
      ]);
      const result = await networkCheckHandler.evaluate(
        { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 5, degradedIsFailure: true, maxResponseMs: 500 },
        DEVICE_ID,
      );
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe(3);
    });

    it('does not breach on a short history of slow results', async () => {
      setReads([{ id: 'nm-1', assetId: null }], [{ status: 'online', responseMs: 900 }]);
      const result = await networkCheckHandler.evaluate(
        { type: 'network_check', monitorId: MONITOR_ID, consecutiveFailures: 2, maxResponseMs: 500 },
        DEVICE_ID,
      );
      expect(result.passed).toBe(false);
      expect(result.actualValue).toBe(1);
    });

    it.each([0, -1, '500', null])('rejects invalid maxResponseMs %s', (maxResponseMs) => {
      expect(networkCheckHandler.validate!({ monitorId: MONITOR_ID, maxResponseMs }, 'c'))
        .toContain('c.maxResponseMs: Must be a positive number');
    });

    it.each(['true', 1, null])('rejects invalid degradedIsFailure %s', (degradedIsFailure) => {
      expect(networkCheckHandler.validate!({ monitorId: MONITOR_ID, degradedIsFailure }, 'c'))
        .toContain('c.degradedIsFailure: Must be a boolean');
    });

    it.each([false, true])('accepts valid verdict options (%s)', (degradedIsFailure) => {
      expect(networkCheckHandler.validate!({ monitorId: MONITOR_ID, maxResponseMs: 1, degradedIsFailure }, 'c')).toEqual([]);
    });
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
