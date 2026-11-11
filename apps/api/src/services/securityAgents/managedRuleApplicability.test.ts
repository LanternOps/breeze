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
    expect(a.isRuleApplicable('ghost', HUNTRESS_CATALOG)).toBe(false);
  });

  it('isRuleApplicable answers per (device, rule catalogId) with the same readiness as filterViolations (#10126)', async () => {
    prime();
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: true }], ['org-2', { ok: false, reason: 'org_not_mapped' }]]));
    const a = await loadManagedRuleApplicability(POLICY, [
      { deviceId: 'd1', orgId: 'org-1', osType: 'windows' },
      { deviceId: 'd2', orgId: 'org-2', osType: 'windows' },
      { deviceId: 'd-mac', orgId: 'org-1', osType: 'macos' },
    ]);
    expect(a.isRuleApplicable('d1', HUNTRESS_CATALOG)).toBe(true);
    expect(a.isRuleApplicable('d2', HUNTRESS_CATALOG)).toBe(false);
    // Platform beats org, exactly as in filterViolations.
    expect(a.isRuleApplicable('d-mac', HUNTRESS_CATALOG)).toBe(false);
    // Fail closed: a catalog id that is not one of this policy's vendor rules.
    expect(a.isRuleApplicable('d1', UNKNOWN_CATALOG)).toBe(false);
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

  const S1_LINK = [{ inlineSettings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] } }];
  /** The package's latest version as a correctly prepared S1 MSI. */
  const S1_MSI = { catalogId: S1_CATALOG, supportedOs: ['windows'], fileType: 'msi', silentInstallArgs: 'SITE_TOKEN={s1_site_token} /q' };

  it("reads SentinelOne readiness for the DEVICE orgs; an unmapped org's violation becomes not_applicable/org_not_mapped", async () => {
    prime({ catalog: [{ id: S1_CATALOG, integrationProvider: 'sentinelone' }], link: S1_LINK });
    queued.push([S1_MSI]);
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

  // #9247: the rule stays when the partner's package has no deployable MSI;
  // every Windows device reads installer_missing (a coverage row a partner
  // sees) instead of the rule being dropped. Nothing installs: the violation
  // is filtered like any other not-ready reason.
  it.each<[string, unknown[]]>([
    ['no latest version with an installer', []],
    ['a latest version that is not an MSI', [{ ...S1_MSI, fileType: 'exe' }]],
    ['a latest MSI without the site-token placeholder', [{ ...S1_MSI, silentInstallArgs: '/qn' }]],
    ['a deployable MSI on some OTHER catalog row', [{ ...S1_MSI, catalogId: 'cat-other' }]],
  ])('%s → installer_missing for a Windows device without the agent, even in a ready org', async (_name, versions) => {
    prime({ catalog: [{ id: S1_CATALOG, integrationProvider: 'sentinelone' }], link: S1_LINK });
    queued.push(versions);
    orgReadiness.mockResolvedValueOnce(new Map([['org-mapped', { ok: true }], ['org-unmapped', { ok: false, reason: 'org_not_mapped' }]]));
    const a = await loadManagedRuleApplicability(S1_POLICY, [
      { deviceId: 'd-mapped', orgId: 'org-mapped', osType: 'windows' },
      { deviceId: 'd-unmapped', orgId: 'org-unmapped', osType: 'windows' },
      { deviceId: 'd-mac', orgId: 'org-mapped', osType: 'macos' },
    ]);
    // The install is refused: the `missing` violation is not applicable.
    expect(a.filterViolations('d-mapped', [s1Missing])).toEqual({
      violations: [],
      notApplicable: [{ catalogId: S1_CATALOG, vendor: 'sentinelone', reason: 'installer_missing' }],
    });
    // A device without the agent reads installer_missing on its coverage row.
    const missingHere = { missingCatalogIds: new Set([S1_CATALOG]) };
    expect(a.evaluateDevice('d-mapped', missingHere)).toEqual([
      { catalogId: S1_CATALOG, vendor: 'sentinelone', result: { ok: false, reason: 'installer_missing' } },
    ]);
    // Presence unknown → treated as missing (visible, never silently "ready").
    expect(a.evaluateDevice('d-mapped')[0]?.result).toEqual({ ok: false, reason: 'installer_missing' });
    // The org's own blocker comes first: mapping is needed whatever the installer.
    expect(a.evaluateDevice('d-unmapped', missingHere)[0]?.result).toEqual({ ok: false, reason: 'org_not_mapped' });
    // Platform still outranks it: a Mac is not a SentinelOne target at all.
    expect(a.evaluateDevice('d-mac', missingHere)[0]?.result).toEqual({ ok: false, reason: 'platform_unsupported' });
  });

  // Review of #10823: the missing installer blocks only an INSTALL. A device
  // that already runs the agent keeps reconciling (covered / offline / gap),
  // keeps its service watch, and keeps its service violations.
  it('installer_missing never touches a device that already has the agent', async () => {
    prime({ catalog: [{ id: S1_CATALOG, integrationProvider: 'sentinelone' }], link: S1_LINK });
    queued.push([]);
    orgReadiness.mockResolvedValueOnce(new Map([['org-mapped', { ok: true }]]));
    const a = await loadManagedRuleApplicability(S1_POLICY, [{ deviceId: 'd-installed', orgId: 'org-mapped', osType: 'windows' }]);
    expect(a.evaluateDevice('d-installed', { missingCatalogIds: new Set() })).toEqual([
      { catalogId: S1_CATALOG, vendor: 'sentinelone', result: { ok: true } },
    ]);
    expect(a.isRuleApplicable('d-installed', S1_CATALOG)).toBe(true);
    const notRunning: SoftwarePolicyViolation = {
      type: 'not_running', rule: { name: 'Sentinel Agent*', catalogId: S1_CATALOG },
      service: { name: 'SentinelAgent', observedStatus: 'stopped', observedAt: null }, severity: 'high', detectedAt: '2026-01-01T00:00:00Z',
    } as SoftwarePolicyViolation;
    expect(a.filterViolations('d-installed', [notRunning])).toEqual({ violations: [notRunning], notApplicable: [] });
  });

  it('Huntress (derivable installer URL) never reads software_versions', async () => {
    prime();
    queued.push([{ unexpected: 'versions row' }]);
    orgReadiness.mockResolvedValueOnce(new Map([['org-1', { ok: true }]]));
    const a = await loadManagedRuleApplicability(POLICY, [{ deviceId: 'd1', orgId: 'org-1', osType: 'windows' }]);
    expect(a.isRuleApplicable('d1', HUNTRESS_CATALOG)).toBe(true);
    expect(queued).toHaveLength(1);
  });
});

