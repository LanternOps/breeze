import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7268: the `topology_interface_poll` delivery revalidation runs inside the
 * claim transaction, after the claim has locked `device_commands` rows. The
 * arm actor's permission-authority version lives in Redis, so it is resolved
 * by the registration's lock-free PREPARE half (before the claim opens its
 * transaction) and the in-lock half only compares against that value. These
 * tests pin that the in-lock half never reaches for Redis, and that the
 * comparison is the same one the live read made: equal version delivers, a
 * changed or unavailable version cancels (`scope_changed`), and a row the
 * preparation did not cover is HELD (left pending), never cancelled.
 */

const { permissionVersionMock, registrations } = vi.hoisted(() => ({
  permissionVersionMock: vi.fn<(userId: string) => Promise<string | null>>(),
  registrations: [] as Array<{ type: string; revalidate: (...a: any[]) => Promise<unknown>; prepare?: (...a: any[]) => Promise<unknown> }>,
}));

vi.mock('../../db', () => ({ db: {}, assertInTransaction: vi.fn() }));
vi.mock('../permissions', () => ({ getPermissionAuthorityVersion: (userId: string) => permissionVersionMock(userId) }));
vi.mock('../commandClaimEligibility', () => ({
  registerCommandRevalidation: (type: string, revalidate: (...a: any[]) => Promise<unknown>, prepare?: (...a: any[]) => Promise<unknown>) => {
    registrations.push({ type, revalidate, prepare });
  },
}));

import pollFixture from '../../../../../packages/shared/src/testing/topology-interface-poll-v1.json';
import {
  resolveTopologyPollPermissionVersions,
  topologyArmProducerCredentials,
  topologyCredentialDigest,
  validateTopologyInterfacePollDelivery,
} from './telemetryArmFence';
import './telemetryPollDelivery';

const USER = '88888888-8888-4888-8888-888888888888';
const DEVICE = '99999999-9999-4999-8999-999999999999';
const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROFILE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAMPED = '["4","9"]';
const binding = pollFixture.validV2c.binding;

const profile = {
  id: PROFILE, orgId: binding.orgId, siteId: binding.siteId, enabled: true,
  methods: ['snmp'], snmpCommunities: ['public-ro'], snmpCredentials: null,
};
const authorityActor = {
  version: 1,
  actor: {
    user: { id: USER, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    principal: { kind: 'user_session' },
    scope: 'organization',
    orgId: binding.orgId,
    partnerId: null,
    accessibleOrgIds: [binding.orgId],
    authEpoch: 3,
    mfaEpoch: 1,
    mfa: true,
  },
  permissionVersion: STAMPED,
};
const iface = pollFixture.validV2c.interfaces[0]!;
const arm = {
  id: binding.armId, orgId: binding.orgId, siteId: binding.siteId, authorityKey: binding.authorityKey,
  state: 'armed', expiresAt: new Date(Date.now() + 86_400_000), collectorDeviceId: DEVICE,
  credentialProfileId: PROFILE, credentialDigest: topologyCredentialDigest(profile), authorityActor,
  authorityPermissionVersion: STAMPED, targetNodeId: NODE, generation: 1n, effectDigest: 'e'.repeat(64),
  interfaces: [{ interfaceId: iface.interfaceId, interfaceEpoch: iface.interfaceEpoch, ifIndex: iface.ifIndex }],
};
const root = { producerEpoch: 'p'.repeat(64), configurationRevision: 'r'.repeat(64), revokedAt: null };
const payload = { ...structuredClone(pollFixture.validV2c), ...topologyArmProducerCredentials(root, arm as never) };
const row = { id: 'cmd-1', deviceId: DEVICE, payload };

/** A reader whose Nth `select()` resolves to the Nth queued result, whatever the chain shape. */
function readerReturning(results: unknown[][]) {
  const queue = [...results];
  const select = vi.fn(() => {
    const value = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'innerJoin', 'orderBy']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject);
    return chain;
  });
  return { select } as never as { select: ReturnType<typeof vi.fn> };
}

/** The reads `validateTopologyInterfacePollDelivery` makes, in order, for an intact arm. */
function intactDeliveryReads(over: { arm?: unknown } = {}) {
  return readerReturning([
    [{ createdAt: new Date(Date.now() - 1_000) }], // the command row
    [over.arm ?? arm], // the arm
    [{ orgId: binding.orgId, siteId: binding.siteId }], // the collector device
    [profile], // the credential profile
    [{ status: 'active', authEpoch: 3, mfaEpoch: 1, partnerId: null, orgId: binding.orgId }], // the frozen actor
    [{ id: iface.interfaceId, epoch: iface.interfaceEpoch, osIndex: String(iface.ifIndex), retiredAt: null }], // armed interfaces
    [root], // the collector root
  ]);
}

beforeEach(() => {
  permissionVersionMock.mockReset();
  permissionVersionMock.mockResolvedValue(STAMPED);
});

