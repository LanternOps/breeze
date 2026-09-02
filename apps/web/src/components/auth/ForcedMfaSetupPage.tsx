import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MFASetupForm from './MFASetupForm';
import {
  AuthSessionExpiredError,
  AuthThrottledError,
  apiEnableSmsMfa,
  apiEnableTotpMfa,
  apiEnrollPasskey,
  apiGetMfaEnrollmentOptions,
  fetchWithAuth,
  restoreAccessTokenFromCookie,
  type MfaEnrollmentCompletion,
  type MfaEnrollmentOptions,
  useAuthStore,
} from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { navigateTo } from '../../lib/navigation';
// Initializes the shared i18next singleton. This page's layout has no Sidebar
// (which is what pulls i18n in elsewhere), so without this every t() call here
// renders its raw key.
import '../../lib/i18n';

type Step = 'password' | 'enroll' | 'done';
type EnrollmentMethod = 'totp' | 'sms' | 'passkey';

export default function ForcedMfaSetupPage() {
  const { t } = useTranslation('auth');
  const [step, setStep] = useState<Step>('password');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | undefined>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [forced, setForced] = useState(false);
  const [options, setOptions] = useState<MfaEnrollmentOptions>();
  const [optionsError, setOptionsError] = useState<string>();
  const [selectedMethod, setSelectedMethod] = useState<EnrollmentMethod>();

  const commitMfaEnrollmentIfCurrent = useAuthStore((state) => state.commitMfaEnrollmentIfCurrent);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    setForced(params.get('forced') === '1');
  }, []);

  useEffect(() => {
    let current = true;
    void apiGetMfaEnrollmentOptions().then((result) => {
      if (!current) return;
      if (!result.success) {
        setOptionsError(result.error);
        return;
      }
      setOptions(result.options);
      const first = result.options.allowedMethods.totp
        ? 'totp'
        : result.options.allowedMethods.sms && result.options.phoneConfigured
          ? 'sms'
          : result.options.allowedMethods.passkey
            ? 'passkey'
            : undefined;
      setSelectedMethod(first);
    });
    return () => { current = false; };
  }, []);

  const finishEnrollment = (result: MfaEnrollmentCompletion, generation: number) => {
    if (!mountedRef.current) return false;
    if (!result.success) {
      setError(result.error);
      return false;
    }
    // The refresh/CSRF cookies were installed by the terminal API response;
    // adopt only its replacement access metadata before leaving the gate.
    if (!commitMfaEnrollmentIfCurrent(generation, result.tokens)) return false;
    setRecoveryCodes(result.recoveryCodes);
    setStep('done');
    setInfo(t('forcedMfa.done.saveCodes', { defaultValue: 'MFA is enabled. Save your recovery codes before continuing.' }));
    return true;
  };

  // NOTE: AuthLayout mounts no AuthOverlay, so the refresh-throttle mask that
  // covers the dashboard (#3696) does NOT appear here. This page therefore has
  // to recognise AuthThrottledError itself — see the catch blocks below.
  //
  // This page renders under AuthLayout (no AuthGuard/DashboardWrapper), and it
  // is always reached via a full-page navigation, so the in-memory access token
  // is gone on mount. Proactively trade the refresh cookie for a fresh access
  // token now — mirroring AuthGuard — so the Bearer is in place before the user
  // submits their password (rather than discovering a dead session only at
  // submit time). If recovery fails, fetchWithAuth/AuthSessionExpiredError will
  // bounce the user to /login on their first action.
  useEffect(() => {
    const { isAuthenticated, tokens } = useAuthStore.getState();
    if (isAuthenticated && !tokens?.accessToken) {
      void restoreAccessTokenFromCookie();
    }
  }, []);

  // Step 1: re-prompt for the current password and start TOTP enrollment.
  const handleStart = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentPassword || !selectedMethod) return;
    setLoading(true);
    setError(undefined);
    try {
      if (selectedMethod === 'sms') {
        const generation = useAuthStore.getState().sessionGeneration;
        finishEnrollment(await apiEnableSmsMfa(currentPassword), generation);
        return;
      }
      if (selectedMethod === 'passkey') {
        const generation = useAuthStore.getState().sessionGeneration;
        finishEnrollment(await apiEnrollPasskey(currentPassword), generation);
        return;
      }
      const response = await fetchWithAuth('/auth/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({ currentPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(extractApiError(data, t('forcedMfa.errors.startFailed', { defaultValue: 'Could not start MFA setup' })));
        return;
      }
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setStep('enroll');
    } catch (err) {
      // Session died and fetchWithAuth is already redirecting to /login — don't
      // flash a misleading "Network error" over the navigation.
      if (err instanceof AuthSessionExpiredError) return;
      // A rate-limited /auth/refresh is not a network error and not an expiry —
      // the session is fine and the user just has to wait. Saying "Network
      // error" on a security-sensitive enrollment page sends people to support
      // for something that resolves itself (#3696).
      if (err instanceof AuthThrottledError) {
        setError(t('common.refreshThrottledError', {
          defaultValue: 'Too many requests — you are still signed in. Please wait a moment and try again.'
        }));
        return;
      }
      setError(t('common.networkError', { defaultValue: 'Network error' }));
    } finally {
      setLoading(false);
    }
  };

  // Step 2: verify the 6-digit code to actually enable MFA.
  const handleEnable = async (code: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const generation = useAuthStore.getState().sessionGeneration;
      finishEnrollment(await apiEnableTotpMfa(code, currentPassword), generation);
    } catch (err) {
      if (err instanceof AuthSessionExpiredError) return;
      // A rate-limited /auth/refresh is not a network error and not an expiry —
      // the session is fine and the user just has to wait. Saying "Network
      // error" on a security-sensitive enrollment page sends people to support
      // for something that resolves itself (#3696).
      if (err instanceof AuthThrottledError) {
        setError(t('common.refreshThrottledError', {
          defaultValue: 'Too many requests — you are still signed in. Please wait a moment and try again.'
        }));
        return;
      }
      setError(t('common.networkError', { defaultValue: 'Network error' }));
    } finally {
      setLoading(false);
    }
  };

  if (optionsError) {
    return (
      <div data-testid="mfa-options-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {optionsError}. {t('forcedMfa.contactAdmin', { defaultValue: 'Contact your administrator for help.' })}
      </div>
    );
  }
  if (!options) {
    return <div data-testid="mfa-options-loading" className="text-sm text-muted-foreground">Loading MFA options…</div>;
  }
  const hasUsableMethod = options.allowedMethods.totp
    || (options.allowedMethods.sms && options.phoneConfigured)
    || options.allowedMethods.passkey;
  if (!hasUsableMethod || !selectedMethod) {
    return (
      <div data-testid="mfa-options-empty" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        {t('forcedMfa.noMethods', { defaultValue: 'No MFA enrollment method is available. Contact your administrator.' })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-sm font-medium text-muted-foreground">{t('forcedMfa.eyebrow', { defaultValue: 'Account security' })}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          {step === 'done'
            ? t('forcedMfa.done.title', { defaultValue: 'MFA enabled' })
            : t('forcedMfa.title', { defaultValue: 'Set up multi-factor authentication' })}
        </h1>
      </div>

      {forced && step !== 'done' && (
        <div
          data-testid="forced-mfa-banner"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
        >
          {t('forcedMfa.requiredBanner', {
            defaultValue:
              'Your role requires multi-factor authentication. You must enroll an authenticator app before you can continue using Breeze.',
          })}
        </div>
      )}

      {step === 'password' && (
        <form
          onSubmit={handleStart}
          className="space-y-4 rounded-lg border bg-card p-6 shadow-xs"
        >
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{t('forcedMfa.method.title', { defaultValue: 'Choose an MFA method' })}</h2>
            <p className="text-sm text-muted-foreground">
              {t('forcedMfa.password.description', {
                defaultValue: 'Choose a permitted method, then re-enter your password to continue.',
              })}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {options.allowedMethods.totp && (
              <button type="button" data-testid="enroll-method-totp" onClick={() => setSelectedMethod('totp')} className={`rounded-md border px-3 py-2 text-sm ${selectedMethod === 'totp' ? 'border-primary bg-primary/10' : ''}`}>
                Authenticator app
              </button>
            )}
            {options.allowedMethods.sms && (
              <button type="button" data-testid="enroll-method-sms" disabled={!options.phoneConfigured} onClick={() => setSelectedMethod('sms')} className={`rounded-md border px-3 py-2 text-sm disabled:opacity-50 ${selectedMethod === 'sms' ? 'border-primary bg-primary/10' : ''}`}>
                Text message
              </button>
            )}
            {options.allowedMethods.passkey && (
              <button type="button" data-testid="enroll-method-passkey" onClick={() => setSelectedMethod('passkey')} className={`rounded-md border px-3 py-2 text-sm ${selectedMethod === 'passkey' ? 'border-primary bg-primary/10' : ''}`}>
                Passkey
              </button>
            )}
          </div>
          {options.allowedMethods.sms && !options.phoneConfigured && (
            <p className="text-xs text-muted-foreground">Add and verify a phone number before choosing text-message MFA.</p>
          )}
          <div className="space-y-2">
            <label htmlFor="forced-mfa-password" className="text-sm font-medium">
              {t('fields.currentPassword', { defaultValue: 'Current password' })}
            </label>
            <input
              id="forced-mfa-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              disabled={loading}
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !currentPassword}
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? t('common.verifying', { defaultValue: 'Verifying...' }) : t('common.continue', { defaultValue: 'Continue' })}
          </button>
        </form>
      )}

      {step === 'enroll' && (
        <>
          <MFASetupForm
            qrCodeDataUrl={qrCodeDataUrl}
            onSubmit={handleEnable}
            errorMessage={error}
            loading={loading}
          />
          {recoveryCodes && recoveryCodes.length > 0 && (
            <div className="rounded-md border bg-card p-4 text-sm">
              <p className="mb-2 font-medium">{t('recoveryCodes.title', { defaultValue: 'Save your recovery codes' })}</p>
              <p className="mb-3 text-muted-foreground">
                {t('forcedMfa.recoveryDescription', {
                  defaultValue:
                    'Store these somewhere safe. Each code can only be used once if you lose access to your authenticator app.',
                })}
              </p>
              <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
                {recoveryCodes.map((code, index) => (
                  <div key={`recovery-${index}`} className="text-center">
                    {code}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {step === 'done' && (
        <div className="space-y-4">
          {info && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">
              {info}
            </div>
          )}
          {recoveryCodes && recoveryCodes.length > 0 && (
            <div data-testid="enrollment-recovery-codes" className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {recoveryCodes.map((code, index) => <div key={`done-recovery-${index}`} className="text-center">{code}</div>)}
            </div>
          )}
          <button
            type="button"
            data-testid="enrollment-continue"
            onClick={() => { void navigateTo('/'); }}
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground"
          >
            I saved these codes — continue
          </button>
        </div>
      )}
    </div>
  );
}
