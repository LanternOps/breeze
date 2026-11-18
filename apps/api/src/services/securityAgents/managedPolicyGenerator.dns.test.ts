import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #6960 W05: the generator for the tenant-variable (DNS) vendors, one rule per
 * (vendor, OS) built-in package. W05 shipped code-only: Control D and NextDNS
 * stay `enableable: false` in the registry until the #6958 lab gates are
 * recorded, so this file runs the generator as it will behave after that
 * one-line flip, by overriding `enableable` for the DNS vendors only.
 */

const { selectMock, transactionMock, captureMock, catalogIdForBuiltinKey } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
  captureMock: vi.fn(),
  catalogIdForBuiltinKey: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: selectMock, transaction: transactionMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../sentry', () => ({ captureException: captureMock }));
vi.mock('../builtinDeploymentPackages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../builtinDeploymentPackages')>();
  return { ...actual, catalogIdForBuiltinKey: (...args: unknown[]) => catalogIdForBuiltinKey(...args) };
});
vi.mock('./securityAgentVendors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./securityAgentVendors')>();
  const flip = <T extends { key: string; enableable: boolean }>(vendor: T): T =>
    (vendor.key === 'controld' || vendor.key === 'nextdns' ? { ...vendor, enableable: true } : vendor);
  const list = actual.listVendors().map(flip);
  return {
    ...actual,
    listVendors: () => list,
    getVendor: (key: string) => {
      const found = list.find((vendor) => vendor.key === key);
      if (!found) throw new Error(`Unknown security agent vendor: ${key}`);
      return found;
    },
  };
});

import {
  desiredManagedPolicy,
  syncManagedSoftwarePolicy,
  SECURITY_AGENTS_CATALOG_MISSING_CODE,
} from './managedPolicyGenerator';
import { checkSecurityAgentsLinkWrite, SecurityAgentsLinkWriteError } from './securityAgentsLinkWrite';

const PARTNER = '00000000-0000-4000-8000-0000000000b1';
const ORG_PARTNER = '00000000-0000-4000-8000-0000000000b2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const CATALOG_HUNTRESS = '00000000-0000-4000-8000-0000000000c1';
const CATALOG_NEXTDNS_WIN = '00000000-0000-4000-8000-0000000000d1';
const CATALOG_CONTROLD_WIN = '00000000-0000-4000-8000-0000000000d2';
const CATALOG_CONTROLD_MAC = '00000000-0000-4000-8000-0000000000d3';

const PARTNER_WIDE = { id: 'cp-1', name: 'Baseline', orgId: null, partnerId: PARTNER };
const ORG_OWNED = { id: 'cp-2', name: 'Acme baseline', orgId: ORG, partnerId: null };

const settings = (...agents: Array<{ vendor: 'huntress' | 'controld' | 'nextdns'; enabled: boolean; platforms?: Array<'windows' | 'macos' | 'linux'> }>) =>
  ({ version: 1 as const, agents });

/** Each select() takes the next queued result set in query order. */
function fakeExecutor(results: unknown[][]) {
  const queue = [...results];
  const writes: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'for', 'innerJoin']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
    return c;
  };
  const settled = { then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r) };
  const executor = {
    select: vi.fn(() => chain(queue.shift() ?? [])),
    insert: vi.fn(() => {
      writes.push('insert');
      return {
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [{ id: 'policy-new' }], ...settled };
        },
      };
    }),
    update: vi.fn(() => {
      writes.push('update');
      return { set: (values: Record<string, unknown>) => { updates.push(values); return { where: async () => undefined }; } };
    }),
  };
  return { executor: executor as never, select: executor.select, writes, inserted, updates };
}

const NEXTDNS_LINK = { id: 'link-dns', configPolicyId: 'cp-1', inlineSettings: settings({ vendor: 'nextdns', enabled: true }) };

beforeEach(() => {
  catalogIdForBuiltinKey.mockReset();
  captureMock.mockReset();
});

describe('desiredManagedPolicy — tenant-variable vendors (#6960 W05)', () => {
  it('one rule per built-in package row, named after the pinned package (never an inventory glob)', () => {
    const desired = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: settings({ vendor: 'nextdns', enabled: true }),
      catalogByVendor: new Map([['nextdns', [{ catalogId: CATALOG_NEXTDNS_WIN, builtinPackageKey: 'nextdns_windows' }]]]),
    });
    expect(desired.missingCatalog).toEqual([]);
    expect(desired.vendors).toEqual(['nextdns']);
    expect(desired.row.isActive).toBe(true);
    expect(desired.row.rules.software).toEqual([
      { name: 'NextDNS CLI (Windows)', catalogId: CATALOG_NEXTDNS_WIN, reason: expect.stringContaining('NextDNS') },
    ]);
    expect(desired.row).toMatchObject({ mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true, autoUninstall: false } });
  });

  it('a vendor with two OS rows gets two rules, in row order (Control D Windows + macOS once macOS is supported)', () => {
    const desired = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: settings({ vendor: 'controld', enabled: true }),
      catalogByVendor: new Map([['controld', [
        { catalogId: CATALOG_CONTROLD_WIN, builtinPackageKey: 'controld_windows' },
        { catalogId: CATALOG_CONTROLD_MAC, builtinPackageKey: 'controld_macos' },
      ]]]),
    });
    expect(desired.row.rules.software.map((rule) => [rule.name, rule.catalogId])).toEqual([
      ['Control D (Windows)', CATALOG_CONTROLD_WIN],
      ['Control D (macOS)', CATALOG_CONTROLD_MAC],
    ]);
    expect(desired.vendors).toEqual(['controld']);
  });

  it('no row for an enabled DNS vendor is catalog-missing', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: settings({ vendor: 'nextdns', enabled: true }), catalogByVendor: new Map() });
    expect(desired.missingCatalog).toEqual(['nextdns']);
    expect(desired.row.rules.software).toEqual([]);
    expect(desired.row.isActive).toBe(false);
  });
});

