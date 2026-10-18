import { beforeEach, describe, expect, it, vi } from 'vitest';

const queued: unknown[][] = [];
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const rows = queued.shift() ?? [];
      const c: Record<string, unknown> = {};
      c.from = () => c;
      c.where = () => c;
      c.limit = () => Promise.resolve(rows);
      c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
      return c;
    }),
  },
}));

const orgReadiness = vi.fn();
vi.mock('./installerReadiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./installerReadiness')>();
  return { ...actual, loadOrgInstallerReadiness: (...args: unknown[]) => orgReadiness(...args) };
});

import { loadManagedRuleApplicability } from './managedRuleApplicability';
import type { SoftwarePolicyViolation } from '../../db/schema';

const HUNTRESS_CATALOG = 'cat-huntress';
const UNKNOWN_CATALOG = 'cat-unknown';

function missing(catalogId: string): SoftwarePolicyViolation {
  return { type: 'missing', rule: { name: 'Huntress Agent*', catalogId }, severity: 'high', detectedAt: '2026-01-01T00:00:00Z' };
}

const POLICY = {
  id: 'policy-1',
  managedByLinkId: 'link-1',
  rules: { software: [{ name: 'Huntress Agent*', catalogId: HUNTRESS_CATALOG }], allowUnknown: true },
};

function prime(opts: { catalog?: unknown[]; link?: unknown[] } = {}) {
  queued.push(opts.catalog ?? [{ id: HUNTRESS_CATALOG, integrationProvider: 'huntress' }]);
  queued.push(opts.link ?? [{ inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true }] } }]);
}

beforeEach(() => {
  queued.length = 0;
  orgReadiness.mockReset();
});

describe('loadManagedRuleApplicability', () => {
  it('keeps a ready (device, rule) and reads org readiness once per vendor for all device orgs', async () => {
    prime();
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: true }], ['org-2', { ok: true }]]));
    const a = await loadManagedRuleApplicability(POLICY, [
      { deviceId: 'd1', orgId: 'org-1', osType: 'windows' },
      { deviceId: 'd2', orgId: 'org-2', osType: 'windows' },
    ]);
    expect(orgReadiness).toHaveBeenCalledTimes(1);
    expect(orgReadiness).toHaveBeenCalledWith('huntress', ['org-1', 'org-2']);
    expect(a.filterViolations('d1', [missing(HUNTRESS_CATALOG)])).toEqual({ violations: [missing(HUNTRESS_CATALOG)], notApplicable: [] });
  });

  it("drops a rule the device's org is not ready for, with the reason", async () => {
    prime();
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: false, reason: 'org_not_mapped' }]]));
    const a = await loadManagedRuleApplicability(POLICY, [{ deviceId: 'd1', orgId: 'org-1', osType: 'windows' }]);
    expect(a.filterViolations('d1', [missing(HUNTRESS_CATALOG)])).toEqual({
      violations: [],
      notApplicable: [{ catalogId: HUNTRESS_CATALOG, vendor: 'huntress', reason: 'org_not_mapped' }],
    });
  });

  it('platform beats org: a macOS device is requires_mdm_approval even in a ready org', async () => {
    prime();
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: true }]]));
    const a = await loadManagedRuleApplicability(POLICY, [{ deviceId: 'd1', orgId: 'org-1', osType: 'macos' }]);
    expect(a.filterViolations('d1', [missing(HUNTRESS_CATALOG)]).notApplicable).toEqual([
      { catalogId: HUNTRESS_CATALOG, vendor: 'huntress', reason: 'requires_mdm_approval' },
    ]);
  });

  it("honours the link's per-vendor platform list", async () => {
    prime({ link: [{ inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true, platforms: ['macos'] }] } }] });
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: true }]]));
    const a = await loadManagedRuleApplicability(POLICY, [{ deviceId: 'd1', orgId: 'org-1', osType: 'windows' }]);
    expect(a.filterViolations('d1', [missing(HUNTRESS_CATALOG)]).notApplicable[0]?.reason).toBe('platform_not_selected');
  });

  it('fails closed on a rule whose catalog row is not a known vendor package', async () => {
    prime({ catalog: [{ id: UNKNOWN_CATALOG, integrationProvider: null }] });
    const a = await loadManagedRuleApplicability(
      { ...POLICY, rules: { software: [{ name: 'X', catalogId: UNKNOWN_CATALOG }], allowUnknown: true } },
      [{ deviceId: 'd1', orgId: 'org-1', osType: 'windows' }],
    );
    expect(a.filterViolations('d1', [missing(UNKNOWN_CATALOG)]).notApplicable[0]?.reason).toBe('vendor_unavailable');
  });

  it.each([
    ['missing', []],
    ['unparseable', [{ inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true, apiKey: 'x' }] } }]],
  ])('fails closed when the link is %s (its platform limits are unknown)', async (_name, link) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    prime({ link: link as unknown[] });
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: true }]]));
    const a = await loadManagedRuleApplicability(POLICY, [{ deviceId: 'd1', orgId: 'org-1', osType: 'windows' }]);
    expect(a.filterViolations('d1', [missing(HUNTRESS_CATALOG)]).notApplicable[0]?.reason).toBe('vendor_unavailable');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('leaves unauthorized violations and rules without catalogId alone', async () => {
    prime();
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: false, reason: 'org_not_mapped' }]]));
    const a = await loadManagedRuleApplicability(POLICY, [{ deviceId: 'd1', orgId: 'org-1', osType: 'windows' }]);
    const unauthorized: SoftwarePolicyViolation = { type: 'unauthorized', software: { name: 'x' }, severity: 'medium', detectedAt: '2026-01-01T00:00:00Z' };
    expect(a.filterViolations('d1', [unauthorized]).violations).toEqual([unauthorized]);
  });

  // #6960 W03: coverage persists per-(device, vendor) applicability whether or
  // not the device currently has a `missing` violation (an installed agent in
  // an unmapped org is still not_applicable, not "covered by accident").
  it('evaluateDevice reports every known-vendor rule, ready or not, with or without a violation', async () => {
    prime();
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: false, reason: 'org_not_mapped' }], ['org-2', { ok: true }]]));
    const a = await loadManagedRuleApplicability(POLICY, [
      { deviceId: 'd1', orgId: 'org-1', osType: 'windows' },
      { deviceId: 'd2', orgId: 'org-2', osType: 'windows' },
    ]);
    expect(a.evaluateDevice('d1')).toEqual([
      { catalogId: HUNTRESS_CATALOG, vendor: 'huntress', result: { ok: false, reason: 'org_not_mapped' } },
    ]);
    expect(a.evaluateDevice('d2')).toEqual([{ catalogId: HUNTRESS_CATALOG, vendor: 'huntress', result: { ok: true } }]);
    expect(a.vendors()).toEqual(['huntress']);
  });

  it('evaluateDevice omits rules whose catalog row is not a known vendor (no vendor to key a status row on)', async () => {
    prime({ catalog: [{ id: UNKNOWN_CATALOG, integrationProvider: null }] });
    const a = await loadManagedRuleApplicability(
      { ...POLICY, rules: { software: [{ name: 'X', catalogId: UNKNOWN_CATALOG }], allowUnknown: true } },
      [{ deviceId: 'd1', orgId: 'org-1', osType: 'windows' }],
    );
    expect(a.evaluateDevice('d1')).toEqual([]);
    expect(a.vendors()).toEqual([]);
  });

  it('an unknown device is treated as not applicable rather than assumed ready', async () => {
    prime();
    orgReadiness.mockResolvedValueOnce(new Map());
    const a = await loadManagedRuleApplicability(POLICY, []);
    expect(a.filterViolations('ghost', [missing(HUNTRESS_CATALOG)]).violations).toEqual([]);
  });
});

