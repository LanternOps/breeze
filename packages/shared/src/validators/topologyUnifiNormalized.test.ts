import { describe, expect, it } from 'vitest';
import { physicalSourceSectionSchema } from './topologyPhysicalNormalized';
import {
  normalizedUnifiClientRowSchema, normalizedUnifiDeviceDetailRowSchema, normalizedUnifiDeviceRowSchema, normalizedUnifiStatisticsRowSchema, unifiEndpointKey,
} from './topologyUnifiNormalized';

const HOST = '900A6F00301100000000074A6BA9:1234567';
const SITE = '88f7af54-98f8-306a-a1c7-c9349722b1f6';
const INVENTORY = '11111111-1111-4111-8111-111111111111';

describe('normalized UniFi rows (M2 Task 5, D16)', () => {
  it('builds unambiguous controller-scoped endpoint keys even when the host id contains colons', () => {
    const device = unifiEndpointKey({ hostKey: HOST, controllerSiteId: SITE, kind: 'device', value: 'dev-1' });
    expect(device).toBe(`unifi:${encodeURIComponent(HOST)}:${SITE}:device:dev-1`);
    expect(device.split(':')).toHaveLength(5);
    expect(unifiEndpointKey({ hostKey: 'h', controllerSiteId: 'default', kind: 'mac', value: '02:00:00:00:00:01' })).toBe('unifi:h:default:mac:02%3A00%3A00%3A00%3A00%3A01');
    // Same controller site id on two hosts never collides.
    expect(unifiEndpointKey({ hostKey: 'h1', controllerSiteId: 'default', kind: 'device', value: 'd' }))
      .not.toBe(unifiEndpointKey({ hostKey: 'h2', controllerSiteId: 'default', kind: 'device', value: 'd' }));
  });

  it('requires identity material on every retained row while keeping the wire refinements', () => {
    const endpointKey = unifiEndpointKey({ hostKey: 'h', controllerSiteId: SITE, kind: 'device', value: 'dev-1' });
    const device = { rowKey: 'dev-1', deviceId: 'dev-1', mac: '02:00:00:00:00:01', name: null, model: null, ipAddress: null, state: null, endpointKey, inventoryDeviceId: INVENTORY };
    expect(normalizedUnifiDeviceRowSchema.safeParse(device).success).toBe(true);
    expect(normalizedUnifiDeviceRowSchema.safeParse({ ...device, inventoryDeviceId: undefined }).success).toBe(false);
    expect(normalizedUnifiDeviceRowSchema.safeParse({ ...device, rowKey: 'other' }).success).toBe(false);
    expect(normalizedUnifiDeviceRowSchema.safeParse({ ...device, endpointKey: 'lldp-chassis:x' }).success).toBe(false);
    const client = { rowKey: 'c-1', clientId: 'c-1', mac: null, clientType: 'VPN', uplinkDeviceId: null, name: null, ipAddress: null, uplinkPortIndex: null, ssid: null, vlan: null, signalDbm: null,
      endpointKey: unifiEndpointKey({ hostKey: 'h', controllerSiteId: SITE, kind: 'client', value: 'c-1' }), uplinkEndpointKey: null, inventoryDeviceId: null };
    expect(normalizedUnifiClientRowSchema.safeParse(client).success).toBe(true);
    expect(normalizedUnifiClientRowSchema.safeParse({ ...client, uplinkEndpointKey: undefined }).success).toBe(false);
    expect(normalizedUnifiDeviceDetailRowSchema.safeParse({ rowKey: 'dev-1', deviceId: 'dev-1', uplinkDeviceId: null, uplinkPortIndex: null, ports: [], endpointKey, uplinkEndpointKey: null }).success).toBe(true);
    expect(normalizedUnifiStatisticsRowSchema.safeParse({ rowKey: 'dev-1', deviceId: 'dev-1', uptimeSeconds: null, cpuUtilizationPct: null, memoryUtilizationPct: null, endpointKey }).success).toBe(true);
  });

  it('only admits normalized rows into retained unifi sections', () => {
    const wireOnly = { rowKey: 'dev-1', deviceId: 'dev-1', mac: null, name: null, model: null, ipAddress: null, state: null };
    const section = { kind: 'unifi_device_list', contextKey: 'c1:s', contentDigest: 'a'.repeat(64), outcome: 'complete', rowCount: 1, rows: [wireOnly] };
    expect(physicalSourceSectionSchema.safeParse(section).success).toBe(false);
    const normalized = { ...wireOnly, endpointKey: unifiEndpointKey({ hostKey: 'h', controllerSiteId: 's', kind: 'device', value: 'dev-1' }), inventoryDeviceId: null };
    expect(physicalSourceSectionSchema.safeParse({ ...section, rows: [normalized] }).success).toBe(true);
  });
});
