/**
 * #7969: which agent a discovery dispatch runs on.
 *
 * - A profile's pinned device runs the scan; if it is offline / not connected
 *   the job FAILS naming it — no fallback to another device.
 * - An explicit agent on a manual scan still wins over the pin.
 * - Unpinned: subnet-overlapping agents first, stable tiebreak, and the
 *   connectivity walk falls through a stale-online top pick (re-preparing the
 *   topology snapshot for the agent actually used).
 *
 * Harness copied from discoveryWorker.topologyDispatch.test.ts (DB-context
 * depth tracking), with the selection module's DB loaders mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchOutcome } from '../services/agentCommandRelay';

const { mockDb, ctxState, agentRelayMock, topologyMock, selectionMock } = vi.hoisted(() => ({
  topologyMock: { prepare: vi.fn() },
  selectionMock: { resolvePinned: vi.fn(), loadCandidates: vi.fn() },
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
  },
  // DB-access-context depth + an ordered event log, so a test can prove which
  // work runs inside a held transaction and which runs after it closes.
  ctxState: { depth: 0, events: [] as string[] },
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async (_agentId: string) => true),
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

// Placement reconciliation on auto-link is covered by services/assetPlacement.test.ts.
vi.mock('../services/assetPlacement', () => ({
  reconcilePlacementOnLinkOrThrow: vi.fn(async () => 'noop'),
}));

vi.mock('../db/schema', () => ({
  discoveryProfiles: { id: 'discoveryProfiles.id' },
  discoveryJobs: { id: 'discoveryJobs.id', status: 'discoveryJobs.status' },
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

vi.mock('./discoveryAgentSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./discoveryAgentSelection')>();
  return {
    ...actual,
    resolvePinnedDiscoveryAgent: selectionMock.resolvePinned,
    loadSiteDiscoveryAgentCandidates: selectionMock.loadCandidates,
  };
});

vi.mock('../services/topology/discoveryDispatch', () => ({
  prepareDiscoveryTopologyDispatch: topologyMock.prepare,
}));

const { __testables } = await import('./discoveryWorker');
const { pinnedAgentNotConnectedMessage } = await import('./discoveryAgentSelection');

const DATA = { type: 'dispatch-scan' as const, jobId: 'job-1', profileId: 'profile-1', orgId: 'org-1', siteId: 'site-1' };
const JOB_ROW_SCHEDULED = { status: 'scheduled' };
const PROFILE_UNPINNED = { id: 'profile-1', subnets: ['192.168.1.0/24'], methods: ['ping'], pinnedDeviceId: null };
const PROFILE_PINNED = { ...PROFILE_UNPINNED, pinnedDeviceId: 'dev-pinned' };

let updates: Array<Record<string, unknown>>;

function selectLimit(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
}

function queueSelects(...rowsets: unknown[][]) {
  for (const rows of rowsets) mockDb.select.mockReturnValueOnce(selectLimit(rows) as never);
}

function failure(): Record<string, unknown> | undefined {
  return updates.find((u) => u.status === 'failed');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockReset();
  ctxState.depth = 0; ctxState.events = [];
  updates = [];
  mockDb.update.mockImplementation((() => ({
    set: (payload: Record<string, unknown>) => ({
      where: async () => { updates.push(payload); },
    }),
  })) as never);
  topologyMock.prepare.mockResolvedValue(null);
  agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
  agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  selectionMock.loadCandidates.mockResolvedValue([]);
});

describe('pinned profile (#7969)', () => {
  it('dispatches to the pinned agent without considering other site agents', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_PINNED]);
    selectionMock.resolvePinned.mockResolvedValue({ ok: true, agentId: 'agent-pinned', label: 'scanner-01' });

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toMatchObject({ dispatched: true, agentId: 'agent-pinned' });
    expect(selectionMock.resolvePinned).toHaveBeenCalledWith('dev-pinned', 'org-1', 'site-1');
    expect(selectionMock.loadCandidates).not.toHaveBeenCalled();
    expect(agentRelayMock.dispatchCommandToAgent).toHaveBeenCalledWith('agent-pinned', expect.anything());
    expect(updates.find((u) => u.status === 'running')).toMatchObject({ agentId: 'agent-pinned' });
  });

  it('fails the job with the resolver\'s reason and records the pinned agent when it is offline — no fallback', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_PINNED]);
    selectionMock.resolvePinned.mockResolvedValue({ ok: false, agentId: 'agent-pinned', message: 'Pinned scan agent "scanner-01" is offline; …' });
    selectionMock.loadCandidates.mockResolvedValue([
      { deviceId: 'dev-other', agentId: 'agent-other', label: 'other', addresses: ['192.168.1.9'] },
    ]);

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toMatchObject({ dispatched: false, agentId: null });
    expect(selectionMock.loadCandidates).not.toHaveBeenCalled();
    expect(agentRelayMock.isAgentConnectedAnywhere).not.toHaveBeenCalled();
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(failure()).toMatchObject({
      agentId: 'agent-pinned',
      errors: { message: 'Pinned scan agent "scanner-01" is offline; …' },
    });
  });

  it('fails naming the pinned agent when it is online in the DB but not connected — does not walk to another agent', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_PINNED]);
    selectionMock.resolvePinned.mockResolvedValue({ ok: true, agentId: 'agent-pinned', label: 'scanner-01' });
    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toMatchObject({ dispatched: false, agentId: null });
    expect(agentRelayMock.isAgentConnectedAnywhere).toHaveBeenCalledTimes(1);
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(failure()).toMatchObject({
      agentId: 'agent-pinned',
      errors: { message: pinnedAgentNotConnectedMessage('scanner-01') },
    });
    warn.mockRestore();
  });

  it('a send failure to the pinned agent names it, records it, and does not try another agent', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_PINNED]);
    selectionMock.resolvePinned.mockResolvedValue({ ok: true, agentId: 'agent-pinned', label: 'scanner-01' });
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'offline' });

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toMatchObject({ dispatched: false, agentId: 'agent-pinned' });
    expect(agentRelayMock.dispatchCommandToAgent).toHaveBeenCalledTimes(1);
    expect(failure()).toMatchObject({
      agentId: 'agent-pinned',
      errors: { message: expect.stringMatching(/pinned scan agent "scanner-01".*not run from any other agent/) },
    });
  });

  it('an explicit agent on a manual scan wins over the pin', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_PINNED], [{ agentId: 'agent-manual', orgId: 'org-1', siteId: 'site-1', status: 'online' }]);

    const result = await __testables.processDispatchScan({ ...DATA, agentId: 'agent-manual' });

    expect(result).toMatchObject({ dispatched: true, agentId: 'agent-manual' });
    expect(selectionMock.resolvePinned).not.toHaveBeenCalled();
  });
});

describe('unpinned profile (#7969)', () => {
  it('prefers the agent on a profile subnet over one that sorts first but is off-LAN', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_UNPINNED]);
    selectionMock.loadCandidates.mockResolvedValue([
      { deviceId: 'dev-a', agentId: 'agent-vpn', label: 'vpn-laptop', addresses: ['10.8.0.5'] },
      { deviceId: 'dev-b', agentId: 'agent-lan', label: 'lan-desktop', addresses: ['192.168.1.20'] },
    ]);

    const result = await __testables.processDispatchScan(DATA);

    expect(selectionMock.loadCandidates).toHaveBeenCalledWith('org-1', 'site-1');
    expect(result).toMatchObject({ dispatched: true, agentId: 'agent-lan' });
    expect(updates.find((u) => u.status === 'running')).toMatchObject({ agentId: 'agent-lan' });
  });

  it('falls through a stale-online top pick to the next connected agent and re-prepares topology for it', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_UNPINNED]);
    selectionMock.loadCandidates.mockResolvedValue([
      { deviceId: 'dev-a', agentId: 'agent-1', label: 'one', addresses: ['192.168.1.1'] },
      { deviceId: 'dev-b', agentId: 'agent-2', label: 'two', addresses: ['192.168.1.2'] },
    ]);
    agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async (agentId: string) => agentId === 'agent-2');
    topologyMock.prepare.mockImplementation(async () => {
      ctxState.events.push(`topologyPersist@depth${ctxState.depth}`);
      return null;
    });

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toMatchObject({ dispatched: true, agentId: 'agent-2' });
    expect(topologyMock.prepare.mock.calls.map((c) => (c[0] as { agentId: string }).agentId)).toEqual(['agent-1', 'agent-2']);
    // Both snapshot writes ran inside a DB context; connectivity checks did not.
    expect(ctxState.events.filter((e) => e.startsWith('topologyPersist'))).toEqual(['topologyPersist@depth1', 'topologyPersist@depth1']);
    // No snapshot for agent-2: the stale phase-1 snapshot (agent-1) is cleared.
    expect(updates).toContainEqual(expect.objectContaining({ topologyDispatch: null, topologyDeadlineAt: null, topologyConfigGeneration: null }));
  });

  it('keeps today\'s message when no site agent is connected', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_UNPINNED]);
    selectionMock.loadCandidates.mockResolvedValue([
      { deviceId: 'dev-a', agentId: 'agent-1', label: 'one', addresses: [] },
    ]);
    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toMatchObject({ dispatched: false, agentId: null });
    expect(failure()).toMatchObject({ errors: { message: 'No online agent available for this site' } });
    warn.mockRestore();
  });

  it('fails with today\'s message when the site has no online agent', async () => {
    queueSelects([JOB_ROW_SCHEDULED], [PROFILE_UNPINNED]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toMatchObject({ dispatched: false, agentId: null });
    expect(agentRelayMock.isAgentConnectedAnywhere).not.toHaveBeenCalled();
    expect(failure()).toMatchObject({ errors: { message: 'No online agent available for this site' } });
    warn.mockRestore();
  });
});
