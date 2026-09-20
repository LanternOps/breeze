import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #6353 — the device-independent network_check sweep: one evaluation per
 * managed check per org, on the resolved alert device (online or not), with
 * partner-wide fan-out by the org's partner and stale-episode detach when the
 * alert device moves.
 */
const {
  selectResults,
  selectMock,
  resolveAlertDeviceMock,
  evaluateForDeviceMock,
  detachMock,
  captureExceptionMock,
} = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const next = () => selectResults.shift() ?? [];
  const chain = () => {
    let resolved: unknown[] | undefined;
    const once = () => {
      if (resolved === undefined) resolved = next();
      return resolved;
    };
    return {
      limit: () => Promise.resolve(once()),
      then: (ok: (v: unknown[]) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(once()).then(ok, ko),
    };
  };
  return {
    selectResults,
    selectMock: vi.fn(() => ({ from: () => ({ where: () => chain() }) })),
    resolveAlertDeviceMock: vi.fn(),
    evaluateForDeviceMock: vi.fn(),
    detachMock: vi.fn(),
    captureExceptionMock: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
    { join: (...args: unknown[]) => ({ op: 'sqlJoin', args }), raw: (s: string) => ({ op: 'raw', s }) },
  ),
}));

vi.mock('../../db', () => ({ db: { select: selectMock } }));
vi.mock('../../db/schema', () => ({
  networkMonitors: {
    id: 'network_monitors.id',
    orgId: 'network_monitors.orgId',
    partnerId: 'network_monitors.partnerId',
    assetId: 'network_monitors.assetId',
    isActive: 'network_monitors.isActive',
    managedByMonitorId: 'network_monitors.managedByMonitorId',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    status: 'organizations.status',
    type: 'organizations.type',
  },
  monitorDeviceState: {
    monitorId: 'monitor_device_state.monitorId',
    deviceId: 'monitor_device_state.deviceId',
    orgId: 'monitor_device_state.orgId',
    currentEpisodeId: 'monitor_device_state.currentEpisodeId',
  },
}));
vi.mock('../alertService', () => ({ evaluateNetworkCheckAlertsForDevice: evaluateForDeviceMock }));
vi.mock('./episodeService', () => ({ detachMonitorFromDevice: detachMock }));
vi.mock('./networkCheckAlertDevice', () => ({ resolveNetworkCheckAlertDeviceForMonitor: resolveAlertDeviceMock }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import { evaluateNetworkCheckAlertsForOrg, selectNetworkCheckOrgIds } from './networkCheckAlertSweep';

const ORG = 'org-a';
const PARTNER = 'partner-1';

beforeEach(() => {
  selectResults.length = 0;
  vi.clearAllMocks();
  evaluateForDeviceMock.mockResolvedValue([]);
  detachMock.mockResolvedValue(undefined);
});

describe('selectNetworkCheckOrgIds (#6353)', () => {
  it('returns nothing when no managed check is active — and does not even read organizations', async () => {
    selectResults.push([]);
    expect(await selectNetworkCheckOrgIds()).toEqual([]);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('fans a partner-wide check out to every org under its partner, plus each org-owned check\'s own org', async () => {
    selectResults.push([
      { orgId: ORG, partnerId: null },
      { orgId: null, partnerId: PARTNER },
    ]);
    selectResults.push([{ id: ORG }, { id: 'org-b' }, { id: 'org-c' }]);

    const orgIds = await selectNetworkCheckOrgIds();

    expect(orgIds).toEqual([ORG, 'org-b', 'org-c']);
  });
});

describe('evaluateNetworkCheckAlertsForOrg (#6353)', () => {
  function pushOrgAndChecks(checks: Array<{ id: string; assetId: string | null; monitorId: string }>, org: Record<string, unknown> = {}) {
    selectResults.push([{ id: ORG, partnerId: PARTNER, status: 'active', type: 'customer', ...org }]);
    selectResults.push(checks);
  }

  it('N online devices + one failing check → exactly ONE evaluation, on the resolver\'s device', async () => {
    pushOrgAndChecks([{ id: 'nm-1', assetId: null, monitorId: 'mon-1' }]);
    selectResults.push([]); // stale-episode scan
    // The resolver picks device-b; device-a and device-c are online too but
    // are never evaluated for this check.
    resolveAlertDeviceMock.mockResolvedValue('device-b');
    evaluateForDeviceMock.mockResolvedValue(['alert-1']);

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    expect(resolveAlertDeviceMock).toHaveBeenCalledWith({ orgId: ORG, assetId: null, monitorId: 'mon-1' });
    expect(evaluateForDeviceMock).toHaveBeenCalledTimes(1);
    expect(evaluateForDeviceMock).toHaveBeenCalledWith('device-b', new Set(['mon-1']));
    expect(result.alertIds).toEqual(['alert-1']);
    expect(result.devicesEvaluated).toBe(1);
  });

  it('evaluates the alert device whether or not it is online — the resolver never looks at status and neither does the sweep', async () => {
    pushOrgAndChecks([{ id: 'nm-1', assetId: null, monitorId: 'mon-1' }]);
    selectResults.push([]);
    resolveAlertDeviceMock.mockResolvedValue('device-offline');
    evaluateForDeviceMock.mockResolvedValue(['alert-1']);

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    expect(evaluateForDeviceMock).toHaveBeenCalledWith('device-offline', new Set(['mon-1']));
    expect(result.alertIds).toEqual(['alert-1']);
    // No devices read at all in the sweep itself: org, checks, stale scan.
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it('groups checks that share an alert device into one evaluation pass', async () => {
    pushOrgAndChecks([
      { id: 'nm-1', assetId: null, monitorId: 'mon-1' },
      { id: 'nm-2', assetId: null, monitorId: 'mon-2' },
      { id: 'nm-3', assetId: 'asset-3', monitorId: 'mon-3' },
    ]);
    selectResults.push([]);
    resolveAlertDeviceMock.mockImplementation(async ({ assetId }: { assetId: string | null }) =>
      assetId ? 'device-linked' : 'device-b');

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    expect(evaluateForDeviceMock).toHaveBeenCalledTimes(2);
    expect(evaluateForDeviceMock).toHaveBeenCalledWith('device-b', new Set(['mon-1', 'mon-2']));
    expect(evaluateForDeviceMock).toHaveBeenCalledWith('device-linked', new Set(['mon-3']));
    expect(result.checks).toBe(3);
    expect(result.devicesEvaluated).toBe(2);
  });

  it('reads the org\'s checks with a partner-wide branch, never eq(orgId) alone', async () => {
    let checksWhere: unknown;
    selectMock
      .mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: ORG, partnerId: PARTNER, status: 'active', type: 'customer' }]) }) }) }) as never)
      .mockImplementationOnce(() => ({ from: () => ({ where: (w: unknown) => { checksWhere = w; return Promise.resolve([]); } }) }) as never);

    await evaluateNetworkCheckAlertsForOrg(ORG);

    const predicate = JSON.stringify(checksWhere);
    expect(predicate).toContain('network_monitors.orgId');
    expect(predicate).toContain('IS NULL AND');
    expect(predicate).toContain(PARTNER);
  });

  it('skips a quick-support or inactive org and a missing org (a miss is a deny)', async () => {
    selectResults.push([{ id: ORG, partnerId: PARTNER, status: 'active', type: 'quick_support' }]);
    expect((await evaluateNetworkCheckAlertsForOrg(ORG)).checks).toBe(0);

    selectResults.push([{ id: ORG, partnerId: PARTNER, status: 'suspended', type: 'customer' }]);
    expect((await evaluateNetworkCheckAlertsForOrg(ORG)).checks).toBe(0);

    selectResults.push([]);
    expect((await evaluateNetworkCheckAlertsForOrg(ORG)).checks).toBe(0);

    expect(evaluateForDeviceMock).not.toHaveBeenCalled();
  });

  it('counts a check with no eligible device instead of evaluating anything for it', async () => {
    pushOrgAndChecks([{ id: 'nm-1', assetId: null, monitorId: 'mon-1' }]);
    resolveAlertDeviceMock.mockResolvedValue(null);

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    expect(result.checksWithoutDevice).toBe(1);
    expect(evaluateForDeviceMock).not.toHaveBeenCalled();
    // Nothing to detach against either: no monitor got an alert device.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('detaches the stale open episode on a device that is no longer the alert device, and keeps the current one', async () => {
    pushOrgAndChecks([{ id: 'nm-1', assetId: null, monitorId: 'mon-1' }]);
    selectResults.push([
      { monitorId: 'mon-1', deviceId: 'device-old' },
      { monitorId: 'mon-1', deviceId: 'device-new' },
    ]);
    resolveAlertDeviceMock.mockResolvedValue('device-new');

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    expect(detachMock).toHaveBeenCalledTimes(1);
    expect(detachMock).toHaveBeenCalledWith('mon-1', 'device-old');
    expect(result.staleEpisodesDetached).toBe(1);
  });

  it('one check\'s resolution failure does not cost the org\'s other checks their evaluation', async () => {
    pushOrgAndChecks([
      { id: 'nm-1', assetId: null, monitorId: 'mon-1' },
      { id: 'nm-2', assetId: null, monitorId: 'mon-2' },
    ]);
    selectResults.push([]);
    resolveAlertDeviceMock
      .mockRejectedValueOnce(new Error('resolver boom'))
      .mockResolvedValueOnce('device-b');
    evaluateForDeviceMock.mockResolvedValue(['alert-2']);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    expect(result.checksFailed).toBe(1);
    expect(evaluateForDeviceMock).toHaveBeenCalledWith('device-b', new Set(['mon-2']));
    expect(result.alertIds).toEqual(['alert-2']);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ issue: 'network_check_sweep_resolve_failed', monitorId: 'mon-1' }),
    );
  });

  it('does NOT detach the old device\'s episode for a monitor whose new alert device failed to evaluate', async () => {
    pushOrgAndChecks([
      { id: 'nm-1', assetId: null, monitorId: 'mon-1' },
      { id: 'nm-3', assetId: 'asset-3', monitorId: 'mon-3' },
    ]);
    // Stale-episode scan: both monitors hold an open episode on an OLD device.
    selectResults.push([
      { monitorId: 'mon-1', deviceId: 'device-old' },
      { monitorId: 'mon-3', deviceId: 'device-old' },
    ]);
    resolveAlertDeviceMock.mockImplementation(async ({ assetId }: { assetId: string | null }) =>
      assetId ? 'device-linked' : 'device-b');
    evaluateForDeviceMock.mockImplementation(async (deviceId: string) => {
      if (deviceId === 'device-b') throw new Error('boom');
      return [];
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    // mon-3 was evaluated on device-linked → its stale episode on device-old
    // is closed; mon-1's evaluation threw → its episode is left alone, or
    // "not evaluated" would read as "resolved".
    expect(detachMock).toHaveBeenCalledTimes(1);
    expect(detachMock).toHaveBeenCalledWith('mon-3', 'device-old');
    expect(result.devicesFailed).toBe(1);
    expect(result.staleEpisodesDetached).toBe(1);
  });

  it('one device\'s failure does not cost the org\'s other checks their evaluation', async () => {
    pushOrgAndChecks([
      { id: 'nm-1', assetId: null, monitorId: 'mon-1' },
      { id: 'nm-3', assetId: 'asset-3', monitorId: 'mon-3' },
    ]);
    selectResults.push([]);
    resolveAlertDeviceMock.mockImplementation(async ({ assetId }: { assetId: string | null }) =>
      assetId ? 'device-linked' : 'device-b');
    evaluateForDeviceMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(['alert-3']);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await evaluateNetworkCheckAlertsForOrg(ORG);

    expect(result.alertIds).toEqual(['alert-3']);
    expect(result.devicesEvaluated).toBe(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ issue: 'network_check_sweep_device_failed', deviceId: 'device-b' }),
    );
  });
});
