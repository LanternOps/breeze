/**
 * Tests for getOrgAgentUpdatePolicy — the DB read that resolves the EFFECTIVE
 * "Agent update policy" (Org > General): partner defaults merged on top of
 * org-local `settings.defaults`, matching the settings UI (issue #2123).
 *
 * The pure gating logic lives in agentUpdatePolicy.ts (tested separately); this
 * file pins two seams the heartbeat tests mock away:
 *   1. The JSONB extraction + normalization: nested settings.defaults lookup,
 *      isObject guards at both levels, unknown-policy fallback to `staged`, and
 *      whitespace-trim-to-null of the maintenance window.
 *   2. The partner→org effective merge: a partner-set field wins and locks; the
 *      org value fills the gap only where the partner has not set that field —
 *      merged per field (issue #2123). This is the bug the issue reported: a
 *      partner-locked Manual policy previously had zero runtime effect.
 * Both are the seams most likely to silently break (a renamed key → permissive
 * default, or a dropped partner merge → partner lock ignored) on a schema change.
 *
 * helpers.ts has a large import graph, so the mock harness below mirrors
 * helpers.pam.test.ts: a single-call db.select queue plus stubs for everything
 * the module references at load time. The lookup is a single org⋈partner joined
 * SELECT, so each `_set(...)` seeds the one row that join returns.
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
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
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

// ---------------------------------------------------------------------------
// Import under test — AFTER all mocks are installed.
// ---------------------------------------------------------------------------
import {
  getOrgAgentUpdatePolicy,
  getOrgAgentUpdateConfig,
  resolvePinnedUpgradeTarget,
  __resetMalformedWindowWarnCache,
} from './helpers';

const ORG_ID = '00000000-0000-4000-8000-000000000001';

/** Seed the single org⋈partner join row. `partner` defaults to no partner row. */
function seed(orgSettings: unknown, partnerSettings: unknown = null): void {
  dbMock._setResult([{ orgSettings, partnerSettings }]);
}

/** Convenience: an org-local `settings.defaults` blob with no partner defaults. */
function orgDefaults(defaults: Record<string, unknown>): void {
  seed({ defaults }, null);
}

