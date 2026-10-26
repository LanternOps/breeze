import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select() call takes the next queued result set, in query order.
const queued: unknown[][] = [];
const selectCalls: number[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn(() => c);
  c.innerJoin = vi.fn(() => c);
  c.where = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(rows));
  c.then = (resolve: (value: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

vi.mock('../../db', () => ({
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => {
      selectCalls.push(1);
      return chain(queued.shift() ?? []);
    }),
  },
}));

const decryptForColumn = vi.fn();
vi.mock('../secretCrypto', () => ({ decryptForColumn: (...args: unknown[]) => decryptForColumn(...args) }));

type FakeVar = { value: string; isSecret: boolean };
// Per org: the variables the resolver would hand back (org override already
// applied over the partner default), and the keys whose winning row failed to
// decrypt. The real resolver's precedence and partner keying are exercised by
// tenantVariableResolution.test.ts and securityAgentCoverage.integration.test.ts.
const varsByOrg = new Map<string, Record<string, FakeVar>>();
const unreadableByOrg = new Map<string, string[]>();
const loadTenantVariableScope = vi.fn(async (orgIds: string[]) => ({ orgIds: new Set(orgIds) }));
vi.mock('../tenantVariableResolution', () => ({
  loadTenantVariableScope: (...args: unknown[]) => loadTenantVariableScope(...(args as [string[]])),
  resolveForOrg: (scope: { orgIds: Set<string> }, orgId: string) => {
    if (!scope.orgIds.has(orgId)) throw new Error(`Org ${orgId} is not in this snapshot`);
    return new Map(Object.entries(varsByOrg.get(orgId) ?? {}).map(([key, v]) => [key, { key, ...v, variableId: 'v', version: 1, ownerScope: 'organization' }]));
  },
  unreadableForOrg: (_scope: unknown, orgId: string) => new Set(unreadableByOrg.get(orgId) ?? []),
}));

