import { describe, expect, it } from 'vitest';
import type { KnownNetworkDevice } from '../db/schema';
import type { DiscoveredHostResult } from '../jobs/discoveryWorker';
import {
  buildEventFingerprint,
  hasHostChanged,
  isRogueDeviceByPolicy,
  mergeKnownDevices,
  normalizeAssetType,
  normalizeBaselineAlertSettings,
  normalizeBaselineScanSchedule,
  parseKnownDevices,
  renderTemplate,
  type OrgNetworkPolicy
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

describe('hasHostChanged', () => {
  const baseExisting: KnownNetworkDevice = {
    ip: '10.0.0.1',
    mac: 'aa:bb:cc:dd:ee:ff',
    hostname: 'printer-1',
    assetType: 'workstation',
    manufacturer: 'Dell',
    linkedDeviceId: null,
    firstSeen: '2026-02-18T00:00:00.000Z',
    lastSeen: '2026-02-18T00:00:00.000Z'
  };

  const baseCurrent: DiscoveredHostResult & { linkedDeviceId?: string | null } = {
    ip: '10.0.0.1',
    mac: 'aa:bb:cc:dd:ee:ff',
    hostname: 'printer-1',
    assetType: 'workstation',
    manufacturer: 'Dell',
    methods: ['arp']
  };

  it('detects MAC changed', () => {
    const result = hasHostChanged(baseExisting, {
      ...baseCurrent,
      mac: 'ff:ee:dd:cc:bb:aa'
    });
    expect(result).toBe(true);
  });

  it('detects hostname changed', () => {
    const result = hasHostChanged(baseExisting, {
      ...baseCurrent,
      hostname: 'printer-2'
    });
    expect(result).toBe(true);
  });

  it('detects assetType changed', () => {
    const result = hasHostChanged(baseExisting, {
      ...baseCurrent,
      assetType: 'server'
    });
    expect(result).toBe(true);
  });

  it('returns false when all fields are identical', () => {
    const result = hasHostChanged(baseExisting, baseCurrent);
    expect(result).toBe(false);
  });

  it('returns false when MAC is null on both sides', () => {
    const existing: KnownNetworkDevice = { ...baseExisting, mac: null };
    const current = { ...baseCurrent, mac: undefined };
    const result = hasHostChanged(existing, current);
    expect(result).toBe(false);
  });

  it('detects MAC added (null -> value)', () => {
    const existing: KnownNetworkDevice = { ...baseExisting, mac: null };
    const current = { ...baseCurrent, mac: 'aa:bb:cc:dd:ee:ff' };
    const result = hasHostChanged(existing, current);
    expect(result).toBe(true);
  });

  it('detects hostname removed (value -> null)', () => {
    const current = { ...baseCurrent, hostname: undefined };
    const result = hasHostChanged(baseExisting, current);
    expect(result).toBe(true);
  });
});

describe('isRogueDeviceByPolicy', () => {
  const baseHost: DiscoveredHostResult = {
    ip: '10.0.0.50',
    mac: 'aa:bb:cc:dd:ee:ff',
    hostname: 'rogue-device',
    assetType: 'workstation',
    manufacturer: 'ShadyCorp',
    methods: ['arp']
  };

  it('flags device with blocked manufacturer (case insensitive)', () => {
    const policy: OrgNetworkPolicy = {
      blockedManufacturers: ['shadycorp'],
      allowedAssetTypes: []
    };
    expect(isRogueDeviceByPolicy(baseHost, policy)).toBe(true);
  });

  it('flags device with blocked manufacturer using mixed case', () => {
    const host: DiscoveredHostResult = { ...baseHost, manufacturer: 'SHADYCORP' };
    const policy: OrgNetworkPolicy = {
      blockedManufacturers: ['shadycorp'],
      allowedAssetTypes: []
    };
    expect(isRogueDeviceByPolicy(host, policy)).toBe(true);
  });

  it('allows device when asset type is in allowed list', () => {
    const policy: OrgNetworkPolicy = {
      blockedManufacturers: [],
      allowedAssetTypes: ['workstation', 'server']
    };
    expect(isRogueDeviceByPolicy(baseHost, policy)).toBe(false);
  });

  it('flags device when asset type is NOT in allowed list', () => {
    const host: DiscoveredHostResult = { ...baseHost, assetType: 'iot' };
    const policy: OrgNetworkPolicy = {
      blockedManufacturers: [],
      allowedAssetTypes: ['workstation', 'server']
    };
    expect(isRogueDeviceByPolicy(host, policy)).toBe(true);
  });

  it('returns false when both lists are empty (no policy restrictions)', () => {
    const policy: OrgNetworkPolicy = {
      blockedManufacturers: [],
      allowedAssetTypes: []
    };
    expect(isRogueDeviceByPolicy(baseHost, policy)).toBe(false);
  });

  it('handles manufacturer with leading/trailing whitespace', () => {
    const host: DiscoveredHostResult = { ...baseHost, manufacturer: '  ShadyCorp  ' };
    const policy: OrgNetworkPolicy = {
      blockedManufacturers: ['shadycorp'],
      allowedAssetTypes: []
    };
    expect(isRogueDeviceByPolicy(host, policy)).toBe(true);
  });
});

describe('normalizeAssetType', () => {
  it('maps port_scan to unknown', () => {
    expect(normalizeAssetType('port_scan')).toBe('unknown');
  });

  it('maps windows to workstation', () => {
    expect(normalizeAssetType('windows')).toBe('workstation');
  });

  it('maps linux to workstation', () => {
    expect(normalizeAssetType('linux')).toBe('workstation');
  });

  it('handles case insensitive input for valid enum values', () => {
    expect(normalizeAssetType('Server')).toBe('server');
  });

  it('returns unknown for null', () => {
    expect(normalizeAssetType(null)).toBe('unknown');
  });

  it('returns unknown for undefined', () => {
    expect(normalizeAssetType(undefined)).toBe('unknown');
  });

  it('returns unknown for empty string', () => {
    expect(normalizeAssetType('')).toBe('unknown');
  });

  it('maps macos to workstation', () => {
    expect(normalizeAssetType('macos')).toBe('workstation');
  });

  it('passes through valid enum values like printer', () => {
    expect(normalizeAssetType('printer')).toBe('printer');
  });

  it('returns unknown for unrecognized strings', () => {
    expect(normalizeAssetType('toaster')).toBe('unknown');
  });
});

describe('buildEventFingerprint', () => {
  it('produces identical fingerprint for same inputs', () => {
    const fp1 = buildEventFingerprint('new_device', '10.0.0.1', {
      macAddress: 'aa:bb:cc:dd:ee:ff',
      hostname: 'host-1',
      assetType: 'workstation'
    });
    const fp2 = buildEventFingerprint('new_device', '10.0.0.1', {
      macAddress: 'aa:bb:cc:dd:ee:ff',
      hostname: 'host-1',
      assetType: 'workstation'
    });
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprints for different event types', () => {
    const fp1 = buildEventFingerprint('new_device', '10.0.0.1', {
      macAddress: 'aa:bb:cc:dd:ee:ff'
    });
    const fp2 = buildEventFingerprint('device_changed', '10.0.0.1', {
      macAddress: 'aa:bb:cc:dd:ee:ff'
    });
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprints for different IPs', () => {
    const fp1 = buildEventFingerprint('new_device', '10.0.0.1', {
      macAddress: 'aa:bb:cc:dd:ee:ff'
    });
    const fp2 = buildEventFingerprint('new_device', '10.0.0.2', {
      macAddress: 'aa:bb:cc:dd:ee:ff'
    });
    expect(fp1).not.toBe(fp2);
  });

  it('normalizes MAC case so different case produces same fingerprint', () => {
    const fp1 = buildEventFingerprint('new_device', '10.0.0.1', {
      macAddress: 'AA:BB:CC:DD:EE:FF'
    });
    const fp2 = buildEventFingerprint('new_device', '10.0.0.1', {
      macAddress: 'aa:bb:cc:dd:ee:ff'
    });
    expect(fp1).toBe(fp2);
  });

  it('handles missing options gracefully', () => {
    const fp = buildEventFingerprint('new_device', '10.0.0.1');
    expect(typeof fp).toBe('string');
    expect(fp.length).toBeGreaterThan(0);
  });
});

describe('renderTemplate', () => {
  it('performs simple variable substitution', () => {
    const result = renderTemplate('Device at {{ipAddress}} detected', {
      ipAddress: '10.0.0.1'
    });
    expect(result).toBe('Device at 10.0.0.1 detected');
  });

  it('resolves nested path variables', () => {
    const result = renderTemplate('Was: {{previousState.hostname}}', {
      previousState: { hostname: 'old-host' }
    });
    expect(result).toBe('Was: old-host');
  });

  it('leaves placeholder when variable is missing', () => {
    const result = renderTemplate('Device {{missingVar}} found', {
      ipAddress: '10.0.0.1'
    });
    expect(result).toBe('Device {{missingVar}} found');
  });

  it('JSON.stringifies object values', () => {
    const result = renderTemplate('State: {{currentState}}', {
      currentState: { hostname: 'host-1', mac: 'aa:bb' }
    });
    expect(result).toBe('State: {"hostname":"host-1","mac":"aa:bb"}');
  });

  it('leaves placeholder for null value', () => {
    const result = renderTemplate('Host: {{hostname}}', {
      hostname: null
    });
    expect(result).toBe('Host: {{hostname}}');
  });

  it('leaves placeholder for undefined value', () => {
    const result = renderTemplate('Host: {{hostname}}', {
      hostname: undefined
    });
    expect(result).toBe('Host: {{hostname}}');
  });

  it('converts number values to string', () => {
    const result = renderTemplate('Port: {{port}}', {
      port: 8080
    });
    expect(result).toBe('Port: 8080');
  });

  it('handles multiple substitutions', () => {
    const result = renderTemplate('{{ipAddress}} ({{hostname}})', {
      ipAddress: '10.0.0.1',
      hostname: 'my-host'
    });
    expect(result).toBe('10.0.0.1 (my-host)');
  });
});

describe('parseKnownDevices', () => {
  it('returns empty array for null input', () => {
    expect(parseKnownDevices(null)).toEqual([]);
  });

  it('returns empty array for non-array input', () => {
    expect(parseKnownDevices('not-an-array')).toEqual([]);
    expect(parseKnownDevices(42)).toEqual([]);
    expect(parseKnownDevices({ ip: '10.0.0.1' })).toEqual([]);
  });

  it('parses a valid entry', () => {
    const result = parseKnownDevices([
      {
        ip: '10.0.0.1',
        mac: 'aa:bb:cc:dd:ee:ff',
        hostname: 'host-1',
        assetType: 'server',
        manufacturer: 'Dell',
        firstSeen: '2026-02-18T00:00:00.000Z',
        lastSeen: '2026-02-18T12:00:00.000Z'
      }
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.ip).toBe('10.0.0.1');
    expect(result[0]!.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(result[0]!.hostname).toBe('host-1');
    expect(result[0]!.assetType).toBe('server');
    expect(result[0]!.manufacturer).toBe('Dell');
    expect(result[0]!.firstSeen).toBe('2026-02-18T00:00:00.000Z');
    expect(result[0]!.lastSeen).toBe('2026-02-18T12:00:00.000Z');
  });

  it('skips entry without ip', () => {
    const result = parseKnownDevices([
      { mac: 'aa:bb:cc:dd:ee:ff', hostname: 'no-ip' }
    ]);
    expect(result).toEqual([]);
  });

  it('skips entry with empty ip', () => {
    const result = parseKnownDevices([
      { ip: '', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'empty-ip' }
    ]);
    expect(result).toEqual([]);
  });

  it('skips entry with whitespace-only ip', () => {
    const result = parseKnownDevices([
      { ip: '   ', mac: 'aa:bb:cc:dd:ee:ff' }
    ]);
    expect(result).toEqual([]);
  });

  it('skips null entries in array', () => {
    const result = parseKnownDevices([null, undefined, { ip: '10.0.0.1' }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.ip).toBe('10.0.0.1');
  });

  it('defaults assetType to unknown when missing', () => {
    const result = parseKnownDevices([{ ip: '10.0.0.1' }]);
    expect(result[0]!.assetType).toBe('unknown');
  });

  it('returns empty array for undefined input', () => {
    expect(parseKnownDevices(undefined)).toEqual([]);
  });
});

describe('normalizeBaselineScanSchedule boundary inputs', () => {
  it('clamps intervalHours = 0 to minimum of 1', () => {
    const schedule = normalizeBaselineScanSchedule({ intervalHours: 0 });
    expect(schedule.intervalHours).toBe(1);
  });

  it('clamps intervalHours = 200 to maximum of 168', () => {
    const schedule = normalizeBaselineScanSchedule({ intervalHours: 200 });
    expect(schedule.intervalHours).toBe(168);
  });

  it('clamps negative intervalHours to minimum of 1', () => {
    const schedule = normalizeBaselineScanSchedule({ intervalHours: -10 });
    expect(schedule.intervalHours).toBe(1);
  });

  it('clamps intervalHours = 168 (exact max) without change', () => {
    const schedule = normalizeBaselineScanSchedule({ intervalHours: 168 });
    expect(schedule.intervalHours).toBe(168);
  });

  it('clamps intervalHours = 1 (exact min) without change', () => {
    const schedule = normalizeBaselineScanSchedule({ intervalHours: 1 });
    expect(schedule.intervalHours).toBe(1);
  });

  it('truncates fractional intervalHours', () => {
    const schedule = normalizeBaselineScanSchedule({ intervalHours: 3.7 });
    expect(schedule.intervalHours).toBe(3);
  });

  it('uses fallback when intervalHours is NaN', () => {
    const schedule = normalizeBaselineScanSchedule({ intervalHours: 'not-a-number' });
    expect(schedule.intervalHours).toBe(4);
  });

  it('clamps fallbackIntervalHours = 0 to 1', () => {
    const schedule = normalizeBaselineScanSchedule(undefined, 0);
    expect(schedule.intervalHours).toBe(1);
  });

  it('clamps fallbackIntervalHours = 200 to 168', () => {
    const schedule = normalizeBaselineScanSchedule(undefined, 200);
    expect(schedule.intervalHours).toBe(168);
  });

  it('clamps negative fallbackIntervalHours to 1', () => {
    const schedule = normalizeBaselineScanSchedule(undefined, -5);
    expect(schedule.intervalHours).toBe(1);
  });
});
