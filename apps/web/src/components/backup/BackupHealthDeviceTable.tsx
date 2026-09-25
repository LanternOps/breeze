// apps/web/src/components/backup/BackupHealthDeviceTable.tsx
import type { BackupHealthRow } from '@breeze/shared';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatBytes } from './backupDashboardHelpers';
import { HEALTH_DOT_CLASS, HISTORY_CELL_CLASS } from './backupHealthBuckets';
import '../../lib/i18n';

/** The 28-day observed-health bar. A day with no observation is grey, NOT
 *  green — "we did not look" and "it was fine" are different facts. */
function HistoryBar({ row }: { row: BackupHealthRow }) {
  const { t } = useTranslation('backup');
  return (
    <div data-testid={`backup-health-history-${row.key}`} className="flex gap-px" aria-hidden="false">
      {row.history28d.map((cell) => (
        <span
          key={cell.day}
          title={`${cell.day} — ${cell.status ?? t('backupHealth.noObservation')}`}
          className={cn('h-4 w-1 rounded-[1px]', HISTORY_CELL_CLASS[cell.status ?? 'none'])}
        />
      ))}
    </div>
  );
}

export default function BackupHealthDeviceTable({ rows }: { rows: BackupHealthRow[] }) {
  const { t } = useTranslation('backup');

  if (rows.length === 0) {
    return (
      <p data-testid="backup-health-empty" className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t('backupHealth.empty')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
            <th className="pb-2 pr-3">{t('backupHealth.table.device')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.computerName')}</th>
            <th className="pb-2 pr-3">{t('common:labels.organization')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.source')}</th>
            <th className="pb-2 pr-3">{t('common:labels.type')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.dataSources')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.selected')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.used')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.history')}</th>
            <th className="pb-2 pr-3">{t('common:labels.status')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.errors')}</th>
            <th className="pb-2">{t('backupHealth.table.agent')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid={`backup-health-row-${row.key}`} className="border-b last:border-0">
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <span
                    data-testid={`backup-health-dot-${row.key}`}
                    title={t(/* i18n-dynamic */ `backupHealth.health.${row.health}`)}
                    className={cn('h-2.5 w-2.5 shrink-0 rounded-full', HEALTH_DOT_CLASS[row.health])}
                  />
                  {row.deviceId ? (
                    <a href={`/devices/${row.deviceId}`} className="font-medium text-primary hover:underline">
                      {row.name}
                    </a>
                  ) : (
                    <span className="font-medium text-foreground">{row.name}</span>
                  )}
                </div>
                <div className="pl-[18px] text-xs text-muted-foreground">
                  {formatDateTime(row.lastSuccessAt, { fallback: '--', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.computerName ?? '--'}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.orgName}</td>
              <td className="py-2 pr-3">
                <span
                  data-testid={`backup-health-source-${row.key}`}
                  className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {row.source === 'breeze' ? t('backupHealth.sourceBreeze') : (row.providerLabel ?? row.providerKey)}
                </span>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">
                {t(/* i18n-dynamic */ `backupHealth.osType.${row.osType}`, { defaultValue: row.osType })}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">
                {row.dataSources
                  .map((source) => t(/* i18n-dynamic */ `backupHealth.dataSource.${source}`, { defaultValue: source }))
                  .join(', ') || '--'}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.selectedBytes == null ? '--' : formatBytes(row.selectedBytes)}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.usedBytes == null ? '--' : formatBytes(row.usedBytes)}</td>
              <td className="py-2 pr-3"><HistoryBar row={row} /></td>
              <td className="py-2 pr-3 text-muted-foreground">
                {t(/* i18n-dynamic */ `backupHealth.status.${row.status}`, { defaultValue: row.status })}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.errorsCount}</td>
              <td className="py-2 text-muted-foreground">
                {row.agentOnline == null
                  ? '--'
                  : row.agentOnline
                    ? t('common:states.online')
                    : t('common:states.offline')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
