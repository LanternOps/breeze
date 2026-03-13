import { useEffect } from 'react';
import { useAuthStore, fetchWithAuth } from '../../stores/auth';

export default function AccountInactiveGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tokens = useAuthStore((s) => s.tokens);

  useEffect(() => {
    if (!isAuthenticated || !tokens?.accessToken) return;

    const path = window.location.pathname;
    if (path.startsWith('/account/') || path.startsWith('/login') || path.startsWith('/register')) {
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
        if (data.status && data.status !== 'active') {
          window.location.href = '/account/inactive';
        }
      })
      .catch(() => {
        // Best-effort check — server-side guard is the real enforcement.
      });

    return () => { cancelled = true; };
  }, [isAuthenticated, tokens?.accessToken]);

  return null;
}
