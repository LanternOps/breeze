import { useEffect } from 'react';
import { useAuthStore, fetchWithAuth } from '../../stores/auth';

/**
 * Redirect guard for partners whose account is still in "pending" status
 * (i.e. they registered but haven't completed Stripe checkout yet).
 *
 * Renders nothing — purely a side-effect component that checks the
 * partner status once on mount and redirects to /billing/plans if needed.
 */
export default function PendingGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tokens = useAuthStore((s) => s.tokens);

  useEffect(() => {
    // Only active when billing service is configured (SaaS mode)
    const billingUrl = import.meta.env.PUBLIC_BILLING_URL;
    if (!billingUrl) return;

    if (!isAuthenticated || !tokens?.accessToken) return;

    // Don't redirect if we're already on a billing or auth page
    const path = window.location.pathname;
    if (path.startsWith('/billing') || path.startsWith('/login') || path.startsWith('/register')) {
      return;
    }

    let cancelled = false;

    fetchWithAuth('/partner/me')
      .then((res) => {
        if (cancelled || !res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (cancelled || !data) return;
        if (data.status === 'pending') {
          window.location.href = '/billing/plans';
        }
      })
      .catch(() => {
        // Server-side pendingPartnerGuard is the real enforcement —
        // this component is just a UX convenience to redirect early.
        // On error, do nothing; API calls will 403 if partner is pending.
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, tokens?.accessToken]);

  return null;
}
