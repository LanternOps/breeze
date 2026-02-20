import { describe, expect, it } from 'vitest';
import type { KnownNetworkDevice } from '../db/schema';
import {
  mergeKnownDevices,
  normalizeBaselineAlertSettings,
  normalizeBaselineScanSchedule
} from './networkBaseline';

describe('networkBaseline helpers', () => {
  it('normalizes scan schedule defaults', () => {
    const schedule = normalizeBaselineScanSchedule(undefined);

    expect(schedule.enabled).toBe(true);
    expect(schedule.intervalHours).toBe(4);
    expect(new Date(schedule.nextScanAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('normalizes alert settings with defaults', () => {
    const settings = normalizeBaselineAlertSettings({
      newDevice: false,
      rogueDevice: true
    });

    expect(settings).toEqual({
      newDevice: false,
      disappeared: true,
      changed: true,
      rogueDevice: true
    });
  });

  it('merges known devices and preserves unseen entries', () => {
    const existing: KnownNetworkDevice[] = [
      {
        ip: '192.168.1.10',
        mac: 'aa:bb:cc:dd:ee:ff',
        hostname: 'printer-1',
        assetType: 'printer',
        manufacturer: 'HP',
        linkedDeviceId: null,
        firstSeen: '2026-02-18T00:00:00.000Z',
        lastSeen: '2026-02-18T00:00:00.000Z'
      },
      {
        ip: '192.168.1.20',
        mac: '00:11:22:33:44:55',
        hostname: 'old-host',
        assetType: 'workstation',
        manufacturer: 'Dell',
        linkedDeviceId: null,
        firstSeen: '2026-02-18T00:00:00.000Z',
        lastSeen: '2026-02-18T00:00:00.000Z'
      }
    ];

    const merged = mergeKnownDevices(existing, [
      {
        ip: '192.168.1.10',
        mac: 'aa:bb:cc:dd:ee:ff',
        hostname: 'printer-1-updated',
        assetType: 'printer',
        methods: ['arp']
      },
      {
        ip: '192.168.1.30',
        mac: '11:22:33:44:55:66',
        hostname: 'new-host',
        assetType: 'workstation',
        methods: ['ping']
      }
    ]);

    expect(merged).toHaveLength(3);

    const updated = merged.find((entry) => entry.ip === '192.168.1.10');
    expect(updated?.hostname).toBe('printer-1-updated');
    expect(updated?.firstSeen).toBe('2026-02-18T00:00:00.000Z');

    const newDevice = merged.find((entry) => entry.ip === '192.168.1.30');
    expect(newDevice?.hostname).toBe('new-host');
    expect(newDevice?.firstSeen).toBeDefined();

    const unseen = merged.find((entry) => entry.ip === '192.168.1.20');
    expect(unseen?.hostname).toBe('old-host');
  });
});
