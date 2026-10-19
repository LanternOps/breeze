import { describe, expect, it } from 'vitest';
import type { UnifiResourceV2 } from '@breeze/shared';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v2.json';
import { buildUnifiWifiRows, deriveWifiCapable, deriveWirelessClientCounts, type UnifiWifiRow } from './unifiWifiMaterializer';

const scope = { orgId: 'org-a', siteId: 'site-a' };
const capturedAt = new Date('2026-10-15T12:00:00Z');
const fixtureResources = () => structuredClone(vectors.vectors[0]!.report.resources) as unknown as UnifiResourceV2[];
const build = (resources: UnifiResourceV2[]) => buildUnifiWifiRows({ scope, capturedAt, resources });
const byDevice = (rows: UnifiWifiRow[]) => new Map(rows.map(row => [row.unifiDeviceId, row]));
const resourceOf = (resources: UnifiResourceV2[], kind: string) => resources.find(r => r.kind === kind)!;

describe('deriveWifiCapable', () => {
  it('is true from a positive documented signal, whatever the other set says', () => {
    expect(deriveWifiCapable(['accessPoint'], ['ports', 'radios'])).toBe(true);
    expect(deriveWifiCapable(null, ['radios'])).toBe(true);
    expect(deriveWifiCapable(['accessPoint'], null)).toBe(true);
  });
  it('is false only when both sets are present and carry no AP/radio signal', () => {
    expect(deriveWifiCapable(['switching'], ['ports'])).toBe(false);
    expect(deriveWifiCapable([], [])).toBe(false);
  });
  it('is null when the capability evidence is missing, never guessed', () => {
    expect(deriveWifiCapable(null, null)).toBeNull();
    expect(deriveWifiCapable(['switching'], null)).toBeNull();
    expect(deriveWifiCapable(null, ['ports'])).toBeNull();
  });
});

describe('deriveWirelessClientCounts', () => {
  it('counts only WIRELESS clients, grouped by a non-null uplink device', () => {
    const counts = deriveWirelessClientCounts([
      { clientType: 'WIRELESS', uplinkDeviceId: 'ap-1' }, { clientType: 'WIRELESS', uplinkDeviceId: 'ap-1' },
      { clientType: 'WIRED', uplinkDeviceId: 'ap-1' }, { clientType: 'VPN', uplinkDeviceId: 'ap-1' },
      { clientType: 'TELEPORT', uplinkDeviceId: 'ap-1' }, { clientType: 'unknown', uplinkDeviceId: 'ap-1' },
      { clientType: 'WIRELESS', uplinkDeviceId: null },
    ]);
    expect([...counts]).toEqual([['ap-1', 2]]);
  });
});

