import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DATASET_ADAPTERS, EXPORT_DATASETS } from './aiToolsExportDatasets';
import type { AnalysisSensitiveGate } from '../db/schema/aiAgents';

const searchFleetLogs = vi.fn();
vi.mock('./logSearch', () => ({ searchFleetLogs: (...a: unknown[]) => searchFleetLogs(...a) }));

const canReadSensitiveEventLogCategory = vi.fn(async () => false);
vi.mock('./eventLogSensitivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./eventLogSensitivity')>();
  return {
    ...actual,
    canReadSensitiveEventLogCategory: (...a: unknown[]) => canReadSensitiveEventLogCategory(...(a as [])),
  };
});

// Only the agent_logs adapter (and metrics, untested here) issues a raw
// db.select(); every other adapter delegates entirely to a mocked builder
// above. Mocked with the same chain shape aiToolsAgentLogs.test.ts already
// uses for the tool this adapter mirrors.
const dbSelect = vi.fn();
vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => dbSelect(...a) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const resolveSiteAllowedDeviceIds = vi.fn(async () => null as string[] | null);
vi.mock('./aiToolsSiteScope', async (importOriginal) => {
  // Partial mock: `buildAgentLogConditions` also calls `deviceScopeCondition`
  // (the exact-device axis, #6096 RC3), and a hand-listed mock silently breaks
  // every time that module grows an export.
  const actual = await importOriginal<typeof import('./aiToolsSiteScope')>();
  return {
    ...actual,
    resolveSiteAllowedDeviceIds: (...a: unknown[]) => resolveSiteAllowedDeviceIds(...(a as [])),
    SITE_SCOPE_EMPTY_NOTE: '',
  };
});

const generateDeviceInventoryReport = vi.fn();
const readDeviceInventoryRows = vi.fn(async (..._args: unknown[]) => [{ deviceId: 'd1' }]);
const readSoftwareInventoryRows = vi.fn(async (..._args: unknown[]) => [{ softwareName: 'App' }]);
vi.mock('./reportGenerationService', () => ({
  generateDeviceInventoryReport: (...a: unknown[]) => generateDeviceInventoryReport(...a),
  generateSoftwareInventoryReport: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  readDeviceInventoryRows: (...args: unknown[]) => readDeviceInventoryRows(...args),
  readSoftwareInventoryRows: (...args: unknown[]) => readSoftwareInventoryRows(...args),
}));
vi.mock('./aiToolsFleet', () => ({ aiLiveReportAuthority: async () => ({ scope: { kind: 'live_v1' } }) }));

/** W02: every request carries the run's frozen grants and a fresh notes array (adapters push into it). */
function reqDefaults() {
  return { exportGrants: { datasets: [...EXPORT_DATASETS] as string[], sensitiveGates: [] as AnalysisSensitiveGate[] }, notes: [] as string[] };
}

const auth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null, canAccessSite: undefined } as never;
const siteAuth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: ['site-1'], canAccessSite: () => true } as never;

