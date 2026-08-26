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
 *    HttpOnly cookie scoped to /api/v1/sso/link (browser binding — the ceremony
 *    can only be completed by the browser that finished the OIDC round-trip,
 *    so a forwarded URL is useless to a phisher). The raw token is never
 *    stored inside the record value and never logged.
 *  - 5-minute TTL, matching the mfa:pending login window.
 *  - completion consumes via atomic GETDEL — exactly one winner under
 *    concurrency.
 *  - fails CLOSED: no Redis ⇒ createSsoPendingLink throws and the callback
 *    falls back to the legacy sso_link_required bounce.
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
  /** users.status snapshot; a suspend during the window invalidates the record. */
  userStatus: string;
  /** Epoch snapshots (SR2-06 idiom): a password reset / factor change / global
   * logout during the window invalidates the record. */
  authEpoch: number;
  mfaEpoch: number;
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
  /** email_verified provenance: 'true' | 'absent'. When 'absent', the callback
   * only accepted the assertion because the email domain was DNS-verified at
   * the time — completion must re-check that domain proof. */
  emailVerifiedClaim: string;
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
  try {
    return JSON.parse(raw) as SsoPendingLink;
  } catch {
    return null;
  }
}

/** Non-consuming read: the password step and the page's describe call must not
 * burn the record — only successful completion (or exhaustion) does. */
export async function peekSsoPendingLink(tokenHash: string): Promise<SsoPendingLink | null> {
  const redis = getRedis();
  if (!redis) return null;
  return parseRecord(await redis.get(pendingKey(tokenHash)));
}

/** Atomic single-winner consumption — called only when completion is about to
 * link + mint (or by the MFA continuation's finalizer). */
export async function consumeSsoPendingLink(tokenHash: string): Promise<SsoPendingLink | null> {
  const redis = getRedis();
  if (!redis) return null;
  return parseRecord(await getDelAtomic(redis as RedisWithGetDel, pendingKey(tokenHash)));
}

/** Hard invalidation (attempt exhaustion, stale-state verdicts). Best-effort. */
export async function deleteSsoPendingLink(tokenHash: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(pendingKey(tokenHash));
}
