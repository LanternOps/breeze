import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bootstrapFromCfAccessRedirect, bootstrapFromSsoCode, restoreAccessTokenFromCookieDetailed, settleSsoLoginGate, useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';
import { navigateTo } from '../../lib/navigation';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

const CF_ACCESS_LOGIN_PARAM = 'cf-access-login';
const SSO_CODE_FRAGMENT_PREFIX = 'ssoCode=';

// SSO callback token handoff (#3700): after a successful IdP login the API
// redirects here with a one-time token-exchange grant in the URL FRAGMENT
// (`/#ssoCode=<grant>`) — fragments never reach the server, so the grant can't
// land in access logs or Referer headers. Consuming it strips the fragment
// from the address bar immediately (before the async exchange settles) so the
// single-use grant can't be re-triggered by a reload or copied out of the URL.
//
// `present` is reported separately from `code` because the caller must be able
// to tell "no SSO handoff happened" apart from "there WAS a handoff and the
// grant was unusable" (truncated by a chat/mail client, bad percent-encoding).
// The latter still deserves the sso_exchange_failed notice — collapsing both
// to null would bounce a real-but-corrupt handoff to a bare, unexplained
// /login, which is the support dead-end this feature exists to remove.
type SsoCodeFragment = { present: false } | { present: true; code: string | null };

function consumeSsoCodeFragment(): SsoCodeFragment {
  if (typeof window === 'undefined') return { present: false };
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith(SSO_CODE_FRAGMENT_PREFIX)) return { present: false };
  const raw = hash.slice(SSO_CODE_FRAGMENT_PREFIX.length).split('&')[0] ?? '';
  window.history.replaceState({}, '', window.location.pathname + window.location.search);
  let code: string | null;
  try {
    code = decodeURIComponent(raw) || null;
  } catch {
    code = null;
  }
  return { present: true, code };
}

function consumeCfAccessLoginParam(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get(CF_ACCESS_LOGIN_PARAM) !== 'success') return false;
  params.delete(CF_ACCESS_LOGIN_PARAM);
  const cleanSearch = params.toString();
  const cleanUrl =
    window.location.pathname +
    (cleanSearch ? `?${cleanSearch}` : '') +
    window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
  return true;
}

