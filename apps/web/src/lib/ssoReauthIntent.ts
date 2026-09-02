/**
 * #4055 — which card started the IdP re-verification round-trip.
 *
 * A passwordless (SSO-provisioned) account can start the same
 * `POST /sso/reauth/start` trip from two places on the profile page: the TOTP
 * setup card and the "Add a passkey" card. Both leave the origin entirely
 * (`window.location.assign(<IdP url>)`), so every scrap of React state is gone
 * by the time the SSO callback redirects back to
 * `/settings/profile#ssoReauthGrant=<id>` — and that return URL is minted
 * server-side, so the client cannot hang anything off it.
 *
 * Hence sessionStorage rather than this repo's usual `window.location.hash`
 * convention for UI state: the hash convention covers in-page state on a URL we
 * control, and neither half of that holds here. Same shape, and the same
 * private-mode caveat, as `orgSwitch.ts`'s switch-toast stash — carry one small
 * fact across a full-page navigation, then consume it.
 *
 * Deliberately NOT round-tripped through the API: the re-auth state row is
 * security-relevant (epochs, sid, single-use grant), and a purely presentational
 * "which card do I go back to" preference has no business on it.
 */

export type SsoReauthIntent = 'totp' | 'passkey';

export const SSO_REAUTH_INTENT_KEY = 'breeze.ssoReauth.intent';

function isIntent(value: string | null): value is SsoReauthIntent {
  return value === 'totp' || value === 'passkey';
}

/** Record the originating card immediately before navigating to the IdP. */
export function stashSsoReauthIntent(intent: SsoReauthIntent): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SSO_REAUTH_INTENT_KEY, intent);
  } catch {
    // Private mode / blocked storage / quota. The intent only decides which
    // card the user lands on; never fail the enrollment trip over it. The
    // reader's `null` fallback keeps the historical TOTP road.
  }
}

/**
 * Read and CONSUME the recorded intent.
 *
 * Consuming matters as much as reading: the grant is single-use, so a value
 * left behind would misroute the NEXT round-trip. An unrecognized value is
 * cleared too — otherwise a stale or foreign write sits there poisoning every
 * later read. `null` means "not recorded", and callers must treat that as the
 * pre-#4055 default (TOTP) so a storage-blocked browser behaves as it always
 * did rather than losing the QR screen.
 */
export function takeSsoReauthIntent(): SsoReauthIntent | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(SSO_REAUTH_INTENT_KEY);
    if (stored !== null) window.sessionStorage.removeItem(SSO_REAUTH_INTENT_KEY);
    return isIntent(stored) ? stored : null;
  } catch {
    return null;
  }
}
