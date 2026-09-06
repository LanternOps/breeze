/**
 * Service-layer unit tests for one-level configuration-policy inheritance
 * (#5080 W01).
 *
 * These pin BEHAVIOUR against a fully mocked `db`: which error class is thrown,
 * what reaches `insert(...).values(...)`, and the shape `getConfigPolicy`
 * returns. The tenancy guarantees themselves are database-enforced and proved
 * against real Postgres in
 * `__tests__/integration/configPolicyInheritance.integration.test.ts` — a mock
 * can only show the service asks the right questions, never that the answers
 * are enforced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import {
  createConfigPolicy,
  deleteConfigPolicy,
  getConfigPolicy,
  getParentLinkFeatureTypes,
  listEligibleParentPolicies,
  InvalidParentPolicyError,
  PolicyHasChildrenError,
} from './configurationPolicy';
import { db } from '../db';

const ORG = '00000000-0000-4000-8000-00000000o001'.replace(/o/g, '0');
const ORG2 = '00000000-0000-4000-8000-000000000002';
const PARTNER = '00000000-0000-4000-8000-0000000000b1';
const PARTNER2 = '00000000-0000-4000-8000-0000000000b2';
const PARENT = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000e1';

/** `db.select(...).from(...).where(...).limit(...)` */
function selectLimit(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** `db.select(...).from(...).where(...)` awaited directly */
function selectWhere(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** `db.select(...).from(...).where(...).orderBy(...)` */
function selectOrderBy(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** `db.select(...).from(...).leftJoin(...).where(...).limit(...)` */
function selectJoinLimit(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function insertReturning(rows: unknown[], captured: { values?: Record<string, unknown> }) {
  return vi.fn(() => ({
    values: vi.fn((v: Record<string, unknown>) => {
      captured.values = v;
      return { returning: vi.fn(() => Promise.resolve(rows)) };
    }),
  }));
}

function insertThrows(err: unknown) {
  return vi.fn(() => ({
    values: vi.fn(() => ({ returning: vi.fn(() => Promise.reject(err)) })),
  }));
}

/** A postgres.js-shaped error nested behind a DrizzleQueryError-shaped wrapper. */
function pgError(code: string, constraintName: string) {
  const inner = Object.assign(new Error(`db said ${code}`), { code, constraint_name: constraintName });
  return Object.assign(new Error('Failed query'), { cause: inner });
}

/** Wire `db.transaction(cb)` to invoke `cb` with a tx exposing these members. */
function mockTransaction(tx: Record<string, unknown>) {
  vi.mocked(db.transaction).mockImplementation(
    (async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as never,
  );
}

const orgAuth = (): never =>
  ({
    scope: 'organization',
    orgId: ORG,
    partnerId: PARTNER,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    user: { id: USER },
  }) as never;

const partnerAuth = (partnerId: string | null = PARTNER): never =>
  ({
    scope: 'partner',
    orgId: null,
    partnerId,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    user: { id: USER },
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createConfigPolicy with parentPolicyId', () => {
  it('creates without a transaction when no parent is named', async () => {
    const captured: { values?: Record<string, unknown> } = {};
    vi.mocked(db.insert).mockImplementation(insertReturning([{ id: 'p1' }], captured) as never);

    await createConfigPolicy({ orgId: ORG }, { name: 'root' }, USER);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(captured.values?.parentPolicyId).toBeNull();
  });

  it('inserts parentPolicyId when the parent is a compatible same-org root', async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: ORG, partnerId: null, parentPolicyId: null }]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: insertReturning([{ id: 'child', parentPolicyId: PARENT }], captured),
    };
    mockTransaction(tx);

    const policy = await createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER);

    expect(captured.values?.parentPolicyId).toBe(PARENT);
    expect(policy).toEqual({ id: 'child', parentPolicyId: PARENT });
  });

  it('accepts a partner-wide parent of the child org\'s own partner', async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: null, partnerId: PARTNER, parentPolicyId: null }]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: insertReturning([{ id: 'child' }], captured),
    };
    mockTransaction(tx);

    await createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER);

    expect(captured.values?.parentPolicyId).toBe(PARENT);
  });

  it('throws InvalidParentPolicyError when the parent is not visible', async () => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: vi.fn(),
    };
    mockTransaction(tx);

    await expect(
      createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('throws InvalidParentPolicyError when the parent belongs to another org', async () => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: ORG2, partnerId: null, parentPolicyId: null }]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: vi.fn(),
    };
    mockTransaction(tx);

    await expect(
      createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('throws InvalidParentPolicyError for another partner\'s partner-wide parent', async () => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: null, partnerId: PARTNER2, parentPolicyId: null }]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: vi.fn(),
    };
    mockTransaction(tx);

    await expect(
      createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  it('throws InvalidParentPolicyError when the parent itself has a parent', async () => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: ORG, partnerId: null, parentPolicyId: 'grand' }]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: vi.fn(),
    };
    mockTransaction(tx);

    await expect(
      createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  it('rejects an org-owned parent for a partner-wide child', async () => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: ORG, partnerId: null, parentPolicyId: null }])),
      insert: vi.fn(),
    };
    mockTransaction(tx);

    await expect(
      createConfigPolicy({ partnerId: PARTNER }, { name: 'child', parentPolicyId: PARENT }, USER),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  // The app-layer check can pass and the insert still fail: the parent was
  // deleted in between (FK), or the constraint trigger disagreed. Both must
  // surface as the same 400, never as a 500.
  it.each([
    ['23503', 'configuration_policies_parent_policy_id_fkey'],
    ['23514', 'configuration_policies_parent_guard'],
    ['23514', 'configuration_policies_not_own_parent_chk'],
  ])('maps a %s on %s to InvalidParentPolicyError', async (code, constraint) => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: ORG, partnerId: null, parentPolicyId: null }]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: insertThrows(pgError(code, constraint)),
    };
    mockTransaction(tx);

    await expect(
      createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  it('does NOT swallow an unrelated constraint violation', async () => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce(selectLimit([{ id: PARENT, orgId: ORG, partnerId: null, parentPolicyId: null }]))
        .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }])),
      insert: insertThrows(pgError('23514', 'configuration_policies_one_owner_chk')),
    };
    mockTransaction(tx);

    await expect(
      createConfigPolicy({ orgId: ORG }, { name: 'child', parentPolicyId: PARENT }, USER),
    ).rejects.not.toBeInstanceOf(InvalidParentPolicyError);
  });
});

