import { describe, expect, it } from 'vitest';
import {
  axcientDeviceToVendorDevice,
  axcientVerifiedBootable,
  mapAxcientOsType,
  mapAxcientStatus,
  scrubAxcientRaw,
} from './device';
import devices101 from './__fixtures__/devices-client-101.json';
import devices102 from './__fixtures__/devices-client-102.json';

type Row = Record<string, unknown>;
const appliance = devices101[0] as Row; // 501, NORMAL, appliance, AutoVerify with screenshots
const d2c = devices101[1] as Row; // 502, WARNED, D2C, no AutoVerify
const rp = '2026-11-05T03:00:00Z';

describe('mapAxcientStatus', () => {
  it.each([
    ['NORMAL', 'ANYTHING', { latest_local_rp: rp }, 'completed'],
    ['WARNED', 'ANYTHING', { latest_local_rp: rp }, 'completed_with_errors'],
    ['TROUBLED', 'OFFSITE_NEVER_RUN', { latest_local_rp: rp }, 'no_backups'],
    ['TROUBLED', 'APPLIANCE_OFFLINE', {}, 'no_backups'], // all three latest_*_rp null
    ['TROUBLED', 'SCHEDULE_DISABLED', { latest_local_rp: rp }, 'no_selection'],
    ['TROUBLED', 'APPLIANCE_OFFLINE', { latest_local_rp: rp }, 'failed'],
    ['TROUBLED', 'APPLIANCE_OFFLINED', { latest_local_rp: rp }, 'failed'], // help-centre spelling
    ['TROUBLED', 'NEVER_SEEN_BEFORE', { latest_local_rp: rp }, 'failed'], // unrecognised reason
    ['PARKED', 'ANYTHING', {}, 'paused'],
    ['UNPROTECTED', 'ANYTHING', { latest_local_rp: rp }, 'no_backups'],
    ['SOMETHING_NEW', 'X', { latest_local_rp: rp }, 'unknown'],
  ])('%s / %s => %s', (status, reason, rps, expected) =>
    expect(mapAxcientStatus({ current_health_status: { status, reason }, ...rps })).toBe(expected));

  it('missing current_health_status => unknown, never throws', () => {
    for (const device of [{}, { current_health_status: null }, { current_health_status: 'x' }, { current_health_status: { status: 7 } }]) {
      expect(mapAxcientStatus(device)).toBe('unknown');
    }
  });

  it('a junk recovery point does not count as one', () => {
    expect(mapAxcientStatus({ current_health_status: { status: 'TROUBLED', reason: 'X' }, latest_local_rp: 'not a date' })).toBe('no_backups');
  });

  it('maps every fixture device without throwing', () => {
    expect([...devices101, ...devices102].map((d) => mapAxcientStatus(d as Row))).toEqual([
      'completed', 'completed_with_errors', 'failed', 'paused',
      'no_backups', 'no_selection', 'no_backups', 'unknown', 'no_backups',
    ]);
  });
});

describe('mapAxcientOsType', () => {
  it.each([['SERVER', 'server'], ['WORKSTATION', 'workstation'], ['NAS', 'unknown'], ['ARCHIVE', 'unknown'], [undefined, 'unknown']])(
    'type %s => %s',
    (type, expected) => expect(mapAxcientOsType(type)).toBe(expected),
  );
});

