import { useEffect, useState } from 'react';
import MFASetupForm from './MFASetupForm';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { navigateTo } from '../../lib/navigation';

type Step = 'password' | 'enroll' | 'done';

export default function ForcedMfaSetupPage() {
  const [step, setStep] = useState<Step>('password');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | undefined>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [forced, setForced] = useState(false);

  const updateUser = useAuthStore((state) => state.updateUser);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    setForced(params.get('forced') === '1');
  }, []);

  // Step 1: re-prompt for the current password and start TOTP enrollment.
  const handleStart = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentPassword) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/auth/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({ currentPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(extractApiError(data, 'Could not start MFA setup'));
        return;
      }
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setRecoveryCodes(data.recoveryCodes);
      setStep('enroll');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  // Step 2: verify the 6-digit code to actually enable MFA.
  const handleEnable = async (code: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/auth/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ code, currentPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(extractApiError(data, 'Invalid verification code'));
        return;
      }
      updateUser({ mfaEnabled: true });
      setStep('done');
      setInfo('MFA enabled. Redirecting...');
      setTimeout(() => {
        navigateTo('/').catch(() => {
          window.location.href = '/';
        });
      }, 1500);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-sm font-medium text-muted-foreground">Account security</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          {step === 'done' ? 'MFA enabled' : 'Set up multi-factor authentication'}
        </h1>
      </div>

      {forced && step !== 'done' && (
        <div
          data-testid="forced-mfa-banner"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
        >
          Your role requires multi-factor authentication. You must enroll an authenticator app before
          you can continue using Breeze.
        </div>
      )}

      {step === 'password' && (
        <form
          onSubmit={handleStart}
          className="space-y-4 rounded-lg border bg-card p-6 shadow-sm"
        >
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Confirm your password</h2>
            <p className="text-sm text-muted-foreground">
              Re-enter your account password to start setting up an authenticator app.
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="forced-mfa-password" className="text-sm font-medium">
              Current password
            </label>
            <input
              id="forced-mfa-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
            {loading ? 'Verifying...' : 'Continue'}
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
              <p className="mb-2 font-medium">Save your recovery codes</p>
              <p className="mb-3 text-muted-foreground">
                Store these somewhere safe. Each code can only be used once if you lose access to
                your authenticator app.
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

      {step === 'done' && info && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">
          {info}
        </div>
      )}
    </div>
  );
}