describe('deleteConfigPolicy with children', () => {
  it('throws PolicyHasChildrenError naming the children, without deleting', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimit([{ orgId: ORG }]) as never)
      .mockReturnValueOnce(selectWhere([{ id: 'c1', name: 'Child One' }]) as never);

    const err = await deleteConfigPolicy(PARENT, orgAuth()).catch((e) => e);

    expect(err).toBeInstanceOf(PolicyHasChildrenError);
    expect((err as PolicyHasChildrenError).children).toEqual([{ id: 'c1', name: 'Child One' }]);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('deletes normally when there are no children', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimit([{ orgId: ORG }]) as never)
      .mockReturnValueOnce(selectWhere([]) as never);
    const del: Record<string, unknown> = {};
    del.where = vi.fn(() => del);
    del.returning = vi.fn(() => Promise.resolve([{ id: PARENT, orgId: ORG, name: 'Gone' }]));
    vi.mocked(db.delete).mockReturnValue(del as never);

    await expect(deleteConfigPolicy(PARENT, orgAuth())).resolves.toMatchObject({ id: PARENT });
  });

  it('maps a self-FK 23503 raced in after the check to PolicyHasChildrenError', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimit([{ orgId: ORG }]) as never)
      .mockReturnValueOnce(selectWhere([]) as never);
    const del: Record<string, unknown> = {};
    del.where = vi.fn(() => del);
    del.returning = vi.fn(() =>
      Promise.reject(pgError('23503', 'configuration_policies_parent_policy_id_fkey')));
    vi.mocked(db.delete).mockReturnValue(del as never);

    const err = await deleteConfigPolicy(PARENT, orgAuth()).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyHasChildrenError);
    expect((err as PolicyHasChildrenError).children).toEqual([]);
  });

  it('does NOT map an unrelated 23503 to PolicyHasChildrenError', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimit([{ orgId: ORG }]) as never)
      .mockReturnValueOnce(selectWhere([]) as never);
    const del: Record<string, unknown> = {};
    del.where = vi.fn(() => del);
    del.returning = vi.fn(() => Promise.reject(pgError('23503', 'some_other_fkey')));
    vi.mocked(db.delete).mockReturnValue(del as never);

    await expect(deleteConfigPolicy(PARENT, orgAuth())).rejects.not.toBeInstanceOf(PolicyHasChildrenError);
  });
});

