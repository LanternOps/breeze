import './setup';

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import {
  partnerUsers,
  refreshTokenFamilies,
  ssoProviders,
  ssoSessions,
  users,
} from '../../db/schema';
import { validateSessionBinding } from '../../routes/sso';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
 import { organizationUsers } from '../../db/schema';
import { getTestDb } from './setup';

/**
 * #4049 — the #4018 reauth callback re-checks the caller's
 * `{authEpoch, mfaEpoch, sid}` binding, captured at `/reauth/start`, against
 * live state before minting an `enroll_first_factor` step-up grant. Until now
 * every DB read in that path was asserted only through `mockReturnValueOnce`
 * chains, which pin the ORDER of calls rather than whether the queries return
 * the right rows under real RLS policies and real column types.
 *
 * The re-check exists for one reason: the user's security posture can change
 * between `/reauth/start` and the callback — they log out, an admin
 * deactivates them, a password reset bumps an epoch, their partner membership
 * is removed. Each of those must kill the pending transaction. That is a
 * property about real rows, and a mock-ordering test cannot demonstrate it.
 *
 * Scope: this pins the BINDING, not the HTTP callback. Driving the route would
 * need an IdP, the state cookie and its HMAC; the binding is where the gap was.
 * The identity-match check (`(provider, sub)` must already belong to the user)
 * and the passwordless re-check live in the callback and are NOT covered here.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

type Fixture = {
  userId: string;
  partnerId: string;
  familyId: string;
  session: typeof ssoSessions.$inferSelect;
  provider: typeof ssoProviders.$inferSelect;
};

let seq = 0;

/** A user mid-reauth: partner member, live family, session bound to both epochs. */
async function seedBoundReauth(
  overrides: { userStatus?: 'active' | 'invited' | 'disabled'; axis?: 'partner' | 'organization' } = {},
): Promise<Fixture> {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const axis = overrides.axis ?? 'partner';
  const partner = await createPartner({ status: 'active' });
  const org =
    axis === 'organization' ? await createOrganization({ partnerId: partner.id }) : null;
  const role = await createRole({
    name: `role-${tag}`,
    ...(org ? { orgId: org.id, scope: 'organization' as const } : { partnerId: partner.id, scope: 'partner' as const }),
  });
  const user = await createUser({
    email: `reauth-${tag}@example.test`,
    // users is the dual-axis shape: partner_id is NOT NULL and the composite FK
    // (org_id, partner_id) -> organizations(id, partner_id) must hold, so an org
    // user carries BOTH. The partner branch rejects outright when orgId is set,
    // which is precisely what separates the two fixtures.
    partnerId: partner.id,
    ...(org ? { orgId: org.id } : {}),
    status: overrides.userStatus ?? 'active',
  });
  if (org) {
    await assignUserToOrganization(user.id, org.id, role.id);
  } else {
    await assignUserToPartner(user.id, partner.id, role.id);
  }

  const db = getTestDb();

  const [provider] = await db
    .insert(ssoProviders)
    .values({
      ...(org ? { orgId: org.id } : { partnerId: partner.id }),
      name: `provider-${tag}`,
      type: 'oidc',
      status: 'active',
      configVersion: 1,
    })
    .returning();

  const familyId = crypto.randomUUID();
  await db.insert(refreshTokenFamilies).values({
    familyId,
    userId: user.id,
    absoluteExpiresAt: FAR_FUTURE,
  });

  // Bind to the user's ACTUAL epochs, so the fixture starts matching and each
  // test has to move something for the check to reject. A hardcoded 0/0 would
  // pass by luck and stop being a control the moment defaults change.
  const [live] = await db
    .select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(eq(users.id, user.id));

  const [session] = await db
    .insert(ssoSessions)
    .values({
      providerId: provider!.id,
      state: `state-${tag}`,
      nonce: `nonce-${tag}`,
      reauthUserId: user.id,
      initiatingAuthEpoch: live!.authEpoch,
      initiatingMfaEpoch: live!.mfaEpoch,
      initiatingSessionId: familyId,
      providerVersion: 1,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    })
    .returning();

  return {
    userId: user.id,
    partnerId: partner.id,
    familyId,
    session: session!,
    provider: provider!,
  };
}

