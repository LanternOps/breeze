import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { ssoProviders, userSsoIdentities, users, organizationUsers, partnerUsers, roles } from '../../db/schema';
import { createSession, getUserEpochs } from '../../services';
import {
  bindIssuedUserSession,
  issueUserSession,
  type AuthorizedUserSession,
  type UserSessionIdentity,
} from '../../services/userSession';
import {
  beginAuthIssuanceForStoredTransition,
  cancelAuthIssuance,
  finishAuthIssuance,
  type AuthIssuanceCapability,
} from '../../services/authBrowserTransition';
import { lockSsoProviderAuthority } from '../../services/ssoBrowserTransition';
import type { Tx as AuthLifecycleTransaction } from '../../services/authLifecycle';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { getTrustedClientIp } from '../../services/clientIp';
import { isSsoProvisioningBlocked, isDomainVerifiedForOrg } from '../../services/ssoDomainVerification';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  consumeSsoPendingLink,
  restoreConsumedSsoPendingLink,
} from '../../services/ssoPendingLink';
import { consumeRecoveryCode, RecoveryCodeInvalidError } from '../../services/recoveryCodeAuth';
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
  configVersion: number;
};

type UserRow = {
  id: string;
  email: string;
  name: string;
  orgId: string | null;
  mfaEnabled: boolean | null;
  authEpoch: number;
  mfaEpoch: number;
};

export interface SsoCompletionParams {
  tx: AuthLifecycleTransaction;
  capability: AuthIssuanceCapability;
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
  | 'provider_unavailable'
  | 'epoch_unavailable';

export type SsoCompletionResult =
  | {
      ok: true;
      issued: AuthorizedUserSession;
      accessToken: string;
      refreshToken: string;
      expiresInSeconds: number;
      mfa: boolean;
    }
  | { ok: false; error: SsoCompletionErrorCode };

class SsoCompletionRejected extends Error {
  constructor(readonly code: SsoCompletionErrorCode) {
    super(code);
  }
}

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
  const tx = params.tx;

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
  let sessionIdentity: UserSessionIdentity;
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
    const [partnerMembership] = await tx
        .select({ roleId: partnerUsers.roleId, roleScope: roles.scope })
        .from(partnerUsers)
        .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
        .where(and(
          eq(partnerUsers.userId, user.id),
          eq(partnerUsers.partnerId, providerPartnerId)
        ))
        .limit(1);
    if (!partnerMembership) {
      return { ok: false, error: 'no_partner_access' };
    }
    if (partnerMembership.roleScope !== 'partner') {
      return { ok: false, error: 'invalid_role_scope' };
    }
    sessionIdentity = {
      userId: user.id,
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
    const [orgUser] = await tx
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
        .limit(1);

    if (!orgUser) {
      return { ok: false, error: 'no_org_access' };
    }

    if (orgUser.roleScope !== 'organization') {
      return { ok: false, error: 'invalid_role_scope' };
    }

    sessionIdentity = {
      userId: user.id,
      email: user.email,
      roleId: orgUser.roleId,
      orgId: provider.orgId!,
      partnerId: null,
      scope: 'organization' as const,
      mfa: ssoMfa
    };
  }

  // Preserve the global lock order: transition -> user -> family -> provider.
  // All subsequent identity and last-login writes remain in this transaction,
  // so a provider drift or identity conflict rolls the issuance back too.
  const issued = await issueUserSession(sessionIdentity, {
    tx,
    capability: params.capability,
    expectedEpochs: {
      authEpoch: params.user.authEpoch,
      mfaEpoch: params.user.mfaEpoch,
    },
  });
  const providerAuthority = await lockSsoProviderAuthority(tx, {
    providerId: provider.id,
    providerVersion: provider.configVersion,
    mode: 'login',
  });
  if (!providerAuthority.ok) return { ok: false, error: 'provider_unavailable' };

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
  const identityOutcome = await (async (): Promise<{ error: 'identity_in_use' } | { ok: true }> => {
    const [existingIdentity] = await tx
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
      await tx
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
      const inserted = await tx
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
        const [conflict] = await tx
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
    await tx
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));
    return { ok: true as const };
  })();

  if ('error' in identityOutcome) {
    return { ok: false, error: identityOutcome.error };
  }

  return {
    ok: true,
    issued,
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresInSeconds: issued.expiresInSeconds,
    mfa: ssoMfa,
  };
}

/**
 * Same-origin path-only redirect sanitizer for post-login relay targets.
 * (Moved here from routes/sso.ts so the link ceremony's completion endpoints
 * can share it without a route-module cycle.)
 */
