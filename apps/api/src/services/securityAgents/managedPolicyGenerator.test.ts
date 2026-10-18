import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, transactionMock, captureMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: selectMock, transaction: transactionMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../sentry', () => ({ captureException: captureMock }));

import {
  desiredManagedPolicy,
  planManagedPolicySync,
  repairManagedSoftwarePolicies,
  syncManagedSoftwarePolicy,
  SECURITY_AGENTS_BINARY_MISSING_CODE,
} from './managedPolicyGenerator';
import { SecurityAgentsLinkWriteError } from './securityAgentsLinkWrite';

const CATALOG_HUNTRESS = '00000000-0000-4000-8000-0000000000c1';
const CATALOG_S1 = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PARTNER = '00000000-0000-4000-8000-0000000000b1';

const PARTNER_WIDE = { id: 'cp-1', name: 'Baseline', orgId: null, partnerId: PARTNER };
const ORG_OWNED = { id: 'cp-2', name: 'Acme baseline', orgId: ORG, partnerId: null };

const catalog = new Map([['huntress' as const, CATALOG_HUNTRESS]]);

function huntress(enabled: boolean) {
  return { version: 1 as const, agents: [{ vendor: 'huntress' as const, enabled }] };
}

describe('desiredManagedPolicy', () => {
  it('generates the fixed enforcement shape (allowlist, allowUnknown, enforce, autoInstall, never autoUninstall)', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(true), catalogIdByVendor: catalog });
    expect(desired.missingCatalog).toEqual([]);
    expect(desired.row).toMatchObject({
      mode: 'allowlist',
      enforceMode: true,
      isActive: true,
      remediationOptions: { autoInstall: true, autoUninstall: false },
      rules: {
        allowUnknown: true,
        software: [{ name: 'Huntress Agent*', catalogId: CATALOG_HUNTRESS }],
      },
    });
    expect(desired.vendors).toEqual(['huntress']);
  });

  it('a partner-wide config policy yields a partner-owned policy', () => {
    const { row } = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(true), catalogIdByVendor: catalog });
    expect(row.orgId).toBeNull();
    expect(row.partnerId).toBe(PARTNER);
  });

  it('an org config policy yields an org-owned policy (one owner axis only)', () => {
    const { row } = desiredManagedPolicy({ configPolicy: ORG_OWNED, settings: huntress(true), catalogIdByVendor: catalog });
    expect(row.orgId).toBe(ORG);
    expect(row.partnerId).toBeNull();
  });

  it('a disabled vendor has no rule; no enabled vendor means inactive with no rules', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(false), catalogIdByVendor: catalog });
    expect(desired.row.rules.software).toEqual([]);
    expect(desired.row.isActive).toBe(false);
    expect(desired.vendors).toEqual([]);
  });

  it('a vendor that is not enableable never gets a rule, even if a stored blob says enabled', () => {
    const desired = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: { version: 1, agents: [{ vendor: 'nextdns', enabled: true }] },
      catalogIdByVendor: new Map(),
    });
    expect(desired.row.rules.software).toEqual([]);
    expect(desired.row.isActive).toBe(false);
    expect(desired.missingCatalog).toEqual([]);
    expect(desired.missingBinary).toEqual([]);
  });

  it('reports an enabled vendor whose partner catalog package is missing', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(true), catalogIdByVendor: new Map() });
    expect(desired.missingCatalog).toEqual(['huntress']);
    expect(desired.row.rules.software).toEqual([]);
  });

  it('the vendor is not stored in rule JSON (derived from catalogId downstream)', () => {
    const { row } = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(true), catalogIdByVendor: catalog });
    expect(Object.keys(row.rules.software[0]!).sort()).toEqual(['catalogId', 'name', 'reason']);
  });

  it('name fits software_policies.name (varchar 200)', () => {
    const { row } = desiredManagedPolicy({
      configPolicy: { ...PARTNER_WIDE, name: 'x'.repeat(400) },
      settings: huntress(true),
      catalogIdByVendor: catalog,
    });
    expect(row.name.length).toBeLessThanOrEqual(200);
  });
});

