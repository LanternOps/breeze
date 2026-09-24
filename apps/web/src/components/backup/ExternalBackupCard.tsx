// apps/web/src/components/backup/ExternalBackupCard.tsx
import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { deriveBackupHealth, type BackupHealth, type ExternalBackupStatus } from '@breeze/shared';

import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '@/lib/runAction';
import { formatBytes } from './backupDashboardHelpers';
import { HEALTH_DOT_CLASS, HISTORY_CELL_CLASS } from './backupHealthBuckets';
import '../../lib/i18n';

export type ProviderDeviceRow = {
  id: string;
  provider: string;
  orgId: string;
  vendorDeviceName: string;
  computerName: string | null;
  customerName: string | null;
  status: ExternalBackupStatus;
  /** Optional: W01's route may return the raw row. Derived locally when absent. */
  health?: BackupHealth;
  lastSuccessAt: string | null;
  lastSessionAt: string | null;
  selectedBytes: number | null;
  usedBytes: number | null;
  errorsCount: number;
  dataSources: string[];
  breezeDeviceId: string | null;
  /** Optional: the bar is skipped rather than faked when the route omits it. */
  history28d?: Array<{ day: string; status: ExternalBackupStatus | null }>;
};

export default function ExternalBackupCard({
  deviceId,
  onUnlinked,
  onPresenceChange,
}: {
  deviceId: string;
  onUnlinked?: () => void;
  onPresenceChange?: (present: boolean) => void;
}) {
  const { t } = useTranslation('backup');
  const [row, setRow] = useState<ProviderDeviceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchWithAuth(`/backup/providers/devices?deviceId=${deviceId}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const payload = await response.json();
      const first: ProviderDeviceRow | null = Array.isArray(payload?.data) ? (payload.data[0] ?? null) : null;
      setRow(first);
      onPresenceChange?.(first !== null);
    } catch (err) {
      console.error('[ExternalBackupCard] load:', err);
      // Not silent: an absent card and a failed lookup look identical to the
      // reader, and only one of them means "no third-party backup".
      setError(t('backupHealth.external.error'));
      onPresenceChange?.(false);
    }
  }, [deviceId, onPresenceChange, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUnlink = async () => {
    if (!row) return;
    if (!window.confirm(t('backupHealth.external.unlinkConfirm'))) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/backup/providers/devices/${row.id}/link`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: null }),
          }),
        errorFallback: t('backupHealth.external.errorUnlink'),
        successMessage: t('backupHealth.external.unlinkedToast'),
      });
      setRow(null);
      onPresenceChange?.(false);
      onUnlinked?.();
    } catch (err) {
      handleActionError(err, t('backupHealth.external.errorUnlink'));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div data-testid="external-backup-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!row) return null;

  const health: BackupHealth =
    row.health ??
    deriveBackupHealth({ status: row.status, lastSuccessAt: row.lastSuccessAt, errorsCount: row.errorsCount }).health;

  return (
    <div data-testid="external-backup-card" className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            data-testid="external-backup-health-dot"
            title={t(/* i18n-dynamic */ `backupHealth.health.${health}`)}
            className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', HEALTH_DOT_CLASS[health])}
          />
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <HardDrive className="h-4 w-4" />
              {t('backupHealth.external.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{row.vendorDeviceName}</p>
          </div>
        </div>
        <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">{row.status}</span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.external.lastSuccess')}</dt>
          <dd className="text-sm text-foreground">
            {formatDateTime(row.lastSuccessAt, { fallback: '--', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.external.lastSession')}</dt>
          <dd className="text-sm text-foreground">
            {formatDateTime(row.lastSessionAt, { fallback: '--', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.external.customer')}</dt>
          <dd className="text-sm text-foreground">{row.customerName ?? '--'}</dd>
        </div>
        <div data-testid="external-backup-selected">
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.selected')}</dt>
          <dd className="text-sm text-foreground">{row.selectedBytes == null ? '--' : formatBytes(row.selectedBytes)}</dd>
        </div>
        <div data-testid="external-backup-used">
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.used')}</dt>
          <dd className="text-sm text-foreground">{row.usedBytes == null ? '--' : formatBytes(row.usedBytes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.errors')}</dt>
          <dd className="text-sm text-foreground">{row.errorsCount}</dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.dataSources')}</dt>
          <dd className="text-sm text-foreground">{row.dataSources.join(', ') || '--'}</dd>
        </div>
      </dl>

      {row.history28d && row.history28d.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">{t('backupHealth.table.history')}</p>
          <div data-testid="external-backup-history" className="mt-1 flex gap-px">
            {row.history28d.map((cell) => (
              <span
                key={cell.day}
                title={`${cell.day} — ${cell.status ?? t('backupHealth.noObservation')}`}
                className={cn('h-4 w-1.5 rounded-[1px]', HISTORY_CELL_CLASS[cell.status ?? 'none'])}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <button
          type="button"
          data-testid="external-backup-unlink"
          disabled={busy}
          onClick={() => void handleUnlink()}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
          {t('backupHealth.external.unlink')}
        </button>
      </div>
    </div>
  );
}
