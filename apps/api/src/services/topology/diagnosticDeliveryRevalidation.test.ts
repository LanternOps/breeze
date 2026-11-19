import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #11358: the `network_diagnostic` delivery revalidation runs inside the claim
 * transaction, after the claim has locked `device_commands` rows. For a run
 * that carries a frozen requester authority (a routed trace, a policy
 * occurrence, an approved proposal), the requester's permission-authority
 * version lives in Redis. The registration's lock-free PREPARE half resolves
 * it before the claim locks `device_commands` rows, and the in-lock half only
 * compares against that value. These tests check that the in-lock half never
 * reads Redis, and that the comparison gives the same verdicts as the live
 * read: an equal version delivers, a changed version cancels
 * (`scope_changed`), an unavailable version cancels (`authority_unavailable`),
 * and a row the preparation did not cover is HELD (left pending), not
 * cancelled.
 */

const { permissionVersionMock, registrations } = vi.hoisted(() => ({
  permissionVersionMock: vi.fn<(userId: string) => Promise<string | null>>(),
  registrations: [] as Array<{ type: string; revalidate: (...a: any[]) => Promise<unknown>; prepare?: (...a: any[]) => Promise<unknown> }>,
}));

vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  getPermissionAuthorityVersion: (userId: string) => permissionVersionMock(userId),
}));
vi.mock('../commandClaimEligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commandClaimEligibility')>()),
  registerCommandRevalidation: (type: string, revalidate: (...a: any[]) => Promise<unknown>, prepare?: (...a: any[]) => Promise<unknown>) => {
    registrations.push({ type, revalidate, prepare });
  },
}));

import { resolveTopologyRequesterPermissionVersions, validateTopologyCommandAuthority } from './diagnosticDispatch';

const USER = '88888888-8888-4888-8888-888888888888';
const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const OTHER_RUN = '45454545-4545-4545-8545-454545454545';
const ATTEMPT = '55555555-5555-4555-8555-555555555555';
const COMMAND = '66666666-6666-4666-8666-666666666666';
const NODE = '77777777-7777-4777-8777-777777777777';
const BINDING = '99999999-9999-4999-8999-999999999999';
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAMPED = '["4","9"]';

const requesterAuthority = {
  version: 1, userId: USER, authEpoch: 3, mfaEpoch: 1, permissionVersion: STAMPED, orgId: ORG, partnerId: null,
};

function commandPayload(runId = RUN, commandId = COMMAND) {
  const acceptedAt = new Date(Date.now() - 1_000);
  const deadline = new Date(acceptedAt.getTime() + 120_000).toISOString();
  const plan = {
    version: 1, recipeId: 'trace_route', recipeVersion: 1,
    scope: { orgId: ORG, siteId: SITE },
    subject: { kind: 'node', id: NODE },
    origin: {
      deviceId: DEVICE, agentId: 'agent-1', nodeId: NODE, bindingId: BINDING, siteId: SITE, contextKey: 'default',
      interfaceId: null, interfaceEpoch: null, interfaceKey: null, sourceId: SOURCE, producerEpoch: 'epoch-1', sequence: '1',
    },
    family: 'ipv4', graphRevision: '0', settingsRevision: '0', contextRevision: '1',
    templateVersions: { partner: null, org: null, defaults: 1, resolver: 1 },
    destinations: [], steps: [],
    limits: { maxConcurrentSteps: 2, maxTargetAddresses: 4, maxResolvers: 2, queueTimeoutSeconds: 30, executionTimeoutSeconds: 60, lifetimeSeconds: 120 },
    acceptedAt: acceptedAt.toISOString(),
    queueDeadline: new Date(acceptedAt.getTime() + 30_000).toISOString(),
    deadline,
    digest: 'a'.repeat(64),
    reasons: [],
  };
  return { type: 'network_diagnostic', version: 1, runId, attemptId: ATTEMPT, commandId, plan, planDigest: plan.digest, expiresAt: deadline };
}

