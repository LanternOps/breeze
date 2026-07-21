import type { Context } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partnerUsers, organizationUsers, organizations, userPasskeys } from '../../db/schema';
import {
  verifyToken,
  isUserTokenRevoked,
  revokeRefreshTokenJti,
  getTrustedClientIp,
  getRedis,
  rateLimiter,
  verifyPassword,
  getUserEpochs
} from '../../services';
import { getImmediatePeerIpOrUndefined, trustsForwardedHeadersFrom } from '../../services/clientIp';
import { createAuditLogAsync } from '../../services/auditService';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { consumeMFAToken } from '../../services/mfa';
import { mintStepUpGrant, validateStepUpGrant, consumeStepUpGrant } from '../../services/mfaStepUpGrant';
import { readMobileDeviceId } from '../../services/mobileDeviceBinding';
import type { AuthContext } from '../../middleware/auth';
import type { RequestLike } from '../../services/auditEvents';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  decryptMfaTotpSecret,
  decryptMfaTotpSecretForMigration,
  encryptMfaTotpSecret,
  type MfaSecretDecryptionResult
} from '../../services/mfaSecretCrypto';
import { DEFAULT_ALLOWED_ORIGINS, shouldIncludeDefaultOrigins } from '../../services/corsOrigins';
import { assertActiveTenantContext } from '../../services/tenantStatus';
import type { PublicTokenPayload, UserTokenContext } from './schemas';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_PATH,
  ANONYMOUS_ACTOR_ID,
  ENABLE_2FA
} from './schemas';

const { db } = dbModule;

export const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Shared floor-the-clock timing equalizer for pre-auth endpoints whose latency
// would otherwise be an account-enumeration oracle (login audit finding H-4;
// forgot-password SR2-22). The slowest legitimate path (real user, SSO/tenant
// joins, argon2) runs materially longer than the cheap "no such account" path;
// flooring every response at a fixed budget collapses that delta. 350ms
// comfortably exceeds the slowest legitimate path while staying below the
// interactive-feel "sluggish" threshold (500ms+). Test/E2E mode skips the floor
// so suites stay fast — unit tests assert state, not wall-clock.
export const AUTH_RESPONSE_FLOOR_MS = 350;

function authResponseFloorDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function authResponseFloorPromise(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return Promise.resolve();
  if (process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true') return Promise.resolve();
  return authResponseFloorDelay(AUTH_RESPONSE_FLOOR_MS);
}

/**
 * #2153: does the account have at least one usable (non-disabled) passkey?
 *
 * Both callers (the password /login handler and the CF-Access login
 * middleware) use this to advertise a passkey as an ALTERNATE second factor
 * even when the account's primary `mfaMethod` is totp/sms — registering a
 * passkey intentionally does not clobber an existing totp/sms method
 * (passkeys.ts), so login must detect the passkey independently.
 *
 * Runs under system DB access because both callers are PRE-AUTH (no request
 * RLS context): an org-scoped read under `breeze_app` would return 0 rows and
 * silently hide the option.
 *
 * NEVER throws. This is an optional affordance layered on top of the essential
 * login flow — a transient DB error here must not 500 a correctly-authenticated
 * user out of login, so a probe failure fails closed (returns false: the
 * primary factor's prompt is still shown, the passkey alternate is just hidden).
 */
export async function userHasUsablePasskey(userId: string): Promise<boolean> {
  try {
    const rows = await runWithSystemDbAccess(() =>
      db
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.disabledAt)))
        .limit(1)
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[auth] passkey-availability probe failed; hiding passkey alternate:', err);
    return false;
  }
}

// ============================================
// Cookie helpers
// ============================================

export function getClientIP(c: RequestLike): string {
  return getTrustedClientIp(c);
}

export function getClientRateLimitKey(c: RequestLike): string {
  const trustedIp = getClientIP(c);
  if (trustedIp && trustedIp !== 'unknown') {
    return `ip:${trustedIp}`;
  }

  // No proxy-verified client IP. Do NOT fingerprint forwarded IP headers —
  // an attacker rotating X-Forwarded-For from an untrusted peer would mint a
  // fresh bucket per request and evade the per-IP limit (SR2-16). Key on the
  // immediate TCP peer, which cannot be spoofed at L7.
  const peerIp = getImmediatePeerIpOrUndefined(c);
  if (peerIp) {
    return `socket:${peerIp}`;
  }

  // Only when even the socket address is unavailable (non-Node runtime / test
  // shim) fall back to a NON-IP fingerprint. Never include x-forwarded-for /
  // x-real-ip / cf-connecting-ip here — they are attacker-controlled.
  const read = (name: string) => c.req.header(name) ?? c.req.header(name.toLowerCase()) ?? '';
  const fingerprintSource = [read('user-agent'), read('accept-language'), read('origin')].join('|');

  const digest = createHash('sha256')
    .update(fingerprintSource || 'no-client-fingerprint')
    .digest('hex')
    .slice(0, 24);

  return `fp:${digest}`;
}

export async function requireCurrentPasswordStepUp(
  c: Context,
  userId: string,
  currentPassword: string,
  keyPrefix = 'auth:pwd-stepup'
): Promise<Response | null> {
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(redis, `${keyPrefix}:${userId}`, 5, 5 * 60);
  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.passwordHash) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  return null;
}

