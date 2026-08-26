import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { userSsoIdentities, users, organizationUsers, partnerUsers, roles } from '../../db/schema';
import {
  createTokenPair,
  createSession,
  mintRefreshTokenFamily,
  bindRefreshJtiToFamily,
  getUserEpochs,
} from '../../services';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { getTrustedClientIp } from '../../services/clientIp';
import { auditLogin } from './helpers';

/**
 * Shared tail of every SSO-completed sign-in: MFA-claim evaluation, axis
 * membership gates, identity upsert, and the token/session mint. Extracted
 * from the /sso/callback success path (#4067) so the link-on-first-login
 * ceremony (password/MFA confirm endpoints) completes through EXACTLY the
 * same gates instead of a re-implementation that could drift.
 *
 * Callers hand in an already-RESOLVED (user, provider, verified-assertion)
 * triple — everything before this point (state binding, id_token verification,
 * email provenance, domain gates, account matching) remains the caller's
 * responsibility.
 */

type ProviderRow = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  trustsIdpMfa: boolean | null;
};

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  orgId: string | null;
  mfaEnabled: boolean | null;
};

export interface SsoCompletionParams {
  provider: ProviderRow;
  user: UserRow;
  /** Whether the verified id_token's `amr` attested MFA at assertion time. */
  idpMfaAsserted: boolean;
  /**
   * True only when the ceremony verified a Breeze-held factor (TOTP / SMS /
   * recovery / passkey) as part of THIS sign-in — the mfa claim is then
   * honestly true regardless of what the IdP asserted.
   */
  breezeMfaVerified?: boolean;
  externalSub: string;
  /** IdP-asserted email (lowercased, verified-source). */
  email: string;
  /** Raw userinfo body → user_sso_identities.profile. */
  profile: unknown;
  /** IdP tokens, already encryptSecret()-wrapped by the caller. */
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: Date | null;
}

export type SsoCompletionErrorCode =
  | 'no_partner_access'
  | 'no_org_access'
  | 'invalid_role_scope'
  | 'identity_in_use'
  | 'epoch_unavailable';

export type SsoCompletionResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      expiresInSeconds: number;
      mfa: boolean;
    }
  | { ok: false; error: SsoCompletionErrorCode };

