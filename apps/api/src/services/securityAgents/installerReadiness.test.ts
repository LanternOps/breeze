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

  it('never reports account_key_missing (SentinelOne has no account-key analogue)', async () => {
    queueS1({ integrations: [{ id: INTEGRATION, partnerId: PARTNER, isActive: true }] });
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

describe('loadOrgInstallerReadiness (vendors not wired yet)', () => {
  it.each(['controld', 'nextdns'] as const)('%s fails closed without touching the DB', async (vendor) => {
    const result = await loadOrgInstallerReadiness(vendor, [ORG]);
    expect(result.get(ORG)).toEqual({ ok: false, reason: 'vendor_unavailable' });
    expect(selectCalls.length).toBe(0);
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