describe('syncManagedSoftwarePolicy — tenant-variable vendors (#6960 W05)', () => {
  it("partner-wide NextDNS: resolves the owner partner's nextdns_windows row (read-only lookup) and creates one armed rule", async () => {
    catalogIdForBuiltinKey.mockResolvedValue(CATALOG_NEXTDNS_WIN);
    const { executor, writes, inserted } = fakeExecutor([[PARTNER_WIDE], []]);
    const result = await syncManagedSoftwarePolicy(executor, NEXTDNS_LINK, { onMissingCatalog: 'refuse' });
    expect(result).toMatchObject({ action: 'create', vendors: ['nextdns'], skippedVendors: [] });
    expect(catalogIdForBuiltinKey.mock.calls).toEqual([[PARTNER, 'nextdns_windows']]);
    expect(writes).toEqual(['insert', 'insert']);
    expect(inserted[0]).toMatchObject({
      partnerId: PARTNER,
      orgId: null,
      isActive: true,
      rules: { software: [{ name: 'NextDNS CLI (Windows)', catalogId: CATALOG_NEXTDNS_WIN }], allowUnknown: true },
    });
  });

  it('row absent or archived (the lookup returns null for both) → 400 security_agents_catalog_missing naming NextDNS, pointing at the Built-in packages panel; nothing written', async () => {
    catalogIdForBuiltinKey.mockResolvedValue(null);
    const { executor, writes } = fakeExecutor([[PARTNER_WIDE]]);
    const err = await syncManagedSoftwarePolicy(executor, NEXTDNS_LINK, { onMissingCatalog: 'refuse' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecurityAgentsLinkWriteError);
    const refusal = err as SecurityAgentsLinkWriteError;
    expect(refusal.status).toBe(400);
    expect(refusal.body).toMatchObject({ code: SECURITY_AGENTS_CATALOG_MISSING_CODE, vendors: ['nextdns'], setupPath: '/software' });
    expect(refusal.body.error).toMatch(/NextDNS/);
    expect(refusal.body.error).toMatch(/Built-in packages/);
    expect(refusal.body.error).not.toMatch(/integration/i);
    expect(writes).toEqual([]);
  });

  it("an org-owned config policy resolves the ORG's partner's row", async () => {
    catalogIdForBuiltinKey.mockResolvedValue(CATALOG_NEXTDNS_WIN);
    const { executor, inserted } = fakeExecutor([[ORG_OWNED], [{ partnerId: ORG_PARTNER }], []]);
    await syncManagedSoftwarePolicy(executor, { ...NEXTDNS_LINK, configPolicyId: 'cp-2' }, { onMissingCatalog: 'refuse' });
    expect(catalogIdForBuiltinKey.mock.calls).toEqual([[ORG_PARTNER, 'nextdns_windows']]);
    expect(inserted[0]).toMatchObject({ orgId: ORG, partnerId: null });
  });

  it('only the OS keys the vendor supports are looked up (controld_macos is never read while macOS is unsupported)', async () => {
    catalogIdForBuiltinKey.mockResolvedValue(CATALOG_CONTROLD_WIN);
    const { executor } = fakeExecutor([[PARTNER_WIDE], []]);
    await syncManagedSoftwarePolicy(executor, { ...NEXTDNS_LINK, inlineSettings: settings({ vendor: 'controld', enabled: true }) });
    expect(catalogIdForBuiltinKey.mock.calls).toEqual([[PARTNER, 'controld_windows']]);
  });

  it('Huntress + Control D: two rules in registry order, whatever order the link lists them in', async () => {
    catalogIdForBuiltinKey.mockResolvedValue(CATALOG_CONTROLD_WIN);
    const huntressRow = { id: CATALOG_HUNTRESS, integrationProvider: 'huntress', createdAt: new Date('2026-01-01T00:00:00Z') };
    const { executor, inserted } = fakeExecutor([[PARTNER_WIDE], [huntressRow], []]);
    const result = await syncManagedSoftwarePolicy(executor, {
      ...NEXTDNS_LINK,
      inlineSettings: settings({ vendor: 'controld', enabled: true }, { vendor: 'huntress', enabled: true }),
    }, { onMissingCatalog: 'refuse' });
    expect(result.vendors).toEqual(['huntress', 'controld']);
    expect((inserted[0]!.rules as { software: Array<{ catalogId: string }> }).software.map((rule) => rule.catalogId))
      .toEqual([CATALOG_HUNTRESS, CATALOG_CONTROLD_WIN]);
  });

  it('a disabled DNS vendor triggers no lookup', async () => {
    const { executor } = fakeExecutor([[PARTNER_WIDE], []]);
    await syncManagedSoftwarePolicy(executor, { ...NEXTDNS_LINK, inlineSettings: settings({ vendor: 'nextdns', enabled: false }) });
    expect(catalogIdForBuiltinKey).not.toHaveBeenCalled();
  });

  it('sweep (skip), fail closed both ways: an archived row drops the rule and deactivates; once un-archived the rule comes back', async () => {
    const armed = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: settings({ vendor: 'nextdns', enabled: true }),
      catalogByVendor: new Map([['nextdns', [{ catalogId: CATALOG_NEXTDNS_WIN, builtinPackageKey: 'nextdns_windows' }]]]),
    }).row;

    catalogIdForBuiltinKey.mockResolvedValueOnce(null);
    const first = fakeExecutor([[PARTNER_WIDE], [{ id: 'policy-1', ...armed }]]);
    const dropped = await syncManagedSoftwarePolicy(first.executor, NEXTDNS_LINK, { onMissingCatalog: 'skip' });
    expect(dropped).toMatchObject({ action: 'update', vendors: [], skippedVendors: ['nextdns'] });
    expect(first.updates[0]).toMatchObject({ isActive: false, rules: { software: [] } });
    expect(first.updates[0]).toHaveProperty('approvalGeneration');

    catalogIdForBuiltinKey.mockResolvedValueOnce(CATALOG_NEXTDNS_WIN);
    const inactive = { ...armed, isActive: false, rules: { software: [], allowUnknown: true } };
    const second = fakeExecutor([[PARTNER_WIDE], [{ id: 'policy-1', ...inactive }]]);
    const restored = await syncManagedSoftwarePolicy(second.executor, NEXTDNS_LINK, { onMissingCatalog: 'skip' });
    expect(restored).toMatchObject({ action: 'update', vendors: ['nextdns'], skippedVendors: [] });
    expect(second.updates[0]).toMatchObject({ isActive: true, rules: { software: [{ catalogId: CATALOG_NEXTDNS_WIN }] } });
  });
});

