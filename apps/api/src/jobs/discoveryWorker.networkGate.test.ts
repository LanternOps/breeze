/**
 * Learned networks W03a (#12369, spec §8.2, index E9): processDispatchScan decides under the shared site lock,
 * re-decides and records the attempt in one context, and only then sends. Same depth-tracking harness as
 * discoveryWorker.dbcontext.test.ts; the gate, eligibility, lock and attempt modules are mocked so each phase's
 * decision can be set per test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchOutcome } from '../services/agentCommandRelay';

const { mockDb, ctxState, agentRelayMock, gateMock, eligibilityMock, attemptMock } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), update: vi.fn() },
  ctxState: { depth: 0, events: [] as string[] },
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn(async (_agentId: string, _command: unknown): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
  },
  gateMock: { evaluateDiscoveryGate: vi.fn() },
  eligibilityMock: {
    explainGuardedAgent: vi.fn(),
    loadEligibleGuardedAgents: vi.fn(async () => []),
    explainNoEligibleAgent: vi.fn(async () => 'none_online'),
  },
  attemptMock: { loadProfileForDispatch: vi.fn(), recordDispatchAttempt: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Queue: class { async getJob() { return undefined; } add() { return undefined; } },
  Worker: class {}, Job: class {}, UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: async (fn: () => unknown) => {
    ctxState.depth++;
    ctxState.events.push('ctx:enter');
    try { return await fn(); } finally { ctxState.depth--; ctxState.events.push('ctx:exit'); }
  },
  runAfterDbContextExit: (_label: string, work: () => unknown) => { void work(); },
}));

vi.mock('../services/assetPlacement', () => ({ reconcilePlacementOnLinkOrThrow: vi.fn(async () => 'noop') }));
vi.mock('../db/schema', () => ({
  discoveryProfiles: { id: 'discoveryProfiles.id' },
  discoveryJobs: { id: 'discoveryJobs.id', status: 'discoveryJobs.status', orgId: 'discoveryJobs.orgId', siteId: 'discoveryJobs.siteId' },
  discoveredAssets: {}, networkTopology: {}, networkBaselines: {}, networkKnownGuests: {},
  networkChangeEvents: { $inferInsert: {} }, organizations: {},
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', agentId: 'devices.agentId', status: 'devices.status', isEphemeral: 'devices.isEphemeral' },
  deviceNetwork: { deviceId: 'deviceNetwork.deviceId', ipAddress: 'deviceNetwork.ipAddress' },
}));
vi.mock('../services/assetApproval', () => ({ normalizeMac: vi.fn(), buildApprovalDecision: vi.fn() }));
vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})), getBullMQConnection: vi.fn(() => ({})), isBullMQAvailable: vi.fn(() => true),
}));
vi.mock('../services/agentCommandRelay', () => agentRelayMock);
vi.mock('../services/cronDue', () => ({ isCronDue: vi.fn() }));
vi.mock('../services/macVendorLookup', () => ({ lookupMacVendor: vi.fn(), inferAssetTypeFromVendor: vi.fn() }));
vi.mock('../services/networkBaseline', () => ({ buildEventFingerprint: vi.fn(() => 'fingerprint') }));
vi.mock('./networkBaselineWorker', () => ({ enqueueBaselineComparison: vi.fn(async () => 'enqueued'), getNetworkBaselineQueue: vi.fn() }));
vi.mock('../services/topology/discoveryDispatch', () => ({ prepareDiscoveryTopologyDispatch: vi.fn(async () => null) }));

vi.mock('../services/learnedNetworks/gate', () => ({
  evaluateDiscoveryGate: gateMock.evaluateDiscoveryGate,
  gateProfileFromRow: (row: { id: string; orgId: string; siteId: string }) => ({
    id: row.id, orgId: row.orgId, siteId: row.siteId, networkId: null, snmpGrantMode: 'unrestricted', hasSavedSnmpSecrets: false,
  }),
}));
vi.mock('../services/learnedNetworks/eligibility', () => eligibilityMock);
vi.mock('../services/learnedNetworks/siteLock', () => ({
  lockSitesForNetworkGate: vi.fn(async () => { ctxState.events.push(`lock@depth${ctxState.depth}`); }),
}));
vi.mock('../services/learnedNetworks/attempt', () => attemptMock);

const { __testables } = await import('./discoveryWorker');

const DATA = { type: 'dispatch-scan' as const, jobId: 'job-1', profileId: 'profile-1', orgId: 'org-1', siteId: 'site-1', agentId: 'agent-1' };
const JOB_ROW_SCHEDULED = { status: 'scheduled', orgId: 'org-1', siteId: 'site-1' };
const PROFILE_ROW = { id: 'profile-1', orgId: 'org-1', siteId: 'site-1', subnets: ['192.168.1.0/24'], methods: ['ping'] };
const VALID_AGENT_ROW = { deviceId: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', status: 'online', isEphemeral: false };
const G1_ENTRY = { networkId: 'n-1', gatewayId: 'g-1', address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' };
const UNRESTRICTED = { kind: 'unrestricted' as const };
const GUARDED = { kind: 'guarded' as const, allowed: [G1_ENTRY] };

let updates: Array<Record<string, unknown>>;

function selectLimitChain(rows: unknown[], label: string) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => { ctxState.events.push(`${label}@depth${ctxState.depth}`); return rows; },
      }),
    }),
  };
}

function queueRequestedAgentSelects() {
  mockDb.select
    .mockReturnValueOnce(selectLimitChain([JOB_ROW_SCHEDULED], 'jobStatusSelect') as never)
    .mockReturnValueOnce(selectLimitChain([PROFILE_ROW], 'profileSelect') as never)
    .mockReturnValueOnce(selectLimitChain([VALID_AGENT_ROW], 'agentValidateSelect') as never);
}

function gateDecisions(...decisions: unknown[]) {
  for (const d of decisions) {
    gateMock.evaluateDiscoveryGate.mockImplementationOnce(async () => { ctxState.events.push(`gate@depth${ctxState.depth}`); return d; });
  }
}

function failure() {
  return updates.find((u) => u.status === 'failed');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockReset();
  gateMock.evaluateDiscoveryGate.mockReset();
  ctxState.depth = 0; ctxState.events = [];
  updates = [];
  mockDb.update.mockImplementation((() => ({
    set: (payload: Record<string, unknown>) => ({
      where: async () => { ctxState.events.push(`update@depth${ctxState.depth}`); updates.push(payload); },
    }),
  })) as never);
  agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async () => {
    ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`); return true;
  });
  agentRelayMock.dispatchCommandToAgent.mockImplementation(async () => {
    ctxState.events.push(`wsDispatch@depth${ctxState.depth}`); return { status: 'sent', via: 'local' };
  });
  attemptMock.loadProfileForDispatch.mockImplementation(async () => {
    ctxState.events.push(`profileForShare@depth${ctxState.depth}`); return PROFILE_ROW;
  });
  attemptMock.recordDispatchAttempt.mockImplementation(async () => {
    ctxState.events.push(`recordAttempt@depth${ctxState.depth}`); return true;
  });
});

describe('processDispatchScan network gate order (E9)', () => {
  it('re-decides and records the attempt inside a context before the send', async () => {
    queueRequestedAgentSelects();
    gateDecisions(UNRESTRICTED, UNRESTRICTED);

    const r = await __testables.processDispatchScan(DATA);

    expect(r.dispatched).toBe(true);
    expect(ctxState.events).toEqual(['ctx:enter', 'jobStatusSelect@depth1', 'profileSelect@depth1', 'lock@depth1', 'gate@depth1',
      'agentValidateSelect@depth1', 'ctx:exit', 'isAgentConnected@depth0', 'ctx:enter', 'lock@depth1', 'profileForShare@depth1',
      'gate@depth1', 'recordAttempt@depth1', 'ctx:exit', 'wsDispatch@depth0']);
    expect(attemptMock.recordDispatchAttempt).toHaveBeenCalledWith('job-1', {
      version: 1, mode: 'unrestricted', agentId: 'agent-1', deviceId: 'dev-1',
      allowedNetworkIds: [], allowedGatewayIds: [], decidedAt: expect.any(String),
    });
    const [, command] = agentRelayMock.dispatchCommandToAgent.mock.calls[0]! as [string, { type: string }];
    expect(command.type).toBe('network_discovery');
  });

  it('sends nothing when the attempt record is refused (the job left scheduled)', async () => {
    queueRequestedAgentSelects();
    gateDecisions(UNRESTRICTED, UNRESTRICTED);
    attemptMock.recordDispatchAttempt.mockResolvedValue(false);

    const r = await __testables.processDispatchScan(DATA);

    expect(r.dispatched).toBe(false);
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('a phase-1 gate failure fails the job with its code and sends nothing', async () => {
    mockDb.select
      .mockReturnValueOnce(selectLimitChain([JOB_ROW_SCHEDULED], 'jobStatusSelect') as never)
      .mockReturnValueOnce(selectLimitChain([PROFILE_ROW], 'profileSelect') as never);
    const error = { code: 'credentials_need_reentry', message: 'The profile\'s saved SNMP credentials…' };
    gateDecisions({ kind: 'fail', error });

    const r = await __testables.processDispatchScan(DATA);

    expect(r.dispatched).toBe(false);
    expect(agentRelayMock.isAgentConnectedAnywhere).not.toHaveBeenCalled();
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(attemptMock.recordDispatchAttempt).not.toHaveBeenCalled();
    expect(failure()).toMatchObject({ errors: error });
  });

  it('the gate reads the job row, not the queue payload', async () => {
    mockDb.select
      .mockReturnValueOnce(selectLimitChain([{ ...JOB_ROW_SCHEDULED, siteId: 'site-9' }], 'jobStatusSelect') as never)
      .mockReturnValueOnce(selectLimitChain([PROFILE_ROW], 'profileSelect') as never);
    gateDecisions({ kind: 'fail', error: { code: 'profile_moved', message: 'moved' } });

    await __testables.processDispatchScan(DATA);

    expect(gateMock.evaluateDiscoveryGate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', siteId: 'site-9', job: { orgId: 'org-1', siteId: 'site-9' },
    }));
  });

  it('a phase-3 re-evaluation that fails fails the job with that code and sends nothing', async () => {
    queueRequestedAgentSelects();
    const error = { code: 'no_network_assigned', message: 'This site requires an assigned network and has none. The scan was not sent.' };
    gateDecisions(UNRESTRICTED, { kind: 'fail', error });

    const r = await __testables.processDispatchScan(DATA);

    expect(r.dispatched).toBe(false);
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(attemptMock.recordDispatchAttempt).not.toHaveBeenCalled();
    expect(failure()).toMatchObject({ errors: error });
  });

  it('a profile that vanished before phase 3 fails the job and sends nothing', async () => {
    queueRequestedAgentSelects();
    gateDecisions(UNRESTRICTED);
    attemptMock.loadProfileForDispatch.mockResolvedValue(null);

    const r = await __testables.processDispatchScan(DATA);

    expect(r.dispatched).toBe(false);
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(failure()).toMatchObject({ errors: { message: 'Profile not found' } });
  });

  it('a site gated between the phases sends guarded only to an eligible chosen agent', async () => {
    queueRequestedAgentSelects();
    gateDecisions(UNRESTRICTED, GUARDED);
    eligibilityMock.explainGuardedAgent.mockResolvedValueOnce({
      eligible: true, agent: { deviceId: 'dev-1', agentId: 'agent-1', hostname: 'LAPTOP-JS', displayName: null, gatewayIds: ['g-1'] },
    });

    const r = await __testables.processDispatchScan(DATA);

    expect(r.dispatched).toBe(true);
    expect(eligibilityMock.explainGuardedAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1', allowedGatewayIds: ['g-1'], orgId: 'org-1', siteId: 'site-1',
    }));
    const [, command] = agentRelayMock.dispatchCommandToAgent.mock.calls[0]! as [string, { type: string; payload: Record<string, unknown> }];
    expect(command.type).toBe('network_discovery_guarded');
    expect(command.payload.expectedNetwork).toEqual({ gateways: [G1_ENTRY] });
    expect(attemptMock.recordDispatchAttempt).toHaveBeenCalledWith('job-1', expect.objectContaining({
      mode: 'guarded', allowedNetworkIds: ['n-1'], allowedGatewayIds: ['g-1'],
    }));

    // Not eligible at phase 3: named, nothing sent, nothing recorded.
    vi.clearAllMocks(); updates = [];
    queueRequestedAgentSelects();
    gateDecisions(UNRESTRICTED, GUARDED);
    eligibilityMock.explainGuardedAgent.mockResolvedValueOnce({ eligible: false, reason: 'not_on_network', label: 'LAPTOP-JS' });

    const r2 = await __testables.processDispatchScan(DATA);

    expect(r2.dispatched).toBe(false);
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(attemptMock.recordDispatchAttempt).not.toHaveBeenCalled();
    expect(failure()).toMatchObject({
      agentId: 'agent-1',
      errors: { code: 'agent_not_eligible', reason: 'not_on_network', message: expect.stringContaining('"LAPTOP-JS"') },
    });
  });

  it('an unsent command fails the job after the attempt was recorded', async () => {
    queueRequestedAgentSelects();
    gateDecisions(UNRESTRICTED, UNRESTRICTED);
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'offline' });

    const r = await __testables.processDispatchScan(DATA);

    expect(r.dispatched).toBe(false);
    expect(attemptMock.recordDispatchAttempt).toHaveBeenCalledTimes(1);
    expect(failure()).toMatchObject({ agentId: 'agent-1', errors: { message: 'Failed to send command to agent' } });
    expect(updates.find((u) => u.status === 'running')).toBeUndefined();
  });
});
