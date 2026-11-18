import { isSsoReauthIntent, type SsoReauthIntent } from './ssoReauthIntent';

/**
 * #8862 — the SSO re-auth grant, carried across a remount of the profile page.
 *
 * The callback hands the grant back once, in `#ssoReauthGrant=<id>`, and
 * ProfilePage strips that fragment the moment it reads it (a single-use proof
 * must not sit in the address bar). Until this stash existed the grant then
 * lived ONLY in React state, so anything that mounted the page a second time —
 * a reload, a soft navigation back to the page, an island re-hydrating — threw
 * it away. The TOTP road never noticed, because it spends the grant on
 * `/mfa/setup` during the first mount; the passkey road waits for a click, and
 * an SSO-only technician landed back on "Verify with your identity provider"
 * with no way forward.
 *
 * The stash MIRRORS the page's grant state: written when the grant arrives,
 * removed wherever the page drops the grant (spent, or rejected as dead). The
 * server stays the authority — the grant is bound to the user, session and
 * MFA epoch it was minted under, `register/options` only validates it,
 * `register/verify` / `mfa/enable` consume it, and it expires 300 s after
 * minting. Nothing here extends that: the client TTL is shorter, so a remount
 * can never arm the card with a proof the server has already let lapse.
 *
 * Same storage, same private-mode caveat, as the intent stash beside it
 * (`ssoReauthIntent.ts`): sessionStorage is per tab, survives a reload, and is
 * gone when the tab closes. A blocked storage simply restores the pre-#8862
 * behaviour (grant held in state only).
 */

export const SSO_REAUTH_GRANT_KEY = 'breeze.ssoReauth.grant';

/**
 * Comfortably inside the server's 300 s grant TTL. The clock starts when the
 * page lands, a beat after the server minted the grant, so the margin covers
 * the redirect hop as well as ordinary clock noise.
 */
export const SSO_REAUTH_GRANT_CLIENT_TTL_MS = 270_000;

// The API types every grant id as `z.string().uuid()`; anything else is a
// foreign or corrupted write and is not worth sending.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoredGrant = {
  grantId: string;
  intent: SsoReauthIntent | null;
  userId: string;
  expiresAt: number;
};

export type RestoredSsoReauthGrant = {
  grantId: string;
  /** The card the round-trip started from; `null` = the historical TOTP road. */
  intent: SsoReauthIntent | null;
};

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Drop the stashed grant. Safe to call when nothing is stashed. */
export function clearSsoReauthGrant(): void {
  try {
    storage()?.removeItem(SSO_REAUTH_GRANT_KEY);
  } catch {
    // Blocked storage: there is nothing we could have written either.
  }
}

/**
 * Record the grant the callback just handed back, with the intent that routed
 * it. Bound to the signed-in user: without a known user nothing is written,
 * since a grant that cannot be tied to an account must not be restored to one.
 */
export function stashSsoReauthGrant(
  grantId: string,
  intent: SsoReauthIntent | null,
  userId: string | null | undefined,
  now: number = Date.now(),
): void {
  if (!userId || !UUID_RE.test(grantId)) return;
  const record: StoredGrant = { grantId, intent, userId, expiresAt: now + SSO_REAUTH_GRANT_CLIENT_TTL_MS };
  try {
    storage()?.setItem(SSO_REAUTH_GRANT_KEY, JSON.stringify(record));
  } catch {
    // Private mode / quota. The grant still lives in React state for this
    // mount; only remount survival is lost.
  }
}

function parse(raw: string): StoredGrant | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.grantId !== 'string' || !UUID_RE.test(v.grantId)) return null;
  if (v.intent !== null && !isSsoReauthIntent(v.intent)) return null;
  if (typeof v.userId !== 'string' || !v.userId) return null;
  if (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) return null;
  return { grantId: v.grantId, intent: v.intent as SsoReauthIntent | null, userId: v.userId, expiresAt: v.expiresAt };
}

/**
 * Read the stashed grant for `userId` WITHOUT consuming it — a remount is not a
 * spend. Anything unusable (expired, malformed, an expiry further out than this
 * build would ever write, or another account's) is cleared as it is rejected,
 * so it cannot sit there being re-offered.
 */
export function readSsoReauthGrant(
  userId: string | null | undefined,
  now: number = Date.now(),
): RestoredSsoReauthGrant | null {
  // Unknown viewer (auth store not hydrated): say nothing, but leave the entry
  // for a read that can actually check whose it is.
  if (!userId) return null;
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(SSO_REAUTH_GRANT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const record = parse(raw);
  const usable =
    record !== null
    && record.userId === userId
    && now < record.expiresAt
    && record.expiresAt - now <= SSO_REAUTH_GRANT_CLIENT_TTL_MS;
  if (!usable || !record) {
    clearSsoReauthGrant();
    return null;
  }
  return { grantId: record.grantId, intent: record.intent };
}
