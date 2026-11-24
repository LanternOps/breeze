/**
 * The read predicate for MSP-managed (partner-owned) configuration policies
 * (#12462 W03a, plan D13/D14).
 *
 * Compiled SQL, not a Drizzle mock: every rule here lives inside a `.where()`
 * argument, which the repo's chainable mocks never inspect. The real
 * correlated EXISTS runs on Postgres in
 * `__tests__/integration/configPolicyReadScope.integration.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));

import { configurationPolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import {
  policyAccessCondition,
  policyAppliesToOrgsSql,
  policyReadCondition,
  policyViewerAccess,
} from './configPolicyReadScope';

const dialect = new PgDialect();
const render = (cond: SQL | undefined) => (cond ? dialect.sqlToQuery(cond) : undefined);

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeAuth(overrides: Partial<AuthContext> & Pick<AuthContext, 'scope'>): AuthContext {
  const accessibleOrgIds = overrides.accessibleOrgIds === undefined ? [ORG_A] : overrides.accessibleOrgIds;
  const orgCondition = (col: PgColumn): SQL | undefined => {
    if (accessibleOrgIds === null) return undefined;
    if (accessibleOrgIds.length === 0) return sql`false`;
    if (accessibleOrgIds.length === 1) return eq(col, accessibleOrgIds[0]!);
    return inArray(col, accessibleOrgIds);
  };
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u-1', email: 'u@example.test', name: 'U', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: null,
    accessibleOrgIds,
    orgCondition,
    canAccessOrg: (id: string) => accessibleOrgIds === null || accessibleOrgIds.includes(id),
    ...overrides,
  } as AuthContext;
}

const systemAuth = () => makeAuth({ scope: 'system', partnerId: null, accessibleOrgIds: null });
const fullPartner = () => makeAuth({ scope: 'partner', partnerOrgAccess: 'all', accessibleOrgIds: [ORG_A, ORG_B] });
const limitedPartner = () => makeAuth({ scope: 'partner', partnerOrgAccess: 'selected', accessibleOrgIds: [ORG_A] });
const orgUser = () => makeAuth({ scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A] });

/** The pre-W03a policyAccessCondition, verbatim, for the characterization cases. */
function legacyAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (!orgCond) return undefined;
  if (auth.scope === 'partner' && auth.partnerId) {
    return and(
      sql`(${orgCond} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${auth.partnerId}))`,
    );
  }
  return orgCond;
}

describe('policyReadCondition leaves full-access partners and system unchanged', () => {
  it('system scope has no filter, on both readers', () => {
    expect(policyReadCondition(systemAuth())).toBeUndefined();
    expect(policyAccessCondition(systemAuth())).toBeUndefined();
  });

  it('a full-access partner reads every policy of its partner, exactly as before', () => {
    const auth = fullPartner();
    const legacy = render(legacyAccessCondition(auth));
    expect(render(policyAccessCondition(auth))).toEqual(legacy);
    expect(render(policyReadCondition(auth))).toEqual(legacy);
  });

  it('an org-scope caller keeps the write-side reader it has today: its own org only', () => {
    const auth = orgUser();
    expect(render(policyAccessCondition(auth))).toEqual(render(legacyAccessCondition(auth)));
    expect(render(policyAccessCondition(auth))!.sql).not.toContain('IS NULL');
  });

  it('a partner context that never resolved a membership (an MCP key) is treated as limited', () => {
    const auth = makeAuth({ scope: 'partner', partnerOrgAccess: undefined, accessibleOrgIds: [ORG_A] });
    expect(render(policyReadCondition(auth))!.sql).toContain('EXISTS');
    expect(render(policyAccessCondition(auth))!.sql).toContain('EXISTS');
  });
});

describe("an org-scope caller's condition admits partner-owned rows only through the applies-to clause", () => {
  it('ORs its own org with partner-owned rows that apply to it', () => {
    const q = render(policyReadCondition(orgUser()))!;
    expect(q.sql).toContain('"configuration_policies"."org_id" = $1');
    expect(q.params[0]).toBe(ORG_A);
    expect(q.sql).toMatch(/"configuration_policies"\."org_id" IS NULL AND "configuration_policies"\."partner_id" = \$\d+ AND/);
    expect(q.params).toContain(PARTNER);
    // The partner-owned branch never stands alone: it is ANDed with the EXISTS.
    expect(q.sql).toContain('EXISTS (SELECT 1 FROM "config_policy_assignments"');
    expect(q.sql).not.toMatch(/IS NULL AND "configuration_policies"\."partner_id" = \$\d+\)\)/);
  });

  it('an org token without a partner reads only its own org', () => {
    const auth = makeAuth({ scope: 'organization', orgId: ORG_A, partnerId: null, accessibleOrgIds: [ORG_A] });
    expect(render(policyReadCondition(auth))).toEqual(render(eq(configurationPolicies.orgId, ORG_A)));
  });
});

