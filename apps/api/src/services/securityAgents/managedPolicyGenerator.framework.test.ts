import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #8170 W06.2: the generator for an EDR framework vendor. Bitdefender stays
 * `enableable: false` until the W06.3 owner lab, so this file runs the generator
 * as it will behave after that flip, by overriding `enableable` for that vendor
 * only (`flipped`). With `flipped` false it is the real, dormant registry.
 */

const { selectMock, transactionMock, captureMock, state } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
  captureMock: vi.fn(),
  state: { flipped: true },
}));

vi.mock('../../db', () => ({
  db: { select: selectMock, transaction: transactionMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../sentry', () => ({ captureException: captureMock }));
vi.mock('./securityAgentVendors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./securityAgentVendors')>();
  const view = <T extends { key: string; enableable: boolean }>(vendor: T): T =>
    (state.flipped && vendor.key === 'bitdefender' ? { ...vendor, enableable: true } : vendor);
  return {
    ...actual,
    listVendors: () => actual.listVendors().map(view),
    getVendor: (key: Parameters<typeof actual.getVendor>[0]) => view(actual.getVendor(key)),
  };
});

import { desiredManagedPolicy, syncManagedSoftwarePolicy, vendorRequiresUploadedBinary } from './managedPolicyGenerator';
import { SecurityAgentsLinkWriteError } from './securityAgentsLinkWrite';

const PARTNER = '00000000-0000-4000-8000-0000000000b1';
const CATALOG = '00000000-0000-4000-8000-0000000000c1';
const CATALOG_HUNTRESS = '00000000-0000-4000-8000-0000000000c2';
const PARTNER_WIDE = { id: 'cp-1', name: 'Baseline', orgId: null, partnerId: PARTNER };
const ENABLED = { version: 1 as const, agents: [{ vendor: 'bitdefender' as const, enabled: true }] };
const LINK = { id: 'link-1', configPolicyId: 'cp-1', inlineSettings: ENABLED };

function fakeExecutor(results: unknown[][]) {
  const queue = [...results];
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'for', 'innerJoin']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
    return c;
  };
  const settled = { then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r) };
  const executor = {
    select: vi.fn(() => chain(queue.shift() ?? [])),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: async () => [{ id: 'policy-new' }], ...settled };
      },
    })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  };
  return { executor: executor as never, select: executor.select, inserted };
}

beforeEach(() => {
  state.flipped = true;
  captureMock.mockReset();
});

describe('framework vendor, as it behaves once enableable', () => {
  it('needs no uploaded binary', () => {
    expect(vendorRequiresUploadedBinary('bitdefender')).toBe(false);
  });

  it('with its catalog row: one rule, named by the inventory glob', () => {
    const desired = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: ENABLED,
      catalogByVendor: new Map([['bitdefender', [{ catalogId: CATALOG, builtinPackageKey: null }]]]),
    });
    expect(desired.vendors).toEqual(['bitdefender']);
    expect(desired.missingBinary).toEqual([]);
    expect(desired.row.isActive).toBe(true);
    expect(desired.row.rules.software).toEqual([{
      name: 'Bitdefender Endpoint Security Tools*',
      catalogId: CATALOG,
      reason: 'Bitdefender GravityZone is required by a configuration policy (Security Agents)',
    }]);
  });

  it("sync writes that rule from the partner's catalog row, with no installer-version read", async () => {
    const { executor, select, inserted } = fakeExecutor([
      [PARTNER_WIDE],
      [{ id: CATALOG, integrationProvider: 'bitdefender', createdAt: new Date('2026-11-01') }],
      [],
    ]);
    const result = await syncManagedSoftwarePolicy(executor, LINK);
    expect(result.vendors).toEqual(['bitdefender']);
    expect(result.action).toBe('create');
    expect((inserted[0]!.rules as { software: Array<{ name: string; catalogId: string }> }).software)
      .toEqual([expect.objectContaining({ name: 'Bitdefender Endpoint Security Tools*', catalogId: CATALOG })]);
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('no catalog row (unreleased or unprovisioned): the write is refused with a readable reason and the setup path', async () => {
    const { executor, inserted } = fakeExecutor([[PARTNER_WIDE], []]);
    const failure = await syncManagedSoftwarePolicy(executor, LINK).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SecurityAgentsLinkWriteError);
    const { body, status } = failure as SecurityAgentsLinkWriteError;
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'security_agents_catalog_missing', vendors: ['bitdefender'], setupPath: '/integrations#edr' });
    expect(body.error).toContain('Bitdefender GravityZone');
    expect(inserted).toEqual([]);
  });

  it('no catalog row on the sweep path: the vendor is skipped and reported, nothing is created', async () => {
    const { executor, inserted } = fakeExecutor([[PARTNER_WIDE], [], []]);
    const result = await syncManagedSoftwarePolicy(executor, LINK, { onMissingCatalog: 'skip' });
    expect(result.skippedVendors).toEqual(['bitdefender']);
    expect(result.action).toBe('none');
    expect(inserted).toEqual([]);
  });

  it('listed with Huntress: rules follow registry order, and one missing row refuses the whole write', async () => {
    const both = { version: 1 as const, agents: [{ vendor: 'bitdefender' as const, enabled: true }, { vendor: 'huntress' as const, enabled: true }] };
    const desired = desiredManagedPolicy({
      configPolicy: PARTNER_WIDE,
      settings: both,
      catalogByVendor: new Map([
        ['bitdefender', [{ catalogId: CATALOG, builtinPackageKey: null }]],
        ['huntress', [{ catalogId: CATALOG_HUNTRESS, builtinPackageKey: null }]],
      ]),
    });
    expect(desired.vendors).toEqual(['huntress', 'bitdefender']);

    const { executor } = fakeExecutor([[PARTNER_WIDE], [{ id: CATALOG_HUNTRESS, integrationProvider: 'huntress', createdAt: new Date('2026-11-01') }]]);
    await expect(syncManagedSoftwarePolicy(executor, { ...LINK, inlineSettings: both }))
      .rejects.toMatchObject({ body: { code: 'security_agents_catalog_missing', vendors: ['bitdefender'] } });
  });
});

describe('framework vendor with the REAL dormant registry', () => {
  it('a stored blob enabling it generates no rule and creates nothing', async () => {
    state.flipped = false;
    const { executor, inserted } = fakeExecutor([[PARTNER_WIDE], [], []]);
    const result = await syncManagedSoftwarePolicy(executor, LINK, { onMissingCatalog: 'skip' });
    expect(result.vendors).toEqual([]);
    expect(result.skippedVendors).toEqual([]);
    expect(result.action).toBe('none');
    expect(inserted).toEqual([]);
  });
});
