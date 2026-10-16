import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { desiredManagedPolicy, planManagedPolicySync } from './managedPolicyGenerator';

const CATALOG_HUNTRESS = '00000000-0000-4000-8000-0000000000c1';
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
      settings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] },
      catalogIdByVendor: new Map([['sentinelone' as const, 'cat-s1']]),
    });
    expect(desired.row.rules.software).toEqual([]);
    expect(desired.row.isActive).toBe(false);
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
