import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

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
    detectedTypeSource: 'discoveredAssets.detectedTypeSource'
  },
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
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    deviceRoleSource: 'devices.deviceRoleSource'
  },
  deviceNetwork: {
    deviceId: 'deviceNetwork.deviceId',
    macAddress: 'deviceNetwork.macAddress',
    ipAddress: 'deviceNetwork.ipAddress'
  }
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

vi.mock('./networkBaselineWorker', () => ({
  enqueueBaselineComparison: vi.fn(async () => 'enqueued'),
  getNetworkBaselineQueue: vi.fn()
}));

import { db } from '../db';
import { buildApprovalDecision } from '../services/assetApproval';
import { inferAssetTypeFromVendor } from '../services/macVendorLookup';
import { devices, discoveredAssets } from '../db/schema';
import type { DiscoveredHostResult } from './discoveryWorker';

const { cleanupSpeculativeTopologyLinks, processResults } = await import('./discoveryWorker') as typeof import('./discoveryWorker');

// Helper: build a chainable Drizzle-like mock that resolves to resolveValue
// when awaited directly (thenable) or via .limit() / .returning().
function makeSelectChain(
  resolveValue: unknown[],
  onWhere?: (condition: unknown) => unknown[] | void,
) {
  let currentValue = resolveValue;
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (condition: unknown) => {
    const replacement = onWhere?.(condition);
    if (replacement) currentValue = replacement;
    return chain;
  };
  chain.limit = () => Promise.resolve(currentValue);
  chain.leftJoin = () => chain;
  chain.innerJoin = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.returning = () => Promise.resolve(resolveValue);
  // Make thenable so `await db.select().from().where()` (no .limit) works
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(currentValue).then(resolve, reject);
  return chain;
}

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

// Render a drizzle `sql` fragment to the exact query Postgres would receive
// (text + bound params), mirroring unifiSyncService.test.ts's renderSql.
//
// Unlike that file, `../db/schema` is mocked here with plain strings standing
// in for columns (see the vi.mock block above) rather than real PgColumn
// instances, so a column reference renders as an ordinary bound parameter
// (e.g. "discoveredAssets.typeSource" as $1) instead of a quoted identifier
// ("discovered_assets"."type_source"). That still pins everything that
// matters for these tests: which column is the CASE subject, the
// (source, rank) ladder in order, the writing classifier's own rank
// threshold, the proposed value, and which column is read back on the
// fallback arm — an inverted guard or wrong fallback column changes this
// output. The real column-identifier rendering is covered by
// unifiSyncService.test.ts, which imports the actual schema.
function renderSqlQuery(value: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(value as never);
  return { sql, params };
}

// The (source, rank) ladder, in precedence order — mirrors
// DISCOVERED_ASSET_DETECTION_SOURCES / DETECTION_SOURCE_RANK in
// discoveredAssetClassification.ts. Every buildClassificationWrite() guard
// embeds this same sequence as the stored-rank CASE's arms.
const RANK_LADDER_PARAMS = ['vendor_oui', 10, 'agent_scan', 20, 'unifi_controller', 30];

// asset_type yields to BOTH axes: a manual pin always wins (first `when`), and
// among classifiers only an equal-or-stronger source may overwrite (second
// `when`), falling back to the existing asset_type column when outranked.
const ASSET_TYPE_CASE_SQL =
  'case when $1 = \'manual\' then $2 when case $3 when $4 then $5 when $6 then $7 when $8 then $9 else 0 end <= $10 then $11 else $12 end';
function assetTypeCaseParams(proposed: string, writerRank: number): unknown[] {
  return [
    'discoveredAssets.typeSource',
    'discoveredAssets.assetType',
    'discoveredAssets.detectedTypeSource',
    ...RANK_LADDER_PARAMS,
    writerRank,
    proposed,
    'discoveredAssets.assetType',
  ];
}