describe('desiredManagedPolicy — guards (#6960 W05)', () => {
  it('a tenant-variable vendor row with no built-in key throws rather than naming a rule after the vendor (an inventory glob)', () => {
    expect(() => desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: settings({ vendor: 'nextdns', enabled: true }),
      catalogByVendor: new Map([['nextdns', [{ catalogId: CATALOG_NEXTDNS_WIN, builtinPackageKey: null }]]]),
    })).toThrow(/nextdns/i);
  });

  it('EDR and DNS vendors missing together: one message naming each remedy', async () => {
    catalogIdForBuiltinKey.mockResolvedValue(null);
    const { executor } = fakeExecutor([[PARTNER_WIDE], []]);
    const err = await syncManagedSoftwarePolicy(executor, {
      ...NEXTDNS_LINK,
      inlineSettings: settings({ vendor: 'huntress', enabled: true }, { vendor: 'nextdns', enabled: true }),
    }, { onMissingCatalog: 'refuse' }).catch((e: unknown) => e) as SecurityAgentsLinkWriteError;
    expect(err.body.vendors).toEqual(['huntress', 'nextdns']);
    expect(err.body.error).toMatch(/Huntress cannot be enabled until its integration is connected/);
    expect(err.body.error).toMatch(/NextDNS cannot be enabled until its client is added .*Built-in packages/);
    expect(err.body.setupPath).toBe('/integrations#huntress');
  });
});

describe('checkSecurityAgentsLinkWrite — DNS platform limits (#6960 W05)', () => {
  it('Control D limited to macOS is refused before any catalog read', () => {
    const result = checkSecurityAgentsLinkWrite({
      inlineSettings: settings({ vendor: 'controld', enabled: true, platforms: ['macos'] }),
      armAuthorized: true,
    });
    expect(result).toMatchObject({ ok: false, refusal: { status: 400, body: { code: 'security_agents_platform_unsupported', vendors: ['controld'] } } });
    expect(catalogIdForBuiltinKey).not.toHaveBeenCalled();
  });

  it('Control D on Windows passes the write check once enableable', () => {
    expect(checkSecurityAgentsLinkWrite({
      inlineSettings: settings({ vendor: 'controld', enabled: true, platforms: ['windows'] }),
      armAuthorized: true,
    })).toMatchObject({ ok: true });
  });
});
