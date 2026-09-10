import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListReliabilityDevices = vi.fn();
const mockListUserRiskScores = vi.fn();
const mockGetUserRiskDetail = vi.fn();
const mockAssignSecurityTraining = vi.fn();
const mockGetUserRiskOrgMembership = vi.fn();

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
  // vitest validates named imports with `in` before calling get — without a
  // has trap, any schema export not listed above fails the whole suite load.
  has() {
    return true;
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
  assignSecurityTraining: (...args: unknown[]) => mockAssignSecurityTraining(...args),
  getUserRiskDetail: (...args: unknown[]) => mockGetUserRiskDetail(...args),
  getUserRiskOrgMembership: (...args: unknown[]) => mockGetUserRiskOrgMembership(...args),
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

describe('aiTools get_user_risk_detail site scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserRiskDetail.mockResolvedValue(null);
  });

  it('passes the authenticated site ceiling to the detail service', async () => {
    const auth = {
      user: { id: 'user-1' }, orgId: 'org-1', scope: 'organization',
      accessibleOrgIds: ['org-1'], allowedSiteIds: ['site-1'],
      canAccessOrg: (id: string) => id === 'org-1',
      canAccessSite: (id: string) => id === 'site-1', orgCondition: () => undefined,
    } as any;

    await executeTool('get_user_risk_detail', { userId: 'target-1' }, auth);

    expect(mockGetUserRiskDetail).toHaveBeenCalledWith('org-1', 'target-1', ['site-1']);
  });
});

describe('aiTools assign_security_training authorization', () => {
  const siteRestrictedAuth = {
    user: { id: 'user-1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    allowedSiteIds: ['site-1'],
    canAccessOrg: () => true,
    canAccessSite: (siteId: string | null | undefined) => siteId === 'site-1',
    orgCondition: () => undefined,
    token: { mfa: true },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserRiskOrgMembership.mockResolvedValue(true);
    mockAssignSecurityTraining.mockResolvedValue({
      assignmentEventId: 'assign-1',
      moduleId: 'security-awareness-baseline',
      deduplicated: false,
      eventPublished: true,
    });
  });

  it('denies a caller whose session has not satisfied MFA, before any write', async () => {
    const result = await executeTool(
      'assign_security_training',
      { userId: 'target-1' },
      { ...siteRestrictedAuth, token: { mfa: false } },
    );

    expect(JSON.parse(result)).toEqual({ error: 'MFA required' });
    expect(mockGetUserRiskOrgMembership).not.toHaveBeenCalled();
    expect(mockAssignSecurityTraining).not.toHaveBeenCalled();
  });

  it('denies a target outside the authenticated site ceiling, before any write', async () => {
    mockGetUserRiskOrgMembership.mockResolvedValue(false);

    const result = await executeTool('assign_security_training', { userId: 'target-1' }, siteRestrictedAuth);

    expect(JSON.parse(result)).toEqual({ error: 'User not found in this organization' });
    expect(mockGetUserRiskOrgMembership).toHaveBeenCalledWith('target-1', 'org-1', ['site-1']);
    expect(mockAssignSecurityTraining).not.toHaveBeenCalled();
  });

  it('carries the site ceiling into the membership check for a visible target', async () => {
    const result = await executeTool('assign_security_training', { userId: 'target-1' }, siteRestrictedAuth);

    expect(JSON.parse(result)).toMatchObject({ success: true, assignmentEventId: 'assign-1' });
    expect(mockGetUserRiskOrgMembership).toHaveBeenCalledWith('target-1', 'org-1', ['site-1']);
    expect(mockAssignSecurityTraining).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      userId: 'target-1',
    }));
  });
});
