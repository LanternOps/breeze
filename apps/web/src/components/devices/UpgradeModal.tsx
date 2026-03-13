import { useState } from 'react';
import { AlertTriangle, Loader2, Zap } from 'lucide-react';
import { useAuthStore } from '../../stores/auth';

interface UpgradeModalProps {
  currentDevices: number;
  maxDevices: number;
  onClose: () => void;
  onUpgraded: () => void;
}

export default function UpgradeModal({
  currentDevices,
  maxDevices,
  onClose,
  onUpgraded,
}: UpgradeModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const billingUrl = import.meta.env.PUBLIC_BILLING_URL || '';

  // Billing not configured — this modal should never appear in self-hosted mode
  if (!billingUrl) {
    return null;
  }

  const handleUpgrade = async () => {
    setLoading(true);
    setError(undefined);

    try {
      // Read partnerId from the persisted auth store
      let partnerId: string | undefined;
      try {
        const stored = localStorage.getItem('breeze-auth');
        if (stored) {
          const parsed = JSON.parse(stored);
          // The org store holds the partnerId, but auth store user may have it too.
          // Fall back to the org store.
          partnerId = parsed?.state?.user?.partnerId;
        }
      } catch {
        /* ignore */
      }

      // Also check the org store for partnerId
      if (!partnerId) {
        try {
          const orgStored = localStorage.getItem('breeze-org');
          if (orgStored) {
            const parsed = JSON.parse(orgStored);
            partnerId = parsed?.state?.currentPartnerId;
          }
        } catch {
          /* ignore */
        }
      }

      if (!partnerId) {
        setError('Unable to determine your account. Please contact support.');
        setLoading(false);
        return;
      }

      // Get access token
      const tokens = useAuthStore.getState().tokens;
      if (!tokens?.accessToken) {
        setError('You must be logged in to upgrade.');
        setLoading(false);
        return;
      }

      // Create Stripe Checkout Session via billing service
      const res = await fetch(`${billingUrl}/api/checkout/create-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify({ partnerId, plan: 'community' }),
      });

      if (!res.ok) {
        let msg = 'Failed to create checkout session';
        try {
          const data = await res.json();
          msg = data.error || msg;
        } catch {
          /* ignore parse error */
        }
        setError(msg);
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        onUpgraded();
      } else {
        setError('No checkout URL returned. Please try again.');
        setLoading(false);
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-500/10 p-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Device Limit Reached</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              You're using{' '}
              <span className="font-medium text-foreground">
                {currentDevices} of {maxDevices}
              </span>{' '}
              devices on your Starter plan.
            </p>
          </div>
        </div>

        {/* Community Plan Card */}
        <div className="mt-6 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <span className="font-semibold">Community Plan</span>
            </div>
            <div className="text-right">
              <span className="text-2xl font-bold">$99</span>
              <span className="text-sm text-muted-foreground">/month</span>
            </div>
          </div>
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            <li>Up to 250 devices</li>
            <li>All monitoring features</li>
            <li>Priority support</li>
          </ul>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Not Now
          </button>
          <button
            type="button"
            onClick={handleUpgrade}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Upgrade Now
          </button>
        </div>
      </div>
    </div>
  );
}
