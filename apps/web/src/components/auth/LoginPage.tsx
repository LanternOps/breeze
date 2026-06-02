import { useEffect, useState } from 'react';
import LoginForm from './LoginForm';
import MFAVerifyForm from './MFAVerifyForm';
import McpUrlCard from '../shared/McpUrlCard';
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
    const res = await fetch(`${apiHost}/api/v1/config`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { cfAccessLogin?: { enabled?: boolean } };
    return !!body.cfAccessLogin?.enabled;
  } catch {
    return false;
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
  const [cfAccessRedirectChecked, setCfAccessRedirectChecked] = useState(shouldSkipCfAccessRedirect());

  const login = useAuthStore((state) => state.login);

  // CF Access trust mode: if the deployment has it on AND we're not already
  // in the post-redirect bounce (which AuthOverlay handles), top-level
  // navigate to the redirect endpoint. The browser's redirect-following
  // behaviour resolves CF Access's per-app cookie handshake silently when
  // the user has an active session at the root app with the same IdP.
  useEffect(() => {
    if (cfAccessRedirectChecked) return;
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

  // While the CF Access config check is in flight, render an empty placeholder
  // so the user doesn't see the password form flash before a redirect kicks in.
  if (!cfAccessRedirectChecked) {
    return <div data-testid="login-cf-access-check" className="min-h-[160px]" />;
  }

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
      <McpUrlCard variant="compact" requireOAuth className="mt-8" />
    </div>
  );
}
