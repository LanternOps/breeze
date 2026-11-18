import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ propagate: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../commandCancelPropagation', () => ({ propagateCancelledDeviceCommands: mocks.propagate }));
vi.mock('../partnerTrust.commands', () => ({
  createDeviceExecuteBatchGate: () => async () => {}, TrustDeniedError: class extends Error {},
}));
vi.mock('../sentry', () => ({ captureException: vi.fn(), captureMessage: mocks.captureMessage }));
import { partitionClaimable, revalidateCommandForDelivery } from '../commandClaimEligibility';
import { agentVersions, deviceNetworkIsolations } from '../../db/schema';
const device = { id: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222', status: 'online', orgType: 'customer', installIncarnation: 1 };
const isolationId = '33333333-3333-4333-8333-333333333333';
const episode = { id: isolationId, deviceId: device.id, state: 'verified', desiredState: 'isolated', generation: 2, commandId: 'command', releaseCommandId: null as string | null };
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
  describe('upgrade floor follows the binary the payload selects, not its version label (#10919)', () => {
    const OLD = 'a'.repeat(64);
    const NEW = 'b'.repeat(64);
    const URL = 'https://updates.example.test/agent.bin';
    // One mocked result per select, in order: the episode read, then the release-record read.
    function sequence(...batches: unknown[][]) {
      const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn() };
      chain.from.mockReturnValue(chain); chain.where.mockReturnValue(chain);
      for (const batch of batches) chain.limit.mockResolvedValueOnce(batch);
      chain.limit.mockResolvedValue([]);
      const tx = { select: vi.fn(() => chain), transaction: async (fn: (sp: unknown) => unknown) => fn(tx) };
      return { tx, chain };
    }
    const upgrade = (type: string, payload: unknown) => ({ ...row({}), type, payload });

    it('refuses a download whose release record is below the floor, whatever version it claims', async () => {
      const { tx } = sequence([episode], [{ version: '1.0.0' }]);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { version: '999.0.0', downloadUrl: URL, checksum: OLD })))
        .toBe('network-isolation-version-floor');
    });
    it('delivers a download whose release record is at the floor, whatever version it claims', async () => {
      const { tx } = sequence([episode], [{ version: '999.0.0' }]);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { version: '1.0.0', downloadUrl: URL, checksum: NEW }))).toBeNull();
    });
    it('reads the release record by the payload checksum, for the agent component only', async () => {
      const { tx, chain } = sequence([episode], [{ version: '999.0.0' }]);
      await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { version: '1.0.0', downloadUrl: URL, checksum: NEW.toUpperCase() }));
      expect(chain.from).toHaveBeenNthCalledWith(2, agentVersions);
      const query = new PgDialect().sqlToQuery(chain.where.mock.calls[1]![0]);
      expect(query.params).toEqual([NEW, 'agent']);
      expect(query.sql).toMatch(/lower\(.*"checksum"\) = \$1 and .*"component" = \$2/);
    });
    it('refuses when more release records share the checksum than it will judge', async () => {
      const { tx, chain } = sequence([episode], Array.from({ length: 21 }, () => ({ version: '999.0.0' })));
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { downloadUrl: URL, checksum: NEW })))
        .toBe('network-isolation-version-floor');
      expect(chain.limit).toHaveBeenNthCalledWith(2, 21);
    });
    it('treats the queue-stamped timeoutSeconds as version-only', async () => {
      const { tx } = sequence();
      expect(await revalidateCommandForDelivery(tx as never, upgrade('update', { version: '999.0.0', timeoutSeconds: 300 }))).toBeNull();
      expect(tx.select).not.toHaveBeenCalled();
    });
    it.each([undefined, ''])('treats dev_update component %j as the agent when the payload names a download', async (component) => {
      const { tx } = sequence([episode], [{ version: '1.0.0' }]);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { version: '999.0.0', downloadUrl: URL, checksum: OLD, component })))
        .toBe('network-isolation-version-floor');
    });
    it.each([{ targetVersion: '1.0.0' }, {}, { targetVersion: 999 }])('refuses a rollback directive %j that cannot prove the floor', async (directive) => {
      const { tx } = sequence([episode]);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('agent_rollback_v1', { ...directive, directiveSignature: 'sig' })))
        .toBe('network-isolation-version-floor');
    });
    it('refuses when any release record sharing the checksum is below the floor', async () => {
      const { tx } = sequence([episode], [{ version: '999.0.0' }, { version: '1.0.0' }]);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { downloadUrl: URL, checksum: NEW })))
        .toBe('network-isolation-version-floor');
    });
    it.each<[string, Record<string, unknown>]>([
      ['an unknown checksum', { version: '999.0.0', downloadUrl: URL, checksum: OLD }],
      ['no checksum', { version: '999.0.0', downloadUrl: URL }],
      ['a malformed checksum', { version: '999.0.0', downloadUrl: URL, checksum: 'not-a-digest' }],
    ])('refuses a download with %s while isolation is unresolved', async (_name, payload) => {
      const { tx } = sequence([episode], []);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', payload))).toBe('network-isolation-version-floor');
    });
    it.each(['update', 'update_agent', 'dev_update'])('refuses %s carrying any field that could choose the binary', async (type) => {
      for (const extra of [{ url: URL }, { downloadUrl: URL }, { manifestUrl: URL }, { source: { href: URL } }]) {
        const { tx } = sequence([episode], []);
        expect(await revalidateCommandForDelivery(tx as never, upgrade(type, { version: '999.0.0', ...extra }))).toBe('network-isolation-version-floor');
      }
    });
    it('reads no release record when the device has no unresolved episode', async () => {
      const { tx } = sequence([]);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { version: '1.0.0', downloadUrl: URL, checksum: OLD }))).toBeNull();
      expect(tx.select).toHaveBeenCalledTimes(1);
    });
    it('still delivers a version-only upgrade at the floor without any read', async () => {
      const { tx } = sequence();
      for (const payload of [{ version: '999.0.0' }, { version: '999.0.0', component: 'agent', reason: 'recovery', preserveAutoUpdate: true }]) {
        expect(await revalidateCommandForDelivery(tx as never, upgrade('update_agent', payload))).toBeNull();
      }
      expect(tx.select).not.toHaveBeenCalled();
    });
    it('leaves a helper-component download alone', async () => {
      const { tx } = sequence([episode]);
      expect(await revalidateCommandForDelivery(tx as never, upgrade('dev_update', { version: '1.0.0', downloadUrl: URL, checksum: OLD, component: 'user-helper' }))).toBeNull();
      expect(tx.select).not.toHaveBeenCalled();
    });
    it('keeps the signed rollback directive on its signed targetVersion', async () => {
      const { tx } = sequence();
      const directive = { targetVersion: '999.0.0', artifacts: [{ url: URL, sha256: OLD }], directiveSignature: 'sig' };
      expect(await revalidateCommandForDelivery(tx as never, upgrade('agent_rollback_v1', directive))).toBeNull();
    });
  });

  describe('delivery is bound to the episode the service issued (#10919)', () => {
    const release = (payload: unknown = { isolationId, generation: 2, reason: 'Operator release' }) =>
      ({ ...row({}), id: 'release-command', type: 'release_containment', payload });
    const refusal = (commandId: string, commandType: string, reason: string) => [
      expect.stringContaining('not the episode'),
      expect.objectContaining({
        eventCode: 'network_isolation_command_unbound', level: 'error',
        tags: expect.objectContaining({ deviceId: device.id, commandId, commandType, reason }),
      }),
    ];

    it('delivers the isolate command the episode row names', async () => {
      const { tx } = reader([episode]);
      expect(await revalidateCommandForDelivery(tx as never, row({ isolationId, generation: 2 }))).toBeNull();
      expect(mocks.captureMessage).not.toHaveBeenCalled();
    });
    it('refuses a forged isolate naming a real episode and its generation, and raises a Sentry event', async () => {
      const { tx } = reader([{ ...episode, commandId: 'the-real-command' }]);
      const result = await partitionClaimable(tx as never, device, [row({ isolationId, generation: 2, allow: [{ scope: 'any' }] })]);
      expect(result.cancelled).toEqual([{ id: 'command', reason: 'isolation_episode_mismatch' }]);
      expect(result.claimable).toEqual([]);
      expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
      expect(mocks.captureMessage.mock.calls[0]).toEqual(refusal('command', 'execute_containment', 'not_episode_command'));
    });
    it('refuses an isolate when the episode names no command at all', async () => {
      const { tx } = reader([{ ...episode, commandId: null }]);
      expect(await revalidateCommandForDelivery(tx as never, row({ isolationId, generation: 2 }))).toBe('isolation_episode_mismatch');
      expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
    });
    it.each<[string, unknown, unknown[], string]>([
      ['legacy payload', undefined, [], 'no_binding'],
      ['malformed id', { isolationId: 'forged', generation: 2 }, [], 'no_binding'],
      ['unknown episode', { isolationId: '44444444-4444-4444-8444-444444444444', generation: 2 }, [], 'no_episode'],
    ])('reports an isolate with %s', async (_name, parameters, episodes, reason) => {
      const { tx } = reader(episodes);
      expect(await revalidateCommandForDelivery(tx as never, row(parameters))).toBe('isolation_episode_mismatch');
      expect(mocks.captureMessage.mock.calls[0]).toEqual(refusal('command', 'execute_containment', reason));
    });
    it.each<[string, Record<string, unknown>, unknown]>([
      ['stale generation', {}, { isolationId, generation: 1 }],
      ['resolved episode', { state: 'released' }, { isolationId, generation: 2 }],
      ['release requested', { desiredState: 'released' }, { isolationId, generation: 2 }],
    ])("cancels the episode's own isolate quietly on %s: ordinary lifecycle, not a forgery", async (_name, patch, parameters) => {
      const { tx } = reader([{ ...episode, ...patch }]);
      expect(await revalidateCommandForDelivery(tx as never, row(parameters))).toBe('isolation_episode_mismatch');
      expect(mocks.captureMessage).not.toHaveBeenCalled();
    });

    it('delivers the release command the episode row names, on a resolved tombstone too', async () => {
      for (const state of ['release_requested', 'released', 'expired']) {
        const { tx } = reader([{ ...episode, state, desiredState: 'released', releaseCommandId: 'release-command' }]);
        expect(await revalidateCommandForDelivery(tx as never, release())).toBeNull();
      }
      expect(mocks.captureMessage).not.toHaveBeenCalled();
    });
    it('refuses a forged release of an episode still meant to be isolated', async () => {
      const { tx } = reader([episode]);
      const result = await partitionClaimable(tx as never, device, [release()]);
      expect(result.cancelled).toEqual([{ id: 'release-command', reason: 'isolation_episode_mismatch' }]);
      expect(result.claimable).toEqual([]);
      expect(mocks.captureMessage.mock.calls[0]).toEqual(refusal('release-command', 'release_containment', 'not_episode_command'));
    });
    it('cancels a superseded release quietly: a re-release replaced it and the newest one is delivered', async () => {
      const { tx } = reader([{ ...episode, desiredState: 'released', state: 'release_requested', releaseCommandId: 'newer-release' }]);
      expect(await revalidateCommandForDelivery(tx as never, release())).toBe('isolation_episode_mismatch');
      expect(mocks.captureMessage).not.toHaveBeenCalled();
    });
    it.each<[string, unknown, unknown[], string]>([
      ['no payload', undefined, [], 'no_binding'],
      ['malformed id', { isolationId: 'episode', generation: 2 }, [], 'no_binding'],
      ['unknown episode', { isolationId, generation: 2 }, [], 'no_episode'],
    ])('reports a release with %s', async (_name, payload, episodes, reason) => {
      const { tx } = reader(episodes);
      const candidate = { ...release(), payload };
      expect(await revalidateCommandForDelivery(tx as never, candidate)).toBe('isolation_episode_mismatch');
      expect(mocks.captureMessage.mock.calls[0]).toEqual(refusal('release-command', 'release_containment', reason));
    });
    it('scopes the episode read to the claiming device', async () => {
      const { tx, chain } = reader([]);
      await revalidateCommandForDelivery(tx as never, release());
      const query = new PgDialect().sqlToQuery(chain.where.mock.calls[0]![0]);
      expect(query.params).toEqual(expect.arrayContaining([isolationId, device.id]));
    });
    it('holds rather than delivers when the binding read fails, for release too', async () => {
      for (const candidate of [release(), row({ isolationId, generation: 2 })]) {
        const { tx, chain } = reader([]);
        chain.limit.mockRejectedValueOnce(new Error('database unavailable'));
        const result = await partitionClaimable(tx as never, device, [candidate]);
        expect(result.held).toEqual([{ id: candidate.id, reason: 'eligibility_check_failed' }]);
        expect(result.claimable).toEqual([]);
      }
    });
  });
});
