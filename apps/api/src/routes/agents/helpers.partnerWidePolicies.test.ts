/**
 * Partner-wide (partner-owned) config-policy resolution for the agent-facing
 * resolvers — issue #2930.
 *
 * A `configuration_policies` row owned by a partner has `org_id NULL` and
 * `partner_id` set. Four resolvers in helpers.ts joined on
 * `eq(configurationPolicies.orgId, device.orgId)`, which can never match such a
 * row, so a partner-authored policy was authorable in the UI and silently never
 * delivered to any agent. The RLS half of the same bug is that partner-owned
 * rows are invisible under an org-scoped DB context, so a corrected predicate
 * still resolves nothing without a system-context escape.
 *
 * The mocked db returns rows unconditionally and cannot evaluate a WHERE
 * clause, so these tests pin the two decisions the resolver actually makes:
 *  - it passes the DEVICE ORG'S PARTNER into `policyOwnershipCondition` (so the
 *    emitted predicate admits `org_id NULL` rows — the SQL itself is pinned in
 *    services/configPolicyOwnership.test.ts), and
 *  - it runs the policy join in the CALLER'S OWN DB CONTEXT, with no escape.
 *
 * That second assertion INVERTED in #4673 W03. It used to require the opposite:
 * that the join ran inside `withPartnerWideVisibility`, a nested
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` that took a second
 * pooled connection (#1105) and bypassed RLS wholesale (#2417). W01 added the
 * SELECT-only `<table>_partner_wide_select` policies and W02 populates
 * `breeze.current_partner_id` on agent contexts, so the database now grants the
 * read and the escape is a liability rather than the fix.
 *
 * The gate is built to fail LOUDLY if anyone reintroduces it:
 *  - `runOutsideDbContext` / `withSystemDbAccessContext` are mocked to THROW,
 *    and each resolver additionally asserts they were never called; and
 *  - the `configPolicyOwnership` mock factory intentionally omits
 *    `withPartnerWideVisibility`, so re-importing it fails with
 *    "No withPartnerWideVisibility export is defined on the mock".
 *
 * End-to-end proof against real Postgres lives in
 * __tests__/integration/configurationPolicyPartnerResolution.integration.test.ts
 * and __tests__/integration/agentPolicyResolversPartnerWide.integration.test.ts
 * (the latter proves the RLS half: the same resolvers under a REAL org-scoped
 * context, with and without `currentPartnerId`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { dbMock, redisMock, getRedisImpl, ownershipMock, systemEscapeMock } = vi.hoisted(() => {
  let selectCallQueue: unknown[][] = [];
  let selectCallIdx = 0;

  const makeSelectChain = () => {
    const result = selectCallQueue[selectCallIdx] ?? [];
    selectCallIdx++;

    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _resetQueue(queue: unknown[][]) {
      selectCallQueue = queue;
      selectCallIdx = 0;
      dbMock.select.mockImplementation(() => makeSelectChain());
    },
  };

  const redisMock = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };

  return {
    dbMock,
    redisMock,
    getRedisImpl: vi.fn(() => redisMock as any),
    ownershipMock: vi.fn(() => 'OWNERSHIP_CONDITION' as any),
    // #4673 W03: any system-context escape on these paths is now a regression.
    // Throwing (rather than transparently delegating) means a reintroduced
    // escape fails the suite even in a test that forgets the explicit
    // `not.toHaveBeenCalled()` assertion below.
    systemEscapeMock: vi.fn(() => {
      throw new Error(
        'routes/agents/helpers.ts must not open a nested system DB context: ' +
          'partner-wide config rows are granted by the *_partner_wide_select ' +
          'RLS branch (#4673 W01/W02). See configPolicyOwnership.ts.',
      );
    }),
  };
});

vi.mock('../../db', () => ({
  runOutsideDbContext: systemEscapeMock,
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: systemEscapeMock,
  getCurrentDbAccessContext: vi.fn(() => undefined),
  db: dbMock,
}));

// `withPartnerWideVisibility` is deliberately ABSENT from this factory (#4673
// W03 deleted it). Re-importing it in helpers.ts fails loudly here rather than
// silently reintroducing the nested system context.
vi.mock('../../services/configPolicyOwnership', () => ({
  policyOwnershipCondition: ownershipMock,
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  organizations: { id: 'orgs.id', partnerId: 'orgs.partnerId' },
  deviceGroupMemberships: { groupId: 'dgm.groupId', deviceId: 'dgm.deviceId' },
  configPolicyAssignments: {
    level: 'cpa.level',
    targetId: 'cpa.targetId',
    configPolicyId: 'cpa.configPolicyId',
    priority: 'cpa.priority',
  },
  configurationPolicies: { id: 'cp.id', status: 'cp.status', orgId: 'cp.orgId', partnerId: 'cp.partnerId' },
  configPolicyFeatureLinks: {
    id: 'cpfl.id',
    configPolicyId: 'cpfl.configPolicyId',
    featureType: 'cpfl.featureType',
    inlineSettings: 'cpfl.inlineSettings',
  },
  configPolicyEventLogSettings: {
    featureLinkId: 'cpels.featureLinkId',
    retentionDays: 'cpels.retentionDays',
    maxEventsPerCycle: 'cpels.maxEventsPerCycle',
    collectCategories: 'cpels.collectCategories',
    minimumLevel: 'cpels.minimumLevel',
    collectionIntervalMinutes: 'cpels.collectionIntervalMinutes',
    rateLimitPerHour: 'cpels.rateLimitPerHour',
  },
  configPolicyMonitoringSettings: {
    id: 'cpms.id',
    featureLinkId: 'cpms.featureLinkId',
    checkIntervalSeconds: 'cpms.checkIntervalSeconds',
  },
  configPolicyMonitoringWatches: {
    settingsId: 'cpmw.settingsId',
    enabled: 'cpmw.enabled',
    sortOrder: 'cpmw.sortOrder',
  },
  configPolicyOnedriveSettings: {
    id: 'cpos.id',
    featureLinkId: 'cpos.featureLinkId',
    silentAccountConfig: 'cpos.silentAccountConfig',
    filesOnDemand: 'cpos.filesOnDemand',
    kfmSilentOptIn: 'cpos.kfmSilentOptIn',
    kfmFolders: 'cpos.kfmFolders',
    kfmBlockOptOut: 'cpos.kfmBlockOptOut',
    tenantAssociationId: 'cpos.tenantAssociationId',
    restartOnChange: 'cpos.restartOnChange',
  },
  configPolicyOnedriveLibraries: {
    settingsId: 'cpol.settingsId',
    enabled: 'cpol.enabled',
    sortOrder: 'cpol.sortOrder',
  },
  onedriveDeviceState: { deviceId: 'ods.deviceId' },
  pamOrgConfig: { orgId: 'poc.orgId', uacInterceptionEnabled: 'poc.uacInterceptionEnabled' },
  partners: {},
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
  agentVersions: {},
}));

vi.mock('../../services/redis', () => ({ getRedis: getRedisImpl }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../../services/cisHardening', () => ({ parseCisCollectorOutput: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));
vi.mock('../../services/featureConfigResolver', () => ({ resolvePatchConfigForDevice: vi.fn() }));
vi.mock('../../services/onedriveGraph', () => ({ resolveUserGroupMembershipCached: vi.fn() }));
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
vi.mock('../../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('./policyProbeSafety', () => ({ isAllowedPolicyConfigProbe: vi.fn(() => true) }));

// ---------------------------------------------------------------------------
import {
  buildEventLogConfigUpdate,
  buildMonitoringConfigUpdate,
  buildPamConfigUpdate,
  buildHelperConfigUpdate,
  buildOnedriveHelperConfigUpdate,
} from './helpers';
import { ORG_SCOPED_ONLY_FEATURE_TYPES } from '@breeze/shared';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const SITE_ID = '00000000-0000-4000-8000-000000000003';
const PARTNER_ID = '00000000-0000-4000-8000-000000000004';

const deviceRow = [{ orgId: ORG_ID, siteId: SITE_ID }];
const orgWithPartner = [{ partnerId: PARTNER_ID }];
const orgWithoutPartner = [{ partnerId: null }];

/** A watch row shaped like config_policy_monitoring_watches. */
const watchRow = {
  watchType: 'service' as const,
  name: 'Spooler',
  alertOnStop: true,
  alertAfterConsecutiveFailures: 2,
  autoRestart: false,
  maxRestartAttempts: 3,
  restartCooldownSeconds: 60,
  cpuThresholdPercent: null,
  memoryThresholdMb: null,
  thresholdDurationSeconds: null,
};

