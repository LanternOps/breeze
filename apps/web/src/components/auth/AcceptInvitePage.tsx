import { useState } from 'react';
import ResetPasswordForm from './ResetPasswordForm';
import { apiAcceptInvite, useAuthStore } from '../../stores/auth';

export default function AcceptInvitePage() {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [token] = useState(() => {
    if (typeof window === 'undefined') return undefined;
    const params = new URLSearchParams(window.location.search);
    return params.get('token') ?? undefined;
  });

  const handleSubmit = async (values: { password: string }) => {
    if (!token) {
      setError('Invalid or missing invite token');
      return;
    }

    setLoading(true);
    setError(undefined);

    try {
      const result = await apiAcceptInvite(token, values.password);

      if (!result.success) {
        setError(result.error || 'Failed to accept invite');
        return;
      }

      if (result.user && result.tokens) {
        useAuthStore.getState().login(result.user, result.tokens);
        window.location.href = '/';
      } else {
        window.location.href = '/login';
      }
    } finally {
      setLoading(false);
    }
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
            This invite link is invalid or has expired.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ResetPasswordForm
      onSubmit={handleSubmit}
      errorMessage={error}
      loading={loading}
      submitLabel="Set password & sign in"
    />
  );
}
