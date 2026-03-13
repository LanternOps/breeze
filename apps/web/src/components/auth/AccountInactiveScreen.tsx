import { useEffect, useState } from 'react';
import { ShieldOff, LogOut } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';

interface StatusInfo {
  status: string;
  message: string | null;
  actionUrl: string | null;
  actionLabel: string | null;
}

const DEFAULT_MESSAGES: Record<string, string> = {
  pending: 'Your account is being set up. Please check back shortly.',
  suspended: 'Your account has been suspended. Please contact your administrator.',
  churned: 'Your account is no longer active. Please contact support.',
};

export default function AccountInactiveScreen() {
  const [info, setInfo] = useState<StatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    fetchWithAuth('/partner/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || data.status === 'active') {
          window.location.href = '/';
          return;
        }
        setInfo({
          status: data.status,
          message: data.statusMessage ?? DEFAULT_MESSAGES[data.status] ?? 'Your account is not active.',
          actionUrl: data.statusActionUrl,
          actionLabel: data.statusActionLabel,
        });
      })
      .catch(() => {
        setInfo({
          status: 'unknown',
          message: 'Unable to load account status. Please try again later.',
          actionUrl: null,
          actionLabel: null,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    logout();
    window.location.href = '/login';
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <ShieldOff className="h-8 w-8 text-muted-foreground" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Account Inactive</h1>
          <p className="text-muted-foreground">{info?.message}</p>
        </div>

        <div className="flex flex-col gap-3">
          {info?.actionUrl && (
            <a
              href={info.actionUrl}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
            >
              {info.actionLabel ?? 'Take Action'}
            </a>
          )}
          <button
            onClick={handleLogout}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