export function normalizeRedirectPath(redirectParam: string | undefined): string {
  if (!redirectParam) {
    return '/';
  }

  const trimmed = redirectParam.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return '/';
  }

  try {
    const parsed = new URL(trimmed, 'https://local.invalid');
    if (parsed.origin !== 'https://local.invalid') {
      return '/';
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

/**
 * The finalizer's PUBLIC error vocabulary — deliberately narrower than
 * SsoCompletionErrorCode. Clients only ever need to distinguish three
 * outcomes: restart the ceremony (link_expired), a terminal ownership
 * conflict (identity_in_use), or "your proofs were fine but this account
 * cannot complete the sign-in" (completion_failed — membership/mint
 * failures, precise reason in the audit trail). Keeping the raw membership
 * codes out of the union keeps the three call sites' wire contracts
 * identical by construction and off the unauthenticated wire.
 */
export type SsoLinkFinalizeErrorCode =
  | 'link_expired'
  | 'identity_in_use'
  | 'completion_failed'
  | 'invalid_mfa_code';

export type SsoLinkFinalizeResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      expiresInSeconds: number;
      mfa: boolean;
      session: AuthorizedUserSession;
      redirectPath: string;
    }
  | { ok: false; error: SsoLinkFinalizeErrorCode };

/**
 * #4067 — terminal step of the link-on-first-SSO-login ceremony. Runs only
 * AFTER the caller has verified the account password (and, for MFA-enrolled
 * users, a Breeze-held second factor). Consumes the pending record (atomic
 * single winner), re-validates every binding against LIVE state, creates the
 * user_sso_identities link, and completes the login through the shared SSO
 * mint.
 *
 * Every rejection collapses to the generic `link_expired` for the client
 * (completion-specific codes like identity_in_use excepted) — the audit trail
 * carries the precise reason.
 */
export async function finalizeSsoPendingLink(
  c: Context,
  tokenHash: string,
  opts: {
    breezeMfaVerified: boolean;
    /**
     * MFA continuation binding: the pending-MFA record's userId must be the
     * SAME account the link record targets — a mismatch means the two records
     * were stitched together across ceremonies and the finalize must refuse.
     */
    expectedUserId?: string;
    /** Already-reserved v1 authority from the MFA endpoint. Ownership moves
     * to this finalizer, which finishes or cancels it on every path. */
    capability?: AuthIssuanceCapability;
    /** Recovery authority must be consumed in the same transaction as session
     * issuance; mere format validation is never sufficient MFA proof. */
    recoveryCode?: string;
  },
): Promise<SsoLinkFinalizeResult> {
  let capability = opts.capability;
  try {
    // Consume FIRST — exactly one concurrent finalize wins; the loser reads
    // null and reports the generic expiry.
    const record = await consumeSsoPendingLink(tokenHash);
    if (!record) {
      // TTL expiry, a concurrent finalize winning the consume, or Redis being
      // unavailable (the service logs that case) — all fail closed here.
      console.warn('[sso/link] finalize found no pending record (expired, already consumed, or store unavailable)');
      return { ok: false, error: 'link_expired' };
    }

    const rejected = (reason: string, extra?: Record<string, unknown>): SsoLinkFinalizeResult => {
      writeRouteAudit(c, {
        orgId: null,
        action: 'sso.link.ceremony_rejected',
        resourceType: 'sso_provider',
        resourceId: record.providerId,
        result: 'denied',
        details: { reason, userId: record.userId, ...extra },
      });
      return { ok: false, error: 'link_expired' };
    };

    if (
      capability
      && (
        capability.transitionId !== record.browserTransitionId
        || capability.generation !== record.browserGeneration
      )
    ) {
      return rejected('browser_transition_mismatch');
    }

  if (opts.expectedUserId && record.userId !== opts.expectedUserId) {
    return rejected('user_binding_mismatch');
  }

  // Live user re-read: the account must still be the one the callback matched
  // — active, same email, still password-holding. A password reset, email
  // change, factor change, suspend, or global logout during the 5-minute
  // window shows up as an epoch/status/email mismatch and voids the ceremony
  // (SR2-06 idiom).
  const [user] = await withSystemDbAccessContext(async () =>
    db.select().from(users).where(eq(users.id, record.userId)).limit(1)
  );
  if (!user) return rejected('user_missing');
  if (user.status !== 'active') return rejected('status_changed');
  if (user.email !== record.userEmail) return rejected('email_changed');
  if (user.passwordHash == null) return rejected('password_removed');

  const liveEpochs = await getUserEpochs(user.id);
  if (!liveEpochs) return rejected('epoch_unavailable');
  if (liveEpochs.authEpoch !== record.authEpoch || liveEpochs.mfaEpoch !== record.mfaEpoch) {
    return rejected('epoch_mismatch');
  }

  // Live provider re-read: same invariant as the callback's
  // checkProviderGeneration — a provider re-config (issuer change, rotation,
  // deactivation) between callback and confirm voids the in-flight ceremony.
  const [provider] = await withSystemDbAccessContext(async () =>
    db.select().from(ssoProviders).where(eq(ssoProviders.id, record.providerId)).limit(1)
  );
  if (!provider) return rejected('provider_missing');
  if (provider.status !== 'active') return rejected('provider_inactive');
  if ((provider.configVersion ?? 0) !== record.providerConfigVersion) {
    return rejected('provider_config_changed');
  }

  // Domain-proof re-checks (org axis): the callback may have accepted an
  // ABSENT email_verified claim only because the domain was DNS-verified at
  // the time, and domain rows can change without bumping the provider's
  // configVersion — so re-run both gates against live state.
  if (provider.orgId) {
    const assertedEmailDomain = emailDomainOf(record.email);
    if (record.emailVerifiedClaim === 'absent') {
      const domainProven = assertedEmailDomain
        ? await withSystemDbAccessContext(() =>
            isDomainVerifiedForOrg(provider.orgId!, assertedEmailDomain),
          )
        : false;
      if (!domainProven) return rejected('domain_proof_revoked');
    }
    const domainBlocked = await withSystemDbAccessContext(() =>
      isSsoProvisioningBlocked(provider.orgId!, assertedEmailDomain)
    );
    if (domainBlocked) return rejected('domain_blocked');
  }

    let completion: Extract<SsoCompletionResult, { ok: true }>;
    try {
      if (!capability) {
        const admission = await beginAuthIssuanceForStoredTransition({
          transitionId: record.browserTransitionId,
          generation: record.browserGeneration,
        }, async () => undefined);
        capability = admission.capability;
      }
      const guardedCapability = capability;
      completion = await finishAuthIssuance(guardedCapability, async (tx) => {
        if (opts.recoveryCode) {
          await consumeRecoveryCode(tx, user.id, opts.recoveryCode);
        }
      const result = await completeSsoLogin(c, {
        tx,
          capability: guardedCapability,
        provider,
        user,
        idpMfaAsserted: record.idpMfaAsserted,
        breezeMfaVerified: opts.breezeMfaVerified,
        externalSub: record.externalSub,
        email: record.email,
        profile: record.profile,
        encryptedAccessToken: record.encryptedAccessToken,
        encryptedRefreshToken: record.encryptedRefreshToken,
        tokenExpiresAt: record.tokenExpiresAt ? new Date(record.tokenExpiresAt) : null,
      });
      if (!result.ok) throw new SsoCompletionRejected(result.error);
      return result;
      });
      capability = undefined;
    } catch (err) {
      if (err instanceof RecoveryCodeInvalidError) {
        const restored = await restoreConsumedSsoPendingLink(tokenHash, record);
        if (!restored) {
          console.warn('[sso/link] invalid recovery code could not restore the retryable pending record');
        }
      }
      const reason = err instanceof RecoveryCodeInvalidError
        ? 'invalid_mfa_code'
        : err instanceof SsoCompletionRejected
          ? err.code
          : 'browser_transition_unavailable';
      writeRouteAudit(c, {
      orgId: provider.orgId,
      action: 'sso.link.ceremony_rejected',
      resourceType: 'sso_provider',
      resourceId: provider.id,
      resourceName: provider.name,
      result: 'denied',
      details: { reason, userId: user.id, partnerId: provider.partnerId },
    });
      return {
        ok: false,
        error: reason === 'invalid_mfa_code'
          ? 'invalid_mfa_code'
          : reason === 'identity_in_use'
            ? 'identity_in_use'
            : err instanceof SsoCompletionRejected
              ? 'completion_failed'
              : 'link_expired',
      };
    }

  await bindIssuedUserSession(completion.issued);
  const ip = getTrustedClientIp(c);
  await createSession({
    userId: user.id,
    ipAddress: ip,
    userAgent: c.req.header('user-agent') || 'unknown',
  });
  if (provider.partnerId) {
    auditLogin(c, {
      orgId: null,
      userId: user.id,
      email: user.email,
      name: user.name,
      mfa: completion.mfa,
      scope: 'partner',
      ip,
      method: 'sso-partner',
    });
  }

  writeRouteAudit(c, {
    orgId: provider.orgId,
    action: 'sso.identity.linked',
    resourceType: 'sso_provider',
    resourceId: provider.id,
    resourceName: provider.name,
    result: 'success',
    details: {
      flow: 'link_on_first_login',
      userId: user.id,
      partnerId: provider.partnerId,
      breezeMfaVerified: opts.breezeMfaVerified,
    },
  });

    return {
      ok: true,
      accessToken: completion.accessToken,
      refreshToken: completion.refreshToken,
      expiresInSeconds: completion.expiresInSeconds,
      mfa: completion.mfa,
      session: completion.issued,
      redirectPath: normalizeRedirectPath(record.redirectUrl ?? undefined),
    };
  } finally {
    if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
  }
}
