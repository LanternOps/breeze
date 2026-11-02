import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ propagate: vi.fn() }));
vi.mock('../commandCancelPropagation', () => ({ propagateCancelledDeviceCommands: mocks.propagate }));
vi.mock('../partnerTrust.commands', () => ({
  createDeviceExecuteBatchGate: () => async () => {}, TrustDeniedError: class extends Error {},
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
import { partitionClaimable, revalidateCommandForDelivery } from '../commandClaimEligibility';
import { deviceNetworkIsolations } from '../../db/schema';
const device = { id: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222', status: 'online', orgType: 'customer', installIncarnation: 1 };
const isolationId = '33333333-3333-4333-8333-333333333333';
const episode = { id: isolationId, deviceId: device.id, state: 'verified', desiredState: 'isolated', generation: 2 };
function reader(rows: unknown[]) {
  const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn(async () => rows) };
  chain.from.mockReturnValue(chain); chain.where.mockReturnValue(chain);
  const tx = { select: vi.fn(() => chain), transaction: async (fn: (sp: unknown) => unknown) => fn(tx),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: async () => [{ id: 'command' }] })) })) })),
  };
  return { tx, chain };
}
function row(parameters: unknown) {
  return { id: 'command', type: 'execute_containment', deviceId: device.id, payload: { actionType: 'network_isolation', parameters }, deviceIncarnation: 1, createdBy: null, submittedOrgId: device.orgId, deliverBy: null };
}
beforeEach(() => vi.clearAllMocks());
describe('network isolation command bypasses', () => {
  it.each<[string, unknown, boolean]>([
    ['execute_containment', { actionType: 'network_isolation' }, true],
    ['release_containment', undefined, true],
    ['release_containment', {}, true],
    ['execute_containment', { actionType: 'process_kill' }, false],
    ['execute_containment', { actionType: 'account_disable' }, false],
    ['execute_containment', { actionType: 'usb_block' }, false],
    ['execute_containment', null, false],
    ['execute_containment', [], false],
    ['reboot', { actionType: 'network_isolation' }, false],
  ])('identifies %s %j as protected=%s', async (type, payload, protectedCommand) => {
    const { isNetworkIsolationCommand } = await import('./bypass');
    expect(isNetworkIsolationCommand(type, payload)).toBe(protectedCommand);
  });
  it.each<[string, unknown, unknown[]]>([
    ['legacy payload', undefined, []],
    ['missing generation', { isolationId }, [episode]],
    ['forged id', { isolationId: '44444444-4444-4444-8444-444444444444', generation: 2 }, []],
    ['stale generation', { isolationId, generation: 1 }, [episode]],
    ['resolved episode', { isolationId, generation: 2 }, [{ ...episode, state: 'released' }]],
    ['release requested', { isolationId, generation: 2 }, [{ ...episode, desiredState: 'released' }]],
    ['another device', { isolationId, generation: 2 }, [{ ...episode, deviceId: 'other-device' }]],
  ])('cancels %s at claim', async (_name, parameters, episodes) => {
    const { tx } = reader(episodes);
    const result = await partitionClaimable(tx as never, device, [row(parameters)]);
    expect(result.cancelled).toEqual([{ id: 'command', reason: 'isolation_episode_mismatch' }]);
    expect(result.claimable).toEqual([]);
    expect(result.held).toEqual([]);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(mocks.propagate).toHaveBeenCalledTimes(1);
  });
  it('delivers the current unresolved episode on its own device and generation', async () => {
    const { tx, chain } = reader([episode]);
    expect(await revalidateCommandForDelivery(tx as never, row({ isolationId, generation: 2 }))).toBeNull();
    expect(chain.from).toHaveBeenCalledWith(deviceNetworkIsolations);
    const query = new PgDialect().sqlToQuery(chain.where.mock.calls[0]![0]);
    expect(query.params).toContain(isolationId);
    expect(query.params).toContain(device.id);
  });
  it.each(['process_kill', 'account_disable', 'usb_block'])('preserves %s delivery', async actionType => {
    const { tx } = reader([]);
    expect(await revalidateCommandForDelivery(tx as never, { ...row({}), payload: { actionType } })).toBeNull();
    expect(tx.select).not.toHaveBeenCalled();
  });
  it.each(['update', 'update_agent', 'dev_update'])('cancels %s below the version floor while unresolved', async type => {
    const { tx } = reader([episode]);
    const result = await partitionClaimable(tx as never, device, [{ ...row({}), type, payload: { version: '1.0.0' } }]);
    expect(result.cancelled).toEqual([{ id: 'command', reason: 'network-isolation-version-floor' }]);
    expect(result.claimable).toEqual([]);
  });
  it.each(['update', 'update_agent', 'dev_update'])('allows %s after resolution and at the version floor', async type => {
    for (const [episodes, version] of [[[], '1.0.0'], [[episode], '999.0.0']] as const) {
      const { tx } = reader([...episodes]);
      expect(await revalidateCommandForDelivery(tx as never, { ...row({}), type, payload: { version } })).toBeNull();
    }
  });
  it('refuses a signed rollback to an agent below the floor', async () => {
    const { tx } = reader([episode]);
    const result = await partitionClaimable(tx as never, device, [{ ...row({}), type: 'agent_rollback_v1', payload: { targetVersion: '1.0.0' } }]);
    expect(result.cancelled).toEqual([{ id: 'command', reason: 'network-isolation-version-floor' }]);
  });
  it('allows signed rollback at the floor and after resolution', async () => {
    for (const [episodes, targetVersion] of [[[], '1.0.0'], [[episode], '999.0.0']] as const) {
      const { tx } = reader([...episodes]);
      expect(await revalidateCommandForDelivery(tx as never, { ...row({}), type: 'agent_rollback_v1', payload: { targetVersion } })).toBeNull();
    }
  });
  it.each([{}, [], true, 1])('treats non-string dev_update component %j as the agent', async component => {
    const { tx } = reader([episode]);
    expect(await revalidateCommandForDelivery(tx as never, { ...row({}), type: 'dev_update', payload: { version: '1.0.0', component } }))
      .toBe('network-isolation-version-floor');
  });
  it('does not apply the agent floor to separate helper components', async () => {
    const { tx } = reader([episode]);
    expect(await revalidateCommandForDelivery(tx as never, { ...row({}), type: 'dev_update', payload: { version: '1.0.0', component: 'desktop-helper' } })).toBeNull();
    expect(tx.select).not.toHaveBeenCalled();
  });
  it('preserves release delivery without consulting the start binding', async () => {
    const { tx } = reader([]);
    expect(await revalidateCommandForDelivery(tx as never, { ...row({}), type: 'release_containment' })).toBeNull();
    expect(tx.select).not.toHaveBeenCalled();
  });
});
