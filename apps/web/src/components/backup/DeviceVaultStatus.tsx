import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, HardDrive, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime } from './backupDashboardHelpers';

// ── Types ──────────────────────────────────────────────────────────

type VaultStatus = 'syncing' | 'completed' | 'failed' | 'never';

type DeviceVault = {
  id: string;
  vaultPath: string;
  type: string;
  status: VaultStatus;
  lastSyncAt?: string | null;
  snapshotCount?: number | null;
};

const statusConfig: Record<VaultStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  syncing: { icon: RefreshCw, className: 'text-primary bg-primary/10', label: 'Syncing' },
  completed: { icon: CheckCircle2, className: 'text-success bg-success/10', label: 'Completed' },
  failed: { icon: XCircle, className: 'text-destructive bg-destructive/10', label: 'Failed' },
  never: { icon: Clock, className: 'text-muted-foreground bg-muted', label: 'Never synced' },
};

// ── Component ─────────────────────────────────────────────────────

export default function DeviceVaultStatus({ deviceId }: { deviceId: string }) {
  const [vault, setVault] = useState<DeviceVault | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchVault = useCallback(async () => {
    try {
      const response = await fetchWithAuth(`/backup/vault?deviceId=${deviceId}`);
      if (response.ok) {
        const payload = await response.json();
        const data = payload?.data ?? payload ?? [];
        const list = Array.isArray(data) ? data : [];
        setVault(list[0] ?? null);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchVault();
  }, [fetchVault]);

  const handleSync = useCallback(async () => {
    if (!vault) return;
    setSyncing(true);
    try {
      await fetchWithAuth(`/backup/vault/${vault.id}/sync`, { method: 'POST' });
      await fetchVault();
    } catch {
      // Silently fail
    } finally {
      setSyncing(false);
    }
  }, [fetchVault, vault]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading vault status...
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-center">
        <HardDrive className="mx-auto h-8 w-8 text-muted-foreground/40" />
        <p className="mt-2 text-sm text-muted-foreground">No local vault configured for this device.</p>
      </div>
    );
  }

  const sCfg = statusConfig[vault.status] ?? statusConfig.never;
  const StatusIcon = sCfg.icon;

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="h-4 w-4" />
          Local Vault
        </h4>
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Sync Now
        </button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Path</p>
          <p className="mt-0.5 truncate font-mono text-xs text-foreground">{vault.vaultPath}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Type</p>
          <p className="mt-0.5 text-xs capitalize text-foreground">{vault.type}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Last Sync</p>
          <p className="mt-0.5 text-xs text-foreground">{formatTime(vault.lastSyncAt)}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Status</p>
          <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', sCfg.className)}>
            <StatusIcon className={cn('h-3 w-3', vault.status === 'syncing' && 'animate-spin')} />
            {sCfg.label}
          </span>
        </div>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {vault.snapshotCount ?? 0} snapshot{(vault.snapshotCount ?? 0) !== 1 ? 's' : ''} stored
      </div>
    </div>
  );
}
