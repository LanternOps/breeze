import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks so we can inspect the upsert shape that reconcileTopology emits.
const {
  selectMock,
  insertMock,
  valuesMock,
  onConflictMock,
  deleteMock,
  assetRows,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
  onConflictMock: vi.fn(),
  deleteMock: vi.fn(),
  assetRows: [] as unknown[],
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      select: (...args: unknown[]) => selectMock(...(args as [])),
      insert: (...args: unknown[]) => insertMock(...(args as [])),
      delete: (...args: unknown[]) => deleteMock(...(args as [])),
    },
  };
});

import { reconcileTopology } from './reconcileTopology';
import { discoveredAssets } from '../db/schema';
import type { DeviceAdjacency, DiscoveredHostResult } from './discoveryWorker';

const SWITCH_ID = '00000000-0000-0000-0000-0000000000aa';
const HOST_ID = '00000000-0000-0000-0000-0000000000bb';

// buildAssetIndex selects FROM discoveredAssets → return seeded asset rows.
// ageOutMeasuredEdges selects FROM networkTopology → return [] (nothing to age out).
function makeFrom(from: unknown) {
  const rows = from === discoveredAssets ? assetRows : [];
  const where = vi.fn(() => Promise.resolve(rows));
  return { where };
}

beforeEach(() => {
  vi.clearAllMocks();
  assetRows.length = 0;
  assetRows.push(
    { id: SWITCH_ID, ip: '10.0.0.254', mac: '00:de:ad:00:00:01', sysName: 'core-sw', snmp: null },
    { id: HOST_ID, ip: '10.0.0.50', mac: 'aa:bb:cc:dd:ee:ff', sysName: 'host-1', snmp: null },
  );

  selectMock.mockImplementation(() => ({ from: (f: unknown) => makeFrom(f) }));

  // insert().values().onConflictDoUpdate() — thenable so `await` resolves.
  onConflictMock.mockImplementation(() => Promise.resolve(undefined));
  valuesMock.mockImplementation(() => ({ onConflictDoUpdate: onConflictMock }));
  insertMock.mockImplementation(() => ({ values: valuesMock }));

  deleteMock.mockImplementation(() => ({ where: vi.fn(() => Promise.resolve(undefined)) }));
});

describe('reconcileTopology — FDB upsert pass', () => {
  const hosts: DiscoveredHostResult[] = [
    { ip: '10.0.0.254', assetType: 'network_device', methods: ['snmp'] },
    { ip: '10.0.0.50', mac: 'aa:bb:cc:dd:ee:ff', assetType: 'workstation', methods: ['ping'] },
  ];

  const adjacency: DeviceAdjacency[] = [
    {
      sourceDeviceIp: '10.0.0.254',
      lldp: [],
      cdp: [],
      fdb: [{ mac: 'aa:bb:cc:dd:ee:ff', bridgePort: 5, ifName: 'Gi0/5', vlan: 100 }],
    },
  ];

  it('upserts an fdb access edge with the provenance-tuple conflict target', async () => {
    await reconcileTopology('org-1', 'site-1', hosts, adjacency);

    expect(insertMock).toHaveBeenCalled();
    // The networkTopology table object must be the insert target.
    const insertTargets = insertMock.mock.calls.map((c) => c[0]);
    expect(insertTargets.length).toBeGreaterThan(0);

    // Find the FDB values payload among all upserts.
    const fdbValues = valuesMock.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((v) => v.method === 'fdb');
    expect(fdbValues).toBeDefined();
    expect(fdbValues).toMatchObject({
      orgId: 'org-1',
      siteId: 'site-1',
      sourceType: 'discovered_asset',
      sourceId: SWITCH_ID,
      targetType: 'discovered_asset',
      targetId: HOST_ID,
      connectionType: 'access',
      method: 'fdb',
      confidence: 'medium',
      interfaceName: 'Gi0/5',
      vlan: 100,
    });
    expect(fdbValues!.lastVerifiedAt).toBeInstanceOf(Date);

    // The onConflictDoUpdate target is the 7-column provenance tuple.
    const fdbConflict = onConflictMock.mock.calls
      .map((c) => c[0] as { target: unknown[]; set: Record<string, unknown> })
      .find((c) => c.set.method === 'fdb' || c.set.connectionType === 'access');
    expect(fdbConflict).toBeDefined();
    expect(Array.isArray(fdbConflict!.target)).toBe(true);
    expect(fdbConflict!.target).toHaveLength(7);
    expect(fdbConflict!.set).toMatchObject({
      connectionType: 'access',
      confidence: 'medium',
      interfaceName: 'Gi0/5',
      vlan: 100,
    });
    expect(fdbConflict!.set.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — a second identical reconcile does not throw', async () => {
    await reconcileTopology('org-1', 'site-1', hosts, adjacency);
    await expect(reconcileTopology('org-1', 'site-1', hosts, adjacency)).resolves.toBeUndefined();
  });
});
