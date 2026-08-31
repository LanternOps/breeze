import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlePeripheralPolicyResultV2Mock = vi.fn().mockResolvedValue('applied');
vi.mock('./peripheralPolicyState', () => ({
  handlePeripheralPolicyResultV2: (...args: unknown[]) =>
    handlePeripheralPolicyResultV2Mock(...(args as [])),
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