describe("a limited partner caller's condition uses its accessible org ids", () => {
  it('narrows partner-owned rows to those that apply to an accessible org, on both readers', () => {
    const auth = limitedPartner();
    const read = render(policyReadCondition(auth))!;
    expect(read).toEqual(render(policyAccessCondition(auth)));
    expect(read.sql).toContain('EXISTS');
    // Org B is not accessible and must not appear anywhere in the predicate.
    expect(read.params).not.toContain(ORG_B);
    expect(read.params).toContain(ORG_A);
  });

  it('a partner caller with no accessible org reads no partner-owned row', () => {
    const auth = makeAuth({ scope: 'partner', partnerOrgAccess: 'none', accessibleOrgIds: [] });
    const q = render(policyReadCondition(auth))!;
    expect(q.sql).toContain('false');
    expect(q.sql).not.toContain('EXISTS');
  });
});

describe('policyAppliesToOrgsSql covers the five D14 clauses', () => {
  const q = dialect.sqlToQuery(policyAppliesToOrgsSql([ORG_A], PARTNER));
  const s = q.sql;

  it('correlates every clause to the outer policy row', () => {
    expect(s).toContain('"rs_a"."config_policy_id" = "configuration_policies"."id"');
  });

  it('1. a partner-level row of its own partner, for an accessible org of that partner outside the holding pool', () => {
    expect(s).toContain(`"rs_a"."level" = 'partner'`);
    expect(s).toContain('"rs_a"."target_id" = "configuration_policies"."partner_id"');
    expect(s).toMatch(/"rs_o"\."id" in \(\$\d+\)/);
    expect(s).toContain('"rs_o"."partner_id" = "configuration_policies"."partner_id"');
    expect(s).toContain('"rs_o"."type" <> ');
    expect(q.params).toContain('unassigned_pool');
  });

  it('2. an organization row naming the org', () => {
    expect(s).toMatch(/"rs_a"\."level" = 'organization' AND "rs_a"\."target_id" in \(\$\d+\)/);
  });

  it('3. a site, a device or an org-owned device group in the org', () => {
    expect(s).toMatch(/"rs_a"\."level" = 'site' AND EXISTS \(SELECT 1 FROM "sites" "rs_s" WHERE "rs_s"\."id" = "rs_a"\."target_id" AND "rs_s"\."org_id" in/);
    expect(s).toMatch(/"rs_a"\."level" = 'device' AND EXISTS \(SELECT 1 FROM "devices" "rs_d" WHERE "rs_d"\."id" = "rs_a"\."target_id" AND "rs_d"\."org_id" in/);
    expect(s).toMatch(/"rs_a"\."level" = 'device_group' AND \(EXISTS \(SELECT 1 FROM "device_groups" "rs_g" WHERE "rs_g"\."id" = "rs_a"\."target_id" AND "rs_g"\."org_id" in/);
  });

  it('4. a partner-owned device group with a member in the org, read through the membership org (no group row needed)', () => {
    expect(s).toMatch(/EXISTS \(SELECT 1 FROM "device_group_memberships" "rs_m" WHERE "rs_m"\."group_id" = "rs_a"\."target_id" AND "rs_m"\."org_id" in/);
  });

  it('5. the parent of a policy that applies: an org-owned child in the org, or a partner-owned child that applies directly', () => {
    expect(s).toContain('FROM "configuration_policies" "rs_child" WHERE "rs_child"."parent_policy_id" = "configuration_policies"."id"');
    expect(s).toMatch(/"rs_child"\."org_id" in \(\$\d+\)/);
    expect(s).toContain('"rs_child"."org_id" IS NULL');
    expect(s).toContain('"rs_ca"."config_policy_id" = "rs_child"."id"');
  });

  it('binds only the given orgs and partner', () => {
    expect(q.params).toContain(ORG_A);
    expect(q.params).toContain(PARTNER);
    expect(q.params).not.toContain(ORG_B);
  });

  it('applies to nothing for an empty org list', () => {
    expect(dialect.sqlToQuery(policyAppliesToOrgsSql([], PARTNER)).sql).toBe('false');
  });
});

describe('policyViewerAccess explains read-only for limited and org callers, and for a site-restricted caller', () => {
  const msp = { orgId: null };
  const own = { orgId: ORG_A };

  it('full-access partners and system can edit either owner', () => {
    expect(policyViewerAccess(fullPartner(), msp)).toEqual({ canEdit: true, reason: null });
    expect(policyViewerAccess(systemAuth(), msp)).toEqual({ canEdit: true, reason: null });
    expect(policyViewerAccess(fullPartner(), own)).toEqual({ canEdit: true, reason: null });
  });

  it('an org user sees an MSP-managed policy read-only, with its own reason', () => {
    expect(policyViewerAccess(orgUser(), msp)).toEqual({ canEdit: false, reason: 'msp_managed_org_user' });
    expect(policyViewerAccess(orgUser(), own)).toEqual({ canEdit: true, reason: null });
  });

  it('a limited partner sees an MSP-managed policy read-only', () => {
    expect(policyViewerAccess(limitedPartner(), msp)).toEqual({ canEdit: false, reason: 'msp_managed_limited_access' });
    expect(policyViewerAccess(limitedPartner(), own)).toEqual({ canEdit: true, reason: null });
  });

  it('a site-restricted caller cannot edit even its own org policy', () => {
    const auth = makeAuth({ scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A], allowedSiteIds: ['site-1'] });
    expect(policyViewerAccess(auth, own)).toEqual({ canEdit: false, reason: 'site_restricted' });
    // The MSP reason wins: it is the one the caller can act on (ask the MSP).
    expect(policyViewerAccess(auth, msp)).toEqual({ canEdit: false, reason: 'msp_managed_org_user' });
  });
});
