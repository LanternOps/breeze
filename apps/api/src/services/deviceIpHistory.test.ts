import { beforeEach, describe, expect, it, vi } from 'vitest';

type UpdateRecord = { payload: Record<string, unknown>; condition: any };

const txState = vi.hoisted(() => ({
  activeRows: [] as Array<{ id: string; interfaceName: string; ipAddress: string; ipType: string }>,
  updates: [] as UpdateRecord[],
  inserts: [] as unknown[],
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ kind: 'eq', column, value })),
  and: vi.fn((...conditions: unknown[]) => ({ kind: 'and', conditions })),
  or: vi.fn((...conditions: unknown[]) => ({ kind: 'or', conditions })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ kind: 'inArray', column, values })),
}));

vi.mock('../db/schema', () => ({
  deviceIpHistory: {
    id: 'id',
    deviceId: 'deviceId',
    orgId: 'orgId',
    interfaceName: 'interfaceName',
    ipAddress: 'ipAddress',
    ipType: 'ipType',
    assignmentType: 'assignmentType',
    macAddress: 'macAddress',
    subnetMask: 'subnetMask',
    gateway: 'gateway',
    dnsServers: 'dnsServers',
    firstSeen: 'firstSeen',
    lastSeen: 'lastSeen',
    isActive: 'isActive',
    deactivatedAt: 'deactivatedAt',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(async (handler: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(txState.activeRows),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((payload: Record<string, unknown>) => ({
            where: vi.fn((condition: any) => {
              txState.updates.push({ payload, condition });
              return Promise.resolve([]);
            }),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((values: unknown) => {
            txState.inserts.push(values);
            return Promise.resolve([]);
          }),
        })),
      };

      return handler(tx);
    }),
  },
}));

import { processDeviceIPHistoryUpdate } from './deviceIpHistory';

function resetTxState() {
  txState.activeRows = [];
  txState.updates = [];
  txState.inserts = [];
}

function deactivationUpdate() {
  return txState.updates.find((record) => record.payload?.isActive === false);
}

describe('processDeviceIPHistoryUpdate', () => {
  beforeEach(() => {
    resetTxState();
    vi.clearAllMocks();
  });

  it('deactivates removed IP assignments by exact key', async () => {
    txState.activeRows = [
      { id: 'row-1', interfaceName: 'eth0', ipAddress: '10.0.0.10', ipType: 'ipv4' },
      { id: 'row-2', interfaceName: 'eth0', ipAddress: '10.0.0.11', ipType: 'ipv4' },
    ];

    await processDeviceIPHistoryUpdate('dev-1', 'org-1', {
      removedIPs: [{ interfaceName: 'eth0', ipAddress: '10.0.0.10', ipType: 'ipv4' }],
      detectedAt: '2026-02-20T16:00:00Z',
    });

    const deactivation = deactivationUpdate();
    expect(deactivation).toBeDefined();

    const inArrayNode = deactivation?.condition?.conditions?.find?.((item: any) => item?.kind === 'inArray');
    expect(inArrayNode?.values).toEqual(['row-1']);
  });

  it('keeps IPv4 and IPv6 assignments independent on the same interface', async () => {
    txState.activeRows = [
      { id: 'row-ipv4', interfaceName: 'eth0', ipAddress: '10.0.0.10', ipType: 'ipv4' },
    ];

    await processDeviceIPHistoryUpdate('dev-1', 'org-1', {
      changedIPs: [{ interfaceName: 'eth0', ipAddress: '2001:db8::10', ipType: 'ipv6', assignmentType: 'static' }],
      detectedAt: '2026-02-20T16:00:00Z',
    });

    expect(deactivationUpdate()).toBeUndefined();
    expect(txState.inserts).toHaveLength(1);

    const insertBatch = txState.inserts[0] as Array<Record<string, unknown>>;
    expect(insertBatch[0]?.ipType).toBe('ipv6');
    expect(insertBatch[0]?.ipAddress).toBe('2001:db8::10');
  });

  it('is idempotent for repeated exact active assignments', async () => {
    txState.activeRows = [
      { id: 'row-1', interfaceName: 'eth0', ipAddress: '10.0.0.10', ipType: 'ipv4' },
    ];

    const payload = {
      changedIPs: [{
        interfaceName: 'eth0',
        ipAddress: '10.0.0.10',
        ipType: 'ipv4',
        assignmentType: 'dhcp',
      }],
      detectedAt: '2026-02-20T16:00:00Z',
    };

    await processDeviceIPHistoryUpdate('dev-1', 'org-1', payload);
    await processDeviceIPHistoryUpdate('dev-1', 'org-1', payload);

    expect(txState.inserts).toHaveLength(0);
    expect(deactivationUpdate()).toBeUndefined();

    const metadataRefreshes = txState.updates.filter((record) => record.payload?.assignmentType === 'dhcp');
    expect(metadataRefreshes.length).toBe(2);
  });
});