describe('dataset adapters', () => {
  beforeEach(() => {
    searchFleetLogs.mockReset();
    canReadSensitiveEventLogCategory.mockReset();
    canReadSensitiveEventLogCategory.mockResolvedValue(false);
    resolveSiteAllowedDeviceIds.mockReset();
    resolveSiteAllowedDeviceIds.mockResolvedValue(null);
    generateDeviceInventoryReport.mockReset();
    readDeviceInventoryRows.mockClear();
    readSoftwareInventoryRows.mockClear();
    dbSelect.mockReset();
  });

  it('covers every dataset named in the spec', () => {
    expect(Object.keys(DATASET_ADAPTERS).sort()).toEqual([...EXPORT_DATASETS].sort());
    expect(EXPORT_DATASETS).toContain('event_logs');
    expect(EXPORT_DATASETS).toContain('custom_fields');
  });

  it('EXPORT_DATASET_REQUIREMENTS has exactly one entry per EXPORT_DATASETS member', async () => {
    const { EXPORT_DATASET_REQUIREMENTS } = await import('./aiToolsExportPermissions');
    expect(Object.keys(EXPORT_DATASET_REQUIREMENTS).sort()).toEqual([...EXPORT_DATASETS].sort());
  });

  it('every adapter declares the tier of its source tool and never above 2', () => {
    for (const adapter of Object.values(DATASET_ADAPTERS)) {
      expect([1, 2]).toContain(adapter.tier);
    }
  });

  describe.each(['device_inventory', 'software_inventory'] as const)('agent %s', (dataset) => {
    const agentAuth = {
      orgId: 'org-1', principal: { kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' },
      allowedDeviceIds: ['d1', 'd2'], allowedSiteIds: ['site-1'], canAccessSite: (id: string) => id === 'site-1',
    } as never;
    const request = { auth: agentAuth, orgId: 'org-1', filters: {}, deviceIds: null,
      runTargets: ['d1', 'd3'], siteId: 'site-1', pageSize: 500, ...reqDefaults() };

    it('uses scoped rows without human report authority and intersects every device ceiling', async () => {
      const pager = await DATASET_ADAPTERS[dataset].createPager({ ...request, deviceIds: ['d1', 'd2', 'd3'] });
      expect((await pager(null)).rows).toHaveLength(1);
      const reader = dataset === 'device_inventory' ? readDeviceInventoryRows : readSoftwareInventoryRows;
      expect(reader).toHaveBeenCalledOnce();
      const [orgId, conditions] = reader.mock.calls[0]!;
      expect(orgId).toBe('org-1');
      const dialect = new PgDialect();
      const queries = (conditions as SQL[]).map((condition) => dialect.sqlToQuery(condition));
      expect(queries.flatMap((query) => query.params)).toEqual(['d1', 'site-1', 'site-1']);
      expect(generateDeviceInventoryReport).not.toHaveBeenCalled();
    });

    // #6096 D4: a principal org that disagrees with the request org is a
    // CALLER bug, not a device-less run. An empty pager would report it as "no
    // data" — the one shape a data-minimisation boundary must never fake.
    it('throws on a cross-organization request instead of reporting an empty export', async () => {
      await expect(DATASET_ADAPTERS[dataset].createPager({ ...request, orgId: 'org-other' }))
        .rejects.toThrow(/organization/i);
      expect(readDeviceInventoryRows).not.toHaveBeenCalled();
      expect(readSoftwareInventoryRows).not.toHaveBeenCalled();
    });

    // A device-less run frame (ticket/anomaly/design principals never freeze
    // `runTargets`) must yield an empty export, not a hard error — a thrown
    // error here previously broke every non-`analysis` ai_agent run.
    it.each([[], null])('yields an empty pager for an absent or empty frozen device set, without throwing', async (runTargets) => {
      const pager = await DATASET_ADAPTERS[dataset].createPager({ ...request, runTargets });
      expect((await pager(null)).rows).toEqual([]);
      expect(readDeviceInventoryRows).not.toHaveBeenCalled();
      expect(readSoftwareInventoryRows).not.toHaveBeenCalled();
    });

    it('never treats an empty requested device set as unrestricted', async () => {
      const pager = await DATASET_ADAPTERS[dataset].createPager({ ...request, deviceIds: [] });
      expect((await pager(null)).rows).toEqual([]);
      expect(readDeviceInventoryRows).not.toHaveBeenCalled();
      expect(readSoftwareInventoryRows).not.toHaveBeenCalled();
    });

    it('refuses a site outside the authenticated ceiling', async () => {
      const pager = await DATASET_ADAPTERS[dataset].createPager({ ...request, siteId: 'site-other' });
      expect((await pager(null)).rows).toEqual([]);
      expect(readDeviceInventoryRows).not.toHaveBeenCalled();
      expect(readSoftwareInventoryRows).not.toHaveBeenCalled();
    });
  });

  it('event_logs pages with the keyset cursor searchFleetLogs returns', async () => {
    searchFleetLogs
      .mockResolvedValueOnce({ results: [{ log: { id: 'a', timestamp: new Date(0), level: 'info', category: 'system', source: 's', eventId: '1', message: 'm', deviceId: 'd1' }, device: null, site: null }], nextCursor: 'cur-1', hasMore: true })
      .mockResolvedValueOnce({ results: [{ log: { id: 'b', timestamp: new Date(0), level: 'info', category: 'system', source: 's', eventId: '2', message: 'm2', deviceId: 'd1' }, device: null, site: null }], nextCursor: null, hasMore: false });

    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });

    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ id: 'a', message: 'm' });
    expect(first.nextCursor).toBe('cur-1');

    const second = await pager('cur-1');
    expect(second.nextCursor).toBeNull();
    expect(searchFleetLogs.mock.calls[1]![1]).toMatchObject({ cursor: 'cur-1', limit: 500 });
  });

  it('event_logs passes the requested device set through to the builder', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: { level: ['error'] }, deviceIds: ['d1', 'd2'], runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ deviceIds: ['d1', 'd2'], level: ['error'] });
  });

  it('event_logs reads security rows only when the run holds the frozen security_events gate, and notes it otherwise', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const base = { auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500 };
    const heldReq = { ...base, exportGrants: { datasets: ['event_logs'], sensitiveGates: ['security_events' as const] }, notes: [] as string[] };
    await (await DATASET_ADAPTERS.event_logs.createPager(heldReq))(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ canReadSensitiveCategory: true });
    expect(heldReq.notes).toEqual([]);
    const notHeldReq = { ...base, exportGrants: { datasets: ['event_logs'], sensitiveGates: [] as AnalysisSensitiveGate[] }, notes: [] as string[] };
    await (await DATASET_ADAPTERS.event_logs.createPager(notHeldReq))(null);
    expect(searchFleetLogs.mock.calls[1]![1]).toMatchObject({ canReadSensitiveCategory: false });
    expect(notHeldReq.notes).toEqual(['Security-category event logs are not in this export: this run does not hold the security_events gate (devices:execute).']);
    // The RBAC check always denied a run principal (it has no role); the frozen gate replaces it.
    expect(canReadSensitiveEventLogCategory).not.toHaveBeenCalled();
  });

  it('event_logs notes nothing when it exports nothing (an empty device set)', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue([]);
    const r = { auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults() };
    expect(await (await DATASET_ADAPTERS.event_logs.createPager(r))(null)).toEqual({ rows: [], nextCursor: null });
    expect(r.notes).toEqual([]);
  });

  it('event_logs surfaces a clean pager error instead of an uncaught throw when a caller without the permission requests only the sensitive category', async () => {
    canReadSensitiveEventLogCategory.mockResolvedValue(false);
    const { SensitiveEventLogAccessError } = await import('./eventLogSensitivity');
    searchFleetLogs.mockImplementation(() => { throw new SensitiveEventLogAccessError(); });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: { category: ['security'] }, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    await expect(pager(null)).rejects.toThrow(SensitiveEventLogAccessError);
  });

  // --- site axis: the narrowing `search_logs` performs at aiToolsEventLogs.ts:84 ---

  it('event_logs narrows a site-restricted caller to its in-scope devices', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue(['d-in-scope']);
    searchFleetLogs.mockResolvedValue({
      results: [{ log: { id: 'a', timestamp: new Date(0), level: 'info', category: 'system', source: 's', eventId: '1', message: 'm', deviceId: 'd-in-scope' }, device: null, site: null }],
      nextCursor: null, hasMore: false,
    });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    const page = await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d-in-scope'] });
    expect(page.rows.map((r) => r.deviceId)).toEqual(['d-in-scope']);
  });

  it('event_logs yields an empty artifact when a site-restricted caller has zero in-scope devices', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue([]);
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    const page = await pager(null);
    expect(page).toEqual({ rows: [], nextCursor: null });
    expect(searchFleetLogs).not.toHaveBeenCalled();
  });

  it('device_inventory passes the requested deviceIds straight into the generator filter (#5776)', async () => {
    // #5776: the generator now honours filters.deviceIds directly, so the
    // adapter no longer post-filters by hostname (which is not unique within
    // an org — see the "shares a hostname" test below).
    generateDeviceInventoryReport.mockResolvedValue({
      rows: [{ deviceId: 'd1', hostname: 'host-d1', osType: 'windows' }],
      rowCount: 1,
    });
    const pager = await DATASET_ADAPTERS.device_inventory.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    const page = await pager(null);
    expect(generateDeviceInventoryReport.mock.calls[0]![1]).toMatchObject({
      filters: { deviceIds: ['d1'] },
    });
    expect(page.rows.map((r) => r.hostname)).toEqual(['host-d1']);
  });

  it('device_inventory falls back to the run target set when no deviceIds were supplied', async () => {
    generateDeviceInventoryReport.mockResolvedValue({
      rows: [{ deviceId: 'd1', hostname: 'host-d1' }],
      rowCount: 1,
    });
    const pager = await DATASET_ADAPTERS.device_inventory.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1'], siteId: null, pageSize: 500, ...reqDefaults(),
    });
    const page = await pager(null);
    expect(generateDeviceInventoryReport.mock.calls[0]![1]).toMatchObject({
      filters: { deviceIds: ['d1'] },
    });
    expect(page.rows.map((r) => r.hostname)).toEqual(['host-d1']);
  });

  it('device_inventory: two devices sharing a hostname — only the admitted device is exported', async () => {
    // Simulates what the real `inArray(devices.id, ...)` query does: it
    // returns only the row for the admitted device, even though DEVICE_B
    // shares its hostname with the admitted DEVICE_A. Before #5776 the
    // adapter resolved the restriction to a Set<hostname> and post-filtered
    // `row.hostname` — since both devices share 'shared-host', that filter
    // could not tell them apart and both/either could ride along. Asserting
    // the generator call args here proves the restriction is now keyed on
    // device id, not hostname.
    generateDeviceInventoryReport.mockImplementation(async (_orgId, config) => {
      const allowed = new Set((config.filters?.deviceIds ?? []) as string[]);
      const all = [
        { deviceId: 'device-a', hostname: 'shared-host' },
        { deviceId: 'device-b', hostname: 'shared-host' },
      ];
      const rows = all.filter((r) => allowed.size === 0 || allowed.has(r.deviceId));
      return { rows, rowCount: rows.length };
    });

    const pager = await DATASET_ADAPTERS.device_inventory.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['device-a'], runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    const page = await pager(null);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ deviceId: 'device-a', hostname: 'shared-host' });
  });

  // --- agent_logs: orders and pages on the RECEIPT-time keyset (created_at,
  // id), matching search_agent_logs and the agent_logs_org_created_at_idx
  // index — NOT the agent-reported `timestamp`, which is explicitly
  // unreliable for ordering across receipts (aiToolsAgentLogs.ts's own
  // comment: "agent event time only breaks ties WITHIN a single receipt
  // instant, which cannot reorder rows across receipts"). ---

  function mockAgentLogsSelect(rows: unknown[]) {
    const orderBy = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) });
    dbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy }) }),
    });
    return orderBy;
  }

  it('agent_logs orders by (created_at, id) — the same keyset search_agent_logs and its index use', async () => {
    const orderBy = mockAgentLogsSelect([]);
    const pager = await DATASET_ADAPTERS.agent_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    await pager(null);
    const dialect = new PgDialect();
    const orderingSql = (orderBy.mock.calls[0] as SQL[])
      .map((clause) => dialect.sqlToQuery(clause).sql)
      .join(', ');
    expect(orderingSql).toContain('"created_at"');
  });

  it('agent_logs pages on a created_at cursor, not the unreliable event timestamp', async () => {
    const row = {
      id: 'log-1', deviceId: 'd1', timestamp: new Date('2026-02-15T10:00:00.000Z'),
      createdAt: new Date('2026-02-15T10:00:05.123Z'), level: 'info', component: 'main',
      message: 'm', fields: {}, agentVersion: '1.0.0',
    };
    mockAgentLogsSelect([row]);
    const pager = await DATASET_ADAPTERS.agent_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 1, ...reqDefaults(),
    });

    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ id: 'log-1' });
    // The cursor is built from createdAt (receipt time), not the agent-
    // reported event timestamp — the two are deliberately different above.
    expect(new Date(decoded.t).toISOString()).toBe(row.createdAt.toISOString());
  });

  it('agent_logs narrows a site-restricted caller to its in-scope devices, empty when none', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue([]);
    const pager = await DATASET_ADAPTERS.agent_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    });
    const page = await pager(null);
    expect(page).toEqual({ rows: [], nextCursor: null });
    expect(dbSelect).not.toHaveBeenCalled();
  });
});