const payload = commandPayload();
const row = { id: COMMAND, type: 'network_diagnostic', deviceId: DEVICE, payload };

/** A routed-trace run that is live and points at the command being delivered. */
const traceRun = {
  id: RUN, orgId: ORG, siteId: SITE, commandId: COMMAND, attemptId: ATTEMPT, planDigest: 'a'.repeat(64), state: 'queued',
  cancelRequestedAt: null, deadline: new Date(Date.now() + 60_000), recipeId: 'trace_route', policyId: null, policyRevision: null,
  requesterId: USER, requesterAuthority, originSnapshot: { deviceId: DEVICE, producerEpoch: 'epoch-1' },
};

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

/**
 * The reads `validateTopologyCommandAuthority` makes, in order, for an intact
 * routed trace: the origin fences, then the requester's user row, then the
 * diagnostics flags and the origin's trace capability.
 */
function intactTraceReads(over: { run?: unknown; user?: unknown } = {}) {
  return readerReturning([
    [over.run ?? traceRun],
    [{ orgId: ORG, siteId: SITE, agentId: 'agent-1' }], // the origin device
    [{ id: BINDING }], // the origin binding
    [{ producerEpoch: 'epoch-1', revokedAt: null, orgId: ORG, siteId: SITE }], // the routes source
    [{ effectiveSettings: {} }], // the site state
    [over.user ?? { id: USER, status: 'active', authEpoch: 3, mfaEpoch: 1, orgId: ORG, partnerId: null }], // the requester
    [{ partnerId: 'partner-1', settings: { topologyFeatureFlags: { materialization: true, diagnostics: true } } }], // the org
    [], // the partner (not visible to an agent claim context)
    [{ currentBaseline: { capabilities: [{ name: 'network_trace', version: 1, supported: true }] } }], // the origin root
  ]);
}

const validate = (reader: unknown, versions?: ReadonlyMap<string, string | null>) =>
  validateTopologyCommandAuthority(row, payload, { reader: reader as never, permissionVersions: versions ?? 'live' });

beforeEach(() => {
  permissionVersionMock.mockReset();
  permissionVersionMock.mockResolvedValue(STAMPED);
});

