/**
 * Cross-site asset identity at scan ingest.
 *
 * `discovered_assets` is unique on (org_id, ip_address) — NOT (org, site, ip)
 * (`discovered_assets_org_ip_unique`). Once assets can be moved between sites
 * by hand, a scan from site A can re-find an asset whose stored site is B. The
 * worker must identify it by (org, ip), take the UPDATE branch (an INSERT
 * would hit 23505 and the host error would be swallowed, freezing the row
 * forever), leave `site_id` alone, and make its link decisions against the
 * asset's STORED site, not the scanning job's site.
 *
 * The select mock mirrors Postgres here: a lookup that still filters on
 * `discovered_assets.site_id = <job site>` gets NO row back, exactly as the
 * real query would, so the old code visibly falls into the INSERT branch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    delete: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
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
  withSystemDbAccessContext: undefined,
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
  isAgentConnectedAnywhere: vi.fn(async () => true),
  dispatchCommandToAgent: vi.fn(async () => ({ status: 'sent', via: 'local' })),
}));
vi.mock('../services/cronDue', () => ({ isCronDue: vi.fn() }));
vi.mock('../services/macVendorLookup', () => ({
  lookupMacVendor: vi.fn(),
  inferAssetTypeFromVendor: vi.fn(),
}));
vi.mock('../services/networkBaseline', () => ({ buildEventFingerprint: vi.fn(() => 'fingerprint') }));
vi.mock('./networkBaselineWorker', () => ({
  enqueueBaselineComparison: vi.fn(async () => 'enqueued'),
  getNetworkBaselineQueue: vi.fn(),
}));

import { buildApprovalDecision } from '../services/assetApproval';
import type { DiscoveredHostResult } from './discoveryWorker';

const { processResults } = await import('./discoveryWorker') as typeof import('./discoveryWorker');

const JOB_SITE = 'site-1';      // the site the scanning profile belongs to
const STORED_SITE = 'site-2';   // where the asset was manually moved to

function collectSqlLeafStrings(node: unknown, seen = new Set<unknown>(), acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node === null || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    for (const item of queryChunks) collectSqlLeafStrings(item, seen, acc);
  }
  return acc;
}

const filtersOnAssetSite = (condition: unknown): boolean =>
  collectSqlLeafStrings(condition).includes('discoveredAssets.siteId');

function makeSelectChain(
  initialRows: unknown[],
  onWhere: (condition: unknown) => unknown[] | void,
) {
  let rows = initialRows;
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (condition: unknown) => {
    const replacement = onWhere(condition);
    if (replacement) rows = replacement;
    return chain;
  };
  chain.limit = () => Promise.resolve(rows);
  chain.leftJoin = () => chain;
  chain.innerJoin = () => chain;
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

describe('processResults — asset identity is (org, ip), site is owned by moves', () => {
  // Select-call ordering for processResults (no profileId in data):
  //  [0] job status
  //  [1] profileId from job
  //  [2] org partnerId
  //  [3] scanned-existing assets (approval pre-load, thenable)
  //  [4] monitored assets for the offline sweep (thenable)
  //  [5] network baseline
  //  [6] per-host existing asset lookup
  //  [7] current link (linkedDeviceId + linked device's site)
  //  [8] auto-link match (only when not already linked)
  const ASSET_ROW = {
    id: 'asset-moved',
    siteId: STORED_SITE,
    typeSource: 'auto',
    detectedTypeSource: null,
    autoLinkSuppressedAt: null,
  };

  let selectQueue: unknown[][];
  let selectCalls: Array<{ index: number; condition: unknown }>;
  let updateCalls: Array<{ set: Record<string, unknown>; where: unknown }>;
  let insertCalls: Record<string, unknown>[];

  const makeData = (hosts: DiscoveredHostResult[]) => ({
    type: 'process-results' as const,
    jobId: 'job-1',
    orgId: 'org-1',
    siteId: JOB_SITE,
    hosts,
    hostsScanned: hosts.length,
    hostsDiscovered: hosts.length,
  });

  const seedSelects = (rows: unknown[][]) => {
    selectQueue = [
      [{ status: 'pending' }],   // [0]
      [],                        // [1]
      [{ partnerId: null }],     // [2]
      [],                        // [3] scanned-existing — replaced by the site-aware mock below
      [],                        // [4] monitored assets
      [{ id: 'baseline-1' }],    // [5]
      ...rows,
    ];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectCalls = [];
    updateCalls = [];
    insertCalls = [];
    let selectCallIndex = 0;

    vi.mocked(buildApprovalDecision).mockReturnValue({ approvalStatus: 'approved', shouldAlert: false });

    vi.mocked(mockDb.select).mockImplementation(() => {
      const index = selectCallIndex++;
      const seeded = selectQueue[index] ?? [];
      return makeSelectChain(seeded, (condition) => {
        selectCalls.push({ index, condition });
        // Postgres semantics for the two asset-by-IP lookups: the row lives in
        // STORED_SITE, so a predicate pinned to the JOB site finds nothing.
        if ((index === 3 || index === 6) && filtersOnAssetSite(condition)) return [];
        if (index === 3) return [{ id: ASSET_ROW.id, ipAddress: '10.0.0.5', macAddress: null, hostname: null, approvalStatus: 'approved', isOnline: true }];
        return undefined;
      });
    });

    vi.mocked(mockDb.update).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      let set: Record<string, unknown> = {};
      chain.set = (args: Record<string, unknown>) => { set = args; return chain; };
      chain.where = (where: unknown) => {
        updateCalls.push({ set, where });
        return Promise.resolve([]);
      };
      return chain;
    });

    vi.mocked(mockDb.insert).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.values = (args: Record<string, unknown>) => { insertCalls.push(args); return chain; };
      chain.onConflictDoNothing = () => chain;
      chain.returning = () => Promise.resolve([{ id: 'new-asset-id' }]);
      return chain;
    });
  });

  it('re-finds an asset that was moved to another site of the same org and UPDATEs it (no INSERT)', async () => {
    seedSelects([
      [ASSET_ROW],                                                   // [6]
      [{ linkedDeviceId: null, linkedDeviceSiteId: null }],          // [7]
      [],                                                            // [8] no auto-link match
    ]);

    const result = await processResults(makeData([
      { ip: '10.0.0.5', assetType: 'unrecognized-type', methods: [] },
    ]));

    // The identity lookup must not carry a site predicate at all.
    const lookup = selectCalls.find((c) => c.index === 6);
    expect(lookup).toBeDefined();
    expect(filtersOnAssetSite(lookup!.condition)).toBe(false);

    // Neither may the approval pre-load.
    const preload = selectCalls.find((c) => c.index === 3);
    expect(preload).toBeDefined();
    expect(filtersOnAssetSite(preload!.condition)).toBe(false);

    expect(insertCalls).toHaveLength(0);
    expect(result.newAssets).toBe(0);
    expect(result.updatedAssets).toBe(1);

    // The scan update leaves site_id alone: it belongs to manual moves.
    const scanUpdate = updateCalls.find((c) => 'lastSeenAt' in c.set);
    expect(scanUpdate).toBeDefined();
    expect(scanUpdate!.set).not.toHaveProperty('siteId');
    for (const call of updateCalls) {
      expect(call.set).not.toHaveProperty('siteId');
    }
  });

  it('keeps a link to a device in the asset\'s STORED site, even though the scan came from another site', async () => {
    seedSelects([
      [ASSET_ROW],                                                                 // [6]
      [{ linkedDeviceId: 'device-in-stored-site', linkedDeviceSiteId: STORED_SITE }], // [7]
      // no [8]: an already-linked asset must not go through the auto-linker
    ]);

    await processResults(makeData([
      { ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:05', assetType: 'unrecognized-type', methods: [] },
    ]));

    expect(insertCalls).toHaveLength(0);
    // No unlink write — the link is same-site relative to where the asset lives.
    expect(updateCalls).not.toContainEqual(expect.objectContaining({
      set: expect.objectContaining({ linkedDeviceId: null, linkSource: null }),
    }));
    // No auto-link attempt either: nothing queried device_network by MAC/IP.
    // (Later selects do exist — reconcileTopology runs after the host loop —
    // so this is asserted on the predicate, not on the call count.)
    const autoLinkAttempt = selectCalls.find((c) => {
      const leaves = collectSqlLeafStrings(c.condition);
      return leaves.includes('deviceNetwork.macAddress') || leaves.includes('deviceNetwork.ipAddress');
    });
    expect(autoLinkAttempt).toBeUndefined();
  });

  it('auto-links against devices in the asset\'s STORED site, not the scanning job\'s site', async () => {
    seedSelects([
      [ASSET_ROW],                                             // [6]
      [{ linkedDeviceId: null, linkedDeviceSiteId: null }],    // [7] unlinked
      [{ deviceId: 'device-in-stored-site' }],                 // [8] match
    ]);

    await processResults(makeData([
      { ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:05', assetType: 'unrecognized-type', methods: [] },
    ]));

    const match = selectCalls.find((c) => c.index === 8);
    expect(match).toBeDefined();
    const leaves = collectSqlLeafStrings(match!.condition);
    expect(leaves).toContain('devices.siteId');
    expect(leaves).toContain(STORED_SITE);
    expect(leaves).not.toContain(JOB_SITE);
    expect(updateCalls).toContainEqual(expect.objectContaining({
      set: expect.objectContaining({ linkedDeviceId: 'device-in-stored-site', linkSource: 'auto' }),
    }));
  });

  it('still inserts a net-new asset under the scanning job\'s site', async () => {
    seedSelects([
      [],   // [6] nothing at this IP anywhere in the org
      [],   // [7] auto-link match (no [linkedDeviceId] query on the insert branch)
    ]);

    await processResults(makeData([
      { ip: '10.0.0.99', assetType: 'unrecognized-type', methods: [] },
    ]));

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ orgId: 'org-1', siteId: JOB_SITE, ipAddress: '10.0.0.99' });
  });
});
