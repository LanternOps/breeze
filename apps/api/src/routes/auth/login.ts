import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
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
  getFamilyForJti,
  revokeFamily,
  isFamilyRevoked,
  touchFamilyLastUsed,
  mintRefreshTokenFamily,
  bindRefreshJtiToFamily,
  recordAccountFailure,
  clearAccountFailures,
  isAccountLocked,
  getAccountLockoutWindowSeconds
} from '../../services';
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
  auditUserLoginFailure,
  auditLogin,
  userRequiresSetup
} from './helpers';
import { assertPasswordAuthAllowedBySso, SsoPasswordAuthRequiredError } from './ssoPolicy';
import { readMobileDeviceId, carryForwardBinding } from '../../services/mobileDeviceBinding';
import { cfAccessLoginMiddleware } from '../../middleware/cfAccessLogin';

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
    if (!(err instanceof TenantInactiveError) && !(err instanceof SsoPasswordAuthRequiredError)) throw err;
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

  // Check if MFA is required. This happens after the SSO-only check so an
  // org-enforced SSO user cannot obtain an MFA temp token through password auth.
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms')) {
    const tempToken = nanoid(32);
    const mfaMethod = user.mfaMethod || 'totp';
    await getRedis()!.setex(`mfa:pending:${tempToken}`, 300, JSON.stringify({
      userId: user.id,
      mfaMethod
    }));

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
      phoneLast4: user.phoneNumber?.slice(-4) || null,
      user: null,
      tokens: null
    });
  }
  const roleId = context.roleId;
  const partnerId = context.partnerId;
  const orgId = context.orgId;
  const scope = context.scope;

  // Create tokens with user's context
  // MFA is vacuously satisfied when the user hasn't enrolled in MFA
  const mfaSatisfied = !(ENABLE_2FA && user.mfaEnabled);

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

  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope,
    mfa: mfaSatisfied,
    // SR-001: bind the token to the mobile install id when the client sends
    // it. Web/SSO clients don't send the header → mdid stays absent → no
    // behaviour change for them.
    mdid: readMobileDeviceId(c) ?? undefined
  }, { refreshFam: familyId });

  // Record the jti → family mapping in Redis for hot-path /refresh lookup.
  // Best-effort: the family id is also encoded in the JWT, so a Redis miss
  // still works via the verified claim.
  await bindRefreshJtiToFamily(tokens.refreshJti, familyId);

  // Update last login
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

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
      avatarUrl: user.avatarUrl
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false,
    requiresSetup
  });
});

// Logout
loginRoutes.post('/logout', authMiddleware, async (c) => {
  const auth = c.get('auth');

  try {
    await revokeAllUserTokens(auth.user.id);
    await revokeCurrentRefreshTokenJti(c, auth.user.id);
  } catch (error) {
    console.error('[auth] Failed to revoke tokens during logout — clearing cookie anyway:', error);
  }

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
    result: 'success'
  });

  clearRefreshTokenCookie(c);
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

  // Task 7: resolve the family for this jti. Prefer the verified JWT claim
  // (`fam`) — it's cryptographically signed and can't be tampered with. Fall
  // back to the Redis jti→family map for tokens that pre-date this rollout
  // (legacy: claim absent → only `refresh-jti-fam:<jti>` may know the
  // family). When BOTH are missing we treat the token as legacy and skip the
  // family-revocation checks — backwards-compat for sessions issued before
  // this PR. The per-jti revocation check below still gates those.
  let familyId: string | null = payload.fam ?? null;
  if (!familyId) {
    familyId = await getFamilyForJti(payload.jti);
  }

  // Reuse detection: if this jti has already been revoked AND we have a
  // family id, this is a replay of an old (rotated) refresh token. Kill the
  // whole family + write an audit row + return 401. Without this check the
  // attacker's later jti would still be valid even after the legitimate
  // user's next rotation.
  const jtiAlreadyRevoked = await isRefreshTokenJtiRevoked(payload.jti);
  if (jtiAlreadyRevoked) {
    if (familyId) {
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
    }
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Family-revoked sentinel check: covers the descendant case. If a sibling
  // refresh on this family already triggered reuse-detection, this token —
  // although its own jti hasn't been revoked — must also fail.
  if (familyId && (await isFamilyRevoked(familyId))) {
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
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)
  );

  if (!user || user.status !== 'active') {
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  let context;
  try {
    context = await resolveCurrentUserTokenContext(user.id);
  } catch (err) {
    if (!(err instanceof TenantInactiveError)) throw err;
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
  let claimedRevocation: boolean;
  try {
    claimedRevocation = await revokeRefreshTokenJti(payload.jti);
  } catch (error) {
    console.error('[auth] Refusing to mint refresh token — old jti revocation failed:', error);
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }
  if (!claimedRevocation) {
    // Another /refresh already revoked this jti. Either the legitimate client
    // double-fired the same cookie (e.g. React strict-mode) or an attacker is
    // racing us. Both branches must refuse — only one new token pair can exist
    // per old jti, and we are not the winner.
    clearRefreshTokenCookie(c);
    return c.json({ error: 'Invalid refresh token' }, 401);
  }

  // Create new token pair. Inherit the family from the verified claim (or
  // the looked-up familyId from Redis for legacy tokens that didn't carry
  // the claim but we still know the family for).
  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: ENABLE_2FA ? payload.mfa : false,
    // SR-001: preserve the device binding from the prior (signed) refresh
    // token. Deliberately NOT re-read from the header — a refresh must not be
    // able to drop the binding by omitting it.
    mdid: carryForwardBinding(payload)
  }, familyId ? { refreshFam: familyId } : {});

  if (familyId) {
    // Map the newly-minted jti to the same family so a future replay of THIS
    // jti can also be detected via Redis. Best-effort; the JWT `fam` claim
    // is the primary record.
    await bindRefreshJtiToFamily(tokens.refreshJti, familyId);
    // Telemetry: bump lastUsedAt on the family row. Fire-and-forget — never
    // blocks the refresh.
    void touchFamilyLastUsed(familyId);
  }

  setRefreshTokenCookie(c, tokens.refreshToken);
  return c.json({ tokens: toPublicTokens(tokens) });
});
