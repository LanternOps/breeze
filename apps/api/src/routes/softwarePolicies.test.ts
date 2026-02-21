import { describe, expect, it } from 'vitest';
import { resolveOrgIdForWrite } from './softwarePolicies';
import type { AuthContext } from '../middleware/auth';

function makeOrgAuth(orgId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: [orgId],
  } as unknown as AuthContext;
}

function makePartnerAuth(orgIds: string[]): AuthContext {
  return {
    scope: 'partner',
    orgId: undefined,
    canAccessOrg: (id: string) => orgIds.includes(id),
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: orgIds,
  } as unknown as AuthContext;
}

describe('resolveOrgIdForWrite', () => {
  it('org-scope token cannot write to a different org', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth, 'org-B');
    expect(result.error).toBeDefined();
    expect(result.orgId).toBeUndefined();
  });

  it('org-scope token can write to its own org', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth, 'org-A');
    expect(result.orgId).toBe('org-A');
    expect(result.error).toBeUndefined();
  });

  it('org-scope token uses its own org when no requestedOrgId', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth);
    expect(result.orgId).toBe('org-A');
  });

  it('partner-scope token denied for inaccessible org', () => {
    const auth = makePartnerAuth(['org-A', 'org-B']);
    const result = resolveOrgIdForWrite(auth, 'org-C');
    expect(result.error).toBeDefined();
  });

  it('partner-scope token allowed for accessible org', () => {
    const auth = makePartnerAuth(['org-A', 'org-B']);
    const result = resolveOrgIdForWrite(auth, 'org-B');
    expect(result.orgId).toBe('org-B');
  });
});
