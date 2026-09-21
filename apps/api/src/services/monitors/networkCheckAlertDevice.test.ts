import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #6353 — the shared alert-device rule (lifted from jobs/monitorWorker.ts) and
 * its monitor-aware wrapper that constrains the pick to devices the monitor's
 * configuration-policy attachment actually reaches.
 */
const { selectResults, selectMock, resolveMonitorsMock } = vi.hoisted(() => {
  const selectResults: Array<{ rows: unknown[]; where?: (w: unknown) => void }> = [];
  const next = () => selectResults.shift() ?? { rows: [] };
  return {
    selectResults,
    selectMock: vi.fn(() => {
      const step = next();
      const done = (w?: unknown) => {
        step.where?.(w);
        return {
          limit: () => Promise.resolve(step.rows),
          orderBy: () => ({ limit: () => Promise.resolve(step.rows) }),
        };
      };
      return { from: () => ({ where: (w: unknown) => done(w) }) };
    }),
    resolveMonitorsMock: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));
vi.mock('../../db', () => ({ db: { select: selectMock } }));
vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    isEphemeral: 'devices.isEphemeral',
    lastSeenAt: 'devices.lastSeenAt',
    enrolledAt: 'devices.enrolledAt',
  },
  discoveredAssets: {
    id: 'discovered_assets.id',
    orgId: 'discovered_assets.orgId',
    linkedDeviceId: 'discovered_assets.linkedDeviceId',
    siteId: 'discovered_assets.siteId',
  },
}));
vi.mock('./monitorResolver', () => ({ resolveMonitorsForDevice: resolveMonitorsMock }));

import {
  NETWORK_CHECK_ALERT_DEVICE_FALLBACK_SCAN,
  resolveNetworkCheckAlertDevice,
  resolveNetworkCheckAlertDeviceForMonitor,
} from './networkCheckAlertDevice';

const ORG = 'org-a';
const MON = 'mon-1';

const resolved = (...enabled: string[]) => ({
  kind: 'resolved' as const,
  monitors: enabled.map((monitorId) => ({ monitorId, enabled: true, overrides: null, sourcePolicyId: 'p', sourceLevel: 'organization', inheritedFromParent: false })),
});

beforeEach(() => {
  selectResults.length = 0;
  vi.clearAllMocks();
});

describe('resolveNetworkCheckAlertDevice — the legacy rule', () => {
  it('returns the asset\'s linked device when it has one, without reading devices at all', async () => {
    let assetWhere: unknown;
    selectResults.push({ rows: [{ linkedDeviceId: 'device-linked', siteId: 'site-1' }], where: (w) => { assetWhere = w; } });

    expect(await resolveNetworkCheckAlertDevice({ orgId: ORG, assetId: 'asset-1' })).toBe('device-linked');
    expect(selectMock).toHaveBeenCalledTimes(1);
    // The asset read is scoped to the RUNNING org, not just the asset id.
    expect(JSON.stringify(assetWhere)).toContain(ORG);
  });

  it('falls back to the most recently seen device in the asset\'s site when the asset is unlinked', async () => {
    let siteWhere: unknown;
    selectResults.push({ rows: [{ linkedDeviceId: null, siteId: 'site-1' }] });
    selectResults.push({ rows: [{ id: 'device-site' }], where: (w) => { siteWhere = w; } });

    expect(await resolveNetworkCheckAlertDevice({ orgId: ORG, assetId: 'asset-1' })).toBe('device-site');
    const predicate = JSON.stringify(siteWhere);
    expect(predicate).toContain('site-1');
    expect(predicate).toContain('devices.isEphemeral');
  });

  it('falls through to the org when the preferred site has no device', async () => {
    selectResults.push({ rows: [{ linkedDeviceId: null, siteId: 'site-1' }] });
    selectResults.push({ rows: [] }); // site devices
    selectResults.push({ rows: [{ id: 'device-org' }] });

    expect(await resolveNetworkCheckAlertDevice({ orgId: ORG, assetId: 'asset-1' })).toBe('device-org');
  });

  it('with no asset, picks the most recently seen non-ephemeral device in the org — online or not', async () => {
    let orgWhere: unknown;
    selectResults.push({ rows: [{ id: 'device-org' }], where: (w) => { orgWhere = w; } });

    expect(await resolveNetworkCheckAlertDevice({ orgId: ORG, assetId: null })).toBe('device-org');
    expect(selectMock).toHaveBeenCalledTimes(1);
    const predicate = JSON.stringify(orgWhere);
    expect(predicate).toContain('devices.isEphemeral');
    expect(predicate).not.toContain('devices.status');
  });

  it('returns null when the org has no device', async () => {
    selectResults.push({ rows: [] });
    expect(await resolveNetworkCheckAlertDevice({ orgId: ORG, assetId: null })).toBeNull();
  });
});

