/**
 * Drift guard for EVENT_LOG_DEFAULTS (#2390) — the API's fallback event-log
 * settings must stay identical to what the shared inline-settings schema
 * produces from an empty object. The 5m→15m collection-interval backoff had to
 * be changed in four sibling defaults (agent NewEventLogCollector, shared
 * eventLogInlineSettingsSchema, API EVENT_LOG_DEFAULTS, web EventLogTab);
 * this test pins the API↔schema pair so they can't silently diverge again —
 * eventlogs.test.ts mocks EVENT_LOG_DEFAULTS wholesale and would never notice.
 *
 * The load-time module mocks mirror helpers.patchSource.test.ts so helpers.ts
 * imports cleanly without a real DB/Redis.
 */
import { describe, expect, it, vi } from 'vitest';

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

import { EVENT_LOG_DEFAULTS } from './helpers';
import { eventLogInlineSettingsSchema } from '@breeze/shared/validators';

describe('EVENT_LOG_DEFAULTS', () => {
  it('matches eventLogInlineSettingsSchema defaults exactly', () => {
    expect(EVENT_LOG_DEFAULTS).toEqual(eventLogInlineSettingsSchema.parse({}));
  });

  it('carries the 15-minute collection interval (#2390 backoff)', () => {
    expect(EVENT_LOG_DEFAULTS.collectionIntervalMinutes).toBe(15);
  });
});
