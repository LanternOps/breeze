import { useState } from 'react';

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

export default function ActivateTokenPage({ token, initialStatus }: Props) {
  const [status, setStatus] = useState<ActivationStatus>(() => normalizeStatus(initialStatus));
  const [error, setError] = useState<string | null>(null);

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
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <h2 className="text-lg font-semibold">Verifying your email…</h2>
          <p className="text-sm text-muted-foreground">
            One moment while we confirm your activation link.
          </p>
        </div>
      </div>
    );
  }

  if (status === 'email_verified') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
            <svg className="h-6 w-6 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold">Email verified</h2>
          <p className="text-sm text-muted-foreground">
            Add a payment method to finish activating your tenant. This is for identity
            verification — there is no charge for the free tier (up to 25 devices).
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
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2 text-center">
        <h2 className="text-lg font-semibold">Redirecting to Stripe…</h2>
        <p className="text-sm text-muted-foreground">
          Hang tight — you'll be forwarded to our secure payment provider in a moment.
        </p>
      </div>
    </div>
  );
}
