import { describe, expect, it } from 'vitest';
import { dbAccessContextFromAuth, type AuthContext } from './auth';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

function partnerAuth(principal: AuthContext['principal']): AuthContext {
  return {
    principal,
    user: { id: OWNER, email: 'owner@example.test', name: 'Owner', isPlatformAdmin: false },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER,
    accessibleOrgIds: [ORG],
  } as unknown as AuthContext;
}

describe('dbAccessContextFromAuth user id', () => {
  it('never puts a partner service principal owner into breeze.user_id', () => {
    const ctx = dbAccessContextFromAuth(partnerAuth({ kind: 'partner_service_principal', principalId: OWNER, keyId: OWNER }));
    expect(ctx.userId).toBeNull();
    expect(ctx.accessibleOrgIds).toEqual([ORG]);
    expect(ctx.scope).toBe('partner');
  });

  it('keeps the user id for an OAuth grant (unchanged)', () => {
    expect(dbAccessContextFromAuth(partnerAuth({ kind: 'oauth_grant', grantId: 'g' })).userId).toBe(OWNER);
  });
});