/**
 * L4 (critical) re-auth fallback for SSO-only / passwordless accounts that have
 * no password to satisfy {@link requireCurrentPasswordStepUp}. Verifies a fresh
 * TOTP code against the user's enrolled MFA secret. Mirrors the password
 * step-up's shape (rate limit → lookup → verify) and returns the same opaque
 * 401/429/503 responses so callers can `if (err) return err` uniformly. Only
 * TOTP step-up is supported here; SMS/passkey L4 re-auth is out of scope.
 */
export async function requireFreshMfaStepUp(
  c: Context,
  userId: string,
  code: string,
  keyPrefix = 'auth:mfa-stepup',
): Promise<Response | null> {
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(redis, `${keyPrefix}:${userId}`, 5, 5 * 60);
  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  const [user] = await db
    .select({ mfaEnabled: users.mfaEnabled, mfaSecret: users.mfaSecret, mfaMethod: users.mfaMethod })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Only TOTP step-up is supported here; SMS/passkey L4 re-auth is out of scope.
  // Allowlist on the method (not a denylist) so any non-TOTP/unset method is
  // rejected even if a stale secret lingers — defense-in-depth for the auth path.
  if (!user?.mfaEnabled || user.mfaMethod !== 'totp' || !user.mfaSecret) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const secret = decryptMfaTotpSecret(user.mfaSecret);
  if (!secret) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // consumeMFAToken (not verifyMFAToken): enforce single-use of the TOTP step
  // so a sniffed live code cannot re-authorize multiple critical actions within
  // its validity window. This L4 path had no other single-use binding. (sec review #2)
  const valid = await consumeMFAToken(secret, code, userId);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  return null;
}

// ============================================
// Existing-factor step-up for factor addition (SR2-20)
// ============================================

/**
 * True when the account already has ANY active MFA factor (TOTP, SMS, or a
 * non-disabled passkey). Drives the SR2-20 gate: initial enrollment (no
 * factor yet) stays password-only; adding a factor to an ALREADY-PROTECTED
 * account additionally requires a fresh existing-factor step-up grant.
 *
 * Runs under system DB access: several callers (e.g. `/mfa/enable`,
 * `/passkeys/register/*`) call this from within their own request-scoped
 * (user-id-scoped) RLS context, where it would still resolve correctly, but
 * system context keeps this probe uniform regardless of caller context.
 */
