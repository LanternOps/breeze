import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as dbModule from '../db';
import { users } from '../db/schema';
import {
  cfAccessAud,
  cfAccessTeamDomain,
  cfAccessTrustEnabled,
  cfAccessTrustsMfa,
} from '../config/env';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  verifyCfAccessJwt,
} from '../services/cfAccessJwt';
import {
  getUserEpochs,
  beginAuthIssuance,
  finishAuthIssuance,
  cancelAuthIssuance,
  assertAuthIssuanceCapability,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  issueUserSession,
  issueUserSessionLegacyDuringTransition,
  bindIssuedUserSession,
  authBrowserTransitionsEnforced,
  recordAuthTransitionLegacyIssuer,
  type AuthIssuanceCapability,
  type AuthorizedUserSession,
  type UserSessionIdentity,
} from '../services';
import { getRedis } from '../services';
import { createAuditLogAsync } from '../services/auditService';
import { TenantInactiveError } from '../services/tenantStatus';
import { getEffectiveMfaPolicy } from '../services/mfaPolicy';
import { ENABLE_2FA } from '../routes/auth/schemas';
import {
  auditUserLoginFailure,
  getClientIP,
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  installAuthorizedUserSessionCookies,
  installLegacyUserSessionCookiesDuringTransition,
  toPublicTokens,
  userRequiresSetup,
  userHasUsablePasskey,
  isAuthTransitionV1Request,
  authClientUpgradeRequiredResponse,
} from '../routes/auth/helpers';
import { readMobileDeviceId } from '../services/mobileDeviceBinding';
import { installAuthBindingReplacement, requestAuthBinding } from '../routes/auth/binding';

const { db, withSystemDbAccessContext } = dbModule;

const CF_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

function authIssuanceAdmissionError(c: Context, error: unknown): Response | null {
  if (error instanceof AuthBindingRotationRequiredError) {
    installAuthBindingReplacement(c, error.replacement);
    return c.json({ error: error.message, reason: 'auth_binding_rotation_required' }, 428);
  }
  if (
    error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError
  ) {
    return c.json({ error: 'Authentication issuance unavailable' }, 409);
  }
  return null;
}

async function beginCfIssuance(c: Context): Promise<AuthIssuanceCapability | Response | null> {
  if (!isAuthTransitionV1Request(c)) {
    return authBrowserTransitionsEnforced() ? authClientUpgradeRequiredResponse(c) : null;
  }
  try {
    return await beginAuthIssuance(requestAuthBinding(c));
  } catch (error) {
    const response = authIssuanceAdmissionError(c, error);
    if (!response) throw error;
    return response;
  }
}

/**
 * Hono middleware that short-circuits `POST /auth/login` when a valid
 * Cloudflare Access JWT is presented (Discussion #702).
 *
 * Behaviour:
 *   - CF_ACCESS_TRUST_ENABLED unset/false  → next()
 *   - Cf-Access-Jwt-Assertion header absent → next()
 *   - JWT signature / claim invalid        → next() (fail-closed on trust)
 *   - JWKS network blip                    → next() (fail-open on availability)
 *   - User not found by email              → next() (let password handler 401)
 *   - User inactive                        → next() (let password handler 401)
 *   - User has MFA + CF_ACCESS_TRUSTS_MFA=false → issue MFA temp token
 *   - Otherwise                            → mint token pair, set cookie, return
 *
 * Mount BEFORE the zValidator+password handler so the JWT path is tried first
 * but the password path still validates its body when this falls through.
 *
 * See:
 *   - apps/api/src/services/cfAccessJwt.ts (JWKS verifier)
 *   - apps/api/src/routes/auth/login.ts (the handler this falls through to)
 */
