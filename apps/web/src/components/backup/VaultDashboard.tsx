import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Usb,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatBytes, formatTime } from './backupDashboardHelpers';
import VaultConfigDialog from './VaultConfigDialog';
import AlphaBadge from '../shared/AlphaBadge';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────

type VaultType = 'local' | 'smb' | 'usb';
type VaultStatus = 'syncing' | 'completed' | 'failed' | 'never';

type Vault = {
  id: string;
  deviceId: string;
  deviceName?: string | null;
  vaultPath: string;
  type: VaultType;
  status: VaultStatus;
  lastSyncAt?: string | null;
  snapshotCount?: number | null;
  sizeBytes?: number | null;
  retentionCount?: number | null;
  active?: boolean;
  lastSyncError?: string | null;
};

const statusConfig: Record<VaultStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  syncing: { icon: RefreshCw, className: 'text-primary bg-primary/10', label: 'Syncing' },
  completed: { icon: CheckCircle2, className: 'text-success bg-success/10', label: 'Completed' },
  failed: { icon: XCircle, className: 'text-destructive bg-destructive/10', label: 'Failed' },
  never: { icon: Clock, className: 'text-muted-foreground bg-muted', label: 'Never synced' },
};

const typeConfig: Record<VaultType, { icon: typeof HardDrive; label: string; className: string }> = {
  local: { icon: HardDrive, label: 'Local', className: 'bg-primary/10 text-primary' },
  smb: { icon: Server, label: 'SMB', className: 'bg-warning/10 text-warning' },
  usb: { icon: Usb, label: 'USB', className: 'bg-muted text-muted-foreground' },
};

// ── Component ─────────────────────────────────────────────────────