const eventLogPolicyRow = (level: string) => ({
  level,
  assignmentPriority: 1,
  retentionDays: 45,
  maxEventsPerCycle: 250,
  collectCategories: ['security'],
  minimumLevel: 'warning',
  collectionIntervalMinutes: 30,
  rateLimitPerHour: 9000,
});

beforeEach(() => {
  vi.clearAllMocks();
  getRedisImpl.mockReturnValue(null); // no cache — always resolve from "DB"
  ownershipMock.mockReturnValue('OWNERSHIP_CONDITION' as any);
});

/**
 * Every agent-facing resolver must (a) hand the device org's partner to the
 * ownership predicate and (b) take the partner-wide RLS escape. Table-driven so
 * a newly added resolver that forgets either half is a one-line addition here.
 */
describe.each([
  {
    feature: 'event_log',
    run: () => buildEventLogConfigUpdate(DEVICE_ID),
    queue: (org: unknown[]) => [deviceRow, org, [], [eventLogPolicyRow('partner')]],
  },
  {
    feature: 'monitoring',
    run: () => buildMonitoringConfigUpdate(DEVICE_ID),
    queue: (org: unknown[]) => [
      deviceRow,
      org,
      [],
      [{ level: 'partner', assignmentPriority: 1, settingsId: 'set-1', checkIntervalSeconds: 90 }],
      [watchRow],
    ],
  },
  {
    feature: 'pam',
    run: () => buildPamConfigUpdate(DEVICE_ID),
    queue: (org: unknown[]) => [
      deviceRow,
      org,
      [],
      [{ level: 'partner', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } }],
    ],
  },
  {
    feature: 'helper',
    run: () => buildHelperConfigUpdate(DEVICE_ID, ORG_ID),
    queue: (org: unknown[]) => [
      deviceRow,
      org,
      [],
      [{ level: 'partner', assignmentPriority: 1, inlineSettings: { enabled: true } }],
    ],
  },
])('$feature resolver — partner-wide ownership (#2930)', ({ run, queue }) => {
  it('passes the device org\'s partnerId into the ownership predicate', async () => {
    dbMock._resetQueue(queue(orgWithPartner));

    await run();

    expect(ownershipMock).toHaveBeenCalledWith({ orgId: ORG_ID, partnerId: PARTNER_ID });
  });

  it('runs the policy join in the caller\'s own DB context — no system escape (#4673 W03)', async () => {
    dbMock._resetQueue(queue(orgWithPartner));

    // Completing at all is half the assertion: the db mock throws from
    // runOutsideDbContext / withSystemDbAccessContext, so a reintroduced escape
    // rejects here rather than reporting a passing resolve.
    await run();

    expect(systemEscapeMock).not.toHaveBeenCalled();
  });

  it('passes partnerId null when the device org has no partner', async () => {
    dbMock._resetQueue(queue(orgWithoutPartner));

    await run();

    expect(ownershipMock).toHaveBeenCalledWith({ orgId: ORG_ID, partnerId: null });
  });
});