describe('getConfigPolicy inheritance embeds', () => {
  it('embeds the parent with its assembled links, plus the children list', async () => {
    vi.mocked(db.select)
      // the policy itself
      .mockReturnValueOnce(selectJoinLimit([{ id: 'child', orgId: ORG, parentPolicyId: PARENT }]) as never)
      // listFeatureLinks(child) — own links
      .mockReturnValueOnce(selectWhere([]) as never)
      // the parent row (no policyAccessCondition)
      .mockReturnValueOnce(selectLimit([{ id: PARENT, name: 'Baseline', status: 'active', orgId: null }]) as never)
      // listFeatureLinks(parent)
      .mockReturnValueOnce(selectWhere([
        { id: 'plink', configPolicyId: PARENT, featureType: 'event_log', inlineSettings: { a: 1 } },
      ]) as never)
      // assembleInlineSettings for the parent's event_log link
      .mockReturnValueOnce(selectLimit([]) as never)
      // childPolicies
      .mockReturnValueOnce(selectOrderBy([]) as never);

    const result = await getConfigPolicy('child', orgAuth());

    expect(result?.parentPolicy).toMatchObject({ id: PARENT, name: 'Baseline', orgId: null });
    expect(result?.parentPolicy?.featureLinks).toHaveLength(1);
    // The editor must still see only the policy's OWN links as authored.
    expect(result?.featureLinks).toEqual([]);
    expect(result?.childPolicies).toEqual([]);
  });

  it('returns parentPolicy null and childPolicies for a root policy', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectJoinLimit([{ id: PARENT, orgId: ORG, parentPolicyId: null }]) as never)
      .mockReturnValueOnce(selectWhere([]) as never)
      .mockReturnValueOnce(selectOrderBy([{ id: 'c1', name: 'Child One' }]) as never);

    const result = await getConfigPolicy(PARENT, orgAuth());

    expect(result?.parentPolicy).toBeNull();
    expect(result?.childPolicies).toEqual([{ id: 'c1', name: 'Child One' }]);
  });

  it('returns null (not a crash) when the policy is not visible', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectJoinLimit([]) as never);
    await expect(getConfigPolicy('nope', orgAuth())).resolves.toBeNull();
  });
});

describe('listEligibleParentPolicies', () => {
  it('organization scope: labels org-owned vs partner-wide rows', async () => {
    vi.mocked(db.select)
      // organizations lookup for the org's partner
      .mockReturnValueOnce(selectLimit([{ partnerId: PARTNER }]) as never)
      .mockReturnValueOnce(selectOrderBy([
        { id: 'a', name: 'Org baseline', orgId: ORG },
        { id: 'b', name: 'MSP baseline', orgId: null },
      ]) as never);

    await expect(listEligibleParentPolicies(orgAuth(), { ownerScope: 'organization', orgId: ORG }))
      .resolves.toEqual([
        { id: 'a', name: 'Org baseline', ownerScope: 'organization' },
        { id: 'b', name: 'MSP baseline', ownerScope: 'partner' },
      ]);
  });

  it('organization scope: an org with no partner still lists its own roots', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimit([{ partnerId: null }]) as never)
      .mockReturnValueOnce(selectOrderBy([{ id: 'a', name: 'Org baseline', orgId: ORG }]) as never);

    await expect(listEligibleParentPolicies(orgAuth(), { ownerScope: 'organization', orgId: ORG }))
      .resolves.toEqual([{ id: 'a', name: 'Org baseline', ownerScope: 'organization' }]);
  });

  it('partner scope: returns partner-wide roots of the caller partner', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectOrderBy([
      { id: 'b', name: 'MSP baseline', orgId: null },
    ]) as never);

    await expect(listEligibleParentPolicies(partnerAuth(), { ownerScope: 'partner' }))
      .resolves.toEqual([{ id: 'b', name: 'MSP baseline', ownerScope: 'partner' }]);
  });

  it('partner scope with no partner on the token returns nothing and queries nothing', async () => {
    await expect(listEligibleParentPolicies(partnerAuth(null), { ownerScope: 'partner' })).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('getParentLinkFeatureTypes', () => {
  it('returns the parent\'s linked feature types', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectWhere([
      { featureType: 'maintenance' },
      { featureType: 'event_log' },
    ]) as never);

    await expect(getParentLinkFeatureTypes(PARENT)).resolves.toEqual(['maintenance', 'event_log']);
  });
});
