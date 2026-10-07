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
    if (keys.includes('worstRank')) return 'aggregates';
    if (keys.includes('batteryStatus')) return 'device';
    if (keys.includes('eventType')) return 'events';
    if (keys.includes('mountPoint')) return 'disks';
    if (keys.includes('componentKey')) return 'components';
    if (keys.includes('lastCollectedAt') && keys.includes('deviceId')) return 'collected';
    if (keys.includes('lastCollectedAt')) return 'collectedOne';
    return 'devicePage';
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
  hardwareHealthDeviceDetail,
  hardwareHealthDevicesPage,
  hardwareHealthOverview,
} from './hardwareHealthReadModel';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-02T12:00:00.000Z');

// Fields that must never reach a customer. Rows below deliberately carry them
// as if a select had leaked them, to prove the mapper drops them anyway.
const FORBIDDEN = [
  'serial', 'firmware', 'attributes', 'source', 'alertExempt',
  'unhealthyStreak', 'criticalStreak', 'healthyStreak', 'belowCriticalStreak',
  'predictiveStreak', 'sources', 'agentVersion', 'detail', 'device',
  'stale', 'staleSince', 'orgId', 'deviceId', 'agentId', 'summary',
  'controllerNames', 'collectorHealth', 'tiersRun',
];

function leak(extra: Record<string, unknown>) {
  return {
    serial: 'SN-1', firmware: 'fw', attributes: { a: 1 }, source: 'storcli',
    alertExempt: false, unhealthyStreak: 1, criticalStreak: 1, healthyStreak: 0,
    belowCriticalStreak: 0, predictiveStreak: 0, sources: [], agentVersion: '1',
    detail: { x: 1 }, device: '/dev/sda', stale: false, staleSince: null,
    orgId: ORG, deviceId: DEVICE, agentId: 'agent-1',
    ...extra,
  };
}

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

