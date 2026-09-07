import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const {
  assertAllowedMock,
  userStatusMock,
  updateMock,
  setMock,
  whereMock,
  returningMock,
  propagateMock,
  captureExceptionMock,
} = vi.hoisted(() => ({
  assertAllowedMock: vi.fn(),
  userStatusMock: vi.fn(),
  updateMock: vi.fn(),
  setMock: vi.fn(),
  whereMock: vi.fn(),
  returningMock: vi.fn(),
  propagateMock: vi.fn(),
  captureExceptionMock: vi.fn(),
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
vi.mock('./sentry', () => ({ captureException: (...a: unknown[]) => captureExceptionMock(...(a as [])) }));
// #5128 review round 2 — the claim-time cancel must terminalise the OWNING
// record (script_executions / deployment_results) inside the SAME transaction.
// Mocked at the seam so this suite can assert exactly which rows reach it.
vi.mock('./commandCancelPropagation', () => ({
  propagateCancelledDeviceCommands: (...a: unknown[]) => propagateMock(...(a as [])),
}));

import {
  POWER_STATE_BARRIER_TYPES,
  partitionClaimable,
  registerTypeHold,
  typeHolds,
  __resetEligibilityFaultThrottleForTests,
  __resetTypeHoldsForTests,
} from './commandClaimEligibility';

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
  payload: null,
  ...over,
});

/**
 * The cancel UPDATE now ends in `.returning({ id })` — only a row the CAS
 * actually flipped may be propagated. `returningMock` therefore decides, per
 * call, whether that row "won"; the default says every cancel won.
 */
function tx() {
  returningMock.mockResolvedValue([{ id: 'flipped' }]);
  whereMock.mockReturnValue({ returning: (...a: unknown[]) => returningMock(...(a as [])) });
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
    __resetTypeHoldsForTests();
    __resetEligibilityFaultThrottleForTests();
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

  it('a non-trust error from the trust check HOLDS the row — never claims it, never poisons the heartbeat', async () => {
    // This runs inside the heartbeat's claim transaction. Rethrowing would 500
    // the heartbeat, and since the row stays pending it would be re-selected on
    // every retry — one deterministic fault would stop the device checking in
    // at all. Fail-closed (not delivered) without that blast radius.
    assertAllowedMock.mockRejectedValue(new Error('db down'));
    const r = await partitionClaimable(tx(), device, [row()]);
    expect(r.claimable).toEqual([]);
    expect(r.cancelled).toEqual([]);
    expect(r.held).toEqual([{ id: 'c1', reason: 'eligibility_check_failed' }]);
  });

  it('a trust-check fault on one row does not withhold its healthy siblings', async () => {
    assertAllowedMock.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const r = await partitionClaimable(tx(), device, [row({ id: 'bad' }), row({ id: 'good' })]);
    expect(r.held).toEqual([{ id: 'bad', reason: 'eligibility_check_failed' }]);
    expect(r.claimable.map((x) => x.id)).toEqual(['good']);
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
    expect([...POWER_STATE_BARRIER_TYPES].sort()).toEqual(['reboot', 'reboot_safe_mode', 'shutdown']);
  });

  it('cancel writes are CAS-guarded on the id AND status=pending', async () => {
    const t = tx();
    await partitionClaimable(t, device, [row({ submittedOrgId: OTHER_ORG })]);
    expect(whereMock).toHaveBeenCalledTimes(1);

    // Compile the ACTUAL predicate rather than asserting the spy was called:
    // the mocked columns are plain strings, so they render as bound params and
    // the exact fence is checkable. Without this, dropping
    // `eq(status,'pending')` from the cancel would leave this test green while
    // production cancelled rows the agent had already claimed — a lost delivery.
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereMock.mock.calls[0]![0] as never);
    expect(params).toEqual(['dc.id', 'c1', 'dc.status', 'pending']);
    expect(sqlText).toContain('and');
  });

  it('a legacy row (deliver_by NULL) with no submitted_org_id is still delivered', async () => {
    const r = await partitionClaimable(tx(), device, [row({ submittedOrgId: null, deliverBy: null })]);
    expect(r.claimable).toHaveLength(1);
    expect(r.cancelled).toEqual([]);
  });

  it('a post-#5128 row whose submitted_org_id went NULL is refused, not delivered', async () => {
    // `deliver_by` set means the enqueue path stamped `submitted_org_id`; a NULL
    // can then only come from the FK's ON DELETE SET NULL, i.e. the originating
    // org was erased. Delivering it would silently pass the org check by
    // destroying the fact it compares against (the org-merge-then-erase path).
    const r = await partitionClaimable(tx(), device, [
      row({ submittedOrgId: null, deliverBy: new Date(Date.now() + 3600_000) }),
    ]);
    expect(r.cancelled).toEqual([{ id: 'c1', reason: 'submitter_org_erased' }]);
    expect(r.claimable).toEqual([]);
  });
  // ── Claim-time cancellation must terminalise the OWNING record ──────────
  //
  // A cancelled command is TERMINAL, so the command reaper (which scans only
  // pending/sent) never revisits it. Without propagation the owning
  // script_executions / deployment_results row sits `pending` forever — the
  // exact silent death #5128 exists to remove, and the same contract the
  // cancel-on-event sweeps (moveOrg.ts, core.ts) already honour.

  it('propagates the cancel to the owning records inside the SAME transaction', async () => {
    const t = tx();
    await partitionClaimable(t, device, [
      row({ id: 'c1', type: 'script', payload: { executionId: 'exec-1' }, submittedOrgId: OTHER_ORG }),
    ]);

    expect(propagateMock).toHaveBeenCalledTimes(1);
    const [subjects, completedAt, executor] = propagateMock.mock.calls[0]!;
    expect(subjects).toEqual([{ id: 'c1', type: 'script', payload: { executionId: 'exec-1' } }]);
    expect(completedAt).toBeInstanceOf(Date);
    // The transaction handle, not the ambient db: a rollback of the claim must
    // roll the owning record back with it.
    expect(executor).toBe(t);
  });

  it('a row whose CAS matched nothing is NOT propagated', async () => {
    // The row lost the race to a concurrent claim, so it is being DELIVERED.
    // Cancelling its script execution would terminalise work about to run on
    // the machine.
    const t = tx();
    // The second cancel's CAS matches zero rows.
    returningMock.mockReset();
    returningMock.mockResolvedValueOnce([{ id: 'won' }]).mockResolvedValueOnce([]);

    await partitionClaimable(t, device, [
      row({ id: 'won', type: 'script', payload: { executionId: 'exec-won' }, submittedOrgId: OTHER_ORG }),
      row({ id: 'lost', type: 'script', payload: { executionId: 'exec-lost' }, submittedOrgId: OTHER_ORG }),
    ]);

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(propagateMock).toHaveBeenCalledTimes(1);
    expect(propagateMock.mock.calls[0]![0]).toEqual([
      { id: 'won', type: 'script', payload: { executionId: 'exec-won' } },
    ]);
  });

  it('nothing cancelled → the propagator is never called', async () => {
    await partitionClaimable(tx(), device, [row()]);
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it('a non-object payload reaches the propagator as null rather than crashing it', async () => {
    await partitionClaimable(tx(), device, [
      row({ id: 'c1', type: 'script', payload: 'not-an-object', submittedOrgId: OTHER_ORG }),
    ]);
    expect(propagateMock.mock.calls[0]![0]).toEqual([{ id: 'c1', type: 'script', payload: null }]);
  });

  // ── Uninstall drain exemption ───────────────────────────────────────────

  it('a queued self_uninstall survives an inactive requester', async () => {
    // Remove-with-uninstall is routinely queued by a tech who leaves before the
    // machine next checks in. Cancelling it here leaves the agent installed on
    // a customer box the MSP has decided to stop managing — the same drain
    // core.ts protects with its ne(type,'self_uninstall') exclusion.
    userStatusMock.mockResolvedValue([{ status: 'disabled' }]);
    const r = await partitionClaimable(tx(), device, [
      row({ id: 'u', type: 'self_uninstall', createdBy: USER }),
      row({ id: 'other', createdBy: USER }),
    ]);
    expect(r.claimable.map((x) => x.id)).toEqual(['u']);
    expect(r.cancelled).toEqual([{ id: 'other', reason: 'requester_inactive' }]);
  });

  it('a self_uninstall survives EVERY cancel at once: decommissioned + trust-denied + inactive tech + org drift', async () => {
    // #3986 regression (caught by deviceUninstallDrain.integration.test.ts):
    // every one of these checks asks "should this device still work for this
    // tenant?", and for a removal the answer is always yes. The drain has its
    // own deadline (device_remove_expires_at) and its own auth gate
    // (agentAuth's drain window); cancelling it strands an agent on a machine
    // the MSP has stopped managing.
    const { TrustDeniedError } = await import('./partnerTrust.commands');
    assertAllowedMock.mockRejectedValue(
      new TrustDeniedError('TRUST_RESTRICTED', 'suspended', 'd1', 'self_uninstall'),
    );
    userStatusMock.mockResolvedValue([{ status: 'disabled' }]);

    const r = await partitionClaimable(tx(), { ...device, status: 'decommissioned' }, [
      row({
        id: 'u',
        type: 'self_uninstall',
        createdBy: USER,
        submittedOrgId: OTHER_ORG,
        deliverBy: new Date(Date.now() + 3600_000),
      }),
    ]);

    expect(r.claimable.map((x) => x.id)).toEqual(['u']);
    expect(r.cancelled).toEqual([]);
    expect(r.held).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
    // The trust check is not even consulted — the drain short-circuits first.
    expect(assertAllowedMock).not.toHaveBeenCalled();
  });

  // ── Registry guard + Sentry throttle ────────────────────────────────────

  it('registerTypeHold refuses to overwrite an existing hold', () => {
    registerTypeHold('install_patches', async () => true);
    expect(() => registerTypeHold('install_patches', async () => false)).toThrow(
      /already registered for "install_patches"/,
    );
    expect(typeHolds.install_patches).toBeDefined();
  });

  it('the eligibility-fault Sentry capture is throttled per device, but the log is not', async () => {
    // One partner-trust outage would otherwise emit one event per row per
    // heartbeat per device.
    assertAllowedMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await partitionClaimable(tx(), device, [row({ id: 'a' }), row({ id: 'b' })]);
      await partitionClaimable(tx(), device, [row({ id: 'c' })]);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(3);

      // A DIFFERENT device is a different fault surface and still reports.
      await partitionClaimable(tx(), { ...device, id: 'd2' }, [row({ id: 'd' })]);
      expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
