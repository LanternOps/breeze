import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DispatchOutcome } from '../services/agentCommandRelay';

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
    autoLinkSuppressedAt: 'discoveredAssets.autoLinkSuppressedAt'
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
    deviceRoleSource: 'devices.deviceRoleSource',
    agentId: 'devices.agentId',
    status: 'devices.status',
    isEphemeral: 'devices.isEphemeral'
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

const agentRelayMock = {
  isAgentConnectedAnywhere: vi.fn(async () => true),
  dispatchCommandToAgent: vi.fn(async (): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
};
vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

vi.mock('../services/cronDue', () => ({
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

const { cleanupSpeculativeTopologyLinks, processResults, __testables } = await import('./discoveryWorker') as typeof import('./discoveryWorker');

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

  it('guards the device_role propagation on a manual asset type in SQL, not in JS', async () => {
    // The manual check used to be a JS decision made from the pre-read row. It
    // now rides in the statement's WHERE clause, because `type_source` can be
    // set by a user between that SELECT and this UPDATE. A mock can only prove
    // we built the right statement — assert the predicate is actually there.
    const updateCalls: Array<{ table: unknown; args: Record<string, unknown>; where: unknown }> = [];

    selectQueue = [
      ...baseSelectQueue(),
      [{ id: 'asset-1', typeSource: 'manual', detectedTypeSource: null }], // [6] existing — manual typeSource
      [{ linkedDeviceId: null }],                  // [7] not yet linked
      [{ deviceId: 'device-1' }],                  // [8] auto-link match found
    ];

    vi.mocked(mockDb.update).mockImplementation((table: unknown) => {
      const chain: Record<string, unknown> = {};
      let args: Record<string, unknown> = {};
      chain.set = (a: Record<string, unknown>) => { args = a; return chain; };
      chain.where = (w: unknown) => {
        updateCalls.push({ table, args, where: w });
        return Promise.resolve([]);
      };
      return chain;
    });

    await processResults(makeData([
      { ip: '192.168.1.53', mac: 'aa:bb:cc:dd:ee:53', assetType: 'workstation', methods: [] },
    ]));

    const roleUpdate = updateCalls.find((c) => c.table === devices && 'deviceRole' in c.args);
    expect(roleUpdate).toBeDefined();
    // Postgres decides whether any row matches; the carve-outs must be in the
    // predicate we send. `../db/schema` is mocked here, so column references
    // render as bound params carrying their mock identity — assert on those.
    // The literal rendered SQL is pinned in the real-DB suite,
    // src/__tests__/integration/discoveredAssetDetectionSource.integration.test.ts.
    const where = renderSqlQuery(roleUpdate!.where);
    // Reads the ASSET's type_source, not the stale pre-read value.
    expect(where.params).toContain('discoveredAssets.typeSource');
    // ...and the device's own manual role is protected too, with IS DISTINCT
    // FROM so a NULL device_role_source (never set) still counts as non-manual.
    expect(where.params).toContain('devices.deviceRoleSource');
    expect(where.sql).toContain(`is distinct from 'manual'`);
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

  it('unlink-then-rescan: suppresses auto-link until manually re-linked, then resumes', async () => {
    // Three phases against the SAME MAC/IP, each a separate processResults()
    // call (i.e. a separate worker run). updatesByPhase[n] collects every
    // `.set(...)` payload written during phase n.
    const updatesByPhase: Record<string, unknown>[][] = [[], [], []];
    let phase = 0;
    vi.mocked(mockDb.update).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = (args: Record<string, unknown>) => {
        updatesByPhase[phase]!.push(args);
        return chain;
      };
      chain.where = () => Promise.resolve([]);
      return chain;
    });

    // assetType deliberately maps to 'unknown' (not in mapAssetType's table) so
    // device-role propagation never fires — irrelevant to this test and would
    // otherwise require mocking an extra select per phase.
    const host: DiscoveredHostResult = {
      ip: '192.168.1.60',
      mac: 'aa:bb:cc:dd:ee:60',
      assetType: 'unrecognized-type',
      methods: [],
    };

    // ── Phase 1 (first worker run): fresh asset, MAC/IP matches an enrolled
    // device — auto-link writes linkedDeviceId + link_source:'auto'. ──
    phase = 0;
    selectCallIndex = 0;
    selectQueue = [
      ...baseSelectQueue(),
      [],                          // [6] no existing asset yet
      [{ deviceId: 'device-1' }],  // [7] auto-link match found
    ];
    await processResults(makeData([host]));

    expect(updatesByPhase[0]).toContainEqual(expect.objectContaining({
      linkedDeviceId: 'device-1',
      linkSource: 'auto',
    }));

    // ── Phase 2: simulate a manual unlink directly on the fixture — the
    // route under test elsewhere sets these; here we're only testing the
    // WORKER's read of that state. Rescanning the identical MAC/IP match
    // must skip the auto-linker entirely: no match query attempted, no
    // re-link write, row stays unlinked. ──
    phase = 1;
    selectCallIndex = 0;
    selectQueue = [
      ...baseSelectQueue(),
      [{
        id: 'new-asset-id',
        typeSource: 'auto',
        autoLinkSuppressedAt: new Date('2026-08-08T00:00:00Z'),
      }],                                                     // [6] existing, suppressed
      [{ linkedDeviceId: null, linkedDeviceSiteId: null }],    // [7] currentAsset — unlinked
      // Deliberately no [8]: if the worker still queried for a match while
      // suppressed, it would consume this slot and find no seeded rows — but
      // the real assertion is that NO re-link write happens below.
    ];
    await processResults(makeData([host]));

    expect(updatesByPhase[1]).not.toContainEqual(expect.objectContaining({ linkSource: 'auto' }));
    expect(
      updatesByPhase[1]!.some((u) => 'linkedDeviceId' in u && u.linkedDeviceId != null)
    ).toBe(false);

    // ── Phase 3: simulate what a manual re-link does — clears
    // auto_link_suppressed_at back to null. Rescanning the SAME MAC/IP match
    // now succeeds again: auto-linking resumes. ──
    phase = 2;
    selectCallIndex = 0;
    selectQueue = [
      ...baseSelectQueue(),
      [{ id: 'new-asset-id', typeSource: 'auto', autoLinkSuppressedAt: null }], // [6] existing, suppression cleared
      [{ linkedDeviceId: null, linkedDeviceSiteId: null }],                     // [7] currentAsset — still unlinked
      [{ deviceId: 'device-1' }],                                              // [8] auto-link match found again
    ];
    await processResults(makeData([host]));

    expect(updatesByPhase[2]).toContainEqual(expect.objectContaining({
      linkedDeviceId: 'device-1',
      linkSource: 'auto',
    }));
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

    it('never propagates this scan\'s own guess — device_role is read back out of the asset row', async () => {
      // The row was already classified by the UniFi controller (rank 30). This
      // scan can only offer a vendor_oui guess (rank 10), which the asset write's
      // SQL guard rejects. The device_role write must NOT carry that rejected
      // guess, or the OUI value would leak onto the linked device and reintroduce
      // the flap one table over (#3187).
      //
      // It does not do that by skipping the write from JS — a pre-read decision
      // can go stale. It writes a SUBQUERY that reads whatever the asset row
      // actually settled on, so the device converges on the winning value no
      // matter which classifier won.
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

      const roleUpdate = updateCalls.find((c) => c.table === devices && 'deviceRole' in c.args);
      expect(roleUpdate).toBeDefined();

      const value = renderSqlQuery(roleUpdate!.args.deviceRole);
      // Reads the asset's settled type (schema is mocked, so the column renders
      // as a bound param carrying its mock identity)...
      expect(value.sql).toContain('select');
      expect(value.params).toContain('discoveredAssets.assetType');
      // ...and never carries the guess this scan proposed.
      expect(value.params).not.toContain('access_point');

      // Sanity check the harness actually exercised the auto-link branch (so a
      // vacuously-empty updateCalls list — e.g. from a wiring mistake — would
      // fail loudly here instead of the assertions above passing for the wrong
      // reason).
      const assetTableUpdates = updateCalls.filter((c) => c.table === discoveredAssets);
      expect(assetTableUpdates.length).toBeGreaterThan(0);
    });

    it('propagates device_role for a classified host, scoped to the asset this scan just wrote', async () => {
      // The negative tests above only prove the guard is in the predicate.
      // Nothing proved the happy path actually fires, stamps the right source,
      // and scopes the value subquery to THIS asset — a regression that dropped
      // the id binding would silently read some other row's type.
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
        [{ id: 'asset-1', typeSource: 'auto', detectedTypeSource: null }], // [6] existing — nothing has claimed it
        [{ linkedDeviceId: null }],                                          // [7] not yet linked
        [{ deviceId: 'device-1' }],                                          // [8] auto-link match found
      ];

      await processResults(makeData([
        {
          ip: '192.168.1.65',
          mac: 'aa:bb:cc:44:55:66', // required for auto-link to run
          assetType: 'printer',     // agent-classified
          methods: [],
        },
      ]));

      const roleUpdate = updateCalls.find((c) => c.table === devices && 'deviceRole' in c.args);
      expect(roleUpdate).toBeDefined();
      expect(roleUpdate!.args.deviceRoleSource).toBe('discovery');

      const value = renderSqlQuery(roleUpdate!.args.deviceRole);
      expect(value.sql).toContain('select');
      expect(value.params).toContain('discoveredAssets.assetType');
      // Bound to the asset row this iteration upserted, not an unscoped read.
      expect(value.params).toContain('discoveredAssets.id');
      expect(value.params).toContain('asset-1');
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

describe('processDispatchScan (wave 3.5b #4084 — dispatch via facade)', () => {
  // Requested-agent path: profile select, then validateRequestedAgentForDiscovery's
  // devices select. Supplying data.agentId means the `if (!agentId)` site-auto
  // devices lookup never runs, keeping the select queue to exactly these two.
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

  let selectQueue: unknown[][];
  let selectCallIndex: number;
  let updateLog: Array<{ payload: Record<string, unknown> }>;

  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue = [[PROFILE_ROW], [VALID_AGENT_ROW]];
    selectCallIndex = 0;
    updateLog = [];

    vi.mocked(mockDb.select).mockImplementation(() =>
      makeSelectChain(selectQueue[selectCallIndex++] ?? [])
    );
    vi.mocked(mockDb.update).mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = (payload: Record<string, unknown>) => {
        updateLog.push({ payload });
        return chain;
      };
      chain.where = () => Promise.resolve([]);
      return chain;
    });

    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  });

  it('marks the job failed with "No online agent available for this site" (byte-identical to today) when no agent is connected anywhere, without calling dispatch', async () => {
    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: false, agentId: null, durationMs: expect.any(Number) });
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(updateLog.some((u) => (u.payload.errors as { message: string } | undefined)?.message === 'No online agent available for this site')).toBe(true);
    warn.mockRestore();
  });

  it('flips the job to running when the outcome is sent', async () => {
    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: true, agentId: 'agent-1', durationMs: expect.any(Number) });
    expect(updateLog.some((u) => u.payload.status === 'running')).toBe(true);
  });

  it('marks the job failed with "Failed to send command to agent" (today\'s message) when the outcome is offline', async () => {
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'offline' });

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: false, agentId: 'agent-1', durationMs: expect.any(Number) });
    expect(updateLog.some((u) => (u.payload.errors as { message: string } | undefined)?.message === 'Failed to send command to agent')).toBe(true);
  });

  it('marks the job failed naming the outcome when indeterminate', async () => {
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'indeterminate' });

    const result = await __testables.processDispatchScan(DATA);

    expect(result).toEqual({ dispatched: false, agentId: 'agent-1', durationMs: expect.any(Number) });
    expect(updateLog.some((u) => {
      const message = (u.payload.errors as { message?: string } | undefined)?.message;
      return typeof message === 'string' && /dispatch outcome indeterminate/i.test(message);
    })).toBe(true);
  });
});
