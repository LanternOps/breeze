/**
 * M2 #5998 D7: the discovery dispatch authorization snapshot is persisted
 * BEFORE the command leaves the server, and the command advertises
 * acceptedAdjacencyVersions:[2] only when a snapshot was persisted.
 * (Harness copied from discoveryWorker.dbcontext.test.ts.)
 *
 * discoveryWorker DB-context scoping (#1105 class, final-review fix for wave
 * 3.5b #4084).
 *
 * The regression this locks down: the ENTIRE worker-handler switch — every
 * job type, including `dispatch-scan` — used to run inside one blanket
 * `runWithSystemDbAccess` wrap, so `isAgentConnectedAnywhere` and
 * `dispatchCommandToAgent` (Redis/WS I/O via the agentCommandRelay facade —
 * the latter with an ack-wait poll loop up to RELAY_DELIVERY_DEADLINE_MS) ran
 * with a pooled Postgres connection pinned idle-in-transaction.
 *
 * An identity `fn => fn()` mock of the context helper can never catch that
 * (which is exactly what discoveryWorker.test.ts uses, since it isn't
 * asserting context depth), so the mock below tracks real enter/exit depth
 * and the tests assert WHICH depth each DB read/write and each facade call
 * happened at — mirroring snmpWorker.dbcontext.test.ts's harness. Exercised
 * directly against `__testables.processDispatchScan`, same as
 * discoveryWorker.test.ts's existing facade-dispatch suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchOutcome } from '../services/agentCommandRelay';

const { mockDb, ctxState, agentRelayMock, topologyMock } = vi.hoisted(() => ({
  topologyMock: { prepare: vi.fn() },
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
  },
  // DB-access-context depth + an ordered event log, so a test can prove which
  // work runs inside a held transaction and which runs after it closes.
  ctxState: { depth: 0, events: [] as string[] },
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn(async (_agentId: string, _command: { payload: Record<string, unknown> }): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  // Real-ish context wrapper: tracks depth around fn so the tests can assert
  // what runs inside the context vs after it closes. Unlike
  // discoveryWorker.test.ts (which sets this to `undefined` for an identity
  // fallback), this is the whole point of this file.
  withSystemDbAccessContext: async (fn: () => unknown) => {
    ctxState.depth++;
    ctxState.events.push('ctx:enter');
    try {
      return await fn();
    } finally {
      ctxState.depth--;
      ctxState.events.push('ctx:exit');
    }
  },
}));

vi.mock('../db/schema', () => ({
  discoveryProfiles: { id: 'discoveryProfiles.id' },
  discoveryJobs: { id: 'discoveryJobs.id' },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
    ipAddress: 'discoveredAssets.ipAddress',
    linkedDeviceId: 'discoveredAssets.linkedDeviceId',
    linkSource: 'discoveredAssets.linkSource',
    typeSource: 'discoveredAssets.typeSource',
    assetType: 'discoveredAssets.assetType',
    detectedAssetType: 'discoveredAssets.detectedAssetType',
    detectedTypeSource: 'discoveredAssets.detectedTypeSource',
    autoLinkSuppressedAt: 'discoveredAssets.autoLinkSuppressedAt',
  },
  networkTopology: {
    id: 'networkTopology.id',
    orgId: 'networkTopology.orgId',
    siteId: 'networkTopology.siteId',
    sourceType: 'networkTopology.sourceType',
    targetType: 'networkTopology.targetType',
    connectionType: 'networkTopology.connectionType',
  },
  networkBaselines: {},
  networkKnownGuests: {},
  networkChangeEvents: { $inferInsert: {} },
  organizations: {},
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    deviceRoleSource: 'devices.deviceRoleSource',
    agentId: 'devices.agentId',
    status: 'devices.status',
    isEphemeral: 'devices.isEphemeral',
  },
  deviceNetwork: {
    deviceId: 'deviceNetwork.deviceId',
    macAddress: 'deviceNetwork.macAddress',
    ipAddress: 'deviceNetwork.ipAddress',
  },
}));

vi.mock('../services/assetApproval', () => ({
  normalizeMac: vi.fn(),
  buildApprovalDecision: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

vi.mock('../services/cronDue', () => ({
  isCronDue: vi.fn(),
}));

vi.mock('../services/macVendorLookup', () => ({
  lookupMacVendor: vi.fn(),
  inferAssetTypeFromVendor: vi.fn(),
}));

vi.mock('../services/networkBaseline', () => ({
  buildEventFingerprint: vi.fn(() => 'fingerprint'),
}));

vi.mock('./networkBaselineWorker', () => ({
  enqueueBaselineComparison: vi.fn(async () => 'enqueued'),
  getNetworkBaselineQueue: vi.fn(),
}));

vi.mock('../services/topology/discoveryDispatch', () => ({
  prepareDiscoveryTopologyDispatch: topologyMock.prepare,
}));

const { __testables } = await import('./discoveryWorker');

/** A `.select().from().where().limit()` chain that logs the depth it ran at. */
function selectLimitChain(rows: unknown[], label: string) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(async () => {
          ctxState.events.push(`${label}@depth${ctxState.depth}`);
          return rows;
        }),
      }),
    }),
  };
}

