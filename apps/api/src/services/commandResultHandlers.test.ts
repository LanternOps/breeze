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

// Learned networks (#12369) Task 10: the persisted discovery result handler verifies before it enqueues.
const { discoverySelectMock, discoveryUpdateMock, enqueueDiscoveryResultsMock, lockSitesMock, verifyMock } = vi.hoisted(() => ({
  discoverySelectMock: vi.fn(),
  discoveryUpdateMock: vi.fn(),
  enqueueDiscoveryResultsMock: vi.fn(async (..._a: unknown[]) => 'queued'),
  lockSitesMock: vi.fn(async (..._a: unknown[]) => undefined),
  verifyMock: vi.fn(),
}));
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: { ...actual.db, select: discoverySelectMock, update: discoveryUpdateMock },
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../jobs/discoveryWorker', () => ({
  enqueueDiscoveryResults: (...a: unknown[]) => enqueueDiscoveryResultsMock(...a),
}));
vi.mock('./redis', () => ({ isRedisAvailable: vi.fn(() => true), getRedis: vi.fn(() => null) }));
vi.mock('./learnedNetworks/siteLock', () => ({
  lockSitesForNetworkGate: (...a: unknown[]) => lockSitesMock(...a),
}));
vi.mock('./learnedNetworks/verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./learnedNetworks/verify')>();
  return { ...actual, verifyDiscoveryResult: (...a: unknown[]) => verifyMock(...a) };
});

import { commandResultHandlers, type CommandResultHandler } from './commandResultHandlers';
import { GATE_FAILURE_MESSAGES } from './learnedNetworks/messages';

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

// #6974: mssql_restore / hyperv_restore are dispatched async (#6437) with the
// restore_jobs row linked by command id — the terminal result must close it.
describe.each(['mssql_restore', 'hyperv_restore'] as const)('%s result handler (#6974)', (type) => {
  beforeEach(() => vi.clearAllMocks());

  const COMMAND_ID = '55555555-5555-4555-8555-555555555555';
  const DEVICE_ID = '66666666-6666-4666-8666-666666666666';

  it('is registered', () => {
    expect(commandResultHandlers[type]).toBeTypeOf('function');
  });

  it('closes the restore job by the transport-authorized command id', async () => {
    const result = { status: 'completed', result: { status: 'completed', databaseName: 'AppDb' } };
    await commandResultHandlers[type]!({
      agentId: 'agent-1',
      commandId: COMMAND_ID,
      resolvedDeviceId: DEVICE_ID,
      command: { id: COMMAND_ID, type, payload: {} } as never,
      result: result as never,
      stdout: undefined,
    });
    expect(updateRestoreJobByCommandIdMock).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      deviceId: DEVICE_ID,
      commandType: type,
      result,
    });
  });
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

