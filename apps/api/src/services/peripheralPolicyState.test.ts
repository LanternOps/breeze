import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assertDeviceExecuteAllowedMock, loadEffectivePolicyMock, txMock } = vi.hoisted(() => ({
  assertDeviceExecuteAllowedMock: vi.fn(async () => undefined),
  loadEffectivePolicyMock: vi.fn(),
  txMock: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  db: {
    transaction: vi.fn((fn: (tx: typeof txMock) => unknown) => fn(txMock)),
  },
}));
vi.mock('./peripheralEffectivePolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./peripheralEffectivePolicy')>()),
  loadAndResolveEffectivePeripheralPolicySetInCurrentDbContext: loadEffectivePolicyMock,
}));
vi.mock('./partnerTrust.commands', async () => ({
  ...(await vi.importActual<typeof import('./partnerTrust.commands')>('./partnerTrust.commands')),
  assertDeviceExecuteAllowed: assertDeviceExecuteAllowedMock,
}));
import {
  planPeripheralPolicyReconciliation,
  planPeripheralPolicyResult,
  reconcilePeripheralPolicyDevice,
  type PeripheralPolicyStateSnapshot,
} from './peripheralPolicyState';
import type {
  PeripheralDeviceIdentity,
  PeripheralPolicyV2,
} from './peripheralEffectivePolicy';
import { TrustDeniedError } from './partnerTrust.commands';

const identity: PeripheralDeviceIdentity = {
  deviceId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  partnerId: '00000000-0000-4000-8000-000000000003',
  siteId: '00000000-0000-4000-8000-000000000004',
  groupIds: [],
};

const effectivePolicies: PeripheralPolicyV2[] = [{
  policyId: '00000000-0000-4000-8000-000000000005',
  source: 'organization',
  effectiveClass: 'storage',
  configuredClass: 'storage',
  action: 'block',
  priority: 100,
  exceptions: [],
}];

function snapshot(overrides: Partial<PeripheralPolicyStateSnapshot>): PeripheralPolicyStateSnapshot {
  return {
    desiredPhase: 'clear_legacy',
    desiredRevision: 1,
    desiredDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    deliveryStatus: 'pending',
    appliedPhase: null,
    appliedRevision: null,
    appliedDigest: null,
    ...overrides,
  };
}

describe('planPeripheralPolicyReconciliation', () => {
  it('admits a device through an empty clear_legacy envelope before enforcement', () => {
    const planned = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: null,
      generatedAt: '2026-08-25T12:00:00.000Z',
      reason: 'policy_changed',
    });

    expect(planned.kind).toBe('queued');
    if (planned.kind !== 'queued') return;
    expect(planned.envelope).toMatchObject({
      schemaVersion: 2,
      phase: 'clear_legacy',
      revision: 1,
      effectivePolicies: [],
    });
  });

  it('coalesces while the exact clear_legacy revision is still pending', () => {
    const first = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: null,
      generatedAt: '2026-08-25T12:00:00.000Z',
      reason: 'policy_changed',
    });
    if (first.kind !== 'queued') throw new Error('expected initial queue');

    expect(planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies: [{ ...effectivePolicies[0]!, action: 'allow' }],
      currentState: snapshot({ desiredDigest: first.envelope.digest }),
      generatedAt: '2026-08-25T12:01:00.000Z',
      reason: 'membership_changed',
    })).toEqual({ kind: 'coalesced' });
  });

  it('queues enforcement only after the exact clear revision and digest are applied', () => {
    const clear = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: null,
      generatedAt: '2026-08-25T12:00:00.000Z',
      reason: 'policy_changed',
    });
    if (clear.kind !== 'queued') throw new Error('expected initial queue');

    const planned = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: snapshot({
        desiredDigest: clear.envelope.digest,
        deliveryStatus: 'applied',
        appliedPhase: 'clear_legacy',
        appliedRevision: 1,
        appliedDigest: clear.envelope.digest,
      }),
      generatedAt: '2026-08-25T12:01:00.000Z',
      reason: 'clear_legacy_applied',
    });

    expect(planned.kind).toBe('queued');
    if (planned.kind !== 'queued') return;
    expect(planned.envelope).toMatchObject({
      phase: 'enforce',
      revision: 2,
      effectivePolicies,
    });
  });

  it('coalesces an unchanged enforce digest and allocates a new revision for changed policy', () => {
    const base = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: snapshot({
        deliveryStatus: 'applied',
        appliedPhase: 'clear_legacy',
        appliedRevision: 1,
        appliedDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
      generatedAt: '2026-08-25T12:01:00.000Z',
      reason: 'clear_legacy_applied',
    });
    if (base.kind !== 'queued') throw new Error('expected enforce queue');
    const current = snapshot({
      desiredPhase: 'enforce',
      desiredRevision: 2,
      desiredDigest: base.envelope.digest,
      deliveryStatus: 'applied',
      appliedPhase: 'enforce',
      appliedRevision: 2,
      appliedDigest: base.envelope.digest,
    });

    expect(planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: current,
      generatedAt: '2026-08-25T12:02:00.000Z',
      reason: 'periodic_drift',
    })).toEqual({ kind: 'coalesced' });

    const changed = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies: [{ ...effectivePolicies[0]!, action: 'allow' }],
      currentState: current,
      generatedAt: '2026-08-25T12:03:00.000Z',
      reason: 'policy_changed',
    });
    expect(changed.kind).toBe('queued');
    if (changed.kind !== 'queued') expect.unreachable();
    expect(changed.envelope.revision).toBe(3);
    expect(changed.envelope.digest).not.toBe(base.envelope.digest);
  });

  it('allocates a fresh revision when an unchanged desired envelope was rejected', () => {
    const base = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: snapshot({
        deliveryStatus: 'applied',
        appliedPhase: 'clear_legacy',
        appliedRevision: 1,
        appliedDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
      generatedAt: '2026-08-25T12:01:00.000Z',
      reason: 'clear_legacy_applied',
    });
    if (base.kind !== 'queued') throw new Error('expected enforce queue');

    const retried = planPeripheralPolicyReconciliation({
      identity,
      effectivePolicies,
      currentState: snapshot({
        desiredPhase: 'enforce',
        desiredRevision: 2,
        desiredDigest: base.envelope.digest,
        deliveryStatus: 'rejected',
        appliedPhase: 'clear_legacy',
        appliedRevision: 1,
        appliedDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
      generatedAt: '2026-08-25T12:02:00.000Z',
      reason: 'periodic_drift',
    });

    expect(retried.kind).toBe('queued');
    if (retried.kind !== 'queued') return;
    expect(retried.envelope.revision).toBe(3);
  });
});