describe('getOrgAgentUpdatePolicy — org-local resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetMalformedWindowWarnCache();
  });

  it('reads a fully configured policy + maintenance window', async () => {
    orgDefaults({ agentUpdatePolicy: 'manual', maintenanceWindow: 'Sun 02:00-04:00' });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: 'Sun 02:00-04:00',
    });
  });

  it('trims a maintenance window and passes through auto/staged', async () => {
    orgDefaults({ agentUpdatePolicy: 'auto', maintenanceWindow: '  02:00-04:00  ' });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'auto', maintenanceWindow: '02:00-04:00',
    });
  });

  it('normalizes a whitespace-only window to null', async () => {
    orgDefaults({ agentUpdatePolicy: 'staged', maintenanceWindow: '   ' });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('normalizes the explicit "24/7" always-state to null (no restriction)', async () => {
    orgDefaults({ agentUpdatePolicy: 'auto', maintenanceWindow: '24/7' });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'auto', maintenanceWindow: null,
    });
  });

  it('normalizes "always"/"none" aliases to null', async () => {
    orgDefaults({ agentUpdatePolicy: 'staged', maintenanceWindow: ' Always ' });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('keeps a legacy malformed window but logs once per org that the restriction is lifted', async () => {
    // New writes are validated (issue #1963); a legacy malformed value still
    // fails open in the gate, but getOrgAgentUpdatePolicy must log it so the
    // silently-lifted restriction is observable. The read runs on the heartbeat
    // hot path, so the warn is deduped per org — two reads, one warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    orgDefaults({ agentUpdatePolicy: 'auto', maintenanceWindow: 'Sundays 2am' });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'auto', maintenanceWindow: 'Sundays 2am',
    });
    orgDefaults({ agentUpdatePolicy: 'auto', maintenanceWindow: 'Sundays 2am' });
    await getOrgAgentUpdatePolicy(ORG_ID); // second heartbeat read for the same org
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed maintenance window'));
    warn.mockRestore();
  });

  it('normalizes a non-string window to null', async () => {
    orgDefaults({ agentUpdatePolicy: 'manual', maintenanceWindow: 42 });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: null,
    });
  });

  it('falls back to the permissive default (staged + null) for an unknown policy', async () => {
    orgDefaults({ agentUpdatePolicy: 'bogus' });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('defaults when defaults sub-object is absent', async () => {
    seed({ somethingElse: true }, null);
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('defaults when settings is absent / non-object', async () => {
    seed(null, null);
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

describe('getOrgAgentUpdatePolicy — effective partner→org merge (issue #2123)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetMalformedWindowWarnCache();
  });

  it('applies the partner default when the org has no local value (the reported bug)', async () => {
    // Partner locks Manual; org never set a policy. Before #2123 this org fell
    // back to the permissive default (staged) and received auto-upgrades.
    seed({ defaults: {} }, { defaults: { agentUpdatePolicy: 'manual' } });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: null,
    });
  });

  it('applies the partner default when the org has no settings blob at all', async () => {
    seed(null, { defaults: { agentUpdatePolicy: 'manual', maintenanceWindow: 'Sun 02:00-04:00' } });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: 'Sun 02:00-04:00',
    });
  });

  it('partner-locked field wins over an org-local value', async () => {
    // Org wants auto; partner locks manual. The partner lock must win at runtime,
    // matching what the settings UI shows.
    seed(
      { defaults: { agentUpdatePolicy: 'auto', maintenanceWindow: '24/7' } },
      { defaults: { agentUpdatePolicy: 'manual' } },
    );
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: null,
    });
  });

  it('honors the org override where the partner has NOT locked that field', async () => {
    // Partner sets nothing; org sets manual. Org value applies (no partner lock).
    seed({ defaults: { agentUpdatePolicy: 'manual' } }, { defaults: {} });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: null,
    });
  });

  it('merges per field: partner locks the policy, org keeps its own window', async () => {
    // Partner locks the policy only; maintenanceWindow is left to the org. The
    // two fields resolve independently (mirrors effectiveSettings.mergeCategory).
    seed(
      { defaults: { agentUpdatePolicy: 'auto', maintenanceWindow: 'Sun 02:00-04:00' } },
      { defaults: { agentUpdatePolicy: 'staged' } },
    );
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: 'Sun 02:00-04:00',
    });
  });

  it('partner locks the window while the org keeps its own policy', async () => {
    seed(
      { defaults: { agentUpdatePolicy: 'manual' } },
      { defaults: { maintenanceWindow: 'Mon 01:00-03:00' } },
    );
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: 'Mon 01:00-03:00',
    });
  });

  it('permissive default when neither partner nor org configured either field', async () => {
    seed({ defaults: {} }, { defaults: {} });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'staged', maintenanceWindow: null,
    });
  });

  it('a partner with a non-object settings blob falls back to org-local values', async () => {
    seed({ defaults: { agentUpdatePolicy: 'manual' } }, 'not-an-object');
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).resolves.toEqual({
      policy: 'manual', maintenanceWindow: null,
    });
  });

  it('propagates a DB error so the heartbeat gate can fail closed (#2125)', async () => {
    // The lookup itself does not swallow errors — a thrown query rejects, and the
    // heartbeat handler's catch is what withholds version-to-version upgrades
    // (fail closed). This pins that getOrgAgentUpdatePolicy stays throw-through.
    dbMock.select.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(getOrgAgentUpdatePolicy(ORG_ID)).rejects.toThrow('db down');
  });
});