describe('onedrive_helper stays org-only — do not "fix" it like the others', () => {
  // onedrive_helper is the sole member of ORG_SCOPED_ONLY_FEATURE_TYPES: its
  // settings carry per-tenant M365 library mappings with no owning org on a
  // partner-wide policy, and featureLinks.ts 400s the link at write time. An
  // audit sweep for #2930 will land on this resolver and see an org-only
  // predicate that looks like the same bug — this test says it isn't.
  it('is still declared org-scoped-only in the shared constant', () => {
    expect(ORG_SCOPED_ONLY_FEATURE_TYPES.has('onedrive_helper')).toBe(true);
  });

  it('does not use the dual-axis ownership predicate or the partner-wide escape', async () => {
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [{
        level: 'organization',
        assignmentPriority: 1,
        settingsId: 'set-1',
        silentAccountConfig: true,
        filesOnDemand: true,
        kfmSilentOptIn: false,
        kfmFolders: [],
        kfmBlockOptOut: false,
        tenantAssociationId: null,
        restartOnChange: false,
      }],
      [], // no libraries
    ]);

    await buildOnedriveHelperConfigUpdate(DEVICE_ID);

    expect(ownershipMock).not.toHaveBeenCalled();
    expect(systemEscapeMock).not.toHaveBeenCalled();
  });
});

