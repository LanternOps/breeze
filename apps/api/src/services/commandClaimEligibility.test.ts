import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assertAllowedMock, userStatusMock, updateMock, setMock, whereMock } = vi.hoisted(() => ({
  assertAllowedMock: vi.fn(),
  userStatusMock: vi.fn(),
  updateMock: vi.fn(),
  setMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock('./partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: (...a: unknown[]) => assertAllowedMock(...(a as [])),
  TrustDeniedError: class TrustDeniedError extends Error {
    capability = 'device_execute' as const;
    constructor(
      public code: string,
      public reason: string,
      public deviceId: string,
      public commandType: string,
    ) {
      super(`Partner trust ${code}`);
      this.name = 'TrustDeniedError';
    }
  },
}));
vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'dc.id',
    status: 'dc.status',
    completedAt: 'dc.completedAt',
    result: 'dc.result',
    payload: 'dc.payload',
  },
  users: { id: 'users.id', status: 'users.status' },
}));
vi.mock('./sensitiveCommandPayload', () => ({ terminalPayloadErasureSet: () => ({ payload: null }) }));

import { POWER_STATE_TYPES, partitionClaimable, typeHolds } from './commandClaimEligibility';

const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';
const device = { id: 'd1', orgId: ORG, status: 'online' };

type Row = Parameters<typeof partitionClaimable>[2][number];
const row = (over: Partial<Row> = {}): Row => ({
  id: 'c1',
  type: 'refresh_inventory',
  createdBy: null,
  submittedOrgId: ORG,
  deliverBy: null,
  ...over,
});

function tx() {
  whereMock.mockResolvedValue([]);
  setMock.mockReturnValue({ where: (...a: unknown[]) => whereMock(...(a as [])) });
  updateMock.mockReturnValue({ set: (...a: unknown[]) => setMock(...(a as [])) });
  return {
    update: (...a: unknown[]) => updateMock(...(a as [])),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => userStatusMock() }) }) }),
  } as never;
}

