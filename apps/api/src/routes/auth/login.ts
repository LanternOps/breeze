import { Hono, type Context, type Next } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  getActiveRefreshTokenFamily,
  issueUserSession,
  verifyToken,
  verifyPassword,
  hashPassword,
  rateLimiter,
  loginLimiter,
  getRedis,
  getRefreshTokenJtiRevocationState,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  wasRefreshTokenJtiRecentlyRotated,
  revokeFamily,
  isFamilyRevoked,
  isTokenIssuedBeforePasswordChange,
  recordAccountFailure,
  clearAccountFailures,
  isAccountLocked,
  getAccountLockoutWindowSeconds,
  decideAuthenticatedUserSession,
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  revokeAllUserTokens,
  beginAuthIssuance,
  cancelAuthIssuance,
  finishAuthIssuance,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  bindIssuedUserSession,
  RefreshTokenCurrentnessError,
  digestRefreshTokenJti,
  getRefreshRotationGraceSeconds,
} from '../../services';
import { getEmailService } from '../../services/email';
import { createHash } from 'crypto';
import { authMiddleware } from '../../middleware/auth';
import { createAuditLogAsync } from '../../services/auditService';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { TenantInactiveError } from '../../services/tenantStatus';
import { nanoid } from 'nanoid';
import { CSRF_COOKIE_NAME, ENABLE_2FA, loginSchema } from './schemas';
import {
  getClientIP,
  getClientRateLimitKey,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  clearRefreshCookieOnly,
  resolveRefreshToken,
  validateCookieCsrfRequest,
  validateTerminalCookieCsrfRequest,
  toPublicTokens,
  genericAuthError,
  isTokenRevokedForUser,
  cacheRefreshTokenFamilyRevocation,
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  auditUserLoginFailure,
  auditLogin,
  userRequiresSetup,
  getCookieValue,
  rotateCsrfBindingCookie,
  setCfAccessLogoutQuarantineCookie,
} from './helpers';
import {
  prepareTerminalLogout,
  toTerminalCleanupFailureCategories,
} from '../../services/terminalLogout';
import { assertPasswordAuthAllowedBySso, SsoPasswordAuthRequiredError } from './ssoPolicy';
import { readMobileDeviceId, carryForwardBinding } from '../../services/mobileDeviceBinding';
import { enforceIpAllowlist, IP_NOT_ALLOWED_BODY, isBlocked } from '../../services/ipAllowlist';
import { captureException } from '../../services/sentry';
import { cfAccessLoginMiddleware } from '../../middleware/cfAccessLogin';
import { getMfaAssuranceFailure, resolveEffectiveMfaPolicy } from '../../services/mfaPolicy';
import {
  revokeUserSessionFamilyForLogout,
  withAuthLifecycleSystemTransaction,
} from '../../services/authLifecycle';
import { runPostCommitCleanup } from '../../services/postCommitCleanup';
import { issueTerminalLogoutTicket } from '../../services/terminalLogoutTicket';
import { authBrowserPublicOrigin } from '../../config/env';

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
// until at least LOGIN_RESPONSE_FLOOR_MS has elapsed.
//
// Budget calibration: argon2id default params take ~100-200ms on prod
// hardware; tenant-context DB joins add ~30-80ms; rate-limit Redis ops
// add ~5-10ms. 350ms is a safe upper bound that comfortably exceeds the
// slowest legitimate path while staying well below interactive-feel
// thresholds (200ms = "instant", 500ms+ = "sluggish").
//
// Test/E2E mode skips the floor so the test suite stays fast — the unit
// tests don't measure timing, only state.
const LOGIN_RESPONSE_FLOOR_MS = 350;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loginResponseFloorPromise(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return Promise.resolve();
  if (process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true') return Promise.resolve();
  return delay(LOGIN_RESPONSE_FLOOR_MS);
}

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
    const resetToken = nanoid(48);
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    const redis = getRedis();
    if (redis) {
      await redis.setex(`reset:${tokenHash}`, 3600, user.id);
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

async function clearLogoutCookiesBeforeAuth(c: Context, next: Next): Promise<void> {
  clearRefreshTokenCookie(c);
  await next();
}

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
  // already says "this email exists" since we ran a real argon2 verify
  // above on the user-found branch, so an additional Redis GET here
  // doesn't leak any new information. Important: returning 429 even
  // when the password is correct is the whole point — a locked account
  // means "we don't trust this session right now", not "your password
  // is wrong". The lockout window expires automatically; the user can
  // also unblock themselves by completing a password reset.
  if (!e2eMode) {
    const redisForLock = getRedis();
    if (await isAccountLocked(redisForLock, normalizedEmail)) {
      void auditUserLoginFailure(c, {
        userId: user.id,
        email: user.email,
        name: user.name,
        reason: 'account_locked',
        result: 'denied',
        details: { method: 'password' }
      });
      await floorPromise;
      return c.json({
        error: 'Account temporarily locked due to repeated failed sign-ins. Try again in 15 minutes or reset your password.',
        retryAfter: getAccountLockoutWindowSeconds()
      }, 429);
    }
  }

  // Verify password
  const validPassword = await verifyPassword(user.passwordHash, password);
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
  // a precise error. Platform admins and untrusted-IP fail-open are handled
  // inside enforceIpAllowlist.
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

  // The locked live decision owns both outcomes. The password hash/change
  // timestamp/auth epoch bind this decision to the credential verified above,
  // closing enrollment and password-change races before pending or direct
  // session issuance.
  let loginDecision;
  try {
    loginDecision = await decideAuthenticatedUserSession({
      authBinding: {
        kind: 'browser',
        value: getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME) ?? '',
      },
      userId: user.id,
      roleId: context.roleId,
      orgId: context.orgId,
      partnerId: context.partnerId,
      scope: context.scope,
      primaryAuthenticationMethod: 'password',
      requireLocalMfa: ENABLE_2FA,
      mobileDeviceId: readMobileDeviceId(c) ?? undefined,
      credentialBinding: {
        kind: 'password',
        passwordHash: user.passwordHash,
        passwordChangedAt: user.passwordChangedAt ?? null,
        authEpoch: user.authEpoch,
      },
    });
  } catch (error) {
    await floorPromise;
    if (error instanceof AuthBindingRotationRequiredError) {
      rotateCsrfBindingCookie(c, error.replacement.value);
      return c.json({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }, 428);
    }
    if (error instanceof AuthBindingUnavailableError
      || error instanceof AuthIssuanceConflictError
      || error instanceof AuthIssuanceCapabilityError) {
      return c.json({ error: 'Authentication temporarily unavailable' }, 409);
    }
    if (error instanceof PendingMfaUnavailableError) {
      return c.json({ error: 'MFA verification unavailable. Please try again later.' }, 503);
    }
    if (error instanceof PendingMfaInvalidError) {
      return c.json(genericAuthError(), 401);
    }
    throw error;
  }

  if (loginDecision.kind === 'pending') {

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
      tempToken: loginDecision.tempToken,
      mfaMethod: loginDecision.primaryMfaMethod,
      // #2153: lets the login MFA screen offer "use a passkey instead" alongside
      // the primary factor's prompt when the account has a registered passkey.
      passkeyAvailable: loginDecision.passkeyAvailable,
      phoneLast4: loginDecision.phoneLast4,
      user: null,
      tokens: null
    });
  }
  const roleId = context.roleId;
  const partnerId = context.partnerId;
  const orgId = context.orgId;
  const scope = context.scope;

  const tokens = loginDecision.tokens;

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
    requiresSetup
  });
});

