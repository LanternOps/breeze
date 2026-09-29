import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { REPORTS_LIST_FILTERS, type ReportsListFilter } from './listModel';

/** All · Multi-org · Single-org · Combined (spec §3.7). Combines with the org switcher. */
export function ReportsFilterChips({ value, onChange }: { value: ReportsListFilter; onChange: (next: ReportsListFilter) => void }) {
  const { t } = useTranslation('reports');
  return (
    <div role="group" aria-label={t('reports.series.list.filtersLabel')} data-testid="reports-filter-chips" className="flex flex-wrap gap-2">
      {REPORTS_LIST_FILTERS.map((filter) => (
        <button
          key={filter}
          type="button"
          data-testid={`reports-filter-${filter}`}
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition',
            value === filter ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
          )}
        >
          {t(/* i18n-dynamic */ `reports.series.list.filters.${filter}`)}
        </button>
      ))}
    </div>
  );
}
