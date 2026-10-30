import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), delete: vi.fn(), update: vi.fn(), execute: vi.fn(),
  matches: vi.fn(), rowLocks: vi.fn(), advisory: vi.fn(), peripheral: vi.fn(), afterCommit: vi.fn() }));
vi.mock('../db', () => ({ db: { select: mocks.select, insert: mocks.insert, delete: mocks.delete, update: mocks.update, execute: mocks.execute },
  runAfterDbContextCommit: mocks.afterCommit }));
vi.mock('./filterEngine', () => ({ deviceMatchesFilter: mocks.matches, evaluateFilter: vi.fn(),
  extractFieldsFromFilter: () => ['hostname'] }));
vi.mock('../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: mocks.peripheral }));
vi.mock('./deviceGroupOwnership', async importOriginal => ({
  ...await importOriginal<typeof import('./deviceGroupOwnership')>(),
  acquirePartnerGroupRowLocks: mocks.rowLocks, acquireGroupOrgMembershipLocks: mocks.advisory,
}));
import { evaluateDeviceGroupMemberships, evaluateDeviceMembershipForGroup, removeDeviceFromAllGroups, schedulePeripheralMembershipChanges } from './groupMembership';
const orgId = '00000000-0000-4000-8000-000000000001';
const device = { id: '00000000-0000-4000-8000-000000000002', orgId, siteId: null, partnerId: '00000000-0000-4000-8000-000000000003', orgType: 'customer' };
const group = { id: '00000000-0000-4000-8000-000000000004', orgId: null, partnerId: device.partnerId, siteId: null,
  type: 'dynamic', filterConditions: { operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'srv' }] } };
