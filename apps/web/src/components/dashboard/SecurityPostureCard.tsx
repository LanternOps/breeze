import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/lib/errorMessages';
import { useTranslation } from 'react-i18next';
import Sparkline from './Sparkline';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { SecurityOverview } from './types';

function scoreBand(score: number): { tone: 'good' | 'fair' | 'poor'; dotClass: string; color: string } {
  if (score >= 80) return { tone: 'good', dotClass: 'bg-success', color: 'hsl(var(--success))' };
  if (score >= 60) return { tone: 'fair', dotClass: 'bg-warning-strong', color: 'hsl(var(--warning-strong))' };
  return { tone: 'poor', dotClass: 'bg-destructive', color: 'hsl(var(--destructive))' };
}

/**
 * Fleet security score with its 30-day trend. Hidden entirely when the
 * caller can't read /security/dashboard.
 */
export default function SecurityPostureCard({
  security,
}: {
  security: DashboardQueryState<SecurityOverview>;
}) {
  const { t, i18n } = useTranslation('common');

  const trendPoints = useMemo(() => {
    const trend = security.data?.trend ?? [];
    const fmt = new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' });
    // Drop invalid timestamps — Intl throws on them, and one bad trend row
    // must not unmount the whole dashboard island.
    return trend
      .map((p) => ({ date: new Date(p.timestamp), score: p.score }))
      .filter((p) => !Number.isNaN(p.date.getTime()))
      .map((p) => ({ label: fmt.format(p.date), value: Math.round(p.score) }));
  }, [security.data?.trend, i18n.language]);

  if (security.unavailable) return null;

  if (security.isLoading) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-security-card">
        <div className="skeleton mb-4 h-4 w-28 rounded" />
        <div className="skeleton mb-3 h-9 w-20 rounded" />
        <div className="skeleton h-14 w-full rounded" />
      </div>
    );
  }

  // A failed load must stay visible — hiding the security card on a 500
  // would be indistinguishable from the deliberate permission-hide above.
  if (security.error && !security.data) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-security-card">
        <a href="/security" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.security.title')}
        </a>
        <p className="mt-3 text-xs text-muted-foreground">{getErrorMessage(security.error)}</p>
      </div>
    );
  }

  const data = security.data;
  if (!data) return null;

  if (data.totalDevices === 0) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-security-card">
        <a href="/security" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.security.title')}
        </a>
        <p className="mt-3 text-sm text-muted-foreground">{t('dashboard.security.empty')}</p>
      </div>
    );
  }

  const band = scoreBand(data.securityScore);

  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs" data-testid="dashboard-security-card">
      <div className="mb-3 flex items-center justify-between">
        <a href="/security" className="text-sm font-semibold transition-colors hover:text-primary">
          {t('dashboard.security.title')}
        </a>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', band.dotClass)} aria-hidden="true" />
          {band.tone === 'good'
            ? t('dashboard.security.good')
            : band.tone === 'fair'
              ? t('dashboard.security.fair')
              : t('dashboard.security.poor')}
        </span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tracking-tight">{Math.round(data.securityScore)}</span>
        <span className="text-sm text-muted-foreground">/100</span>
      </div>

      {trendPoints.length >= 2 && (
        <div className="mt-3">
          <Sparkline points={trendPoints} color={band.color} min={0} max={100} />
          <p className="mt-1 text-[11px] text-muted-foreground/70">{t('dashboard.security.trendLabel')}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <span className={cn(data.atRiskDevices > 0 && 'text-warning-strong')}>
          {t('dashboard.security.atRiskCount', { count: data.atRiskDevices })}
        </span>
        <span className={cn(data.activeThreats > 0 && 'font-medium text-destructive')}>
          {t('dashboard.security.threatsCount', { count: data.activeThreats })}
        </span>
      </div>
    </div>
  );
}
