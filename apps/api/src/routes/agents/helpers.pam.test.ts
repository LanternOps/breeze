/**
 * Tests for resolveDevicePamSettings (via buildPamConfigUpdate) and
 * buildPamConfigUpdate Redis cache behavior.
 *
 * resolveDevicePamSettings is not exported, so we exercise it through
 * buildPamConfigUpdate with Redis mocked to a miss (no cached value). The
 * function runs 4 db.select calls in sequence:
 *   1. device row (orgId, siteId)
 *   2. org row (partnerId)
 *   3. device group memberships
 *   4. join query (assignments → policies → feature links) — returns winner rows
 *
 * We drive the mock with a call-counter queue so each call returns a
 * different result set.
 *
 * NOTE: The SQL WHERE on query 4 filters by status='active' and orgId — those
 * conditions live inside Drizzle's `.where(and(...))`. We cannot assert them
 * through a mocked db because the mock returns rows unconditionally. The
 * closest-wins sorting and PAM_DEFAULTS fallback are fully testable here;
 * the WHERE-level org/status guards are exercised only by integration tests
 * that hit a real DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() must run before any import.
// ---------------------------------------------------------------------------

const { dbMock, redisMock, getRedisImpl } = vi.hoisted(() => {
  // Queue of return values for successive db.select calls within one test.
  // Each entry is the resolved value of that call's .limit() or the final
  // await for the chained query.
  let selectCallQueue: unknown[][] = [];
  let selectCallIdx = 0;

  const makeSelectChain = () => {
    const result = selectCallQueue[selectCallIdx] ?? [];
    selectCallIdx++;

    // Build a chainable mock that resolves to `result` at the terminal call.
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
      // For the 4th query (no .limit — it's the terminal .where that returns
      // rows directly when awaited). We make `where` thenable.
    };

    // Make the chain itself thenable so `await db.select()...from()...innerJoin()...where()` works
    chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);

    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    // Reset helper used in beforeEach
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

  const getRedisImpl = vi.fn(() => redisMock as any);

  return { dbMock, redisMock, getRedisImpl };
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
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  organizations: { id: 'orgs.id', partnerId: 'orgs.partnerId' },
  deviceGroupMemberships: { groupId: 'dgm.groupId', deviceId: 'dgm.deviceId' },
  configPolicyAssignments: {
    level: 'cpa.level',
    targetId: 'cpa.targetId',
    configPolicyId: 'cpa.configPolicyId',
    priority: 'cpa.priority',
  },
  configurationPolicies: {
    id: 'cp.id',
    status: 'cp.status',
    orgId: 'cp.orgId',
  },
  configPolicyFeatureLinks: {
    configPolicyId: 'cpfl.configPolicyId',
    featureType: 'cpfl.featureType',
    inlineSettings: 'cpfl.inlineSettings',
  },
  // Stub out everything else helpers.ts references so the module loads
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

vi.mock('../../services/redis', () => ({
  getRedis: getRedisImpl,
}));

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
import { buildPamConfigUpdate } from './helpers';
import { PAM_DEFAULTS } from './pamSettings';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const SITE_ID = '00000000-0000-4000-8000-000000000003';
const PARTNER_ID = '00000000-0000-4000-8000-000000000004';
const GROUP_ID = '00000000-0000-4000-8000-000000000005';

/** Queue the 4 db.select calls: [deviceRow[], orgRow[], groupRows[], policyRows[]] */
function setDbQueue(
  deviceRows: unknown[],
  orgRows: unknown[],
  groupRows: unknown[],
  policyRows: unknown[],
) {
  dbMock._resetQueue([deviceRows, orgRows, groupRows, policyRows]);
}

// ---------------------------------------------------------------------------
// Gap 1: resolveDevicePamSettings closest-wins table tests
// ---------------------------------------------------------------------------