describe('network discovery results are verified before they are enqueued (#12369)', () => {
  const CMD_ID = '9a1c2e3f-4b5d-4c6e-8f70-112233445566';
  const JOB_ID = '9b2d3f40-5c6e-4d7f-8a81-223344556677';
  const ORG_ID = '9c3e4051-6d7f-4e80-8b92-334455667788';
  const SITE_ID = '9d4f5162-7e80-4f91-8ca3-445566778899';
  const PROFILE_ID = '9e506273-8f91-40a2-8db4-5566778899aa';
  const GATEWAY_ID = '9f617384-90a2-41b3-8ec5-66778899aabb';
  const NETWORK_ID = 'a0728495-a1b3-42c4-8fd6-778899aabbcc';
  const VN = {
    networkId: NETWORK_ID,
    gatewayId: GATEWAY_ID,
    gatewayAddress: '192.168.1.1',
    gatewayMac: 'a4:2b:b0:11:22:9c',
    interfaceName: 'eth0',
  };
  const DISPATCH = {
    version: 1,
    mode: 'guarded',
    agentId: 'agent-1',
    deviceId: 'a1839516-b2c4-43d5-80e7-8899aabbccdd',
    allowedNetworkIds: [NETWORK_ID],
    allowedGatewayIds: [GATEWAY_ID],
    decidedAt: '2026-11-22T10:00:00.000Z',
  };
  const HOST = { ip: '192.168.1.20', hostname: 'LAPTOP-JS', assetType: 'workstation' };
  const UNVERIFIED = { code: 'network_unverified', message: GATE_FAILURE_MESSAGES.network_unverified };
  const handler = commandResultHandlers.network_discovery_guarded!;
  const setSpy = vi.fn((_values: Record<string, unknown>) => ({ where: () => Promise.resolve([]) }));

  function input(
    type: string,
    payload: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Parameters<CommandResultHandler>[0] {
    return {
      agentId: 'agent-1', commandId: CMD_ID,
      command: { id: CMD_ID, type, payload, submittedOrgId: ORG_ID } as never,
      resolvedDeviceId: 'dev-1', result: { status: 'completed', ...result } as never, stdout: undefined,
    };
  }
  function updateSet(): Record<string, unknown> | undefined {
    return setSpy.mock.calls[0]?.[0];
  }
  /** #12502: the handler returns the enqueue; the transport runs it after its transaction commits. */
  async function deliverAfterCommit(outcome: Awaited<ReturnType<CommandResultHandler>>): Promise<void> {
    expect(outcome).toMatchObject({ kind: 'afterCommit' });
    expect(enqueueDiscoveryResultsMock).not.toHaveBeenCalled();
    await (outcome as { run: () => Promise<void> }).run();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    discoverySelectMock.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([
        { orgId: ORG_ID, siteId: SITE_ID, profileId: PROFILE_ID, networkDispatch: DISPATCH },
      ]) }) }),
    });
    discoveryUpdateMock.mockReturnValue({ set: setSpy });
    verifyMock.mockResolvedValue({ ok: true, networkId: NETWORK_ID });
  });

  it('registers one handler for both discovery types', () => {
    expect(handler).toBeTypeOf('function');
    expect(handler).toBe(commandResultHandlers.network_discovery);
  });

  it('discards an unverified result and enqueues nothing', async () => {
    verifyMock.mockResolvedValue({ ok: false, error: UNVERIFIED });
    await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST] } }));
    expect(updateSet()).toMatchObject({ status: 'failed', errors: UNVERIFIED });
    expect(enqueueDiscoveryResultsMock).not.toHaveBeenCalled();
  });

  it('takes the shared site lock before it verifies, with the job placement and the attempt record', async () => {
    await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST], verifiedNetwork: VN } }));
    expect(lockSitesMock).toHaveBeenCalledWith([SITE_ID], 'shared');
    expect(verifyMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      siteId: SITE_ID,
      profileId: PROFILE_ID,
      attempt: { mode: 'guarded', allowedGatewayIds: [GATEWAY_ID] },
      verifiedNetwork: VN,
    });
    expect(lockSitesMock.mock.invocationCallOrder[0]!).toBeLessThan(verifyMock.mock.invocationCallOrder[0]!);
  });

  it('stores a refusal code', async () => {
    await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { status: 'failed', errorCode: 'network_changed', error: 'x' }));
    expect(updateSet()).toMatchObject({
      status: 'failed',
      errors: { code: 'network_changed', message: GATE_FAILURE_MESSAGES.network_changed },
    });
    expect(verifyMock).not.toHaveBeenCalled();
    expect(enqueueDiscoveryResultsMock).not.toHaveBeenCalled();
  });

  it('stores a network_mismatch refusal with its message', async () => {
    await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { status: 'failed', errorCode: 'network_mismatch', error: 'x' }));
    expect(updateSet()).toMatchObject({
      status: 'failed',
      errors: { code: 'network_mismatch', message: GATE_FAILURE_MESSAGES.network_mismatch },
    });
  });

  it('leaves any other failure as it was (no job write)', async () => {
    await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { status: 'failed', errorCode: 'timeout', error: 'x' }));
    expect(discoveryUpdateMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('enqueues a verified result with its verifiedNetwork', async () => {
    await deliverAfterCommit(await handler(input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST], verifiedNetwork: VN } })));
    expect(enqueueDiscoveryResultsMock).toHaveBeenCalledTimes(1);
    expect(enqueueDiscoveryResultsMock.mock.calls[0]![9]).toEqual(VN);
    expect(discoveryUpdateMock).not.toHaveBeenCalled();
  });

  it('passes no verifiedNetwork to the queue when the upload does not parse', async () => {
    verifyMock.mockResolvedValue({ ok: true, networkId: null });
    await deliverAfterCommit(await handler(input('network_discovery', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST], verifiedNetwork: { gatewayId: 'nope' } } })));
    expect(enqueueDiscoveryResultsMock).toHaveBeenCalledTimes(1);
    expect(enqueueDiscoveryResultsMock.mock.calls[0]![9]).toBeUndefined();
  });

  it('reads verifiedNetwork from stdout when the REST route delivers the body there (C7)', async () => {
    await deliverAfterCommit(await handler({
      ...input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST] } }),
      stdout: JSON.stringify({ jobId: JOB_ID, hosts: [HOST], verifiedNetwork: VN }),
    }));
    expect(verifyMock.mock.calls[0]![0]).toMatchObject({ verifiedNetwork: VN });
    expect(enqueueDiscoveryResultsMock.mock.calls[0]![9]).toEqual(VN);
  });

  it('treats unparseable stdout as no verifiedNetwork', async () => {
    await handler({
      ...input('network_discovery_guarded', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [HOST] } }),
      stdout: 'not json',
    });
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock.mock.calls[0]![0]).toMatchObject({ verifiedNetwork: undefined });
  });

  it('does nothing for a command without a jobId (the AI tool)', async () => {
    await handler(input('network_discovery_guarded', { subnets: ['192.168.1.0/24'] }, { result: { hosts: [HOST] } }));
    await handler(input('network_discovery_guarded', { subnets: ['192.168.1.0/24'] }, { status: 'failed', errorCode: 'network_mismatch' }));
    expect(discoveryUpdateMock).not.toHaveBeenCalled();
    expect(lockSitesMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
    expect(enqueueDiscoveryResultsMock).not.toHaveBeenCalled();
  });
});