export async function userIsMfaProtected(userId: string): Promise<boolean> {
  const [row] = await runWithSystemDbAccess(() =>
    db
      .select({
        mfaEnabled: users.mfaEnabled,
        passkeyCount: sql<number>`(SELECT COUNT(*)::int FROM user_passkeys WHERE user_id = ${userId} AND disabled_at IS NULL)`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );
  return row?.mfaEnabled === true || Number(row?.passkeyCount ?? 0) > 0;
}

/**
 * Enforce the SR2-20 existing-factor step-up on a factor-ADDITION endpoint.
 * No-factor accounts (initial enrollment) pass with password-only (returns
 * null) — this avoids a chicken-and-egg lockout. Already-protected accounts
 * must present a fresh grant bound to the live epochs + this session's
 * `sid`; the binding is re-checked against the LIVE row here (not just at
 * mint time) so a factor change since the grant was minted (which bumps
 * `mfa_epoch` + revokes refresh families) invalidates it.
 *
 * Every factor-addition route calls this TWICE, in two phases:
 *
 * `opts.consume: false` = non-consuming validate, at the gate. Runs before the
 * factor proof (TOTP/SMS code, WebAuthn assertion) so a missing/bogus/stale
 * grant 403s without burning the consuming TOTP verifier's time-step.
 * `opts.consume: true` = single-use consume, immediately before the terminal
 * write, once the factor proof has validated. A wrong code therefore leaves the
 * grant intact for a retry, while a successful add burns it exactly once (the
 * consume re-checks the binding against the LIVE epochs and fails CLOSED, so
 * one grant can never write two factors).
 *
 * Returns a 403/503 Response to short-circuit the caller, or null to proceed.
 */
export async function enforceExistingFactorStepUp(
  c: Context,
  auth: AuthContext,
  grantId: string | undefined,
  opts: { consume: boolean },
): Promise<Response | null> {
  if (!(await userIsMfaProtected(auth.user.id))) return null;

  const epochs = await getUserEpochs(auth.user.id);
  if (!epochs || !auth.token.sid) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const bind = {
    userId: auth.user.id,
    operation: 'add_factor' as const,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid: auth.token.sid,
  };

  const ok = grantId
    ? (opts.consume ? await consumeStepUpGrant(grantId, bind) : await validateStepUpGrant(grantId, bind))
    : false;

  if (!ok) {
    return c.json({ error: 'existing_factor_step_up_required', stepUpUrl: '/auth/mfa/step-up' }, 403);
  }
  return null;
}

/**
 * True when the account holds a re-auth factor STRONGER than a password that
 * the browser register UI can actually exercise: TOTP MFA or an active
 * passkey. Deliberately excludes SMS (no authenticated step-up SMS sender
 * exists; SMS-method users use the password path — see the #2707 spec).
 * Gates POST /authenticator/register-grant: password re-auth is refused when
 * this returns true, keeping the server tiering identical to the UI tiering.
 */
export async function userHasStrongerReauthFactor(userId: string): Promise<boolean> {
  // #2707 review: with 2FA disabled cluster-wide (ENABLE_2FA=false), the
  // step-up endpoint (POST /auth/mfa/step-up) that would normally satisfy a
  // "stronger factor" is dead — every requireMfa() gate in the API is
  // disabled along with it (see the ENABLE_2FA warning in ./schemas). If this
  // still reported true for a user with a leftover TOTP secret or passkey
  // row, the password-fallback mint (POST /authenticator/register-grant)
  // would refuse them with no route left to satisfy the alternative,
  // permanently locking that account out of approver-device registration.
  // Fail open on the gate (not the grant itself — the grant is still
  // required) by always reporting no stronger factor when 2FA is off.
  if (!ENABLE_2FA) return false;

  const [row] = await runWithSystemDbAccess(() =>
    db
      .select({
        mfaEnabled: users.mfaEnabled,
        mfaMethod: users.mfaMethod,
        passkeyCount: sql<number>`(SELECT COUNT(*)::int FROM user_passkeys WHERE user_id = ${userId} AND disabled_at IS NULL)`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );
  return (row?.mfaEnabled === true && row?.mfaMethod === 'totp') || Number(row?.passkeyCount ?? 0) > 0;
}

/**
 * #2707: enforce a register_approver_device grant on the approver-device
 * registration routes. Same two-phase validate/consume contract as
 * `enforceExistingFactorStepUp` above, with one CRITICAL difference: NO
 * `userIsMfaProtected` bypass. Registration is deferred-proof-of-possession —
 * a stolen bearer token must never be able to register an approver key, so
 * the grant is required for EVERY account, MFA-protected or not.
 */
export async function enforceApproverRegisterStepUp(
  c: Context,
  auth: AuthContext,
  grantId: string | undefined,
  opts: { consume: boolean },
): Promise<Response | null> {
  const epochs = await getUserEpochs(auth.user.id);
  if (!epochs || !auth.token.sid) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const bind = {
    userId: auth.user.id,
    operation: 'register_approver_device' as const,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid: auth.token.sid,
  };

  const ok = grantId
    ? (opts.consume ? await consumeStepUpGrant(grantId, bind) : await validateStepUpGrant(grantId, bind))
    : false;

  if (!ok) {
    // Registration is deferred-proof-of-possession with no other write-time
    // check — a denial here is the only signal an operator gets that someone
    // tried to register an approver key without a valid grant (stolen
    // token, replayed/expired grant, etc). NEVER include the grant value —
    // only whether one was presented.
    writeAuthAudit(c, {
      orgId: auth.orgId ?? undefined,
      action: 'auth.authenticator.register.denied',
      result: 'failure',
      reason: 'register_step_up_required',
      userId: auth.user.id,
      email: auth.user.email,
      details: { hadGrantId: Boolean(grantId) },
    });
    return c.json({ error: 'register_step_up_required' }, 403);
  }
  return null;
}

/**
 * #2707: best-effort login-time mint of a register_approver_device grant,
 * returned to the MOBILE client as `authenticatorRegisterGrantId` so the app
 * can register its approver key promptlessly right after login.
 *
 * Gated on the mobile device-id header: web logins hit the same endpoints and
 * must NEVER receive a live register grant — an XSS on the web app COULD
 * redeem it directly against `POST /authenticator/devices` (arbitrary SPKI,
 * no further ceremony) to register an attacker-controlled approver key. Only
 * a genuine mobile client (proven by the device-id header) is ever handed
 * one.
 *
 * NEVER throws: every failure mode (missing epochs, Redis down, or any other
 * unexpected rejection from a collaborator) is caught here and mapped to
 * null, so a mint failure can never 500 an otherwise-successful login — the
 * phone simply registers on a later login. When the mobile header IS
 * present and the mint declines for any reason, an operator-visible error is
 * logged (the grant value itself is NEVER logged) so a systemic failure
 * (e.g. Redis down) is observable instead of silently degrading every mobile
 * login.
 *
 * NEVER call this from the /auth/refresh handler: a stolen refresh token
 * would then mint a fresh register grant on every rotation, defeating the
 * stolen-session protection the grant exists to provide.
 */
export async function mintLoginRegisterGrant(
  c: Context,
  userId: string,
  sid: string
): Promise<string | null> {
  if (!readMobileDeviceId(c)) return null;
  try {
    const epochs = await getUserEpochs(userId);
    if (!epochs) {
      console.error(`[auth] mintLoginRegisterGrant: epochs unavailable for user ${userId}; login proceeds without a grant`);
      return null;
    }
    const grantId = await mintStepUpGrant({
      userId,
      operation: 'register_approver_device',
      authEpoch: epochs.authEpoch,
      mfaEpoch: epochs.mfaEpoch,
      sid,
    });
    if (!grantId) {
      console.error(`[auth] mintLoginRegisterGrant: mint declined (Redis unavailable?) for user ${userId}; login proceeds without a grant`);
    }
    return grantId;
  } catch (err) {
    console.error(`[auth] mintLoginRegisterGrant: unexpected failure minting register grant for user ${userId}; login proceeds without a grant:`, err);
    return null;
  }
}

export function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Whether the browser's connection to us actually arrived over HTTPS.
 *
 * #1618: the auth cookies' `Secure` flag MUST track the real transport, not
 * `NODE_ENV`. A production deploy the browser reaches over plain HTTP — ACME
 * failed (port 80 blocked / DNS not pointed), the site is opened via `http://`,
 * or the browser's path to us has a plain-HTTP hop end-to-end (TLS-stripping
 * proxy) — would otherwise stamp `Secure` on the refresh cookie, which the
 * browser then *silently discards*. Login still "succeeds" (the access token
 * rides back in the JSON body and lives in memory), but every reload 401s
 * because the refresh cookie was never stored. That is exactly the "persistent
 * login" failure reporters hit, with no diagnostic anywhere.
 *
 * Resolution order:
 * 1. `X-Forwarded-Proto` (first, client-facing hop) — but only when the
 *    immediate TCP peer passes the same TRUST_PROXY_HEADERS /
 *    TRUSTED_PROXY_CIDRS gate as forwarded-ip headers (`clientIp.ts`).
 *    Without the gate, any client that can reach the API around the proxy
 *    could send `X-Forwarded-Proto: http` over genuine TLS and strip `Secure`
 *    from its own cookies. The stock compose topology trusts Caddy's static
 *    IP out of the box (locked by `config/proxyTrustCompose.test.ts`). Note
 *    Caddy REPLACES `X-Forwarded-*` from untrusted clients but PASSES THROUGH
 *    values from `CADDY_TRUSTED_PROXIES`: in the hosted Cloudflare-Tunnel
 *    topology the `https` the API sees originates at the Cloudflare edge and
 *    is passed through by Caddy, whose own inbound hop (cloudflared → Caddy)
 *    is plain HTTP — the fix *relies* on that passthrough.
 * 2. An `https://` request URL as a positive-only signal (direct-to-API TLS,
 *    no proxy in front).
 * 3. `NODE_ENV` as the safe default, with a throttled production breadcrumb
 *    (`warnAmbiguousCookieTransport`) because this branch is genuinely blind:
 *    a proxy that never sends `X-Forwarded-Proto` (or isn't in
 *    TRUSTED_PROXY_CIDRS) with a browser on plain HTTP lands here and still
 *    gets `Secure` — the pre-fix #1618 behavior — so we leave a grep-able
 *    trail instead of failing silently.
 *
 * The URL scheme is only ever a POSITIVE signal: in the standard topology the
 * request URL's *scheme* reflects the internal plain-HTTP Caddy→API hop
 * (`http://<original-host>/...` — Caddy preserves the Host header), which does
 * NOT reflect the browser's transport. So an `http` URL with no trusted
 * `X-Forwarded-Proto` is ambiguous — we fall back to `NODE_ENV` rather than
 * downgrading a genuinely HTTPS deployment whose proxy strips the header.
 */
export function isRequestConnectionSecure(c: Context): boolean {
  const forwardedProto = c.req.header('x-forwarded-proto');
  if (forwardedProto && trustsForwardedHeadersFrom(c)) {
    // A proxy chain may append hops ("https, http"); the first is client-facing.
    return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https';
  }
  try {
    if (new URL(c.req.url).protocol === 'https:') {
      return true;
    }
  } catch {
    // Malformed URL — no positive signal; same ambiguous fall-through below.
  }
  warnAmbiguousCookieTransport(c, forwardedProto);
  return isSecureCookieEnvironment();
}

type SameSiteValue = 'Lax' | 'Strict' | 'None';

function normalizeSameSite(raw: string | undefined): SameSiteValue {
  const value = raw?.trim().toLowerCase();
  if (value === 'strict') return 'Strict';
  if (value === 'none') return 'None';
  return 'Lax';
}

function resolveAuthCookieSameSite(): SameSiteValue {
  return normalizeSameSite(process.env.AUTH_COOKIE_SAME_SITE ?? process.env.COOKIE_SAME_SITE);
}

function forceSecureCookie(): boolean {
  const forceSecure = (process.env.AUTH_COOKIE_FORCE_SECURE ?? process.env.COOKIE_FORCE_SECURE)?.trim().toLowerCase();
  return forceSecure === '1' || forceSecure === 'true';
}

function shouldSetSecureCookie(sameSite: SameSiteValue, connectionSecure: boolean): boolean {
  if (sameSite === 'None') {
    // Browsers require Secure when SameSite=None.
    return true;
  }
  if (forceSecureCookie()) {
    return true;
  }
  return connectionSecure;
}

function buildCookieSecuritySuffix(sameSite: SameSiteValue, connectionSecure: boolean): string {
  const secure = shouldSetSecureCookie(sameSite, connectionSecure) ? '; Secure' : '';
  return `; SameSite=${sameSite}${secure}`;
}

// `connectionSecure` is required on every build* function so no caller can
// silently fall back to the pre-#1618 NODE_ENV heuristic — derive it from the
// request via isRequestConnectionSecure(c), or use the set/clear entry points
// below, which also emit the misconfiguration warnings.
export function buildRefreshTokenCookie(refreshToken: string, connectionSecure: boolean): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}; Path=${REFRESH_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}`;
}

export function buildCsrfTokenCookie(csrfToken: string, connectionSecure: boolean): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=${CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}`;
}

export function buildClearRefreshTokenCookie(connectionSecure: boolean): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${REFRESH_COOKIE_NAME}=; Path=${REFRESH_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=0`;
}

export function buildClearCsrfTokenCookie(connectionSecure: boolean): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${CSRF_COOKIE_NAME}=; Path=${CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=0`;
}

// Throttled warnings so a busy misconfigured deployment logs periodically
// without flooding. Keyed per warning kind (a small fixed set — never by
// host/peer) so one misconfiguration class can't suppress reports of another.
// Module-scoped; resets on process restart.
const AUTH_COOKIE_WARN_INTERVAL_MS = 10 * 60 * 1000;
const authCookieLastWarnAt = new Map<string, number>();

function warnAuthCookieThrottled(kind: string, message: string): void {
  const now = Date.now();
  const last = authCookieLastWarnAt.get(kind);
  if (last !== undefined && now - last < AUTH_COOKIE_WARN_INTERVAL_MS) {
    return;
  }
  authCookieLastWarnAt.set(kind, now);
  console.warn(message);
}

export function _resetAuthCookieWarnStateForTests(): void {
  authCookieLastWarnAt.clear();
}

function describeCookieTransport(c: Context): string {
  const host = c.req.header('host') ?? 'unknown-host';
  const observedProto = c.req.header('x-forwarded-proto');
  return `host "${host}", X-Forwarded-Proto ${observedProto ? `"${observedProto}"` : 'absent'}`;
}

// Production breadcrumb for the blind NODE_ENV fallback in
// isRequestConnectionSecure: nothing told us the browser's transport, we are
// about to assume HTTPS, and if that assumption is wrong the browser discards
// the Secure cookie with no other diagnostic anywhere (the original #1618).
function warnAmbiguousCookieTransport(c: Context, forwardedProto: string | undefined): void {
  if (!isSecureCookieEnvironment()) {
    return;
  }
  const cause = forwardedProto
    ? `\`X-Forwarded-Proto: ${forwardedProto}\` was IGNORED because the TCP peer is not a trusted proxy (TRUST_PROXY_HEADERS / TRUSTED_PROXY_CIDRS)`
    : 'no `X-Forwarded-Proto` header was present';
  warnAuthCookieThrottled(
    'ambiguous-transport',
    `[auth] Cannot determine the browser's transport for auth cookies (${describeCookieTransport(c)}): ${cause}, ` +
    'and the request URL is not https. Assuming HTTPS because NODE_ENV=production, so cookies get `Secure`. ' +
    'If users cannot stay logged in (issue #1618), the browser is likely reaching Breeze over plain HTTP: ' +
    'make your reverse proxy forward `X-Forwarded-Proto` and list its IP in TRUSTED_PROXY_CIDRS.'
  );
}

// Keyed off the ACTUAL Secure decision, not just the transport: `Secure` can be
// forced onto an insecure transport (AUTH_COOKIE_FORCE_SECURE / SameSite=None),
// and that case breaks login outright — the warning must say so, not claim the
// cookies are non-Secure.
function warnOnAuthCookieTransportMismatch(c: Context, sameSite: SameSiteValue, connectionSecure: boolean, secure: boolean): void {
  if (connectionSecure) {
    return;
  }
  if (secure) {
    // Explicit config forces `Secure` onto a transport the browser will reject
    // it on. Only reachable via deliberate configuration, so warn in every
    // environment — this is the #1618 symptom by operator choice.
    const cause = sameSite === 'None'
      ? 'AUTH_COOKIE_SAME_SITE=None requires the Secure attribute'
      : 'AUTH_COOKIE_FORCE_SECURE is set';
    warnAuthCookieThrottled(
      'forced-secure-over-http',
      `[auth] Issuing \`Secure\` auth cookies over a NON-HTTPS request (${describeCookieTransport(c)}) because ${cause}. ` +
      'The browser WILL silently discard them and persistent login WILL break (issue #1618). Fix TLS so the ' +
      'browser reaches Breeze over https, or remove that configuration.'
    );
    return;
  }
  // Non-Secure cookies over HTTP: login works, but credentials transit
  // unencrypted. Dev-over-http is the normal local flow — only warn when
  // deployed (production).
  if (!isSecureCookieEnvironment()) {
    return;
  }
  warnAuthCookieThrottled(
    'insecure-transport',
    `[auth] Issuing NON-Secure auth cookies: this production request arrived over HTTP (${describeCookieTransport(c)}). ` +
    'Persistent login will work, but the connection is not encrypted. If Breeze should be served over HTTPS, ' +
    'fix TLS / your reverse proxy so the browser reaches it over https and the proxy forwards ' +
    '`X-Forwarded-Proto: https` (see issue #1618).'
  );
}

export function setRefreshTokenCookie(c: Context, refreshToken: string): void {
  const connectionSecure = isRequestConnectionSecure(c);
  const sameSite = resolveAuthCookieSameSite();
  warnOnAuthCookieTransportMismatch(c, sameSite, connectionSecure, shouldSetSecureCookie(sameSite, connectionSecure));
  const csrfToken = randomBytes(32).toString('hex');
  c.header('Set-Cookie', buildRefreshTokenCookie(refreshToken, connectionSecure), { append: true });
  c.header('Set-Cookie', buildCsrfTokenCookie(csrfToken, connectionSecure), { append: true });
}

export function clearRefreshTokenCookie(c: Context): void {
  // Derive from the same request so the clearing cookie's attributes match the
  // set cookie's within this transport (a `Secure` clear sent over HTTP would
  // itself be ignored by the browser, stranding the cookie).
  const connectionSecure = isRequestConnectionSecure(c);
  c.header('Set-Cookie', buildClearRefreshTokenCookie(connectionSecure), { append: true });
  c.header('Set-Cookie', buildClearCsrfTokenCookie(connectionSecure), { append: true });
}

export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const target = `${name}=`;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

export function resolveRefreshToken(c: Context): string | null {
  return getCookieValue(c.req.header('cookie'), REFRESH_COOKIE_NAME);
}

// ============================================
// CORS / CSRF helpers
// ============================================

export function getAllowedOrigins(): Set<string> {
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // Gate dev-only origins on environment, mirroring corsOrigins.ts.
  // In production, do NOT merge localhost defaults unless
  // CORS_INCLUDE_DEFAULT_ORIGINS=true is explicitly set.
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const includeDefaults = shouldIncludeDefaultOrigins(nodeEnv);
  const defaults = includeDefaults ? DEFAULT_ALLOWED_ORIGINS : [];

  return new Set<string>([...defaults, ...configuredOrigins]);
}

export function isAllowedOrigin(origin: string): boolean {
  const allowList = getAllowedOrigins();
  if (allowList.has(origin)) {
    return true;
  }

  if (process.env.NODE_ENV !== 'production') {
    try {
      const parsed = new URL(origin);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

export function validateCookieCsrfRequest(c: Context): string | null {
  const csrfHeader = c.req.header(CSRF_HEADER_NAME)?.trim();
  if (!csrfHeader || csrfHeader.length === 0) {
    return 'Missing CSRF header';
  }

  const csrfCookie = getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME);
  if (!csrfCookie) {
    // Backward compatibility for non-browser clients that do not expose cookie APIs.
    // Browsers are still protected by Origin/Sec-Fetch-Site checks below.
    const hasOrigin = Boolean(c.req.header('origin'));
    const fetchSite = c.req.header('sec-fetch-site');
    const isBrowserSignal = hasOrigin || Boolean(fetchSite);
    if (csrfHeader === '1' && !isBrowserSignal) {
      return null;
    }
    return 'Missing CSRF cookie';
  }
  if (!safeCompareTokens(csrfHeader, csrfCookie)) {
    return 'Invalid CSRF token';
  }

  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin)) {
    return 'Invalid request origin';
  }

  // Defense-in-depth: block cross-site requests when the browser provides Sec-Fetch-Site
  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite) {
    const normalized = fetchSite.toLowerCase();
    if (normalized !== 'same-origin' && normalized !== 'same-site') {
      return 'Cross-site request blocked';
    }
  }

  return null;
}

