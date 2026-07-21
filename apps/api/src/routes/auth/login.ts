import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  createTokenPair,
  verifyToken,
  verifyPassword,
  hashPassword,
  rateLimiter,
  loginLimiter,
  getRedis,
  isRefreshTokenJtiRevoked,
  revokeAllUserTokens,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  wasRefreshTokenJtiRecentlyRotated,
  revokeFamily,
  isFamilyRevoked,
  touchFamilyLastUsed,
  isTokenIssuedBeforePasswordChange,
  mintRefreshTokenFamily,
  bindRefreshJtiToFamily,
  recordAccountFailure,
  clearAccountFailures,
  isAccountLocked,
  getAccountLockoutWindowSeconds,
  getUserEpochs,
  getRefreshFamily
} from '../../services';
import { advanceUserEpochs, revokeRefreshFamilyById } from '../../services/authLifecycle';
import { getEmailService } from '../../services/email';
import { createHash } from 'crypto';
import { authMiddleware } from '../../middleware/auth';
import { createAuditLogAsync } from '../../services/auditService';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { TenantInactiveError } from '../../services/tenantStatus';
import { nanoid } from 'nanoid';
import { ENABLE_2FA, loginSchema } from './schemas';
import {
  getClientIP,
  getClientRateLimitKey,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  resolveRefreshToken,
  validateCookieCsrfRequest,
  toPublicTokens,
  genericAuthError,
  isTokenRevokedForUser,
  revokeCurrentRefreshTokenJti,
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  auditUserLoginFailure,
  auditLogin,
  userRequiresSetup,
  userHasUsablePasskey,
  authResponseFloorPromise,
  mintLoginRegisterGrant
} from './helpers';
import { assertPasswordAuthAllowedBySso, SsoPasswordAuthRequiredError } from './ssoPolicy';
import { readMobileDeviceId, carryForwardBinding } from '../../services/mobileDeviceBinding';
import { enforceIpAllowlist, IP_NOT_ALLOWED_BODY, isBlocked } from '../../services/ipAllowlist';
import { captureException } from '../../services/sentry';
import { cfAccessLoginMiddleware } from '../../middleware/cfAccessLogin';
import { dbWriteExpectingRows } from '../../db/dbWriteExpectingRows';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';

const { db, withSystemDbAccessContext } = dbModule;

// Lazily-computed dummy argon2id hash used to constant-time the
// user-not-found branch of the login handler. The first miss after
// startup computes and caches it; every miss after that reuses the same
// hash. Without this, response timing reveals whether an email exists
// in the users table (hit runs verifyPassword → ~100-500ms argon2; miss
// returns immediately → ~1ms), trivially enabling email enumeration.
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hashPassword('__login-timing-dummy-never-matches__');
  }
  return dummyPasswordHashPromise;
}

// Task 11: floor-the-clock timing equalizer for /login (audit finding H-4).
//
// The dummy-argon2 verify above equalizes the *password-check phase*. But
// the slowest legitimate denial path (real user with SSO-only enforcement
// or inactive tenant) ALSO runs resolveCurrentUserTokenContext(), which
// does multiple DB joins across partner_users / organization_users /
// organizations / sso_providers — adding ~30-80ms over the cheap
// "unknown email" branch. That delta is observable by a remote attacker
// and lets them distinguish "real user with SSO enforced" from "no such
// user" by measuring response latency.
//
// Rather than try to dummy-resolve a sentinel context on the miss branch
// (fragile — any new denial branch added later silently regresses the
// equalization), we floor the entire handler's wall-clock latency at a
// fixed budget. Every response (success, 401, 429, MFA-required) waits
// until the shared AUTH_RESPONSE_FLOOR_MS budget has elapsed.
//
// SR2-22 shares this exact equalizer (now `authResponseFloorPromise` in
// ./helpers) with /forgot-password rather than defining a second one.
const loginResponseFloorPromise = authResponseFloorPromise;

