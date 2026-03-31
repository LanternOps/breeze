import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Monitor, RefreshCw, Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type InstantBootStatusRow = {
  id: string;
  vmName: string;
  status: 'booting' | 'running' | 'completed' | 'failed';
  hostDeviceId: string;
  hostDeviceName?: string | null;
  syncProgress?: number | null;
  startedAt?: string | null;
};

const statusConfig: Record<InstantBootStatusRow['status'], { label: string; className: string; icon: typeof Loader2 }> = {
  booting: { label: 'Booting', className: 'text-primary bg-primary/10', icon: Loader2 },
  running: { label: 'Running', className: 'text-success bg-success/10', icon: Zap },
  completed: { label: 'Completed', className: 'text-success bg-success/10', icon: Zap },
  failed: { label: 'Failed', className: 'text-destructive bg-destructive/10', icon: AlertCircle },
};

export default function InstantBootStatus() {
  const [boots, setBoots] = useState<InstantBootStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchBoots = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/backup/restore/instant-boot/active');
      if (!response.ok) {
        throw new Error('Failed to fetch instant boot status');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setBoots(Array.isArray(data) ? data : []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch instant boot status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBoots();
  }, [fetchBoots]);

  useEffect(() => {
    if (!boots.some((boot) => boot.status === 'booting' || boot.status === 'running')) {
      return;
    }
    const interval = setInterval(fetchBoots, 10000);
    return () => clearInterval(interval);
  }, [boots, fetchBoots]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading instant boot status...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (boots.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center">
        <Zap className="mx-auto h-8 w-8 text-muted-foreground/40" />
        <p className="mt-2 text-sm text-muted-foreground">No active instant boots.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Migration completion controls are hidden until the backend supports them end to end.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {boots.map((boot) => {
        const config = statusConfig[boot.status] ?? statusConfig.booting;
        const StatusIcon = config.icon;

        return (
          <div key={boot.id} className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Monitor className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{boot.vmName}</p>
                  <p className="text-xs text-muted-foreground">
                    Host: {boot.hostDeviceName ?? boot.hostDeviceId.slice(0, 8)}
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                  config.className
                )}
              >
                <StatusIcon className={cn('h-3.5 w-3.5', boot.status === 'booting' && 'animate-spin')} />
                {config.label}
              </span>
            </div>

            {typeof boot.syncProgress === 'number' && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Background sync</span>
                  <span>{boot.syncProgress}%</span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, boot.syncProgress))}%` }}
                  />
                </div>
              </div>
            )}

            <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <RefreshCw className="mt-0.5 h-3.5 w-3.5" />
              Migration completion controls remain hidden until the backend supports a real completion command.
            </div>
          </div>
        );
      })}
    </div>
  );
}
