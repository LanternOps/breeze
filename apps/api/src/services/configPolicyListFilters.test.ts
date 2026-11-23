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

  it('returns every policy the org owns, of any status, whether or not it applies anywhere (#12567)', () => {
    // The org's own policies are a bare OR branch: no applies or status test on them.
    expect(q.sql).toMatch(/^\("configuration_policies"\."org_id" = \$1 OR \("configuration_policies"\."org_id" is null AND "configuration_policies"\."partner_id" = \$2 AND \(/);
    expect(q.params[0]).toBe(ORG);
    expect(q.params[1]).toBe(PARTNER);
  });

  it("returns the partner's MSP-managed policies that apply to the org, plus unassigned inactive ones (Q3)", () => {
    // Applies: the D14 clauses, bound to this one org.
    expect(q.sql).toContain('"rs_a"."config_policy_id" = "configuration_policies"."id"');
    // Or inactive and applying nowhere: no assignment and no child.
    expect(q.sql).toMatch(/"configuration_policies"\."status" = 'inactive' AND \(NOT EXISTS \(SELECT 1 FROM "config_policy_assignments" "lf_a"/);
    expect(q.sql).toContain('NOT EXISTS (SELECT 1 FROM "configuration_policies" "lf_child"');
  });

  it("fails closed when the org has no visible partner: the org's own policies only", () => {
    const closed = dialect.sqlToQuery(appliesToOrgCondition(ORG, null));
    expect(closed.sql).toBe('"configuration_policies"."org_id" = $1');
    expect(closed.params).toEqual([ORG]);
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
