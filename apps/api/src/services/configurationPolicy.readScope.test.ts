/**
 * Which reader each configuration-policy service read uses (#12462 W03a, D13).
 *
 * The two readers are replaced with sentinels, and every `.where()` argument
 * the service passes is rendered through PgDialect, so a test fails when a
 * read switches reader. What each reader admits is pinned in
 * configPolicyReadScope.test.ts and, on Postgres, in
 * __tests__/integration/configPolicyReadScope.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { whereArgs, queue } = vi.hoisted(() => ({
  whereArgs: [] as unknown[],
  queue: [] as unknown[][],
}));

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: any = {};
    for (const m of ['from', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'groupBy']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.where = vi.fn((arg: unknown) => {
      whereArgs.push(arg);
      return chain;
    });
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve, reject);
    return chain;
  };
  return {
    db: { select: vi.fn(() => makeChain()) },
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    getCurrentDbAccessContext: vi.fn(() => undefined),
  };
});

vi.mock('./configPolicyReadScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./configPolicyReadScope')>();
  const { sql: s } = await import('drizzle-orm');
  return {
    ...actual,
    policyReadCondition: vi.fn(() => s`READ_SENTINEL`),
    policyAccessCondition: vi.fn(() => s`WRITE_SENTINEL`),
  };
});

import type { AuthContext } from '../middleware/auth';
import {
  getConfigPolicy,
  listConfigPolicies,
  listEligibleParentPolicies,
  previewEffectiveConfig,
  PolicyNotReadableError,
} from './configurationPolicy';
import { readablePolicyIds } from './configPolicyReach';
import { db } from '../db';

const dialect = new PgDialect();
const rendered = () =>
  whereArgs.map((arg) => (arg ? dialect.sqlToQuery(arg as SQL).sql : ''));

const auth = {
  scope: 'organization',
  orgId: 'org-a',
  partnerId: 'partner-1',
  accessibleOrgIds: ['org-a'],
  orgCondition: () => sql`true`,
  canAccessOrg: () => true,
  user: { id: 'u-1' },
} as unknown as AuthContext;

const POLICY = { id: 'p-1', orgId: null, partnerId: 'partner-1', parentPolicyId: null, name: 'Baseline', orgName: null };

beforeEach(() => {
  whereArgs.length = 0;
  queue.length = 0;
});

describe('getConfigPolicy', () => {
  it('defaults to the write-side reader', async () => {
    queue.push([POLICY], [], []);
    await getConfigPolicy('p-1', auth);
    expect(rendered()[0]).toContain('WRITE_SENTINEL');
    expect(rendered()[0]).not.toContain('READ_SENTINEL');
  });

  it("reads with the read predicate when access is 'read'", async () => {
    queue.push([POLICY], [], []);
    await getConfigPolicy('p-1', auth, { access: 'read' });
    expect(rendered()[0]).toContain('READ_SENTINEL');
    expect(rendered()[0]).not.toContain('WRITE_SENTINEL');
  });

  it('the childPolicies embed lists only children the caller may read', async () => {
    queue.push([POLICY], [], []);
    await getConfigPolicy('p-1', auth);
    // policy, feature links, children: the last read is the children embed.
    const children = rendered().at(-1)!;
    expect(children).toContain('"parent_policy_id"');
    expect(children).toContain('READ_SENTINEL');
  });

  it("a write read's children embed uses the read predicate too (it names policies)", async () => {
    queue.push([POLICY], [], []);
    await getConfigPolicy('p-1', auth, { access: 'write' });
    expect(rendered().at(-1)).toContain('READ_SENTINEL');
  });
});

describe('list reads', () => {
  it('listConfigPolicies uses the read predicate', async () => {
    queue.push([{ count: 0 }], []);
    await listConfigPolicies(auth, {}, { page: 1, limit: 25 });
    expect(rendered()[0]).toContain('READ_SENTINEL');
    expect(rendered().join(' ')).not.toContain('WRITE_SENTINEL');
  });

  it('eligible parents use the read predicate (organization owner)', async () => {
    queue.push([{ partnerId: 'partner-1' }], []);
    await listEligibleParentPolicies(auth, { ownerScope: 'organization', orgId: 'org-a' });
    expect(rendered().at(-1)).toContain('READ_SENTINEL');
  });

  it('eligible parents use the read predicate (partner owner)', async () => {
    const partnerAuth = { ...auth, scope: 'partner' } as unknown as AuthContext;
    queue.push([]);
    await listEligibleParentPolicies(partnerAuth, { ownerScope: 'partner' });
    expect(rendered().at(-1)).toContain('READ_SENTINEL');
  });

  it('readablePolicyIds (the reach batch filter) uses the read predicate', async () => {
    queue.push([{ id: 'p-1' }]);
    expect(await readablePolicyIds(auth, ['p-1'])).toEqual(['p-1']);
    expect(rendered()[0]).toContain('READ_SENTINEL');
  });

  it('readablePolicyIds issues no statement for an empty list', async () => {
    vi.mocked(db.select).mockClear();
    expect(await readablePolicyIds(auth, [])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('previewEffectiveConfig', () => {
  it('refuses to preview an added policy the caller may not read, before any read of the device', async () => {
    queue.push([]); // readablePolicyIds: nothing readable
    await expect(previewEffectiveConfig('dev-1', {
      add: [{ configPolicyId: 'hidden', level: 'device', targetId: 'dev-1' }],
    }, auth)).rejects.toBeInstanceOf(PolicyNotReadableError);
    expect(rendered()).toHaveLength(1);
    expect(rendered()[0]).toContain('READ_SENTINEL');
  });
});
