import { cn } from '@/lib/utils';

export type AssetHistoryEntry = {
  id: string;
  action: 'check-out' | 'check-in';
  user: string;
  date: string;
  notes?: string;
};

type AssetHistoryProps = {
  entries: AssetHistoryEntry[];
};

const actionStyles: Record<AssetHistoryEntry['action'], string> = {
  'check-out': 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  'check-in': 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
};

export default function AssetHistory({ entries }: AssetHistoryProps) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Asset history</h3>
        <p className="text-xs text-muted-foreground">Recent check-in and check-out activity</p>
      </div>
      <div className="divide-y">
        {entries.map(entry => (
          <div key={entry.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">{entry.user}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(entry.date).toLocaleString()}
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium capitalize',
                  actionStyles[entry.action]
                )}
              >
                {entry.action.replace('-', ' ')}
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