const captureException = vi.fn();
vi.mock('../sentry', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

import { checkInstallerReadiness, evaluatePlatformReadiness, loadOrgInstallerReadiness } from './installerReadiness';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000a2';
const PARTNER = '00000000-0000-4000-8000-0000000000b1';
const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000c1';
const INTEGRATION = '00000000-0000-4000-8000-0000000000d1';
const DEVICE = '00000000-0000-4000-8000-0000000000e1';

function queueHuntress(opts: {
  orgs?: Array<{ id: string; partnerId: string | null }>;
  mappings?: Array<{ orgId: string; partnerId: string; integrationId: string; orgKey: string | null }>;
  integrations?: Array<{ id: string; partnerId: string; isActive: boolean; hasAccountKey: boolean }>;
}) {
  queued.push(opts.orgs ?? [{ id: ORG, partnerId: PARTNER }]);
  queued.push(opts.mappings ?? [{ orgId: ORG, partnerId: PARTNER, integrationId: INTEGRATION, orgKey: '<org-key>' }]);
  queued.push(opts.integrations ?? [{ id: INTEGRATION, partnerId: PARTNER, isActive: true, hasAccountKey: true }]);
}

function queueS1(opts: {
  orgs?: Array<{ id: string; partnerId: string | null }>;
  mappings?: Array<{ orgId: string; partnerId: string; integrationId: string; hasToken: boolean }>;
  integrations?: Array<{ id: string; partnerId: string; isActive: boolean }>;
}) {
  queued.push(opts.orgs ?? [{ id: ORG, partnerId: PARTNER }]);
  queued.push(opts.mappings ?? [{ orgId: ORG, partnerId: PARTNER, integrationId: INTEGRATION, hasToken: true }]);
  queued.push(opts.integrations ?? [{ id: INTEGRATION, partnerId: PARTNER, isActive: true }]);
}

beforeEach(() => {
  queued.length = 0;
  selectCalls.length = 0;
  decryptForColumn.mockReset();
  varsByOrg.clear();
  unreadableByOrg.clear();
  loadTenantVariableScope.mockClear();
  captureException.mockReset();
});

describe('evaluatePlatformReadiness', () => {
  it('Huntress on Windows is ready', () => {
    expect(evaluatePlatformReadiness('huntress', 'windows')).toEqual({ ok: true });
  });

  it('Huntress on macOS needs MDM approval (never attempted)', () => {
    expect(evaluatePlatformReadiness('huntress', 'macos')).toEqual({ ok: false, reason: 'requires_mdm_approval' });
  });

  it('Huntress on Linux is unsupported', () => {
    expect(evaluatePlatformReadiness('huntress', 'linux')).toEqual({ ok: false, reason: 'platform_unsupported' });
  });

  it('an unknown os type is unsupported, never assumed Windows', () => {
    expect(evaluatePlatformReadiness('huntress', 'solaris')).toEqual({ ok: false, reason: 'platform_unsupported' });
  });

  it('a platform the link did not select is not applicable', () => {
    expect(evaluatePlatformReadiness('huntress', 'windows', ['macos'])).toEqual({
      ok: false,
      reason: 'platform_not_selected',
    });
  });
});

describe('loadOrgInstallerReadiness (huntress)', () => {
  it('ready when the org is mapped with an org key and the partner integration is active with an account key', async () => {
    queueHuntress({});
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: true });
  });

  it('org_not_mapped when no mapping names the org', async () => {
    queueHuntress({ mappings: [] });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'org_not_mapped' });
  });

  it("org_not_mapped when the only mapping belongs to another partner's integration", async () => {
    queueHuntress({
      mappings: [{ orgId: ORG, partnerId: OTHER_PARTNER, integrationId: INTEGRATION, orgKey: '<org-key>' }],
      integrations: [{ id: INTEGRATION, partnerId: OTHER_PARTNER, isActive: true, hasAccountKey: true }],
    });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'org_not_mapped' });
  });

  it('integration_inactive when the integration is disconnected', async () => {
    queueHuntress({ integrations: [{ id: INTEGRATION, partnerId: PARTNER, isActive: false, hasAccountKey: true }] });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'integration_inactive' });
  });

  it('integration_inactive when the integration row is gone', async () => {
    queueHuntress({ integrations: [] });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'integration_inactive' });
  });

  it('org_key_missing when the mapping has not synced an org key', async () => {
    queueHuntress({ mappings: [{ orgId: ORG, partnerId: PARTNER, integrationId: INTEGRATION, orgKey: '  ' }] });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'org_key_missing' });
  });

  it('account_key_missing when the integration has no deployment account key', async () => {
    queueHuntress({ integrations: [{ id: INTEGRATION, partnerId: PARTNER, isActive: true, hasAccountKey: false }] });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'account_key_missing' });
  });

  it('two mappings for one org: not ready unless every one is ready (dispatch picks either)', async () => {
    queueHuntress({
      mappings: [
        { orgId: ORG, partnerId: PARTNER, integrationId: INTEGRATION, orgKey: '<org-key>' },
        { orgId: ORG, partnerId: PARTNER, integrationId: INTEGRATION, orgKey: null },
      ],
    });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'org_key_missing' });
  });

  it('batches: three queries for many orgs, one answer per org', async () => {
    queueHuntress({
      orgs: [{ id: ORG, partnerId: PARTNER }, { id: ORG_B, partnerId: PARTNER }],
      mappings: [{ orgId: ORG, partnerId: PARTNER, integrationId: INTEGRATION, orgKey: '<org-key>' }],
    });
    const result = await loadOrgInstallerReadiness('huntress', [ORG, ORG_B, ORG]);
    expect(result.get(ORG)).toEqual({ ok: true });
    expect(result.get(ORG_B)).toEqual({ ok: false, reason: 'org_not_mapped' });
    expect(selectCalls.length).toBe(3);
  });

  it('an org that no longer exists is not mapped', async () => {
    queueHuntress({ orgs: [] });
    const result = await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'org_not_mapped' });
  });

  it('never decrypts anything', async () => {
    queueHuntress({});
    await loadOrgInstallerReadiness('huntress', [ORG]);
    expect(decryptForColumn).not.toHaveBeenCalled();
  });
});

