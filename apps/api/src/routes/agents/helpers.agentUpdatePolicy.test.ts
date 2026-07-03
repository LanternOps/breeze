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
import { getOrgAgentUpdatePolicy, __resetMalformedWindowWarnCache } from './helpers';

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