describe('loadManagedRuleApplicability — SentinelOne rule (#6960 W04, vendor-generic path)', () => {
  const S1_CATALOG = 'cat-s1';
  const S1_POLICY = {
    id: 'policy-s1',
    managedByLinkId: 'link-s1',
    rules: { software: [{ name: 'Sentinel Agent*', catalogId: S1_CATALOG }], allowUnknown: true },
  };
  const s1Missing: SoftwarePolicyViolation = {
    type: 'missing', rule: { name: 'Sentinel Agent*', catalogId: S1_CATALOG }, severity: 'high', detectedAt: '2026-01-01T00:00:00Z',
  };

  it("reads SentinelOne readiness for the DEVICE orgs; an unmapped org's violation becomes not_applicable/org_not_mapped", async () => {
    prime({
      catalog: [{ id: S1_CATALOG, integrationProvider: 'sentinelone' }],
      link: [{ inlineSettings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] } }],
    });
    orgReadiness.mockResolvedValueOnce(new Map([['org-mapped', { ok: true }], ['org-unmapped', { ok: false, reason: 'org_not_mapped' }]]));
    const a = await loadManagedRuleApplicability(S1_POLICY, [
      { deviceId: 'd-mapped', orgId: 'org-mapped', osType: 'windows' },
      { deviceId: 'd-unmapped', orgId: 'org-unmapped', osType: 'windows' },
      { deviceId: 'd-mac', orgId: 'org-mapped', osType: 'macos' },
    ]);
    expect(orgReadiness).toHaveBeenCalledWith('sentinelone', ['org-mapped', 'org-unmapped']);
    expect(a.vendors()).toEqual(['sentinelone']);
    expect(a.filterViolations('d-mapped', [s1Missing])).toEqual({ violations: [s1Missing], notApplicable: [] });
    expect(a.filterViolations('d-unmapped', [s1Missing])).toEqual({
      violations: [],
      notApplicable: [{ catalogId: S1_CATALOG, vendor: 'sentinelone', reason: 'org_not_mapped' }],
    });
    expect(a.filterViolations('d-mac', [s1Missing]).notApplicable).toEqual([
      { catalogId: S1_CATALOG, vendor: 'sentinelone', reason: 'platform_unsupported' },
    ]);
  });
});
