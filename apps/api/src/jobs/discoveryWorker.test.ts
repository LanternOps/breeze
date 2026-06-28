import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    delete: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  }
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined
}));

vi.mock('../db/schema', () => ({
  discoveryProfiles: {},
  discoveryJobs: { id: 'discoveryJobs.id' },
  discoveredAssets: { id: 'discoveredAssets.id', ipAddress: 'discoveredAssets.ipAddress', typeSource: 'discoveredAssets.typeSource', detectedAssetType: 'discoveredAssets.detectedAssetType' },
  networkTopology: {
    id: 'networkTopology.id',
    orgId: 'networkTopology.orgId',
    siteId: 'networkTopology.siteId',
    sourceType: 'networkTopology.sourceType',
    targetType: 'networkTopology.targetType',
    connectionType: 'networkTopology.connectionType'
  },
  networkBaselines: {},
  networkKnownGuests: {},
  networkChangeEvents: {
    $inferInsert: {}
  },
  organizations: {},
  devices: {},
  deviceNetwork: {}
}));

vi.mock('../services/assetApproval', () => ({
  normalizeMac: vi.fn(),
  buildApprovalDecision: vi.fn()
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn()
}));

vi.mock('../services/automationRuntime', () => ({
  isCronDue: vi.fn()
}));

vi.mock('../services/macVendorLookup', () => ({
  lookupMacVendor: vi.fn(),
  inferAssetTypeFromVendor: vi.fn()
}));

vi.mock('../services/networkBaseline', () => ({
  buildEventFingerprint: vi.fn(() => 'fingerprint')
}));

import { db } from '../db';
import { buildApprovalDecision } from '../services/assetApproval';

const { cleanupSpeculativeTopologyLinks, processResults } = await import('./discoveryWorker') as typeof import('./discoveryWorker');

// Helper: build a chainable Drizzle-like mock that resolves to resolveValue
// when awaited directly (thenable) or via .limit() / .returning().
function makeSelectChain(resolveValue: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(resolveValue);
  chain.innerJoin = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.returning = () => Promise.resolve(resolveValue);
  // Make thenable so `await db.select().from().where()` (no .limit) works
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return chain;
}

describe('processResults — type_source', () => {
  let capturedUpdateSet: Record<string, unknown> | null;
  let capturedInsertValues: Record<string, unknown> | null;
  // FIFO queue of resolved values for each successive db.select() call
  let selectQueue: unknown[][];
  let selectCallIndex: number;

  // Minimal host payload that exercises the asset upsert path
  const makeData = (hosts: unknown[]) => ({
    type: 'process-results' as const,
    jobId: 'job-1',
    orgId: 'org-1',
    siteId: 'site-1',
    hosts,
    hostsScanned: hosts.length,
    hostsDiscovered: hosts.length,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedUpdateSet = null;
    capturedInsertValues = null;
    selectQueue = [];
    selectCallIndex = 0;

    vi.mocked(buildApprovalDecision).mockReturnValue({ approvalStatus: 'pending', shouldAlert: false });

    vi.mocked(mockDb.select).mockImplementation(() =>
      makeSelectChain(selectQueue[selectCallIndex++] ?? [])
    );

    vi.mocked(mockDb.update).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = (args: Record<string, unknown>) => {
        // Capture only the first update (the main asset upsert, not the later
        // approvalStatus update or auto-link update).
        if (capturedUpdateSet === null) capturedUpdateSet = args;
        return chain;
      };
      chain.where = () => Promise.resolve([]);
      return chain;
    });

    vi.mocked(mockDb.insert).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.values = (args: Record<string, unknown>) => {
        capturedInsertValues = args;
        return chain;
      };
      chain.onConflictDoNothing = () => chain;
      chain.returning = () => Promise.resolve([{ id: 'new-asset-id' }]);
      return chain;
    });
  });

  // Standard select-call ordering for processResults (no profileId supplied):
  //  [0] job status
  //  [1] profileId from job  (since no profileId in data)
  //  [2] org partnerId
  //  [3] scanned-existing assets (thenable, no .limit)
  //  [4] monitored assets       (thenable, no .limit)
  //  [5] network baseline
  //  [6] per-host existing asset  ← seeded per test
  //  [7] linkedDeviceId (if existing)
  //  [8] auto-link match
  const baseSelectQueue = () => [
    [{ status: 'pending' }],   // [0] job status — non-cancelled
    [],                         // [1] profileId from job — none
    [{ partnerId: null }],      // [2] org — no partner → no known-guests query
    [],                         // [3] scanned-existing assets
    [],                         // [4] monitored assets
    [{ id: 'baseline-1' }],    // [5] network baseline — exists, skip insert
  ];

  it('preserves asset_type but updates detected_asset_type when type_source=manual', async () => {
    selectQueue = [
      ...baseSelectQueue(),
      [{ id: 'asset-1', typeSource: 'manual' }], // [6] existing asset
      [{ linkedDeviceId: null }],                  // [7] linkedDeviceId
      [],                                           // [8] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.50', assetType: 'workstation', methods: [] },
    ]));

    expect(capturedUpdateSet).not.toBeNull();
    // Manual override: user-facing asset_type must NOT be overwritten
    expect(capturedUpdateSet).not.toHaveProperty('assetType');
    // But detected_asset_type (what the scan sees) MUST be written
    expect(capturedUpdateSet!.detectedAssetType).toBe('workstation');
  });

  it('updates asset_type normally when type_source=auto', async () => {
    selectQueue = [
      ...baseSelectQueue(),
      [{ id: 'asset-1', typeSource: 'auto' }], // [6] existing asset
      [{ linkedDeviceId: null }],                // [7] linkedDeviceId
      [],                                         // [8] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.51', assetType: 'printer', methods: [] },
    ]));

    expect(capturedUpdateSet).not.toBeNull();
    // Auto source: asset_type is freely overwritten
    expect(capturedUpdateSet!.assetType).toBe('printer');
    // detected_asset_type is always written
    expect(capturedUpdateSet!.detectedAssetType).toBe('printer');
  });

  it('fresh insert sets type_source=auto and detected_asset_type', async () => {
    selectQueue = [
      ...baseSelectQueue(),
      [],  // [6] no existing asset
      [],  // [7] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.52', assetType: 'server', methods: [] },
    ]));

    expect(capturedInsertValues).not.toBeNull();
    expect(capturedInsertValues!.typeSource).toBe('auto');
    expect(capturedInsertValues!.detectedAssetType).toBe('server');
  });
});

describe('cleanupSpeculativeTopologyLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes speculative discovered-asset topology links for a site', async () => {
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'edge-1' }, { id: 'edge-2' }])
      })
    } as any);

    const deleted = await cleanupSpeculativeTopologyLinks('org-1', 'site-1');

    expect(deleted).toBe(2);
    expect(vi.mocked(db.delete)).toHaveBeenCalledWith(expect.anything());
  });
});
