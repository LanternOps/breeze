import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '@/lib/dateTimeFormat';
import type { RecentEntry, RecentEntryKind } from '../../stores/recentsStore';
import { RECENT_ENTRY_ICONS } from '../layout/recentEntryIcons';

export const RECENTLY_VIEWED_LIMIT = 8;

export const RECENT_ENTRY_KIND_LABEL_KEYS: Record<RecentEntryKind, string> = {
  device: 'dashboard.recentlyViewed.kind.device',
  org: 'dashboard.recentlyViewed.kind.org',
  ticket: 'dashboard.recentlyViewed.kind.ticket',
  alert: 'dashboard.recentlyViewed.kind.alert',
  site: 'dashboard.recentlyViewed.kind.site',
  page: 'dashboard.recentlyViewed.kind.page',
};

/**
 * "Pick up where you left off": the same recency list as the sidebar's Recent
 * group. Presentational — DashboardPage owns the data and the mounted gate.
 */
export default function RecentlyViewedCard({ entries }: { entries: RecentEntry[] }) {
  const { t } = useTranslation('common');
  if (entries.length === 0) return null;
  return (
    <section data-testid="dashboard-recently-viewed" className="rounded-lg border bg-card p-5 shadow-xs">
      <h3 data-testid="dashboard-recently-viewed-heading" className="text-sm font-semibold">
        {t('dashboard.recentlyViewed.title')}
      </h3>
      <ul className="mt-3 space-y-0.5">
        {entries.map((entry) => {
          const Icon = RECENT_ENTRY_ICONS[entry.kind];
          return (
            <li key={entry.href} data-kind={entry.kind}>
              <a
                data-testid="dashboard-recently-viewed-link"
                href={entry.href}
                title={entry.label}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(/* i18n-dynamic */ RECENT_ENTRY_KIND_LABEL_KEYS[entry.kind])}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatRelativeTime(entry.at)}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
