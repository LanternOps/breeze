import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { restoreAccessTokenFromCookieDetailed, useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';
import { navigateTo } from '../../lib/navigation';

interface AuthGuardProps {
  children: ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { t } = useTranslation('auth');
  const { isAuthenticated, isLoading, tokens, authThrottledUntil } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverAttempted, setRecoverAttempted] = useState(false);

  useEffect(() => {
    // Give the store time to rehydrate from localStorage
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 50);

    // Safety net: if still loading after 10s, force through to avoid permanent hang
    const safetyTimer = setTimeout(() => {
      setIsChecking(false);
      useAuthStore.getState().setLoading(false);
      // ...but a rate-limited refresh legitimately outlasts this timer (the
      // server's window is up to 90s). Clearing `isRecovering` here while a
      // throttle is still in force drops through to the redirect below and
      // re-creates the forced logout of #3696 — with no explanation, since the
      // eviction path was never entered. Leave recovery armed while throttled.
      const { authThrottledUntil: throttledUntil } = useAuthStore.getState();
      if (throttledUntil && throttledUntil > Date.now()) return;
      setIsRecovering(false);
    }, 10000);

    return () => {
      clearTimeout(timer);
      clearTimeout(safetyTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (isChecking || isLoading) return;

    // Fast path: tokens were rehydrated from localStorage — no network needed
    if (isAuthenticated && tokens?.accessToken) {
      return;
    }

    // Slow path: authenticated but no token (e.g. first load after login on another tab)
    if (isAuthenticated && !tokens?.accessToken && !recoverAttempted) {
      setRecoverAttempted(true);
      setIsRecovering(true);

      // Detailed outcome, not the boolean: a 'throttled' verdict (#3696) means
      // the server rate-limited /auth/refresh and never judged the cookie, so
      // the redirect-to-login below must stay dormant. AuthOverlay's throttle
      // mask owns that state.
      void restoreAccessTokenFromCookieDetailed().then((outcome) => {
        if (cancelled) return;
        setIsRecovering(false);
        // 'throttled' (#3696) is NOT a dead session: the server rate-limited
        // /auth/refresh and never judged the cookie. Returning here leaves the
        // guard rendering its spinner instead of redirecting; the store retries
        // and AuthOverlay's throttle mask (where mounted) explains the wait.
        if (outcome === 'throttled') return;
      });
      return () => { cancelled = true; };
    }

    if (isRecovering) {
      return () => { cancelled = true; };
    }

    // Not authenticated — redirect to login. Never while a refresh throttle is
    // still in force: no verdict was reached on the session (#3696).
    if (authThrottledUntil && authThrottledUntil > Date.now()) {
      return () => { cancelled = true; };
    }
    if (!isAuthenticated || !tokens?.accessToken) {
      void navigateTo('/login', { replace: true });
    }

    return () => { cancelled = true; };
  }, [isAuthenticated, isLoading, isChecking, tokens, recoverAttempted, isRecovering, authThrottledUntil]);

  // Fast path: authenticated with token — render children immediately
  if (!isChecking && !isLoading && isAuthenticated && tokens?.accessToken) {
    return <>{children}</>;
  }

  // Show loading while checking auth
  if (isChecking || isLoading || isRecovering) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">{t('common.loading', { defaultValue: 'Loading...' })}</p>
        </div>
      </div>
    );
  }

  // Not authenticated, redirect pending
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">{t('common.redirectingToLogin', { defaultValue: 'Redirecting to login...' })}</p>
      </div>
    </div>
  );
}
