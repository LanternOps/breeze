import { useEffect, useState } from 'react';
import { parseSignupIntentParams, signupIntentHandoffQuery, type SignupIntent } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import PartnerRegisterForm from './PartnerRegisterForm';
import StatusIcon from './StatusIcon';
import { apiRegisterPartner, restoreAccessTokenFromCookieDetailed, useAuthStore } from '../../stores/auth';
import { useRegistrationGate } from '../../stores/featuresStore';
import { navigateTo } from '../../lib/navigation';
import { fetchSignupOffer, type SignupOffer } from '../../lib/signupOffer';
// Initializes the shared i18next singleton. This page's layout has no Sidebar
// (which is what pulls i18n in elsewhere), so without this every t() call here
// renders its raw key.
import '../../lib/i18n';

// The `next` prop is accepted for URL compatibility but is no longer consumed:
// SR2-21 makes signup email-first, so there is no post-submit navigation to
// forward. The eventual login happens on the verify-email page (step 2).
interface PartnerRegisterPageProps {
  next?: string;
}

export default function PartnerRegisterPage(_props: PartnerRegisterPageProps = {}) {
  const { t } = useTranslation('auth');
  const [error, setError] = useState<string>();
  const [errorAction, setErrorAction] = useState<{ url: string; label: string }>();
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // What this signup is for. Unknown or malformed values fall back to the
  // cloud intent; there is no error state for a bad link.
  const [handoff, setHandoff] = useState<{ intent: SignupIntent; explicit: boolean } | null>(null);
  const [offer, setOffer] = useState<SignupOffer | null>(null);
  const signupIntent = handoff?.intent ?? { intent: 'cloud' as const };
  const billingPlansUrl = `/billing/plans?${signupIntentHandoffQuery(signupIntent)}`;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setHandoff({ intent: parseSignupIntentParams(params), explicit: params.has('intent') || params.has('offer') || params.has('catalog') });
  }, []);

  // The quote comes from billing only. A failed lookup shows no price and
  // never blocks registration.
  useEffect(() => {
    let cancelled = false;
    void fetchSignupOffer().then((quote) => { if (!cancelled) setOffer(quote); });
    return () => { cancelled = true; };
  }, []);

  // Sweep paper cut #1: this is a bare Astro page reached by a full-page
  // navigation, so an already-signed-in visitor arrives with a persisted
  // `isAuthenticated` flag but no in-memory access token — the exact
  // condition fetchWithAuth's own bootstrap-recovery branch keys on. Left
  // alone, the registration gate below reads /config through fetchWithAuth,
  // which re-derives that same condition, and on any refresh hiccup calls
  // handleSessionExpired and hard-navigates to /login?reason=session-expired
  // — wrong and confusing for someone who is, in fact, signed in. Resolve
  // the ambiguity ONCE up front with the same cookie-refresh check AuthGuard
  // uses (restoreAccessTokenFromCookieDetailed never itself redirects): a
  // real session goes to the dashboard instead of the registration form; a
  // merely stale flag is cleared here so the gate's own /config call below
  // runs unauthenticated and can never re-enter that race.
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [sessionChecked, setSessionChecked] = useState(!isAuthenticated);
  const [alreadySignedIn, setAlreadySignedIn] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !handoff) return;
    let cancelled = false;
    void restoreAccessTokenFromCookieDetailed().then((outcome) => {
      if (cancelled) return;
      if (outcome === 'restored') {
        setAlreadySignedIn(true);
        void navigateTo(handoff.explicit ? billingPlansUrl : '/dashboard', { replace: true });
        return;
      }
      // Only a definitive refusal clears the persisted flag. 'throttled'
      // (#3696) and 'transient' (a 502/offline/timeout on /auth/refresh) are
      // not verdicts on the session — evicting here on a transient would
      // hard-log-out a valid session, the regression QA 2026-07-08 fixed in
      // AuthGuard. Leave the flag alone and let the gate's own request judge.
      if (outcome === 'auth-failed' || outcome === 'origin-rejected') {
        useAuthStore.getState().logout();
      }
      setSessionChecked(true);
    });
    return () => { cancelled = true; };
    // Resolve only after the handoff is parsed; a stale-auth eviction must not
    // re-arm this check. The intent is a hint passed to normal billing auth.
  }, [handoff]);

  // Runtime registration gate (#1308). The server enforces ENABLE_REGISTRATION
  // on /auth/register-partner; this mirrors it client-side so the form isn't
  // shown (then rejected) when registration is disabled. We wait for /config
  // to load before deciding, so an open deployment never flashes the redirect.
  // `active: sessionChecked` defers the /config fetch (see above) until the
  // already-signed-in check above has resolved.
  const { enabled: registrationEnabled, loaded: gateLoaded } = useRegistrationGate(sessionChecked);
  useEffect(() => {
    if (handoff && sessionChecked && gateLoaded && !registrationEnabled) {
      void navigateTo(`/login?reason=registration-disabled&next=${encodeURIComponent(billingPlansUrl)}`);
    }
  }, [handoff, billingPlansUrl, sessionChecked, gateLoaded, registrationEnabled]);

  const handleRegister = async (values: {
    companyName: string;
    name: string;
    email: string;
    password: string;
    acceptTerms: boolean;
  }) => {
    setLoading(true);
    setError(undefined);
    setErrorAction(undefined);

    const result = await apiRegisterPartner(
      values.companyName,
      values.email,
      values.password,
      values.name,
      signupIntent
    );

    if (!result.success) {
      setError(result.error);
      setErrorAction(result.action);
      setLoading(false);
      return;
    }

    // SR2-21: registration no longer auto-logs-in. The server created NOTHING —
    // no partner, no user, no session — and deliberately returns the same body
    // whether or not the address already has an account. Render one terminal
    // "check your email" state; branching on anything the server said here
    // would rebuild the enumeration oracle in the client.
    setSubmitted(true);
    setLoading(false);
  };

  if (!handoff) return null;
  // Until the already-signed-in check resolves, or once it finds a real
  // session (the effect above is redirecting to the dashboard), render
  // nothing rather than flashing the registration form.
  if (!sessionChecked || alreadySignedIn) {
    return null;
  }

  // Until /config resolves, or once we know registration is disabled (the
  // effect above is redirecting), render nothing rather than the form.
  if (!gateLoaded || !registrationEnabled) {
    return null;
  }

  if (submitted) {
    return (
      <div data-testid="register-check-email" className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">
            {t('register.checkEmail.title', { defaultValue: 'Check your email' })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('register.checkEmail.description', {
              defaultValue:
                "If registration can proceed, we've sent a confirmation link to that address. Click it to finish creating your account.",
            })}
          </p>
        </div>
        <a
          href={`/login?next=${encodeURIComponent(billingPlansUrl)}`}
          className="flex h-11 w-full items-center justify-center rounded-md border text-sm font-medium transition hover:bg-muted"
        >
          {t('common.backToSignIn', { defaultValue: 'Back to sign in' })}
        </a>
      </div>
    );
  }

  return (
    <PartnerRegisterForm
      onSubmit={handleRegister}
      errorMessage={error}
      errorAction={errorAction}
      loading={loading}
      signupIntent={signupIntent}
      offer={offer}
    />
  );
}