describe('hardwareHealthDeviceDetail', () => {
  function seed() {
    mocks.data.device = [leak({
      id: DEVICE, hostname: 'srv-01', displayName: null, osType: 'linux',
      batteryStatus: {
        present: true, percent: 80, chargingState: 'charging', pluggedIn: true,
        timeRemainingMinutes: 120, timeToFullMinutes: 30,
        reportedAt: '2026-10-02T11:00:00.000Z',
      },
    })];
    mocks.data.components = [
      leak({
        componentKey: 'pd0', componentType: 'physical_disk', parentKey: 'c0', name: 'Disk 0',
        model: 'ST1000', sizeBytes: 1000, health: 'warning', state: 'online', stateDetail: null,
        progressPercent: null, temperatureC: 40, predictiveFailure: true,
        lastSeenAt: new Date('2026-10-02T11:59:00.000Z'),
      }),
      leak({
        componentKey: 'vd0', componentType: 'virtual_disk', parentKey: 'c0', name: 'VD 0',
        model: null, sizeBytes: 2000, health: 'ok', state: 'optimal', stateDetail: null,
        progressPercent: null, temperatureC: null, predictiveFailure: false,
        lastSeenAt: new Date('2026-10-02T11:59:00.000Z'),
      }),
      // Defense in depth: even if the query returned these, they never appear.
      leak({
        componentKey: 'bmc0', componentType: 'bmc', parentKey: null, name: 'BMC',
        model: null, sizeBytes: null, health: 'critical', state: 'x', stateDetail: null,
        progressPercent: null, temperatureC: null, predictiveFailure: false,
        lastSeenAt: new Date('2026-10-02T11:59:00.000Z'),
      }),
      leak({
        componentKey: 'old0', componentType: 'physical_disk', parentKey: null, name: 'Gone',
        model: null, sizeBytes: null, health: 'critical', state: 'x', stateDetail: null,
        progressPercent: null, temperatureC: null, predictiveFailure: false, stale: true,
        lastSeenAt: new Date('2026-09-01T11:59:00.000Z'),
      }),
    ];
    mocks.data.events = [
      leak({
        componentKey: 'pd0', componentType: 'physical_disk', eventType: 'health_changed',
        fromHealth: 'ok', toHealth: 'warning', fromState: 'online', toState: 'online',
        occurredAt: new Date('2026-10-02T10:00:00.000Z'),
      }),
      leak({
        componentKey: 'bmc0', componentType: 'collector', eventType: 'first_seen',
        fromHealth: null, toHealth: 'ok', fromState: null, toState: 'x',
        occurredAt: new Date('2026-10-02T09:00:00.000Z'),
      }),
    ];
    mocks.data.disks = [leak({
      mountPoint: '/', fsType: 'ext4', totalGb: 100, usedGb: 40, freeGb: 60,
      usedPercent: 40, health: 'healthy', updatedAt: new Date('2026-10-02T11:00:00.000Z'),
    })];
    mocks.data.collectedOne = [{ lastCollectedAt: new Date('2026-10-02T11:58:00.000Z') }];
  }

  it('never exposes component keys, disk serials or raw tool text', async () => {
    seed();
    mocks.data.components = [
      ...(mocks.data.components ?? []),
      leak({
        componentKey: 'smart:SER123', componentType: 'physical_disk', parentKey: 'storcli:c0',
        name: 'smart:SER123', model: 'ST2000', sizeBytes: 2000, health: 'ok', state: 'online',
        stateDetail: 'raw vendor output SER123', progressPercent: null, temperatureC: 35,
        predictiveFailure: false, lastSeenAt: new Date('2026-10-02T11:59:00.000Z'),
      }),
    ];
    const dto = await hardwareHealthDeviceDetail(ORG, DEVICE, NOW);
    const json = JSON.stringify(dto);
    for (const leaked of ['SER123', 'smart:', 'storcli', 'raw vendor output']) {
      expect(json).not.toContain(leaked);
    }
    expect(dto!.components.find((c) => c.model === 'ST2000')!.name).toBeNull();
  });

  it('returns null when the device is not in the organization', async () => {
    mocks.data.device = [];
    expect(await hardwareHealthDeviceDetail(ORG, DEVICE, NOW)).toBeNull();
    // It must stop at the device lookup: no component/event/disk query runs.
    expect(mocks.selects).toHaveLength(1);
  });

  it('computes health and counts from the filtered components only', async () => {
    seed();
    const dto = await hardwareHealthDeviceDetail(ORG, DEVICE, NOW);
    expect(dto).not.toBeNull();
    expect(dto!.components.map((c) => c.name)).toEqual(['Disk 0', 'VD 0']);
    expect(dto!.health).toBe('warning');
    expect(dto!.counts).toEqual({ ok: 1, warning: 1, critical: 0, unknown: 0 });
    expect(dto!.events.map((e) => e.componentType)).toEqual(['physical_disk']);
    expect(dto!.dataStatus).toBe('ok');
    expect(dto!.asOf).toBe(NOW.toISOString());
  });

  it('exposes only allowlisted fields (contract)', async () => {
    seed();
    const dto = await hardwareHealthDeviceDetail(ORG, DEVICE, NOW);
    // `device` is the top-level device summary here; the OS device path of a
    // disk (also called `device`) is covered by the exact disk key list below.
    const { device: _summary, ...rest } = dto!;
    const keys = allKeys(rest);
    for (const forbidden of FORBIDDEN) expect(keys.has(forbidden)).toBe(false);
    expect(Object.keys(dto!).sort()).toEqual(
      ['asOf', 'battery', 'counts', 'dataStatus', 'device', 'disks', 'events',
        'health', 'components', 'lastCollectedAt'].sort(),
    );
    expect(Object.keys(dto!.components[0]!).sort()).toEqual(
      ['componentType', 'health', 'model', 'name', 'predictiveFailure',
        'progressPercent', 'sizeBytes', 'state', 'temperatureC'].sort(),
    );
    expect(Object.keys(dto!.events[0]!).sort()).toEqual(
      ['componentType', 'eventType', 'fromHealth', 'fromState', 'occurredAt',
        'toHealth', 'toState'].sort(),
    );
    expect(Object.keys(dto!.disks[0]!).sort()).toEqual(
      ['freeGb', 'fsType', 'health', 'mountPoint', 'totalGb', 'usedGb',
        'usedPercent'].sort(),
    );
    expect(Object.keys(dto!.device).sort()).toEqual(
      ['displayName', 'hostname', 'id', 'osType'].sort(),
    );
    expect(Object.keys(dto!.battery!).sort()).toEqual(
      ['chargingState', 'percent', 'pluggedIn', 'present', 'reportedAt',
        'timeRemainingMinutes', 'timeToFullMinutes'].sort(),
    );
  });

  it('never selects forbidden columns from the database', async () => {
    seed();
    await hardwareHealthDeviceDetail(ORG, DEVICE, NOW);
    const selected = new Set(mocks.selects.flat());
    // `stale` is read only to drop stale rows in code (defense in depth) and is
    // never emitted; every other forbidden column must not be selected at all.
    for (const forbidden of FORBIDDEN.filter((k) => k !== 'stale')) {
      expect(selected.has(forbidden)).toBe(false);
    }
  });

  it('reports no_data and unknown health when there are no components', async () => {
    seed();
    mocks.data.components = [];
    mocks.data.events = [];
    const dto = await hardwareHealthDeviceDetail(ORG, DEVICE, NOW);
    expect(dto!.dataStatus).toBe('no_data');
    expect(dto!.health).toBe('unknown');
    expect(dto!.counts).toEqual({ ok: 0, warning: 0, critical: 0, unknown: 0 });
  });

  it('returns battery null when the device has none', async () => {
    seed();
    (mocks.data.device![0] as Record<string, unknown>).batteryStatus = null;
    const dto = await hardwareHealthDeviceDetail(ORG, DEVICE, NOW);
    expect(dto!.battery).toBeNull();
  });
});

