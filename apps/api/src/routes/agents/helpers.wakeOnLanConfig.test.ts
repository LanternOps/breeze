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

import { buildWakeOnLanConfigUpdate, wakeObserveVendors } from './helpers';
import { VENDOR_STAGES } from '../../services/vendorCanary';

// Fake partners only. The real canary partner is an env value and never appears in the repo.
const CANARY = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('buildWakeOnLanConfigUpdate', () => {
  beforeEach(() => {
    resolveWakeMock.mockReset();
    vi.unstubAllEnvs();
  });

  it('returns enabled=false when no wake_on_lan link resolves', async () => {
    resolveWakeMock.mockResolvedValue(null);
    await expect(buildWakeOnLanConfigUpdate('dev-1')).resolves.toEqual({
      enabled: false, configureSettings: false, firmwareWrites: [], observeVendors: [],
    });
  });

  it('returns enabled=true (writes still off) when a link resolves', async () => {
    resolveWakeMock.mockResolvedValue({ configureSettings: false, buttonMode: 'always' });
    await expect(buildWakeOnLanConfigUpdate('dev-1')).resolves.toEqual({
      enabled: true, configureSettings: false, firmwareWrites: [], observeVendors: [],
    });
  });

  // Observe-first amendment §1: the vendor list rides the existing block.
  it('observe_vendors is empty for a non-canary partner', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    resolveWakeMock.mockResolvedValue({ configureSettings: false, buttonMode: 'always' });
    const out = await buildWakeOnLanConfigUpdate('dev-1', undefined, OTHER);
    expect(out.observeVendors).toEqual([]);
    expect(out.firmwareWrites).toEqual([]);
  });

  it('observe_vendors lists hp, lenovo and surface when the canary partner\'s stage is observe', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    resolveWakeMock.mockResolvedValue({ configureSettings: false, buttonMode: 'always' });
    const out = await buildWakeOnLanConfigUpdate('dev-1', undefined, CANARY);
    expect(out.observeVendors).toEqual(['hp', 'lenovo', 'surface']);
    // Observe never turns writes on.
    expect(out.configureSettings).toBe(false);
    expect(out.firmwareWrites).toEqual([]);
  });

  it('a disabled vendor in BREEZE_VENDOR_CANARY_DISABLED is omitted', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    vi.stubEnv('BREEZE_VENDOR_CANARY_DISABLED', 'wake_on_lan:lenovo,oem_updates:hp');
    resolveWakeMock.mockResolvedValue({ configureSettings: false, buttonMode: 'always' });
    const out = await buildWakeOnLanConfigUpdate('dev-1', undefined, CANARY);
    expect(out.observeVendors).toEqual(['hp', 'surface']);
  });

  it('no wake_on_lan link: block says enabled false and observe_vendors is empty', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    resolveWakeMock.mockResolvedValue(null);
    await expect(buildWakeOnLanConfigUpdate('dev-1', undefined, CANARY)).resolves.toEqual({
      enabled: false, configureSettings: false, firmwareWrites: [], observeVendors: [],
    });
  });

  it('no partner (null or undefined) observes nothing, even with the env set', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    resolveWakeMock.mockResolvedValue({ configureSettings: false, buttonMode: 'always' });
    expect((await buildWakeOnLanConfigUpdate('dev-1', undefined, null)).observeVendors).toEqual([]);
    expect((await buildWakeOnLanConfigUpdate('dev-1')).observeVendors).toEqual([]);
  });

  // The hot-path budget: the stage is an env and code lookup, never a query.
  it('budget unchanged: the observe list issues no query', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    resolveWakeMock.mockResolvedValue({ configureSettings: false, buttonMode: 'always' });
    dbMock.select.mockClear();
    await buildWakeOnLanConfigUpdate('dev-1', undefined, CANARY);
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(wakeObserveVendors(CANARY)).toEqual(['hp', 'lenovo', 'surface']);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('lists only vendors the stage table names for wake_on_lan, in a stable order', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(wakeObserveVendors(CANARY)).toEqual(Object.keys(VENDOR_STAGES.wake_on_lan).sort());
    expect(wakeObserveVendors(CANARY)).not.toContain('dell');
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
