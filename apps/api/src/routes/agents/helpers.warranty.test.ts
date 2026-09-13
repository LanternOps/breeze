/**
 * Tests for buildWarrantyConfigUpdate (#5511 W02) — the heartbeat helper that
 * surfaces device-side HP CMSL collection to the agent.
 *
 * resolveEffectiveWarrantyInlineSettings is mocked directly (its hierarchy
 * resolution is covered by warrantyPolicyResolution.test.ts), so this file pins
 * only the mapping the heartbeat relies on:
 *   - no warranty policy resolved (undefined) → { hpCmslEnabled: false }
 *     (the revoke-on-unassign contract)
 *   - resolved but not consented → false (never collect without an acceptance)
 *   - resolver THROWS → rethrow, so the heartbeat omits the block
 *
 * The load-time module mocks mirror helpers.patchSource.test.ts so helpers.ts
 * imports cleanly without a real DB/Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveEffectiveWarrantyInlineSettingsMock } = vi.hoisted(() => ({
  resolveEffectiveWarrantyInlineSettingsMock: vi.fn(),
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
vi.mock('../../services/warrantyPolicyResolution', () => ({
  resolveEffectiveWarrantyInlineSettings: resolveEffectiveWarrantyInlineSettingsMock,
}));
vi.mock('../../services/featureConfigResolver', () => ({
  resolvePatchConfigForDevice: vi.fn(),
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

import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';
import { buildWarrantyConfigUpdate } from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

describe('buildWarrantyConfigUpdate (#5511 W02)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns hpCmslEnabled:false when no warranty policy resolves (revoke-on-unassign)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue(undefined);
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns true for a link that is enabled and consented against the current EULA id', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({
      enabled: true, warnDays: 90, criticalDays: 30,
      hpCmsl: { enabled: true, consent: CONSENT },
    });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: true });
  });

  it('returns false for an alerting-only link (the inheritance drop, contract D5)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({ enabled: true, warnDays: 14 });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns false when the block is enabled but carries no acceptance', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({ hpCmsl: { enabled: true } });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns false when the acceptance names a superseded EULA id (contract D2)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({
      hpCmsl: { enabled: true, consent: { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } },
    });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns false for a resolved-but-null blob', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue(null);
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('RETHROWS a resolver error rather than reporting false (no unintended revocation)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockRejectedValue(new Error('boom'));
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).rejects.toThrow('boom');
  });
});
