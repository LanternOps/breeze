import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => {
  const db: Record<string, any> = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  };
  db.transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(db));
  return { db };
});

vi.mock('../db/schema', () => ({
  configPolicyAssignments: { configPolicyId: 'cpa.configPolicyId' },
  configPolicyFeatureLinks: {
    configPolicyId: 'cpfl.configPolicyId',
    featureType: 'cpfl.featureType',
    featurePolicyId: 'cpfl.featurePolicyId',
  },
  configurationPolicies: { orgId: 'cp.orgId', name: 'cp.name', status: 'cp.status' },
  devices: {},
  softwareInventory: {},
  softwarePolicies: {
    id: 'sp.id',
    orgId: 'sp.orgId',
    name: 'sp.name',
    mode: 'sp.mode',
    isActive: 'sp.isActive',
    managedByLinkId: 'sp.managedByLinkId',
    approvalGeneration: 'sp.approvalGeneration',
  },
}));

vi.mock('./softwarePolicyService', () => ({
  recordSoftwarePolicyAudit: vi.fn(() => Promise.resolve()),
}));

import { db } from '../db';
import { recordSoftwarePolicyAudit } from './softwarePolicyService';
import {
  approveInventorySoftware,
  clearInventorySoftware,
  denyInventorySoftware,
  FOREIGN_DEFAULT_CONFIG_LINK_ERROR,
} from './softwareInventoryPolicy';

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const auth = { scope: 'organization', orgId: ORG } as any;

/** select().from().where()[.limit()].for() chain; records the .for() lock mode. */
function mockLockedSelect(rows: any[], forSpy: ReturnType<typeof vi.fn>, withLimit = true) {
  forSpy.mockResolvedValueOnce(rows);
  const tail = { for: forSpy };
  vi.mocked(db.select).mockReturnValueOnce({
    from: () => ({ where: () => (withLimit ? { limit: () => tail } : tail) }),
  } as any);
}

/** Plain awaited select().from().where()[.limit()]. */
function mockSelect(rows: any[], withLimit: boolean) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: () => ({ where: () => (withLimit ? { limit: () => Promise.resolve(rows) } : Promise.resolve(rows)) }),
  } as any);
}

describe('softwareInventoryPolicy writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approve locks the default allowlist row FOR UPDATE inside a transaction', async () => {
    const forSpy = vi.fn();
    mockLockedSelect([{ id: 'p1', name: 'Default Allowlist', rules: { software: [] } }], forSpy);
    const set = vi.fn().mockReturnValue({ where: () => Promise.resolve() });
    vi.mocked(db.update).mockReturnValueOnce({ set } as any);
    // ensureDefaultConfigPolicyLink: config policy exists, link + assignment upserts
    mockSelect([{ id: 'cfg-1' }], true);
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(), onConflictDoNothing: () => Promise.resolve() }),
    } as any);
    const audit = vi.fn();

    const result = await approveInventorySoftware({
      auth, orgId: ORG, softwareName: 'Acme', actorUserId: USER, audit,
    });

    expect(result).toEqual({ status: 200, body: { success: true, policyId: 'p1' } });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(forSpy).toHaveBeenCalledWith('update');
    expect(set).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('stamps actorUserId and the actor kind on the software policy audit', async () => {
    mockLockedSelect([], vi.fn());
    vi.mocked(db.insert).mockReturnValueOnce({
      values: () => ({ returning: () => Promise.resolve([{ id: 'p-new', name: 'Default Blocklist' }]) }),
    } as any);
    // ensureDefaultConfigPolicyLink fails: logged; fatal to the answer only for the AI actor
    vi.mocked(db.select).mockImplementationOnce(() => { throw new Error('link boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await denyInventorySoftware({
      auth, orgId: ORG, softwareName: 'Bad', actorUserId: USER, actor: 'ai', audit: vi.fn(),
    });

    // W12 review: the AI caller is told the org link failed (503), while the entry's audit rows are still written.
    expect(result.status).toBe(503);
    expect(recordSoftwarePolicyAudit).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'ai', actorId: USER, policyId: 'p-new', action: 'inventory_deny',
    }));
    warn.mockRestore();
  });

  it('refuseForeignConfigLink: 409 and no write when the default config policy carries other links', async () => {
    mockLockedSelect([{ id: 'p1', name: 'Default Allowlist', rules: { software: [] } }], vi.fn());
    mockSelect([{ id: 'cfg-1' }], true); // the named default config policy
    mockSelect([
      { featureType: 'software_policy', featurePolicyId: 'p1' },
      { featureType: 'patch', featurePolicyId: 'patch-1' },
    ], false);
    const audit = vi.fn();

    const result = await approveInventorySoftware({
      auth, orgId: ORG, softwareName: 'Acme', actorUserId: USER, audit, refuseForeignConfigLink: true,
    });

    expect(result).toEqual({ status: 409, body: { error: FOREIGN_DEFAULT_CONFIG_LINK_ERROR } });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuseForeignConfigLink: 409 when the software_policy link points at another policy', async () => {
    mockLockedSelect([], vi.fn()); // no default blocklist yet
    mockSelect([{ id: 'cfg-1' }], true);
    mockSelect([{ featureType: 'software_policy', featurePolicyId: 'someone-elses' }], false);

    const result = await denyInventorySoftware({
      auth, orgId: ORG, softwareName: 'Bad', actorUserId: USER, audit: vi.fn(), refuseForeignConfigLink: true,
    });

    expect(result.status).toBe(409);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuseForeignConfigLink: proceeds when the config policy holds only this flow\'s link', async () => {
    mockLockedSelect([{ id: 'p1', name: 'Default Allowlist', rules: { software: [{ name: 'Acme' }] } }], vi.fn());
    mockSelect([{ id: 'cfg-1' }], true);
    mockSelect([{ featureType: 'software_policy', featurePolicyId: 'p1' }], false);
    mockSelect([{ id: 'cfg-1' }], true); // ensureDefaultConfigPolicyLink lookup
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(), onConflictDoNothing: () => Promise.resolve() }),
    } as any);

    const result = await approveInventorySoftware({
      auth, orgId: ORG, softwareName: 'Acme', actorUserId: USER, audit: vi.fn(), refuseForeignConfigLink: true,
    });

    expect(result).toEqual({ status: 200, body: { success: true, policyId: 'p1' } });
    expect(db.update).not.toHaveBeenCalled(); // already present, rules unchanged
  });

  it('clear locks both default rows FOR UPDATE and reports cleared', async () => {
    const forSpy = vi.fn();
    mockLockedSelect([
      { id: 'a', name: 'Default Allowlist', mode: 'allowlist', rules: { software: [{ name: 'Acme' }] } },
      { id: 'b', name: 'Default Blocklist', mode: 'blocklist', rules: { software: [] } },
    ], forSpy, false);
    vi.mocked(db.update).mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) } as any);
    const audit = vi.fn();

    const result = await clearInventorySoftware({
      auth, orgId: ORG, softwareName: 'acme', actorUserId: USER, audit,
    });

    expect(result).toEqual({ status: 200, body: { success: true, cleared: true } });
    expect(forSpy).toHaveBeenCalledWith('update');
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(recordSoftwarePolicyAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: 'user', actorId: USER }));
  });
});