describe('resolveNetworkCheckAlertDeviceForMonitor — constrained to the attachment scope', () => {
  it('keeps the legacy pick when the monitor resolves (enabled) for it — one resolution, no scan', async () => {
    selectResults.push({ rows: [{ id: 'device-org' }] });
    resolveMonitorsMock.mockResolvedValue(resolved(MON, 'other'));

    expect(await resolveNetworkCheckAlertDeviceForMonitor({ orgId: ORG, assetId: null, monitorId: MON })).toBe('device-org');
    expect(resolveMonitorsMock).toHaveBeenCalledTimes(1);
    expect(resolveMonitorsMock).toHaveBeenCalledWith('device-org');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the most recent device the monitor DOES resolve for when the legacy pick is outside the scope', async () => {
    selectResults.push({ rows: [{ id: 'device-ws' }] }); // legacy: most recent org device (a workstation)
    selectResults.push({ rows: [{ id: 'device-ws' }, { id: 'device-other' }, { id: 'device-srv' }] }); // fallback scan
    resolveMonitorsMock.mockImplementation(async (deviceId: string) =>
      deviceId === 'device-srv' ? resolved(MON) : resolved('other'));

    expect(await resolveNetworkCheckAlertDeviceForMonitor({ orgId: ORG, assetId: null, monitorId: MON })).toBe('device-srv');
    // The legacy pick is not re-resolved during the scan.
    expect(resolveMonitorsMock.mock.calls.map((c) => c[0])).toEqual(['device-ws', 'device-other', 'device-srv']);
  });

  it('a DISABLED winner does not count as in scope', async () => {
    selectResults.push({ rows: [{ id: 'device-a' }] });
    selectResults.push({ rows: [{ id: 'device-a' }, { id: 'device-b' }] });
    resolveMonitorsMock.mockImplementation(async (deviceId: string) =>
      deviceId === 'device-a'
        ? { kind: 'resolved', monitors: [{ monitorId: MON, enabled: false, overrides: null, sourcePolicyId: 'p', sourceLevel: 'site', inheritedFromParent: false }] }
        : resolved(MON));

    expect(await resolveNetworkCheckAlertDeviceForMonitor({ orgId: ORG, assetId: null, monitorId: MON })).toBe('device-b');
  });

  it('returns null when no device in the scan resolves the monitor, and when there is no legacy pick', async () => {
    selectResults.push({ rows: [{ id: 'device-a' }] });
    selectResults.push({ rows: [{ id: 'device-a' }, { id: 'device-b' }] });
    resolveMonitorsMock.mockResolvedValue(resolved('other'));
    expect(await resolveNetworkCheckAlertDeviceForMonitor({ orgId: ORG, assetId: null, monitorId: MON })).toBeNull();

    resolveMonitorsMock.mockClear();
    selectResults.push({ rows: [] });
    expect(await resolveNetworkCheckAlertDeviceForMonitor({ orgId: ORG, assetId: null, monitorId: MON })).toBeNull();
    expect(resolveMonitorsMock).not.toHaveBeenCalled();
  });

  it('bounds the fallback scan', () => {
    expect(NETWORK_CHECK_ALERT_DEVICE_FALLBACK_SCAN).toBeGreaterThan(0);
    expect(NETWORK_CHECK_ALERT_DEVICE_FALLBACK_SCAN).toBeLessThanOrEqual(500);
  });
});
