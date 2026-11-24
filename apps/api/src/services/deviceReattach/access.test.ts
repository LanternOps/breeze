import { describe, expect, it } from 'vitest';
import { canActorActOnReattachEvidence, canActorReattach, type ReattachActorAccess, type ReattachAccessScope } from './access';

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
      : { orgAccess: 'all', reachableOrgIds: [ORG_A, ORG_B, ORG_C], grants: WRITE_DELETE, ...membership },
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
    const tech = (reachableOrgIds: string[]) => actor({}, { orgAccess: 'selected', reachableOrgIds });

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

  // Review of wave 1b-2, finding 1: only the LIVE reachable set counts (the
  // RLS population: active/trial, undeleted, not the holding org).
  describe('the live reachable set, not raw membership', () => {
    it('a full partner admin is refused a target org they cannot reach now (suspended, deleted)', () => {
      expect(canActorReattach(actor({}, { reachableOrgIds: [ORG_A] }), realSource)).toEqual({ allowed: false, code: 'org_access_denied' });
    });

    it('a full partner admin is refused a real source org they cannot reach now', () => {
      expect(canActorReattach(actor({}, { reachableOrgIds: [ORG_B] }), realSource)).toEqual({ allowed: false, code: 'org_access_denied' });
    });

    it('a full partner admin may still act on a parked source (the holding org is never reachable)', () => {
      expect(canActorReattach(actor({}, { reachableOrgIds: [ORG_B] }), parkedSource)).toEqual({ allowed: true, fullAdmin: true });
    });

    it('a technician whose selected target org is no longer reachable is refused', () => {
      expect(canActorReattach(actor({}, { orgAccess: 'selected', reachableOrgIds: [ORG_A] }), realSource))
        .toEqual({ allowed: false, code: 'org_access_denied' });
    });
  });

  it("org_access 'none' is refused", () => {
    expect(canActorReattach(actor({}, { orgAccess: 'none', reachableOrgIds: [ORG_A, ORG_B] }), realSource)).toEqual({ allowed: false, code: 'org_access_denied' });
  });
});

describe('canActorActOnReattachEvidence (#8318 wave T2: reviewing a TPM key change)', () => {
  const real = { partnerId: PARTNER, orgId: ORG_A, parked: false };
  const parked = { partnerId: PARTNER, orgId: HOLDING, parked: true };

  it('a full partner admin may review a real or a parked device', () => {
    expect(canActorActOnReattachEvidence(actor(), real)).toEqual({ allowed: true, fullAdmin: true });
    expect(canActorActOnReattachEvidence(actor(), parked)).toEqual({ allowed: true, fullAdmin: true });
  });

  it('a technician may review a device in one of their orgs, never a parked one', () => {
    const tech = actor({}, { orgAccess: 'selected', reachableOrgIds: [ORG_A] });
    expect(canActorActOnReattachEvidence(tech, real)).toEqual({ allowed: true, fullAdmin: false });
    expect(canActorActOnReattachEvidence(tech, { ...real, orgId: ORG_B })).toEqual({ allowed: false, code: 'org_access_denied' });
    expect(canActorActOnReattachEvidence(tech, parked)).toEqual({ allowed: false, code: 'full_admin_required' });
  });

  it('a full admin still needs the org to be reachable now (a draining org grants nothing)', () => {
    expect(canActorActOnReattachEvidence(actor({}, { reachableOrgIds: [ORG_B] }), real)).toEqual({ allowed: false, code: 'org_access_denied' });
  });

  it.each<[string, ReattachActorAccess | null, string]>([
    ['no user', null, 'not_partner_user'],
    ['an inactive user', actor({ status: 'disabled' }), 'user_inactive'],
    ['another partner', actor({ partnerId: OTHER_PARTNER }), 'partner_mismatch'],
    ['no membership', actor({}, null), 'not_partner_user'],
    ['no devices:delete', actor({}, { grants: [{ resource: 'devices', action: 'write' }] }), 'permission_denied'],
    ['org access none', actor({}, { orgAccess: 'none' }), 'org_access_denied'],
  ])('refuses %s, as the reattach rule does', (_name, who, code) => {
    expect(canActorActOnReattachEvidence(who, real)).toEqual({ allowed: false, code });
    expect(canActorActOnReattachEvidence(who, parked)).toEqual({ allowed: false, code });
  });
});
