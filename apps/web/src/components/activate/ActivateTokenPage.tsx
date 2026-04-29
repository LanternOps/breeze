import { useEffect, useState } from 'react';
import StatusIcon from '../auth/StatusIcon';

type ActivationStatus = 'pending' | 'email_verified' | 'payment_redirecting';

interface Props {
  token: string;
  initialStatus: string;
}

function normalizeStatus(value: string): ActivationStatus {
  if (value === 'email_verified' || value === 'payment_redirecting') {
    return value;
  }
  return 'pending';
}

const PENDING_TIMEOUT_MS = 10_000;

export default function ActivateTokenPage({ token, initialStatus }: Props) {
  const [status, setStatus] = useState<ActivationStatus>(() => normalizeStatus(initialStatus));
  const [error, setError] = useState<string | null>(null);
  const [pendingStuck, setPendingStuck] = useState(false);

  // The /activate/:token API endpoint verifies the token server-side and
  // redirects here with ?status=email_verified. If a user lands on this
  // page in the pending state (e.g. browser blocked the redirect, or the
  // user pasted a bare /activate/<token> URL), forward them through the
  // verification endpoint. If nothing happens within 10s, surface a
  // manual retry instead of leaving them on a frozen screen.
  useEffect(() => {
    if (status !== 'pending') return;
    const timeout = window.setTimeout(() => setPendingStuck(true), PENDING_TIMEOUT_MS);
    window.location.replace(`/activate/${encodeURIComponent(token)}`);
    return () => window.clearTimeout(timeout);
  }, [status, token]);

  async function onAttachPayment() {
    setError(null);
    setStatus('payment_redirecting');
    try {
      const res = await fetch('/activate/setup-intent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => 'unknown error');
        throw new Error(`Could not start payment setup: ${msg}`);
      }
      const data = (await res.json()) as { setup_url?: string };
      if (!data.setup_url) throw new Error('No setup URL returned.');
      window.location.href = data.setup_url;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      setStatus('email_verified');
    }
  }

  if (status === 'pending') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm" aria-busy={!pendingStuck}>
        <div className="space-y-2 text-center">
          <StatusIcon variant="pending" label="Verifying" />
          <h2 className="text-lg font-semibold">
            {pendingStuck ? 'Still working…' : 'Verifying your email…'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {pendingStuck
              ? "If this page hasn't moved on, your link may have expired."
              : 'One moment while we confirm your activation link.'}
          </p>
        </div>
        {pendingStuck && (
          <a
            href="/login"
            className="flex h-11 w-full items-center justify-center rounded-md border text-sm font-medium transition hover:bg-muted"
          >
            Go to sign in
          </a>
        )}
      </div>
    );
  }

  if (status === 'email_verified') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">Email verified</h2>
          <p className="text-sm text-muted-foreground">
            One more step. Add a payment method to finish activating your Breeze account. Stripe
            uses this to verify your identity. You won't be charged now.
          </p>
        </div>
        {error && (
          <p className="text-center text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={onAttachPayment}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Add payment method
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm" aria-busy="true">
      <div className="space-y-2 text-center">
        <StatusIcon variant="pending" label="Redirecting" />
        <h2 className="text-lg font-semibold">Redirecting to Stripe…</h2>
        <p className="text-sm text-muted-foreground">
          Hang tight. You'll be forwarded to our secure payment provider in a moment.
        </p>
      </div>
    </div>
  );
}
