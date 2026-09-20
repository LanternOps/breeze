import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlePeripheralPolicyResultV2Mock, recordPamActuationResultMock } = vi.hoisted(() => ({
  handlePeripheralPolicyResultV2Mock: vi.fn().mockResolvedValue('applied'),
  recordPamActuationResultMock: vi.fn().mockResolvedValue('applied'),
}));
vi.mock('./peripheralPolicyState', () => ({
  handlePeripheralPolicyResultV2: (...args: unknown[]) =>
    handlePeripheralPolicyResultV2Mock(...(args as [])),
}));
vi.mock('./pamActuationResult', async (importOriginal) => {
  const original = await importOriginal<typeof import('./pamActuationResult')>();
  return { ...original, recordPamActuationResult: recordPamActuationResultMock };
});

// W05a bare_metal_rebuild: the handler updates the restore_jobs row by
// command id (existing path) and then applies the terminal status to the
// recovery row for an offline host whose progress posts never arrived.
const { updateRestoreJobByCommandIdMock, applyRebuildCommandResultMock } = vi.hoisted(() => ({
  updateRestoreJobByCommandIdMock: vi.fn(async () => undefined),
  applyRebuildCommandResultMock: vi.fn(async () => undefined),
}));
vi.mock('./restoreResultPersistence', async (importOriginal) => {
  const original = await importOriginal<typeof import('./restoreResultPersistence')>();
  return { ...original, updateRestoreJobByCommandId: updateRestoreJobByCommandIdMock };
});
vi.mock('./bareMetalRecoveryService', () => ({
  applyRebuildCommandResult: applyRebuildCommandResultMock,
}));

import { commandResultHandlers } from './commandResultHandlers';

describe('peripheral policy v2 command result handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the transport-authorized device and command ids to the shared state handler', async () => {
    const protocolResult = {
      schemaVersion: 2 as const,
      phase: 'clear_legacy' as const,
      revision: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      outcome: 'applied' as const,
    };

    await commandResultHandlers.peripheral_policy_sync_v2!({
      agentId: 'agent-1',
      commandId: '22222222-2222-4222-8222-222222222222',
      resolvedDeviceId: '11111111-1111-4111-8111-111111111111',
      command: { id: '22222222-2222-4222-8222-222222222222' } as never,
      result: { status: 'completed', result: protocolResult },
      stdout: undefined,
    });

    expect(handlePeripheralPolicyResultV2Mock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      protocolResult,
    );
  });

  it('drops malformed protocol output before it can alter desired state', async () => {
    await commandResultHandlers.peripheral_policy_sync_v2!({
      agentId: 'agent-1',
      commandId: '22222222-2222-4222-8222-222222222222',
      resolvedDeviceId: '11111111-1111-4111-8111-111111111111',
      command: { id: '22222222-2222-4222-8222-222222222222' } as never,
      result: { status: 'completed', result: { schemaVersion: 2, digest: 'bad' } },
      stdout: undefined,
    });

    expect(handlePeripheralPolicyResultV2Mock).not.toHaveBeenCalled();
  });
});

describe('PAM v2 command result handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['pam_apply_v2', 'pam_cleanup_v2'] as const)(
    'passes %s through the same authenticated result transaction',
    async (commandType) => {
      const protocolResult = {
        protocolVersion: 2 as const,
        observationId: '11111111-1111-4111-8111-111111111111',
        actuationId: '22222222-2222-4222-8222-222222222222',
        generation: 2,
        state: commandType === 'pam_apply_v2' ? 'verified_active' as const : 'received' as const,
        observedAt: '2026-08-25T12:00:00.000Z',
        evidence: { bootId: 'boot-1' },
      };
      const outcome = await commandResultHandlers[commandType]!({
        agentId: 'agent-1',
        commandId: '33333333-3333-4333-8333-333333333333',
        resolvedDeviceId: '44444444-4444-4444-8444-444444444444',
        command: { id: '33333333-3333-4333-8333-333333333333', type: commandType } as never,
        result: { status: 'completed', result: protocolResult },
        stdout: undefined,
      });
      expect(recordPamActuationResultMock).toHaveBeenCalledWith({
        agentId: 'agent-1',
        deviceId: '44444444-4444-4444-8444-444444444444',
        commandId: '33333333-3333-4333-8333-333333333333',
        result: protocolResult,
      });
      expect(outcome).toEqual({ kind: 'pam', classification: 'applied' });
    },
  );
});

describe('bare_metal_rebuild command result handler (W05a)', () => {
  beforeEach(() => vi.clearAllMocks());

  const COMMAND_ID = '55555555-5555-4555-8555-555555555555';
  const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
  const RECOVERY_ID = '77777777-7777-4777-8777-777777777777';
  const ORG_ID = '88888888-8888-4888-8888-888888888888';

  function run(result: Record<string, unknown>) {
    return commandResultHandlers.bare_metal_rebuild!({
      agentId: 'agent-1',
      commandId: COMMAND_ID,
      resolvedDeviceId: DEVICE_ID,
      command: { id: COMMAND_ID, type: 'bare_metal_rebuild', submittedOrgId: ORG_ID, payload: { recoveryId: RECOVERY_ID, target: { kind: 'vhdx', path: '/srv/x.vhdx' } } } as never,
      result: result as never,
      stdout: undefined,
    });
  }

  it('is registered', () => {
    expect(commandResultHandlers.bare_metal_rebuild).toBeTypeOf('function');
  });

  it('updates the restore job by the transport-authorized command id and completes an identity:new recovery', async () => {
    const result = { status: 'completed', result: { status: 'completed', phaseReached: 'convert', validated: true } };
    await run(result);

    expect(updateRestoreJobByCommandIdMock).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      deviceId: DEVICE_ID,
      commandType: 'bare_metal_rebuild',
      result,
    });
    expect(applyRebuildCommandResultMock).toHaveBeenCalledWith({ recoveryId: RECOVERY_ID, orgId: ORG_ID, result });
  });

  it('passes a refusal through so the recovery ends refused with the refusal as reason', async () => {
    const result = { status: 'failed', result: { status: 'refused', refusal: 'qemu-img not installed on this host; install qemu-utils' } };
    await run(result);
    expect(applyRebuildCommandResultMock).toHaveBeenCalledWith({ recoveryId: RECOVERY_ID, orgId: ORG_ID, result });
  });

  it('skips the recovery update when the payload carries no recoveryId, but still closes the restore job', async () => {
    await commandResultHandlers.bare_metal_rebuild!({
      agentId: 'agent-1',
      commandId: COMMAND_ID,
      resolvedDeviceId: DEVICE_ID,
      command: { id: COMMAND_ID, type: 'bare_metal_rebuild', submittedOrgId: ORG_ID, payload: null } as never,
      result: { status: 'failed', error: 'boom' } as never,
      stdout: undefined,
    });
    expect(updateRestoreJobByCommandIdMock).toHaveBeenCalledTimes(1);
    expect(applyRebuildCommandResultMock).not.toHaveBeenCalled();
  });
});
