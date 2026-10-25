import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool catalog W04 (#5219), plan Task A8 / Decision 8 — run slots and the
 * active-run cap. Branch logic against the mocked SQL boundary (runStore.ts);
 * the advisory lock and the counts are proven on a real database
 * (flowRunLease.integration.test.ts).
 */
const h = vi.hoisted(() => ({
  store: {
    lockOwnerSlots: vi.fn(async () => {}),
    loadSlotSnapshot: vi.fn(),
    casRunToRunning: vi.fn(),
    countActiveRunsForOwner: vi.fn(),
    flowOwnerKey: (o: { orgId: string | null; partnerId: string }) => (o.orgId ? `org:${o.orgId}` : `partner:${o.partnerId}`),
  },
  maxRunning: 20,
  order: [] as string[],
}));

vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: async (fn: () => unknown) => {
    h.order.push('tx:begin');
    const out = await fn();
    h.order.push('tx:commit');
    return out;
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./runStore', () => h.store);
vi.mock('../../config/env', () => ({ flowMaxRunningPerOwner: () => h.maxRunning }));

import { assertActiveCapacity, assertFlowRunAdmission, claimRunSlot } from './runAdmission';

const RUN = { id: 'bbbbbbbb-0000-4000-8000-000000000001', flowId: 'eeeeeeee-0000-4000-8000-000000000001', orgId: 'cccccccc-0000-4000-8000-000000000001' };
const OWNER = { orgId: RUN.orgId, partnerId: 'dddddddd-0000-4000-8000-000000000001' };
const PARTNER_OWNER = { orgId: null, partnerId: OWNER.partnerId };
const TOKEN = 'aaaaaaaa-0000-4000-8000-000000000009';

function snapshot(over: Partial<{ status: string; leaseToken: string | null; otherRunningForFlowOrg: boolean; ownerRunning: number }> = {}) {
  return {
    self: { status: over.status ?? 'queued', leaseToken: over.leaseToken === undefined ? TOKEN : over.leaseToken },
    otherRunningForFlowOrg: over.otherRunningForFlowOrg ?? false,
    ownerRunning: over.ownerRunning ?? 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.maxRunning = 20;
  h.store.casRunToRunning.mockResolvedValue(true);
});

describe('claimRunSlot', () => {
  it('takes the owner advisory lock first, then CASes the run to running', async () => {
    h.store.lockOwnerSlots.mockImplementationOnce(async () => { h.order.push('lock'); });
    h.store.loadSlotSnapshot.mockImplementationOnce(async () => { h.order.push('snapshot'); return snapshot(); });
    h.store.casRunToRunning.mockImplementationOnce(async () => { h.order.push('cas'); return true; });
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(true);
    expect(h.order).toEqual(['tx:begin', 'lock', 'snapshot', 'cas', 'tx:commit']);
    expect(h.store.lockOwnerSlots).toHaveBeenCalledWith(`org:${OWNER.orgId}`);
    expect(h.store.casRunToRunning).toHaveBeenCalledWith(RUN.id, TOKEN);
  });

  it('a partner-wide flow locks on the partner key', async () => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot());
    await claimRunSlot(RUN, PARTNER_OWNER, TOKEN);
    expect(h.store.lockOwnerSlots).toHaveBeenCalledWith(`partner:${OWNER.partnerId}`);
  });

  it('second running run for the same (flow, org) is refused', async () => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ otherRunningForFlowOrg: true }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(false);
    expect(h.store.casRunToRunning).not.toHaveBeenCalled();
  });

  it('a parked run does not hold the slot (only running runs are counted)', async () => {
    // loadSlotSnapshot counts status = 'running' only; waiting /
    // awaiting_approval siblings are invisible to it.
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ otherRunningForFlowOrg: false, ownerRunning: 0 }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(true);
  });

  it('owner cap 20: the 21st running run is refused, the 20th admitted', async () => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ ownerRunning: 19 }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(true);
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ ownerRunning: 20 }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(false);
  });

  it('honours FLOW_MAX_RUNNING_PER_OWNER', async () => {
    h.maxRunning = 2;
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ ownerRunning: 2 }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(false);
  });

  it('a run already running (stalled redelivery under a fresh lease) holds its own slot', async () => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ status: 'running', ownerRunning: 99, otherRunningForFlowOrg: true }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(true);
    expect(h.store.casRunToRunning).not.toHaveBeenCalled();
  });

  it.each(['queued', 'waiting', 'awaiting_approval'])('admits from %s', async (status) => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ status }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(true);
  });

  it('a lease that is no longer ours is refused without a write', async () => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ leaseToken: 'aaaaaaaa-0000-4000-8000-0000000000ff' }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(false);
    expect(h.store.casRunToRunning).not.toHaveBeenCalled();
  });

  it('a terminal run is refused', async () => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot({ status: 'cancelled' }));
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(false);
  });

  it('a lost CAS is a refusal', async () => {
    h.store.loadSlotSnapshot.mockResolvedValueOnce(snapshot());
    h.store.casRunToRunning.mockResolvedValueOnce(false);
    await expect(claimRunSlot(RUN, OWNER, TOKEN)).resolves.toBe(false);
  });
});

describe('assertActiveCapacity / assertFlowRunAdmission', () => {
  it('active cap 1,000 counts parked runs (the count covers every active status)', async () => {
    h.store.countActiveRunsForOwner.mockResolvedValueOnce(999);
    await expect(assertActiveCapacity(OWNER)).resolves.toEqual({ ok: true });
    h.store.countActiveRunsForOwner.mockResolvedValueOnce(1000);
    await expect(assertActiveCapacity(OWNER)).resolves.toEqual({ ok: false, error: 'flow_queue_full' });
  });

  it('assertFlowRunAdmission is exactly assertActiveCapacity in W04', async () => {
    h.store.countActiveRunsForOwner.mockResolvedValueOnce(1000);
    await expect(assertFlowRunAdmission(OWNER, RUN.flowId)).resolves.toEqual({ ok: false, error: 'flow_queue_full' });
    h.store.countActiveRunsForOwner.mockResolvedValueOnce(3);
    await expect(assertFlowRunAdmission(PARTNER_OWNER, RUN.flowId)).resolves.toEqual({ ok: true });
    expect(h.store.countActiveRunsForOwner).toHaveBeenLastCalledWith(PARTNER_OWNER);
  });
});
