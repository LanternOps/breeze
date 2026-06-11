import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import { resolveMcpExecutionOrgId } from './mcpExecutionOrg';

// ============================================================================
// resolveMcpExecutionOrgId — tenant-isolation regression (security)
//
// Regression for the cross-tenant audit/ledger attribution defect: a
// partner-scoped MCP caller (OAuth bearer, org_id claim null) had apiKey.orgId
// AND auth.orgId both null, so org resolution fell through to the
// attacker-supplied arguments.orgId with no authorization check. That value is
// used as the tenant attribution for the tool-execution ledger
// (ai_sessions / ai_tool_executions) and the per-tool audit_logs event — so an
// out-of-scope orgId let a partner forge audit/ledger rows in another tenant.
//
// The resolver MUST gate a client-supplied orgId through auth.canAccessOrg(),
// mirroring resolveWritableToolOrgId (services/aiTools.ts).
// ============================================================================

const OWN_ORG = '11111111-1111-4111-8111-111111111111';
const SECOND_ORG = '22222222-2222-4222-8222-222222222222';
const VICTIM_ORG = '99999999-9999-4999-8999-999999999999';
const KEY_ORG = '33333333-3333-4333-8333-333333333333';

// Partner-scoped principal: orgId is null; access is bounded by accessibleOrgIds.
// This is the exact shape an MSP partner-admin OAuth bearer produces.
function partnerAuth(accessibleOrgIds: string[]): AuthContext {
  return {
    user: { id: '44444444-4444-4444-8444-444444444444', email: 'p@msp.example', name: 'P', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: '55555555-5555-4555-8555-555555555555',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => accessibleOrgIds.includes(orgId),
  };
}

// Org-scoped principal: pinned to a single org.
function orgAuth(orgId: string): AuthContext {
  return {
    user: { id: '66666666-6666-4666-8666-666666666666', email: 'u@org.example', name: 'U', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === orgId,
  };
}

// System-scoped principal (e.g. platform admin): can access ALL orgs, so
// canAccessOrg returns true for any org and accessibleOrgIds is null.
function systemAuth(): AuthContext {
  return {
    user: { id: '77777777-7777-4777-8777-777777777777', email: 's@breeze.example', name: 'S', isPlatformAdmin: true },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  };
}

describe('resolveMcpExecutionOrgId — tenant isolation', () => {
  it('does NOT honor an out-of-scope arguments.orgId for a partner-scoped caller', () => {
    // Core defect: a partner names a victim org it cannot access.
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      partnerAuth([OWN_ORG]),
      { orgId: VICTIM_ORG },
    );
    expect(result).not.toBe(VICTIM_ORG);
    // Falls back to an org the caller can actually access.
    expect(result).toBe(OWN_ORG);
  });

  it('returns null (never the victim org) when an out-of-scope orgId is supplied and the caller has no accessible orgs', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      partnerAuth([]),
      { orgId: VICTIM_ORG },
    );
    expect(result).not.toBe(VICTIM_ORG);
    expect(result).toBeNull();
  });

  it('honors an in-scope arguments.orgId for a partner-scoped caller', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      partnerAuth([OWN_ORG, SECOND_ORG]),
      { orgId: SECOND_ORG },
    );
    expect(result).toBe(SECOND_ORG);
  });

  it('falls back to the first accessible org when no orgId is supplied', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      partnerAuth([OWN_ORG, SECOND_ORG]),
      {},
    );
    expect(result).toBe(OWN_ORG);
  });

  it('pins to the API key org and ignores arguments.orgId (org-scoped X-API-Key)', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: KEY_ORG },
      partnerAuth([OWN_ORG]),
      { orgId: VICTIM_ORG },
    );
    expect(result).toBe(KEY_ORG);
  });

  it('pins to auth.orgId and ignores arguments.orgId (org-scoped principal)', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      orgAuth(OWN_ORG),
      { orgId: VICTIM_ORG },
    );
    expect(result).toBe(OWN_ORG);
  });

  it('ignores a non-string arguments.orgId and falls back to an accessible org', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      partnerAuth([OWN_ORG]),
      { orgId: 12345 },
    );
    expect(result).toBe(OWN_ORG);
  });

  it('treats an undefined principal like a partner with the supplied access check', () => {
    // Defensive: even with no apiKey object, an out-of-scope input is rejected.
    const result = resolveMcpExecutionOrgId(
      undefined,
      partnerAuth([OWN_ORG]),
      { orgId: VICTIM_ORG },
    );
    expect(result).not.toBe(VICTIM_ORG);
    expect(result).toBe(OWN_ORG);
  });

  it('honors any supplied orgId for a system-scoped caller (system can access all orgs)', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      systemAuth(),
      { orgId: VICTIM_ORG },
    );
    expect(result).toBe(VICTIM_ORG);
  });

  it('returns null for a system-scoped caller with no supplied orgId (no sensible default)', () => {
    const result = resolveMcpExecutionOrgId(
      { orgId: null },
      systemAuth(),
      {},
    );
    expect(result).toBeNull();
  });
});