describe('hardwareHealthOverview', () => {
  it('counts devices by worst filtered health', async () => {
    mocks.data.total = [{ total: 5 }];
    mocks.data.aggregates = [
      { deviceId: 'a', worstRank: 3, componentCount: 2 },
      { deviceId: 'b', worstRank: 2, componentCount: 1 },
      { deviceId: 'c', worstRank: 0, componentCount: 4 },
      { deviceId: 'd', worstRank: 1, componentCount: 1 },
    ];
    const dto = await hardwareHealthOverview(ORG, NOW);
    expect(dto.devices).toEqual({
      total: 5,
      reporting: 4,
      byHealth: { ok: 1, warning: 1, critical: 1, unknown: 1 },
    });
    expect(dto.dataStatus).toBe('ok');
    expect(allKeys(dto).has('deviceId')).toBe(false);
  });

  it('reports no_data when no device reports hardware health', async () => {
    mocks.data.total = [{ total: 3 }];
    mocks.data.aggregates = [];
    const dto = await hardwareHealthOverview(ORG, NOW);
    expect(dto.dataStatus).toBe('no_data');
    expect(dto.devices.reporting).toBe(0);
  });
});

describe('hardwareHealthDevicesPage', () => {
  it('maps a page of devices with their worst health', async () => {
    mocks.data.total = [{ total: 2 }];
    mocks.data.reporting = [{ reporting: 1 }];
    mocks.data.devicePage = [
      leak({ id: 'a', hostname: 'h-a', displayName: 'A', osType: 'windows' }),
      leak({ id: 'b', hostname: 'h-b', displayName: null, osType: 'linux' }),
    ];
    mocks.data.aggregates = [{ deviceId: 'a', worstRank: 2, componentCount: 3 }];
    mocks.data.collected = [
      { deviceId: 'a', lastCollectedAt: new Date('2026-10-02T11:00:00.000Z') },
    ];
    const dto = await hardwareHealthDevicesPage(ORG, { page: 2, limit: 25, now: NOW });
    expect(dto.pagination).toEqual({ page: 2, limit: 25, total: 2 });
    expect(dto.dataStatus).toBe('ok');
    expect(dto.data).toEqual([
      {
        id: 'a', hostname: 'h-a', displayName: 'A', osType: 'windows',
        health: 'warning', componentCount: 3,
        lastCollectedAt: '2026-10-02T11:00:00.000Z',
      },
      {
        id: 'b', hostname: 'h-b', displayName: null, osType: 'linux',
        health: 'unknown', componentCount: 0, lastCollectedAt: null,
      },
    ]);
    for (const forbidden of FORBIDDEN) expect(allKeys(dto).has(forbidden)).toBe(false);
  });
});

describe('hardwareHealthDevicesPage dataStatus', () => {
  it('is ok when the organization reports data even if this page has none', async () => {
    mocks.data.total = [{ total: 120 }];
    mocks.data.reporting = [{ reporting: 3 }];
    mocks.data.devicePage = [leak({ id: 'z', hostname: 'h-z', displayName: null, osType: 'linux' })];
    mocks.data.aggregates = [];
    const dto = await hardwareHealthDevicesPage(ORG, { page: 3, limit: 50, now: NOW });
    expect(dto.dataStatus).toBe('ok');
    expect(dto.data[0]!.health).toBe('unknown');
  });

  it('is no_data only when nothing in the organization reports', async () => {
    mocks.data.total = [{ total: 2 }];
    mocks.data.reporting = [{ reporting: 0 }];
    mocks.data.devicePage = [];
    const dto = await hardwareHealthDevicesPage(ORG, { page: 1, limit: 50, now: NOW });
    expect(dto.dataStatus).toBe('no_data');
  });
});