describe('desiredManagedPolicy — partner-uploaded binary gate (SentinelOne, #6960 W04)', () => {
  const s1 = (enabled: boolean) => ({ version: 1 as const, agents: [{ vendor: 'sentinelone' as const, enabled }] });
  const s1Catalog = new Map([['sentinelone' as const, CATALOG_S1]]);

  it('a catalog row with no deployable MSI version yields no rule and reports the missing binary', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: s1(true), catalogIdByVendor: s1Catalog, uploadedBinaryVendors: new Set() });
    expect(desired.missingBinary).toEqual(['sentinelone']);
    expect(desired.missingCatalog).toEqual([]);
    expect(desired.vendors).toEqual([]);
    expect(desired.row.rules.software).toEqual([]);
    expect(desired.row.isActive).toBe(false);
  });

  it('fails closed when the caller does not say whether a binary was uploaded', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: s1(true), catalogIdByVendor: s1Catalog });
    expect(desired.missingBinary).toEqual(['sentinelone']);
    expect(desired.row.isActive).toBe(false);
  });

  it('with a deployable MSI the rule is generated and the policy armed', () => {
    const desired = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE, settings: s1(true), catalogIdByVendor: s1Catalog, uploadedBinaryVendors: new Set(['sentinelone' as const]),
    });
    expect(desired.missingBinary).toEqual([]);
    expect(desired.vendors).toEqual(['sentinelone']);
    expect(desired.row.isActive).toBe(true);
    expect(desired.row.rules.software).toEqual([
      { name: 'Sentinel Agent*', catalogId: CATALOG_S1, reason: expect.stringContaining('SentinelOne') },
    ]);
  });

  it('a missing catalog row is reported as catalog-missing, not binary-missing', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: s1(true), catalogIdByVendor: new Map() });
    expect(desired.missingCatalog).toEqual(['sentinelone']);
    expect(desired.missingBinary).toEqual([]);
  });

  it('Huntress needs no uploaded binary (derivable URL): unchanged without the binary set', () => {
    const desired = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(true), catalogIdByVendor: catalog });
    expect(desired.missingBinary).toEqual([]);
    expect(desired.vendors).toEqual(['huntress']);
  });

  it('Huntress + SentinelOne without its MSI: Huntress still gets its rule, SentinelOne is reported', () => {
    const desired = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }, { vendor: 'huntress', enabled: true }] },
      catalogIdByVendor: new Map([['huntress' as const, CATALOG_HUNTRESS], ['sentinelone' as const, CATALOG_S1]]),
      uploadedBinaryVendors: new Set(),
    });
    expect(desired.vendors).toEqual(['huntress']);
    expect(desired.missingBinary).toEqual(['sentinelone']);
  });
});

/**
 * Executor fake: each select() takes the next queued result set in query order
 * (config policy -> owner catalog rows -> [deployable versions] -> existing row).
 */
function fakeExecutor(results: unknown[][]) {
  const queue = [...results];
  const writes: string[] = [];
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
      return { values: () => ({ returning: async () => [{ id: 'policy-new' }], ...settled }) };
    }),
    update: vi.fn(() => {
      writes.push('update');
      return { set: () => ({ where: async () => undefined }) };
    }),
  };
  return { executor: executor as never, writes, remaining: () => queue.length };
}

const S1_LINK = { id: 'link-s1', configPolicyId: 'cp-1', inlineSettings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] } };
const S1_CATALOG_ROW = { id: CATALOG_S1, integrationProvider: 'sentinelone', createdAt: new Date('2026-01-01T00:00:00Z') };