describe('planPeripheralPolicyResult', () => {
  const desired = snapshot({
    desiredDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  it('rejects a result for a different revision or digest without changing projection', () => {
    expect(planPeripheralPolicyResult(desired, {
      schemaVersion: 2,
      phase: 'clear_legacy',
      revision: 2,
      digest: desired.desiredDigest,
      outcome: 'applied',
    })).toEqual({ accepted: false, scheduleEnforce: false });
  });

  it('advances an exact clear result and requests post-commit enforcement', () => {
    expect(planPeripheralPolicyResult(desired, {
      schemaVersion: 2,
      phase: 'clear_legacy',
      revision: 1,
      digest: desired.desiredDigest,
      outcome: 'applied',
    })).toEqual({
      accepted: true,
      deliveryStatus: 'applied',
      lastErrorCode: null,
      scheduleEnforce: true,
    });
  });
});

describe('reconcilePeripheralPolicyDevice trust gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txMock.select
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: () => Promise.resolve([{
                id: identity.deviceId,
                orgId: identity.orgId,
                peripheralPolicyProtocolVersion: 2,
              }]),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => ({ for: () => Promise.resolve([]) }) }),
        }),
      });
    loadEffectivePolicyMock.mockResolvedValue({ identity, effectivePolicies });
  });

  it('warns and skips all writes when partner trust denies the policy push', async () => {
    assertDeviceExecuteAllowedMock.mockRejectedValueOnce(
      new TrustDeniedError(
        'TRUST_PROBATION',
        'Partner verification is required.',
        identity.deviceId,
        'peripheral_policy_sync_v2',
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(reconcilePeripheralPolicyDevice(identity.deviceId, 'policy_changed'))
      .resolves.toBe('incompatible');

    expect(assertDeviceExecuteAllowedMock).toHaveBeenCalledWith(
      identity.deviceId,
      'peripheral_policy_sync_v2',
      null,
    );
    expect(txMock.insert).not.toHaveBeenCalled();
    expect(txMock.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Skipping peripheral policy push because partner trust denied device execution',
      { deviceId: identity.deviceId, code: 'TRUST_PROBATION' },
    );
    warn.mockRestore();
  });

  it('preserves the existing queued flow when partner trust allows the policy push', async () => {
    txMock.insert
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'command-1' }]) }),
      })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    await expect(reconcilePeripheralPolicyDevice(identity.deviceId, 'policy_changed'))
      .resolves.toBe('queued');

    expect(txMock.insert).toHaveBeenCalledTimes(3);
  });
});
