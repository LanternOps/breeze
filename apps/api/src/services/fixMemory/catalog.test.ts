import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { scriptVisibilityCondition } from './catalog';

const dialect = new PgDialect();
const compile = (ctx: Parameters<typeof scriptVisibilityCondition>[0]) => dialect.sqlToQuery(scriptVisibilityCondition(ctx));

describe('scriptVisibilityCondition', () => {
  it('includes the org’s partner-wide scripts (the pre-W1 matcher missed them)', () => {
    const q = compile({ orgId: 'org-1', partnerId: 'p-1', deviceOs: 'linux' });
    expect(q.sql).toContain('"scripts"."partner_id" = $');
    expect(q.params).toEqual(expect.arrayContaining(['org-1', 'p-1', 'linux']));
  });
  it('has no partner branch when the org’s partner is unknown', () => {
    const q = compile({ orgId: 'org-1', partnerId: null, deviceOs: null });
    expect(q.sql).not.toContain('"scripts"."partner_id"');
    expect(q.sql).not.toContain('@>');
  });
});
