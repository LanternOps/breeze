/**
 * buildWakeOnLanConfigUpdate (#10838 W02): maps the resolver's answer onto the
 * heartbeat block, and deliberately does NOT swallow a resolver error - the
 * heartbeat omits the block on a throw so a transient failure never tells the
 * agent to stop collecting. Harness mirrors helpers.agentUpdatePolicy.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() must run before any import.
// ---------------------------------------------------------------------------
const { dbMock } = vi.hoisted(() => {
  let nextResult: unknown[] = [];
  const chains: any[] = [];

  const makeSelectChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(nextResult)),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(nextResult).then(resolve, reject);
    chains.push(chain);
    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _setResult(rows: unknown[]) {
      nextResult = rows;
    },
    /** The `.where()` argument of the most recent select chain. */
    _lastWhereArg(): unknown {
      const chain = chains[chains.length - 1];
      return chain?.where.mock.calls[0]?.[0];
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
  // #8053 per-org cache (services/hotPathCache.ts); no ambient context here.
  hasDbAccessContext: () => false,
  runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },
  // W05 (#8144): cluster caches publish their invalidation after commit.
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { work(); },
  db: dbMock,
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'orgs.id', settings: 'orgs.settings', partnerId: 'orgs.partner_id' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
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
  configPolicyOnedriveSettings: {},
  configPolicyOnedriveLibraries: {},
  pamOrgConfig: {},
  agentVersions: {
    id: 'av.id',
    version: 'av.version',
    platform: 'av.platform',
    architecture: 'av.architecture',
    component: 'av.component',
    isLatest: 'av.is_latest',
    createdAt: 'av.created_at',
    edition: 'av.edition',
  },
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
// #7516 — the local-build servability check is its own unit
// (services/localBinaryBuild.test.ts); here it is a seam the resolvers consult.
const { isUpgradeTargetServableMock } = vi.hoisted(() => ({
  isUpgradeTargetServableMock: vi.fn(async (_args: { component: string; version: string }) => true),
}));
vi.mock('../../services/localBinaryBuild', () => ({
  isUpgradeTargetServable: isUpgradeTargetServableMock,
}));

const { resolveWakeMock } = vi.hoisted(() => ({ resolveWakeMock: vi.fn() }));
vi.mock('../../services/featureConfigResolver', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveWakeOnLanSettingsForDevice: resolveWakeMock,
}));

import { buildWakeOnLanConfigUpdate } from './helpers';

describe('buildWakeOnLanConfigUpdate', () => {
  beforeEach(() => resolveWakeMock.mockReset());

  it('returns enabled=false when no wake_on_lan link resolves', async () => {
    resolveWakeMock.mockResolvedValue(null);
    await expect(buildWakeOnLanConfigUpdate('dev-1')).resolves.toEqual({
      enabled: false, configureSettings: false, firmwareWrites: [],
    });
  });

  it('returns enabled=true (writes still off) when a link resolves', async () => {
    resolveWakeMock.mockResolvedValue({ configureSettings: false, buttonMode: 'always' });
    await expect(buildWakeOnLanConfigUpdate('dev-1')).resolves.toEqual({
      enabled: true, configureSettings: false, firmwareWrites: [],
    });
  });

  it('forwards the device id and policy-set opts to the resolver', async () => {
    resolveWakeMock.mockResolvedValue(null);
    const opts = { orgId: 'org-1' } as never;
    await buildWakeOnLanConfigUpdate('dev-1', opts);
    expect(resolveWakeMock).toHaveBeenCalledWith('dev-1', opts);
  });

  it('rejects when the resolver throws (does not swallow, so the heartbeat omits the block)', async () => {
    resolveWakeMock.mockRejectedValueOnce(new Error('lookup failed'));
    await expect(buildWakeOnLanConfigUpdate('dev-1')).rejects.toThrow('lookup failed');
  });
});