// Task 10 helper: bump the per-account failure counter, and if THIS
// attempt is the one that crossed the lockout threshold, fire a security
// notification email + audit event exactly once. Pulled into a helper so
// the login handler stays readable; called fire-and-forget so the user
// still gets their 401 promptly.
async function recordAccountFailureAndMaybeNotify(
  c: Context,
  user: { id: string; email: string; name?: string | null },
  normalizedEmail: string
): Promise<void> {
  try {
    const result = await recordAccountFailure(getRedis(), normalizedEmail);
    if (!result.newlyLocked) return;

    // Audit the lockout itself (separate from the normal `user.login.failed`
    // audit row that the caller already emits). Lets ops correlate the
    // lockout event with the surrounding failure pattern.
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name ?? undefined,
      reason: 'account_locked',
      result: 'denied',
      details: {
        method: 'password',
        consecutiveFailures: result.count,
        action: 'auth.login.account_locked',
        lockoutWindowSeconds: getAccountLockoutWindowSeconds()
      }
    });

    // Mint a single-use password-reset token + URL so the email gives the
    // user a path back in without waiting out the lockout window. Reuses
    // the same `reset:<hash>` Redis convention as /forgot-password. 1h TTL
    // matches that endpoint.
    //
    // SR2-08: same generation+email envelope as /forgot-password. Pre-auth
    // path (no ambient DB context) — wrap the epoch advance in the system
    // context, same reasoning as /forgot-password.
    const resetToken = nanoid(48);
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    const redis = getRedis();
    if (redis) {
      const gen = await withSystemDbAccessContext(() =>
        db.transaction(async (tx) => advanceUserEpochs(tx, user.id, { passwordReset: true }))
      );
      const envelope = {
        userId: user.id,
        passwordResetEpoch: gen.passwordResetEpoch,
        // The lockout path only has the user's live email (not a
        // request-supplied address) — this is always the current one.
        email: user.email.toLowerCase(),
      };
      await redis.setex(`reset:${tokenHash}`, 3600, JSON.stringify(envelope));
    }
    const appBaseUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
    const resetUrl = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

    const emailService = getEmailService();
    if (emailService) {
      try {
        await emailService.sendAccountLocked({
          to: user.email,
          name: user.name ?? undefined,
          resetUrl,
          lockoutMinutes: Math.round(getAccountLockoutWindowSeconds() / 60)
        });
      } catch (err) {
        console.error('[auth] Failed to send account-locked email:', err);
      }
    } else {
      console.warn('[auth] Email service not configured; account-locked email was not sent');
    }
  } catch (err) {
    console.error('[auth] recordAccountFailureAndMaybeNotify failed:', err);
  }
}

export const loginRoutes = new Hono();