// detected_asset_type ignores the manual axis but still respects precedence,
// falling back to the existing detected_asset_type column when outranked.
const DETECTED_ASSET_TYPE_CASE_SQL =
  'case when case $1 when $2 then $3 when $4 then $5 when $6 then $7 else 0 end <= $8 then $9 else $10 end';
function detectedAssetTypeCaseParams(proposed: string, writerRank: number): unknown[] {
  return [
    'discoveredAssets.detectedTypeSource',
    ...RANK_LADDER_PARAMS,
    writerRank,
    proposed,
    'discoveredAssets.detectedAssetType',
  ];
}

// detected_type_source: same rank guard, proposed value is always the source
// itself (a bound literal, cast to the enum), falling back to the existing
// detected_type_source column when outranked.
const DETECTED_TYPE_SOURCE_CASE_SQL =
  'case when case $1 when $2 then $3 when $4 then $5 when $6 then $7 else 0 end <= $8 then $9::discovered_asset_detection_source else $10 end';
function detectedTypeSourceCaseParams(source: string, writerRank: number): unknown[] {
  return [
    'discoveredAssets.detectedTypeSource',
    ...RANK_LADDER_PARAMS,
    writerRank,
    source,
    'discoveredAssets.detectedTypeSource',
  ];
}

describe('processResults — type_source', () => {
  let capturedUpdateSet: Record<string, unknown> | null;
  let capturedInsertValues: Record<string, unknown> | null;
  // FIFO queue of resolved values for each successive db.select() call
  let selectQueue: unknown[][];
  let selectCallIndex: number;
  let capturedWherePredicates: unknown[];

  // Minimal host payload that exercises the asset upsert path
  const makeData = (hosts: DiscoveredHostResult[]) => ({
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
    capturedWherePredicates = [];

    vi.mocked(buildApprovalDecision).mockReturnValue({ approvalStatus: 'pending', shouldAlert: false });

    vi.mocked(mockDb.select).mockImplementation(() =>
      makeSelectChain(selectQueue[selectCallIndex++] ?? [], (condition) => {
        capturedWherePredicates.push(condition);
      })
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
      [{ id: 'asset-1', typeSource: 'manual', detectedTypeSource: null }], // [6] existing asset
      [{ linkedDeviceId: null }],                  // [7] linkedDeviceId
      [],                                           // [8] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.50', assetType: 'workstation', methods: [] },
    ]));

    expect(capturedUpdateSet).not.toBeNull();
    // asset_type is now ALWAYS present in the update set — the manual-vs-auto
    // decision moved entirely into SQL (#3187), evaluated against the real row
    // at write time rather than the JS-side `existing.typeSource` this test used
    // to branch on. What must still hold is that the guard's manual arm reads
    // back the existing asset_type unconditionally, so a manual pin is a no-op
    // against the real row regardless of what this scan proposed.
    const assetType = renderSqlQuery(capturedUpdateSet!.assetType);
    expect(assetType.sql).toBe(ASSET_TYPE_CASE_SQL);
    expect(assetType.params).toEqual(assetTypeCaseParams('workstation', 20));

    // detected_asset_type (what the scan sees) ignores the manual axis entirely
    // and is guarded only by rank against the stronger of the two classifiers.
    const detectedAssetType = renderSqlQuery(capturedUpdateSet!.detectedAssetType);
    expect(detectedAssetType.sql).toBe(DETECTED_ASSET_TYPE_CASE_SQL);
    expect(detectedAssetType.params).toEqual(detectedAssetTypeCaseParams('workstation', 20));

    // detected_type_source itself is written as 'agent_scan' (rank 20), guarded
    // by the same rank check.
    const detectedTypeSource = renderSqlQuery(capturedUpdateSet!.detectedTypeSource);
    expect(detectedTypeSource.sql).toBe(DETECTED_TYPE_SOURCE_CASE_SQL);
    expect(detectedTypeSource.params).toEqual(detectedTypeSourceCaseParams('agent_scan', 20));
  });

  it('updates asset_type normally when type_source=auto', async () => {
    selectQueue = [
      ...baseSelectQueue(),
      [{ id: 'asset-1', typeSource: 'auto', detectedTypeSource: null }], // [6] existing asset
      [{ linkedDeviceId: null }],                // [7] linkedDeviceId
      [],                                         // [8] auto-link
    ];

    await processResults(makeData([
      { ip: '192.168.1.51', assetType: 'printer', methods: [] },
    ]));

    expect(capturedUpdateSet).not.toBeNull();
    // Auto source: the SQL guard's manual arm reads back the existing column
    // (a no-op here since type_source isn't 'manual' on the real row), so the
    // rank-guard arm is what actually lets 'printer' through — same shape as
    // the manual-row test above, because the decision moved into SQL (#3187).
    const assetType = renderSqlQuery(capturedUpdateSet!.assetType);
    expect(assetType.sql).toBe(ASSET_TYPE_CASE_SQL);
    expect(assetType.params).toEqual(assetTypeCaseParams('printer', 20));

    // detected_asset_type is always written, guarded only by rank.
    const detectedAssetType = renderSqlQuery(capturedUpdateSet!.detectedAssetType);
    expect(detectedAssetType.sql).toBe(DETECTED_ASSET_TYPE_CASE_SQL);
    expect(detectedAssetType.params).toEqual(detectedAssetTypeCaseParams('printer', 20));
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

  it('does not propagate device role when asset type is a manual override', async () => {
    let deviceRoleUpdated = false;

    selectQueue = [
      ...baseSelectQueue(),
      [{ id: 'asset-1', typeSource: 'manual', detectedTypeSource: null }], // [6] existing — manual typeSource
      [{ linkedDeviceId: null }],                  // [7] not yet linked
      [{ deviceId: 'device-1' }],                  // [8] auto-link match found
      [{ deviceRoleSource: 'auto' }],              // [9] target device (consumed if propagation fires)
    ];

    vi.mocked(mockDb.update).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = (args: Record<string, unknown>) => {
        if ('deviceRole' in args) deviceRoleUpdated = true;
        return chain;
      };
      chain.where = () => Promise.resolve([]);
      return chain;
    });

    await processResults(makeData([
      { ip: '192.168.1.53', assetType: 'workstation', methods: [] },
    ]));

    expect(deviceRoleUpdated).toBe(false);
  });

  it('does not auto-link a same-MAC/private-IP device from a sibling site', async () => {
    selectQueue = [
      ...baseSelectQueue(),
      [], // [6] no existing asset in this site
    ];

    const updatePayloads: Record<string, unknown>[] = [];
    vi.mocked(mockDb.update).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = (args: Record<string, unknown>) => {
        updatePayloads.push(args);
        return chain;
      };
      chain.where = () => Promise.resolve([]);
      return chain;
    });

    vi.mocked(mockDb.select).mockImplementation(() => {
      const callIndex = selectCallIndex++;
      const initialRows = callIndex === 7
        ? [{ deviceId: 'sibling-site-device' }]
        : (selectQueue[callIndex] ?? []);
      return makeSelectChain(initialRows, (condition) => {
        capturedWherePredicates.push(condition);
        if (callIndex !== 7) return;
        const leaves = collectSqlLeafStrings(condition);
        return leaves.includes('devices.siteId') && leaves.includes('site-1')
          ? []
          : initialRows;
      });
    });

    await processResults(makeData([
      {
        ip: '192.168.1.53',
        mac: 'aa:bb:cc:dd:ee:ff',
        assetType: 'unknown',
        methods: [],
      },
    ]));

    expect(updatePayloads).not.toContainEqual(expect.objectContaining({
      linkedDeviceId: 'sibling-site-device',
    }));
    const allWhereLeaves = capturedWherePredicates.flatMap((condition) => collectSqlLeafStrings(condition));
    expect(allWhereLeaves).toContain('devices.siteId');
    expect(allWhereLeaves).toContain('site-1');
  });

  it('clears a stale cross-site link before applying the current scan result', async () => {
    selectQueue = [
      ...baseSelectQueue(),
      [{ id: 'asset-1', typeSource: 'auto', detectedTypeSource: null }],
      [{ linkedDeviceId: 'sibling-site-device', linkedDeviceSiteId: 'site-2' }],
      [],
    ];

    const updatePayloads: Record<string, unknown>[] = [];
    vi.mocked(mockDb.update).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = (args: Record<string, unknown>) => {
        updatePayloads.push(args);
        return chain;
      };
      chain.where = () => Promise.resolve([]);
      return chain;
    });

    await processResults(makeData([
      { ip: '192.168.1.54', assetType: 'unknown', methods: [] },
    ]));

    expect(updatePayloads).toContainEqual(expect.objectContaining({
      linkedDeviceId: null,
      linkSource: null,
    }));
    expect(buildApprovalDecision).toHaveBeenCalled();
  });

  // Nested inside `processResults — type_source` (rather than a sibling
  // top-level describe) so these tests can reuse the outer beforeEach's
  // harness — selectQueue/capturedUpdateSet/capturedInsertValues and the
  // default mockDb.select/update/insert wiring — without duplicating it.
  describe('processResults — classifier precedence (#3187)', () => {
    it('writes none of the three type columns when this scan has no opinion (unclassified agent, no vendor match)', async () => {
      // Headline regression: before #3187 an unrecognised agent type with no
      // vendor fallback still round-tripped through buildClassificationWrite
      // (or its precursor) and stamped 'unknown' back over a better answer.
      // With no classification at all, none of the three columns should be
      // touched in the update set.
      selectQueue = [
        ...baseSelectQueue(),
        [{ id: 'asset-1', typeSource: 'auto', detectedTypeSource: null }], // [6] existing asset
        [{ linkedDeviceId: null }],                                          // [7] linkedDeviceId
        [],                                                                    // [8] auto-link (no mac/ip match)
      ];

      await processResults(makeData([
        { ip: '192.168.1.60', assetType: 'unknown', methods: [] }, // no mac, no manufacturer
      ]));

      expect(capturedUpdateSet).not.toBeNull();
      expect(capturedUpdateSet).not.toHaveProperty('assetType');
      expect(capturedUpdateSet).not.toHaveProperty('detectedAssetType');
      expect(capturedUpdateSet).not.toHaveProperty('detectedTypeSource');
    });

    it('an agent-classified host writes detected_type_source as a guarded SQL CASE on the update path', async () => {
      selectQueue = [
        ...baseSelectQueue(),
        [{ id: 'asset-1', typeSource: 'auto', detectedTypeSource: null }], // [6] existing asset
        [{ linkedDeviceId: null }],                                          // [7] linkedDeviceId
        [],                                                                    // [8] auto-link
      ];

      await processResults(makeData([
        { ip: '192.168.1.61', assetType: 'server', methods: [] }, // agent recognised this host
      ]));

      expect(capturedUpdateSet).not.toBeNull();
      const detectedTypeSource = renderSqlQuery(capturedUpdateSet!.detectedTypeSource);
      expect(detectedTypeSource.sql).toBe(DETECTED_TYPE_SOURCE_CASE_SQL);
      expect(detectedTypeSource.params).toEqual(detectedTypeSourceCaseParams('agent_scan', 20));
    });

    it('an agent-classified host stamps detected_type_source=agent_scan as a plain value on a fresh insert', async () => {
      selectQueue = [
        ...baseSelectQueue(),
        [], // [6] no existing asset
        [], // [7] auto-link
      ];

      await processResults(makeData([
        { ip: '192.168.1.62', assetType: 'server', methods: [] },
      ]));

      expect(capturedInsertValues).not.toBeNull();
      expect(capturedInsertValues!.assetType).toBe('server');
      expect(capturedInsertValues!.detectedAssetType).toBe('server');
      expect(capturedInsertValues!.detectedTypeSource).toBe('agent_scan');
    });

    it('a host the agent could not classify but whose manufacturer maps via OUI stamps detected_type_source=vendor_oui on a fresh insert', async () => {
      vi.mocked(inferAssetTypeFromVendor).mockReturnValue('access_point' as never);

      selectQueue = [
        ...baseSelectQueue(),
        [], // [6] no existing asset
        [], // [7] auto-link
      ];

      await processResults(makeData([
        {
          ip: '192.168.1.63',
          assetType: 'unknown', // agent has no opinion
          manufacturer: 'Ruckus Wireless', // vendor is single-purpose enough to infer from
          methods: [],
        },
      ]));

      expect(capturedInsertValues).not.toBeNull();
      expect(capturedInsertValues!.assetType).toBe('access_point');
      expect(capturedInsertValues!.detectedAssetType).toBe('access_point');
      expect(capturedInsertValues!.detectedTypeSource).toBe('vendor_oui');
    });

    it('does not propagate device_role when this scan is outranked by the row\'s stored detection source', async () => {
      // The row was already classified by the UniFi controller (rank 30). This
      // scan can only offer a vendor_oui guess (rank 10) — weaker — so it must
      // not just skip the asset write (covered by buildClassificationWrite's own
      // SQL guard), it must ALSO skip the JS-side device_role propagation. If it
      // didn't, the OUI guess the asset row just rejected would leak onto the
      // linked device's role anyway and reintroduce the flap one table over.
      vi.mocked(inferAssetTypeFromVendor).mockReturnValue('access_point' as never);

      const updateCalls: Array<{ table: unknown; args: Record<string, unknown> }> = [];
      vi.mocked(mockDb.update).mockImplementation((table: unknown) => {
        const chain: Record<string, unknown> = {};
        chain.set = (args: Record<string, unknown>) => {
          updateCalls.push({ table, args });
          return chain;
        };
        chain.where = () => Promise.resolve([]);
        return chain;
      });

      selectQueue = [
        ...baseSelectQueue(),
        [{ id: 'asset-1', typeSource: 'auto', detectedTypeSource: 'unifi_controller' }], // [6] existing — UniFi already won this row
        [{ linkedDeviceId: null }],                                                        // [7] not yet linked
        [{ deviceId: 'device-1' }],                                                        // [8] auto-link match found
        // [9] target-device select: NOT consumed by a correct implementation
        // (classificationApplied is false before that point), but seeded with
        // a row that WOULD pass the deviceRoleSource !== 'manual' check anyway
        // — so if the rank guard regressed to a no-op, this select would be
        // reached, the row would be consumed, and deviceRole WOULD be updated,
        // failing the assertion below. An empty row here would let a regressed
        // guard pass vacuously (target undefined → update skipped for the
        // wrong reason), which is exactly the trap this test must not fall into.
        [{ deviceRoleSource: 'auto' }],
      ];

      await processResults(makeData([
        {
          ip: '192.168.1.64',
          mac: 'aa:bb:cc:11:22:33',
          assetType: 'unknown',
          manufacturer: 'Ruckus Wireless',
          methods: [],
        },
      ]));

      const deviceTableUpdates = updateCalls.filter((c) => c.table === devices);
      expect(deviceTableUpdates.find((c) => 'deviceRole' in c.args)).toBeUndefined();

      // Sanity check the harness actually exercised the auto-link branch (so a
      // vacuously-empty updateCalls list — e.g. from a wiring mistake — would
      // fail loudly here instead of the assertion above passing for the wrong
      // reason).
      const assetTableUpdates = updateCalls.filter((c) => c.table === discoveredAssets);
      expect(assetTableUpdates.length).toBeGreaterThan(0);
    });
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