// Cloudflare Access logout preflight. Unlike ordinary family-scoped logout,
// this terminal flow must revoke every token for both independently verified
// subjects before clearing the origin-wide refresh cookie: a stale tab's
// access token and the shared cookie may legitimately belong to different
// accounts or different families.
loginRoutes.post('/cf-access-logout/prepare', authMiddleware, async (c) => {
  const csrfError = validateTerminalCookieCsrfRequest(c);
  if (csrfError) return c.json({ error: csrfError }, 403);

  const publicOrigin = authBrowserPublicOrigin();
  if (!publicOrigin) {
    console.error('[cf-access-logout] Refusing terminal logout preparation without a configured public application origin');
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const auth = c.get('auth');
  const bindingValue = getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME);
  if (!bindingValue || !auth.token.sid) {
    return c.json({ error: 'Invalid authentication binding' }, 403);
  }
  const refreshToken = resolveRefreshToken(c);

  let prepared;
  try {
    prepared = await prepareTerminalLogout({
      binding: { kind: 'browser', value: bindingValue },
      access: {
        userId: auth.user.id,
        familyId: auth.token.sid,
        authEpoch: auth.token.ae,
        mfaEpoch: auth.token.me,
      },
      refreshToken,
    });
  } catch (error) {
    console.error('[cf-access-logout] Refusing terminal logout preparation because the authoritative transaction failed:', error);
    void createAuditLogAsync({
      orgId: auth.orgId ?? undefined,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'auth.cf_access_terminal_logout.prepare',
      resourceType: 'auth_browser_transition',
      details: {
        transitionId: null,
        logoutId: null,
        result: 'failed',
        cleanupStatus: 'failed',
        advancedUserCount: 0,
        revokedFamilyCount: 0,
      },
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'failure',
      errorMessage: 'Durable terminal logout preparation unavailable',
    });
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  let ticket: string;
  try {
    ticket = issueTerminalLogoutTicket({
      transitionId: prepared.transitionId,
      logoutId: prepared.logoutId,
      generation: prepared.generation,
      nonce: prepared.nonce,
      issuedAt: new Date(),
      expiresAt: prepared.expiresAt,
    });
  } catch (error) {
    console.error('[cf-access-logout] Refusing terminal logout navigation because ticket issuance failed:', error);
    void createAuditLogAsync({
      orgId: auth.orgId ?? undefined,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'auth.cf_access_terminal_logout.prepare',
      resourceType: 'auth_browser_transition',
      resourceId: prepared.transitionId,
      details: {
        transitionId: prepared.transitionId,
        logoutId: prepared.logoutId,
        result: 'ticket-failed',
        cleanupStatus: prepared.cleanupStatus,
        advancedUserCount: prepared.advancedUserCount,
        revokedFamilyCount: prepared.revokedFamilyCount,
      },
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'failure',
      errorMessage: 'Terminal logout ticket issuance unavailable',
    });
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const navigationUrl = new URL('/api/v1/auth/cf-access-logout', publicOrigin);
  navigationUrl.searchParams.set('ticket', ticket);

  const cleanupFailures = toTerminalCleanupFailureCategories(prepared.cleanupFailures);
  void createAuditLogAsync({
    orgId: auth.orgId ?? undefined,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'auth.cf_access_terminal_logout.prepare',
    resourceType: 'auth_browser_transition',
    resourceId: prepared.transitionId,
    details: {
      transitionId: prepared.transitionId,
      logoutId: prepared.logoutId,
      result: 'prepared',
      cleanupStatus: prepared.cleanupStatus,
      cleanupFailures,
      advancedUserCount: prepared.advancedUserCount,
      revokedFamilyCount: prepared.revokedFamilyCount,
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: 'success',
  });

  // Install the legacy issuer barrier on this authoritative POST response.
  // Top-level GETs must never install it: duplicated navigations can arrive
  // after completion and would otherwise resurrect a stale quarantine cookie.
  setCfAccessLogoutQuarantineCookie(c);
  clearRefreshCookieOnly(c);
  return c.json({
    success: true,
    navigationUrl: navigationUrl.toString(),
    cleanupStatus: prepared.cleanupStatus,
    cleanupFailures,
  });
});

// Logout
loginRoutes.post('/logout', clearLogoutCookiesBeforeAuth, authMiddleware, async (c) => {
  const auth = c.get('auth');

  const accessFamilyId = auth.token.sid;
  if (!accessFamilyId) {
    createAuditLogAsync({
      orgId: auth.orgId ?? undefined,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'user.logout',
      resourceType: 'user',
      resourceId: auth.user.id,
      resourceName: auth.user.name,
      details: { reason: 'access_session_family_missing' },
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'denied',
    });
    return c.json({ error: 'Invalid session' }, 401);
  }

  let familyId = accessFamilyId;
  let refreshJti: string | undefined;
  const refreshToken = resolveRefreshToken(c);
  if (refreshToken) {
    const refreshPayload = await verifyToken(refreshToken);
    if (refreshPayload?.type === 'refresh' && refreshPayload.fam) {
      // A signed cookie for another user or family must never choose which row
      // this access session revokes. Reject the request instead of falling back
      // and accidentally revoking either sibling.
      if (
        refreshPayload.sub !== auth.user.id
        || refreshPayload.fam !== accessFamilyId
      ) {
        createAuditLogAsync({
          orgId: auth.orgId ?? undefined,
          actorId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'user.logout',
          resourceType: 'user',
          resourceId: auth.user.id,
          resourceName: auth.user.name,
          details: { reason: 'session_family_mismatch' },
          ipAddress: getClientIP(c),
          userAgent: c.req.header('user-agent'),
          result: 'denied',
        });
        return c.json({ error: 'Invalid session' }, 401);
      }
      familyId = refreshPayload.fam;
      refreshJti = refreshPayload.jti;
    }
  }

  let durableOutcome: 'revoked' | 'already_revoked';
  try {
    const outcome = await withAuthLifecycleSystemTransaction((tx) =>
      revokeUserSessionFamilyForLogout(tx, auth.user.id, familyId, 'logout')
    );
    if (outcome.status === 'not_found') {
      createAuditLogAsync({
        orgId: auth.orgId ?? undefined,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'user.logout',
        resourceType: 'user',
        resourceId: auth.user.id,
        resourceName: auth.user.name,
        details: { reason: 'session_family_not_found' },
        ipAddress: getClientIP(c),
        userAgent: c.req.header('user-agent'),
        result: 'denied',
      });
      return c.json({ error: 'Invalid session' }, 401);
    }
    durableOutcome = outcome.status;
  } catch (error) {
    console.error('[auth] Durable session-family revocation failed during logout:', error);
    createAuditLogAsync({
      orgId: auth.orgId ?? undefined,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'user.logout',
      resourceType: 'user',
      resourceId: auth.user.id,
      resourceName: auth.user.name,
      details: { familyId, reason: 'durable_revocation_failed' },
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'failure',
      errorMessage: 'Session revocation unavailable',
    });
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const cleanup = await runPostCommitCleanup([
    {
      name: 'refresh-family-cache',
      run: () => cacheRefreshTokenFamilyRevocation(familyId),
    },
    ...(refreshJti ? [{
      name: 'refresh-token-jti',
      run: () => revokeRefreshTokenJti(refreshJti),
    }] : []),
  ]);
  for (const failure of cleanup.failures) {
    console.error(`[auth] Logout cleanup failed (${failure.name}):`, failure.error);
  }

  createAuditLogAsync({
    orgId: auth.orgId ?? undefined,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'user.logout',
    resourceType: 'user',
    resourceId: auth.user.id,
    resourceName: auth.user.name,
    details: {
      familyId,
      durableOutcome,
      cleanupStatus: cleanup.cleanupStatus,
      cleanupFailures: cleanup.cleanupFailures,
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });

  return c.json({
    success: true,
    cleanupStatus: cleanup.cleanupStatus,
    cleanupFailures: cleanup.cleanupFailures,
  });
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
  const presentedJti: string = payload.jti;

  // PostgreSQL is authoritative for family ownership and lifecycle. Perform
  // this owner-bound preflight before any reuse marker or old-JTI claim so an
  // invalid family cannot burn the token or mint a replacement. The same
  // check remains inside issueUserSession after the claim as a race backstop.
  let preflightCurrentJtiDigest: string | null;
  let preflightPreviousJtiDigest: string | null;
  let preflightLastUsedAt: Date;
  let preflightDatabaseNow: Date;
  try {
    const activeFamily = await getActiveRefreshTokenFamily(familyId, payload.sub);
    if (!activeFamily) {
      clearRefreshTokenCookie(c);
      return c.json({ error: 'Invalid refresh token' }, 401);
    }
    preflightCurrentJtiDigest = activeFamily.currentRefreshJtiDigest;
    preflightPreviousJtiDigest = activeFamily.previousRefreshJtiDigest;
    preflightLastUsedAt = activeFamily.lastUsedAt;
    preflightDatabaseNow = activeFamily.databaseNow;
  } catch (error) {
    console.error('[auth] Refresh family preflight failed closed:', error);
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // PostgreSQL currentness is the reuse-detection authority. A non-null
  // mismatch here was already stale when this request arrived, so it may
  // revoke exactly its signed family even if Redis was flushed or the winner
  // crashed before cache cleanup. Null remains the one-time rollout upgrade.
  // A request that matches here but loses the guarded CAS later is a genuine
  // concurrent loser and must not revoke the successor that beat it.
  const presentedJtiDigest = digestRefreshTokenJti(presentedJti);
  if (
    preflightCurrentJtiDigest !== null
    && preflightCurrentJtiDigest !== presentedJtiDigest
  ) {
    const graceSeconds = getRefreshRotationGraceSeconds();
    const durableGrace = preflightPreviousJtiDigest === presentedJtiDigest
      && graceSeconds > 0
      && preflightDatabaseNow.getTime() - preflightLastUsedAt.getTime() <= graceSeconds * 1_000;
    if (durableGrace) {
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
        classification: 'durably_stale',
        reason: 'Durably stale refresh token replayed — entire family revoked',
      },
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'denied',
    });
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Only rollout-null families consult the legacy Redis JTI marker. A cache
  // outage is unknown, not proof of compromise: refuse this attempt without
  // mutating the family so the client can retry. Non-null PostgreSQL
  // currentness never consults this cache.
  const legacyJtiState = preflightCurrentJtiDigest === null
    ? await getRefreshTokenJtiRevocationState(presentedJti)
    : 'active';
  if (legacyJtiState === 'unknown') {
    return c.json({
      error: 'Service temporarily unavailable',
      reason: 'refresh_state_unavailable',
    }, 503);
  }
  if (legacyJtiState === 'revoked') {
    if (await wasRefreshTokenJtiRecentlyRotated(presentedJti)) {
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
        classification: 'legacy_revoked',
        reason: 'Revoked rollout-era refresh token replayed — entire family revoked',
      },
      ipAddress: getClientIP(c),
      userAgent: c.req.header('user-agent'),
      result: 'denied',
    });
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Redis is only the fast rejection path here; getActiveRefreshTokenFamily
  // above already checks PostgreSQL, and the final CAS repeats that check.
  if (await isFamilyRevoked(familyId)) {
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

  // Epoch changes are global sign-out boundaries. Compare the verified token
  // claims with the live user row before claiming the old jti so a stale token
  // cannot be laundered into a newly issued session.
  if (user.authEpoch !== payload.ae || user.mfaEpoch !== payload.me) {
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

  const effectiveMfaPolicy = await resolveEffectiveMfaPolicy({
    userId: user.id,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
  });
  if (getMfaAssuranceFailure(payload, effectiveMfaPolicy)) {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  const bindingValue = getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME);
  let capability;
  try {
    capability = await beginAuthIssuance({ kind: 'browser', value: bindingValue ?? '' });
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError) {
      rotateCsrfBindingCookie(c, error.replacement.value);
      return c.json({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }, 428);
    }
    if (error instanceof AuthBindingUnavailableError || error instanceof AuthIssuanceConflictError) {
      return c.json({ error: 'Refresh already in progress', reason: 'refresh_raced' }, 409);
    }
    throw error;
  }

  // Finalization owns the transition lock before user and family locks. The
  // family digest compare/swap and successor signing commit together.
  let tokens: Awaited<ReturnType<typeof issueUserSession>>;
  try {
    tokens = await finishAuthIssuance(capability, (tx) => issueUserSession({
        userId: user.id,
        email: user.email,
        roleId: context.roleId,
        orgId: context.orgId,
        partnerId: context.partnerId,
        scope: context.scope,
        mfa: payload.mfa,
        amr: payload.amr,
        // Preserve the signed device binding; headers cannot drop it.
        mobileDeviceId: carryForwardBinding(payload),
      }, {
        tx,
        capability,
        familyId,
        refreshRotation: {
          presentedJti,
          authEpoch: payload.ae,
          mfaEpoch: payload.me,
        },
      }));
  } catch (error) {
    await cancelAuthIssuance(capability).catch(() => false);
    if (!(error instanceof RefreshTokenCurrentnessError)) throw error;
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Redis is an accelerator only. These effects intentionally occur after the
  // PostgreSQL commit and cannot reactivate or invalidate durable currentness.
  await markRefreshTokenJtiRotated(payload.jti);
  await revokeRefreshTokenJti(payload.jti).catch((error) => {
    console.warn('[auth] Post-commit refresh JTI cache cleanup failed:', error);
  });
  void bindIssuedUserSession(tokens);

  setRefreshTokenCookie(c, tokens.refreshToken);
  // Bind the rotated credentials to the server-verified account. The refresh
  // cookie is origin-wide, while browser stores are tab-local; clients must
  // never attach this token to a stale tab's different user projection.
  return c.json({ userId: user.id, tokens: toPublicTokens(tokens) });
});
