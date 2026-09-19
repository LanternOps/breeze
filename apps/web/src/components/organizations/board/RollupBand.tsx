import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { connectorRepairs, type BoardFilter, type ReadinessConnector } from '@/lib/orgReadiness';
import { formatNumber } from '@/lib/i18n/format';
import { integrationSystemName } from './IntegrationBadges';

export interface RollupCell {
  key: BoardFilter;
  /** null → dash: the readiness batches have not all landed yet. */
  count: number | null;
  sub?: string | null;
  subTone?: 'muted' | 'destructive';
  pressed: boolean;
  onPress: () => void;
}

export type RollupStatus = 'idle' | 'loading' | 'partial' | 'ready';

export interface RollupBandProps {
  /** Same order and wording as the filter chips (the page builds them from `visibleFilters`). */
  cells: RollupCell[];
  status: RollupStatus;
  onRetry: () => void;
  /** Partner-level connector state; every not-connected connector renders ONE repair line here (spec: never N per-org problems). */
  connectors?: ReadinessConnector[] | null;
}

/**
 * The roll-up band: one `aria-pressed` button per filter, counts over the LIVE
 * unfiltered list, dashes until every batch has landed, and a "partial" line
 * with Try again when a batch failed. Two per row on a phone, the last cell
 * full width when the count is odd.
 */
export function RollupBand({ cells, status, onRetry, connectors }: RollupBandProps) {
  const { t } = useTranslation('organizations');
  const odd = cells.length % 2 === 1;
  const repairs = connectorRepairs(connectors);
  return (
    <section aria-label={t('orgBoard.band.label')} data-testid="org-board-band" className="space-y-2">
      <div role="group" aria-label={t('orgBoard.band.label')} className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cells.map((cell, index) => {
          const last = index === cells.length - 1;
          return (
            <button
              key={cell.key}
              type="button"
              aria-pressed={cell.pressed}
              data-testid={`org-board-band-${cell.key}`}
              onClick={cell.onPress}
              className={`rounded-lg border bg-card p-4 text-left shadow-xs transition hover:border-primary/40 ${
                cell.pressed ? 'border-primary ring-1 ring-primary/40' : ''
              } ${last && odd ? 'col-span-2 md:col-span-1' : ''}`}
            >
              <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(/* i18n-dynamic */ `orgBoard.band.${cell.key}`)}
              </span>
              <span className="mt-1 block text-2xl font-semibold tabular-nums" data-testid={`org-board-band-${cell.key}-count`}>
                {cell.count === null ? '—' : formatNumber(cell.count)}
              </span>
              {cell.sub && (
                <span className={`mt-0.5 block text-xs ${cell.subTone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {cell.sub}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {repairs.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="org-board-repairs">
          {repairs.map((repair) => {
            const system = integrationSystemName(t, repair.system, { provider: repair.provider });
            return (
              <li key={`${repair.system}:${repair.provider ?? ''}`} className="flex items-center gap-1 text-warning-strong">
                <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-warning" />
                <a
                  href={repair.href}
                  className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  data-testid={`org-board-repair-${repair.system}`}
                  aria-label={t('orgBoard.integrations.connectors.openSettings', { system })}
                >
                  {t(/* i18n-dynamic */ `orgBoard.integrations.connectors.repair.${repair.state}`, { system })}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {status === 'partial' && (
        <p role="status" data-testid="org-board-band-partial" className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span>{t('orgBoard.band.partial')}</span>
          <button type="button" data-testid="org-board-band-retry" onClick={onRetry} className="font-medium text-primary hover:underline">
            {t('orgBoard.actions.tryAgain')}
          </button>
        </p>
      )}
    </section>
  );
}