/** An `.update().set().where()` chain that logs the depth it ran at. */
function updateChain(label: string) {
  return {
    set: () => ({
      where: async () => {
        ctxState.events.push(`${label}@depth${ctxState.depth}`);
      },
    }),
  };
}

describe('processDispatchScan topology dispatch authority (D7)', () => {
  const DATA = { type: 'dispatch-scan' as const, jobId: 'job-1', profileId: 'profile-1', orgId: 'org-1', siteId: 'site-1', agentId: 'agent-1' };
  const PROFILE_ROW = { id: 'profile-1', subnets: ['192.0.2.0/24'], methods: ['snmp'] };
  const VALID_AGENT_ROW = { agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', status: 'online' };
  const BLOCK = { acceptedAdjacencyVersions: [2], producerEpoch: 'e'.repeat(64), sourceIdentity: 'o:s:discovery:d', deadline: '2026-11-01T00:15:00.000Z',
    protocols: ['lldp', 'cdp', 'fdb', 'interfaces'], contexts: ['default'], expectedIntervalSeconds: 86400 };
  let sent: { payload: Record<string, unknown> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    ctxState.depth = 0; ctxState.events = []; sent = undefined;
    mockDb.select
      .mockReturnValueOnce(selectLimitChain([PROFILE_ROW], 'profileSelect') as never)
      .mockReturnValueOnce(selectLimitChain([VALID_AGENT_ROW], 'agentValidateSelect') as never);
    mockDb.update.mockReturnValue(updateChain('statusUpdate') as never);
    agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async () => { ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`); return true; });
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async (_agent: string, command: { payload: Record<string, unknown> }): Promise<DispatchOutcome> => {
      sent = command; ctxState.events.push(`wsDispatch@depth${ctxState.depth}`); return { status: 'sent', via: 'local' };
    });
  });

  it('persists the snapshot inside a DB context before dispatching, and advertises v2 only then', async () => {
    topologyMock.prepare.mockImplementation(async () => { ctxState.events.push(`topologyPersist@depth${ctxState.depth}`); return BLOCK; });
    const result = await __testables.processDispatchScan(DATA);
    expect(result.dispatched).toBe(true);
    expect(topologyMock.prepare).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', orgId: 'org-1', siteId: 'site-1', agentId: 'agent-1', profile: PROFILE_ROW }));
    const persistAt = ctxState.events.indexOf('topologyPersist@depth1');
    expect(persistAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(ctxState.events.indexOf('wsDispatch@depth0'));
    expect(sent?.payload.topology).toEqual(BLOCK);
  });

  it('dispatches legacy-only when no snapshot is persisted', async () => {
    topologyMock.prepare.mockResolvedValue(null);
    await __testables.processDispatchScan(DATA);
    expect(sent).toBeDefined();
    expect(sent!.payload).not.toHaveProperty('topology');
  });

  it('keeps legacy discovery working when snapshot preparation fails', async () => {
    topologyMock.prepare.mockRejectedValue(new Error('boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await __testables.processDispatchScan(DATA);
    expect(result.dispatched).toBe(true);
    expect(sent!.payload).not.toHaveProperty('topology');
    error.mockRestore();
  });
});
