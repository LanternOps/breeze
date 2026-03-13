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
    if (!isAuthenticated || !tokens?.accessToken) return;

    // Don't redirect if we're already on a billing or auth page
    const path = window.location.pathname;
    if (path.startsWith('/billing') || path.startsWith('/login') || path.startsWith('/register')) {
      return;
    }

    let cancelled = false;

    fetchWithAuth('/partner/me')
      .then((res) => {
        if (cancelled) return null;
        if (!res.ok) {
          // Fail closed: if we can't verify partner status, redirect to billing
          window.location.href = '/billing/plans';
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled || !data) return;
        if (data.status === 'pending') {
          window.location.href = '/billing/plans';
        }
      })
      .catch(() => {
        // Fail closed: network error means we can't verify, redirect to billing
        if (!cancelled) {
          window.location.href = '/billing/plans';
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, tokens?.accessToken]);

  return null;
}
