import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
  },
  deviceSoftware: {},
  deviceChangeLog: {
    orgId: 'deviceChangeLog.orgId',
    changeType: 'deviceChangeLog.changeType',
    subject: 'deviceChangeLog.subject',
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
    hostname: 'discoveredAssets.hostname',
    ipAddress: 'discoveredAssets.ipAddress',
    assetType: 'discoveredAssets.assetType',
    snmpData: 'discoveredAssets.snmpData',
    approvalStatus: 'discoveredAssets.approvalStatus',
    isOnline: 'discoveredAssets.isOnline',
    lastSeenAt: 'discoveredAssets.lastSeenAt',
    createdAt: 'discoveredAssets.createdAt',
    updatedAt: 'discoveredAssets.updatedAt',
  },
  networkMonitors: {
    assetId: 'networkMonitors.assetId',
    orgId: 'networkMonitors.orgId',
    isActive: 'networkMonitors.isActive',
    id: 'networkMonitors.id',
    updatedAt: 'networkMonitors.updatedAt',
  },
  snmpDevices: {
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    assetId: 'snmpDevices.assetId',
    snmpVersion: 'snmpDevices.snmpVersion',
    templateId: 'snmpDevices.templateId',
    pollingInterval: 'snmpDevices.pollingInterval',
    port: 'snmpDevices.port',
    isActive: 'snmpDevices.isActive',
    lastPolled: 'snmpDevices.lastPolled',
    lastStatus: 'snmpDevices.lastStatus',
    createdAt: 'snmpDevices.createdAt',
    community: 'snmpDevices.community',
    authPassword: 'snmpDevices.authPassword',
    privPassword: 'snmpDevices.privPassword',
    username: 'snmpDevices.username',
  },
  snmpMetrics: {
    id: 'snmpMetrics.id',
    deviceId: 'snmpMetrics.deviceId',
    oid: 'snmpMetrics.oid',
    name: 'snmpMetrics.name',
    value: 'snmpMetrics.value',
    valueType: 'snmpMetrics.valueType',
    timestamp: 'snmpMetrics.timestamp',
  },
  snmpTemplates: {
    id: 'snmpTemplates.id',
    orgId: 'snmpTemplates.orgId',
    isBuiltIn: 'snmpTemplates.isBuiltIn',
    sysObjectIdPrefixes: 'snmpTemplates.sysObjectIdPrefixes',
  },
  serviceProcessCheckResults: {
    id: 'serviceProcessCheckResults.id',
    orgId: 'serviceProcessCheckResults.orgId',
    deviceId: 'serviceProcessCheckResults.deviceId',
    watchType: 'serviceProcessCheckResults.watchType',
    name: 'serviceProcessCheckResults.name',
    status: 'serviceProcessCheckResults.status',
    cpuPercent: 'serviceProcessCheckResults.cpuPercent',
    memoryMb: 'serviceProcessCheckResults.memoryMb',
    pid: 'serviceProcessCheckResults.pid',
    details: 'serviceProcessCheckResults.details',
    autoRestartAttempted: 'serviceProcessCheckResults.autoRestartAttempted',
    autoRestartSucceeded: 'serviceProcessCheckResults.autoRestartSucceeded',
    timestamp: 'serviceProcessCheckResults.timestamp',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const siteHeader = c.req.header('x-restrict-site');
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    if (siteHeader) {
      c.set('permissions', {
        allowedSiteIds: siteHeader === '__empty__' ? [] : siteHeader.split(','),
      });
    }
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => true),
}));

vi.mock('../services/snmpTemplateSuggest', () => ({
  suggestTemplate: vi.fn(),
}));

import { monitoringRoutes } from './monitoring';
import { db } from '../db';
import { suggestTemplate } from '../services/snmpTemplateSuggest';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_HIDDEN = 'bbbbbbbb-0000-0000-0000-000000000002';
const OTHER_ORG_ASSET = '44444444-4444-4444-4444-444444444444';

function mockAssetLookup(row: Record<string, unknown> | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }),
    }),
  } as never);
}

describe('GET /monitoring/templates/suggest', () => {
  let app: Hono;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(suggestTemplate).mockReset();
    app = new Hono();
    app.route('/monitoring', monitoringRoutes);
  });

  const get = (assetId: string, site?: string) => app.request(
    `/monitoring/templates/suggest?assetId=${assetId}`,
    { headers: { Authorization: 'Bearer token', ...(site ? { 'x-restrict-site': site } : {}) } },
  );

  it('returns the suggestion with the sysObjectID it matched on', async () => {
    mockAssetLookup({
      id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, assetType: 'printer',
      snmpData: { sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', sysDescr: 'Xerox(R) C325 Color MFP; …' },
    });
    vi.mocked(suggestTemplate).mockResolvedValue({
      templateId: 'tpl-xerox', templateName: 'Xerox Printer', reason: 'Detected Xerox printer, using Xerox Printer',
    });

    const res = await get(ASSET_ID, SITE_ALLOWED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
      assetType: 'printer',
      suggestion: { templateId: 'tpl-xerox', templateName: 'Xerox Printer', reason: 'Detected Xerox printer, using Xerox Printer' },
    });
    expect(suggestTemplate).toHaveBeenCalledWith({
      sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1', assetType: 'printer', orgId: ORG_ID,
    });
  });

  it('returns a null suggestion with a null sysObjectID when the asset was never SNMP-scanned', async () => {
    mockAssetLookup({ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, assetType: 'unknown', snmpData: null });
    vi.mocked(suggestTemplate).mockResolvedValue(null);

    const res = await get(ASSET_ID, SITE_ALLOWED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sysObjectId: null, assetType: 'unknown', suggestion: null });
  });

  it('treats a non-string sysObjectID as null in the response and suggestion input', async () => {
    mockAssetLookup({
      id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, assetType: 'printer',
      snmpData: { sysObjectId: 253 },
    });
    vi.mocked(suggestTemplate).mockResolvedValue(null);

    const res = await get(ASSET_ID, SITE_ALLOWED);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sysObjectId: null, assetType: 'printer', suggestion: null });
    expect(suggestTemplate).toHaveBeenCalledWith({ sysObjectId: null, assetType: 'printer', orgId: ORG_ID });
  });

  it('404s for an asset outside the caller\'s org', async () => {
    mockAssetLookup(null);
    const res = await get(OTHER_ORG_ASSET);
    expect(res.status).toBe(404);
    expect(suggestTemplate).not.toHaveBeenCalled();
  });

  it('404s (opaque, matching a missing asset) for a site the caller cannot see, before suggesting anything (#5777)', async () => {
    mockAssetLookup({ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_HIDDEN, assetType: 'printer', snmpData: {} });
    const res = await get(ASSET_ID, SITE_ALLOWED);
    // Must be indistinguishable from the "asset outside the caller's org" 404
    // above — an out-of-ceiling asset is not an existence oracle (#5777).
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Asset not found');
    expect(suggestTemplate).not.toHaveBeenCalled();
  });

  it('400s on a non-uuid assetId', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(400);
  });
});
