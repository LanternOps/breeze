/**
 * Tests for getOrgAgentUpdatePolicy — the DB read that resolves the org-level
 * "Agent update policy" (Org > General) from organizations.settings.defaults.
 *
 * The pure gating logic lives in agentUpdatePolicy.ts (tested separately); this
 * file pins the JSONB extraction + normalization seam that the heartbeat tests
 * mock away: nested settings.defaults lookup, isObject guards at both levels,
 * unknown-policy fallback to `staged`, and whitespace-trim-to-null of the
 * maintenance window. That seam is the one most likely to silently break (a
 * renamed key → permissive default) on a settings-schema change.
 *
 * helpers.ts has a large import graph, so the mock harness below mirrors
 * helpers.pam.test.ts: a single-call db.select queue plus stubs for everything
 * the module references at load time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() must run before any import.
// ---------------------------------------------------------------------------
const { dbMock } = vi.hoisted(() => {
  let nextResult: unknown[] = [];

  const makeSelectChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(nextResult)),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(nextResult).then(resolve, reject);
    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _setResult(rows: unknown[]) {
      nextResult = rows;
    },
  };

  return { dbMock };
});

// ---------------------------------------------------------------------------
// Module mocks (must come before any import of the module under test)
// ---------------------------------------------------------------------------
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'orgs.id', settings: 'orgs.settings' },
  // Stub out everything else helpers.ts references so the module loads.
  devices: {},
  deviceGroupMemberships: {},
  configPolicyAssignments: {},
  configurationPolicies: {},
  configPolicyFeatureLinks: {},
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

vi.mock('../../services/redis', () => ({ getRedis: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../../services/cisHardening', () => ({ parseCisCollectorOutput: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));
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

// ---------------------------------------------------------------------------
// Import under test — AFTER all mocks are installed.
// ---------------------------------------------------------------------------
import { getOrgAgentUpdatePolicy } from './helpers';

const ORG_ID = '00000000-0000-4000-8000-000000000001';

describe('getOrgAgentUpdatePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads a fully configured policy + maintenance window', async () => {
    dbMock._setResult([{ settings: { defaults: { agentUpdatePolicy: 'manual', maintenanceWindow: 'Sun 02:00-04:00' } } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: 'Sun 02:00-04:00',
    });
  });

  it('trims a maintenance window and passes through auto/staged', async () => {
    dbMock._setResult([{ settings: { defaults: { agentUpdatePolicy: 'auto', maintenanceWindow: '  02:00-04:00  ' } } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'auto', maintenanceWindow: '02:00-04:00',
    });
  });

  it('normalizes a whitespace-only window to null', async () => {
    dbMock._setResult([{ settings: { defaults: { agentUpdatePolicy: 'staged', maintenanceWindow: '   ' } } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('normalizes the explicit "24/7" always-state to null (no restriction)', async () => {
    dbMock._setResult([{ settings: { defaults: { agentUpdatePolicy: 'auto', maintenanceWindow: '24/7' } } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'auto', maintenanceWindow: null,
    });
  });

  it('normalizes "always"/"none" aliases to null', async () => {
    dbMock._setResult([{ settings: { defaults: { agentUpdatePolicy: 'staged', maintenanceWindow: ' Always ' } } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('normalizes a non-string window to null', async () => {
    dbMock._setResult([{ settings: { defaults: { agentUpdatePolicy: 'manual', maintenanceWindow: 42 } } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: null,
    });
  });

  it('falls back to the permissive default (staged + null) for an unknown policy', async () => {
    dbMock._setResult([{ settings: { defaults: { agentUpdatePolicy: 'bogus' } } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('defaults when defaults sub-object is absent', async () => {
    dbMock._setResult([{ settings: { somethingElse: true } }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('defaults when settings is absent / non-object', async () => {
    dbMock._setResult([{ settings: null }]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('defaults when the org row is missing entirely', async () => {
    dbMock._setResult([]);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });
});
