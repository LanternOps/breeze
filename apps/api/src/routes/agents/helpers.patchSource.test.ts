/**
 * Tests for buildPatchSourceConfigUpdate (#1872) — the heartbeat helper that
 * surfaces the sole-Windows-Update-source enforcement flag to the agent.
 *
 * resolvePatchConfigForDevice is mocked directly (its DB resolution is covered
 * by configPolicyPatching/featureConfigResolver tests), so this file pins only
 * the mapping the heartbeat relies on:
 *   - no patch policy resolved (null) → { exclusiveWindowsUpdate: false }
 *     (the revert-on-unassign contract — a device that loses its patch policy
 *     must be told to revert, not left enforced)
 *   - resolved row → pass the column through verbatim
 *
 * The load-time module mocks mirror helpers.pam.test.ts so helpers.ts imports
 * cleanly without a real DB/Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolvePatchConfigForDeviceMock } = vi.hoisted(() => ({
  resolvePatchConfigForDeviceMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  devices: {},
  organizations: {},
  deviceGroupMemberships: {},
  configPolicyAssignments: {},
  configurationPolicies: {},
  configPolicyFeatureLinks: {},
  pamOrgConfig: {},
  softwarePolicies: {},
  softwareComplianceStatus: {},
  deviceCommands: { $inferSelect: {} },
  deviceDisks: {},
  deviceFilesystemSnapshots: {},
  automationPolicies: {},
  cisBaselines: {},
  cisBaselineResults: {},
  cisRemediationActions: {},
  securityStatus: {},
  securityThreats: {},
  securityScans: {},
  sensitiveDataFindings: {},
  sensitiveDataScans: {},
  sites: {},
  users: {},
  deviceGroups: {},
  configPolicyMonitoringSettings: {},
  configPolicyMonitoringWatches: {},
  configPolicyEventLogSettings: {},
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../../services/cisHardening', () => ({ parseCisCollectorOutput: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));
vi.mock('../../services/featureConfigResolver', () => ({
  resolvePatchConfigForDevice: resolvePatchConfigForDeviceMock,
}));
vi.mock('../../services/filesystemAnalysis', () => ({
  getFilesystemScanState: vi.fn(),
  mergeFilesystemAnalysisPayload: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(),
  readHotDirectories: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  upsertFilesystemScanState: vi.fn(),
}));
vi.mock('../metrics', () => ({
  recordSoftwareRemediationDecision: vi.fn(),
  recordSensitiveDataFinding: vi.fn(),
  recordSensitiveDataRemediationDecision: vi.fn(),
}));
vi.mock('../../jobs/softwareComplianceWorker', () => ({
  scheduleSoftwareComplianceCheck: vi.fn(),
}));
vi.mock('./policyProbeSafety', () => ({ isAllowedPolicyConfigProbe: vi.fn(() => true) }));

import { buildPatchSourceConfigUpdate } from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';

describe('buildPatchSourceConfigUpdate (#1872)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exclusiveWindowsUpdate:false when the device has no patch policy (revert-on-unassign)', async () => {
    resolvePatchConfigForDeviceMock.mockResolvedValue(null);

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: false });
  });

  it('passes through exclusiveWindowsUpdate:true from a resolved patch settings row', async () => {
    resolvePatchConfigForDeviceMock.mockResolvedValue({ exclusiveWindowsUpdate: true });

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: true });
  });

  it('passes through exclusiveWindowsUpdate:false from a resolved patch settings row', async () => {
    resolvePatchConfigForDeviceMock.mockResolvedValue({ exclusiveWindowsUpdate: false });

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: false });
  });

  it('coerces a missing column on a resolved row to false (back-compat)', async () => {
    // A pre-migration row read back without the column must not push undefined.
    resolvePatchConfigForDeviceMock.mockResolvedValue({ rebootPolicy: 'if_required' });

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: false });
  });
});