describe('partner-owned policies actually reach the agent payload', () => {
  it('event_log: a partner-level assignment supplies the delivered settings', async () => {
    dbMock._resetQueue([deviceRow, orgWithPartner, [], [eventLogPolicyRow('partner')]]);

    const settings = await buildEventLogConfigUpdate(DEVICE_ID);

    expect(settings.collection_interval_minutes).toBe(30);
    expect(settings.max_events_per_cycle).toBe(250);
    expect(settings.minimum_level).toBe('warning');
  });

  it('event_log: an org-level policy still outranks a partner-level one', async () => {
    // Partner-wide policies must widen coverage, not override a customer's own
    // closer assignment — partner is the LOWEST level in the hierarchy.
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [
        eventLogPolicyRow('partner'),
        { ...eventLogPolicyRow('organization'), collectionIntervalMinutes: 5, maxEventsPerCycle: 10 },
      ],
    ]);

    const settings = await buildEventLogConfigUpdate(DEVICE_ID);

    expect(settings.collection_interval_minutes).toBe(5);
    expect(settings.max_events_per_cycle).toBe(10);
  });

  it('pam: a partner-level policy enables UAC interception without any org row', async () => {
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [{ level: 'partner', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } }],
      [], // pam_org_config — must not be consulted, the policy resolved
    ]);

    const result = await buildPamConfigUpdate(DEVICE_ID);

    expect(result.uacInterceptionEnabled).toBe(true);
  });

  it('monitoring: a partner-level policy delivers its watches', async () => {
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [{ level: 'partner', assignmentPriority: 1, settingsId: 'set-1', checkIntervalSeconds: 90 }],
      [watchRow],
    ]);

    const result = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(result?.check_interval_seconds).toBe(90);
    expect(result?.watches).toHaveLength(1);
    expect(result?.watches[0]?.name).toBe('Spooler');
  });

  it('monitoring: the watches read shares the policy join\'s escape, not a second one', async () => {
    // The watches table's RLS walks settings_id → feature link →
    // configuration_policies, so reading it outside the escape would find the
    // partner-owned policy and then resolve zero watches (returning null).
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [{ level: 'partner', assignmentPriority: 1, settingsId: 'set-1', checkIntervalSeconds: 90 }],
      [watchRow],
    ]);

    await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(systemEscapeMock).not.toHaveBeenCalled();
  });
});

describe('monitoring: a matched policy with zero enabled watches (#2949)', () => {
  // A winning policy row with no enabled watches ("clear all watches") is a
  // different fact than "no policy matched at all" — collapsing both to `null`
  // means heartbeat.ts omits monitoring_settings from the payload entirely, and
  // the agent (which handles an empty watches array fine — see
  // agent/internal/monitoring/monitor.go ApplyConfig) never learns to clear out
  // watches it was told about on a previous heartbeat.
  it('returns an object with an empty watches array, not null', async () => {
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [{ level: 'organization', assignmentPriority: 1, settingsId: 'set-1', checkIntervalSeconds: 90 }],
      [], // no enabled watches for the winning settings row
    ]);

    const result = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(result).not.toBeNull();
    expect(result?.check_interval_seconds).toBe(90);
    expect(result?.watches).toEqual([]);
  });

  it('still returns null when no policy row matches at all', async () => {
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [], // no assignment/policy rows matched
    ]);

    const result = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(result).toBeNull();
  });

  it('caches the empty-watches result via redis.set, same as any other match', async () => {
    // `buildMonitoringConfigUpdate` only skips caching on a null resolution
    // ("quick policy activation"); an empty-watches object is a real match and
    // must be cached like any other, or a rapid heartbeat retry would re-run
    // the resolver queries needlessly.
    getRedisImpl.mockReturnValue(redisMock);
    dbMock._resetQueue([
      deviceRow,
      orgWithPartner,
      [],
      [{ level: 'organization', assignmentPriority: 1, settingsId: 'set-1', checkIntervalSeconds: 90 }],
      [], // no enabled watches for the winning settings row
    ]);

    const result = await buildMonitoringConfigUpdate(DEVICE_ID);

    expect(result?.watches).toEqual([]);
    expect(redisMock.set).toHaveBeenCalledWith(
      `monitoring:settings:device:${DEVICE_ID}`,
      JSON.stringify({ check_interval_seconds: 90, watches: [] }),
      'EX',
      120,
    );
  });
});
