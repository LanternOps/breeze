import { createHash, randomBytes } from 'crypto';
import { getRedis } from './redis';

/**
 * #4067 — link-on-first-SSO-login pending records.
 *
 * When the SSO callback resolves an email-matched, password-holding account it
 * must NOT auto-link (#2183: a malicious/misconfigured IdP can assert a
 * victim's email). Instead the verified IdP identity is parked here and the
 * user is sent to a "connect your sign-in" page that demands the account
 * password (and, for MFA-enrolled users, a Breeze-held second factor) before
 * the link is created and the login completes.
 *
 * Storage contract (mirrors services/pendingRegistration.ts):
 *  - key = sha256 of a fresh 256-bit token; the raw token travels ONLY in an
 *    HttpOnly cookie (see the pending-link cookie section in routes/sso.ts,
 *    which owns the path/attributes). Browser binding: a forwarded URL is
 *    useless to a phisher — only the browser that finished the OIDC
 *    round-trip holds the cookie, and the MFA continuation inherits the
 *    binding via the tempToken issued to that same browser. The raw token is
 *    never stored inside the record value and never logged.
 *  - 5-minute TTL, matching the mfa:pending login window.
 *  - completion consumes via atomic GETDEL — exactly one winner under
 *    concurrency.
 *  - fails CLOSED: no Redis ⇒ createSsoPendingLink throws; the caller decides
 *    the fallback (the callback bounces to the legacy error).
 *
 * The record carries everything needed to finish the login after the id_token
 * is gone (IdP tokens already encrypted with encryptSecret), plus the bindings
 * that must be re-validated live at completion time: the user's auth/mfa
 * epochs and status as of the callback, the provider's config generation, and
 * the email_verified provenance of the assertion.
 */

const PENDING_LINK_PREFIX = 'sso:pendinglink:';
export const SSO_PENDING_LINK_TTL_SECONDS = 300;

export interface SsoPendingLink {
  /** The matched account (byEmail) — the ONLY account this record can link. */
  userId: string;
  /** The account email at match time; must still match at completion. */
  userEmail: string;
  /** Epoch snapshots (SR2-06 idiom): a password reset / factor change / global
   * logout during the window invalidates the record. */
  authEpoch: number;
  mfaEpoch: number;
  /** Browser issuance snapshot captured by the original SSO callback. The
   * delayed password/MFA completion must reclaim this exact generation before
   * it may mint a Breeze session. */
  browserTransitionId: string;
  browserGeneration: number;
  providerId: string;
  /** Provider axis snapshot — drives the MFA-policy scope for the ceremony's
   * pending-MFA record without re-reading the provider mid-ceremony. */
  providerOrgId: string | null;
  providerPartnerId: string | null;
  /** sso_providers.config_version snapshot — same invariant as
   * checkProviderGeneration: a provider re-config voids in-flight ceremonies. */
  providerConfigVersion: number;
  /** The verified id_token subject. */
  externalSub: string;
  /** The IdP-asserted email (lowercased, verified-source). */
  email: string;
  name: string | null;
  /** Raw userinfo body → user_sso_identities.profile. */
  profile: unknown;
  /** IdP tokens, ALREADY encryptSecret()-wrapped by the callback. */
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  /** ISO timestamp or null. */
  tokenExpiresAt: string | null;
  /** Whether the verified id_token's amr attested MFA (the id_token itself is
   * gone by completion time). Combined with a LIVE re-read of
   * provider.trustsIdpMfa at completion. */
  idpMfaAsserted: boolean;
  /** email_verified provenance. When 'absent', the callback only accepted the
   * assertion because the email domain was DNS-verified at the time —
   * completion must re-check that domain proof. ('false' never reaches this
   * record: the callback rejects it outright.) parseRecord normalizes any
   * drifted value to 'absent' so unknown shapes land on the CONSERVATIVE
   * side (re-prove the domain), never the trusting one. */
  emailVerifiedClaim: 'true' | 'absent';
  /** sso_sessions.redirect_url relay target (normalized again at completion). */
  redirectUrl: string | null;
  createdAt: number;
}

function pendingKey(tokenHash: string): string {
  return `${PENDING_LINK_PREFIX}${tokenHash}`;
}

export function hashSsoPendingLinkToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

type RedisWithGetDel = NonNullable<ReturnType<typeof getRedis>> & {
  getdel?: (key: string) => Promise<string | null>;
  eval?: (script: string, keyCount: number, ...keys: string[]) => Promise<unknown>;
};

// Same capability dance as services/pendingRegistration.ts — GETDEL where the
// client supports it, a Lua GET+DEL otherwise, so exactly one caller wins.
async function getDelAtomic(redis: RedisWithGetDel, key: string): Promise<string | null> {
  if (typeof redis.getdel === 'function') {
    return redis.getdel(key);
  }
  if (typeof redis.eval === 'function') {
    const raw = await redis.eval(
      `
      local value = redis.call('GET', KEYS[1])
      if value then
        redis.call('DEL', KEYS[1])
      end
      return value
    `,
      1,
      key,
    );
    return typeof raw === 'string' ? raw : null;
  }
  throw new Error('Redis client does not support atomic pending-link consumption');
}

