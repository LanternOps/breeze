import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { loadMappableOrgs } from './mappableOrgs';

const dialect = new PgDialect();
const PARTNER = '00000000-0000-4000-8000-0000000000a1';

function fakeExecutor(rows: unknown[]) {
  let where: unknown;
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn((w: unknown) => { where = w; return Promise.resolve(rows); });
  const executor = { select: vi.fn(() => chain) };
  return { executor, getWhere: () => where };
}

describe('loadMappableOrgs', () => {
  it('returns the rows and carries all six mappable-org conditions in the where clause', async () => {
    const rows = [{ id: 'o1', name: 'Acme' }];
    const { executor, getWhere } = fakeExecutor(rows);
    const result = await loadMappableOrgs(executor as never, PARTNER);
    expect(result).toBe(rows);

    const q = dialect.sqlToQuery(getWhere() as SQL);
    const sql = q.sql.replace(/\s+/g, ' ');
    // 1. partner match
    expect(sql).toContain('"organizations"."partner_id" = $1');
    expect(q.params).toContain(PARTNER);
    // 2-3. live, not archived
    expect(sql).toContain('"organizations"."deleted_at" is null');
    expect(sql).toContain('"organizations"."archived_at" is null');
    // 4. lifecycle status
    expect(sql).toContain(`"organizations"."status" NOT IN ('archived','purging','merging')`);
    // 6. holding org
    expect(sql).toContain(`"organizations"."type" <> 'unassigned_pool'`);
    // 5. notHiddenOrgType(): Quick Support (and the holding org) as a NOT IN list
    expect(sql).toMatch(/"organizations"\."type" not in \(\$\d+, \$\d+\)/);
    expect(q.params).toEqual(expect.arrayContaining(['quick_support', 'unassigned_pool']));
  });
});
