import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Monitor, RefreshCw, Server, Zap, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

// ── Types ──────────────────────────────────────────────────────────

type BootStatus = 'booting' | 'running' | 'migrating' | 'completed' | 'failed';

type InstantBoot = {
  id: string;
  vmName: string;
  status: BootStatus;
  hostDeviceId: string;
  hostDeviceName?: string | null;
  snapshotId: string;
  migrationProgress?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

const statusConfig: Record<BootStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  booting: { icon: Loader2, className: 'text-primary bg-primary/10', label: 'Booting' },
  running: { icon: Zap, className: 'text-success bg-success/10', label: 'Running' },
  migrating: { icon: RefreshCw, className: 'text-warning bg-warning/10', label: 'Migrating' },
  completed: { icon: CheckCircle2, className: 'text-success bg-success/10', label: 'Completed' },
  failed: { icon: XCircle, className: 'text-destructive bg-destructive/10', label: 'Failed' },
};

// ── Component ─────────────────────────────────────────────────────

export default function InstantBootStatus() {
  const [boots, setBoots] = useState<InstantBoot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [migratingId, setMigratingId] = useState<string | null>(null);

  const fetchBoots = useCallback(async () => {
    try {
      setError(undefined);
      const response = await fetchWithAuth('/backup/restore/instant-boot/active');
      if (!response.ok) throw new Error('Failed to fetch instant boot status');
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setBoots(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[InstantBootStatus] fetchBoots:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBoots();
  }, [fetchBoots]);

  // Auto-refresh while there are active boots
  useEffect(() => {
    const hasActive = boots.some((b) => ['booting', 'running', 'migrating'].includes(b.status));
    if (!hasActive) return;
    const interval = setInterval(fetchBoots, 10000);
    return () => clearInterval(interval);
  }, [boots, fetchBoots]);

  const handleCompleteMigration = useCallback(async (bootId: string) => {
    try {
      setMigratingId(bootId);
      const response = await fetchWithAuth(`/backup/restore/instant-boot/${bootId}/complete`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Failed to complete migration');
      await fetchBoots();
    } catch (err) {
      console.error('[InstantBootStatus] handleCompleteMigration:', err);
      setError(err instanceof Error ? err.message : 'Failed to complete migration');
    } finally {
      setMigratingId(null);
    }
  }, [fetchBoots]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading instant boot status...
      </div>
    );
  }

  if (boots.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center">
        <Zap className="mx-auto h-8 w-8 text-muted-foreground/40" />
        <p className="mt-2 text-sm text-muted-foreground">No active instant boots.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {boots.map((boot) => {
        const sCfg = statusConfig[boot.status] ?? statusConfig.booting;
        const StatusIcon = sCfg.icon;
        const isActive = ['booting', 'running', 'migrating'].includes(boot.status);
        const progress = boot.migrationProgress ?? 0;

        return (
          <div key={boot.id} className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Monitor className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm font-semibold text-foreground">{boot.vmName}</p>
                  <p className="text-xs text-muted-foreground">
                    Host: {boot.hostDeviceName ?? boot.hostDeviceId?.slice(0, 8) ?? '--'}
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                  sCfg.className
                )}
              >
                <StatusIcon className={cn('h-3.5 w-3.5', isActive && 'animate-spin')} />
                {sCfg.label}
              </span>
            </div>

            {/* Migration progress bar */}
            {boot.status === 'migrating' && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Background sync</span>
                  <span>{progress}%</span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                  />
                </div>
              </div>
            )}

            {/* Complete Migration button */}
            {(boot.status === 'running' || boot.status === 'migrating') && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => handleCompleteMigration(boot.id)}
                  disabled={migratingId === boot.id}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  {migratingId === boot.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Server className="h-3 w-3" />
                  )}
                  Complete Migration
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
