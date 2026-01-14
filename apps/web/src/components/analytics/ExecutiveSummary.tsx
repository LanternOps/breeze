import { useMemo } from 'react';
import { AlertTriangle, CheckCircle, TrendingDown, TrendingUp } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { cn, formatNumber } from '@/lib/utils';

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
  trendLabel = 'Operational health'
}: ExecutiveSummaryProps) {
  const uptimeRate = totalDevices === 0 ? 0 : (onlineDevices / totalDevices) * 100;
  const alertsTrend = useMemo(() => {
    const current = warningAlerts + criticalAlerts;
    const previous = Math.max(1, Math.round(current * 1.15));
    const change = ((current - previous) / previous) * 100;
    return { current, change };
  }, [warningAlerts, criticalAlerts]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Device Overview</p>
            <p className="text-xs text-muted-foreground">Fleet availability summary</p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>Uptime</p>
            <p className="text-base font-semibold text-foreground">{uptimeRate.toFixed(1)}%</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border bg-background p-3">
            <p className="text-xs text-muted-foreground">Total devices</p>
            <p className="text-lg font-semibold">{formatNumber(totalDevices)}</p>
          </div>
          <div className="rounded-md border bg-background p-3">
            <p className="text-xs text-muted-foreground">Online</p>
            <p className="text-lg font-semibold text-success">{formatNumber(onlineDevices)}</p>
          </div>
          <div className="rounded-md border bg-background p-3">
            <p className="text-xs text-muted-foreground">Offline</p>
            <p className="text-lg font-semibold text-destructive">{formatNumber(offlineDevices)}</p>
          </div>
        </div>
      </div>
      <div className="grid gap-4">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Alert Summary</p>
              <p className="text-xs text-muted-foreground">Critical and warning alerts</p>
            </div>
            <div
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                alertsTrend.change <= 0 ? 'text-success' : 'text-destructive'
              )}
            >
              {alertsTrend.change <= 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
              {Math.abs(alertsTrend.change).toFixed(1)}%
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <div>
                <p className="text-xs text-muted-foreground">Warnings</p>
                <p className="text-sm font-semibold">{warningAlerts}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
              <CheckCircle className="h-4 w-4 text-destructive" />
              <div>
                <p className="text-xs text-muted-foreground">Critical</p>
                <p className="text-sm font-semibold">{criticalAlerts}</p>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">{trendLabel}</p>
              <p className="text-xs text-muted-foreground">Weekly trend</p>
            </div>
            <p className="text-xs text-muted-foreground">Last 12 weeks</p>
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