export default function AuthOverlay() {
  const { t } = useTranslation('auth');
  const { isAuthenticated, isLoading, tokens, sessionExpiredReason, authThrottledUntil } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverAttempted, setRecoverAttempted] = useState(false);
  const [cfBootstrapAttempted, setCfBootstrapAttempted] = useState(false);
  const [ssoBootstrapAttempted, setSsoBootstrapAttempted] = useState(false);
  const [fadeState, setFadeState] = useState<'visible' | 'fading' | 'hidden'>('visible');

  useEffect(() => {
    // Give the store time to rehydrate from localStorage
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 50);

    return () => clearTimeout(timer);
  }, []);

  // Safety net: if the overlay is still visible after 10 seconds, force redirect to login.
  // This prevents the user from being stuck on "Loading..." indefinitely.
  useEffect(() => {
    const safetyTimer = setTimeout(() => {
      const state = useAuthStore.getState();
      // CONSTRAINT: same invariant as the redirect branch below — once
      // `handleSessionExpired` owns the navigation this must stay dormant, or
      // its soft nav races the hard redirect and drops `next`/`reason`.
      if (state.sessionExpiredReason) return;
      // A rate-limited refresh legitimately takes longer than this timer
      // (the server's window is 60s). Bouncing to /login here would reinstate
      // exactly the forced logout #3696 removes — the throttle mask below just
      // reflects the wait; the auth store (not this timer) owns automatic
      // recovery (#3984).
      if (state.authThrottledUntil && state.authThrottledUntil > Date.now()) return;
      if (!state.isAuthenticated || !state.tokens?.accessToken) {
        redirectToLogin();
      }
    }, 10_000);

    return () => clearTimeout(safetyTimer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (isChecking || isLoading) return;

    // Fast path: tokens were rehydrated from localStorage — no network needed.
    // A leftover `#ssoCode=` fragment (e.g. a re-visited SSO redirect while
    // already signed in) is stripped without an exchange: the live session wins
    // and the stale single-use grant must not linger in the address bar.
    if (isAuthenticated && tokens?.accessToken) {
      if (consumeSsoCodeFragment().present) settleSsoLoginGate();
      return;
    }

    // SSO redirect bootstrap (#3700): the SSO callback completed the IdP login
    // and handed us a one-time exchange grant in the fragment. Trade it for
    // tokens before any other recovery path — it represents a FRESH login, so
    // it outranks both the CF Access param and a possibly-dead refresh cookie
    // from a previous session (which is exactly the state a user locked out by
    // enforce-SSO arrives in). Runs once per overlay mount. Every outcome must
    // settleSsoLoginGate(), or refreshes queued behind the gate hang until its
    // timeout.
    if (!ssoBootstrapAttempted) {
      const fragment = consumeSsoCodeFragment();
      if (fragment.present && !fragment.code) {
        // A handoff arrived but the grant is unusable (empty or malformed
        // percent-encoding — typically a truncated link). Surface the same
        // notice as a failed exchange instead of falling through to the bare
        // /login redirect below, which would be undiagnosable from a support
        // ticket: the evidence was just stripped from the address bar.
        setSsoBootstrapAttempted(true);
        // Same reasoning as the failed-exchange path below: isRecovering stays
        // true so the effect re-run's bare `/login` branch can't race this
        // redirect and strip the error param.
        setIsRecovering(true);
        console.warn('[AuthOverlay] malformed ssoCode fragment; bouncing to login');
        void navigateTo('/login?error=sso_exchange_failed', { replace: true });
        settleSsoLoginGate();
        return () => { cancelled = true; };
      }
      if (fragment.present && fragment.code) {
        setSsoBootstrapAttempted(true);
        setIsRecovering(true);
        void bootstrapFromSsoCode(fragment.code)
          .catch((err) => {
            // bootstrapFromSsoCode resolves false on every expected failure;
            // a rejection is a genuine bug, but it must still surface the
            // error redirect rather than stranding the user on the spinner.
            console.warn('[AuthOverlay] unexpected SSO bootstrap rejection', err);
            return false;
          })
          .then((ok) => {
            if (!ok) {
              // NOT gated on `cancelled`: the setSsoBootstrapAttempted /
              // setIsRecovering calls above re-run this effect immediately,
              // which flips `cancelled` on the old closure long before the
              // exchange settles — gating here would silently swallow the
              // failure redirect. isRecovering also deliberately stays true:
              // dropping it re-arms the final !isAuthenticated branch, whose
              // bare `/login` redirect races this one and strips the error
              // param. The navigation below unmounts the overlay anyway.
              // Gate settles AFTER the navigation is issued so a queued
              // refresh's own eviction redirect can't beat this one.
              void navigateTo('/login?error=sso_exchange_failed', { replace: true });
              settleSsoLoginGate();
              return;
            }
            settleSsoLoginGate();
            // Ungated on purpose (`cancelled` is always true by now, see
            // above): the overlay still hides via shouldHide regardless, but
            // isRecovering must drop so the slow-path branch isn't suppressed
            // for the rest of the session.
            setIsRecovering(false);
          });
        return () => { cancelled = true; };
      }
    }

    // CF Access redirect bootstrap: the server's GET /api/v1/auth/cf-access-login
    // endpoint sets a refresh cookie and redirects here with ?cf-access-login=success.
    // The SPA has no in-memory session yet, so trade the cookie for tokens and fetch
    // the user before falling through to the normal "no session, redirect to /login"
    // path. This runs once per overlay mount.
    if (!isAuthenticated && !cfBootstrapAttempted) {
      const shouldBootstrap = consumeCfAccessLoginParam();
      if (shouldBootstrap) {
        setCfBootstrapAttempted(true);
        setIsRecovering(true);
        void bootstrapFromCfAccessRedirect().then((ok) => {
          if (cancelled) return;
          setIsRecovering(false);
          if (!ok) {
            void navigateTo('/login?error=cf-access', { replace: true });
          }
        });
        return () => { cancelled = true; };
      }
    }

    // Slow path: authenticated but no token (e.g. first load after login on
    // another tab). `!isRecovering` keeps it out of the stale-persisted-auth +
    // fresh-#ssoCode state: while the SSO exchange is in flight this branch
    // would otherwise race it with a dead-cookie refresh whose failure
    // redirects to a bare /login mid-exchange.
    if (isAuthenticated && !tokens?.accessToken && !recoverAttempted && !isRecovering) {
      setRecoverAttempted(true);
      setIsRecovering(true);

      void restoreAccessTokenFromCookieDetailed().then((outcome) => {
        if (cancelled) return;
        setIsRecovering(false);

        // 'throttled' (#3696) is NOT a dead session — the server rate-limited
        // /auth/refresh and never judged the cookie. Bouncing to /login here is
        // the forced-logout bug. The throttle mask below takes over: it shows
        // why the page is waiting and retries when the window elapses.
        if (outcome === 'throttled') return;

        if (outcome !== 'restored') {
          redirectToLogin();
        }
      });

      return () => { cancelled = true; };
    }

    if (isRecovering) {
      return () => { cancelled = true; };
    }

    // CONSTRAINT: this is a SECOND redirect path, and it must stay dormant once
    // `handleSessionExpired` owns the navigation. That helper flips
    // `isAuthenticated` to false (via logout()) synchronously before its
    // `window.location.replace('/login?next=…&reason=…')`, which re-runs this
    // effect; an ungated soft `navigateTo('/login')` here races the hard
    // redirect and, when it wins, lands the user on a bare /login with no
    // notice and no deep link. `sessionExpiredReason` is the flag that the
    // expiry flow is in progress — never drop this guard.
    if (!isAuthenticated && !sessionExpiredReason) {
      redirectToLogin();
    }

    return () => { cancelled = true; };
  }, [isAuthenticated, isLoading, isChecking, tokens, recoverAttempted, isRecovering, cfBootstrapAttempted, ssoBootstrapAttempted, sessionExpiredReason]);

  // Authenticated with token — fade out then unmount
  const shouldHide = !isChecking && !isLoading && isAuthenticated && !!tokens?.accessToken;

  useEffect(() => {
    if (shouldHide && fadeState === 'visible') {
      // Start fade-out on next frame so the browser paints opacity:1 first
      requestAnimationFrame(() => setFadeState('fading'));
    }
  }, [shouldHide, fadeState]);

  // Session expiry mask. Checked BEFORE the `fadeState === 'hidden'` early
  // return: by the time a session expires the overlay has long since faded out
  // and unmounted itself, and `handleSessionExpired()` has already gutted the
  // store — without this branch the user stares at an empty sidebar and blank
  // widgets until the browser finishes the redirect. Purely cosmetic: the
  // navigation is `window.location.replace` inside `handleSessionExpired`, this
  // component must never navigate on its own.
  if (sessionExpiredReason) {
    return (
      <div
        data-testid="session-expired-overlay"
        className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      >
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">
            {t('common.sessionExpiredRedirecting', {
              defaultValue: 'Your session has expired — redirecting to sign in…',
            })}
          </p>
        </div>
      </div>
    );
  }

  // Refresh-throttle mask (#3696). Rendered AFTER the expiry branch (a real
  // expiry always wins) but BEFORE the `fadeState === 'hidden'` early return,
  // for the same reason the expiry mask is: by the time a mid-session refresh
  // gets throttled this overlay has faded out and unmounted, and without this
  // branch the user sees a fully-painted page whose every data call 401'd with
  // no explanation — the silent variant of this bug, which is worse than the
  // logout because it looks like real (empty) data.
  //
  // Non-destructive by construction: the session is untouched, nothing is
  // logged out, and recovery is automatic.
  //
  // Gated on there being no usable access token, and that gate is load-bearing.
  // The justification above only holds when the token is gone — that is what
  // makes the data calls 401. A throttle can also arrive on a refresh the user
  // never needed: AdminSessionManager runs a keepalive `refreshAccessToken()`
  // on an interval while `isAuthenticated` (AdminSessionManager.tsx:308-320),
  // so a 429 there lands while the access token is still valid and every data
  // call is still succeeding. Masking that session would be wrong on its own,
  // and the store's own throttle recovery (`scheduleThrottleReload`, #3984)
  // ends with `window.location.reload()` — so an unconditional branch would
  // throw away unsaved work to "recover" a session that was never impaired.
  // (The store re-checks this same condition before it actually reloads, but
  // this branch must stay in sync with it regardless.) See #3696 review.
  if (authThrottledUntil !== null && !tokens?.accessToken) {
    return <AuthThrottledMask retryAt={authThrottledUntil} />;
  }

  if (fadeState === 'hidden') {
    return null;
  }

  if (shouldHide) {
    return (
      <div
        className={`fixed inset-0 z-50 flex items-center justify-center bg-background transition-opacity duration-300 pointer-events-none ${fadeState === 'fading' ? 'opacity-0' : 'opacity-100'}`}
        onTransitionEnd={() => setFadeState('hidden')}
      />
    );
  }

  // Still initializing or recovering — show overlay
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">
          {isChecking || isLoading || isRecovering
            ? t('common.loading', { defaultValue: 'Loading...' })
            : t('common.redirectingToLogin', { defaultValue: 'Redirecting to login...' })}
        </p>
      </div>
    </div>
  );
}