const validate = (f: Fixture) =>
  withSystemDbAccessContext(() => validateSessionBinding(f.session, f.provider, f.userId));

describe('#4049 — SSO reauth binding re-check against real Postgres', () => {
  runDb('accepts a binding that still matches live state, and narrows the three columns', async () => {
    const f = await seedBoundReauth();

    const result = await validate(f);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The narrowing is the point: the callback mints a grant from these, and a
    // caller re-asserting them with `!` would mint one with an undefined member.
    expect(result.initiating.sid).toBe(f.familyId);
    expect(typeof result.initiating.authEpoch).toBe('number');
    expect(typeof result.initiating.mfaEpoch).toBe('number');
    expect(result.user.id).toBe(f.userId);
  });

  runDb('rejects when the auth epoch moved — a logout or password reset mid-flow', async () => {
    const f = await seedBoundReauth();
    await getTestDb()
      .update(users)
      .set({ authEpoch: f.session.initiatingAuthEpoch! + 1 })
      .where(eq(users.id, f.userId));

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_auth_epoch_mismatch' });
  });

  runDb('rejects when the MFA epoch moved', async () => {
    const f = await seedBoundReauth();
    await getTestDb()
      .update(users)
      .set({ mfaEpoch: f.session.initiatingMfaEpoch! + 1 })
      .where(eq(users.id, f.userId));

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_mfa_epoch_mismatch' });
  });

  runDb('rejects when the initiating refresh family was revoked', async () => {
    const f = await seedBoundReauth();
    await getTestDb()
      .update(refreshTokenFamilies)
      .set({ revokedAt: new Date(), revokedReason: 'test' })
      .where(eq(refreshTokenFamilies.familyId, f.familyId));

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_family_revoked' });
  });

  runDb('rejects when the initiating refresh family is past its absolute expiry', async () => {
    const f = await seedBoundReauth();
    await getTestDb()
      .update(refreshTokenFamilies)
      .set({ absoluteExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokenFamilies.familyId, f.familyId));

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_family_expired' });
  });

  runDb('rejects when the initiating family row is gone entirely', async () => {
    const f = await seedBoundReauth();
    await getTestDb()
      .delete(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, f.familyId));

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_family_missing' });
  });

  runDb('rejects when the user was disabled mid-flow', async () => {
    const f = await seedBoundReauth({ userStatus: 'disabled' });

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_user_inactive' });
  });

  // The partner and org axes are SEPARATE branches with the same reject reason.
  // A control that neuters one leaves the other's test green — which is exactly
  // what happened while writing this suite: neutering the org branch left all
  // ten passing, because every fixture above is partner-axis. Both are pinned.
  runDb('rejects when ORG membership was removed mid-flow (org-axis provider)', async () => {
    const f = await seedBoundReauth({ axis: 'organization' });
    await getTestDb().delete(organizationUsers).where(eq(organizationUsers.userId, f.userId));

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_axis_membership_lost' });
  });

  runDb('accepts an org-axis provider whose membership still holds', async () => {
    const f = await seedBoundReauth({ axis: 'organization' });

    const result = await validate(f);

    expect(result.ok).toBe(true);
  });

  runDb('rejects when partner membership was removed mid-flow', async () => {
    const f = await seedBoundReauth();
    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.userId, f.userId));

    const result = await validate(f);

    expect(result).toEqual({ ok: false, reason: 'link_axis_membership_lost' });
  });

  runDb('rejects a session missing any of the three binding columns', async () => {
    const f = await seedBoundReauth();

    for (const column of ['initiatingAuthEpoch', 'initiatingMfaEpoch', 'initiatingSessionId'] as const) {
      const result = await withSystemDbAccessContext(() =>
        validateSessionBinding({ ...f.session, [column]: null }, f.provider, f.userId),
      );
      expect(result, `nulling ${column} must reject`).toEqual({
        ok: false,
        reason: 'link_binding_missing',
      });
    }
  });

  runDb('rejects when the bound user no longer exists', async () => {
    const f = await seedBoundReauth();

    const result = await withSystemDbAccessContext(() =>
      validateSessionBinding(f.session, f.provider, crypto.randomUUID()),
    );

    expect(result).toEqual({ ok: false, reason: 'link_user_gone' });
  });
});