// Login. cfAccessLoginMiddleware runs first; on a valid Cloudflare Access JWT
// it short-circuits with a minted session. On any failure (trust disabled,
// header absent, invalid JWT, JWKS down, user not found, etc.) it calls
// next() and the password handler below validates the body normally.
// See Discussion #702 and apps/api/src/middleware/cfAccessLogin.ts.
loginRoutes.post('/login', cfAccessLoginMiddleware, zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const ip = getClientIP(c);
  const rateLimitClient = getClientRateLimitKey(c);
  const normalizedEmail = email.toLowerCase();

  // Task 11: kick off the timing-floor promise at the very top so every
  // branch below — including the cheap "no Redis" 503 and the cheap
  // "unknown email" 401 — is measured against the same starting line.
  // Every return path awaits this before responding; the 503 (Redis-down)
  // branch awaits it too so attackers can't observationally distinguish
  // "Redis is down right now" from any other denial outcome.
  const floorPromise = loginResponseFloorPromise();

  // Rate limit by IP + email combination - fail closed for security
  // In E2E mode, skip rate limiting entirely
  const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';
  if (!e2eMode) {
    const redis = getRedis();
    if (!redis) {
      await floorPromise;
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    // First, IP-only bucket — guards against credential stuffing where the
    // attacker rotates email each attempt to keep the per-(IP,email) bucket
    // fresh. Tightened in Task 10 from 30 to 10 attempts per 5min per IP:
    // an RMM admin console has no legitimate use-case for double-digit
    // login attempts in 5 minutes from one IP, and against a moderate
    // botnet (50 IPs × 10/5min = 6,000/hr vs the prior 18,000/hr) this
    // is a meaningful cut. Real shared-NAT users still get 10 attempts
    // before they're forced to wait — well above any human's miss rate.
    const ipRateKey = `login:ip:${ip}`;
    const ipRateCheck = await rateLimiter(redis, ipRateKey, 10, 5 * 60);
    if (!ipRateCheck.allowed) {
      recordFailedLogin('rate_limited_ip');
      // Task 11: floor rate-limit responses too. Without this, the
      // attacker can detect whether they've crossed the per-IP bucket
      // (cheap rate-limit 429, ~5ms) vs the per-(IP,email) bucket
      // (cheap, ~5ms) vs a real password check (~200ms). Flooring keeps
      // all 4xx responses indistinguishable.
      await floorPromise;
      return c.json({
        error: 'Too many login attempts. Please try again later.',
        retryAfter: Math.ceil((ipRateCheck.resetAt.getTime() - Date.now()) / 1000)
      }, 429);
    }

    const rateKey = `login:${rateLimitClient}:${normalizedEmail}`;
    const rateCheck = await rateLimiter(redis, rateKey, loginLimiter.limit, loginLimiter.windowSeconds);

    if (!rateCheck.allowed) {
      recordFailedLogin('rate_limited_account');
      await floorPromise;
      return c.json({
        error: 'Too many login attempts. Please try again later.',
        retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
      }, 429);
    }
  }

  // Find user — pre-auth lookup, must run under system scope since no
  // request context has set breeze.scope yet. The `users` table is under
  // RLS; without this wrap the lookup returns empty for real emails under
  // breeze_app, and login would always 401 regardless of password.
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1)
  );

  if (!user || !user.passwordHash) {
    // Constant-time response: run one argon2 verify against a dummy hash
    // so the handler's latency matches the found-user branch. This blunts
    // email enumeration via timing side-channel. We deliberately do NOT
    // bump the per-account failure counter here — that would let an
    // attacker lock arbitrary emails out of the system just by knowing
    // them, turning a security control into a DoS amplifier.
    await verifyPassword(await getDummyPasswordHash(), password).catch(() => false);
    if (user) {
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'password_auth_not_available',
        details: { method: 'password' }
      });
    }
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }

  // Task 10: per-account lockout check. Runs AFTER the user lookup so
  // a locked vs unlocked email isn't observable via timing — the timing
  // already says "this email exists" since we run a real argon2 verify
  // below on the user-found branch, so an additional Redis GET here
  // doesn't leak any new information. Important: DENYING the login even
  // when the password is correct is the whole point — a locked account
  // means "we don't trust this session right now", not "your password
  // is wrong". The response shape is the generic 401 (SR2-23), but the
  // denial stands. The lockout window expires automatically; the user can
  // also unblock themselves by completing a password reset.
  //
  // SR2-23: this is a FLAG, not an early return. The old code short-circuited
  // here, which meant a locked account skipped the argon2 verify below and
  // answered measurably sooner than a live account whenever argon2 outruns the
  // wall-clock floor — moving the enumeration oracle from the body into the
  // latency. Both denial paths now do identical work: one Redis GET, one argon2
  // verify, one floored 401.
  const accountLocked = e2eMode
    ? false
    : await isAccountLocked(getRedis(), normalizedEmail);

  // Verify password. Runs unconditionally — see the SR2-23 note above; the
  // result is discarded on the locked branch (a locked account is denied
  // regardless of whether the password was right).
  const validPassword = await verifyPassword(user.passwordHash, password);

  if (accountLocked) {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'account_locked',
      result: 'denied',
      details: { method: 'password' }
    });
    // SR2-23: the public response is the SAME generic 401 an unknown email or
    // a wrong password gets — same status, same body, same headers, floored on
    // the same clock. The previous `429 { error: 'Account temporarily locked…',
    // retryAfter }` was a pure account-existence oracle: unknown emails never
    // lock (we deliberately do not bump their failure counter — see the miss
    // branch above), so seeing that body proved the address had an account
    // without ever guessing the password.
    //
    // The owner is still told — out of band, in the lockout email that
    // recordAccountFailureAndMaybeNotify already sends to the address itself,
    // which is the only channel that proves ownership. Ops still get the audit
    // row + the anomaly metric. Only the attacker loses a signal.
    //
    // We deliberately do NOT bump the failure counter here: an already-locked
    // account re-bumping on every attempt would let an attacker hold a victim
    // locked out indefinitely, turning the control into a DoS amplifier.
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }

  if (!validPassword) {
    // Task 10: bump the per-account failure counter. If THIS attempt is
    // the one that crosses the threshold, fire the lockout-notice email
    // exactly once (newlyLocked flag). The audit log records the
    // `account_locked` event so ops can correlate lockouts with the
    // surrounding failed-login pattern. Fire-and-forget — never blocks
    // the response (we still want the generic 401 to come back fast).
    if (!e2eMode) {
      void recordAccountFailureAndMaybeNotify(c, user, normalizedEmail);
    }
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'invalid_password',
      details: { method: 'password' }
    });
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }

  // Check account status. Avoid response-content differentiation here: a
  // distinct 403 "Account is not active" lets attackers enumerate which
  // emails are valid + active vs suspended. Return the SAME generic 401
  // used for invalid creds, but keep the rich audit trail (status, reason)
  // so ops can still see why a real user was bounced.
  if (user.status !== 'active') {
    // #719 residual 2: auditUserLoginFailure feeds the anomaly metric
    // (recordFailedLogin) internally, so repeated inactive-account login
    // denials are alertable WITHOUT double-counting. Server-side counter
    // only — the response stays a generic 401, so this leaks nothing to
    // the client.
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'account_inactive',
      result: 'denied',
      details: { accountStatus: user.status, method: 'password' }
    });
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }

  // Look up user's partner/org context
  let context;
  try {
    context = await resolveCurrentUserTokenContext(user.id);
    await assertPasswordAuthAllowedBySso(context);
  } catch (err) {
    if (
      !(err instanceof TenantInactiveError) &&
      !(err instanceof SsoPasswordAuthRequiredError) &&
      !(err instanceof NoTenantMembershipError)
    ) throw err;
    // #719 residual 2: auditUserLoginFailure feeds the anomaly metric
    // (recordFailedLogin) internally, so a sudden spike in inactive-tenant
    // denials (e.g. a billing-state change trapping a cohort of users) is
    // alertable WITHOUT double-counting. Metric only — the client still
    // gets the generic 401.
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: err instanceof SsoPasswordAuthRequiredError ? 'sso_required' : 'tenant_inactive',
      result: 'denied',
      details: { method: 'password' }
    });
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }

  // Partner IP allowlist: block before issuing tokens so the login form shows
  // a precise error. Platform admins bypass; an untrusted/undeterminable
  // client IP now FAILS CLOSED (deny) inside enforceIpAllowlist (SR2-16).
  let ipDecision;
  try {
    ipDecision = await enforceIpAllowlist(c, {
      partnerId: context.partnerId,
      isPlatformAdmin: user.isPlatformAdmin === true,
      actorId: user.id,
      actorEmail: user.email,
    });
  } catch (err) {
    console.error('[auth] IP allowlist check failed during login:', err);
    captureException(err, c);
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }
  if (isBlocked(ipDecision)) {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'ip_not_allowed',
      result: 'denied',
      details: { method: 'password' },
    });
    await floorPromise;
    return c.json(IP_NOT_ALLOWED_BODY, 403);
  }

  // Check if MFA is required. This happens after the SSO-only check so an
  // org-enforced SSO user cannot obtain an MFA temp token through password auth.
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms' || user.mfaMethod === 'passkey')) {
    const tempToken = nanoid(32);
    const mfaMethod = user.mfaMethod || 'totp';

    // #2153: a passkey is a valid ALTERNATE second factor even when the
    // account's primary `mfaMethod` is totp/sms. Registering a passkey
    // deliberately does NOT clobber an existing totp/sms `mfaMethod` (see
    // passkeys.ts register/verify — that would strand the working
    // authenticator and risk lockout), so login must independently detect
    // whether the account has any usable passkey and offer it as a choice.
    // This ADDS an option; it never removes the primary factor's prompt.
    // The helper reads under system scope (pre-auth) and fails closed — a
    // probe error hides the alternate, it never blocks this login.
    const passkeyAvailable = await userHasUsablePasskey(user.id);

    // SR2-06: bind the pending record to the live auth/mfa epochs + status +
    // effective allowed methods at login time, so every completion path
    // (mfa.ts TOTP/SMS, passkeys.ts) can detect a factor/status change that
    // happened during the 5-minute MFA window and reject rather than mint
    // stale assurance.
    const pendingEpochs = await getUserEpochs(user.id);
    if (!pendingEpochs) {
      await floorPromise;
      return c.json(genericAuthError(), 401);
    }
    const pendingPolicy = await getEffectiveMfaPolicy({
      scope: context.scope, userId: user.id, orgId: context.orgId, partnerId: context.partnerId,
    });
    const PENDING_TTL_SECONDS = 300;
    const pendingRecord = {
      userId: user.id,
      mfaMethod,
      // Server-authoritative: the passkey MFA endpoints gate on this flag, so
      // the client can't self-elevate to the passkey path without an actually
      // registered credential (and /verify still re-checks credential
      // ownership + assertion regardless).
      passkeyAvailable,
      authEpoch: pendingEpochs.authEpoch,
      mfaEpoch: pendingEpochs.mfaEpoch,
      statusExpectation: user.status,
      allowedMethods: pendingPolicy.allowedMethods,
      expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000,
    };
    await getRedis()!.setex(`mfa:pending:${tempToken}`, PENDING_TTL_SECONDS, JSON.stringify(pendingRecord));

    // Task 10: the password was verified correctly — clear the per-account
    // failure counter even though MFA still has to succeed. This keeps the
    // counter honestly measuring "consecutive failed *password* attempts",
    // which is the threat the lockout is designed to mitigate. MFA brute
    // force is gated separately by mfaLimiter.
    if (!e2eMode) {
      void clearAccountFailures(getRedis(), normalizedEmail).catch((err) => {
        console.error('[auth] clear failures failed (mfa branch):', err);
      });
    }

    // Task 11: floor the MFA-required response too. Otherwise "your
    // password was right, MFA is next" returns measurably faster than
    // any 401 path, leaking which emails have valid creds without MFA
    // enrolled vs with — useful intel for an attacker pivoting from a
    // password-stuffing list.
    await floorPromise;
    return c.json({
      mfaRequired: true,
      tempToken,
      mfaMethod,
      // #2153: lets the login MFA screen offer "use a passkey instead" alongside
      // the primary factor's prompt when the account has a registered passkey.
      passkeyAvailable,
      phoneLast4: user.phoneNumber?.slice(-4) || null,
      user: null,
      tokens: null
    });
  }
  const roleId = context.roleId;
  const partnerId = context.partnerId;
  const orgId = context.orgId;
  const scope = context.scope;

  // Resolve effective policy. A user who reaches here is NOT MFA-enrolled (the
  // enrolled branch above returns early). If policy requires MFA we must NOT
  // grant vacuous assurance: mint mfa=false and tell the client to enroll. The
  // middleware exempt paths (/auth/mfa/*, /users/me) still admit the enrollment
  // flow; every other route 428s until they enroll.
  const policy = await getEffectiveMfaPolicy({ scope, userId: user.id, orgId, partnerId });
  const mfaEnrollmentRequired = ENABLE_2FA && !user.mfaEnabled && policy.required;
  const mfaSatisfied = !ENABLE_2FA || (!user.mfaEnabled && !policy.required);

  // Task 7: mint a fresh refresh-token family for this login. The family id
  // is embedded in the refresh token's `fam` claim and tracked in
  // refresh_token_families. Every subsequent /refresh inherits this family;
  // if a revoked jti from this chain is ever replayed, the WHOLE chain
  // (every descendant + the current valid token) gets revoked, not just the
  // replayed jti — closing the OAuth 2.1 token-reuse race described in
  // RFC 9700 §4.13.2.
  //
  // The helper is shared by every authenticated token-mint path (login,
  // mfa-verify, register-partner, accept-invite, sso) — one source of
  // truth so no future path can quietly opt out of reuse-detection.
  const familyId = await mintRefreshTokenFamily(user.id);

  // Epochs are the DB-authoritative source for aep/mep — never trust caller
  // input. A null read means the user row vanished between the earlier
  // lookup and here (deleted mid-request); fail closed with the same
  // generic 401 every other login failure returns rather than leak which
  // stage failed.
  const epochs = await getUserEpochs(user.id);
  if (!epochs) {
    await floorPromise;
    return c.json(genericAuthError(), 401);
  }

  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope,
    mfa: mfaSatisfied,
    aep: epochs.authEpoch,
    mep: epochs.mfaEpoch,
    // SR-001: bind the token to the mobile install id when the client sends
    // it. Web/SSO clients don't send the header → mdid stays absent → no
    // behaviour change for them.
    mdid: readMobileDeviceId(c) ?? undefined
  }, { refreshFam: familyId });

  // Record the jti → family mapping in Redis for hot-path /refresh lookup.
  // Best-effort: the family id is also encoded in the JWT, so a Redis miss
  // still works via the verified claim.
  await bindRefreshJtiToFamily(tokens.refreshJti, familyId);

  // Update last login. MUST run inside a system DB context: /login is an
  // unauthenticated route, so no breeze.user_id/partner/org GUC is set and the
  // `users` RLS UPDATE policy would match 0 rows silently under breeze_app —
  // the bug that froze last_login_at platform-wide (#1375). System scope
  // satisfies RLS the same way the pre-auth user lookup above does.
  await withSystemDbAccessContext(() =>
    dbWriteExpectingRows('users.last_login_at', () =>
      db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id))
        .returning({ id: users.id })
    )
  );

  // Task 10: clear the per-account failure counter on successful login so
  // a real user with one fat-finger doesn't slowly approach a lockout over
  // weeks of normal usage. Best-effort — a Redis error here logs but
  // doesn't fail the login (the counter expires naturally at the end of
  // the 15-minute window anyway).
  if (!e2eMode) {
    void clearAccountFailures(getRedis(), normalizedEmail).catch((err) => {
      console.error('[auth] clear failures failed:', err);
    });
  }

  auditLogin(c, { orgId: orgId ?? null, userId: user.id, email: user.email, name: user.name, mfa: false, scope, ip });

  setRefreshTokenCookie(c, tokens.refreshToken);

  const requiresSetup = userRequiresSetup(user);

  // Task 11: floor the success response too. If success returned faster
  // than every 401 branch, an attacker could observe "correct credentials"
  // by latency alone even though the response body is the same JSON
  // shape. The floor is calibrated above the slowest legitimate denial
  // path so a successful login is no faster than any other outcome.
  await floorPromise;

  // #2707: mobile-only best-effort mint of a register_approver_device grant,
  // so the app can register its approver key promptlessly right after login.
  // Gated inside mintLoginRegisterGrant on the mobile device-id header — web
  // logins never get a value here.
  const authenticatorRegisterGrantId = await mintLoginRegisterGrant(c, user.id, familyId);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: ENABLE_2FA ? user.mfaEnabled : false,
      avatarUrl: user.avatarUrl,
      // The web sidebar gates platform-admin-only nav (and its badge fetch) on
      // this flag from the auth store, which is seeded from THIS payload on
      // password login — omit it and platform admins lose that nav entirely.
      isPlatformAdmin: user.isPlatformAdmin === true
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false,
    requiresSetup,
    mfaEnrollmentRequired,
    enrollUrl: mfaEnrollmentRequired ? '/auth/mfa/setup' : undefined,
    ...(authenticatorRegisterGrantId ? { authenticatorRegisterGrantId } : {})
  });
});

