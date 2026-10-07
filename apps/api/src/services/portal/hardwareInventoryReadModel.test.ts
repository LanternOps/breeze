import { beforeEach, describe, expect, it, vi } from 'vitest';

// The db mock records the column map of every select() so the contract test can
// assert which columns the read model asks for, and answers each query by the
// shape of its column map.
const mocks = vi.hoisted(() => ({
  selects: [] as string[][],
  data: {} as Record<string, unknown[]>,
}));

vi.mock('../../db', () => {
  const kindOf = (keys: string[]): string => {
    if (keys.includes('total')) return 'total';
    if (keys.includes('reporting')) return 'reporting';
    if (keys.includes('gpuModel')) return 'hardwareDetail';
    if (keys.includes('manufacturer')) return 'hardwareList';
    if (keys.includes('slotIndex')) return 'memory';
    if (keys.includes('interfaceName')) return 'adapters';
    if (keys.includes('protocol')) return 'connections';
    return 'device';
  };
  const chain = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    mocks.selects.push(keys);
    const rows = mocks.data[kindOf(keys)] ?? [];
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'leftJoin', 'innerJoin']) {
      c[m] = () => c;
    }
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return c;
  };
  return { db: { select: (cols: Record<string, unknown>) => chain(cols) } };
});

import {
  hardwareInventoryDeviceDetail,
  hardwareInventoryDevicesPage,
  isOverlayAdapter,
  isOverlayAddress,
} from './hardwareInventoryReadModel';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-06T12:00:00.000Z');

// Identifiers that must never reach a customer. Rows below deliberately carry
// them as if a select had leaked them, to prove the mapper drops them anyway.
const SECRETS = ['SN-DEVICE-SECRET', 'SN-DIMM-SECRET', 'PN-SECRET', 'aa:bb:cc:dd:ee:ff', '203.0.113.9', 'secretd', '10.9.9.9'];

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

beforeEach(() => {
  mocks.selects.length = 0;
  mocks.data = {};
});

describe('hardwareInventoryDevicesPage', () => {
  it('reports dataStatus for the whole organization, not only the current page', async () => {
    mocks.data.total = [{ total: 120 }];
    mocks.data.reporting = [{ reporting: 3 }];
    // A page whose own devices have never reported inventory.
    mocks.data.device = [
      { id: DEVICE, hostname: 'srv-99', displayName: null, osType: 'linux' },
    ];
    mocks.data.hardwareList = [];

    const result = await hardwareInventoryDevicesPage(ORG, { page: 3, limit: 50, now: NOW });

    expect(result.dataStatus).toBe('ok');
    expect(result.data[0]).toMatchObject({ id: DEVICE, manufacturer: null, ramTotalMb: null });
    expect(result.pagination).toEqual({ page: 3, limit: 50, total: 120 });
  });

  it('says no_data only when no device in the organization has reported', async () => {
    mocks.data.total = [{ total: 2 }];
    mocks.data.reporting = [{ reporting: 0 }];
    mocks.data.device = [];

    const result = await hardwareInventoryDevicesPage(ORG, { page: 1, limit: 50, now: NOW });

    expect(result.dataStatus).toBe('no_data');
    expect(result.data).toEqual([]);
  });

  it('exposes only the closed list of keys per device', async () => {
    mocks.data.total = [{ total: 1 }];
    mocks.data.reporting = [{ reporting: 1 }];
    mocks.data.device = [{ id: DEVICE, hostname: 'srv-01', displayName: 'Srv', osType: 'linux' }];
    mocks.data.hardwareList = [{
      deviceId: DEVICE, manufacturer: 'Dell', model: 'R740', cpuModel: 'Xeon', cpuCores: 8,
      cpuThreads: 16, ramTotalMb: 65536, diskTotalGb: 960,
      serialNumber: 'SN-DEVICE-SECRET', orgId: ORG,
    }];

    const result = await hardwareInventoryDevicesPage(ORG, { page: 1, limit: 50, now: NOW });

    expect(Object.keys(result.data[0]!).sort()).toEqual([
      'cpuCores', 'cpuModel', 'cpuThreads', 'diskTotalGb', 'displayName', 'hostname', 'id',
      'manufacturer', 'model', 'osType', 'ramTotalMb',
    ]);
    expect(JSON.stringify(result)).not.toContain('SN-DEVICE-SECRET');
  });
});

