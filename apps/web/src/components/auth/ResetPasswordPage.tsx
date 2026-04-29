import { useState, useEffect } from 'react';
import ResetPasswordForm from './ResetPasswordForm';
import StatusIcon from './StatusIcon';
import { apiResetPassword } from '../../stores/auth';

type TokenState = { phase: 'loading' } | { phase: 'present'; token: string } | { phase: 'absent' };

export default function ResetPasswordPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Tri-state to prevent a one-frame flash of "Invalid Link" while the
  // useEffect that reads the URL is still pending. (#418, then a follow-up.)
  const [tokenState, setTokenState] = useState<TokenState>({ phase: 'loading' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    setTokenState(tokenParam ? { phase: 'present', token: tokenParam } : { phase: 'absent' });
  }, []);

  const handleSubmit = async (values: { password: string }) => {
    if (tokenState.phase !== 'present') {
      setError('Invalid or missing reset token');
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
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm" aria-busy="true">
        <div className="space-y-2 text-center">
          <StatusIcon variant="pending" label="Loading" />
          <h2 className="text-lg font-semibold">Loading…</h2>
        </div>
      </div>
    );
  }

  if (tokenState.phase === 'absent') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <StatusIcon variant="error" />
          <h2 className="text-lg font-semibold">This link doesn't work</h2>
          <p className="text-sm text-muted-foreground">
            The password reset link is invalid or has expired. Request a new one and try again.
          </p>
        </div>
        <a
          href="/forgot-password"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Request a new link
        </a>
      </div>
    );
  }

  if (success) {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">Password reset successful</h2>
          <p className="text-sm text-muted-foreground">
            Your password has been reset. You can now sign in with your new password.
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Sign in
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