// Logout
loginRoutes.post('/logout', authMiddleware, async (c) => {
  const auth = c.get('auth');
  // Resolve the family: access-token `sid` is authoritative; fall back to the
  // refresh cookie's verified `fam` when present.
  let familyId: string | null = auth.token.sid ?? null;
  if (!familyId) {
    const refreshToken = resolveRefreshToken(c);
    if (refreshToken) {
      const rp = await verifyToken(refreshToken);
      familyId = rp?.type === 'refresh' ? (rp.fam ?? null) : null;
    }
  }

  let durableOk = true;
  if (familyId) {
    try {
      // Self-revocation: the request context's userId IS this user, so the
      // user-id-scoped refresh_token_families RLS policy admits the write —
      // the ambient db.transaction is fine here (unlike Task 9's admin paths).
      await db.transaction(async (tx) => {
        await revokeRefreshFamilyById(tx, familyId!, 'logout');
      });
    } catch (error) {
      durableOk = false;
      console.error('[auth] Durable logout revocation failed:', error);
    }
  }

  // Post-commit best-effort Redis cleanup — same scope as today's logout
  // (user-wide access-token cutoff + current refresh jti). Deliberately NOT
  // runPostCommitCleanup: logout must not sweep the user's MCP OAuth grants.
  try {
    await revokeAllUserTokens(auth.user.id);
    await revokeCurrentRefreshTokenJti(c, auth.user.id);
  } catch (error) {
    console.error('[auth] Logout Redis cleanup failed (durable revocation state above):', error);
  }

  // Always clear the local cookie — even on durable failure the client should
  // drop its credential; the durable revoke is retried by ops via the audit.
  // Runs BEFORE the audit write so "cookie always cleared" holds even against
  // a synchronous throw from the audit call.
  clearRefreshTokenCookie(c);

  createAuditLogAsync({
    orgId: auth.orgId ?? undefined,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'user.logout',
    resourceType: 'user',
    resourceId: auth.user.id,
    resourceName: auth.user.name,
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: durableOk ? 'success' : 'failure',
    details: durableOk ? undefined : { reason: 'durable_revocation_failed', familyId },
  });

  if (!durableOk) {
    return c.json({ error: 'Logout could not be fully completed. Please try again.' }, 500);
  }
  return c.json({ success: true });
});

