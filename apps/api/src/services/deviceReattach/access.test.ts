import { describe, expect, it } from 'vitest';
import { canActorReattach, type ReattachActorAccess, type ReattachAccessScope } from './access';

const PARTNER = '00000000-0000-4000-8000-0000000000a9';
const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000b9';
const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000a2';
const ORG_C = '00000000-0000-4000-8000-0000000000a3';
const HOLDING = '00000000-0000-4000-8000-0000000000f1';

const WRITE_DELETE = [
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'delete' },
];

function actor(overrides: Partial<ReattachActorAccess> = {}, membership: Partial<NonNullable<ReattachActorAccess['membership']>> | null = {}): ReattachActorAccess {
  return {
    userId: 'user-1',
    status: 'active',
    partnerId: PARTNER,
    membership: membership === null
      ? null
      : { orgAccess: 'all', orgIds: [], grants: WRITE_DELETE, ...membership },
    ...overrides,
  };
}

const realSource: ReattachAccessScope = { partnerId: PARTNER, sourceOrgId: ORG_A, sourceParked: false, targetOrgId: ORG_B };
const parkedSource: ReattachAccessScope = { partnerId: PARTNER, sourceOrgId: HOLDING, sourceParked: true, targetOrgId: ORG_B };

describe('canActorReattach (#8318 §8)', () => {
  it('a full partner admin may reattach anything in the partner, parked sources included', () => {
    expect(canActorReattach(actor(), realSource)).toEqual({ allowed: true, fullAdmin: true });
    expect(canActorReattach(actor(), parkedSource)).toEqual({ allowed: true, fullAdmin: true });
  });

  it('wildcard grants count, as hasPermission does', () => {
    expect(canActorReattach(actor({}, { grants: [{ resource: '*', action: '*' }] }), realSource).allowed).toBe(true);
    expect(canActorReattach(actor({}, { grants: [{ resource: 'devices', action: '*' }] }), realSource).allowed).toBe(true);
  });

  it('a customer-org user (no partner membership) never can', () => {
    expect(canActorReattach(actor({}, null), realSource)).toEqual({ allowed: false, code: 'not_partner_user' });
  });

  it('a missing user is refused', () => {
    expect(canActorReattach(null, realSource)).toEqual({ allowed: false, code: 'not_partner_user' });
  });

  it('an inactive user is refused', () => {
    expect(canActorReattach(actor({ status: 'disabled' }), realSource)).toEqual({ allowed: false, code: 'user_inactive' });
    expect(canActorReattach(actor({ status: 'invited' }), realSource)).toEqual({ allowed: false, code: 'user_inactive' });
  });

  it('a user of another partner is refused', () => {
    expect(canActorReattach(actor({ partnerId: OTHER_PARTNER }), realSource)).toEqual({ allowed: false, code: 'partner_mismatch' });
  });

  it('needs both devices:write and devices:delete', () => {
    expect(canActorReattach(actor({}, { grants: [WRITE_DELETE[0]!] }), realSource)).toEqual({ allowed: false, code: 'permission_denied' });
    expect(canActorReattach(actor({}, { grants: [WRITE_DELETE[1]!] }), realSource)).toEqual({ allowed: false, code: 'permission_denied' });
    expect(canActorReattach(actor({}, { grants: [] }), realSource)).toEqual({ allowed: false, code: 'permission_denied' });
  });

  describe('a technician limited to selected orgs', () => {
    const tech = (orgIds: string[]) => actor({}, { orgAccess: 'selected', orgIds });

    it('may reattach when both the target org and the real source org are theirs', () => {
      expect(canActorReattach(tech([ORG_A, ORG_B]), realSource)).toEqual({ allowed: true, fullAdmin: false });
    });

    it('is refused without the target org', () => {
      expect(canActorReattach(tech([ORG_A, ORG_C]), realSource)).toEqual({ allowed: false, code: 'org_access_denied' });
    });

    it('is refused without the real source org (its row is retired)', () => {
      expect(canActorReattach(tech([ORG_B]), realSource)).toEqual({ allowed: false, code: 'org_access_denied' });
    });

    it('needs a full partner admin for a parked source until wave H', () => {
      expect(canActorReattach(tech([ORG_B]), parkedSource)).toEqual({ allowed: false, code: 'full_admin_required' });
    });

    it('a parked source without the target org is an org refusal first', () => {
      expect(canActorReattach(tech([ORG_C]), parkedSource)).toEqual({ allowed: false, code: 'org_access_denied' });
    });
  });

  it("org_access 'none' is refused", () => {
    expect(canActorReattach(actor({}, { orgAccess: 'none', orgIds: [ORG_A, ORG_B] }), realSource)).toEqual({ allowed: false, code: 'org_access_denied' });
  });
});