function redirectToLogin() {
  void navigateTo('/login', { replace: true });
}

/**
 * Shown while POST /auth/refresh is rate-limited (#3696). The session is fine —
 * this is a wait, not an eviction — so the copy must not say "expired".
 *
 * Purely a display: the countdown is cosmetic. The actual recovery reload is
 * owned and scheduled by the auth store (`scheduleThrottleReload`, #3984) once
 * its own bounded in-memory retry is exhausted — a full reload rather than an
 * in-place retry because the web app is an Astro MPA whose access token is
 * memory-only, so a fresh document is what re-runs the bootstrap refresh. This
 * component used to independently reload at the end of its OWN countdown,
 * racing the store's own retry-in-progress at the same deadline; the reload
 * usually won, wasting the store's retry. Never re-add an automatic action
 * here — the store is the single owner of recovery.
 */
function AuthThrottledMask({ retryAt }: { retryAt: number }) {
  const { t } = useTranslation('auth');
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
  );

  useEffect(() => {
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  return (
    <div
      data-testid="auth-throttled-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
    >
      <div className="max-w-sm text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        <p className="mt-4 text-sm font-medium">
          {t('common.refreshThrottledTitle', {
            defaultValue: 'Too many requests — reconnecting',
          })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('common.refreshThrottledBody', {
            count: secondsLeft,
            defaultValue: "You're still signed in. Retrying in {{count}}s…",
          })}
        </p>
        <div className="mt-4 flex items-center justify-center gap-4">
          <button
            type="button"
            data-testid="auth-throttled-retry"
            className="text-sm text-primary underline underline-offset-4"
            onClick={() => window.location.reload()}
          >
            {t('common.refreshThrottledRetry', { defaultValue: 'Retry now' })}
          </button>
          {/* Escape hatch: a client stuck in a repeating throttle would
              otherwise have no way out of the mask short of clearing storage.
              Signing out is always available and is never automatic — the
              whole point of #3696 is that WE must not decide to sign them out. */}
          <button
            type="button"
            data-testid="auth-throttled-signout"
            className="text-sm text-muted-foreground underline underline-offset-4"
            onClick={() => {
              useAuthStore.getState().logout();
              void navigateTo('/login', { replace: true });
            }}
          >
            {t('common.signOut', { defaultValue: 'Sign Out' })}
          </button>
        </div>
      </div>
    </div>
  );
}
