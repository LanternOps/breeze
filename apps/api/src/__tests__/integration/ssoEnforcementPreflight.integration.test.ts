/**
 * Enforce-SSO lockout preflight (#4068) — population SQL against real Postgres.
 *
 * computeEnforcementLockoutPreflight (routes/sso.ts) computes who would be
 * locked out when SSO enforcement goes live on an axis. The unit suite
 * (sso.test.ts) pins the route contract with mocked chains, which cannot prove
 * the SQL — and this query family is exactly the class where mocks have lied
 * before (NOT/EXISTS over membership joins). The load-bearing semantics proven
 * here:
 *
 *   - Membership comes from organization_users / partner_users, NOT
 *     users.org_id — and partner membership WINS the axis (a user with both a
 *     partner_users row and an organization_users row resolves to the partner
 *     axis at login, so an org-axis provider never gates them).
 *   - "Linked" means linked to the EFFECTIVE login provider — the oldest
 *     (createdAt, id) provider that will be active once the change is live —
 *     because the pre-auth login entries pick exactly that one. A link to a
 *     newer active provider is unusable at login and must NOT count.
 *   - Only status='active' users count; invited/disabled are already unable to
 *     log in.
 *   - identities/passkeys are user-id-scoped under RLS, so the whole read runs
 *     in a system DB context — from a plain test context it must still see
 *     every user's links.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import {
  ssoProviders,
  userSsoIdentities,
  userPasskeys
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
  assignUserToOrganization,
  assignUserToPartner
} from './db-utils';
import { computeEnforcementLockoutPreflight } from '../../routes/sso';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function seedProvider(opts: {
  orgId?: string | null;
  partnerId?: string | null;
  status: 'active' | 'inactive' | 'testing';
  type?: 'oidc' | 'saml';
  createdAt: Date;
  enforceSSO?: boolean;
}) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId: opts.orgId ?? null,
      partnerId: opts.partnerId ?? null,
      name: `preflight-${uniq()}`,
      type: opts.type ?? 'oidc',
      status: opts.status,
      enforceSSO: opts.enforceSSO ?? false,
      createdAt: opts.createdAt
    })
    .returning();
  return row!;
}

async function linkIdentity(userId: string, providerId: string) {
  const db = getTestDb();
  await db.insert(userSsoIdentities).values({
    userId,
    providerId,
    externalId: `ext-${uniq()}`,
    email: `ext-${uniq()}@example.com`
  });
}

describe('enforce-SSO lockout preflight population (#4068)', () => {
  it('org axis: effective-provider linkage, partner-membership exclusion, status filtering, tenant isolation', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
    const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });

    // Tenant-isolation discriminator: a SIBLING org under the same partner
    // with its own active unlinked member and its own provider. If any of the
    // org_id filters were dropped, this user/provider would leak into the
    // result — this is a system-context read that returns email addresses.
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const otherOrgRole = await createRole({ scope: 'organization', orgId: otherOrg.id, partnerId: partner.id });
    const outsider = await createUser({
      partnerId: partner.id,
      orgId: otherOrg.id,
      email: `outsider-${uniq()}@example.com`,
      name: 'outsider',
      status: 'active'
    });
    await assignUserToOrganization(outsider.id, otherOrg.id, otherOrgRole.id);
    // Older than every provider in the org under test: if the provider-axis
    // filter leaked, THIS would be picked as the effective login provider.
    await seedProvider({ orgId: otherOrg.id, status: 'active', createdAt: new Date(Date.now() - 120_000) });

    // Two ACTIVE providers: pOld is the one the login entry actually uses.
    const pOld = await seedProvider({ orgId: org.id, status: 'active', createdAt: new Date(Date.now() - 60_000) });
    const pNew = await seedProvider({ orgId: org.id, status: 'active', createdAt: new Date() });

    const mkOrgUser = async (label: string, status: 'active' | 'invited' | 'disabled' = 'active') => {
      const u = await createUser({
        partnerId: partner.id,
        orgId: org.id,
        email: `${label}-${uniq()}@example.com`,
        name: label,
        status
      });
      await assignUserToOrganization(u.id, org.id, orgRole.id);
      return u;
    };

    const alice = await mkOrgUser('alice'); // unlinked → locked out
    const bob = await mkOrgUser('bob'); // linked to pOld → safe
    await linkIdentity(bob.id, pOld.id);
    const carol = await mkOrgUser('carol'); // linked ONLY to pNew → still locked out
    await linkIdentity(carol.id, pNew.id);
    const eve = await mkOrgUser('eve', 'disabled'); // excluded (not active)
    const frank = await mkOrgUser('frank', 'invited'); // excluded (not active)

    // dave: org membership AND partner membership — partner wins the axis, so
    // the org preflight must not report him even though he's unlinked.
    const dave = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `dave-${uniq()}@example.com`,
      name: 'dave',
      status: 'active'
    });
    await assignUserToOrganization(dave.id, org.id, orgRole.id);
    await assignUserToPartner(dave.id, partner.id, partnerRole.id, 'all');

    // Passkey annotation: alice keeps a passkey path; a DISABLED passkey must
    // not count (carol's).
    await db.insert(userPasskeys).values({
      userId: alice.id,
      credentialId: `cred-${uniq()}`,
      publicKey: 'pk',
      deviceType: 'platform'
    });
    await db.insert(userPasskeys).values({
      userId: carol.id,
      credentialId: `cred-${uniq()}`,
      publicKey: 'pk',
      deviceType: 'platform',
      disabledAt: new Date()
    });

    // Self = CAROL, whose email sorts AFTER alice's: the self-first assertion
    // below only discriminates the isSelf sort term if the email tiebreak
    // alone would order self last.
    const result = await computeEnforcementLockoutPreflight(
      { scope: 'organization', orgId: org.id },
      pNew.id,
      carol.id
    );

    // Active org-axis members: alice, bob, carol (dave partner-wins out,
    // eve/frank not active, outsider belongs to the sibling org).
    expect(result.totalActiveUsers).toBe(3);
    expect(result.loginProvider?.id).toBe(pOld.id);
    const emails = result.unlinked.map((u) => u.email).sort();
    expect(emails).toEqual([alice.email, carol.email].sort());
    expect(result.unlinkedCount).toBe(2);
    expect(result.unlinked.some((u) => u.email === outsider.email)).toBe(false);
    expect(result.selfLockedOut).toBe(true); // self = carol

    const aliceRow = result.unlinked.find((u) => u.id === alice.id)!;
    expect(aliceRow.isSelf).toBe(false);
    expect(aliceRow.hasPasskey).toBe(true);
    // Self sorts first (beating the email order) so truncation can never hide
    // the self-lockout.
    expect(result.unlinked[0]!.id).toBe(carol.id);
    const carolRow = result.unlinked.find((u) => u.id === carol.id)!;
    expect(carolRow.isSelf).toBe(true);
    expect(carolRow.hasPasskey).toBe(false);
  });

  it('partner axis: partner_users population, inactive target counts as the future login provider', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
    const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });

    // The target is INACTIVE (freshly created) and the only provider on the
    // axis — it still becomes the effective login provider once activated.
    const target = await seedProvider({ partnerId: partner.id, status: 'inactive', enforceSSO: true, createdAt: new Date() });

    const tech1 = await createUser({ partnerId: partner.id, email: `tech1-${uniq()}@example.com`, name: 'tech1', status: 'active' });
    await assignUserToPartner(tech1.id, partner.id, partnerRole.id, 'all');
    const tech2 = await createUser({ partnerId: partner.id, email: `tech2-${uniq()}@example.com`, name: 'tech2', status: 'active' });
    await assignUserToPartner(tech2.id, partner.id, partnerRole.id, 'all');
    await linkIdentity(tech2.id, target.id);

    // Org-axis member of the same partner — NOT partner-axis population.
    const orgUser = await createUser({ partnerId: partner.id, orgId: org.id, email: `orguser-${uniq()}@example.com`, name: 'orguser', status: 'active' });
    await assignUserToOrganization(orgUser.id, org.id, orgRole.id);

    // Tenant-isolation discriminator: a SECOND partner with its own unlinked
    // staff — must not appear in this partner's population.
    const otherPartner = await createPartner();
    const otherPartnerRole = await createRole({ scope: 'partner', partnerId: otherPartner.id });
    const otherTech = await createUser({ partnerId: otherPartner.id, email: `othertech-${uniq()}@example.com`, name: 'othertech', status: 'active' });
    await assignUserToPartner(otherTech.id, otherPartner.id, otherPartnerRole.id, 'all');

    const result = await computeEnforcementLockoutPreflight(
      { scope: 'partner', partnerId: partner.id },
      target.id,
      tech2.id
    );

    expect(result.unlinked.some((u) => u.email === otherTech.email)).toBe(false);
    expect(result.totalActiveUsers).toBe(2);
    expect(result.loginProvider?.id).toBe(target.id);
    expect(result.unlinkedCount).toBe(1);
    expect(result.unlinked[0]!.id).toBe(tech1.id);
    expect(result.selfLockedOut).toBe(false); // self = tech2, who is linked
  });

  it('a SAML effective provider gives nobody a pre-auth path — links to it do not count', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });

    // Oldest active provider is SAML: the login entry 400s on it instead of
    // falling through, so even a user LINKED to it is locked out.
    const saml = await seedProvider({ orgId: org.id, status: 'active', type: 'saml', createdAt: new Date(Date.now() - 60_000) });

    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `saml-user-${uniq()}@example.com`, name: 'saml-user', status: 'active' });
    await assignUserToOrganization(user.id, org.id, orgRole.id);
    await linkIdentity(user.id, saml.id);

    const result = await computeEnforcementLockoutPreflight(
      { scope: 'organization', orgId: org.id },
      saml.id,
      user.id
    );

    expect(result.loginProvider?.type).toBe('saml');
    expect(result.unlinkedCount).toBe(1);
    expect(result.selfLockedOut).toBe(true);
  });

  it('no provider on the axis at all (create flow): every active member is unlinked, loginProvider null', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `solo-${uniq()}@example.com`, name: 'solo', status: 'active' });
    await assignUserToOrganization(user.id, org.id, orgRole.id);

    const result = await computeEnforcementLockoutPreflight(
      { scope: 'organization', orgId: org.id },
      null,
      user.id
    );

    expect(result.loginProvider).toBeNull();
    expect(result.totalActiveUsers).toBe(1);
    expect(result.unlinkedCount).toBe(1);
  });
});
