import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useTranslation } from 'react-i18next';

export type AssetHistoryEntry = {
  id: string;
  action: 'check-out' | 'check-in';
  user: string;
  date: string;
  notes?: string;
};

type AssetHistoryProps = {
  entries: AssetHistoryEntry[];
  timezone?: string;
};

const actionStyles: Record<AssetHistoryEntry['action'], string> = {
  'check-out': 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  'check-in': 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
};

export default function AssetHistory({ entries, timezone }: AssetHistoryProps) {
  const { t } = useTranslation('portal');

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{t('assetHistory.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('assetHistory.description')}</p>
      </div>
      <div className="divide-y">
        {entries.map(entry => (
          <div key={entry.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">{entry.user}</div>
              <div className="text-xs text-muted-foreground">
                {formatDateTime(entry.date, { timeZone: timezone })}
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium capitalize',
                  actionStyles[entry.action]
                )}
              >
                {t(/* i18n-dynamic */ `assetHistory.actions.${entry.action}`)}
              </span>
              {entry.notes && (
                <span className="text-xs text-muted-foreground">{entry.notes}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
