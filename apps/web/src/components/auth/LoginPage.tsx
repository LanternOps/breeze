import { useState } from 'react';
import LoginForm from './LoginForm';
import MFAVerifyForm from './MFAVerifyForm';
import { useAuthStore, apiLogin, apiVerifyMFA, apiSendSmsMfaCode, fetchAndApplyPreferences } from '../../stores/auth';
import type { MfaMethod } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { getSafeNext } from '../../lib/authNext';

function getRegistrationDisabledNotice(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  if (params.get('reason') === 'registration-disabled') {
    return 'New registrations are currently disabled. Please contact your administrator.';
  }
}

interface LoginPageProps {
  next?: string;
}

export default function LoginPage({ next }: LoginPageProps = {}) {
  const safeNext = getSafeNext(next);
  const [error, setError] = useState<string>();
  const registrationNotice = getRegistrationDisabledNotice();
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [tempToken, setTempToken] = useState<string>();
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp');
  const [phoneLast4, setPhoneLast4] = useState<string>();
  const [smsSending, setSmsSending] = useState(false);
  const [smsSent, setSmsSent] = useState(false);

  const login = useAuthStore((state) => state.login);

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

  if (mfaRequired) {
    return (
      <div>
        <div className="mb-8">
          <p className="text-sm font-medium text-muted-foreground">Almost there</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Verify your identity</h1>
        </div>
        <MFAVerifyForm
          onSubmit={handleMfaVerify}
          errorMessage={error}
          loading={loading}
          mfaMethod={mfaMethod}
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
        <p className="text-sm font-medium text-muted-foreground">Welcome back</p>
        <h1 data-testid="login-heading" className="mt-1 text-2xl font-bold tracking-tight">Sign in to Breeze</h1>
      </div>

      {registrationNotice && (
        <div className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
          {registrationNotice}
        </div>
      )}
      <LoginForm
        onSubmit={handleLogin}
        errorMessage={error}
        loading={loading}
      />
    </div>
  );
}
