import { describe, expect, it } from 'vitest';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sites } from '../../db/schema';
import { HIDDEN_ORG_TYPES, isHiddenOrgType, notHiddenOrgType, notInHiddenOrgCondition } from './visibility';

describe('hidden org types (visibility)', () => {
  it('hides Quick Support and the holding org, nothing else', () => {
    expect([...HIDDEN_ORG_TYPES].sort()).toEqual(['quick_support', 'unassigned_pool']);
    expect(isHiddenOrgType('quick_support')).toBe(true);
    expect(isHiddenOrgType('unassigned_pool')).toBe(true);
    expect(isHiddenOrgType('customer')).toBe(false);
    expect(isHiddenOrgType(null)).toBe(false);
  });

  it('notHiddenOrgType excludes both types', () => {
    const q = new PgDialect().sqlToQuery(and(notHiddenOrgType())!);
    expect(q.sql).toMatch(/"organizations"\."type" not in \(\$1, \$2\)/);
    expect(q.params).toEqual(['quick_support', 'unassigned_pool']);
  });

  it('notInHiddenOrgCondition excludes rows of either hidden org by org id', () => {
    const q = new PgDialect().sqlToQuery(notInHiddenOrgCondition(sites.orgId));
    expect(q.sql).toContain(`hidden_org.id = "sites"."org_id" AND hidden_org.type IN ('quick_support', 'unassigned_pool')`);
  });
});