function safeCompareTokens(headerToken: string, cookieToken: string): boolean {
  const headerBuffer = Buffer.from(headerToken, 'utf8');
  const cookieBuffer = Buffer.from(cookieToken, 'utf8');
  if (headerBuffer.length !== cookieBuffer.length) {
    return false;
  }
  return timingSafeEqual(headerBuffer, cookieBuffer);
}

// ============================================
// Token helpers
// ============================================

export function toPublicTokens(tokens: { accessToken: string; expiresInSeconds: number }): PublicTokenPayload {
  return {
    accessToken: tokens.accessToken,
    expiresInSeconds: tokens.expiresInSeconds
  };
}

// ============================================
// MFA crypto helpers
// ============================================

export function encryptMfaSecret(secret: string | null | undefined): string | null {
  return encryptMfaTotpSecret(secret);
}

export function decryptMfaSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  try {
    return decryptMfaTotpSecret(secret);
  } catch (error) {
    console.error('[auth] Failed to decrypt MFA secret — user may need to re-enroll MFA:', error);
    return null;
  }
}

export function decryptMfaSecretForMigration(secret: string | null | undefined): MfaSecretDecryptionResult {
  if (!secret) return { plaintext: null, migratedSecret: null };
  try {
    return decryptMfaTotpSecretForMigration(secret);
  } catch (error) {
    console.error('[auth] Failed to decrypt MFA secret — user may need to re-enroll MFA:', error);
    return { plaintext: null, migratedSecret: null };
  }
}