describe('network_diagnostic delivery revalidation (#11358)', () => {
  describe('prepare half', () => {
    it('resolves each requester\'s version once, from the runs the pending rows point at', async () => {
      const reader = readerReturning([[{ recipeId: 'trace_route', policyId: null, requesterAuthority }]]);
      const versions = await resolveTopologyRequesterPermissionVersions(reader as never, [payload, structuredClone(payload), { not: 'a diagnostic' }]);
      expect(versions).toEqual(new Map([[USER, STAMPED]]));
      expect(reader.select).toHaveBeenCalledTimes(1);
      expect(permissionVersionMock).toHaveBeenCalledTimes(1);
      expect(permissionVersionMock).toHaveBeenCalledWith(USER);
    });

    it('resolves one version per distinct requester, and keeps an unavailable one as null', async () => {
      permissionVersionMock.mockImplementation(async (userId) => (userId === USER ? STAMPED : null));
      const reader = readerReturning([[
        { recipeId: 'trace_route', policyId: null, requesterAuthority },
        { recipeId: 'target_connectivity', policyId: 'policy-1', requesterAuthority: { ...requesterAuthority, userId: OTHER_USER } },
      ]]);
      const versions = await resolveTopologyRequesterPermissionVersions(reader as never, [payload, commandPayload(OTHER_RUN)]);
      expect(versions).toEqual(new Map([[USER, STAMPED], [OTHER_USER, null]]));
      expect(permissionVersionMock).toHaveBeenCalledTimes(2);
    });

    it('skips runs that need no requester revalidation, and frozen authorities that do not parse', async () => {
      const reader = readerReturning([[
        { recipeId: 'gateway_basic', policyId: null, requesterAuthority: null },
        { recipeId: 'trace_route', policyId: null, requesterAuthority: { version: 1, userId: 'not-a-uuid' } },
      ]]);
      expect(await resolveTopologyRequesterPermissionVersions(reader as never, [payload])).toEqual(new Map());
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('reads nothing for payloads that are not diagnostics', async () => {
      const reader = readerReturning([]);
      expect(await resolveTopologyRequesterPermissionVersions(reader as never, [{ not: 'a diagnostic' }])).toEqual(new Map());
      expect(reader.select).not.toHaveBeenCalled();
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });
  });

  describe('in-lock half', () => {
    it('delivers when the prepared version is the frozen one, without touching Redis', async () => {
      expect(await validate(intactTraceReads(), new Map([[USER, STAMPED]]))).toMatchObject({ allow: true });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('cancels when the prepared version moved on, without touching Redis', async () => {
      expect(await validate(intactTraceReads(), new Map([[USER, '["4","10"]']]))).toEqual({ allow: false, reason: 'scope_changed' });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('cancels when the version could not be read at prepare time (fails closed, as the live read did)', async () => {
      expect(await validate(intactTraceReads(), new Map([[USER, null]]))).toEqual({ allow: false, reason: 'authority_unavailable' });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('holds a requester the preparation did not cover instead of reading Redis under the lock', async () => {
      expect(await validate(intactTraceReads(), new Map([[OTHER_USER, STAMPED]]))).toEqual({ allow: false, hold: 'revalidation_unprepared' });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('a changed requester still cancels before any version is needed', async () => {
      const reads = intactTraceReads({ user: { id: USER, status: 'active', authEpoch: 4, mfaEpoch: 1, orgId: ORG, partnerId: null } });
      expect(await validate(reads, new Map())).toEqual({ allow: false, reason: 'scope_changed' });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('a frozen authority bound to another user still denies before any version is needed (never held)', async () => {
      const reads = intactTraceReads({ run: { ...traceRun, requesterId: OTHER_USER } });
      expect(await validate(reads, new Map())).toEqual({ allow: false, reason: 'authority_unavailable' });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('a run that needs no requester revalidation delivers with no preparation', async () => {
      const reads = intactTraceReads({ run: { ...traceRun, recipeId: 'gateway_basic', requesterAuthority: null } });
      expect(await validate(reads, new Map())).toMatchObject({ allow: true });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('reads the version live only when a caller outside a claim asks for it explicitly', async () => {
      expect(await validate(intactTraceReads())).toMatchObject({ allow: true });
      expect(permissionVersionMock).toHaveBeenCalledWith(USER);
    });
  });

  describe('registration', () => {
    const registration = () => {
      const found = registrations.find((r) => r.type === 'network_diagnostic');
      if (!found) throw new Error('network_diagnostic revalidation was not registered');
      return found;
    };

    it('registers a prepare half that resolves versions from the pending rows', async () => {
      const { prepare } = registration();
      expect(prepare).toBeTypeOf('function');
      const reader = readerReturning([[{ recipeId: 'trace_route', policyId: null, requesterAuthority }]]);
      expect(await prepare!(reader, [row])).toEqual(new Map([[USER, STAMPED]]));
    });

    it('delivers with the prepared versions and never reads Redis in the in-lock half', async () => {
      const { revalidate } = registration();
      expect(await revalidate(intactTraceReads(), row, new Map([[USER, STAMPED]]))).toBeNull();
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('cancels on a moved version with the claim cancel reason', async () => {
      const { revalidate } = registration();
      expect(await revalidate(intactTraceReads(), row, new Map([[USER, '["4","10"]']]))).toBe('scope_changed');
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });

    it('holds (not cancels) a row with no preparation, and never reads Redis in the in-lock half', async () => {
      const { revalidate } = registration();
      expect(await revalidate(intactTraceReads(), row, undefined)).toEqual({ hold: 'revalidation_unprepared' });
      expect(await revalidate(intactTraceReads(), row, new Map())).toEqual({ hold: 'revalidation_unprepared' });
      expect(permissionVersionMock).not.toHaveBeenCalled();
    });
  });
});