describe('loadOrgInstallerReadiness (sentinelone, #6960 W04)', () => {
  const S1_MAPPED = { orgId: ORG, partnerId: PARTNER, integrationId: INTEGRATION, hasToken: true };

  it.each<[string, Parameters<typeof queueS1>[0], { ok: true } | { ok: false; reason: string }]>([
    ['ready: mapped under its own partner, active integration, site token present', {}, { ok: true }],
    ['org_not_mapped: no site maps to the org', { mappings: [] }, { ok: false, reason: 'org_not_mapped' }],
    ["org_not_mapped: the only mapping is another partner's",
      { mappings: [{ ...S1_MAPPED, partnerId: OTHER_PARTNER }], integrations: [{ id: INTEGRATION, partnerId: OTHER_PARTNER, isActive: true }] },
      { ok: false, reason: 'org_not_mapped' }],
    ['org_not_mapped: the org no longer exists', { orgs: [] }, { ok: false, reason: 'org_not_mapped' }],
    ["org_not_mapped: a site is still mapped under ANOTHER partner (dispatch could pick its token)",
      { mappings: [S1_MAPPED, { ...S1_MAPPED, partnerId: OTHER_PARTNER }] }, { ok: false, reason: 'org_not_mapped' }],
    ['integration_inactive: disconnected', { integrations: [{ id: INTEGRATION, partnerId: PARTNER, isActive: false }] }, { ok: false, reason: 'integration_inactive' }],
    ['integration_inactive: integration row gone', { integrations: [] }, { ok: false, reason: 'integration_inactive' }],
    ["integration_inactive: integration belongs to another partner",
      { integrations: [{ id: INTEGRATION, partnerId: OTHER_PARTNER, isActive: true }] }, { ok: false, reason: 'integration_inactive' }],
    ['org_key_missing: the site has no registration token', { mappings: [{ ...S1_MAPPED, hasToken: false }] }, { ok: false, reason: 'org_key_missing' }],
    ['two sites map to the org: not ready unless every one would succeed (dispatch reads either)',
      { mappings: [S1_MAPPED, { ...S1_MAPPED, hasToken: false }] }, { ok: false, reason: 'org_key_missing' }],
  ])('%s', async (_name, opts, expected) => {
    queueS1(opts);
    const result = await loadOrgInstallerReadiness('sentinelone', [ORG]);
    expect(result.get(ORG)).toEqual(expected);
  });

  it('never reports account_key_missing (SentinelOne has no account-key analogue): an integration without one is still ready', async () => {
    queueS1({ integrations: [{ id: INTEGRATION, partnerId: PARTNER, isActive: true, hasAccountKey: false } as never] });
    const result = await loadOrgInstallerReadiness('sentinelone', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: true });
  });

  it('batches: three queries for many orgs, one answer per org, never decrypts', async () => {
    queueS1({ orgs: [{ id: ORG, partnerId: PARTNER }, { id: ORG_B, partnerId: PARTNER }] });
    const result = await loadOrgInstallerReadiness('sentinelone', [ORG, ORG_B, ORG]);
    expect(result.get(ORG)).toEqual({ ok: true });
    expect(result.get(ORG_B)).toEqual({ ok: false, reason: 'org_not_mapped' });
    expect(selectCalls.length).toBe(3);
    expect(decryptForColumn).not.toHaveBeenCalled();
  });

  it('checkInstallerReadiness: a macOS device is platform_unsupported without reading the integration', async () => {
    const result = await checkInstallerReadiness({ vendor: 'sentinelone', deviceId: DEVICE, orgId: ORG, platform: 'macos' });
    expect(result).toEqual({ ok: false, reason: 'platform_unsupported' });
    expect(selectCalls.length).toBe(0);
  });
});

