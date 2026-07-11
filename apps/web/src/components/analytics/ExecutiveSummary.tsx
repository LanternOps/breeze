import { useMemo } from 'react';
import { AlertTriangle, CheckCircle, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { cn, formatNumber } from '@/lib/utils';
import { formatPercent } from '@/lib/i18n/format';

type ExecutiveSummaryProps = {
  totalDevices?: number;
  onlineDevices?: number;
  offlineDevices?: number;
  criticalAlerts?: number;
  warningAlerts?: number;
  trendData?: Array<{ timestamp: string; value: number }>;
  trendLabel?: string;
};

export default function ExecutiveSummary({
  totalDevices = 0,
  onlineDevices = 0,
  offlineDevices = 0,
  criticalAlerts = 0,
  warningAlerts = 0,
  trendData = [],
  trendLabel
}: ExecutiveSummaryProps) {
  const { t } = useTranslation('reports');
  const uptimeRate = totalDevices === 0 ? 0 : (onlineDevices / totalDevices) * 100;
  const displayTrendLabel = trendLabel ?? t('analytics.executiveSummary.operationalHealth');
  const alertsTrend = useMemo(() => {
    const current = warningAlerts + criticalAlerts;
    const previous = Math.max(1, Math.round(current * 1.15));
    const change = ((current - previous) / previous) * 100;
    return { current, change };
  }, [warningAlerts, criticalAlerts]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">{t('analytics.executiveSummary.deviceOverview')}</p>
            <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.fleetAvailabilitySummary')}</p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>{t('analytics.executiveSummary.uptime')}</p>
            <p className="text-base font-semibold text-foreground">{formatPercent(uptimeRate / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border bg-background p-3">
            <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.totalDevices')}</p>
            <p className="text-lg font-semibold">{formatNumber(totalDevices)}</p>
          </div>
          <div className="rounded-md border bg-background p-3">
            <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.online')}</p>
            <p className="text-lg font-semibold text-success">{formatNumber(onlineDevices)}</p>
          </div>
          <div className="rounded-md border bg-background p-3">
            <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.offline')}</p>
            <p className="text-lg font-semibold text-destructive">{formatNumber(offlineDevices)}</p>
          </div>
        </div>
      </div>
      <div className="grid gap-4">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">{t('analytics.executiveSummary.alertSummary')}</p>
              <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.criticalAndWarningAlerts')}</p>
            </div>
            <div
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                alertsTrend.change <= 0 ? 'text-success' : 'text-destructive'
              )}
            >
              {alertsTrend.change <= 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
              {formatPercent(Math.abs(alertsTrend.change) / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <div>
                <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.warnings')}</p>
                <p className="text-sm font-semibold">{warningAlerts}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
              <CheckCircle className="h-4 w-4 text-destructive" />
              <div>
                <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.critical')}</p>
                <p className="text-sm font-semibold">{criticalAlerts}</p>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">{displayTrendLabel}</p>
              <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.weeklyTrend')}</p>
            </div>
            <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.last12Weeks')}</p>
          </div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { ExecutiveSummaryProps };
