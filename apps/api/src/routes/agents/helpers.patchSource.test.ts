/**
 * Tests for buildPatchSourceConfigUpdate (#1872) — the heartbeat helper that
 * surfaces the sole-Windows-Update-source enforcement flag to the agent.
 *
 * resolvePatchConfigPolicyForDevice is mocked directly (its DB resolution is
 * covered by configPolicyPatching/featureConfigResolver tests), so this file
 * pins only the mapping the heartbeat relies on (#8053 W1a-1: the policy-only
 * variant, never the timezone-resolving details path):
 *   - no patch policy resolved (null) → { exclusiveWindowsUpdate: false }
 *     (the revert-on-unassign contract — a device that loses its patch policy
 *     must be told to revert, not left enforced)
 *   - resolved row → pass the column through verbatim
 *
 * The load-time module mocks mirror helpers.pam.test.ts so helpers.ts imports
 * cleanly without a real DB/Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolvePatchConfigPolicyForDeviceMock, resolvePatchConfigForDeviceMock } = vi.hoisted(() => ({
  resolvePatchConfigPolicyForDeviceMock: vi.fn(),
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
  resolvePatchConfigPolicyForDevice: resolvePatchConfigPolicyForDeviceMock,
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

import { buildPatchSourceConfigUpdate, sanitizeDate } from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';

describe('buildPatchSourceConfigUpdate (#1872)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exclusiveWindowsUpdate:false when the device has no patch policy (revert-on-unassign)', async () => {
    resolvePatchConfigPolicyForDeviceMock.mockResolvedValue(null);

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: false });
  });

  it('passes through exclusiveWindowsUpdate:true from a resolved patch settings row', async () => {
    resolvePatchConfigPolicyForDeviceMock.mockResolvedValue({ settings: { exclusiveWindowsUpdate: true } });

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: true });
  });

  it('passes through exclusiveWindowsUpdate:false from a resolved patch settings row', async () => {
    resolvePatchConfigPolicyForDeviceMock.mockResolvedValue({ settings: { exclusiveWindowsUpdate: false } });

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: false });
  });

  it('coerces a missing column on a resolved row to false (back-compat)', async () => {
    // A pre-migration row read back without the column must not push undefined.
    resolvePatchConfigPolicyForDeviceMock.mockResolvedValue({ settings: { rebootPolicy: 'if_required' } });

    const result = await buildPatchSourceConfigUpdate(DEVICE_ID);

    expect(result).toEqual({ exclusiveWindowsUpdate: false });
  });

  it('reads only the winning patch link, never the timezone-resolving details path (#8053)', async () => {
    resolvePatchConfigPolicyForDeviceMock.mockResolvedValue({ settings: { exclusiveWindowsUpdate: true } });

    await expect(buildPatchSourceConfigUpdate(DEVICE_ID)).resolves.toEqual({ exclusiveWindowsUpdate: true });

    expect(resolvePatchConfigPolicyForDeviceMock).toHaveBeenCalledWith(DEVICE_ID, undefined);
    expect(resolvePatchConfigForDeviceMock).not.toHaveBeenCalled();
  });
});

describe('sanitizeDate', () => {
  it('round-trips a valid date', () => {
    expect(sanitizeDate('2026-01-05')).toBe('2026-01-05');
  });

  it('rejects an impossible calendar date instead of letting it roll over (regression)', () => {
    // `new Date('2026-02-31')` silently rolls over to 2026-03-03; the old code
    // returned the original string, which then hit Postgres 22008 and aborted
    // the whole ingest transaction.
    expect(sanitizeDate('2026-02-31')).toBeNull();
  });

  it('rejects a month 13 date', () => {
    expect(sanitizeDate('2026-13-01')).toBeNull();
  });

  it('rejects Feb 29 in a non-leap year', () => {
    expect(sanitizeDate('2025-02-29')).toBeNull();
  });

  it('rejects non-matching shapes', () => {
    expect(sanitizeDate('01/05/2026')).toBeNull();
    expect(sanitizeDate('')).toBeNull();
    expect(sanitizeDate(12345)).toBeNull();
    expect(sanitizeDate(null)).toBeNull();
    expect(sanitizeDate(undefined)).toBeNull();
    expect(sanitizeDate('2026-1-5')).toBeNull();
  });
});
