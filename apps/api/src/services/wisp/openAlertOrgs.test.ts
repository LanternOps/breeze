/**
 * #10406 — `orgsWithOpenAlerts`: which ceiling orgs an on-demand assessment
 * covers. The db is a chain recorder; the SQL the mock cannot evaluate is
 * asserted on its PgDialect rendering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[]; inSystem: boolean }>,
  rows: [] as unknown[],
  inSystem: false,
}));

vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'from', 'innerJoin', 'where', 'groupBy', 'orderBy']) {
    chain[method] = (...args: unknown[]) => {
      h.calls.push({ method, args, inSystem: h.inSystem });
      return chain;
    };
  }
  chain.limit = (...args: unknown[]) => {
    h.calls.push({ method: 'limit', args, inSystem: h.inSystem });
    return Promise.resolve(h.rows);
  };
  return {
    db: chain,
    runOutsideDbContext: <T>(fn: () => T) => fn(),
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => {
      h.inSystem = true;
      try { return await fn(); } finally { h.inSystem = false; }
    },
  };
});

import { ONBOARDING_ORG_LIMIT } from './assessableOrgs';
import { orgsWithOpenAlerts } from './openAlertOrgs';

const O1 = '00000000-0000-4000-8000-0000000000b1';
const O2 = '00000000-0000-4000-8000-0000000000b2';
const dialect = new PgDialect();
const compile = (q: unknown) => dialect.sqlToQuery(q as SQL);
const call = (method: string) => h.calls.find((c) => c.method === method)!;

beforeEach(() => {
  h.calls = [];
  h.rows = [];
  h.inSystem = false;
});

describe('orgsWithOpenAlerts (#10406)', () => {
  it('reads nothing for an empty org list or a zero limit', async () => {
    await expect(orgsWithOpenAlerts([], ONBOARDING_ORG_LIMIT)).resolves.toEqual([]);
    await expect(orgsWithOpenAlerts([O1], 0)).resolves.toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('groups the open (active / acknowledged) alerts of the given orgs, in a system context', async () => {
    h.rows = [{ orgId: O2, orgName: 'Beta' }, { orgId: O1, orgName: 'Alpha' }];
    await expect(orgsWithOpenAlerts([O1, O2], ONBOARDING_ORG_LIMIT)).resolves.toEqual([
      { orgId: O2, orgName: 'Beta' },
      { orgId: O1, orgName: 'Alpha' },
    ]);
    expect(h.calls.every((c) => c.inSystem)).toBe(true);

    const where = compile(call('where').args[0]);
    expect(where.sql).toMatch(/"alerts"\."org_id" in \(\$\d+, \$\d+\)/);
    expect(where.sql).toMatch(/"alerts"\."status" in \(\$\d+, \$\d+\)/);
    expect(where.params).toEqual(expect.arrayContaining([O1, O2, 'active', 'acknowledged']));
    expect(where.params).not.toContain('resolved');

    // The org's name comes from the organizations row it groups on.
    expect(compile(call('innerJoin').args[1]).sql).toBe('"organizations"."id" = "alerts"."org_id"');
    expect(call('groupBy').args.map((a) => compile(sql`${a}`).sql)).toEqual(['"alerts"."org_id"', '"organizations"."name"']);
  });

  it('orders by the worst open severity, then the open count, then the name, and stops at the limit', async () => {
    await orgsWithOpenAlerts([O1, O2], ONBOARDING_ORG_LIMIT);
    // The severity enum is declared critical → info, so min() is the worst.
    expect(call('orderBy').args.map((a) => compile(a).sql)).toEqual([
      'min("alerts"."severity") asc',
      'count("alerts"."id") desc',
      '"organizations"."name" asc',
      '"alerts"."org_id" asc',
    ]);
    expect(call('limit').args[0]).toBe(10);
  });
});
