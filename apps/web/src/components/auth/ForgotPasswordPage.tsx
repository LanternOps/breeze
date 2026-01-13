import { useState } from 'react';
import ForgotPasswordForm from './ForgotPasswordForm';
import { apiForgotPassword } from '../../stores/auth';

export default function ForgotPasswordPage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (values: { email: string }) => {
    setLoading(true);
    setError(undefined);

    const result = await apiForgotPassword(values.email);

    if (!result.success) {
      setError(result.error);
      setLoading(false);
      return;
    }

    setSubmitted(true);
    setLoading(false);
  };

  if (submitted) {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
            <svg className="h-6 w-6 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p className="text-sm text-muted-foreground">
            If an account exists with that email, we have sent a password reset link.
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md border text-sm font-medium transition hover:bg-muted"
        >
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    <ForgotPasswordForm
      onSubmit={handleSubmit}
      errorMessage={error}
      loading={loading}
    />
  );
}
