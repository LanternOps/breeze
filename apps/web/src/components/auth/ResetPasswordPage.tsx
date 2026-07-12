import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ResetPasswordForm from './ResetPasswordForm';
import StatusIcon from './StatusIcon';
import { apiResetPassword } from '../../stores/auth';
import { scrubQueryParamsFromCurrentUrl } from '../../lib/sensitiveUrl';

type TokenState = { phase: 'loading' } | { phase: 'present'; token: string } | { phase: 'absent' };

export default function ResetPasswordPage() {
  const { t } = useTranslation('auth');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Tri-state to prevent a one-frame flash of "Invalid Link" while the
  // useEffect that reads the URL is still pending. (#418, then a follow-up.)
  const [tokenState, setTokenState] = useState<TokenState>({ phase: 'loading' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    if (tokenParam) {
      scrubQueryParamsFromCurrentUrl(['token']);
    }
    setTokenState(tokenParam ? { phase: 'present', token: tokenParam } : { phase: 'absent' });
  }, []);

  const handleSubmit = async (values: { password: string }) => {
    if (tokenState.phase !== 'present') {
      setError(t('resetPassword.errors.missingToken', { defaultValue: 'Invalid or missing reset token' }));
      return;
    }

    setLoading(true);
    setError(undefined);

    const result = await apiResetPassword(tokenState.token, values.password);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (tokenState.phase === 'loading') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs" aria-busy="true">
        <div className="space-y-2 text-center">
          <StatusIcon variant="pending" label={t('common.loadingLabel', { defaultValue: 'Loading' })} />
          <h2 className="text-lg font-semibold">{t('common.loadingEllipsis', { defaultValue: 'Loading…' })}</h2>
        </div>
      </div>
    );
  }

  if (tokenState.phase === 'absent') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="error" />
          <h2 className="text-lg font-semibold">{t('resetPassword.invalid.title', { defaultValue: "This link doesn't work" })}</h2>
          <p className="text-sm text-muted-foreground">
            {t('resetPassword.invalid.description', {
              defaultValue: 'The password reset link is invalid or has expired. Request a new one and try again.',
            })}
          </p>
        </div>
        <a
          href="/forgot-password"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('resetPassword.invalid.requestNewLink', { defaultValue: 'Request a new link' })}
        </a>
      </div>
    );
  }

  if (success) {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">{t('resetPassword.success.title', { defaultValue: 'Password reset successful' })}</h2>
          <p className="text-sm text-muted-foreground">
            {t('resetPassword.success.description', {
              defaultValue: 'Your password has been reset. You can now sign in with your new password.',
            })}
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('common.signIn', { defaultValue: 'Sign in' })}
        </a>
      </div>
    );
  }

  return (
    <ResetPasswordForm
      onSubmit={handleSubmit}
      errorMessage={error}
      loading={loading}
    />
  );
}
