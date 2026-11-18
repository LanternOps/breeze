import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * W5 PR C (#5220), Task C1 — the owner predicate of the flow-tool read,
 * proven on the COMPILED statement (real drizzle `.toSQL()`, no database),
 * the resolver.test.ts pattern. The real-database half is
 * flowToolsRls.integration.test.ts.
 */
vi.mock('../flowValidator', () => ({ stepPinsFor: vi.fn(), FlowStepPinError: class extends Error {} }));

import { buildFlowToolsQuery } from './flowTools';
import { buildKnownFlowSlugsQuery } from './agentFlowTools';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const PARTNER_A = '22222222-2222-4222-8222-222222222222';

function orgAuth(orgId: string): AuthContext {
  return { scope: 'organization', orgId, partnerId: PARTNER_A, user: { id: 'u' }, canAccessOrg: (id: string) => id === orgId } as unknown as AuthContext;
}
function partnerAuth(reach: string[] = [ORG_A]): AuthContext {
  return { scope: 'partner', orgId: null, partnerId: PARTNER_A, user: { id: 'u' }, canAccessOrg: (id: string) => reach.includes(id) } as unknown as AuthContext;
}

describe('buildFlowToolsQuery — owner predicate (DB-less, real toSQL)', () => {
  it('org caller: its own org flows OR partner-wide flows of the org\'s LIVE partner, enabled + manual only', () => {
    const { sql: text, params } = buildFlowToolsQuery(orgAuth(ORG_A), null)!.toSQL();
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(ORG_B);
    expect(params).toContain('enabled');
    expect(params).toContain('manual');
    // The partner id is re-derived from organizations, never auth.partnerId.
    expect(params).not.toContain(PARTNER_A);
    expect(text).toMatch(/"flows"\."org_id" = \$\d+/);
    expect(text).toMatch(/"flows"\."org_id" is null/);
    expect(text).toMatch(/select "organizations"\."partner_id" from "organizations"/);
    expect(text).toMatch(/"flows"\."status" = \$\d+/);
    expect(text).toMatch(/->'trigger'->>'type' = \$\d+/);
    // Live publication only.
    expect(text).toMatch(/"flow_versions"\."publication_seq" = "flows"\."enabled_publication_seq"/);
  });

  it('org caller ignores a targetOrgId of a sibling org', () => {
    const { params } = buildFlowToolsQuery(orgAuth(ORG_A), ORG_B)!.toSQL();
    expect(params).not.toContain(ORG_B);
  });

  it('partner caller without targetOrgId: partner-wide flows only', () => {
    const { sql: text, params } = buildFlowToolsQuery(partnerAuth(), null)!.toSQL();
    expect(params).toContain(PARTNER_A);
    expect(params).not.toContain(ORG_A);
    expect(text).toMatch(/"flows"\."org_id" is null/);
    expect(text).not.toMatch(/"flows"\."org_id" = \$\d+/);
  });

  it('partner caller needs targetOrgId for org flows, and the target org\'s partner is re-derived', () => {
    const { sql: text, params } = buildFlowToolsQuery(partnerAuth([ORG_A]), ORG_A)!.toSQL();
    expect(params).toContain(ORG_A);
    expect(params).toContain(PARTNER_A);
    expect(text).toMatch(/"flows"\."org_id" = \$\d+/);
    expect(text).toMatch(/select "organizations"\."partner_id" from "organizations" where "organizations"\."id" = \$\d+/);
  });

  it('partner caller: a targetOrgId the caller cannot reach adds no org flows', () => {
    const { sql: text, params } = buildFlowToolsQuery(partnerAuth([ORG_A]), ORG_B)!.toSQL();
    expect(params).not.toContain(ORG_B);
    expect(text).not.toMatch(/"flows"\."org_id" = \$\d+/);
  });

  it('the last-run ordering reads runs of the target org only (no cross-org activity signal)', () => {
    const { sql: text, params } = buildFlowToolsQuery(partnerAuth([ORG_A]), ORG_A)!.toSQL();
    expect(text).toMatch(/max\("flow_runs"\."created_at"\)/);
    expect(text).toMatch(/"flow_runs"\."org_id" = \$\d+/);
    expect(params.filter((p) => p === ORG_A).length).toBeGreaterThanOrEqual(2);
    const noTarget = buildFlowToolsQuery(partnerAuth(), null)!.toSQL();
    expect(noTarget.sql).not.toMatch(/max\("flow_runs"\."created_at"\)/);
  });

  it('a slug narrows to one flow; the session cap is the limit', () => {
    const one = buildFlowToolsQuery(orgAuth(ORG_A), null, { slug: 'triage_disk' })!.toSQL();
    expect(one.params).toContain('triage_disk');
    const capped = buildFlowToolsQuery(orgAuth(ORG_A), null, { limit: 20 })!.toSQL();
    expect(capped.sql).toMatch(/limit \$\d+/);
    expect(capped.params).toContain(20);
  });

  it('system scope and scopes missing their id resolve to nothing', () => {
    expect(buildFlowToolsQuery({ scope: 'system', orgId: null, partnerId: null } as unknown as AuthContext, null)).toBeNull();
    expect(buildFlowToolsQuery({ scope: 'organization', orgId: null, partnerId: null } as unknown as AuthContext, null)).toBeNull();
    expect(buildFlowToolsQuery({ scope: 'partner', orgId: null, partnerId: null } as unknown as AuthContext, null)).toBeNull();
  });
});

describe('buildKnownFlowSlugsQuery — the agent-save warning read (W5 PR C)', () => {
  it('an org agent sees its org flows and its LIVE partner\'s partner-wide flows; enabled manual live publications only', () => {
    const { sql: text, params } = buildKnownFlowSlugsQuery({ orgId: ORG_A, partnerId: null }, ['report', 'fixit'])!.toSQL();
    expect(params).toEqual(expect.arrayContaining([ORG_A, 'enabled', 'manual', 'report', 'fixit']));
    expect(params).not.toContain(PARTNER_A);
    expect(text).toMatch(/select "organizations"\."partner_id" from "organizations"/);
    expect(text).toMatch(/"flow_versions"\."publication_seq" = "flows"\."enabled_publication_seq"/);
  });

  it('a partner agent sees partner-wide flows of its partner only', () => {
    const { sql: text, params } = buildKnownFlowSlugsQuery({ orgId: null, partnerId: PARTNER_A }, ['report'])!.toSQL();
    expect(params).toContain(PARTNER_A);
    expect(params).not.toContain(ORG_A);
    expect(text).toMatch(/"flows"\."org_id" is null/);
    expect(text).not.toMatch(/"flows"\."org_id" = \$\d+/);
  });

  it('no owner ⇒ no query', () => {
    expect(buildKnownFlowSlugsQuery({ orgId: null, partnerId: null }, ['report'])).toBeNull();
  });
});
