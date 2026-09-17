import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DATASET_ADAPTERS, EXPORT_DATASETS } from './aiToolsExportDatasets';

const searchFleetLogs = vi.fn();
vi.mock('./logSearch', () => ({ searchFleetLogs: (...a: unknown[]) => searchFleetLogs(...a) }));

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
vi.mock('./aiToolsSiteScope', () => ({
  resolveSiteAllowedDeviceIds: (...a: unknown[]) => resolveSiteAllowedDeviceIds(...(a as [])),
  SITE_SCOPE_EMPTY_NOTE: '',
}));

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

const readCustomFieldDefinitions = vi.fn(async () => [] as Array<Record<string, unknown>>);
vi.mock('./aiToolsDevice', () => ({
  readCustomFieldDefinitions: () => readCustomFieldDefinitions(),
  customFieldDefinitionConditions: () => [],
}));

const verifyDeviceAccess = vi.fn(async (deviceId: string) =>
  ({ device: { id: deviceId, hostname: `host-${deviceId}`, customFields: { tier: 'gold' } } }) as
    | { device: { id: string; hostname: string; customFields: Record<string, unknown> } }
    | { error: string });
vi.mock('./aiTools', () => ({ verifyDeviceAccess: (id: string) => verifyDeviceAccess(id) }));

const readDeviceFindings = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
const readCatalog = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('./aiToolsVulnerability', () => ({
  readDeviceFindings: (...a: unknown[]) => readDeviceFindings(...a),
  readCatalog: (...a: unknown[]) => readCatalog(...a),
  normStatus: (v: unknown) => (typeof v === 'string' ? v : 'open'),
}));

const auth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null, canAccessSite: undefined } as never;
const siteAuth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: ['site-1'], canAccessSite: () => true } as never;