export function getRecoveryCodePepper(): string {
  const pepper = process.env.MFA_RECOVERY_CODE_PEPPER?.trim();
  if (pepper) return pepper;

  if (process.env.NODE_ENV === 'test') {
    return 'test-mfa-recovery-code-pepper';
  }

  throw new Error('No MFA recovery code pepper configured. Set MFA_RECOVERY_CODE_PEPPER.');
}

export function hashRecoveryCode(code: string): string {
  const normalizedCode = code.trim().toUpperCase();
  return createHash('sha256')
    .update(`${getRecoveryCodePepper()}:${normalizedCode}`)
    .digest('hex');
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map(hashRecoveryCode);
}

// ============================================
// Pending MFA session helpers (SR2-06)
// ============================================

export interface PendingMfaRecord {
  userId: string;
  mfaMethod: 'totp' | 'sms' | 'passkey';
  passkeyAvailable: boolean;
  authEpoch: number;
  mfaEpoch: number;
  statusExpectation: string;
  allowedMethods: { totp: boolean; sms: boolean; passkey: boolean };
  expiresAt: number;
}

/**
 * Strict parse of a `mfa:pending:<tempToken>` value. Returns null for the
 * legacy bare-userId form or any record missing the epoch/status binding
 * (SR2-06): those predate this rollout and must force a fresh login rather than
 * complete with no live re-check.
 */