function selectRows(rows: unknown[]) {
  const terminal = { limit: () => Promise.resolve(rows), orderBy: () => Promise.resolve(rows),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
  const from = { where: () => terminal, innerJoin: () => from };
  return { from: () => from };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockImplementation(() => selectRows([]));
  mocks.matches.mockResolvedValue(true);
  mocks.execute.mockResolvedValue([]);
  mocks.insert.mockImplementation(() => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) }));
  mocks.delete.mockReturnValue({ where: () => Promise.resolve(undefined) });
});
describe('per-device partner evaluation locking', () => {
  it.each([null, orgId])('takes the export lock before the first membership write for owner %s', async owner => {
    mocks.select.mockReturnValueOnce(selectRows([device])).mockReturnValueOnce(selectRows([{ ...group, orgId: owner }]));
    if (owner === null) mocks.select.mockReturnValueOnce(selectRows([group]));
    // Ownership re-read after waiting for the export lock.
    mocks.select.mockImplementation(() => selectRows([device]));
    // The initial membership is absent; subsequent membership reads are absent too.
    mocks.select.mockReturnValueOnce(selectRows([])).mockReturnValueOnce(selectRows([device])).mockReturnValueOnce(selectRows([]));
    await evaluateDeviceGroupMemberships(device.id, { all: true });
    const query = mocks.execute.mock.calls.find(([statement]) => new PgDialect().sqlToQuery(statement).sql.includes('breeze_partner_export_lock_orgs_exclusive'));
    expect(query).toBeDefined();
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.insert.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not take the export lock or write for a zero diff', async () => {
    mocks.select.mockReturnValueOnce(selectRows([device])).mockReturnValueOnce(selectRows([group]))
      .mockReturnValueOnce(selectRows([group])).mockReturnValueOnce(selectRows([{ deviceId: device.id, isPinned: false }]));
    await evaluateDeviceGroupMemberships(device.id, { all: true });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  it('takes all partner locks before an org-group write and takes one export lock across groups', async () => {
    mocks.select.mockReturnValueOnce(selectRows([device])).mockReturnValueOnce(selectRows([
      { ...group, id: '00000000-0000-4000-8000-000000000000', orgId }, group,
    ])).mockReturnValueOnce(selectRows([group])).mockReturnValueOnce(selectRows([])).mockReturnValueOnce(selectRows([device]))
      .mockReturnValueOnce(selectRows([])).mockReturnValueOnce(selectRows([]));
    await evaluateDeviceGroupMemberships(device.id, { all: true });
    expect(mocks.rowLocks).toHaveBeenCalledWith([group.id]);
    expect(mocks.advisory).toHaveBeenCalledWith([{ groupId: group.id, orgId }], 'shared');
    expect(mocks.advisory.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('does not insert with the old org after a device moves during the export lock wait', async () => {
    mocks.select.mockReturnValueOnce(selectRows([device])).mockReturnValueOnce(selectRows([group]))
      .mockReturnValueOnce(selectRows([group])).mockReturnValueOnce(selectRows([])).mockReturnValueOnce(selectRows([{ ...device, orgId: 'moved' }]));
    const result = await evaluateDeviceGroupMemberships(device.id, { all: true });
    expect(result.added).toBe(0);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('created evaluation collects failures and evaluates the remaining groups', async () => {
    mocks.select.mockReturnValueOnce(selectRows([device])).mockReturnValueOnce(selectRows([group, { ...group, id: 'second' }]))
      .mockReturnValueOnce(selectRows([group, { ...group, id: 'second' }])).mockReturnValueOnce(selectRows([]));
    mocks.matches.mockRejectedValueOnce(new Error('filter failed')).mockResolvedValue(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(evaluateDeviceGroupMemberships(device.id, { all: true })).rejects.toBeInstanceOf(AggregateError);
    expect(mocks.matches).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe('peripheral reconciliation after commit', () => {
  it('defers work and sends deduplicated devices in sequential chunks of 100', async () => {
    const work: (() => unknown)[] = [];
    mocks.afterCommit.mockImplementation((_label: string, callback: () => unknown) => { work.push(callback); });
    const releases: (() => void)[] = [];
    mocks.peripheral.mockImplementation(() => new Promise<void>(resolve => releases.push(resolve)));
    await schedulePeripheralMembershipChanges([...Array.from({ length: 205 }, (_, i) => String(i)), '0'], 'dynamic_membership_changed');
    expect(mocks.peripheral).not.toHaveBeenCalled();
    const pending = work[0]?.();
    expect(mocks.peripheral).toHaveBeenCalledTimes(100);
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(mocks.peripheral).toHaveBeenCalledTimes(200));
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(mocks.peripheral).toHaveBeenCalledTimes(205));
    releases.splice(0).forEach(release => release());
    await pending;
  });
});


describe('device deletion membership cleanup', () => {
  it('locks every partner membership and the single export org before deleting', async () => {
    mocks.select.mockReturnValueOnce(selectRows([{ groupId: group.id, orgId, groupOrgId: null }]));
    await removeDeviceFromAllGroups(device.id);
    expect(mocks.rowLocks).toHaveBeenCalledWith([group.id]);
    expect(mocks.advisory).toHaveBeenCalledWith([{ groupId: group.id, orgId }], 'shared');
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.delete.mock.invocationCallOrder[0] ?? 0);
  });
  it('takes no export lock or write when no memberships remain', async () => {
    await removeDeviceFromAllGroups(device.id);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});


describe('partner definitions after advisory admission', () => {
  it.each(['batch', 'wrapper'])('%s evaluates the filter committed by a whole-group writer while waiting', async mode => {
    const current = { ...group, filterConditions: { operator: 'AND', conditions: [
      { field: 'hostname', operator: 'equals', value: 'new-filter' },
    ] } };
    if (mode === 'batch') {
      mocks.select.mockReturnValueOnce(selectRows([device])).mockReturnValueOnce(selectRows([group]));
    } else {
      mocks.select.mockReturnValueOnce(selectRows([group])).mockReturnValueOnce(selectRows([device]));
    }
    mocks.select.mockReturnValueOnce(selectRows([current])).mockReturnValueOnce(selectRows([]));
    mocks.matches.mockResolvedValue(false);
    if (mode === 'batch') await evaluateDeviceGroupMemberships(device.id, { all: true });
    else await evaluateDeviceMembershipForGroup(group.id, device.id);
    expect(mocks.matches).toHaveBeenCalledWith(device.id, current.filterConditions);
    expect(mocks.advisory.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[2] ?? 0);
    expect(mocks.select.mock.invocationCallOrder[2]).toBeLessThan(mocks.matches.mock.invocationCallOrder[0] ?? 0);
  });
});