describe('hardwareInventoryDeviceDetail', () => {
  function seed() {
    mocks.data.device = [{ id: DEVICE, hostname: 'srv-01', displayName: null, osType: 'linux' }];
    mocks.data.hardwareDetail = [{
      manufacturer: 'Dell', model: 'R740', cpuModel: 'Xeon', cpuCores: 8, cpuThreads: 16,
      ramTotalMb: 65536, diskTotalGb: 960, gpuModel: null, biosVersion: '2.1',
      observedAt: new Date('2026-10-06T11:00:00.000Z'),
      serialNumber: 'SN-DEVICE-SECRET', motherboardProduct: 'MB', orgId: ORG,
    }];
    mocks.data.memory = [{
      slotIndex: 0, locator: 'DIMM_A1', populated: true, capacityMb: 32768, memoryType: 'DDR4',
      formFactor: 'DIMM', speedMts: 3200, configuredSpeedMts: 2933,
      serialNumber: 'SN-DIMM-SECRET', partNumber: 'PN-SECRET', manufacturer: 'Vendor',
      slotKey: 'k',
    }];
    mocks.data.adapters = [
      {
        interfaceName: 'Ethernet', ipAddress: '10.0.0.5', ipType: 'ipv4', isPrimary: true,
        macAddress: 'aa:bb:cc:dd:ee:ff', publicIp: '203.0.113.9',
      },
      { interfaceName: 'tailscale0', ipAddress: '100.101.1.1', ipType: 'ipv4', isPrimary: false },
      { interfaceName: 'wg0', ipAddress: '10.9.9.9', ipType: 'ipv4', isPrimary: false },
      { interfaceName: 'eth1', ipAddress: '100.100.5.5', ipType: 'ipv4', isPrimary: false },
    ];
    mocks.data.connections = [
      {
        protocol: 'tcp', state: 'ESTABLISHED', count: 4,
        localAddr: '10.0.0.5', remoteAddr: '8.8.8.8', pid: 4, processName: 'secretd',
      },
      { protocol: 'udp', state: null, count: 1 },
    ];
  }

  it('returns null when the device is not in the organization', async () => {
    mocks.data.device = [];
    expect(await hardwareInventoryDeviceDetail(ORG, DEVICE, NOW)).toBeNull();
  });

  it('exposes exactly the allowed keys at every level', async () => {
    seed();
    const result = (await hardwareInventoryDeviceDetail(ORG, DEVICE, NOW))!;

    expect(Object.keys(result).sort()).toEqual([
      'asOf', 'connections', 'dataStatus', 'device', 'hardware', 'memoryModules', 'networkAdapters',
    ]);
    expect(Object.keys(result.hardware!).sort()).toEqual([
      'biosVersion', 'cpuCores', 'cpuModel', 'cpuThreads', 'diskTotalGb', 'gpuModel',
      'manufacturer', 'model', 'ramTotalMb',
    ]);
    expect(Object.keys(result.memoryModules[0]!).sort()).toEqual([
      'capacityMb', 'configuredSpeedMts', 'formFactor', 'locator', 'memoryType', 'populated',
      'slotIndex', 'speedMts',
    ]);
    expect(Object.keys(result.networkAdapters[0]!).sort()).toEqual([
      'interfaceName', 'ipAddress', 'ipType', 'isPrimary',
    ]);
    expect(Object.keys(result.connections.groups[0]!).sort()).toEqual(['count', 'protocol', 'state']);
  });

  it('never exposes serials, part numbers, MAC, public IP, addresses, ports or processes', async () => {
    seed();
    const result = await hardwareInventoryDeviceDetail(ORG, DEVICE, NOW);
    const json = JSON.stringify(result);
    for (const secret of SECRETS) expect(json).not.toContain(secret);

    const keys = allKeys(result);
    for (const forbidden of [
      'serialNumber', 'partNumber', 'macAddress', 'publicIp', 'localAddr', 'localPort',
      'remoteAddr', 'remotePort', 'pid', 'processName', 'manufacturer_module', 'orgId', 'slotKey',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('never asks the database for a forbidden column', async () => {
    seed();
    await hardwareInventoryDeviceDetail(ORG, DEVICE, NOW);
    const selected = new Set(mocks.selects.flat());
    for (const forbidden of [
      'serialNumber', 'partNumber', 'macAddress', 'publicIp', 'localAddr', 'localPort',
      'remoteAddr', 'remotePort', 'pid', 'processName', 'agentTokenHash', 'mtlsCertSerialNumber',
    ]) {
      expect(selected.has(forbidden)).toBe(false);
    }
  });

  it('skips tunnel and overlay adapters', async () => {
    seed();
    const result = (await hardwareInventoryDeviceDetail(ORG, DEVICE, NOW))!;
    expect(result.networkAdapters.map((a) => a.interfaceName)).toEqual(['Ethernet']);
  });

  it('aggregates connections by protocol and state with a total', async () => {
    seed();
    const result = (await hardwareInventoryDeviceDetail(ORG, DEVICE, NOW))!;
    expect(result.connections).toEqual({
      total: 5,
      groups: [
        { protocol: 'tcp', state: 'ESTABLISHED', count: 4 },
        { protocol: 'udp', state: null, count: 1 },
      ],
    });
  });

  it('reports no_data and a null hardware block for a device that never reported', async () => {
    mocks.data.device = [{ id: DEVICE, hostname: 'srv-01', displayName: null, osType: 'linux' }];
    const result = (await hardwareInventoryDeviceDetail(ORG, DEVICE, NOW))!;
    expect(result.dataStatus).toBe('no_data');
    expect(result.hardware).toBeNull();
    expect(result.memoryModules).toEqual([]);
    expect(result.connections).toEqual({ total: 0, groups: [] });
  });
});

describe('overlay detection', () => {
  it.each([
    ['tailscale0', null, true],
    ['Tailscale', null, true],
    ['WireGuard Tunnel', null, true],
    ['wg0', null, true],
    ['utun3', null, true],
    ['ZeroTier One [abc]', null, true],
    ['Ethernet', '100.64.0.1', true],
    ['Ethernet', '100.127.255.254', true],
    ['Ethernet', '100.128.0.1', false],
    ['Ethernet', '100.63.0.1', false],
    ['eth0', 'fd7a:115c:a1e0::1', true],
    ['eth0', '10.0.0.5', false],
    ['Ethernet', null, false],
  ])('%s %s -> %s', (name, ip, expected) => {
    expect(isOverlayAdapter(name, ip)).toBe(expected);
  });

  it('treats empty addresses as not overlay', () => {
    expect(isOverlayAddress(null)).toBe(false);
    expect(isOverlayAddress('')).toBe(false);
  });
});
