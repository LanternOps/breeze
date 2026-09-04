import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LoginForm from './LoginForm';
import MFAVerifyForm from './MFAVerifyForm';
import McpUrlCard from '../shared/McpUrlCard';
import {
  useAuthStore,
  apiLogin,
  apiVerifyMFA,
  apiVerifyPasskeyMFA,
  apiSendSmsMfaCode,
  fetchAndApplyPreferences
} from '../../stores/auth';
import type { MfaChallenge, MfaMethod } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { getSafeNext } from '../../lib/authNext';
import { getLoginContext } from '../../lib/loginContext';
import { discoverOrgSso, type SsoDiscoveryProvider } from '../../lib/ssoDiscovery';
import { parseMfaChallengeResponse } from '../../lib/mfaChallenge';
// Initializes the shared i18next singleton. This page's layout has no Sidebar
// (which is what pulls i18n in elsewhere), so without this every t() call here
// renders its raw key.
import '../../lib/i18n';

function getRegistrationDisabledNotice(t: ReturnType<typeof useTranslation<'auth'>>['t']): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  if (params.get('reason') === 'registration-disabled') {
    return t('login.notices.registrationDisabled', {
      defaultValue: 'New registrations are currently disabled. Please contact your administrator.',
    });
  }
}

// Copy for `?reason=<code>` bounces produced by handleSessionExpired() in the
// auth store, which appends the code when it redirects an expired session here.
// Informational, not an error: the user did nothing wrong, they just need to
// sign in again. Unknown codes render nothing.
function getSessionExpiredNotice(t: ReturnType<typeof useTranslation<'auth'>>['t']): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const reason = new URLSearchParams(window.location.search).get('reason');
  const sessionExpiredCopy: Record<string, string> = {
    'session-expired': t('login.notices.sessionExpired', {
      defaultValue: 'Your session expired. Please sign in again to continue.',
    }),
    idle: t('login.notices.idle', {
      defaultValue: 'You were signed out due to inactivity.',
    }),
    // Not an expiry: POST /auth/refresh answered 403 "Invalid request origin",
    // i.e. the API was never told about the address this browser is using
    // (classically a self-hoster on an SSH tunnel — https://localhost:8443
    // against a CORS_ALLOWED_ORIGINS of https://localhost). Without naming the
    // origin, the bounce is indistinguishable from a bad password and it
    // repeats after every successful sign-in.
    'origin-rejected': t('login.notices.originRejected', {
      origin: window.location.origin,
      defaultValue:
        'This Breeze server is not configured to accept sign-ins from {{origin}}. Open Breeze at the public URL set during setup (PUBLIC_APP_URL), or add {{origin}} to CORS_ALLOWED_ORIGINS in .env and restart the API.',
    }),
  };
  return reason ? sessionExpiredCopy[reason] : undefined;
}

// Copy for SSO callback `?error=<reason>` bounces that land back on /login.
// `sso_link_required` (#2183/#4067): since #4067, password-holding users are
// routed into the connect-your-sign-in ceremony instead of landing here. This
// banner remains only for the flows that can't enter it (an SSO-only account
// already linked to a DIFFERENT provider, or the ceremony store being
// unavailable) — so it must never instruct a password login, which
// enforce_sso may forbid tenant-wide.
function getSsoLoginNotice(t: ReturnType<typeof useTranslation<'auth'>>['t']): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const ssoLoginErrorCopy: Record<string, string> = {
    sso_link_required: t('login.ssoErrors.ssoLinkRequired', {
      defaultValue:
        'Your sign-in succeeded, but it couldn’t be connected to your account automatically. Sign in the way you usually do, or contact your administrator.',
    }),
  // Partner axis (#2183): identity-first, no JIT — an unrecognized identity
  // needs an out-of-band invite before SSO can sign it in.
    invite_required: t('login.ssoErrors.inviteRequired', {
      defaultValue:
        'Your sign-in succeeded, but no account here is linked to that identity yet. Ask your administrator for an invite, then try again.',
    }),
    no_partner_access: t('login.ssoErrors.noPartnerAccess', {
      defaultValue: 'That account does not have access to this workspace. Contact your administrator.',
    }),
  // The verified IdP identity is already linked to a DIFFERENT account
  // (#2195 unique-index race guard in the callback).
    identity_in_use: t('login.ssoErrors.identityInUse', {
      defaultValue: 'That sign-in identity is already linked to a different account. Contact your administrator.',
    }),
    // #3700: AuthOverlay's `#ssoCode` → POST /sso/exchange handoff failed (the
    // single-use grant expired/was consumed, the grant fragment was malformed,
    // the exchange request failed, or a step AFTER a successful exchange
    // failed — in that last case the refresh cookie is already set and the
    // cookie-restore path on this page may sign the user in without any
    // re-initiation). The IdP login itself succeeded in every case.
    sso_exchange_failed: t('login.ssoErrors.ssoExchangeFailed', {
      defaultValue: 'Single sign-on almost completed, but the final sign-in step failed. Please start the sign-in again.',
    }),
  };
  return error ? ssoLoginErrorCopy[error] : undefined;
}