export async function cfAccessLoginMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (!cfAccessTrustEnabled()) return next();

  const token = c.req.header(CF_ACCESS_JWT_HEADER);
  if (!token) return next();

  const teamDomain = cfAccessTeamDomain();
  const audience = cfAccessAud();
  if (!teamDomain || !audience) {
    // Trust is enabled but the deployment is misconfigured. Fail-open to
    // the password handler rather than wedge /login for everyone. Surface
    // a single warning so ops sees it.
    console.warn(
      '[cf-access-login] CF_ACCESS_TRUST_ENABLED=true but CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD is empty; ignoring header.'
    );
    return next();
  }

  let claims;
  try {
    claims = await verifyCfAccessJwt(token, { teamDomain, audience });
  } catch (err) {
    if (err instanceof CfAccessInvalidTokenError) {
      // Don't log token contents; just the code. Repeated INVALID is
      // either a stale CF Access session or an attacker probe — either
      // way fall through and let the password handler do its thing.
      console.warn('[cf-access-login] rejected JWT', { code: err.code });
    } else if (err instanceof CfAccessJwksUnavailableError) {
      console.error('[cf-access-login] JWKS unavailable, falling through to password', err);
    } else {
      console.error('[cf-access-login] unexpected verify error', err);
    }
    return next();
  }

  const normalizedEmail = claims.email.toLowerCase();

  const [user] = await withSystemDbAccessContext(async () =>
    db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1)
  );

  if (!user) {
    // No matching Breeze user. Fall through; password handler will 401
    // generically. We don't want to leak "no such email" via this path
    // either.
    return next();
  }

  if (user.status !== 'active') {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'account_inactive',
      result: 'denied',
      details: { accountStatus: user.status, method: 'cf_access_jwt' },
    });
    return next();
  }

  let context;
  try {
    context = await resolveCurrentUserTokenContext(user.id);
  } catch (err) {
    // Membership-less / non-admin user: don't authenticate via CF-Access (it
    // would mint a system-scope token). Fall through to password auth, which
    // also fails closed for this user. (security review #2)
    if (!(err instanceof TenantInactiveError) && !(err instanceof NoTenantMembershipError)) throw err;
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: err instanceof NoTenantMembershipError ? 'no_membership' : 'tenant_inactive',
      result: 'denied',
      details: { method: 'cf_access_jwt' },
    });
    return next();
  }

  // CF Access JWT cannot tell us whether the user satisfied MFA at the
  // edge — that's an operator-level assertion via CF_ACCESS_TRUSTS_MFA.
  // If the user has Breeze MFA enrolled and we don't trust CF Access as
  // MFA, issue a temp token and require the user to complete TOTP, same
  // shape the password handler uses.
  const trustsMfa = cfAccessTrustsMfa();
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms' || user.mfaMethod === 'passkey') && !trustsMfa) {
    const redis = getRedis();
    if (!redis) {
      console.error('[cf-access-login] redis unavailable; cannot issue MFA temp token, falling through');
      return next();
    }
    const tempToken = nanoid(32);
    const mfaMethod = user.mfaMethod || 'totp';
    // #2153: mirror the password /login handler — a passkey is an accepted
    // ALTERNATE second factor here too, even when the primary method is
    // totp/sms. The helper fails closed, so a probe error just hides the
    // alternate rather than blocking this CF-Access MFA challenge.
    const passkeyAvailable = await userHasUsablePasskey(user.id);
    // Mirror the password /login handler and the SSO handler (sso.ts): a
    // pending record now requires recoveryAvailable (parsePendingMfa rejects
    // any record missing it), so this CF-Access issuance path must compute
    // and carry it too, or every real MFA completion here would be hard
    // -rejected as a malformed/legacy record.
    const recoveryAvailable = Array.isArray(user.mfaRecoveryCodes)
      && user.mfaRecoveryCodes.length > 0;
    // SR2-06: bind the pending record to the live auth/mfa epochs + status +
    // effective allowed methods at issuance — same shape/rationale as the
    // password /login handler (login.ts), so the shared TOTP/SMS/passkey
    // completion paths (mfa.ts, passkeys.ts) can validate it via
    // parsePendingMfa/evaluatePendingMfa rather than treating it as a legacy
    // (rejected) record.
    const pendingEpochs = await getUserEpochs(user.id);
    if (!pendingEpochs) throw new Error('user epochs unavailable at MFA temp-token issuance');
    const pendingPolicy = await getEffectiveMfaPolicy({
      scope: context.scope, userId: user.id, orgId: context.orgId, partnerId: context.partnerId,
    });
    const admission = await beginCfIssuance(c);
    if (admission instanceof Response) return admission;
    const capability = admission;
    let pendingTransition = { transitionId: 'legacy', browserGeneration: 0 };
    if (capability) {
      try {
        pendingTransition = await finishAuthIssuance(capability, async (tx) => {
          await assertAuthIssuanceCapability(tx, capability);
          return {
            transitionId: capability.transitionId,
            browserGeneration: capability.generation,
          };
        });
      } catch (error) {
        await cancelAuthIssuance(capability).catch(() => undefined);
        const response = authIssuanceAdmissionError(c, error);
        if (!response) throw error;
        return response;
      }
    }
    const PENDING_TTL_SECONDS = 300;
    await redis.setex(
      `mfa:pending:${tempToken}`,
      PENDING_TTL_SECONDS,
      JSON.stringify({
        userId: user.id,
        mfaMethod,
        passkeyAvailable,
        recoveryAvailable,
        authEpoch: pendingEpochs.authEpoch,
        mfaEpoch: pendingEpochs.mfaEpoch,
        statusExpectation: user.status,
        allowedMethods: pendingPolicy.allowedMethods,
        ...pendingTransition,
        expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000,
      })
    );
    return c.json({
      mfaRequired: true,
      tempToken,
      mfaMethod,
      passkeyAvailable,
      recoveryAvailable,
      phoneLast4: user.phoneNumber?.slice(-4) || null,
      user: null,
      tokens: null,
    });
  }

  // Parity with the password /login handler (routes/auth/login.ts). Reaching
  // here means the user is NOT MFA-challenged: either they hold no Breeze
  // factor, or CF_ACCESS_TRUSTS_MFA asserts the edge already did MFA.
  //
  // The old `trustsMfa || !(ENABLE_2FA && user.mfaEnabled)` granted VACUOUS
  // assurance to any user with no factor — INCLUDING one whose effective
  // policy requires MFA — so a CF Access login walked straight past forced
  // enrollment and every hasSatisfiedMfa() gate. An unenrolled user under a
  // required policy must get mfa=false plus a forced-enrollment response,
  // exactly as the password path does. `trustsMfa` still satisfies MFA, but
  // ONLY for a user who actually HAS a factor: the operator is asserting the
  // edge performed a second factor, not that policy is irrelevant.
  //
  // Fail-closed on an unresolvable policy: getEffectiveMfaPolicy runs its
  // reads under runOutsideDbContext+withSystemDbAccessContext (so this
  // pre-auth path can never silently 0-row under RLS and mistake "no policy
  // row" for "no policy"), and a role/membership-join failure THROWS rather
  // than returning a permissive default — the throw aborts the request before
  // any token is minted, which is the closed outcome. (A settings-read blip
  // is the one deliberate fail-open, owned by the resolver and shared with
  // /login: a transient error must not lock a whole tenant out of signing in.)
  const policy = await getEffectiveMfaPolicy({
    scope: context.scope,
    userId: user.id,
    orgId: context.orgId,
    partnerId: context.partnerId,
  });
  const mfaEnrollmentRequired = ENABLE_2FA && !user.mfaEnabled && policy.required;
  const mfaSatisfied =
    !ENABLE_2FA ||
    (user.mfaEnabled && trustsMfa) ||
    (!user.mfaEnabled && !policy.required);

  const admission = await beginCfIssuance(c);
  if (admission instanceof Response) return admission;
  const capability = admission;

  // Mint a fresh refresh-token family for this login so the rotation chain
  // participates in OAuth 2.1 reuse-detection — same invariant as every
  // other authenticated mint path (see services/refreshTokenFamily.ts and
  // the /login handler this middleware short-circuits).
  const identity: UserSessionIdentity = {
      userId: user.id,
      email: user.email,
      roleId: context.roleId,
      orgId: context.orgId,
      partnerId: context.partnerId,
      scope: context.scope,
      mfa: mfaSatisfied,
      mobileDeviceId: readMobileDeviceId(c) ?? undefined,
  };

  let tokens: ReturnType<typeof toPublicTokens>;
  let installSessionCookies: () => void;
  if (capability) {
    let issued: AuthorizedUserSession;
    try {
      issued = await finishAuthIssuance(capability, async (tx) => {
        const session = await issueUserSession(identity, {
          tx,
          capability,
          expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
        });
        await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
        return session;
      });
    } catch (error) {
      await cancelAuthIssuance(capability).catch(() => undefined);
      const response = authIssuanceAdmissionError(c, error);
      if (!response) throw error;
      return response;
    }
    await bindIssuedUserSession(issued);
    tokens = toPublicTokens(issued);
    installSessionCookies = () => installAuthorizedUserSessionCookies(c, issued);
  } else {
    recordAuthTransitionLegacyIssuer('cf_access', readMobileDeviceId(c) ? 'native' : 'web');
    const issued = await issueUserSessionLegacyDuringTransition(identity);
    await withSystemDbAccessContext(() =>
      db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
    );
    tokens = toPublicTokens(issued);
    installSessionCookies = () => installLegacyUserSessionCookiesDuringTransition(c, issued);
  }

  createAuditLogAsync({
    orgId: context.orgId ?? undefined,
    actorId: user.id,
    actorEmail: user.email,
    action: 'user.login',
    resourceType: 'user',
    resourceId: user.id,
    resourceName: user.name,
    details: {
      method: 'cf_access_jwt',
      mfa: mfaSatisfied,
      scope: context.scope,
      cfAccessSub: claims.sub,
      cfAccessCountry: claims.country ?? null,
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: 'success',
  });

  installSessionCookies();

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: ENABLE_2FA ? user.mfaEnabled : false,
      avatarUrl: user.avatarUrl,
    },
    tokens,
    mfaRequired: false,
    requiresSetup: userRequiresSetup(user),
    // Same contract the password /login handler returns, so the SPA drives the
    // CF-Access user into enrollment instead of letting them bounce off a 428.
    mfaEnrollmentRequired,
    enrollUrl: mfaEnrollmentRequired ? '/auth/mfa/setup' : undefined,
  });
}
