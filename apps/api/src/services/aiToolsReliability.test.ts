import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListReliabilityDevices = vi.fn();

vi.mock('../db', () => ({
  db: {},
}));

vi.mock('../db/schema', () => ({
  devices: {},
  deviceHardware: {},
  deviceNetwork: {},
  deviceDisks: {},
  deviceMetrics: {},
  deviceBootMetrics: {},
  alerts: {},
  sites: {},
  organizations: {},
  auditLogs: {},
  deviceCommands: {},
  deviceFilesystemCleanupRuns: {},
  deviceSessions: {},
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

import { executeTool } from './aiTools';

describe('aiTools get_fleet_health org scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListReliabilityDevices.mockResolvedValue({ total: 0, rows: [] });
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
});