export async function completeSsoLogin(
  c: Context,
  params: SsoCompletionParams,
): Promise<SsoCompletionResult> {
  const {
    provider,
    user,
    idpMfaAsserted,
    breezeMfaVerified,
    externalSub,
    email,
    profile,
    encryptedAccessToken,
    encryptedRefreshToken,
    tokenExpiresAt,
  } = params;

  // IdP-asserted MFA — axis-independent, so it is computed here (above the
  // membership branch) and shared by both the org and partner token payloads.
  // When the provider opts in via `trustsIdpMfa` AND the verified id_token's
  // `amr` attested multi-factor, propagate mfa:true so the tenant can satisfy
  // Breeze's MFA-gated routes via their IdP. Fail-safe: any provider that
  // hasn't opted in, or an assertion without the `mfa` amr, yields mfa:false.
  // This claim never satisfies the L4 step-up (requireFreshMfaStepUp
  // re-verifies a Breeze-held TOTP).
  //
  // BUT: trusting an IdP's MFA assertion is NOT the same as the user holding
  // a factor under OUR policy (the adjudicated rule the CF-Access mint sites
  // already follow). An UNENROLLED user whose effective policy REQUIRES MFA
  // must not get mfa:true, however loudly the IdP asserts `amr:mfa` — that
  // would walk them straight past authMiddleware's forced-enrollment gate and
  // every hasSatisfiedMfa() route, permanently, through refresh rotation.
  // `trustsIdpMfa` still satisfies MFA for a user who actually HAS a factor,
  // and still does so for an unenrolled user under a policy that does not
  // require one. Callers are unauthenticated (no ambient DB context), so
  // getEffectiveMfaPolicy's own runOutsideDbContext+withSystemDbAccessContext
  // read is correct here: `user` is COMMITTED, so this resolves against real
  // rows.
  //
  // A Breeze-verified factor from the link ceremony (#4067) outranks the IdP
  // evaluation entirely — the user just proved a Breeze-held factor in this
  // very sign-in.
  const idpMfa = provider.trustsIdpMfa === true && idpMfaAsserted;
  const ssoPolicy = await getEffectiveMfaPolicy({
    scope: provider.partnerId ? 'partner' : 'organization',
    userId: user.id,
    orgId: provider.partnerId ? null : provider.orgId,
    partnerId: provider.partnerId ?? null,
  });
  const ssoMfa = breezeMfaVerified === true
    || (idpMfa && (user.mfaEnabled === true || !ssoPolicy.required));

  // Membership resolution + token payload, keyed on the provider's axis.
  let tokenPayload: Parameters<typeof createTokenPair>[0];
  if (provider.partnerId) {
    // Defense-in-depth: a partner token is ONLY for partner STAFF
    // (users.orgId IS NULL). Re-assert the invariant at the MINT gate, not
    // just at link/email-resolution time — so even a resolved user reached
    // via a pre-existing (provider, sub) link cannot mint a scope:'partner'
    // / orgId:null token if their row is org-bound. Org-bound users never
    // authenticate through a partner provider.
    if (user.orgId != null) {
      return { ok: false, error: 'no_partner_access' };
    }

    // Partner axis (#2183): the tech's role membership lives in partner_users
    // and MUST be partner-scoped. A user with NO partner_users membership is
    // REJECTED (no_partner_access) — it never falls back to the provider
    // defaultRoleId, which would recreate the membershipless-user
    // system-scope-token bug class. defaultRoleId is NEVER applied at login in
    // v1. orgId is always null on a partner token.
    const providerPartnerId = provider.partnerId;
    const [partnerMembership] = await withSystemDbAccessContext(async () =>
      db
        .select({ roleId: partnerUsers.roleId, roleScope: roles.scope })
        .from(partnerUsers)
        .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
        .where(and(
          eq(partnerUsers.userId, user.id),
          eq(partnerUsers.partnerId, providerPartnerId)
        ))
        .limit(1)
    );
    if (!partnerMembership) {
      return { ok: false, error: 'no_partner_access' };
    }
    if (partnerMembership.roleScope !== 'partner') {
      return { ok: false, error: 'invalid_role_scope' };
    }
    tokenPayload = {
      sub: user.id,
      email: user.email,
      roleId: partnerMembership.roleId,
      orgId: null,
      partnerId: providerPartnerId,
      scope: 'partner' as const,
      mfa: ssoMfa
    };
  } else {
    // System context required: the caller is unauthenticated (no request
    // scope), so a bare `db` read here silently 0-rows under RLS and every
    // org-axis login would fail with no_org_access regardless of real
    // membership.
    const [orgUser] = await withSystemDbAccessContext(async () =>
      db
        .select({
          orgId: organizationUsers.orgId,
          roleId: organizationUsers.roleId,
          roleName: roles.name,
          roleScope: roles.scope
        })
        .from(organizationUsers)
        .innerJoin(roles, eq(roles.id, organizationUsers.roleId))
        .where(
          and(
            eq(organizationUsers.userId, user.id),
            eq(organizationUsers.orgId, provider.orgId!)
          )
        )
        .limit(1)
    );

    if (!orgUser) {
      return { ok: false, error: 'no_org_access' };
    }

    if (orgUser.roleScope !== 'organization') {
      return { ok: false, error: 'invalid_role_scope' };
    }

    tokenPayload = {
      sub: user.id,
      email: user.email,
      roleId: orgUser.roleId,
      orgId: provider.orgId!,
      partnerId: null,
      scope: 'organization' as const,
      mfa: ssoMfa
    };
  }

  // Update or create SSO identity link (shared across both axes). System DB
  // context required for ALL of it: callers are unauthenticated, so bare
  // reads/writes silently match 0 rows under breeze_app RLS (#2195). Also
  // stamps last_login_at (#1375).
  //
  // Resolution is EXACT on (provider, external subject) — the DB uniqueness
  // invariant (#2195). The previous shape keyed the update on
  // (userId, providerId) without checking externalId, so a user whose IdP
  // subject rotated (same provider, new sub) had the assertion's email/profile
  // stamped onto the OLD subject's row while the login proceeded — corrupting
  // the row instead of recording the new subject. Now: the exact (provider,
  // sub) row is updated when it is the user's own; a foreign owner is refused
  // (identity_in_use); no row means a fresh INSERT for this subject.
  const identityOutcome = await withSystemDbAccessContext(async () => {
    const [existingIdentity] = await db
      .select({ id: userSsoIdentities.id, userId: userSsoIdentities.userId })
      .from(userSsoIdentities)
      .where(and(
        eq(userSsoIdentities.providerId, provider.id),
        eq(userSsoIdentities.externalId, externalSub)
      ))
      .limit(1);

    if (existingIdentity) {
      if (existingIdentity.userId !== user.id) {
        return { error: 'identity_in_use' as const };
      }
      await db
        .update(userSsoIdentities)
        .set({
          email,
          profile,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiresAt,
          lastLoginAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(userSsoIdentities.id, existingIdentity.id));
    } else {
      // Race-safe against the unique (provider_id, external_id) index
      // (#2195): a concurrent callback that linked this subject first turns
      // this INSERT into a no-op rather than a 23505 throw — postgres.js
      // rethrows errors through the transaction wrapper even when caught,
      // so ON CONFLICT is the only clean path here.
      const inserted = await db
        .insert(userSsoIdentities)
        .values({
          userId: user.id,
          providerId: provider.id,
          externalId: externalSub,
          email,
          profile,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          tokenExpiresAt,
          lastLoginAt: new Date()
        })
        .onConflictDoNothing({
          target: [userSsoIdentities.providerId, userSsoIdentities.externalId]
        })
        .returning({ id: userSsoIdentities.id });

      if (inserted.length === 0) {
        // Conflict row already exists. Same user (two parallel logins) →
        // the link is in place, proceed. Different user → this (provider,
        // sub) identity belongs to someone else; never mint tokens for it.
        const [conflict] = await db
          .select({ userId: userSsoIdentities.userId })
          .from(userSsoIdentities)
          .where(and(
            eq(userSsoIdentities.providerId, provider.id),
            eq(userSsoIdentities.externalId, externalSub)
          ))
          .limit(1);
        if (conflict && conflict.userId !== user.id) {
          return { error: 'identity_in_use' as const };
        }
        if (!conflict) {
          // Anomaly: the insert reported a conflict but the conflicting row
          // vanished before the re-select (concurrent unlink/revocation).
          // Proceeding is safe — the user was already resolved — but this
          // login completes WITHOUT a persisted identity row, so leave a
          // trace for anyone debugging a future linkage report.
          console.warn(
            `[sso/completion] identity insert conflicted but conflicting row vanished: provider=${provider.id} user=${user.id}`
          );
        }
      }
    }

    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));
    return { ok: true as const };
  });

  if ('error' in identityOutcome) {
    return { ok: false, error: identityOutcome.error };
  }

  // Create session and tokens. `tokenPayload` (and its mfa claim) was already
  // built by the axis branch above.
  const ip = getTrustedClientIp(c);
  const userAgent = c.req.header('user-agent') || 'unknown';

  // Epochs are the DB-authoritative source for aep/mep — never trust caller
  // input. Resolved here (after both membership branches, right before
  // mint) so it applies uniformly to both the partner and org axes without
  // duplicating the fetch into each branch.
  const epochs = await getUserEpochs(user.id);
  if (!epochs) {
    return { ok: false, error: 'epoch_unavailable' };
  }
  tokenPayload = { ...tokenPayload, aep: epochs.authEpoch, mep: epochs.mfaEpoch };

  // Mint a fresh refresh-token family for the SSO-completed session so
  // SSO logins get the same reuse-detection coverage as password/MFA
  // logins. Without this, SSO-issued tokens would silently bypass RFC
  // 9700 §4.13.2 protection.
  const ssoFamilyId = await mintRefreshTokenFamily(user.id);
  const { accessToken, refreshToken, refreshJti, expiresInSeconds } = await createTokenPair(
    tokenPayload,
    { refreshFam: ssoFamilyId }
  );
  await bindRefreshJtiToFamily(refreshJti, ssoFamilyId);

  await createSession({
    userId: user.id,
    ipAddress: ip,
    userAgent
  });

  // Partner-axis logins are audited as user.login with method 'sso-partner'
  // (org-axis SSO keeps its existing audit path). orgId is null on a partner
  // token, matching the audit row's tenancy.
  if (provider.partnerId) {
    auditLogin(c, {
      orgId: null,
      userId: user.id,
      email: user.email,
      name: user.name,
      mfa: ssoMfa,
      scope: 'partner',
      ip,
      method: 'sso-partner'
    });
  }

  return { ok: true, accessToken, refreshToken, expiresInSeconds, mfa: ssoMfa };
}