describe('syncManagedSoftwarePolicy — SentinelOne MSI gate (#6960 W04)', () => {
  it('write path: catalog row present but no deployable version -> 400 security_agents_binary_missing with a Versions deep link, nothing written', async () => {
    const { executor, writes } = fakeExecutor([[PARTNER_WIDE], [S1_CATALOG_ROW], []]);
    const err = await syncManagedSoftwarePolicy(executor, S1_LINK, { onMissingCatalog: 'refuse' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecurityAgentsLinkWriteError);
    const refusal = err as SecurityAgentsLinkWriteError;
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe(SECURITY_AGENTS_BINARY_MISSING_CODE);
    expect(refusal.body).toMatchObject({
      code: 'security_agents_binary_missing',
      vendors: ['sentinelone'],
      setupPath: `/software#versions=${CATALOG_S1}`,
    });
    expect(refusal.body.error).toMatch(/SentinelOne/);
    expect(writes).toEqual([]);
  });

  it('write path with a deployable version: the policy is created armed', async () => {
    const { executor, writes } = fakeExecutor([[PARTNER_WIDE], [S1_CATALOG_ROW], [{ catalogId: CATALOG_S1 }], []]);
    const result = await syncManagedSoftwarePolicy(executor, S1_LINK, { onMissingCatalog: 'refuse' });
    expect(result).toMatchObject({ action: 'create', vendors: ['sentinelone'], skippedVendors: [], missingBinaryVendors: [] });
    expect(writes).toEqual(['insert', 'insert']);
  });

  it('a latest version declared for platforms SentinelOne does not support (no Windows) does not count', async () => {
    const { executor } = fakeExecutor([[PARTNER_WIDE], [S1_CATALOG_ROW], [{ catalogId: CATALOG_S1, supportedOs: ['macos'] }]]);
    await expect(syncManagedSoftwarePolicy(executor, S1_LINK)).rejects.toMatchObject({ code: 'security_agents_binary_missing' });
  });

  it('a latest version declaring Windows (or no restriction) counts', async () => {
    for (const supportedOs of [['windows'], [], null]) {
      const { executor } = fakeExecutor([[PARTNER_WIDE], [S1_CATALOG_ROW], [{ catalogId: CATALOG_S1, supportedOs }], []]);
      await expect(syncManagedSoftwarePolicy(executor, S1_LINK)).resolves.toMatchObject({ vendors: ['sentinelone'] });
    }
  });

  it('a deployable-version row for some OTHER catalog id does not count', async () => {
    const { executor } = fakeExecutor([[PARTNER_WIDE], [S1_CATALOG_ROW], [{ catalogId: 'some-other-catalog' }]]);
    await expect(syncManagedSoftwarePolicy(executor, S1_LINK)).rejects.toMatchObject({ code: 'security_agents_binary_missing' });
  });

  it('sweep (skip): no rule, the vendor is reported as missing its binary, and an existing armed row is deactivated', async () => {
    const armed = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] },
      catalogIdByVendor: new Map([['sentinelone' as const, CATALOG_S1]]),
      uploadedBinaryVendors: new Set(['sentinelone' as const]),
    }).row;
    const { executor, writes } = fakeExecutor([[PARTNER_WIDE], [S1_CATALOG_ROW], [], [{ id: 'policy-1', ...armed }]]);
    const result = await syncManagedSoftwarePolicy(executor, S1_LINK, { onMissingCatalog: 'skip' });
    expect(result).toMatchObject({ action: 'update', vendors: [], skippedVendors: ['sentinelone'], missingBinaryVendors: ['sentinelone'] });
    expect(writes[0]).toBe('update');
  });

  it('Huntress never reads software_versions (no uploaded binary needed)', async () => {
    const huntressRow = { id: CATALOG_HUNTRESS, integrationProvider: 'huntress', createdAt: new Date('2026-01-01T00:00:00Z') };
    const { executor, remaining } = fakeExecutor([[PARTNER_WIDE], [huntressRow], []]);
    const result = await syncManagedSoftwarePolicy(executor, { ...S1_LINK, inlineSettings: huntress(true) }, { onMissingCatalog: 'refuse' });
    expect(result).toMatchObject({ action: 'create', vendors: ['huntress'], missingBinaryVendors: [] });
    expect(remaining()).toBe(0);
  });
});

