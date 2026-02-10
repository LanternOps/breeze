import { useEffect, useState } from 'react';
import { restoreAccessTokenFromCookie, useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';

export default function AuthOverlay() {
  const { isAuthenticated, isLoading, tokens } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverAttempted, setRecoverAttempted] = useState(false);
  const [shouldShow, setShouldShow] = useState(true);

  useEffect(() => {
    // Give the store time to rehydrate from localStorage
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!isChecking && !isLoading) {
      if (isAuthenticated && !tokens?.accessToken && !recoverAttempted) {
        setRecoverAttempted(true);
        setIsRecovering(true);

        void restoreAccessTokenFromCookie().then((restored) => {
          if (cancelled) return;
          setIsRecovering(false);

          if (restored) {
            setShouldShow(false);
          }
        });

        return () => {
          cancelled = true;
        };
      }

      if (isRecovering) {
        return () => {
          cancelled = true;
        };
      }

      const hasValidAuth = isAuthenticated && tokens?.accessToken;

      if (!hasValidAuth) {
        // Store the current URL to redirect back after login
        const currentPath = window.location.pathname + window.location.search;
        if (currentPath !== '/login' && currentPath !== '/register') {
          sessionStorage.setItem('redirectAfterLogin', currentPath);
        }
        window.location.href = '/login';
      } else {
        // Authenticated - hide the overlay
        setShouldShow(false);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading, isChecking, tokens, recoverAttempted, isRecovering]);

  // Don't render anything if authenticated
  if (!shouldShow) {
    return null;
  }

  // Show overlay while checking or redirecting
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