describe('topology_interface_poll delivery revalidation (#7268)', () => {
  it('resolves each arm actor\'s version once, in the lock-free prepare half', async () => {
    const reader = readerReturning([[{ authorityActor }]]);
    const versions = await resolveTopologyPollPermissionVersions(reader as never, [payload, structuredClone(payload), { not: 'a poll' }]);
    expect(versions).toEqual(new Map([[USER, STAMPED]]));
    expect(reader.select).toHaveBeenCalledTimes(1);
    expect(permissionVersionMock).toHaveBeenCalledTimes(1);
    expect(permissionVersionMock).toHaveBeenCalledWith(USER);
  });

  it('resolves one version per distinct actor across several arms', async () => {
    const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const OTHER_ARM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const otherActor = { ...authorityActor, actor: { ...authorityActor.actor, user: { ...authorityActor.actor.user, id: OTHER_USER } } };
    const otherPayload = { ...structuredClone(payload), binding: { ...payload.binding, armId: OTHER_ARM } };
    permissionVersionMock.mockImplementation(async (userId) => (userId === USER ? STAMPED : null));
    // Three arms: two frozen to USER, one to OTHER_USER whose version is unavailable.
    const reader = readerReturning([[{ authorityActor }, { authorityActor }, { authorityActor: otherActor }]]);

    const versions = await resolveTopologyPollPermissionVersions(reader as never, [payload, otherPayload]);

    expect(versions).toEqual(new Map([[USER, STAMPED], [OTHER_USER, null]]));
    expect(permissionVersionMock).toHaveBeenCalledTimes(2);
  });

  it('reads nothing for payloads that are not polls', async () => {
    const reader = readerReturning([]);
    expect(await resolveTopologyPollPermissionVersions(reader as never, [{ not: 'a poll' }])).toEqual(new Map());
    expect(reader.select).not.toHaveBeenCalled();
    expect(permissionVersionMock).not.toHaveBeenCalled();
  });

  it('delivers when the prepared version is the one the arm was stamped at, without touching Redis', async () => {
    expect(await validateTopologyInterfacePollDelivery(intactDeliveryReads() as never, row, new Map([[USER, STAMPED]]))).toBeNull();
    expect(permissionVersionMock).not.toHaveBeenCalled();
  });

  it('cancels when the prepared version moved on, without touching Redis', async () => {
    expect(await validateTopologyInterfacePollDelivery(intactDeliveryReads() as never, row, new Map([[USER, '["4","10"]']]))).toBe('scope_changed');
    expect(permissionVersionMock).not.toHaveBeenCalled();
  });

  it('cancels when the version could not be read at prepare time (fails closed, as the live read did)', async () => {
    expect(await validateTopologyInterfacePollDelivery(intactDeliveryReads() as never, row, new Map([[USER, null]]))).toBe('scope_changed');
    expect(permissionVersionMock).not.toHaveBeenCalled();
  });

  it('reports a row the preparation did not cover as unprepared instead of reading Redis under the lock', async () => {
    expect(await validateTopologyInterfacePollDelivery(intactDeliveryReads() as never, row, new Map())).toBe('unprepared');
    expect(permissionVersionMock).not.toHaveBeenCalled();
  });

  it('a broken arm still cancels before any version is needed', async () => {
    const revoked = intactDeliveryReads({ arm: { ...arm, state: 'revoked' } });
    expect(await validateTopologyInterfacePollDelivery(revoked as never, row, new Map())).toBe('scope_changed');
    expect(permissionVersionMock).not.toHaveBeenCalled();
  });

  describe('registration', () => {
    const registration = () => {
      const found = registrations.find((r) => r.type === 'topology_interface_poll');
      if (!found) throw new Error('topology_interface_poll revalidation was not registered');
      return found;
    };

    it('registers a prepare half that resolves versions from the pending rows', async () => {
      const { prepare } = registration();
      expect(prepare).toBeTypeOf('function');
      const reader = readerReturning([[{ authorityActor }]]);
      expect(await prepare!(reader, [{ id: 'cmd-1', type: 'topology_interface_poll', deviceId: DEVICE, payload }])).toEqual(new Map([[USER, STAMPED]]));
    });

    it('delivers with the prepared versions and never reads Redis in the in-lock half', async () => {
      const { revalidate } = registration();
      expect(await revalidate(intactDeliveryReads(), { ...row, type: 'topology_interface_poll' }, new Map([[USER, STAMPED]]))).toBeNull();
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('holds (not cancels) a row with no preparation, and never reads Redis in the in-lock half', async () => {
      const { revalidate } = registration();
      expect(await revalidate(intactDeliveryReads(), { ...row, type: 'topology_interface_poll' }, undefined)).toEqual({ hold: 'revalidation_unprepared' });
      expect(await revalidate(intactDeliveryReads(), { ...row, type: 'topology_interface_poll' }, new Map())).toEqual({ hold: 'revalidation_unprepared' });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });
  });
});
