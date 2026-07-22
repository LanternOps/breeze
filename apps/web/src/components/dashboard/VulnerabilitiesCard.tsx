import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/lib/errorMessages';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { VulnerabilityStats } from './types';

/**
 * Open vulnerability exposure: critical findings, known-exploited (KEV)
 * reach, and how many findings already have a patch waiting. Hidden when
 * the caller can't read /vulnerabilities/stats.
 */
export default function VulnerabilitiesCard({
  vulns,
}: {
  vulns: DashboardQueryState<VulnerabilityStats>;
}) {
  const { t } = useTranslation('common');

  if (vulns.unavailable) return null;

  if (vulns.isLoading) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-vulnerabilities-card">
        <div className="skeleton mb-4 h-4 w-28 rounded" />
        <div className="space-y-2.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-5 w-full" />
          ))}
        </div>
      </div>
    );
  }

  // Visible failure state — a 500 must not look like the permission-hide.
  if (vulns.error && !vulns.data) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-vulnerabilities-card">
        <a href="/vulnerabilities" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.vuln.title')}
        </a>
        <p className="mt-3 text-xs text-muted-foreground">{getErrorMessage(vulns.error)}</p>
      </div>
    );
  }

  const data = vulns.data;
  if (!data) return null;

  const allClear = data.totalFindings === 0;

  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-vulnerabilities-card">
      <div className="mb-3 flex items-center justify-between">
        <a href="/vulnerabilities" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.vuln.title')}
        </a>
        {!allClear && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('dashboard.vuln.totalOpen', { count: data.totalFindings })}
          </span>
        )}
      </div>

      {allClear ? (
        <div className="flex flex-col items-center py-5 text-center">
          <div className="mb-2.5 rounded-full bg-success/10 p-2.5">
            <ShieldCheck className="h-5 w-5 text-success" />
          </div>
          <p className="text-sm font-medium text-foreground">{t('dashboard.vuln.allClear')}</p>
        </div>
      ) : (
        <dl className="space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-sm text-foreground/80">
              <span
                className={cn('h-2 w-2 rounded-full', data.criticalOpen > 0 ? 'bg-destructive' : 'bg-chart-neutral')}
                aria-hidden="true"
              />
              {t('dashboard.vuln.criticalOpen')}
            </dt>
            <dd className={cn('text-sm font-semibold tabular-nums', data.criticalOpen > 0 && 'text-destructive')}>
              {formatNumber(data.criticalOpen)}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-sm text-foreground/80">
              <span
                className={cn('h-2 w-2 rounded-full', data.kevCveCount > 0 ? 'bg-warning-strong' : 'bg-chart-neutral')}
                aria-hidden="true"
              />
              {t('dashboard.vuln.kev')}
            </dt>
            <dd className="text-sm tabular-nums text-muted-foreground">
              {t('dashboard.vuln.kevCves', { count: data.kevCveCount })}
              {' · '}
              {t('dashboard.vuln.kevDevices', { count: data.kevDeviceCount })}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-sm text-foreground/80">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              {t('dashboard.vuln.patchReady')}
            </dt>
            <dd className="text-sm font-semibold tabular-nums">{formatNumber(data.patchReadyFindingCount)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
