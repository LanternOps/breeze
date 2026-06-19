import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListReliabilityDevices = vi.fn();
const mockListUserRiskScores = vi.fn();

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

vi.mock('../db/schema', () => new Proxy({
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  dnsActionEnum: { enumValues: ['allow', 'block', 'log'] },
  dnsThreatCategoryEnum: { enumValues: ['malware', 'phishing', 'botnet', 'cryptomining'] },
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'router', 'switch', 'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'] },
  peripheralEventTypeEnum: { enumValues: ['connected', 'disconnected', 'blocked', 'allowed'] },
  peripheralDeviceClassEnum: { enumValues: ['storage', 'all_usb', 'bluetooth', 'thunderbolt'] },
  peripheralPolicyActionEnum: { enumValues: ['allow', 'block', 'read_only', 'alert'] },
  peripheralPolicyTargetTypeEnum: { enumValues: ['organization', 'site', 'group', 'device'] },
}, {
  get(target, prop) {
    if (prop in target) return target[prop as keyof typeof target];
    // Return empty object for any un-mocked table/export
    return {};
  },
}));

vi.mock('./aiToolSchemas', () => ({
  validateToolInput: vi.fn(() => ({ success: true })),
}));

vi.mock('./aiToolsAgentLogs', () => ({
  registerAgentLogTools: vi.fn(),
}));

vi.mock('./aiToolsConfigPolicy', () => ({
  registerConfigPolicyTools: vi.fn(),
}));

vi.mock('./aiToolsFleet', () => ({
  registerFleetTools: vi.fn(),
}));

vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(),
  getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(),
  resolveDeviceContext: vi.fn(),
}));

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(),
  getLatestFilesystemSnapshot: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  safeCleanupCategories: [],
}));

vi.mock('./securityPosture', () => ({
  getLatestSecurityPostureForDevice: vi.fn(),
  listLatestSecurityPosture: vi.fn(),
}));

vi.mock('./reliabilityScoring', () => ({
  listReliabilityDevices: (...args: unknown[]) => mockListReliabilityDevices(...args),
}));

vi.mock('./userRiskScoring', () => ({
  assignSecurityTraining: vi.fn(),
  getUserRiskDetail: vi.fn(),
  listUserRiskScores: (...args: unknown[]) => mockListUserRiskScores(...args),
}));

import { executeTool } from './aiTools';

describe('aiTools get_fleet_health org scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListReliabilityDevices.mockResolvedValue({ total: 0, rows: [] });
    mockListUserRiskScores.mockResolvedValue({ total: 0, rows: [] });
  });

  it('returns org context error when accessibleOrgIds is empty', async () => {
    const auth = {
      user: { id: 'user-1' },
      orgId: null,
      scope: 'partner',
      accessibleOrgIds: [],
      canAccessOrg: () => false,
      orgCondition: () => undefined,
    } as any;

    const result = await executeTool('get_fleet_health', {}, auth);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Organization context required' });
    expect(mockListReliabilityDevices).not.toHaveBeenCalled();
  });

  it('passes accessible orgIds to reliability query when present', async () => {
    mockListReliabilityDevices.mockResolvedValue({
      total: 1,
      rows: [{ reliabilityScore: 44, trendDirection: 'degrading' }],
    });

    const auth = {
      user: { id: 'user-1' },
      orgId: null,
      scope: 'partner',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as any;

    const result = await executeTool('get_fleet_health', {}, auth);
    const parsed = JSON.parse(result);

    expect(mockListReliabilityDevices).toHaveBeenCalledWith(
      expect.objectContaining({
        orgIds: ['org-1'],
      }),
    );
    expect(parsed.total).toBe(1);
    expect(parsed.summary.averageScore).toBe(44);
  });

  it('narrows fleet health by allowed sites for site-restricted callers', async () => {
    const auth = {
      user: { id: 'user-1' },
      orgId: 'org-1',
      scope: 'organization',
      accessibleOrgIds: ['org-1'],
      allowedSiteIds: ['site-1', 'site-2'],
      canAccessOrg: () => true,
      canAccessSite: (siteId: string | null | undefined) => siteId === 'site-1' || siteId === 'site-2',
      orgCondition: () => undefined,
    } as any;

    const result = await executeTool('get_fleet_health', {}, auth);
    const parsed = JSON.parse(result);

    expect(mockListReliabilityDevices).toHaveBeenCalledWith(
      expect.objectContaining({
        orgIds: ['org-1'],
        siteIds: ['site-1', 'site-2'],
      }),
    );
    expect(parsed.total).toBe(0);
  });

  it('denies explicit fleet health site filters outside caller site access', async () => {
    const auth = {
      user: { id: 'user-1' },
      orgId: 'org-1',
      scope: 'organization',
      accessibleOrgIds: ['org-1'],
      allowedSiteIds: ['site-1'],
      canAccessOrg: () => true,
      canAccessSite: (siteId: string | null | undefined) => siteId === 'site-1',
      orgCondition: () => undefined,
    } as any;

    const result = await executeTool('get_fleet_health', { siteId: 'site-2' }, auth);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Access denied to this site' });
    expect(mockListReliabilityDevices).not.toHaveBeenCalled();
  });
});

describe('aiTools get_user_risk_scores site scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListReliabilityDevices.mockResolvedValue({ total: 0, rows: [] });
    mockListUserRiskScores.mockResolvedValue({ total: 0, rows: [] });
  });

  it('narrows user risk scores by allowed sites for site-restricted callers', async () => {
    const auth = {
      user: { id: 'user-1' },
      orgId: 'org-1',
      scope: 'organization',
      accessibleOrgIds: ['org-1'],
      allowedSiteIds: ['site-1', 'site-2'],
      canAccessOrg: () => true,
      canAccessSite: (siteId: string | null | undefined) => siteId === 'site-1' || siteId === 'site-2',
      orgCondition: () => undefined,
    } as any;

    const result = await executeTool('get_user_risk_scores', {}, auth);
    const parsed = JSON.parse(result);

    expect(mockListUserRiskScores).toHaveBeenCalledWith(
      expect.objectContaining({
        orgIds: ['org-1'],
        siteIds: ['site-1', 'site-2'],
      }),
    );
    expect(parsed.total).toBe(0);
  });

  it('denies explicit user risk site filters outside caller site access', async () => {
    const auth = {
      user: { id: 'user-1' },
      orgId: 'org-1',
      scope: 'organization',
      accessibleOrgIds: ['org-1'],
      allowedSiteIds: ['site-1'],
      canAccessOrg: () => true,
      canAccessSite: (siteId: string | null | undefined) => siteId === 'site-1',
      orgCondition: () => undefined,
    } as any;

    const result = await executeTool('get_user_risk_scores', { siteId: 'site-2' }, auth);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({ error: 'Access denied to this site' });
    expect(mockListUserRiskScores).not.toHaveBeenCalled();
  });
});