describe('buildUnifiWifiRows (real-evidence fixture)', () => {
  it('derives exact per-AP wireless counts, including a measured zero, and never counts a wired client', () => {
    const rows = byDevice(build(fixtureResources()));
    expect(rows.get('ap-u6lr-online')!.numClients).toBe(3); // 3 wireless + 1 wired client on the same uplink
    expect(rows.get('ap-e7-online')!.numClients).toBe(5);
    expect(rows.get('ap-u6lite-online')!.numClients).toBe(1);
    expect(rows.get('ap-u6lite-offline')!.numClients).toBe(0);
    expect(rows.get('ap-u6lite-offline')!.clientsObservedAt).toEqual(capturedAt);
  });

  it('writes no count for a device that is not positively Wi-Fi capable', () => {
    const rows = byDevice(build(fixtureResources()));
    expect(rows.get('sw-1')!.wifiCapable).toBe(false);
    expect(rows.get('sw-1')!.numClients).toBeNull();
    expect(rows.get('sw-1')!.clientsObservedAt).toBeNull();
    expect(rows.get('legacy-1')!.wifiCapable).toBeNull();
    expect(rows.get('legacy-1')!.clientsObservedAt).toBeNull();
  });

  it('a partial client list never produces a count: the previous count and timestamp are left alone', () => {
    const resources = fixtureResources();
    resourceOf(resources, 'client_list').outcome = 'partial';
    const rows = byDevice(build(resources));
    for (const row of rows.values()) {
      expect(row.numClients).toBeNull();
      expect(row.clientsObservedAt).toBeNull();
    }
  });

  it('keeps null (omitted by the controller) distinct from a measured zero', () => {
    const rows = byDevice(build(fixtureResources()));
    const offline = rows.get('ap-u6lite-offline')!;
    expect(offline.cpuPct).toBeNull();
    expect(offline.memPct).toBeNull();
    expect(offline.uptimeSeconds).toBeNull();
    expect(offline.uplinkRxRateBps).toBe(1724576); // positive rate on an OFFLINE AP is carried as reported
    expect(offline.radioStatistics).toEqual([{ frequencyGHz: 2.4, txRetriesPct: null }, { frequencyGHz: 5, txRetriesPct: null }]);
    const sw = rows.get('sw-1')!;
    expect(sw.cpuPct).toBe(0);
    expect(sw.uplinkRxRateBps).toBe(0);
    expect(sw.uplinkTxRateBps).toBe(0);
    expect(rows.get('ap-e7-online')!.uplinkRxRateBps).toBeNull();
    expect(rows.get('ap-u6lr-online')!.radioStatistics).toEqual([{ frequencyGHz: 2.4, txRetriesPct: 26 }, { frequencyGHz: 5, txRetriesPct: 0 }]);
  });

  it('carries the radio overview, the raw controller state and the heartbeat metadata', () => {
    const rows = byDevice(build(fixtureResources()));
    expect(rows.get('ap-e7-online')!.radioOverview).toHaveLength(3);
    expect(rows.get('ap-u6lite-offline')!.radioOverview![0]).toEqual({ frequencyGHz: 2.4, channel: null, channelWidthMHz: 20, wlanStandard: '802.11n' });
    expect(rows.get('legacy-1')!.radioOverview).toEqual([]); // explicit empty list stays empty
    expect(rows.get('sw-1')!.radioOverview).toBeNull();
    expect(rows.get('ap-u6lite-offline')!.controllerState).toBe('OFFLINE'); // raw, never normalized to a boolean here
    expect(rows.get('ap-u6lr-online')!.lastHeartbeatAt).toEqual(new Date('2026-10-15T11:59:50Z'));
    expect(rows.get('ap-e7-online')!.lastHeartbeatAt).toBeNull();
  });

  it('only fills the families that were actually present (omitted rows stay out of the upsert)', () => {
    const resources = fixtureResources();
    const stats = resourceOf(resources, 'statistics');
    stats.rows = (stats.rows as { deviceId: string }[]).filter(row => row.deviceId === 'ap-u6lr-online') as never;
    stats.rowCount = 1;
    stats.outcome = 'partial';
    const rows = byDevice(build(resources));
    expect(rows.get('ap-u6lr-online')!.statisticsObservedAt).toEqual(capturedAt);
    expect(rows.get('ap-e7-online')!.statisticsObservedAt).toBeNull(); // omitted by rotation: SQL keeps value AND timestamp
    expect(rows.get('ap-e7-online')!.cpuPct).toBeNull();
    // ...while the families that were present still refresh.
    expect(rows.get('ap-e7-online')!.detailObservedAt).toEqual(capturedAt);
    expect(rows.get('ap-e7-online')!.inventoryObservedAt).toEqual(capturedAt);
  });

  it('ignores a failed resource instead of clearing anything from it', () => {
    const resources = fixtureResources();
    const detail = resourceOf(resources, 'device_details');
    detail.outcome = 'failed';
    detail.rows = [] as never;
    detail.rowCount = 0;
    const rows = byDevice(build(resources));
    for (const row of rows.values()) expect(row.detailObservedAt).toBeNull();
  });

  it('stamps every row with the already-authorized scope, never with anything from the upload', () => {
    for (const row of build(fixtureResources())) expect({ orgId: row.orgId, siteId: row.siteId }).toEqual(scope);
  });

  it('canonicalizes the MAC used only for a newly created row', () => {
    const rows = byDevice(build(fixtureResources()));
    expect(rows.get('ap-u6lr-online')!.mac).toBe('02:00:00:00:04:01');
    expect(rows.get('ap-u6lr-online')!.name).toBe('AP U6 LR');
  });
});