describe('dataset adapters', () => {
  beforeEach(() => {
    searchFleetLogs.mockReset();
    resolveSiteAllowedDeviceIds.mockReset();
    resolveSiteAllowedDeviceIds.mockResolvedValue(null);
    generateDeviceInventoryReport.mockReset();
    readDeviceInventoryRows.mockClear();
    readSoftwareInventoryRows.mockClear();
    readCustomFieldDefinitions.mockReset();
    readCustomFieldDefinitions.mockResolvedValue([]);
    dbSelect.mockReset();
    verifyDeviceAccess.mockClear();
    readDeviceFindings.mockReset();
    readDeviceFindings.mockResolvedValue([]);
    readCatalog.mockReset();
    readCatalog.mockResolvedValue([]);
  });

  it('covers every dataset named in the spec', () => {
    expect(Object.keys(DATASET_ADAPTERS).sort()).toEqual([...EXPORT_DATASETS].sort());
    expect(EXPORT_DATASETS).toContain('event_logs');
    expect(EXPORT_DATASETS).toContain('custom_fields');
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
      runTargets: ['d1', 'd3'], siteId: 'site-1', pageSize: 500 };

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

    it('denies a cross-organization request before reading inventory', async () => {
      await expect(DATASET_ADAPTERS[dataset].createPager({ ...request, orgId: 'org-other' })).rejects.toThrow('frozen device scope');
      expect(readDeviceInventoryRows).not.toHaveBeenCalled();
      expect(readSoftwareInventoryRows).not.toHaveBeenCalled();
    });

    it.each([[], null])('denies an absent or empty frozen device set', async (runTargets) => {
      await expect(DATASET_ADAPTERS[dataset].createPager({ ...request, runTargets })).rejects.toThrow('frozen device scope');
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
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
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
      auth, orgId: 'org-1', filters: { level: ['error'] }, deviceIds: ['d1', 'd2'], runTargets: null, siteId: null, pageSize: 500,
    });
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ deviceIds: ['d1', 'd2'], level: ['error'] });
  });

  // --- site axis: the narrowing `search_logs` performs at aiToolsEventLogs.ts:84 ---

  it('event_logs narrows a site-restricted caller to its in-scope devices', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue(['d-in-scope']);
    searchFleetLogs.mockResolvedValue({
      results: [{ log: { id: 'a', timestamp: new Date(0), level: 'info', category: 'system', source: 's', eventId: '1', message: 'm', deviceId: 'd-in-scope' }, device: null, site: null }],
      nextCursor: null, hasMore: false,
    });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d-in-scope'] });
    expect(page.rows.map((r) => r.deviceId)).toEqual(['d-in-scope']);
  });

  it('event_logs yields an empty artifact when a site-restricted caller has zero in-scope devices', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue([]);
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
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
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
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
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1'], siteId: null, pageSize: 500,
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
      auth, orgId: 'org-1', filters: {}, deviceIds: ['device-a'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ deviceId: 'device-a', hostname: 'shared-host' });
  });

  it('custom_fields includes partner-wide definitions via the shared reader', async () => {
    readCustomFieldDefinitions.mockResolvedValue([
      { id: 'def-partner', name: 'Contract tier', fieldKey: 'tier', type: 'text' },
    ]);
    const pager = await DATASET_ADAPTERS.custom_fields.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(readCustomFieldDefinitions).toHaveBeenCalledTimes(1);
    expect(page.rows).toEqual([
      expect.objectContaining({ deviceId: 'd1', fieldKey: 'tier', fieldName: 'Contract tier', value: 'gold' }),
    ]);
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
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
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
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 1,
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
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page).toEqual({ rows: [], nextCursor: null });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  // --- metrics: per-device fan-out over a raw deviceMetrics select, paced at
  // EXPORT_DEVICE_CONCURRENCY and gated by the adapter's own verifyDeviceAccess ---

  function mockMetricsSelect(rows: unknown[]) {
    const orderBy = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) });
    dbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy }) }),
    });
  }

  // NOTE: exactly one deviceId per test here, deliberately. `runWithConcurrency`
  // resolves this adapter's `getVerifyDeviceAccess()` dynamic import() in
  // parallel across devices; under this test file's mocked `./aiTools`, two+
  // concurrent FIRST resolutions of the same dynamic import race Vite's SSR
  // module runner and can silently load the real (unmocked) module instead —
  // every other adapter test in this file has the same one-device constraint.
  // (Confirmed by direct reproduction during #5775's review: priming the
  // import ahead of time does NOT avoid the race.) A consequence for THIS
  // adapter specifically: how a >1-device EXPORT_DEVICE_CONCURRENCY batch
  // interacts with per-device intra-batch pagination (one device exhausting
  // early while a sibling in the same batch still pages, and the batch not
  // advancing until every entry is `done`) is exercised by hand-tracing the
  // closure logic below, not by a unit test — that needs either a real-DB
  // integration test or a from-scratch mock of aiTools.ts's whole import
  // graph, both out of scope for this file's existing single-device pattern.

  it('metrics reads a device\'s samples, gated by verifyDeviceAccess', async () => {
    mockMetricsSelect([
      { timestamp: new Date('2026-02-15T10:00:00.000Z'), cpuPercent: 50, ramPercent: 60, ramUsedMb: 4096, diskPercent: 70, diskUsedGb: 100 },
    ]);
    const pager = await DATASET_ADAPTERS.metrics.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(verifyDeviceAccess).toHaveBeenCalledWith('d1');
    expect(page.rows).toEqual([
      expect.objectContaining({ deviceId: 'd1', cpuPercent: 50, hostname: 'host-d1' }),
    ]);
    expect(page.nextCursor).toBeNull(); // the one device fits in the first EXPORT_DEVICE_CONCURRENCY batch
  });

  // NOTE: `mockMetricsSelect` above returns the SAME page from every
  // `db.select()` call — fine for the single-page tests, but a per-device
  // pagination test needs a DIFFERENT page per call, so it builds its own
  // sequenced select mock rather than reusing that helper.
  function mockMetricsPagedSelect(pages: Array<Array<Record<string, unknown>>>) {
    let call = 0;
    const limit = vi.fn().mockImplementation(async () => {
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return page;
    });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    dbSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
    return { where };
  }

  it('metrics paginates WITHIN a device via a timestamp cursor instead of hard-capping at pageSize (#5775)', async () => {
    const { where } = mockMetricsPagedSelect([
      [
        { timestamp: new Date('2026-02-15T10:02:00.000Z'), cpuPercent: 3, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 },
        { timestamp: new Date('2026-02-15T10:01:00.000Z'), cpuPercent: 2, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 },
      ],
      [
        { timestamp: new Date('2026-02-15T10:00:00.000Z'), cpuPercent: 1, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 },
      ],
    ]);
    const pager = await DATASET_ADAPTERS.metrics.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 2,
    });

    // First call comes back FULL (2 of 2) — more samples may exist for this
    // device, so the pager must NOT report done via a null nextCursor.
    const first = await pager(null);
    expect(first.rows.map((r) => r.cpuPercent)).toEqual([3, 2]);
    expect(first.nextCursor).not.toBeNull();

    // Second call re-queries the SAME device (not the next one — there is no
    // next device) using a timestamp cursor older than the last row seen.
    const second = await pager(first.nextCursor);
    expect(second.rows.map((r) => r.cpuPercent)).toEqual([1]);
    expect(second.nextCursor).toBeNull(); // short page: device exhausted, no more devices queued

    // The device gate runs once per device, not once per page.
    expect(verifyDeviceAccess).toHaveBeenCalledTimes(1);

    expect(where).toHaveBeenCalledTimes(2);
    const dialect = new PgDialect();
    // The cursored page must keep BOTH bounds: the `since` (hoursBack) floor
    // AND the new `before` ceiling — a refactor that swapped rather than
    // appended the cursor condition would silently widen the export past its
    // requested time window without any test catching it.
    const secondWhereSql = dialect.sqlToQuery(where.mock.calls[1]![0] as SQL).sql;
    expect(secondWhereSql).toContain('"timestamp" >');
    expect(secondWhereSql).toContain('"timestamp" <');
  });

  it('metrics marks a device done only after a SHORT page, even when its sample count is an exact multiple of pageSize', async () => {
    // A device with exactly 2×pageSize samples: the first two pages both come
    // back FULL and must NOT be treated as the exhaustion signal — only a page
    // shorter than pageSize may set `done`. This is the boundary the "full
    // page" vs. "short page" distinction hinges on; a `<=` instead of `<`
    // comparison would stop one page early and silently drop the last page.
    const { where } = mockMetricsPagedSelect([
      [
        { timestamp: new Date('2026-02-15T10:03:00.000Z'), cpuPercent: 4, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 },
        { timestamp: new Date('2026-02-15T10:02:00.000Z'), cpuPercent: 3, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 },
      ],
      [
        { timestamp: new Date('2026-02-15T10:01:00.000Z'), cpuPercent: 2, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 },
        { timestamp: new Date('2026-02-15T10:00:00.000Z'), cpuPercent: 1, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 },
      ],
      [], // exhaustion signal: a page shorter than pageSize (here, empty)
    ]);
    const pager = await DATASET_ADAPTERS.metrics.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 2,
    });

    const first = await pager(null);
    expect(first.rows.map((r) => r.cpuPercent)).toEqual([4, 3]);
    expect(first.nextCursor).not.toBeNull();

    const second = await pager(first.nextCursor);
    expect(second.rows.map((r) => r.cpuPercent)).toEqual([2, 1]);
    expect(second.nextCursor).not.toBeNull(); // still full — not yet exhausted

    const third = await pager(second.nextCursor);
    expect(third.rows).toEqual([]);
    expect(third.nextCursor).toBeNull(); // short (empty) page: NOW exhausted

    expect(where).toHaveBeenCalledTimes(3);
    expect(verifyDeviceAccess).toHaveBeenCalledTimes(1);
  });

  it('metrics excludes a device verifyDeviceAccess denies, without failing the whole export', async () => {
    verifyDeviceAccess.mockImplementationOnce(async () => ({ error: 'not found' }));
    mockMetricsSelect([{ timestamp: new Date('2026-02-15T10:00:00.000Z'), cpuPercent: 1 }]);
    const pager = await DATASET_ADAPTERS.metrics.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d-denied'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page.rows).toEqual([]);
  });

  // --- vulnerabilities: per-device findings joined against the catalog ---

  it('vulnerabilities joins findings to the catalog per requested device', async () => {
    readDeviceFindings.mockImplementation(async (..._a: unknown[]) => {
      const opts = _a[1] as { deviceId?: string };
      return [{ id: 'f1', deviceId: opts.deviceId, vulnerabilityId: 'v1', status: 'open', riskScore: '80' }];
    });
    readCatalog.mockResolvedValue([
      { id: 'v1', cveId: 'CVE-2026-1', severity: 'critical', cvssScore: '9.8', knownExploited: true, epssScore: '0.9', patchAvailable: true },
    ]);
    const pager = await DATASET_ADAPTERS.vulnerabilities.createPager({
      auth, orgId: 'org-1', filters: { status: 'open' }, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(verifyDeviceAccess).toHaveBeenCalledWith('d1');
    expect(page.rows).toEqual([
      expect.objectContaining({ deviceId: 'd1', cveId: 'CVE-2026-1', severity: 'critical', knownExploited: true }),
    ]);
  });

  it('vulnerabilities drops findings whose CVE is not in the catalog rather than exporting a partial row', async () => {
    readDeviceFindings.mockResolvedValue([{ id: 'f1', deviceId: 'd1', vulnerabilityId: 'v-missing', status: 'open', riskScore: null }]);
    readCatalog.mockResolvedValue([]); // catalog lookup came back empty
    const pager = await DATASET_ADAPTERS.vulnerabilities.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page.rows).toEqual([]);
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
    resolveSiteAllowedDeviceIds.mockReset();
    resolveSiteAllowedDeviceIds.mockResolvedValue(null);
  });

  it('event_logs with NO deviceIds filter is bounded to the run frame', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1', 'd2'],
      siteId: null, pageSize: 500,
    } as never);
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d1', 'd2'] });
  });

  it('event_logs intersects the run frame with the site axis rather than replacing it', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue(['d2', 'd3']);
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1', 'd2'],
      siteId: null, pageSize: 500,
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
      siteId: null, pageSize: 500,
    } as never);
    expect(await pager(null)).toEqual({ rows: [], nextCursor: null });
    expect(searchFleetLogs).not.toHaveBeenCalled();
  });

  it('event_logs is unrestricted when there is no run frame (direct chat / MCP)', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
    } as never);
    await pager(null);
    // An absent frame means "no run", NOT "no devices" — the pre-W04 behaviour
    // for every chat-path export has to be preserved exactly.
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: null });
  });
});
