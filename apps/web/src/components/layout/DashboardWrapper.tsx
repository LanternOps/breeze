import { useEffect, useState, type ReactNode } from 'react';
import { restoreAccessTokenFromCookieDetailed, useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';
import Sidebar from './Sidebar';
import Header from './Header';
import { navigateTo } from '../../lib/navigation';
import { useTranslation } from 'react-i18next';

interface DashboardWrapperProps {
  children: ReactNode;
  currentPath: string;
}

export default function DashboardWrapper({ children, currentPath }: DashboardWrapperProps) {
  const { t } = useTranslation('common');
  const { isAuthenticated, isLoading, tokens, authThrottledUntil } = useAuthStore();
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

        // Detailed outcome, not the boolean: a 'throttled' verdict (#3696) means
        // the server rate-limited /auth/refresh and never judged the cookie, so
        // the redirect-to-login below must stay dormant. AuthOverlay's throttle
        // mask owns that state.
        void restoreAccessTokenFromCookieDetailed().then((outcome) => {
          if (cancelled) return;
          setIsRecovering(false);
          // 'throttled' (#3696) is NOT a dead session: the server rate-limited
          // /auth/refresh and never judged the cookie. Keep rendering the
          // spinner rather than redirecting; the store retries on its own.
          if (outcome === 'throttled') return;
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

      // Never redirect while a refresh throttle is still in force: no verdict
      // was reached on the session, so there is nothing to evict on (#3696).
      if (authThrottledUntil && authThrottledUntil > Date.now()) {
        return () => {
          cancelled = true;
        };
      }

      // Check if we have valid auth
      const hasValidAuth = isAuthenticated && tokens?.accessToken;

      if (!hasValidAuth) {
        void navigateTo('/login', { replace: true });
      }
    }
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading, isChecking, tokens, currentPath, recoverAttempted, isRecovering, authThrottledUntil]);

  // Show loading while checking auth
  if (isChecking || isLoading || isRecovering) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">{t('states.loading')}</p>
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
          <p className="mt-4 text-sm text-muted-foreground">{t('layout.redirectingToLogin')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar currentPath={currentPath} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
