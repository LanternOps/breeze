import { AlertTriangle, AlertCircle, Info, XCircle, CheckCircle2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { formatTimeAgo } from '@/lib/formatTime';
import { useTranslation } from 'react-i18next';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AlertRow, AlertsSummary } from './types';

const severityConfig: Record<string, { icon: typeof Info; chipClass: string; iconClass: string }> = {
  critical: { icon: XCircle, chipClass: 'bg-destructive/10', iconClass: 'text-destructive' },
  high: { icon: AlertCircle, chipClass: 'bg-destructive/10', iconClass: 'text-destructive' },
  medium: { icon: AlertTriangle, chipClass: 'bg-warning/15', iconClass: 'text-warning-strong' },
  low: { icon: Info, chipClass: 'bg-muted', iconClass: 'text-muted-foreground' },
  info: { icon: Info, chipClass: 'bg-muted', iconClass: 'text-muted-foreground' },
};

/**
 * The triage feed: only active/acknowledged alerts appear (the query
 * filters server-side); rows with a device deep-link to it. Hidden when the
 * caller can't read alerts — an empty success state on a 403 would be a
 * false health claim.
 */
export default function AlertsFeed({
  alerts,
  summary,
  showOrg,
  onRetry,
}: {
  alerts: DashboardQueryState<AlertRow[]>;
  summary: DashboardQueryState<AlertsSummary>;
  showOrg: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation('common');

  if (alerts.unavailable) return null;

  const severity = summary.data?.bySeverity;
  const criticalCount = severity ? severity.critical + severity.high : 0;
  const warningCount = severity ? severity.medium : 0;

  const header = (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex items-baseline gap-3">
        <h3 data-testid="dashboard-recent-alerts-heading" className="text-sm font-semibold">
          {t('dashboard.attention.title')}
        </h3>
        {severity && (criticalCount > 0 || warningCount > 0) && (
          <span className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
            {criticalCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />
                <span className="sr-only">{t('dashboard.stats.critical')}</span>
                {criticalCount}
              </span>
            )}
            {warningCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-warning-strong" aria-hidden="true" />
                <span className="sr-only">{t('dashboard.stats.warnings')}</span>
                {warningCount}
              </span>
            )}
          </span>
        )}
      </div>
      <a href="/alerts" className="text-xs font-medium text-primary transition-colors hover:text-primary/80">
        {t('dashboard.alerts.viewAll')}
      </a>
    </div>
  );

  if (alerts.isLoading) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs">
        {header}
        <div className="space-y-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3 px-1 py-2.5">
              <div className="skeleton h-8 w-8 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3.5 w-3/4" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (alerts.error && !alerts.data) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs">
        {header}
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="mb-3 rounded-full bg-destructive/10 p-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="mb-1 text-sm font-medium text-foreground">{getErrorTitle(alerts.error)}</p>
          <p className="mb-3 text-xs text-muted-foreground">{getErrorMessage(alerts.error)}</p>
          <button onClick={onRetry} className="text-xs font-medium text-primary hover:underline">
            {t('actions.retry')}
          </button>
        </div>
      </div>
    );
  }

  const rows = alerts.data ?? [];

  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs">
      {header}
      {rows.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
          <div className="rounded-full bg-success/10 p-2.5">
            <CheckCircle2 className="h-5 w-5 text-success" />
          </div>
          <p className="text-sm font-medium text-foreground/80">{t('dashboard.alerts.allClear')}</p>
          <p className="text-xs text-muted-foreground">{t('dashboard.alerts.empty')}</p>
        </div>
      ) : (
        <div className="-mx-2 divide-y divide-border/60">
          {rows.map((alert) => {
            const config = severityConfig[alert.severity?.toLowerCase()] ?? severityConfig.low;
            const Icon = config.icon;
            const title = alert.title || alert.message || t('dashboard.alerts.fallbackTitle');
            const timestamp = alert.triggeredAt || alert.createdAt;
            const inner = (
              <>
                <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', config.chipClass)}>
                  <Icon className={cn('h-4 w-4', config.iconClass)} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {alert.deviceHostname ?? t('states.unknown')}
                    {showOrg && alert.orgName ? ` · ${alert.orgName}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {timestamp ? formatTimeAgo(timestamp) : ''}
                </span>
              </>
            );
            const rowClass =
              'flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors';
            return alert.deviceId ? (
              <a key={alert.id} href={`/devices/${alert.deviceId}`} className={cn(rowClass, 'group hover:bg-muted/40')}>
                {inner}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" aria-hidden="true" />
              </a>
            ) : (
              <div key={alert.id} className={rowClass}>
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
