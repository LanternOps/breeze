import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATASET_ADAPTERS, EXPORT_DATASETS } from './aiToolsExportDatasets';

const searchFleetLogs = vi.fn();
vi.mock('./logSearch', () => ({ searchFleetLogs: (...a: unknown[]) => searchFleetLogs(...a) }));

const resolveSiteAllowedDeviceIds = vi.fn(async () => null as string[] | null);
vi.mock('./aiToolsSiteScope', () => ({
  resolveSiteAllowedDeviceIds: (...a: unknown[]) => resolveSiteAllowedDeviceIds(...(a as [])),
  SITE_SCOPE_EMPTY_NOTE: '',
}));

const generateDeviceInventoryReport = vi.fn();
vi.mock('./reportGenerationService', () => ({
  generateDeviceInventoryReport: (...a: unknown[]) => generateDeviceInventoryReport(...a),
  generateSoftwareInventoryReport: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));
vi.mock('./aiToolsFleet', () => ({ aiLiveReportAuthority: async () => ({ scope: { kind: 'live_v1' } }) }));

const readCustomFieldDefinitions = vi.fn(async () => [] as Array<Record<string, unknown>>);
vi.mock('./aiToolsDevice', () => ({
  readCustomFieldDefinitions: () => readCustomFieldDefinitions(),
  customFieldDefinitionConditions: () => [],
}));

const verifyDeviceAccess = vi.fn(async (deviceId: string) => ({ device: { id: deviceId, hostname: `host-${deviceId}`, customFields: { tier: 'gold' } } }));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: (id: string) => verifyDeviceAccess(id) }));

const auth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null, canAccessSite: undefined } as never;
const siteAuth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: ['site-1'], canAccessSite: () => true } as never;

describe('dataset adapters', () => {
  beforeEach(() => {
    searchFleetLogs.mockReset();
    resolveSiteAllowedDeviceIds.mockReset();
    resolveSiteAllowedDeviceIds.mockResolvedValue(null);
    generateDeviceInventoryReport.mockReset();
    readCustomFieldDefinitions.mockReset();
    readCustomFieldDefinitions.mockResolvedValue([]);
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

  it('device_inventory restricts rows to the requested devices even though the generator ignores deviceIds', async () => {
    generateDeviceInventoryReport.mockResolvedValue({
      rows: [
        { hostname: 'host-d1', osType: 'windows' },
        { hostname: 'host-d2', osType: 'windows' },
        { hostname: 'host-d3', osType: 'windows' },
      ],
      rowCount: 3,
    });
    const pager = await DATASET_ADAPTERS.device_inventory.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page.rows.map((r) => r.hostname)).toEqual(['host-d1']);
  });

  it('device_inventory falls back to the run target set when no deviceIds were supplied', async () => {
    generateDeviceInventoryReport.mockResolvedValue({
      rows: [{ hostname: 'host-d1' }, { hostname: 'host-d9' }],
      rowCount: 2,
    });
    const pager = await DATASET_ADAPTERS.device_inventory.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1'], siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page.rows.map((r) => r.hostname)).toEqual(['host-d1']);
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
});
