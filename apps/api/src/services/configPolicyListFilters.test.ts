/**
 * The list filters of GET /configuration-policies (#12462 W03a, plan S4).
 * Compiled SQL is pinned here; the rows each filter returns are proven on
 * Postgres in __tests__/integration/configPolicyReadScope.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));

import { appliesToOrgCondition, notAppliedCondition } from './configPolicyListFilters';

const dialect = new PgDialect();
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER = '11111111-1111-4111-8111-111111111111';

describe('appliesToOrgCondition', () => {
  const q = dialect.sqlToQuery(appliesToOrgCondition(ORG, PARTNER));

  it("returns applying policies plus unassigned inactive ones, owned by the org or the org's partner", () => {
    expect(q.sql).toMatch(/^\(\("configuration_policies"\."org_id" = \$\d+ or \("configuration_policies"\."org_id" is null and "configuration_policies"\."partner_id" = \$\d+\)\) AND/);
    // Applies: the D14 clauses, bound to this one org.
    expect(q.sql).toContain('"rs_a"."config_policy_id" = "configuration_policies"."id"');
    // Or inactive and applying nowhere: no assignment and no child.
    expect(q.sql).toMatch(/"configuration_policies"\."status" = 'inactive' AND \(NOT EXISTS \(SELECT 1 FROM "config_policy_assignments" "lf_a"/);
    expect(q.sql).toContain('NOT EXISTS (SELECT 1 FROM "configuration_policies" "lf_child"');
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(PARTNER);
  });

  it('fails closed when the org has no visible partner: org-owned policies of that org only', () => {
    const closed = dialect.sqlToQuery(appliesToOrgCondition(ORG, null));
    expect(closed.sql).not.toContain('"configuration_policies"."org_id" is null');
    expect(closed.sql).not.toContain('"rs_child"."org_id" IS NULL');
    expect(closed.sql).toMatch(/^\("configuration_policies"\."org_id" = \$1 AND/);
  });
});

describe('notAppliedCondition', () => {
  it('returns policies with no rows and no children', () => {
    const q = dialect.sqlToQuery(notAppliedCondition());
    expect(q.sql).toBe(
      '(NOT EXISTS (SELECT 1 FROM "config_policy_assignments" "lf_a" WHERE "lf_a"."config_policy_id" = "configuration_policies"."id")'
      + ' AND NOT EXISTS (SELECT 1 FROM "configuration_policies" "lf_child" WHERE "lf_child"."parent_policy_id" = "configuration_policies"."id"))',
    );
  });
});