function shouldSkipCfAccessRedirect(): boolean {
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  // Don't loop:
  // - error=cf-access  → we just bounced off a failed JWT verification
  // - cf-access-login=success → we just succeeded; AuthOverlay handles the rest
  // - signedOut=1 → the user just hit Sign out; respect that intent
  if (params.get('error') === 'cf-access') return true;
  if (params.get('cf-access-login') === 'success') return true;
  if (params.get('signedOut') === '1') return true;
  return false;
}

async function checkCfAccessLoginEnabled(): Promise<boolean> {
  try {
    const apiHost = import.meta.env.PUBLIC_API_URL || '';
    // This fetch gates the entire login form behind an empty placeholder, so a
    // hung request (black-holed proxy, captive portal) must not stall login
    // forever — time out and fall back to the password form.
    const res = await fetch(`${apiHost}/api/v1/config`, {
      method: 'GET',
      credentials: 'include',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { cfAccessLogin?: { enabled?: boolean } };
    return !!body.cfAccessLogin?.enabled;
  } catch (err) {
    // Fail open to the password form — but leave a trace, or a deployment-wide
    // config/CORS regression silently disables CF Access SSO with no signal.
    console.warn('[login] CF Access config check failed; falling back to password form', err);
    return false;
  }
}

function buildApiUrl(path: string): string {
  const apiHost = import.meta.env.PUBLIC_API_URL || '';
  return `${apiHost}/api/v1${path}`;
}

async function bootstrapThenNavigate(url: string): Promise<void> {
  const response = await fetch(buildApiUrl('/auth/browser-binding/bootstrap'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error('Authentication bootstrap failed');
  window.location.assign(url);
}

interface LoginPageProps {
  next?: string;
}

export default function LoginPage({ next }: LoginPageProps = {}) {
  const { t } = useTranslation('auth');
  const safeNext = getSafeNext(next);
  const [error, setError] = useState<string>();
  const registrationNotice = getRegistrationDisabledNotice(t);
  const ssoLoginNotice = getSsoLoginNotice(t);
  // An SSO bounce carries the more specific, more actionable copy — when both
  // params resolve to a notice, the error wins and the expiry notice is dropped
  // rather than stacked.
  const sessionExpiredNotice = ssoLoginNotice ? undefined : getSessionExpiredNotice(t);
  const [loading, setLoading] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge>();
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp');
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [phoneLast4, setPhoneLast4] = useState<string>();
  const [smsSending, setSmsSending] = useState(false);
  const [smsSent, setSmsSent] = useState(false);
  // MUST start `false` (a constant), not `shouldSkipCfAccessRedirect()`: that
  // helper returns true on the server (no `window`) and false on a plain client
  // load, so seeding the initial state with it made the SSR render the form
  // while the client's first render produced the placeholder below — a React
  // #418 hydration mismatch on every /login visit. The skip decision now lives
  // entirely in the effect (client-only), keeping SSR and CSR initial output
  // identical (both render the placeholder).
  const [cfAccessRedirectChecked, setCfAccessRedirectChecked] = useState(false);
  const [partnerSso, setPartnerSso] = useState<{ providerName: string; loginUrl: string; enforceSSO: boolean } | null>(null);
  // Only meaningful once enforceSSO is true: lets the user reveal the password
  // form that's collapsed behind it (see the enforceSSO comment below).
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [ssoBootstrapping, setSsoBootstrapping] = useState(false);
  // Org-axis SSO for the address currently in the email field (#3229). Null
  // until an entered address resolves to an org that MANDATES SSO; the server
  // answers null for every other case, so this is only ever set when the
  // password form would be refused anyway.
  const [orgSso, setOrgSso] = useState<SsoDiscoveryProvider | null>(null);
  const [orgSsoDismissed, setOrgSsoDismissed] = useState(false);
  // The address the in-flight/last discovery was for, so retyping the same
  // address (tab out, tab back) does not re-spend the rate-limit budget.
  const lastDiscoveredEmail = useRef<string | null>(null);
  // Monotonic request id. A slow answer for an address the user has already
  // replaced must never overwrite the answer for the address on screen.
  const discoverySeq = useRef(0);

  const login = useAuthStore((state) => state.login);

  // Partner SSO: the (memoized) login context tells us whether this deployment
  // resolves to a single partner with an active SSO provider. Presence of
  // partnerSso IS the availability signal (no separate `available` flag). If
  // present, surface a "Sign in with {provider}" button above the password
  // form. Fetch failure / null response leaves the button absent
  // (password-only login).
  useEffect(() => {
    let cancelled = false;
    getLoginContext().then((ctx) => {
      if (cancelled) return;
      if (ctx.partnerSso) {
        setPartnerSso({
          providerName: ctx.partnerSso.providerName,
          loginUrl: ctx.partnerSso.loginUrl,
          enforceSSO: ctx.partnerSso.enforceSSO,
        });
      }
    });
    return () => { cancelled = true; };
  }, []);

  // CF Access trust mode: if the deployment has it on AND we're not already
  // in the post-redirect bounce (which AuthOverlay handles), top-level
  // navigate to the redirect endpoint. The browser's redirect-following
  // behaviour resolves CF Access's per-app cookie handshake silently when
  // the user has an active session at the root app with the same IdP.
  useEffect(() => {
    if (cfAccessRedirectChecked) return;
    // Post-redirect bounce / explicit sign-out: skip the check and show the
    // form immediately (one tick after mount, so SSR and CSR still agree on the
    // initial placeholder render).
    if (shouldSkipCfAccessRedirect()) {
      setCfAccessRedirectChecked(true);
      return;
    }
    let cancelled = false;
    void checkCfAccessLoginEnabled().then(async (enabled) => {
      if (cancelled) return;
      if (enabled) {
        const nextParam = safeNext === '/' ? '' : `?next=${encodeURIComponent(safeNext)}`;
        try {
          await bootstrapThenNavigate(`/api/v1/auth/cf-access-login${nextParam}`);
        } catch (caught) {
          if (!cancelled) {
            setError(caught instanceof Error ? caught.message : 'Authentication bootstrap failed');
            setCfAccessRedirectChecked(true);
          }
        }
        return;
      }
      setCfAccessRedirectChecked(true);
    });
    return () => { cancelled = true; };
  }, [cfAccessRedirectChecked, safeNext]);

  const handleLogin = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(undefined);

    const result = await apiLogin(values.email, values.password);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (result.mfaRequired) {
      const challenge = result.challenge ?? parseMfaChallengeResponse({
        ...result,
        mfaRequired: true,
      });
      if (!challenge) {
        setError('Invalid MFA challenge response');
        setLoading(false);
        return;
      }
      setMfaChallenge(challenge);
      setMfaMethod(challenge.primary);
      setPasskeyAvailable(challenge.allowedMethods.passkey);
      setPhoneLast4(challenge.phoneLast4 ?? undefined);
      setSmsSent(false);
      setLoading(false);
      return;
    }

    if (result.user && result.tokens) {
      login(result.user, result.tokens);
      fetchAndApplyPreferences();
      // Setup wizard wins over `next` — user can't do anything useful before setup completes.
      await navigateTo(result.requiresSetup ? '/setup' : safeNext);
      return;
    }

    setLoading(false);
  };

  const handleMfaVerify = async (code: string) => {
    if (!mfaChallenge || mfaMethod === 'passkey') return;

    setLoading(true);
    setError(undefined);

    const result = await apiVerifyMFA(code, mfaChallenge.tempToken, mfaMethod);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (result.user && result.tokens) {
      setMfaChallenge(undefined);
      login(result.user, result.tokens);
      fetchAndApplyPreferences();
      // Setup wizard wins over `next` — user can't do anything useful before setup completes.
      await navigateTo(result.requiresSetup ? '/setup' : safeNext);
      return;
    }

    setLoading(false);
  };

  const handlePasskeyMfaVerify = async () => {
    if (!mfaChallenge) return;

    setLoading(true);
    setError(undefined);

    const result = await apiVerifyPasskeyMFA(mfaChallenge.tempToken);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (result.user && result.tokens) {
      setMfaChallenge(undefined);
      login(result.user, result.tokens);
      fetchAndApplyPreferences();
      await navigateTo(result.requiresSetup ? '/setup' : safeNext);
      return;
    }

    setLoading(false);
  };

  const handleSendSmsCode = async () => {
    if (!mfaChallenge) return false;

    setSmsSending(true);
    setError(undefined);

    const result = await apiSendSmsMfaCode(mfaChallenge.tempToken);

    if (!result.success) {
      setError(result.error);
      setSmsSending(false);
      return false;
    } else {
      setSmsSent(true);
    }

    setSmsSending(false);
    return true;
  };

  const handleEmailSettled = useCallback((raw: string) => {
    const email = raw.trim().toLowerCase();
    // Cheap syntactic gate: the API 400s anything that isn't an address, and a
    // half-typed one is a wasted request against a limited budget.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (lastDiscoveredEmail.current === email) return;
    lastDiscoveredEmail.current = email;

    const seq = ++discoverySeq.current;
    void discoverOrgSso(email).then((provider) => {
      if (seq !== discoverySeq.current) return;
      setOrgSso(provider);
      // A newly discovered tenant re-collapses the password controls: the
      // previous "show me the password form anyway" was about the previous
      // address, not this one.
      setOrgSsoDismissed(false);
    });
  }, []);

  const handleOrgSso = async () => {
    if (!orgSso || ssoBootstrapping) return;
    const url = `${orgSso.loginUrl}${safeNext ? `?redirect=${encodeURIComponent(safeNext)}` : ''}`;
    setSsoBootstrapping(true);
    setError(undefined);
    try {
      await bootstrapThenNavigate(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Authentication bootstrap failed');
      setSsoBootstrapping(false);
    }
  };

  const handlePartnerSso = async () => {
    if (!partnerSso || ssoBootstrapping) return;
    const url = `${partnerSso.loginUrl}${safeNext ? `?redirect=${encodeURIComponent(safeNext)}` : ''}`;
    setSsoBootstrapping(true);
    setError(undefined);
    try {
      await bootstrapThenNavigate(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Authentication bootstrap failed');
      setSsoBootstrapping(false);
    }
  };

  // While the CF Access config check is in flight, render an empty placeholder
  // so the user doesn't see the password form flash before a redirect kicks in.
  if (!cfAccessRedirectChecked) {
    return <div data-testid="login-cf-access-check" className="u-min-h-px-160" />;
  }

  if (mfaChallenge) {
    return (
      <div>
        <div className="mb-8">
          <p className="text-sm font-medium text-muted-foreground">{t('login.mfa.eyebrow', { defaultValue: 'Almost there' })}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{t('login.mfa.title', { defaultValue: 'Verify your identity' })}</h1>
        </div>
        <MFAVerifyForm
          onSubmit={handleMfaVerify}
          onPasskeyVerify={handlePasskeyMfaVerify}
          errorMessage={error}
          loading={loading}
          mfaMethod={mfaMethod}
          methods={mfaChallenge.methods}
          onMethodChange={(method) => {
            setMfaMethod(method);
            setError(undefined);
            if (method !== 'sms') setSmsSent(false);
          }}
          passkeyAvailable={passkeyAvailable}
          phoneLast4={phoneLast4}
          onSendSmsCode={handleSendSmsCode}
          smsSending={smsSending}
          smsSent={smsSent}
        />
      </div>
    );
  }

  return (
    <div data-testid="login-page">
      <div className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">{t('login.eyebrow', { defaultValue: 'Welcome back' })}</p>
        <h1 data-testid="login-heading" className="mt-1 text-2xl font-bold tracking-tight">{t('login.title', { defaultValue: 'Sign in to Breeze' })}</h1>
      </div>

      {registrationNotice && (
        <div className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
          {registrationNotice}
        </div>
      )}
      {sessionExpiredNotice && (
        <div
          role="status"
          data-testid="login-session-expired-notice"
          className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200"
        >
          {sessionExpiredNotice}
        </div>
      )}
      {ssoLoginNotice && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200"
        >
          {ssoLoginNotice}
        </div>
      )}
      {partnerSso && (
        <button
          type="button"
          onClick={handlePartnerSso}
          disabled={ssoBootstrapping}
          data-testid="partner-sso-button"
          className="mb-4 flex w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('login.signInWithProvider', {
            defaultValue: `Sign in with ${partnerSso.providerName}`,
            providerName: partnerSso.providerName,
          })}
        </button>
      )}
      {/*
        enforceSSO only de-emphasizes the UI here — it collapses the password
        form behind a reveal toggle so the SSO button reads as the primary
        path. The password form must stay reachable: org-axis users (customer
        techs) on this same single-partner instance are NOT SSO-gated —
        `enforceSSO` is a partner-provider setting enforced per-user at login
        time server-side (ssoPolicy), never by hiding the form client-side.
      */}
      {partnerSso?.enforceSSO && !showPasswordForm ? (
        <button
          type="button"
          data-testid="show-password-form"
          onClick={() => setShowPasswordForm(true)}
          className="w-full text-center text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          {t('login.signInWithPasswordInstead', { defaultValue: 'Sign in with password instead' })}
        </button>
      ) : (
        <LoginForm
          onSubmit={handleLogin}
          errorMessage={error}
          loading={loading}
          onEmailSettled={handleEmailSettled}
          ssoPrompt={
            orgSso && !orgSsoDismissed
              ? {
                  providerName: orgSso.providerName,
                  onSelect: () => { void handleOrgSso(); },
                  onUsePassword: () => setOrgSsoDismissed(true),
                  busy: ssoBootstrapping,
                }
              : null
          }
        />
      )}
      <McpUrlCard variant="compact" requireOAuth className="mt-8" />
    </div>
  );
}