describe('planManagedPolicySync', () => {
  const enabled = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(true), catalogIdByVendor: catalog }).row;
  const disabled = desiredManagedPolicy({ configPolicy: PARTNER_WIDE, settings: huntress(false), catalogIdByVendor: catalog }).row;

  it('no existing row and nothing enabled: create nothing', () => {
    expect(planManagedPolicySync(null, disabled)).toEqual({ action: 'none' });
  });

  it('no existing row and a vendor enabled: create', () => {
    expect(planManagedPolicySync(null, enabled)).toEqual({ action: 'create' });
  });

  it('unchanged: no write, no generation bump', () => {
    expect(planManagedPolicySync({ ...enabled }, enabled)).toEqual({ action: 'none' });
  });

  it('disabling the last vendor deactivates (never deletes), bumps the generation and drops its cached violations', () => {
    expect(planManagedPolicySync({ ...enabled }, disabled)).toEqual({
      action: 'update',
      bumpGeneration: true,
      removedCatalogIds: [CATALOG_HUNTRESS],
    });
  });

  it('re-enabling reuses the row', () => {
    expect(planManagedPolicySync({ ...disabled }, enabled)).toEqual({
      action: 'update',
      bumpGeneration: true,
      removedCatalogIds: [],
    });
  });

  it('jsonb key order from the database is not a change (no perpetual generation bump)', () => {
    const fromDb = {
      ...enabled,
      // jsonb returns keys shortest-first, not in insertion order.
      rules: {
        software: enabled.rules.software.map((rule) => ({ name: rule.name, reason: rule.reason, catalogId: rule.catalogId })),
        allowUnknown: true,
      },
      remediationOptions: { autoUninstall: false, autoInstall: true },
    };
    expect(planManagedPolicySync(fromDb as never, enabled)).toEqual({ action: 'none' });
  });

  it('a rename alone updates without bumping the generation (queued work stays valid)', () => {
    expect(planManagedPolicySync({ ...enabled, name: 'old' }, enabled)).toEqual({
      action: 'update',
      bumpGeneration: false,
      removedCatalogIds: [],
    });
  });

  it('a manual drift in enforcement fields is repaired and bumps the generation', () => {
    expect(planManagedPolicySync({ ...enabled, remediationOptions: { autoInstall: true, autoUninstall: true } }, enabled)).toMatchObject({
      action: 'update',
      bumpGeneration: true,
    });
  });
});

describe('repairManagedSoftwarePolicies', () => {
  beforeEach(() => { captureMock.mockClear(); transactionMock.mockClear(); });
  it('an enabled vendor whose MSI is missing is surfaced (warn + Sentry, own fingerprint), not silently dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureMock.mockClear();
    selectMock.mockReturnValueOnce({ from: () => ({ where: async () => [{ id: 'link-s1' }] }) });
    transactionMock.mockResolvedValueOnce({
      policyId: 'policy-1', action: 'update', vendors: [], skippedVendors: ['sentinelone'], missingBinaryVendors: ['sentinelone'],
    });
    await expect(repairManagedSoftwarePolicies()).resolves.toEqual({ links: 1, changed: 1, failed: 0 });
    expect(captureMock).toHaveBeenCalledTimes(1);
    const [, , tags, opts] = captureMock.mock.calls[0]!;
    expect(tags).toMatchObject({ area: 'security_agents_repair', vendors: 'sentinelone' });
    expect(opts).toEqual({ fingerprint: ['security_agents_repair', 'binary_missing'] });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/installer/i), expect.objectContaining({ linkId: 'link-s1', vendors: ['sentinelone'] }));
    warn.mockRestore();
  });

  it('one failing link is counted, logged and sent to Sentry; the others still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    selectMock.mockReturnValueOnce({ from: () => ({ where: async () => [{ id: 'link-a' }, { id: 'link-b' }] }) });
    transactionMock
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValueOnce(null); // link-b deleted between list and lock
    await expect(repairManagedSoftwarePolicies()).resolves.toEqual({ links: 2, changed: 0, failed: 1 });
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
