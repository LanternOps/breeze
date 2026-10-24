import { describe, expect, it } from 'vitest';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { partnerVisibleOrgConditions } from './partnerVisibleOrgs';

const dialect = new PgDialect();
const compile = (ids: readonly string[]) => dialect.sqlToQuery(and(...partnerVisibleOrgConditions(ids))!);

describe('partnerVisibleOrgConditions', () => {
  it('empty ids match nothing', () => {
    const { sql: text, params } = compile([]);
    expect(text).toBe('false');
    expect(params).toEqual([]);
  });

  it('same predicates as the list route: accessible ids, no hidden org types, not deleted', () => {
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const { sql: text, params } = compile(ids);
    expect(text).toMatchInlineSnapshot(`"("organizations"."id" in ($1, $2) and "organizations"."type" not in ($3, $4) and "organizations"."deleted_at" is null)"`);
    expect(params).toEqual([...ids, 'quick_support', 'unassigned_pool']);
  });

  it('never carries a search, status or pagination term', () => {
    const { sql: text } = compile(['00000000-0000-4000-8000-000000000001']);
    expect(text).not.toMatch(/ilike|status|limit|offset/i);
  });
});
