import { useState, useEffect } from 'react';
import ResetPasswordForm from './ResetPasswordForm';
import { apiResetPassword } from '../../stores/auth';

export default function ResetPasswordPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [token, setToken] = useState<string>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    if (tokenParam) {
      setToken(tokenParam);
    }
  }, []);

  const handleSubmit = async (values: { password: string }) => {
    if (!token) {
      setError('Invalid or missing reset token');
      return;
    }

    setLoading(true);
    setError(undefined);

    const result = await apiResetPassword(token, values.password);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (!token) {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <svg className="h-6 w-6 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold">Invalid Link</h2>
          <p className="text-sm text-muted-foreground">
            This password reset link is invalid or has expired.
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
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
            <svg className="h-6 w-6 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
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
