import { useEffect, useState } from 'react';
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
import type { MfaMethod } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { getSafeNext } from '../../lib/authNext';
import { getLoginContext } from '../../lib/loginContext';
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

// Copy for SSO callback `?error=<reason>` bounces that land back on /login.
// `sso_link_required` (#2183): a password-holding user tried to sign in via SSO
// and was refused auto-linking — they must connect SSO from an authenticated
// session instead (Profile → Security → Connect SSO).
function getSsoLoginNotice(t: ReturnType<typeof useTranslation<'auth'>>['t']): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const ssoLoginErrorCopy: Record<string, string> = {
    sso_link_required: t('login.ssoErrors.ssoLinkRequired', {
      defaultValue:
        'This account already has a password. Sign in with your password, then connect SSO under Profile → Security.',
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

interface LoginPageProps {
  next?: string;
}

export default function LoginPage({ next }: LoginPageProps = {}) {
  const { t } = useTranslation('auth');
  const safeNext = getSafeNext(next);
  const [error, setError] = useState<string>();
  const registrationNotice = getRegistrationDisabledNotice(t);
  const ssoLoginNotice = getSsoLoginNotice(t);
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [tempToken, setTempToken] = useState<string>();
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
    void checkCfAccessLoginEnabled().then((enabled) => {
      if (cancelled) return;
      if (enabled) {
        const nextParam = safeNext === '/' ? '' : `?next=${encodeURIComponent(safeNext)}`;
        window.location.assign(`/api/v1/auth/cf-access-login${nextParam}`);
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
      setMfaRequired(true);
      setTempToken(result.tempToken);
      setMfaMethod(result.mfaMethod || 'totp');
      setPasskeyAvailable(result.passkeyAvailable === true);
      setPhoneLast4(result.phoneLast4);
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
    if (!tempToken) return;

    setLoading(true);
    setError(undefined);

    const result = await apiVerifyMFA(code, tempToken, mfaMethod);

    if (!result.success) {
      setError(result.error);
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

  const handlePasskeyMfaVerify = async () => {
    if (!tempToken) return;

    setLoading(true);
    setError(undefined);

    const result = await apiVerifyPasskeyMFA(tempToken);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (result.user && result.tokens) {
      login(result.user, result.tokens);
      fetchAndApplyPreferences();
      await navigateTo(result.requiresSetup ? '/setup' : safeNext);
      return;
    }

    setLoading(false);
  };

  const handleSendSmsCode = async () => {
    if (!tempToken) return;

    setSmsSending(true);
    setError(undefined);

    const result = await apiSendSmsMfaCode(tempToken);

    if (!result.success) {
      setError(result.error);
    } else {
      setSmsSent(true);
    }

    setSmsSending(false);
  };

  // While the CF Access config check is in flight, render an empty placeholder
  // so the user doesn't see the password form flash before a redirect kicks in.
  if (!cfAccessRedirectChecked) {
    return <div data-testid="login-cf-access-check" className="u-min-h-px-160" />;
  }

  if (mfaRequired) {
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
      {ssoLoginNotice && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200"
        >
          {ssoLoginNotice}
        </div>
      )}
      {partnerSso && (
        <a
          href={`${partnerSso.loginUrl}${safeNext ? `?redirect=${encodeURIComponent(safeNext)}` : ''}`}
          data-testid="partner-sso-button"
          className="mb-4 flex w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          {t('login.signInWithProvider', {
            defaultValue: `Sign in with ${partnerSso.providerName}`,
            providerName: partnerSso.providerName,
          })}
        </a>
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
        />
      )}
      <McpUrlCard variant="compact" requireOAuth className="mt-8" />
    </div>
  );
}