describe('axcientDeviceToVendorDevice', () => {
  it('lastSuccessAt = max of the three RPs, ignoring nulls and junk', () => {
    const device = axcientDeviceToVendorDevice({
      ...appliance, latest_local_rp: '2026-11-03T03:00:00Z', latest_vault_rp: '2026-11-05T03:00:00Z', latest_cloud_rp: null,
    });
    expect(device.lastSuccessAt).toEqual(new Date('2026-11-05T03:00:00Z'));
    expect(device.lastSessionAt).toEqual(device.lastSuccessAt);
    expect(device.lastCompletedAt).toEqual(device.lastSuccessAt);
    const junk = axcientDeviceToVendorDevice({ ...appliance, latest_local_rp: 'garbage', latest_vault_rp: 42, latest_cloud_rp: '2026-11-04T00:00:00Z' });
    expect(junk.lastSuccessAt).toEqual(new Date('2026-11-04T00:00:00Z'));
    const none = axcientDeviceToVendorDevice({ ...appliance, latest_local_rp: null, latest_vault_rp: null, latest_cloud_rp: null });
    expect([none.lastSuccessAt, none.lastSessionAt, none.lastCompletedAt]).toEqual([null, null, null]);
  });

  it('appliance device: usedBytes = local_usage, selectedBytes = local_total, dataSources [image]', () => {
    const device = axcientDeviceToVendorDevice(appliance);
    expect(device.usedBytes).toBe(132153611);
    expect(device.selectedBytes).toBe(152136512);
    expect(device.dataSources).toEqual(['image']);
  });

  it('D2C device: usedBytes = cloud_usage, selectedBytes null when local_total absent, dataSources [image]', () => {
    const device = axcientDeviceToVendorDevice(d2c);
    expect(device.usedBytes).toBe(4096);
    expect(device.selectedBytes).toBeNull();
    expect(device.dataSources).toEqual(['image']);
  });

  it('byte counts must be non-negative numbers (bigint columns reject fractions)', () => {
    const device = axcientDeviceToVendorDevice({ ...appliance, local_usage: '12', local_total: -1 });
    expect(device.usedBytes).toBeNull();
    expect(device.selectedBytes).toBeNull();
    expect(axcientDeviceToVendorDevice({ ...appliance, local_usage: 10.7 }).usedBytes).toBe(10);
  });

  it('maps identity fields', () => {
    const device = axcientDeviceToVendorDevice(appliance);
    expect(device).toMatchObject({
      vendorDeviceId: '501',
      vendorCustomerId: '101',
      name: 'SYN-SRV-01',
      computerName: 'SYN-SRV-01',
      osType: 'server',
      osVersion: 'Windows Server 2022',
      clientVersion: '2.40.1546',
      accountType: 'backup_manager',
      status: 'completed',
      vendorStatusCode: null,
      vendorCreatedAt: null,
      vendorExpiresAt: null,
    });
  });

  it('a device without a name keeps its id as the label and no computer name to match on', () => {
    const device = axcientDeviceToVendorDevice({ ...appliance, name: '' });
    expect(device.name).toBe('501');
    expect(device.computerName).toBeNull();
  });

  it('normalises mac_address to lower-case colon form, [] when absent', () => {
    expect(axcientDeviceToVendorDevice(appliance).macAddresses).toEqual(['00:1a:2b:3c:4d:5e']);
    expect(axcientDeviceToVendorDevice({ ...appliance, mac_address: undefined }).macAddresses).toEqual([]);
  });

  it('errorsCount 0 for NORMAL, 1 otherwise', () => {
    expect(axcientDeviceToVendorDevice(appliance).errorsCount).toBe(0);
    expect(axcientDeviceToVendorDevice(d2c).errorsCount).toBe(1);
    expect(axcientDeviceToVendorDevice({ ...appliance, current_health_status: undefined }).errorsCount).toBe(1);
  });

  it('raw drops jobs, volumes, excluded_volumes, vaults and both screenshot URLs', () => {
    const { raw } = axcientDeviceToVendorDevice(appliance);
    for (const key of ['jobs', 'volumes', 'excluded_volumes', 'vaults']) expect(raw).not.toHaveProperty(key);
    expect(raw).toHaveProperty('current_health_status');
    expect(raw).toHaveProperty('device_details_page_url');
    expect(raw).toHaveProperty('local_ps_id');
    expect((raw.latest_autoverify_details as Row).rp).toBe(rp);
    expect(JSON.stringify(raw)).not.toContain('screenshot');
    // The input is not mutated: the adapter may still need it.
    expect((appliance.latest_autoverify_details as Row).screenshot_url).toEqual(expect.any(String));
  });

  it('scrubAxcientRaw drops screenshot keys at any depth', () => {
    const raw = scrubAxcientRaw({ id: 1, nested: { deeper: [{ screenshot_url: 'u', keep: 1 }] } });
    expect(raw).toEqual({ id: 1, nested: { deeper: [{ keep: 1 }] } });
  });

  it('carries verified-bootable evidence onto the device', () => {
    expect(axcientDeviceToVendorDevice(appliance).verifiedBootable).toEqual({
      at: new Date('2026-11-05T03:12:00Z'), healthy: true, failedChecks: [],
    });
    expect(axcientDeviceToVendorDevice(d2c).verifiedBootable).toBeNull();
  });

  it('throws malformed_response when id or client_id is missing', () => {
    for (const bad of [{ ...appliance, id: undefined }, { ...appliance, client_id: undefined }, { ...appliance, id: '' }, { ...appliance, client_id: {} }]) {
      expect(() => axcientDeviceToVendorDevice(bad)).toThrow(expect.objectContaining({ code: 'malformed_response' }));
    }
  });
});

describe('axcientVerifiedBootable', () => {
  it('healthy pass', () => {
    expect(axcientVerifiedBootable({ status: 'success', is_healthy: true, end_timestamp: rp })).toEqual({
      at: new Date(rp), healthy: true, failedChecks: [],
    });
  });

  it('failed system_boot', () => {
    expect(axcientVerifiedBootable({
      status: 'success', is_healthy: false, end_timestamp: rp,
      check_disk: { result: 'passed' }, system_boot: { result: false },
    })).toEqual({ at: new Date(rp), healthy: false, failedChecks: ['system_boot'] });
  });

  it('lists failed checks in fixed order from every recognised shape', () => {
    expect(axcientVerifiedBootable({
      status: 'success', is_healthy: false,
      start_vss: { result: 'FAILED' }, check_disk: false, heartbeat: { result: 'error' }, system_boot: { result: 'Failure' },
    })?.failedChecks).toEqual(['system_boot', 'heartbeat', 'check_disk', 'start_vss']);
    expect(axcientVerifiedBootable({ status: 'success', is_healthy: false, heartbeat: 'failed', check_disk: { result: 'passed' } })?.failedChecks).toEqual([]);
  });

  it('ran but did not complete', () => {
    expect(axcientVerifiedBootable({ status: 'failure', is_healthy: true })).toEqual({ at: null, healthy: false, failedChecks: [] });
  });

  it('null when details absent or is_healthy not boolean', () => {
    for (const details of [undefined, null, 'x', [], {}, { status: 'success', is_healthy: 'true' }]) {
      expect(axcientVerifiedBootable(details)).toBeNull();
    }
  });
});
