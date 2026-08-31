/**
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

const { mockDb, ctxState, agentRelayMock } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
  },
  // DB-access-context depth + an ordered event log, so a test can prove which
  // work runs inside a held transaction and which runs after it closes.
  ctxState: { depth: 0, events: [] as string[] },
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn(async (): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
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

describe('processDispatchScan DB-context scoping (final-review fix, #4084/#1105)', () => {
  const DATA = {
    type: 'dispatch-scan' as const,
    jobId: 'job-1',
    profileId: 'profile-1',
    orgId: 'org-1',
    siteId: 'site-1',
    agentId: 'agent-1',
  };
  const PROFILE_ROW = { id: 'profile-1' };
  const VALID_AGENT_ROW = { agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', status: 'online' };

  beforeEach(() => {
    vi.clearAllMocks();
    ctxState.depth = 0;
    ctxState.events = [];

    agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async () => {
      ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`);
      return true;
    });
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async () => {
      ctxState.events.push(`wsDispatch@depth${ctxState.depth}`);
      return { status: 'sent', via: 'local' };
    });
  });

  it('reads profile + validates the requested agent in-context, but checks connectivity, dispatches and flips status OUTSIDE it', async () => {
    // Requested-agent path: profile select, then validateRequestedAgentForDiscovery's
    // devices select — exactly two selects, both inside phase 1.
    mockDb.select
      .mockReturnValueOnce(selectLimitChain([PROFILE_ROW], 'profileSelect') as never)
      .mockReturnValueOnce(selectLimitChain([VALID_AGENT_ROW], 'agentValidateSelect') as never);
    mockDb.update.mockReturnValue(updateChain('statusUpdate') as never);

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: true, agentId: 'agent-1', durationMs: expect.any(Number) });
    // Phase 1 (profile + agent-validation reads) shares ONE context; the
    // connectivity check and the WS dispatch run after it closes; the final
    // status flip to 'running' gets its own short context.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'profileSelect@depth1',
      'agentValidateSelect@depth1',
      'ctx:exit',
      'isAgentConnected@depth0',
      'wsDispatch@depth0',
      'ctx:enter',
      'statusUpdate@depth1',
      'ctx:exit',
    ]);
  });

  it('holds no context past phase 1 when the profile is missing', async () => {
    mockDb.select.mockReturnValueOnce(selectLimitChain([], 'profileSelect') as never);
    mockDb.update.mockReturnValue(updateChain('markJobFailed') as never);

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: false, agentId: null, durationMs: expect.any(Number) });
    expect(agentRelayMock.isAgentConnectedAnywhere).not.toHaveBeenCalled();
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    // markJobFailed (an UPDATE) shares phase 1's context with the profile read.
    expect(ctxState.events).toEqual(['ctx:enter', 'profileSelect@depth1', 'markJobFailed@depth1', 'ctx:exit']);
  });

  it('checks connectivity OUTSIDE any context, then reopens a short context to mark the job failed when the agent is not connected', async () => {
    mockDb.select
      .mockReturnValueOnce(selectLimitChain([PROFILE_ROW], 'profileSelect') as never)
      .mockReturnValueOnce(selectLimitChain([VALID_AGENT_ROW], 'agentValidateSelect') as never);
    mockDb.update.mockReturnValue(updateChain('markJobFailed') as never);
    agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async () => {
      ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`);
      return false;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: false, agentId: null, durationMs: expect.any(Number) });
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'profileSelect@depth1',
      'agentValidateSelect@depth1',
      'ctx:exit',
      'isAgentConnected@depth0',
      'ctx:enter',
      'markJobFailed@depth1',
      'ctx:exit',
    ]);
    warn.mockRestore();
  });

  it('reopens a short context for the post-dispatch markJobFailed when the outcome is not sent', async () => {
    // A contextless UPDATE here would be an RLS-denied silent no-op in prod
    // (0 rows, no error) — the job would sit 'pending' forever. Lock the
    // depth-1 requirement down the same way backupWorker.dbcontext.test.ts does.
    mockDb.select
      .mockReturnValueOnce(selectLimitChain([PROFILE_ROW], 'profileSelect') as never)
      .mockReturnValueOnce(selectLimitChain([VALID_AGENT_ROW], 'agentValidateSelect') as never);
    mockDb.update.mockReturnValue(updateChain('markJobFailed') as never);
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async () => {
      ctxState.events.push(`wsDispatch@depth${ctxState.depth}`);
      return { status: 'indeterminate' };
    });

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: false, agentId: 'agent-1', durationMs: expect.any(Number) });
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'profileSelect@depth1',
      'agentValidateSelect@depth1',
      'ctx:exit',
      'isAgentConnected@depth0',
      'wsDispatch@depth0',
      'ctx:enter',
      'markJobFailed@depth1',
      'ctx:exit',
    ]);
  });
});
