import { useEffect, useState, type ReactNode } from 'react';
import { restoreAccessTokenFromCookie, useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';

interface AuthGuardProps {
  children: ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, isLoading, tokens } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverAttempted, setRecoverAttempted] = useState(false);

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

        void restoreAccessTokenFromCookie().finally(() => {
          if (!cancelled) {
            setIsRecovering(false);
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

      // Check if we have valid auth
      const hasValidAuth = isAuthenticated && tokens?.accessToken;

      if (!hasValidAuth) {
        // Store the current URL to redirect back after login
        const currentPath = window.location.pathname + window.location.search;
        if (currentPath !== '/login' && currentPath !== '/register') {
          sessionStorage.setItem('redirectAfterLogin', currentPath);
        }
        window.location.href = '/login';
      }
    }
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading, isChecking, tokens, recoverAttempted, isRecovering]);

  // Show loading while checking auth
  if (isChecking || isLoading || isRecovering) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // If not authenticated, show nothing (redirect will happen)
  if (!isAuthenticated || !tokens?.accessToken) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