describe('loadOrgInstallerReadiness (tenant-variable vendors, #6960 W05)', () => {
  const PROFILE = '<profile-id>';
  const CODE = '<provisioning-code>';

  it('NextDNS: an org whose nextdns_profile_id resolves to a value is ready', async () => {
    varsByOrg.set(ORG, { nextdns_profile_id: { value: PROFILE, isSecret: false } });
    const result = await loadOrgInstallerReadiness('nextdns', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: true });
  });

  it('Control D reads controld_provisioning_code, not another vendor\'s variable', async () => {
    varsByOrg.set(ORG, { nextdns_profile_id: { value: PROFILE, isSecret: false } });
    varsByOrg.set(ORG_B, { controld_provisioning_code: { value: CODE, isSecret: false } });
    const result = await loadOrgInstallerReadiness('controld', [ORG, ORG_B]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'var_missing' });
    expect(result.get(ORG_B)).toEqual({ ok: true });
  });

  it('var_missing when the variable is not set for the org (nor as its partner\'s default)', async () => {
    const result = await loadOrgInstallerReadiness('nextdns', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'var_missing' });
  });

  it('var_missing when the winning value is blank (an org override of "" shadows the partner default, and dispatch would substitute "")', async () => {
    varsByOrg.set(ORG, { nextdns_profile_id: { value: '   ', isSecret: false } });
    const result = await loadOrgInstallerReadiness('nextdns', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'var_missing' });
  });

  it('var_secret when the variable resolves but is marked secret (dispatch refuses to place a secret in a script)', async () => {
    varsByOrg.set(ORG, { nextdns_profile_id: { value: PROFILE, isSecret: true } });
    const result = await loadOrgInstallerReadiness('nextdns', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'var_secret' });
  });

  it('var_missing when the winning row exists but cannot be decrypted (it never resolves at dispatch)', async () => {
    unreadableByOrg.set(ORG, ['nextdns_profile_id']);
    const result = await loadOrgInstallerReadiness('nextdns', [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'var_missing' });
  });

  it('one snapshot for every org, one answer per org, each org judged on its own variables', async () => {
    varsByOrg.set(ORG, { nextdns_profile_id: { value: PROFILE, isSecret: false } });
    const ORG_C = '00000000-0000-4000-8000-0000000000a3';
    varsByOrg.set(ORG_C, { nextdns_profile_id: { value: PROFILE, isSecret: true } });
    const result = await loadOrgInstallerReadiness('nextdns', [ORG, ORG_B, ORG_C, ORG]);
    expect(loadTenantVariableScope).toHaveBeenCalledTimes(1);
    expect(loadTenantVariableScope.mock.calls[0]![0]).toEqual([ORG, ORG_B, ORG_C]);
    expect(result.get(ORG)).toEqual({ ok: true });
    expect(result.get(ORG_B)).toEqual({ ok: false, reason: 'var_missing' });
    expect(result.get(ORG_C)).toEqual({ ok: false, reason: 'var_secret' });
    expect(result.size).toBe(3);
    // The resolver escapes to its own system context; nothing here reads the
    // vendor integration tables.
    expect(selectCalls.length).toBe(0);
  });

  it('never returns, logs or reports a variable value', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    try {
      varsByOrg.set(ORG, { nextdns_profile_id: { value: PROFILE, isSecret: false } });
      varsByOrg.set(ORG_B, { nextdns_profile_id: { value: 'secret-<profile-id>', isSecret: true } });
      const result = await loadOrgInstallerReadiness('nextdns', [ORG, ORG_B]);
      const seen = JSON.stringify([
        Array.from(result.entries()),
        ...spies.map((spy) => spy.mock.calls),
        captureException.mock.calls,
      ]);
      expect(seen).not.toContain(PROFILE);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('a resolver failure propagates (the compliance pass fails loudly; nothing is assumed ready)', async () => {
    loadTenantVariableScope.mockRejectedValueOnce(new Error('db down'));
    await expect(loadOrgInstallerReadiness('nextdns', [ORG])).rejects.toThrow('db down');
  });

  it('checkInstallerReadiness: a macOS device is platform_unsupported without loading variables', async () => {
    const result = await checkInstallerReadiness({ vendor: 'controld', deviceId: DEVICE, orgId: ORG, platform: 'macos' });
    expect(result).toEqual({ ok: false, reason: 'platform_unsupported' });
    expect(loadTenantVariableScope).not.toHaveBeenCalled();
  });
});

describe('checkInstallerReadiness', () => {
  it('platform is checked first: a Linux device never reads the integration', async () => {
    const result = await checkInstallerReadiness({ vendor: 'huntress', deviceId: DEVICE, orgId: ORG, platform: 'linux' });
    expect(result).toEqual({ ok: false, reason: 'platform_unsupported' });
    expect(selectCalls.length).toBe(0);
  });

  it("evaluates the DEVICE's org", async () => {
    queueHuntress({ mappings: [] });
    const result = await checkInstallerReadiness({ vendor: 'huntress', deviceId: DEVICE, orgId: ORG, platform: 'windows' });
    expect(result).toEqual({ ok: false, reason: 'org_not_mapped' });
  });

  it('ready end to end', async () => {
    queueHuntress({});
    const result = await checkInstallerReadiness({ vendor: 'huntress', deviceId: DEVICE, orgId: ORG, platform: 'windows' });
    expect(result).toEqual({ ok: true });
    expect(decryptForColumn).not.toHaveBeenCalled();
  });
});
