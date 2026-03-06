import { useEffect, useState } from 'react';
import { restoreAccessTokenFromCookie, useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';
import { navigateTo } from '../../lib/navigation';

export default function AuthOverlay() {
  const { isAuthenticated, isLoading, tokens } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverAttempted, setRecoverAttempted] = useState(false);

  useEffect(() => {
    // Give the store time to rehydrate from localStorage
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 50);

    return () => clearTimeout(timer);
  }, []);

  // Safety net: if the overlay is still visible after 10 seconds, force redirect to login.
  // This prevents the user from being stuck on "Loading..." indefinitely.
  useEffect(() => {
    const safetyTimer = setTimeout(() => {
      const state = useAuthStore.getState();
      if (!state.isAuthenticated || !state.tokens?.accessToken) {
        redirectToLogin();
      }
    }, 10_000);

    return () => clearTimeout(safetyTimer);
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

      void restoreAccessTokenFromCookie().then((restored) => {
        if (cancelled) return;
        setIsRecovering(false);

        if (!restored) {
          redirectToLogin();
        }
      });

      return () => { cancelled = true; };
    }

    if (isRecovering) {
      return () => { cancelled = true; };
    }

    if (!isAuthenticated) {
      redirectToLogin();
    }

    return () => { cancelled = true; };
  }, [isAuthenticated, isLoading, isChecking, tokens, recoverAttempted, isRecovering]);

  // Authenticated with token — render nothing, page is visible immediately
  if (!isChecking && !isLoading && isAuthenticated && tokens?.accessToken) {
    return null;
  }

  // Still initializing or recovering — show overlay
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">
          {isChecking || isLoading || isRecovering ? 'Loading...' : 'Redirecting to login...'}
        </p>
      </div>
    </div>
  );
}

function redirectToLogin() {
  const currentPath = window.location.pathname + window.location.search;
  if (currentPath !== '/login' && currentPath !== '/register') {
    sessionStorage.setItem('redirectAfterLogin', currentPath);
  }
  void navigateTo('/login', { replace: true });
}
