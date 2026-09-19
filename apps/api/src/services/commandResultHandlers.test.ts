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