export async function createSsoPendingLink(
  record: Omit<SsoPendingLink, 'createdAt'>,
): Promise<{ rawToken: string; tokenHash: string }> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[sso-pending-link] Redis unavailable; cannot park pending link');
  }

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashSsoPendingLinkToken(rawToken);

  const stored: SsoPendingLink = { ...record, createdAt: Date.now() };
  await redis.setex(pendingKey(tokenHash), SSO_PENDING_LINK_TTL_SECONDS, JSON.stringify(stored));

  return { rawToken, tokenHash };
}

function parseRecord(raw: string | null): SsoPendingLink | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // A corrupt/truncated record must fail closed — but never silently, or
    // serialization bugs hide behind "your link expired" indefinitely.
    console.error('[sso-pending-link] unparseable pending record; treating as absent:', err);
    return null;
  }
  // Strict shape validation (same philosophy as parsePendingMfa): a record
  // whose security bindings are missing/mistyped — rolling-deploy shape
  // drift, a renamed field — must NOT limp through the finalizer with
  // undefined comparisons. Fail closed to 'link_expired'.
  if (
    typeof parsed.userId !== 'string' ||
    typeof parsed.userEmail !== 'string' ||
    typeof parsed.authEpoch !== 'number' ||
    typeof parsed.mfaEpoch !== 'number' ||
    typeof parsed.browserTransitionId !== 'string' ||
    typeof parsed.browserGeneration !== 'number' ||
    typeof parsed.providerId !== 'string' ||
    typeof parsed.providerConfigVersion !== 'number' ||
    typeof parsed.externalSub !== 'string' ||
    typeof parsed.email !== 'string'
  ) {
    console.error('[sso-pending-link] pending record failed shape validation; treating as absent');
    return null;
  }
  return {
    ...(parsed as unknown as SsoPendingLink),
    // The ONE field whose drift would otherwise fail OPEN: anything but the
    // exact literal 'true' means the domain proof must be re-run.
    emailVerifiedClaim: parsed.emailVerifiedClaim === 'true' ? 'true' : 'absent',
  };
}

/** Non-consuming read: the password step and the page's describe call must not
 * burn the record — only finalize (which consumes first, win or lose) or a
 * hard invalidation (attempt exhaustion, stale-state guards) does. */
export async function peekSsoPendingLink(tokenHash: string): Promise<SsoPendingLink | null> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[sso-pending-link] Redis unavailable during peek — ceremony will read as expired');
    return null;
  }
  return parseRecord(await redis.get(pendingKey(tokenHash)));
}

/** Atomic single-winner consumption — called only when completion is about to
 * link + mint (or by the MFA continuation's finalizer). */
export async function consumeSsoPendingLink(tokenHash: string): Promise<SsoPendingLink | null> {
  const redis = getRedis();
  if (!redis) {
    // Distinguishable from a genuine expiry in logs: a Redis blip between the
    // password step and the MFA continuation otherwise reads as "no record"
    // and 401s every completion with zero server-side trace.
    console.warn('[sso-pending-link] Redis unavailable during consume — ceremony will read as expired');
    return null;
  }
  return parseRecord(await getDelAtomic(redis as RedisWithGetDel, pendingKey(tokenHash)));
}

/** Restore the single consumed record after a retryable factor failure. The
 * original window is preserved, so wrong codes cannot extend the ceremony. */
export async function restoreConsumedSsoPendingLink(
  tokenHash: string,
  record: SsoPendingLink,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const remainingSeconds = Math.ceil(
    (record.createdAt + SSO_PENDING_LINK_TTL_SECONDS * 1000 - Date.now()) / 1000,
  );
  if (remainingSeconds <= 0) return false;
  await redis.setex(pendingKey(tokenHash), remainingSeconds, JSON.stringify(record));
  return true;
}

/**
 * Re-arm the record's TTL to the full window. Called when the password step
 * succeeds and hands off to the MFA continuation, so the factor step gets its
 * own 5-minute window (matching the fresh mfa:pending record) instead of
 * racing whatever remained of the callback-time TTL — without this, a user
 * who takes a few minutes on the password step enters a CORRECT MFA code and
 * is told their session is invalid. Best-effort: a miss leaves the original
 * TTL. (Call sites reference this doc rather than restating it.)
 */
export async function touchSsoPendingLink(tokenHash: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const record = parseRecord(await redis.get(pendingKey(tokenHash)));
  if (!record) return;
  await redis.setex(
    pendingKey(tokenHash),
    SSO_PENDING_LINK_TTL_SECONDS,
    JSON.stringify({ ...record, createdAt: Date.now() }),
  );
}

/** Hard invalidation (attempt exhaustion, stale-state verdicts). Best-effort. */
export async function deleteSsoPendingLink(tokenHash: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(pendingKey(tokenHash));
}