export function parsePendingMfa(raw: string): PendingMfaRecord | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // legacy bare-userId string
  }
  const method = parsed.mfaMethod;
  const am = parsed.allowedMethods as Record<string, unknown> | undefined;
  if (
    typeof parsed.userId !== 'string' ||
    (method !== 'totp' && method !== 'sms' && method !== 'passkey') ||
    typeof parsed.authEpoch !== 'number' ||
    typeof parsed.mfaEpoch !== 'number' ||
    typeof parsed.statusExpectation !== 'string' ||
    typeof parsed.expiresAt !== 'number' ||
    !am || typeof am !== 'object'
  ) {
    return null;
  }
  return {
    userId: parsed.userId,
    mfaMethod: method,
    passkeyAvailable: parsed.passkeyAvailable === true,
    authEpoch: parsed.authEpoch,
    mfaEpoch: parsed.mfaEpoch,
    statusExpectation: parsed.statusExpectation,
    allowedMethods: {
      totp: am.totp !== false,
      sms: am.sms !== false,
      passkey: am.passkey !== false,
    },
    expiresAt: parsed.expiresAt,
  };
}

/**
 * Compare a pending record against the live user row. MFA assurance is valid
 * only for the current MFA config + status (invariants 6/7). Any factor change
 * bumps mfa_epoch; any account-wide change bumps auth_epoch; a suspend flips
 * status — all of which must invalidate an in-flight MFA session.
 */
