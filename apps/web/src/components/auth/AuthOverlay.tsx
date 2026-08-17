import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bootstrapFromCfAccessRedirect, bootstrapFromSsoCode, restoreAccessTokenFromCookie, useAuthStore } from '../../stores/auth';
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
function consumeSsoCodeFragment(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith(SSO_CODE_FRAGMENT_PREFIX)) return null;
  const raw = hash.slice(SSO_CODE_FRAGMENT_PREFIX.length).split('&')[0] ?? '';
  window.history.replaceState({}, '', window.location.pathname + window.location.search);
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return null;
  }
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
  const { isAuthenticated, isLoading, tokens, sessionExpiredReason } = useAuthStore();
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
      consumeSsoCodeFragment();
      return;
    }

    // SSO redirect bootstrap (#3700): the SSO callback completed the IdP login
    // and handed us a one-time exchange grant in the fragment. Trade it for
    // tokens before any other recovery path — it represents a FRESH login, so
    // it outranks both the CF Access param and a possibly-dead refresh cookie
    // from a previous session (which is exactly the state a user locked out by
    // enforce-SSO arrives in). Runs once per overlay mount.
    if (!ssoBootstrapAttempted) {
      const ssoCode = consumeSsoCodeFragment();
      if (ssoCode) {
        setSsoBootstrapAttempted(true);
        setIsRecovering(true);
        void bootstrapFromSsoCode(ssoCode).then((ok) => {
          if (!ok) {
            // NOT gated on `cancelled`: the setSsoBootstrapAttempted /
            // setIsRecovering calls above re-run this effect immediately,
            // which flips `cancelled` on the old closure long before the
            // exchange settles — gating here would silently swallow the
            // failure redirect. isRecovering also deliberately stays true:
            // dropping it re-arms the final !isAuthenticated branch, whose
            // bare `/login` redirect races this one and strips the error
            // param. The navigation below unmounts the overlay anyway.
            void navigateTo('/login?error=sso_exchange_failed', { replace: true });
            return;
          }
          if (!cancelled) setIsRecovering(false);
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

    // Slow path: authenticated but no token (e.g. first load after login on another tab)
    if (isAuthenticated && !tokens?.accessToken && !recoverAttempted) {
      setRecoverAttempted(true);
      setIsRecovering(true);

      void restoreAccessTokenFromCookie().then((restored) => {
        if (cancelled) return;
        setIsRecovering(false);

        if (!restored) {
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