export default function VaultDashboard() {
  const { t } = useTranslation('backup');
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingVault, setEditingVault] = useState<Vault | null>(null);

  const fetchVaults = useCallback(async () => {
    try {
      setError(undefined);
      const response = await fetchWithAuth('/backup/vault');
      if (!response.ok) throw new Error('Failed to fetch vaults');
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setVaults(
        Array.isArray(data)
          ? data.map((item) => {
              const raw = item as Record<string, unknown>;
              const rawStatus = `${raw.lastSyncStatus ?? ''}`.toLowerCase();
              const status: VaultStatus =
                rawStatus === 'pending' || rawStatus === 'running'
                  ? 'syncing'
                  : rawStatus === 'completed'
                    ? 'completed'
                    : rawStatus === 'failed'
                      ? 'failed'
                      : 'never';

              return {
                id: String(raw.id ?? ''),
                deviceId: String(raw.deviceId ?? ''),
                deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : null,
                vaultPath: String(raw.vaultPath ?? ''),
                type: (raw.vaultType === 'smb' || raw.vaultType === 'usb' ? raw.vaultType : 'local') as VaultType,
                status,
                lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
                snapshotCount: typeof raw.snapshotCount === 'number' ? raw.snapshotCount : null,
                sizeBytes: typeof raw.syncSizeBytes === 'number'
                  ? raw.syncSizeBytes
                  : typeof raw.sizeBytes === 'number'
                    ? raw.sizeBytes
                    : null,
                retentionCount: typeof raw.retentionCount === 'number' ? raw.retentionCount : null,
                active: typeof raw.isActive === 'boolean' ? raw.isActive : true,
                lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : null,
              } satisfies Vault;
            })
          : []
      );
    } catch (err) {
      console.error('[VaultDashboard] fetchVaults:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVaults();
  }, [fetchVaults]);

  const handleSync = useCallback(async (vaultId: string) => {
    try {
      setSyncingId(vaultId);
      const response = await fetchWithAuth(`/backup/vault/${vaultId}/sync`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to trigger sync');
      await fetchVaults();
    } catch (err) {
      console.error('[VaultDashboard] handleSync:', err);
      setError(err instanceof Error ? err.message : 'Failed to sync vault');
    } finally {
      setSyncingId(null);
    }
  }, [fetchVaults]);

  const handleDeactivate = useCallback(async (vaultId: string) => {
    try {
      const response = await fetchWithAuth(`/backup/vault/${vaultId}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      });
      if (!response.ok) throw new Error('Failed to deactivate vault');
      await fetchVaults();
    } catch (err) {
      console.error('[VaultDashboard] handleDeactivate:', err);
      setError(err instanceof Error ? err.message : 'Failed to deactivate vault');
    }
  }, [fetchVaults]);

  const handleEdit = useCallback((vault: Vault) => {
    setEditingVault(vault);
    setDialogOpen(true);
  }, []);

  const handleAdd = useCallback(() => {
    setEditingVault(null);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback((saved?: boolean) => {
    setDialogOpen(false);
    setEditingVault(null);
    if (saved) fetchVaults();
  }, [fetchVaults]);

  // Summary stats
  const totalVaults = vaults.length;
  const totalSyncedSize = vaults.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0);
  const vaultsWithErrors = vaults.filter((v) => v.status === 'failed').length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('vaultDashboard.loadingVaults')}</p>
        </div>
      </div>
    );
  }

  if (error && vaults.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchVaults}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('vaultDashboard.tryAgain')} </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="Local vault (SMB/USB) caching is in early access. Vault sync, retention, and fallback restore are functional but have not been tested across all network and storage configurations." />
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs font-medium text-muted-foreground">{t('vaultDashboard.totalVaults')}</p>
          <p className="mt-1 text-2xl font-bold text-foreground">{totalVaults}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs font-medium text-muted-foreground">{t('vaultDashboard.totalSyncedSize')}</p>
          <p className="mt-1 text-2xl font-bold text-foreground">{formatBytes(totalSyncedSize)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs font-medium text-muted-foreground">{t('vaultDashboard.vaultsWithErrors')}</p>
          <p className={cn('mt-1 text-2xl font-bold', vaultsWithErrors > 0 ? 'text-destructive' : 'text-foreground')}>
            {vaultsWithErrors}
          </p>
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{t('vaultDashboard.localVaults')}</h3>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('vaultDashboard.addVault')} </button>
      </div>

      {/* Vault Table */}
      {vaults.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
          <HardDrive className="h-12 w-12 text-muted-foreground/40" />
          <h3 className="mt-4 text-base font-semibold text-foreground">{t('vaultDashboard.noVaultsConfigured')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('vaultDashboard.addALocalVaultToEnableOnSite')} </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.device')}</th>
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.vaultPath')}</th>
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.type')}</th>
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.status')}</th>
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.lastSync')}</th>
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.snapshots')}</th>
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.size')}</th>
                  <th className="px-4 py-3 font-medium">{t('vaultDashboard.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {vaults.map((vault) => {
                  const sCfg = statusConfig[vault.status] ?? statusConfig.never;
                  const StatusIcon = sCfg.icon;
                  const tCfg = typeConfig[vault.type] ?? typeConfig.local;
                  const TypeIcon = tCfg.icon;
                  return (
                    <tr key={vault.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium text-foreground">
                        {vault.deviceName ?? vault.deviceId?.slice(0, 8) ?? '--'}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        <div>
                          <div>{vault.vaultPath}</div>
                          {vault.lastSyncError ? (
                            <div className="mt-1 flex items-start gap-1 chart-legend-xs text-destructive">
                              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                              <span className="line-clamp-2">{vault.lastSyncError}</span>
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tCfg.className)}>
                          <TypeIcon className="h-3 w-3" />
                          {tCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', sCfg.className)}>
                          <StatusIcon className={cn('h-3 w-3', vault.status === 'syncing' && 'animate-spin')} />
                          {sCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatTime(vault.lastSyncAt)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {vault.snapshotCount ?? 0}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatBytes(vault.sizeBytes ?? 0)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleSync(vault.id)}
                            disabled={syncingId === vault.id}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                          >
                            {syncingId === vault.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                            {t('vaultDashboard.sync')} </button>
                          <button
                            type="button"
                            onClick={() => handleEdit(vault)}
                            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            {t('vaultDashboard.edit')} </button>
                          <button
                            type="button"
                            onClick={() => handleDeactivate(vault.id)}
                            className="rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                          >
                            {t('vaultDashboard.deactivate')} </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Vault Config Dialog */}
      {dialogOpen && (
        <VaultConfigDialog
          vault={editingVault}
          onClose={handleDialogClose}
        />
      )}
    </div>
  );
}
