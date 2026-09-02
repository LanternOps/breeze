import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MFAVerifyForm from './MFAVerifyForm';
import {
  useAuthStore,
  apiSsoLinkPending,
  apiSsoLinkConfirm,
  apiVerifyMFA,
  apiVerifyPasskeyMFA,
  apiSendSmsMfaCode,
  fetchAndApplyPreferences
} from '../../stores/auth';
import type { MfaChallenge, MfaMethod } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
// Initializes the shared i18next singleton (this page's layout has no Sidebar).
import '../../lib/i18n';

/**
 * #4067 — "Connect your sign-in" (link-on-first-SSO-login).
 *
 * The SSO callback verified the IdP assertion, matched a password-holding
 * account, parked the identity server-side, and bound the ceremony to this
 * browser with an HttpOnly cookie. This page collects the second proof — the
 * account password (plus the account's Breeze-held MFA factor when enrolled) —
 * then completes the login with the normal SSO session.
 */
export default function ConnectSsoLoginPage() {
  const { t } = useTranslation('auth');
  const login = useAuthStore((state) => state.login);

  const [pending, setPending] = useState<{ email: string; providerName: string | null } | null>(null);
  const [expired, setExpired] = useState(false);
  // Transient failure reading the ceremony (network blip, 503, 429) — NOT
  // expiry. Rendering these as "expired" would send the user on a needless
  // full IdP round-trip when a retry would have worked.
  const [unavailable, setUnavailable] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge>();
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp');
  const [smsSending, setSmsSending] = useState(false);
  const [smsSent, setSmsSent] = useState(false);

  const describeCeremony = () => {
    setChecking(true);
    setUnavailable(false);
    return apiSsoLinkPending().then((result) => {
      if (result.success) {
        setPending({ email: result.email, providerName: result.providerName });
      } else if (result.expired) {
        setExpired(true);
      } else {
        setUnavailable(true);
      }
      setChecking(false);
    });
  };

  useEffect(() => {
    void describeCeremony();
  }, []);

  const identityInUseCopy = () => t('connectSso.identityInUse', {
    defaultValue: 'That sign-in identity is already linked to a different account. Contact your administrator.',
  });
  const completionFailedCopy = () => t('connectSso.completionFailed', {
    defaultValue: 'Your password was correct, but the sign-in could not be completed. Contact your administrator.',
  });

  const completeLogin = async (result: {
    user?: unknown;
    tokens?: unknown;
    redirectPath?: string;
    requiresSetup?: boolean;
  }) => {
    if (result.user && result.tokens) {
      login(result.user as never, result.tokens as never);
      fetchAndApplyPreferences();
      await navigateTo(result.requiresSetup ? '/setup' : (result.redirectPath || '/'));
      return true;
    }
    // Defensive: a success without user/tokens (API drift) must not strand
    // the user on a silently re-enabled button.
    setError(completionFailedCopy());
    return false;
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || loading) return;
    setLoading(true);
    setError(undefined);

    const result = await apiSsoLinkConfirm(password);

    switch (result.state) {
      case 'failed':
        if (result.reason === 'expired') {
          setExpired(true);
        } else if (result.reason === 'identity_in_use') {
          setError(identityInUseCopy());
        } else if (result.reason === 'completion_failed') {
          setError(completionFailedCopy());
        } else {
          setError(result.error);
        }
        setLoading(false);
        return;
      case 'mfa':
        setMfaRequired(true);
        setMfaChallenge(result.challenge);
        setMfaMethod(result.challenge.primary);
        setSmsSent(false);
        setLoading(false);
        return;
      case 'complete':
        if (await completeLogin(result)) return;
        setLoading(false);
        return;
    }
  };

  const handleMfaVerify = async (code: string) => {
    if (!mfaChallenge || mfaMethod === 'passkey') return;
    setLoading(true);
    setError(undefined);

    const result = await apiVerifyMFA(code, mfaChallenge.tempToken, mfaMethod);
    if (!result.success) {
      if (result.error === 'sso_link_expired') {
        // The factor was fine — the ceremony died underneath it. Retrying the
        // code can never work; route to the expired view's restart CTA.
        setExpired(true);
      } else if (result.error === 'identity_in_use') {
        setError(identityInUseCopy());
      } else if (result.error === 'completion_failed') {
        setError(completionFailedCopy());
      } else {
        setError(result.error);
      }
      setLoading(false);
      return;
    }
    if (await completeLogin(result)) return;
    setLoading(false);
  };

  const handlePasskeyMfaVerify = async () => {
    if (!mfaChallenge) return;
    setLoading(true);
    setError(undefined);

    const result = await apiVerifyPasskeyMFA(mfaChallenge.tempToken);
    if (!result.success) {
      if (result.error === 'sso_link_expired') {
        setExpired(true);
      } else if (result.error === 'identity_in_use') {
        setError(identityInUseCopy());
      } else if (result.error === 'completion_failed') {
        setError(completionFailedCopy());
      } else {
        setError(result.error);
      }
      setLoading(false);
      return;
    }
    if (await completeLogin(result)) return;
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

  if (checking) {
    return <div data-testid="connect-sso-checking" className="u-min-h-px-160" />;
  }

  if (unavailable) {
    return (
      <div data-testid="connect-sso-unavailable">
        <div className="mb-8">
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            {t('connectSso.unavailableTitle', { defaultValue: "We couldn't check your sign-in link" })}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('connectSso.unavailableBody', {
            defaultValue: 'Something went wrong while loading this page. Your link may still be valid — try again.',
          })}
        </p>
        <button
          type="button"
          data-testid="connect-sso-retry"
          onClick={() => { void describeCeremony(); }}
          className="mt-6 flex w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          {t('connectSso.retry', { defaultValue: 'Try again' })}
        </button>
      </div>
    );
  }

  if (expired) {
    return (
      <div data-testid="connect-sso-expired">
        <div className="mb-8">
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            {t('connectSso.expiredTitle', { defaultValue: 'This sign-in link has expired' })}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('connectSso.expiredBody', {
            defaultValue: 'For your security, the connection window is short. Start single sign-on again to get a new one.',
          })}
        </p>
        <a
          href="/login"
          data-testid="connect-sso-back-to-login"
          className="mt-6 flex w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          {t('connectSso.backToLogin', { defaultValue: 'Back to sign in' })}
        </a>
      </div>
    );
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
          methods={mfaChallenge?.methods}
          onMethodChange={setMfaMethod}
          passkeyAvailable={mfaChallenge?.allowedMethods.passkey}
          phoneLast4={mfaChallenge?.phoneLast4 ?? undefined}
          onSendSmsCode={handleSendSmsCode}
          smsSending={smsSending}
          smsSent={smsSent}
        />
      </div>
    );
  }

  return (
    <div data-testid="connect-sso-page">
      <div className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">
          {t('connectSso.eyebrow', { defaultValue: 'One more step' })}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          {t('connectSso.title', { defaultValue: 'Connect your sign-in' })}
        </h1>
      </div>

      <p className="mb-6 text-sm text-muted-foreground">
        {t('connectSso.explainer', {
          defaultValue:
            'Your single sign-on succeeded, and it matches an existing account. Enter that account’s password once to connect {{provider}} to it — future sign-ins will be one click.',
          provider: pending?.providerName || t('connectSso.genericProvider', { defaultValue: 'single sign-on' }),
        })}
      </p>

      <form onSubmit={handleConfirm} data-testid="connect-sso-form">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium" htmlFor="connect-sso-email">
            {t('connectSso.emailLabel', { defaultValue: 'Account' })}
          </label>
          <input
            id="connect-sso-email"
            type="email"
            value={pending?.email ?? ''}
            disabled
            data-testid="connect-sso-email"
            className="w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground"
          />
        </div>
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium" htmlFor="connect-sso-password">
            {t('connectSso.passwordLabel', { defaultValue: 'Password' })}
          </label>
          <input
            id="connect-sso-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="connect-sso-password"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        {error && (
          <div
            role="alert"
            data-testid="connect-sso-error"
            className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200"
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !password}
          data-testid="connect-sso-submit"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading
            ? t('connectSso.connecting', { defaultValue: 'Connecting…' })
            : t('connectSso.submit', { defaultValue: 'Connect and sign in' })}
        </button>
      </form>
    </div>
  );
}