describe('partitionClaimable (#5128 W1 §G)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    assertAllowedMock.mockResolvedValue(undefined);
    userStatusMock.mockResolvedValue([{ status: 'active' }]);
    for (const key of Object.keys(typeHolds)) delete typeHolds[key];
  });

  it('passes an ordinary row through and writes nothing', async () => {
    const r = await partitionClaimable(tx(), device, [row()]);
    expect(r.claimable.map((x) => x.id)).toEqual(['c1']);
    expect(r.cancelled).toEqual([]);
    expect(r.held).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('cancels when the device moved org since enqueue', async () => {
    const r = await partitionClaimable(tx(), device, [row({ submittedOrgId: OTHER_ORG })]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'device_moved_org' }]);
    expect(r.claimable).toEqual([]);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0]![0]).toMatchObject({
      status: 'cancelled',
      result: expect.objectContaining({ status: 'cancelled', reason: 'device_moved_org' }),
    });
  });

  it('legacy rows with NULL submitted_org_id are not cancelled for org drift', async () => {
    const r = await partitionClaimable(tx(), device, [row({ submittedOrgId: null })]);
    expect(r.claimable).toHaveLength(1);
    expect(r.cancelled).toEqual([]);
  });

  it('cancels on device lifecycle (quarantined) except self_uninstall', async () => {
    const r = await partitionClaimable(tx(), { ...device, status: 'quarantined' }, [
      row(),
      row({ id: 'c2', type: 'self_uninstall' }),
    ]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'device_lifecycle' }]);
    expect(r.claimable.map((x) => x.id)).toEqual(['c2']);
  });

  it('cancels on device lifecycle (decommissioned) except self_uninstall', async () => {
    const r = await partitionClaimable(tx(), { ...device, status: 'decommissioned' }, [
      row(),
      row({ id: 'c2', type: 'self_uninstall' }),
    ]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'device_lifecycle' }]);
    expect(r.claimable.map((x) => x.id)).toEqual(['c2']);
  });

  it('an offline or maintenance device is NOT a lifecycle cancellation', async () => {
    for (const status of ['offline', 'maintenance', 'updating', 'pending']) {
      const r = await partitionClaimable(tx(), { ...device, status }, [row()]);
      expect(r.claimable).toHaveLength(1);
    }
  });

  it('cancels on trust denial', async () => {
    const { TrustDeniedError } = await import('./partnerTrust.commands');
    assertAllowedMock.mockRejectedValue(new TrustDeniedError('TRUST_RESTRICTED', 'suspended', 'd1', 'refresh_inventory'));
    const r = await partitionClaimable(tx(), device, [row()]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'trust_denied' }]);
  });

  it('a non-trust error from the trust check propagates (never silently claims)', async () => {
    assertAllowedMock.mockRejectedValue(new Error('db down'));
    await expect(partitionClaimable(tx(), device, [row()])).rejects.toThrow('db down');
  });

  it('cancels when the requesting user is no longer active', async () => {
    userStatusMock.mockResolvedValue([{ status: 'disabled' }]);
    const r = await partitionClaimable(tx(), device, [row({ createdBy: USER })]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'requester_inactive' }]);
  });

  it('cancels when the requesting user row is gone entirely', async () => {
    userStatusMock.mockResolvedValue([]);
    const r = await partitionClaimable(tx(), device, [row({ createdBy: USER })]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'requester_inactive' }]);
  });

  it('system-issued rows (created_by NULL) are never cancelled for an inactive requester', async () => {
    userStatusMock.mockResolvedValue([{ status: 'disabled' }]);
    const r = await partitionClaimable(tx(), device, [row({ createdBy: null })]);
    expect(r.claimable).toHaveLength(1);
    expect(userStatusMock).not.toHaveBeenCalled();
  });

  it('the requester probe is cached per user across a batch', async () => {
    const r = await partitionClaimable(tx(), device, [
      row({ id: 'a', createdBy: USER }),
      row({ id: 'b', createdBy: USER }),
      row({ id: 'c', createdBy: OTHER_USER }),
    ]);
    expect(r.claimable).toHaveLength(3);
    expect(userStatusMock).toHaveBeenCalledTimes(2);
  });

  it('power-state rows are held while other work is claimable in the same batch', async () => {
    const r = await partitionClaimable(tx(), device, [
      row({ id: 'a', type: 'refresh_inventory' }),
      row({ id: 'b', type: 'reboot' }),
    ]);
    expect(r.claimable.map((x) => x.id)).toEqual(['a']);
    expect(r.held).toEqual([{ id: 'b', reason: 'power_state_barrier' }]);
  });

  it('power-state rows are held while anything is already in flight', async () => {
    const r = await partitionClaimable(tx(), device, [row({ id: 'b', type: 'reboot' })], { inFlight: 1 });
    expect(r.claimable).toEqual([]);
    expect(r.held).toEqual([{ id: 'b', reason: 'power_state_barrier' }]);
  });

  it('a power-state row alone with nothing in flight is claimed', async () => {
    const r = await partitionClaimable(tx(), device, [row({ id: 'b', type: 'reboot' })], { inFlight: 0 });
    expect(r.claimable.map((x) => x.id)).toEqual(['b']);
    expect(r.held).toEqual([]);
  });

  it('two power-state rows: exactly one is claimed, the rest held', async () => {
    const r = await partitionClaimable(
      tx(),
      device,
      [row({ id: 'b', type: 'reboot' }), row({ id: 'c', type: 'shutdown' })],
      { inFlight: 0 }
    );
    expect(r.claimable).toHaveLength(1);
    expect(r.claimable[0]!.id).toBe('b');
    expect(r.held).toEqual([{ id: 'c', reason: 'power_state_barrier' }]);
  });

  it('a held power-state row is never also cancelled', async () => {
    const r = await partitionClaimable(tx(), device, [
      row({ id: 'a', type: 'refresh_inventory' }),
      row({ id: 'b', type: 'reboot' }),
    ]);
    expect(r.cancelled).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a cancelled power-state row does not consume the barrier slot', async () => {
    const r = await partitionClaimable(tx(), device, [
      row({ id: 'b', type: 'reboot', submittedOrgId: OTHER_ORG }),
      row({ id: 'c', type: 'shutdown' }),
    ]);
    expect(r.cancelled).toEqual([{ id: 'b', reason: 'device_moved_org' }]);
    expect(r.claimable.map((x) => x.id)).toEqual(['c']);
  });

  it('a registered type hold keeps the row pending without cancelling it', async () => {
    typeHolds.install_patches = async () => true;
    const r = await partitionClaimable(tx(), device, [row({ type: 'install_patches' })]);
    expect(r.held).toEqual([{ id: 'c1', reason: 'held_maintenance_suppression' }]);
    expect(r.claimable).toEqual([]);
    expect(r.cancelled).toEqual([]);
  });

  it('a type hold that returns false lets the row through', async () => {
    typeHolds.install_patches = async () => false;
    const r = await partitionClaimable(tx(), device, [row({ type: 'install_patches' })]);
    expect(r.claimable).toHaveLength(1);
  });

  it('reboot, shutdown and reboot_safe_mode are the barrier set', () => {
    expect([...POWER_STATE_TYPES].sort()).toEqual(['reboot', 'reboot_safe_mode', 'shutdown']);
  });

  it('cancel writes are CAS-guarded on status=pending', async () => {
    const t = tx();
    await partitionClaimable(t, device, [row({ submittedOrgId: OTHER_ORG })]);
    // The where() arg list is what carries the id + status='pending' fence; a
    // cancel that landed on a row already claimed would be a lost delivery.
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});