// ---------------------------------------------------------------------------
// getOrgAgentUpdateConfig — effective version pins (issue #2124). Same org⋈
// partner join and partner-locks precedence as the policy, resolved in ONE
// round trip. `agentVersionPins` is an atomic unit: a partner that sets it locks
// the whole object for the org; agent and watchdog stay independent knobs.
// ---------------------------------------------------------------------------
describe('getOrgAgentUpdateConfig — version pins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetMalformedWindowWarnCache();
  });

  it('no pin anywhere → both components track global latest (null)', async () => {
    seed({ defaults: {} }, null);
    const { pins } = await getOrgAgentUpdateConfig(ORG_ID);
    expect(pins).toEqual({ agent: null, watchdog: null });
  });

  it('org pin only → uses the org pin (no partner pin to inherit)', async () => {
    seed({ defaults: { agentVersionPins: { agent: '0.88.0' } } }, { defaults: {} });
    const { pins } = await getOrgAgentUpdateConfig(ORG_ID);
    expect(pins).toEqual({ agent: '0.88.0', watchdog: null });
  });

  it('partner pin only → org inherits the partner pin', async () => {
    seed({ defaults: {} }, { defaults: { agentVersionPins: { watchdog: '0.87.0' } } });
    const { pins } = await getOrgAgentUpdateConfig(ORG_ID);
    expect(pins).toEqual({ agent: null, watchdog: '0.87.0' });
  });

  it('org pin OVERRIDES the partner pin (inherit-with-override, not locks)', async () => {
    seed(
      { defaults: { agentVersionPins: { agent: '0.80.0', watchdog: '0.80.0' } } },
      { defaults: { agentVersionPins: { agent: '0.88.0' } } },
    );
    const { pins } = await getOrgAgentUpdateConfig(ORG_ID);
    // agent: org 0.80.0 overrides partner 0.88.0. watchdog: org 0.80.0 (partner
    // unset). The partner pin is a default, not a lock — the org wins.
    expect(pins).toEqual({ agent: '0.80.0', watchdog: '0.80.0' });
  });

  it('org inherits the partner pin per component where the org has not set it', async () => {
    seed(
      { defaults: { agentVersionPins: { watchdog: '0.70.0' } } },
      { defaults: { agentVersionPins: { agent: '0.88.0' } } },
    );
    const { pins } = await getOrgAgentUpdateConfig(ORG_ID);
    // agent: inherited partner 0.88.0 (org unset); watchdog: org 0.70.0. Agent
    // and watchdog resolve independently across the two levels.
    expect(pins).toEqual({ agent: '0.88.0', watchdog: '0.70.0' });
  });

  it("an org 'latest' deliberately overrides a partner pin back to global latest", async () => {
    seed(
      { defaults: { agentVersionPins: { agent: 'latest' } } },
      { defaults: { agentVersionPins: { agent: '0.88.0' } } },
    );
    const { pins } = await getOrgAgentUpdateConfig(ORG_ID);
    // Presence-keyed merge: the org SET agent ('latest'), so it wins and
    // normalizes to null (track global latest) despite the partner pin.
    expect(pins).toEqual({ agent: null, watchdog: null });
  });

  it("the 'latest' sentinel normalizes to null (no pin)", async () => {
    seed({ defaults: { agentVersionPins: { agent: 'latest', watchdog: '0.88.0' } } }, null);
    const { pins } = await getOrgAgentUpdateConfig(ORG_ID);
    expect(pins).toEqual({ agent: null, watchdog: '0.88.0' });
  });

  it('resolves settings and pins together from one lookup', async () => {
    seed(
      { defaults: { agentUpdatePolicy: 'manual', agentVersionPins: { agent: '0.88.0' } } },
      null,
    );
    const cfg = await getOrgAgentUpdateConfig(ORG_ID);
    expect(cfg.settings).toEqual({ policy: 'manual', maintenanceWindow: null });
    expect(cfg.pins).toEqual({ agent: '0.88.0', watchdog: null });
  });
});

// ---------------------------------------------------------------------------
// resolvePinnedUpgradeTarget — turns a pin (or its absence) into a concrete
// target version, fail-closed when a pinned build is missing for the device's
// platform/arch (issue #2124).
// ---------------------------------------------------------------------------
describe('resolvePinnedUpgradeTarget', () => {
  const base = { component: 'agent', platform: 'windows', architecture: 'amd64' as const };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the per-(component/platform/arch/version) capture dedup so the
    // fail-closed Sentry assertion isn't suppressed by a prior test.
    __resetMalformedWindowWarnCache();
  });

  it('no pin → returns the globally promoted latest version', async () => {
    dbMock._setResult([{ version: '0.88.0' }]);
    await expect(resolvePinnedUpgradeTarget({ ...base, pin: null })).resolves.toBe('0.88.0');
  });

  it('no pin and no promoted build → null (unchanged legacy behaviour)', async () => {
    dbMock._setResult([]);
    await expect(resolvePinnedUpgradeTarget({ ...base, pin: null })).resolves.toBeNull();
  });

  it('pin with a registered build for this platform/arch → returns the pinned version', async () => {
    dbMock._setResult([{ version: '0.85.0' }]);
    await expect(resolvePinnedUpgradeTarget({ ...base, pin: '0.85.0' })).resolves.toBe('0.85.0');
  });

  it('pin with NO build for this platform/arch → null (fail closed, no fallback to latest)', async () => {
    dbMock._setResult([]);
    await expect(
      resolvePinnedUpgradeTarget({ ...base, pin: '0.85.0', agentId: 'device-1' }),
    ).resolves.toBeNull();
  });

  it('routes the fail-closed pin-miss to Sentry (observability parity with the #2125 gate)', async () => {
    const { captureException } = await import('../../services/sentry');
    dbMock._setResult([]);
    await resolvePinnedUpgradeTarget({ ...base, pin: '0.85.0', agentId: 'device-1' });
    expect(vi.mocked(captureException)).toHaveBeenCalledTimes(1);

    // Deduped: a second identical miss must NOT re-capture (avoids per-heartbeat
    // Sentry spam for a persistent misconfig).
    dbMock._setResult([]);
    await resolvePinnedUpgradeTarget({ ...base, pin: '0.85.0', agentId: 'device-2' });
    expect(vi.mocked(captureException)).toHaveBeenCalledTimes(1);
  });
});