// Refresh token
loginRoutes.post('/refresh', async (c) => {
  const refreshToken = resolveRefreshToken(c);

  if (!refreshToken) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const csrfError = validateCookieCsrfRequest(c);
  if (csrfError) {
    clearRefreshTokenCookie(c);
    return c.json({ error: csrfError }, 403);
  }

  const payload = await verifyToken(refreshToken);

  if (!payload || payload.type !== 'refresh' || !payload.jti) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // #917 L-1: hard-reject refresh tokens minted before the family/reuse-detection
  // rollout (Task 7). A token without a `fam` claim pre-dates families and would
  // silently skip family-wide reuse-detection — an attacker replaying a stolen
  // legacy token could keep refreshing undetected. The backwards-compat window
  // was time-gated to one refresh-token TTL (7d) past the rollout; that window
  // has now elapsed, so every still-valid refresh token carries a `fam`. Reject
  // the claimless remainder rather than fall through to the legacy per-jti path.
  //
  // Emit a counter so the cohort is observable: this rejection's safety rests on
  // the compat window having fully closed. A non-trivial `refresh_fam_missing`
  // rate in production would mean that assumption is wrong (clock skew, a late-
  // upgraded self-hosted instance) and real users are being silently logged out
  // — this metric is the only signal that distinguishes that from ordinary
  // expiry, since the response is a generic 401 like every other invalid token.
  if (!payload.fam) {
    recordFailedLogin('refresh_fam_missing');
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Rate limit per user — 10 refreshes per minute
  const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';
  if (!e2eMode) {
    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    const refreshRateKey = `refresh:${payload.sub}`;
    const refreshRateCheck = await rateLimiter(redis, refreshRateKey, 10, 60);
    if (!refreshRateCheck.allowed) {
      return c.json({
        error: 'Too many refresh attempts. Please try again later.',
        retryAfter: Math.ceil((refreshRateCheck.resetAt.getTime() - Date.now()) / 1000)
      }, 429);
    }
  }

  // Task 7: the family id comes from the verified JWT claim (`fam`) — it's
  // cryptographically signed and can't be tampered with. The claimless legacy
  // path was retired in #917 L-1 (rejected above), so every token reaching here
  // carries a family and the Redis jti→family fallback is no longer needed.
  const familyId: string = payload.fam;

  // Reuse detection: if this jti has already been revoked AND we have a
  // family id, this is a replay of an old (rotated) refresh token. Kill the
  // whole family + write an audit row + return 401. Without this check the
  // attacker's later jti would still be valid even after the legitimate
  // user's next rotation.
  const jtiAlreadyRevoked = await isRefreshTokenJtiRevoked(payload.jti);
  if (jtiAlreadyRevoked) {
    // Distinguish a benign concurrent/double-fired refresh from a true
    // token-reuse attack. The same cookie replayed within seconds of its own
    // legitimate rotation (multiple tabs sharing the cookie jar, the periodic
    // heartbeat refresh, or a page reload fired while a refresh was already in
    // flight) is NOT an attack: the winning sibling already minted a fresh
    // cookie this browser shares. We must NOT revoke the family and must NOT
    // clear the cookie — clearing it would wipe the winner's valid token and
    // log the user out (issue #1107). The loser just retries and picks up the
    // winner's new token. Only a replay OUTSIDE the grace window (an old,
    // long-rotated jti) is treated as reuse and kills the family.
    if (await wasRefreshTokenJtiRecentlyRotated(payload.jti)) {
      return c.json({ error: 'Refresh already in progress', reason: 'refresh_raced' }, 401);
    }
    await revokeFamily(familyId, 'reuse-detected');
    createAuditLogAsync({
      actorType: 'user',
      actorId: payload.sub,
      actorEmail: payload.email,
      action: 'auth.refresh.reuse_detected',
      resourceType: 'refresh_token_family',
      resourceId: familyId,
      details: {
        replayedJti: payload.jti,
        reason: 'Revoked refresh-token JTI replayed — entire family revoked',
      },
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'denied',
    });
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Family-revoked sentinel check: covers the descendant case. If a sibling
  // refresh on this family already triggered reuse-detection, this token —
  // although its own jti hasn't been revoked — must also fail.
  if (await isFamilyRevoked(familyId)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Belt-and-braces: isFamilyRevoked above may be answered from its Redis
  // sentinel, which can lag the durable Postgres row. getRefreshFamily reads
  // the authoritative row directly — cheap here since /refresh already reads
  // Postgres for the user lookup below — and also enforces the absolute
  // (non-sliding) expiry on the family.
  const familyRow = await getRefreshFamily(familyId);
  if (!familyRow || familyRow.revokedAt !== null || familyRow.absoluteExpiresAt.getTime() <= Date.now()) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  if (await isTokenRevokedForUser(payload.sub, payload.iat)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Check if user still exists and is active — pre-auth, wrap in system scope.
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        passwordChangedAt: users.passwordChangedAt,
        authEpoch: users.authEpoch,
        mfaEpoch: users.mfaEpoch,
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)
  );

  if (!user || user.status !== 'active') {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  if (isTokenIssuedBeforePasswordChange(payload.iat, user.passwordChangedAt)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Epoch gate: a refresh token minted before an auth/mfa state change must not
  // rotate into a fresh access token (deliberate global sign-out). Legacy tokens
  // lack aep/mep entirely → undefined !== number → rejected. Placed BEFORE the
  // jti rotation-claim dance below so a denied refresh never burns rotation state.
  if (payload.aep !== user.authEpoch || payload.mep !== user.mfaEpoch) {
    recordFailedLogin('refresh_epoch_mismatch');
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  let context;
  try {
    context = await resolveCurrentUserTokenContext(user.id);
  } catch (err) {
    // A membership-less / non-admin user (membership revoked mid-session) must
    // not be able to refresh into a system-scope token. Fail closed. (sec review #2)
    if (!(err instanceof TenantInactiveError) && !(err instanceof NoTenantMembershipError)) throw err;
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Task 7: revoke the OLD jti BEFORE minting the new token, not after. This
  // closes a TOCTOU window — a concurrent /refresh racing on the same cookie
  // would otherwise both see "jti not revoked" and both mint new pairs.
  // Revocation failing OR the claim being lost to a concurrent /refresh means
  // we must NOT issue a new cookie. `revokeRefreshTokenJti` returns false when
  // the jti was already claimed (NX failed) — that proves another /refresh
  // raced us, so the legitimate path is to refuse and let the loser retry.
  // Drop the rotation-grace marker BEFORE revoking the old jti so it is
  // already present whenever the revoked state becomes visible to a concurrent
  // racer (see the reuse-detection branch above, issue #1107).
  await markRefreshTokenJtiRotated(payload.jti);

  let claimedRevocation: boolean;
  try {
    claimedRevocation = await revokeRefreshTokenJti(payload.jti);
  } catch (error) {
    console.error('[auth] Refusing to mint refresh token — old jti revocation failed:', error);
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
  if (!claimedRevocation) {
    // Another /refresh already revoked this jti — the legitimate client
    // double-fired the same cookie (multi-tab, heartbeat, reload-mid-flight).
    // We lost the race, so we must not mint a new pair, but we must also NOT
    // clear the cookie: the winning sibling already set a fresh cookie this
    // browser shares, and clearing it would log the user out (#1107). Surface
    // a distinct reason so the client retries rather than redirecting to login.
    return c.json({ error: 'Refresh already in progress', reason: 'refresh_raced' }, 401);
  }

  // Create new token pair. The rotated refresh token inherits the family from
  // the verified `fam` claim so reuse-detection follows the whole chain.
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: ENABLE_2FA ? payload.mfa : false,
    aep: user.authEpoch,
    mep: user.mfaEpoch,
    // SR-001: preserve the device binding from the prior (signed) refresh
    // token. Deliberately NOT re-read from the header — a refresh must not be
    // able to drop the binding by omitting it.
    mdid: carryForwardBinding(payload)
  }, { refreshFam: familyId });

  // Map the newly-minted jti to the same family so a future replay of THIS
  // jti can also be detected via Redis. Best-effort; the JWT `fam` claim
  // is the primary record.
  await bindRefreshJtiToFamily(tokens.refreshJti, familyId);
  // Telemetry: bump lastUsedAt on the family row. Fire-and-forget — never
  // blocks the refresh.
  void touchFamilyLastUsed(familyId);

  setRefreshTokenCookie(c, tokens.refreshToken);
  return c.json({ tokens: toPublicTokens(tokens) });
});