describe('loadManagedRuleApplicability — tenant-variable (DNS) rules and service violations (#6960 W05)', () => {
  const NEXTDNS_WIN = 'cat-nextdns-win';
  const CONTROLD_WIN = 'cat-controld-win';
  const CONTROLD_MAC = 'cat-controld-mac';
  const NEXTDNS_POLICY = {
    id: 'policy-dns',
    managedByLinkId: 'link-dns',
    rules: { software: [{ name: 'NextDNS CLI (Windows)', catalogId: NEXTDNS_WIN }], allowUnknown: true },
  };
  const NEXTDNS_LINK = [{ inlineSettings: { version: 1, agents: [{ vendor: 'nextdns', enabled: true }] } }];

  function violation(type: 'missing' | 'not_running' | 'service_unverified', catalogId = NEXTDNS_WIN): SoftwarePolicyViolation {
    return {
      type,
      rule: { name: 'NextDNS CLI (Windows)', catalogId },
      ...(type === 'missing' ? {} : { service: { name: 'nextdns', observedStatus: type === 'not_running' ? 'stopped' : null, observedAt: null } }),
      severity: type === 'not_running' ? 'high' : 'low',
      detectedAt: '2026-01-01T00:00:00Z',
    } as SoftwarePolicyViolation;
  }

  async function nextdnsApplicability() {
    prime({ catalog: [{ id: NEXTDNS_WIN, integrationProvider: null, builtinPackageKey: 'nextdns_windows' }], link: NEXTDNS_LINK });
    orgReadiness.mockResolvedValueOnce(new Map([
      ['org-ready', { ok: true }],
      ['org-novar', { ok: false, reason: 'var_missing' }],
      ['org-secret', { ok: false, reason: 'var_secret' }],
    ]));
    return loadManagedRuleApplicability(NEXTDNS_POLICY, [
      { deviceId: 'd-ready', orgId: 'org-ready', osType: 'windows' },
      { deviceId: 'd-novar', orgId: 'org-novar', osType: 'windows' },
      { deviceId: 'd-secret', orgId: 'org-secret', osType: 'windows' },
      { deviceId: 'd-mac', orgId: 'org-ready', osType: 'macos' },
    ]);
  }

  it('maps a rule to its vendor through the catalog row\'s builtin_package_key and reads that vendor\'s readiness', async () => {
    const a = await nextdnsApplicability();
    expect(orgReadiness).toHaveBeenCalledWith('nextdns', ['org-ready', 'org-novar', 'org-secret']);
    expect(a.vendors()).toEqual(['nextdns']);
  });

  it.each([
    ['missing', 'd-ready', 'kept'],
    ['missing', 'd-novar', 'var_missing'],
    ['missing', 'd-secret', 'var_secret'],
    ['missing', 'd-mac', 'platform_unsupported'],
    ['not_running', 'd-ready', 'kept'],
    ['not_running', 'd-novar', 'var_missing'],
    ['not_running', 'd-secret', 'var_secret'],
    ['not_running', 'd-mac', 'platform_unsupported'],
    ['service_unverified', 'd-ready', 'kept'],
    ['service_unverified', 'd-novar', 'var_missing'],
    ['service_unverified', 'd-secret', 'var_secret'],
    ['service_unverified', 'd-mac', 'platform_unsupported'],
  ] as const)('%s on %s → %s', async (type, deviceId, expected) => {
    const a = await nextdnsApplicability();
    const v = violation(type);
    const out = a.filterViolations(deviceId, [v]);
    if (expected === 'kept') {
      expect(out).toEqual({ violations: [v], notApplicable: [] });
    } else {
      expect(out).toEqual({ violations: [], notApplicable: [{ catalogId: NEXTDNS_WIN, vendor: 'nextdns', reason: expected }] });
    }
  });

  it("a Linux device (no row for its OS) is platform_unsupported, never judged on the Windows row's readiness", async () => {
    prime({ catalog: [{ id: NEXTDNS_WIN, integrationProvider: null, builtinPackageKey: 'nextdns_windows' }], link: NEXTDNS_LINK });
    orgReadiness.mockResolvedValueOnce(new Map([['org-ready', { ok: true }]]));
    const a = await loadManagedRuleApplicability(NEXTDNS_POLICY, [{ deviceId: 'd-linux', orgId: 'org-ready', osType: 'linux' }]);
    expect(a.evaluateDevice('d-linux')).toEqual([{ catalogId: NEXTDNS_WIN, vendor: 'nextdns', result: { ok: false, reason: 'platform_unsupported' } }]);
    expect(a.filterViolations('d-linux', [violation('service_unverified')]).notApplicable[0]?.reason).toBe('platform_unsupported');
  });

  it('unauthorized violations are untouched on a not-ready device', async () => {
    const a = await nextdnsApplicability();
    const unauthorized: SoftwarePolicyViolation = { type: 'unauthorized', software: { name: 'x' }, severity: 'medium', detectedAt: '2026-01-01T00:00:00Z' };
    expect(a.filterViolations('d-novar', [unauthorized]).violations).toEqual([unauthorized]);
  });

  it("a per-OS row applies only to its own OS: a Windows device is not a target of the macOS row, even in a ready org", async () => {
    prime({
      catalog: [
        { id: CONTROLD_WIN, integrationProvider: null, builtinPackageKey: 'controld_windows' },
        { id: CONTROLD_MAC, integrationProvider: null, builtinPackageKey: 'controld_macos' },
      ],
      link: [{ inlineSettings: { version: 1, agents: [{ vendor: 'controld', enabled: true }] } }],
    });
    orgReadiness.mockResolvedValueOnce(new Map([['org-ready', { ok: true }]]));
    const a = await loadManagedRuleApplicability(
      {
        id: 'policy-cd',
        managedByLinkId: 'link-cd',
        rules: {
          software: [
            { name: 'Control D (Windows)', catalogId: CONTROLD_WIN },
            { name: 'Control D (macOS)', catalogId: CONTROLD_MAC },
          ],
          allowUnknown: true,
        },
      },
      [{ deviceId: 'd-win', orgId: 'org-ready', osType: 'windows' }],
    );
    // One vendor, read once, however many OS rows it has.
    expect(orgReadiness).toHaveBeenCalledTimes(1);
    expect(a.vendors()).toEqual(['controld']);
    const winMissing = violation('missing', CONTROLD_WIN);
    const macMissing = violation('missing', CONTROLD_MAC);
    expect(a.filterViolations('d-win', [winMissing, macMissing])).toEqual({
      violations: [winMissing],
      notApplicable: [{ catalogId: CONTROLD_MAC, vendor: 'controld', reason: 'platform_unsupported' }],
    });
    // Coverage keys one status row per (device, vendor): the device's own OS row.
    expect(a.evaluateDevice('d-win')).toEqual([{ catalogId: CONTROLD_WIN, vendor: 'controld', result: { ok: true } }]);
  });
});