// --- run frame: the FROZEN device set of an analysis run (W04, #5715) -------
// `aiToolsExport.ts` refuses a model-supplied `deviceIds` list that strays
// outside `runTargets` — which bounds nothing when the model supplies no list
// at all. These pin the adapter-side half: with a run frame present, an
// unfiltered export is bounded to the frame rather than to the whole org.

describe('dataset adapters — analysis run frame', () => {
  beforeEach(() => {
    searchFleetLogs.mockReset();
    canReadSensitiveEventLogCategory.mockReset();
    canReadSensitiveEventLogCategory.mockResolvedValue(false);
    resolveSiteAllowedDeviceIds.mockReset();
    resolveSiteAllowedDeviceIds.mockResolvedValue(null);
  });

  it('event_logs with NO deviceIds filter is bounded to the run frame', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1', 'd2'],
      siteId: null, pageSize: 500, ...reqDefaults(),
    } as never);
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d1', 'd2'] });
  });

  it('event_logs intersects the run frame with the site axis rather than replacing it', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue(['d2', 'd3']);
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1', 'd2'],
      siteId: null, pageSize: 500, ...reqDefaults(),
    } as never);
    await pager(null);
    // d1 is in the frame but outside the caller's sites; d3 is in the sites but
    // outside the frame. Only d2 satisfies both.
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d2'] });
  });

  it('event_logs exports nothing when the frame and the site axis do not overlap', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue(['d9']);
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1'],
      siteId: null, pageSize: 500, ...reqDefaults(),
    } as never);
    expect(await pager(null)).toEqual({ rows: [], nextCursor: null });
    expect(searchFleetLogs).not.toHaveBeenCalled();
  });

  it('event_logs is unrestricted when there is no run frame (direct chat / MCP)', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(),
    } as never);
    await pager(null);
    // An absent frame means "no run", NOT "no devices" — the pre-W04 behaviour
    // for every chat-path export has to be preserved exactly.
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: null });
  });
  // W02 Task 8: an exact-device set on the auth (a run admitted with no
  // devices carries `allowedDeviceIds: []`) is "no devices", never "no frame".
  const req = (over: Record<string, unknown>) => ({
    auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, ...reqDefaults(), ...over,
  }) as never;

  it('event_logs exports nothing for a run whose exact-device set is empty and that has no frame', async () => {
    const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(auth as object), allowedDeviceIds: [] }, runTargets: null }));
    expect(await pager(null)).toEqual({ rows: [], nextCursor: null });
    expect(searchFleetLogs).not.toHaveBeenCalled();
  });

  it('event_logs exports nothing for an empty exact-device set even with an empty frame', async () => {
    const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(auth as object), allowedDeviceIds: [] }, runTargets: [] }));
    expect(await pager(null)).toEqual({ rows: [], nextCursor: null });
    expect(searchFleetLogs).not.toHaveBeenCalled();
  });

  it('event_logs narrows to the exact-device set when the run carries one and no frame', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(auth as object), allowedDeviceIds: ['d1', 'd2'] }, runTargets: null }));
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d1', 'd2'] });
  });

  it('event_logs intersects the exact-device set with the run frame', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(auth as object), allowedDeviceIds: ['d1', 'd2'] }, runTargets: ['d2', 'd3'] }));
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d2'] });
  });

  it('event_logs intersects the exact-device set with the site axis', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue(['d2', 'd3']);
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(siteAuth as object), allowedDeviceIds: ['d1', 'd2'] }, runTargets: null }));
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d2'] });
  });

  it('an unrestricted caller (no exact-device set, no site axis, no frame) is still unrestricted', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ runTargets: null }));
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: null });
  });
});
