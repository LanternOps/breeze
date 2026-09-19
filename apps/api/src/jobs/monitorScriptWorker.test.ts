import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, dispatchMock, resolveMonitorsMock } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  dispatchMock: vi.fn(),
  resolveMonitorsMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
}));

vi.mock('../db/schema', () => ({
  monitorDefinitions: {
    id: 'monitorDefinitions.id',
    kind: 'monitorDefinitions.kind',
    enabled: 'monitorDefinitions.enabled',
    orgId: 'monitorDefinitions.orgId',
    partnerId: 'monitorDefinitions.partnerId',
    condition: 'monitorDefinitions.condition',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    osType: 'devices.osType',
    status: 'devices.status',
    agentId: 'devices.agentId',
    hostname: 'devices.hostname',
    siteId: 'devices.siteId',
    customFields: 'devices.customFields',
  },
  scriptExecutions: {
    monitorId: 'scriptExecutions.monitorId',
    deviceId: 'scriptExecutions.deviceId',
    createdAt: 'scriptExecutions.createdAt',
  },
  scripts: {
    id: 'scripts.id',
  },
}));

vi.mock('../services/scriptDispatch', () => ({
  dispatchScriptToDevice: dispatchMock,
}));

vi.mock('../services/monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: resolveMonitorsMock,
}));

import { monitorDefinitions, organizations, devices, scriptExecutions, scripts } from '../db/schema';
import { processScriptMonitorTick } from './monitorScriptWorker';

const MONITOR_ID = 'monitor-1';
const DEVICE_ID = 'device-1';
const ORG_ID = 'org-1';
const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-13T12:00:00.000Z');

type TableRef = typeof monitorDefinitions | typeof organizations | typeof devices | typeof scriptExecutions | typeof scripts;

/**
 * Routes `db.select({...}).from(table)...` chains by the TABLE passed to
 * `.from()`, resolving to whatever rows the test registered for that table.
 * Supports both `await ...where(...)` (no orderBy/limit) and
 * `...where().orderBy().limit()` shapes, matching what monitorScriptWorker
 * actually calls per table.
 */
function setupDb(responses: Map<TableRef, unknown[]>) {
  mockDb.select.mockImplementation(() => {
    let rows: unknown[] = [];
    const builder = {
      from(table: TableRef) {
        rows = responses.get(table) ?? [];
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return Promise.resolve(rows);
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  });
}

function makeMonitorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MONITOR_ID,
    orgId: ORG_ID,
    partnerId: null,
    enabled: true,
    condition: {
      scriptId: SCRIPT_ID,
      intervalMinutes: 60,
      timeoutSeconds: 300,
      breachOnNonZeroExit: true,
    },
    ...overrides,
  };
}

function makeDeviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_ID,
    orgId: ORG_ID,
    osType: 'windows',
    status: 'online',
    agentId: 'agent-1',
    hostname: 'device-1.example',
    siteId: 'site-1',
    customFields: {},
    ...overrides,
  };
}

function makeScriptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCRIPT_ID,
    orgId: null,
    version: 1,
    language: 'powershell',
    timeoutSeconds: 300,
    content: 'Write-Output "ok"',
    runAs: 'system',
    ...overrides,
  };
}

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe('processScriptMonitorTick', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
    dispatchMock.mockReset();
    resolveMonitorsMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    dispatchMock.mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      delivered: true,
      deliverBy: null,
      deliveryOutcome: 'sent',
      executedAt: null,
      ignoredParameters: [],
      runAs: 'system',
      targetSessionId: null,
    });

    resolveMonitorsMock.mockResolvedValue({
      kind: 'resolved',
      monitors: [
        {
          monitorId: MONITOR_ID,
          enabled: true,
          overrides: null,
          sourcePolicyId: 'policy-1',
          sourceLevel: 'organization',
          inheritedFromParent: false,
        },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) does not redispatch when the newest execution is younger than the interval', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, [{ createdAt: minutesAgo(10) }]], // 10 min old, interval is 60
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 0, skipped: 1 });
  });

  it('(b) redispatches when the newest execution is older than the interval', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, [{ createdAt: minutesAgo(70) }]], // 70 min old, interval is 60
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 1, skipped: 0 });
  });

  it('(c) does not dispatch when the resolver says this monitor is disabled for the device', async () => {
    resolveMonitorsMock.mockResolvedValue({
      kind: 'resolved',
      monitors: [
        {
          monitorId: MONITOR_ID,
          enabled: false,
          overrides: null,
          sourcePolicyId: 'policy-1',
          sourceLevel: 'device',
          inheritedFromParent: false,
        },
      ],
    });
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        // No execution history needed — disabled short-circuits before the throttle check.
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 0, skipped: 1 });
  });

  it('(c2) does not dispatch when the device raced a delete — resolver returns device_missing, not a fabricated "zero monitors" (#5677)', async () => {
    resolveMonitorsMock.mockResolvedValue({ kind: 'device_missing' });
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []],
        [scripts, [makeScriptRow()]],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ monitorsConsidered: 1, devicesConsidered: 1, dispatched: 0, skipped: 1 });
  });

  it('(d) dispatches with triggerType "monitor" and the monitor definition id', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, [makeMonitorRow()]],
        [devices, [makeDeviceRow()]],
        [scriptExecutions, []], // no prior run at all -> due
        [scripts, [makeScriptRow()]],
      ]),
    );

    await processScriptMonitorTick();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]![0];
    expect(call.triggerType).toBe('monitor');
    expect(call.monitorId).toBe(MONITOR_ID);
    expect(call.device.id).toBe(DEVICE_ID);
    expect(call.timeoutSeconds).toBe(300);
  });

  it('never dispatches when no monitor rows are due for consideration', async () => {
    setupDb(
      new Map<TableRef, unknown[]>([
        [monitorDefinitions, []],
        [devices, []],
        [scriptExecutions, []],
        [scripts, []],
      ]),
    );

    const result = await processScriptMonitorTick();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ monitorsConsidered: 0, devicesConsidered: 0, dispatched: 0, skipped: 0, errors: 0 });
  });
});
