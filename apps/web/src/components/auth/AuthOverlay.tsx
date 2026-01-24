import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';

export default function AuthOverlay() {
  const { isAuthenticated, isLoading, tokens } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const [shouldShow, setShouldShow] = useState(true);

  useEffect(() => {
    // Give the store time to rehydrate from localStorage
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isChecking && !isLoading) {
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
  }, [isAuthenticated, isLoading, isChecking, tokens]);

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
          {isChecking || isLoading ? 'Loading...' : 'Redirecting to login...'}
        </p>
      </div>
    </div>
  );
}
