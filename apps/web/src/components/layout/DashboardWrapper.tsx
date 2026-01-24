import { useEffect, useState, type ReactNode } from 'react';
import { useAuthStore } from '../../stores/auth';
import { Loader2 } from 'lucide-react';
import Sidebar from './Sidebar';
import Header from './Header';

interface DashboardWrapperProps {
  children: ReactNode;
  currentPath: string;
}

export default function DashboardWrapper({ children, currentPath }: DashboardWrapperProps) {
  const { isAuthenticated, isLoading, tokens } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Give the store time to rehydrate from localStorage
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isChecking && !isLoading) {
      // Check if we have valid auth
      const hasValidAuth = isAuthenticated && tokens?.accessToken;

      if (!hasValidAuth) {
        // Store the current URL to redirect back after login
        if (currentPath !== '/login' && currentPath !== '/register') {
          sessionStorage.setItem('redirectAfterLogin', currentPath);
        }
        window.location.href = '/login';
      }
    }
  }, [isAuthenticated, isLoading, isChecking, tokens, currentPath]);

  // Show loading while checking auth
  if (isChecking || isLoading) {
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