describe('resolveDevicePamSettings (via buildPamConfigUpdate, cache miss)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: Redis returns no cached value (cache miss)
    getRedisImpl.mockReturnValue(redisMock);
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');
  });

  it('case 1: device-level disable beats org-level enable', async () => {
    // Org row has enabled:true, device row has enabled:false.
    // Device has level priority 5, org has 2 → device wins → uacInterceptionEnabled: false.
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [
        { level: 'organization', assignmentPriority: 10, inlineSettings: { uacInterceptionEnabled: true } },
        { level: 'device', assignmentPriority: 10, inlineSettings: { uacInterceptionEnabled: false } },
      ],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result.uacInterceptionEnabled).toBe(false);
  });

  it('case 2: device_group beats site; site beats org; org beats partner', async () => {
    // Four rows at decreasing level priorities; device_group (4) should win
    // over site (3), site over org (2), org over partner (1).
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [{ groupId: GROUP_ID }],
      [
        { level: 'partner', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } },
        { level: 'organization', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } },
        { level: 'site', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } },
        { level: 'device_group', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: false } },
      ],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    // device_group (priority 4) should win over site (3), org (2), partner (1)
    expect(result.uacInterceptionEnabled).toBe(false);
  });

  it('case 2b: site beats org when no device or device_group row', async () => {
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [], // no group memberships
      [
        { level: 'organization', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } },
        { level: 'site', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: false } },
      ],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result.uacInterceptionEnabled).toBe(false);
  });

  it('case 3: same level — assignment priority 5 beats priority 10 (lower number wins)', async () => {
    // Two org-level rows. Priority 5 should win over priority 10.
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [
        { level: 'organization', assignmentPriority: 10, inlineSettings: { uacInterceptionEnabled: true } },
        { level: 'organization', assignmentPriority: 5, inlineSettings: { uacInterceptionEnabled: false } },
      ],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result.uacInterceptionEnabled).toBe(false);
  });

  it('case 4: zero policy rows → returns PAM_DEFAULTS (uacInterceptionEnabled: true)', async () => {
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [], // no policy rows
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result).toEqual(PAM_DEFAULTS);
    expect(result.uacInterceptionEnabled).toBe(true);
  });

  it('case 5: device not found (first query returns []) → returns PAM_DEFAULTS', async () => {
    setDbQueue(
      [], // device not found
      [],
      [],
      [],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result).toEqual(PAM_DEFAULTS);
  });

  it('case 6: winner has malformed inlineSettings (uacInterceptionEnabled as string "false") → parses to default true', async () => {
    // parsePamSettings treats non-boolean as default → true
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [
        { level: 'device', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: 'false' } },
      ],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    // 'false' (string) is not a boolean, so parsePamSettings falls back to default (true)
    expect(result.uacInterceptionEnabled).toBe(true);
  });

  it('winner with null inlineSettings → returns PAM_DEFAULTS', async () => {
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [
        { level: 'device', assignmentPriority: 1, inlineSettings: null },
      ],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result).toEqual(PAM_DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Gap 2: buildPamConfigUpdate Redis cache behavior
// ---------------------------------------------------------------------------

describe('buildPamConfigUpdate — Redis cache behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisImpl.mockReturnValue(redisMock);
  });

  it('cache hit returns parsed value WITHOUT running resolver queries (db.select not called)', async () => {
    const cachedSettings = { uacInterceptionEnabled: false };
    redisMock.get.mockResolvedValue(JSON.stringify(cachedSettings));

    const result = await buildPamConfigUpdate(DEVICE_ID);

    expect(result).toEqual(cachedSettings);
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(redisMock.get).toHaveBeenCalledWith(`pam:settings:device:${DEVICE_ID}`);
  });

  it('cache miss → resolves from DB → redis.set called with correct key, value, and TTL', async () => {
    redisMock.get.mockResolvedValue(null);
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [{ level: 'device', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: false } }],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);

    expect(result.uacInterceptionEnabled).toBe(false);
    // DB should have been called
    expect(dbMock.select).toHaveBeenCalled();
    // Redis set should be called with the correct cache key, serialized value, EX, and 120s TTL
    expect(redisMock.set).toHaveBeenCalledWith(
      `pam:settings:device:${DEVICE_ID}`,
      JSON.stringify({ uacInterceptionEnabled: false }),
      'EX',
      120,
    );
  });

  it('redis.get throws → still resolves from DB (fail-open) and returns settings', async () => {
    redisMock.get.mockRejectedValue(new Error('Redis connection error'));
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [{ level: 'organization', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: true } }],
    );

    // Should not throw
    const result = await buildPamConfigUpdate(DEVICE_ID);

    // Falls through to DB resolution despite Redis error
    expect(result.uacInterceptionEnabled).toBe(true);
    expect(dbMock.select).toHaveBeenCalled();
  });

  it('redis.set throws → still returns resolved settings (cache-write failure is non-fatal)', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockRejectedValue(new Error('Redis write error'));
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result).toEqual(PAM_DEFAULTS);
  });

  it('getRedis() returns null (no Redis configured) → resolves from DB normally', async () => {
    getRedisImpl.mockReturnValue(null);
    setDbQueue(
      [{ orgId: ORG_ID, siteId: SITE_ID }],
      [{ partnerId: PARTNER_ID }],
      [],
      [{ level: 'site', assignmentPriority: 1, inlineSettings: { uacInterceptionEnabled: false } }],
    );

    const result = await buildPamConfigUpdate(DEVICE_ID);
    expect(result.uacInterceptionEnabled).toBe(false);
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});