export function evaluatePendingMfa(
  record: PendingMfaRecord,
  live: { status: string; authEpoch: number; mfaEpoch: number },
): { ok: true } | { ok: false; reason: 'expired' | 'epoch_mismatch' | 'status_changed' } {
  if (record.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
  if (record.authEpoch !== live.authEpoch || record.mfaEpoch !== live.mfaEpoch) {
    return { ok: false, reason: 'epoch_mismatch' };
  }
  if (live.status !== 'active' || record.statusExpectation !== live.status) {
    return { ok: false, reason: 'status_changed' };
  }
  return { ok: true };
}

// ============================================
// Invite token helpers
// ============================================

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function inviteRedisKey(tokenHash: string): string {
  return `invite:${tokenHash}`;
}

export function inviteUserRedisKey(userId: string): string {
  return `invite-user:${userId}`;
}

// ============================================
// Error response helpers
// ============================================

export function genericAuthError() {
  return { error: 'Invalid email or password' };
}

export function registrationDisabledResponse(c: Context): Response {
  return c.json({ error: 'Not Found' }, 404);
}

export function mfaDisabledResponse(c: Context): Response {
  return c.json({ error: 'Not Found' }, 404);
}

// ============================================
// Token/session helpers
// ============================================

export async function isTokenRevokedForUser(userId: string, tokenIssuedAt?: number): Promise<boolean> {
  return isUserTokenRevoked(userId, tokenIssuedAt);
}

export async function revokeCurrentRefreshTokenJti(c: Context, expectedUserId?: string): Promise<void> {
  const refreshToken = resolveRefreshToken(c);
  if (!refreshToken) {
    return;
  }

  const payload = await verifyToken(refreshToken);
  if (!payload || payload.type !== 'refresh' || !payload.jti) {
    return;
  }

  if (expectedUserId && payload.sub !== expectedUserId) {
    return;
  }

  await revokeRefreshTokenJti(payload.jti);
}

// ============================================
// User context helpers
// ============================================

/**
 * Thrown by resolveCurrentUserTokenContext when a user has no partner or org
 * membership and is NOT a platform admin. Such a principal must never be issued
 * a token (it would otherwise default to scope:'system', which short-circuits
 * RLS to full cross-tenant access). Login entry points map this to a generic
 * 401. (security review #2)
 */
export class NoTenantMembershipError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has no tenant membership and is not a platform admin`);
    this.name = 'NoTenantMembershipError';
  }
}

export async function resolveCurrentUserTokenContext(userId: string): Promise<UserTokenContext> {
  return runWithSystemDbAccess(async () => {
    let roleId: string | null = null;
    let partnerId: string | null = null;
    let orgId: string | null = null;
    let scope: 'system' | 'partner' | 'organization' = 'system';

    let partnerUsersTable:
      | { partnerId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      partnerUsersTable = partnerUsers as unknown as { partnerId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      partnerUsersTable = undefined;
    }

    if (partnerUsersTable?.partnerId && partnerUsersTable?.roleId && partnerUsersTable?.userId) {
      const [partnerAssoc] = await db
        .select({
          partnerId: partnerUsers.partnerId,
          roleId: partnerUsers.roleId
        })
        .from(partnerUsers)
        .where(eq(partnerUsers.userId, userId))
        .limit(1);

      if (partnerAssoc?.partnerId && partnerAssoc?.roleId) {
        await assertActiveTenantContext({
          scope: 'partner',
          partnerId: partnerAssoc.partnerId,
          orgId: null
        });
        return {
          roleId: partnerAssoc.roleId,
          partnerId: partnerAssoc.partnerId,
          orgId: null,
          scope: 'partner'
        };
      }
    }

    let organizationUsersTable:
      | { orgId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      organizationUsersTable = organizationUsers as unknown as { orgId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      organizationUsersTable = undefined;
    }

    if (organizationUsersTable?.orgId && organizationUsersTable?.roleId && organizationUsersTable?.userId) {
      const [orgAssoc] = await db
        .select({
          orgId: organizationUsers.orgId,
          roleId: organizationUsers.roleId
        })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, userId))
        .limit(1);

      if (orgAssoc?.orgId && orgAssoc?.roleId) {
        orgId = orgAssoc.orgId;
        roleId = orgAssoc.roleId;
        scope = 'organization';

        const [org] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, orgAssoc.orgId))
          .limit(1);

        partnerId = org?.partnerId ?? null;
        await assertActiveTenantContext({
          scope: 'organization',
          partnerId,
          orgId
        });
      }
    }

    // No partner or org membership resolved. The ONLY legitimate membership-less
    // system-scope principal is a platform admin; every other such user is an
    // orphaned / partially-provisioned account (e.g. the #1367 class). Handing
    // them the default scope:'system' grants full cross-tenant access because
    // the RLS helpers (breeze_has_org_access/_partner_access) short-circuit TRUE
    // for system scope. Fail closed unless the user is a platform admin.
    // (security review #2)
    if (scope === 'system') {
      const [u] = await db
        .select({ isPlatformAdmin: users.isPlatformAdmin })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (u?.isPlatformAdmin !== true) {
        throw new NoTenantMembershipError(userId);
      }
    }

    return { roleId, partnerId, orgId, scope };
  });
}

export async function resolveUserAuditOrgId(userId: string): Promise<string | null> {
  return runWithSystemDbAccess(async () => {
    try {
      const orgUsersTable = organizationUsers as unknown as { orgId?: unknown; userId?: unknown } | undefined;
      if (!orgUsersTable?.orgId || !orgUsersTable?.userId) {
        return null;
      }

      const [orgAssoc] = await db
        .select({ orgId: organizationUsers.orgId })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, userId))
        .limit(1);

      return orgAssoc?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId for user:', userId, err);
      return null;
    }
  });
}

// ============================================
// Audit helpers
// ============================================

export function writeAuthAudit(
  c: RequestLike,
  opts: {
    orgId?: string;
    action: string;
    result: 'success' | 'failure' | 'denied';
    reason?: string;
    userId?: string;
    email?: string;
    name?: string;
    details?: Record<string, unknown>;
  }
): void {
  createAuditLogAsync({
    orgId: opts.orgId,
    actorType: opts.userId ? 'user' : 'system',
    actorId: opts.userId ?? ANONYMOUS_ACTOR_ID,
    actorEmail: opts.email,
    action: opts.action,
    resourceType: 'user',
    resourceId: opts.userId,
    resourceName: opts.name,
    details: {
      ...opts.details,
      reason: opts.reason
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: opts.result
  });
}

export async function auditUserLoginFailure(
  c: RequestLike,
  opts: {
    userId: string;
    email?: string;
    name?: string;
    reason: string;
    result?: 'failure' | 'denied';
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const orgId = await resolveUserAuditOrgId(opts.userId);

  recordFailedLogin(opts.reason, orgId);

  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'user.login.failed',
    result: opts.result ?? 'failure',
    reason: opts.reason,
    userId: opts.userId,
    email: opts.email,
    name: opts.name,
    details: opts.details
  });
}

export function auditLogin(
  c: RequestLike,
  opts: { orgId: string | null; userId: string; email: string; name: string; mfa: boolean; scope: string; ip: string; method?: string }
): void {
  createAuditLogAsync({
    orgId: opts.orgId ?? undefined,
    actorId: opts.userId,
    actorEmail: opts.email,
    action: 'user.login',
    resourceType: 'user',
    resourceId: opts.userId,
    resourceName: opts.name,
    details: { method: opts.method ?? 'password', mfa: opts.mfa, scope: opts.scope },
    ipAddress: opts.ip,
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });
}

/**
 * Check if a user requires the first-login setup wizard.
 * Triggers for the bootstrap admin on first login (before they complete setup).
 * New partner registrations get their org/site created at registration time
 * and have setupCompletedAt set, so they skip the wizard.
 */
export function userRequiresSetup(user: {
  setupCompletedAt: Date | string | null;
  email: string;
  preferences?: unknown;
}): boolean {
  if (user.setupCompletedAt) return false;

  if (user.email === 'admin@breeze.local') return true;

  if (
    user.preferences &&
    typeof user.preferences === 'object' &&
    !Array.isArray(user.preferences) &&
    (user.preferences as { bootstrapSetupRequired?: unknown }).bootstrapSetupRequired === true
  ) {
    return true;
  }

  return false;
}
