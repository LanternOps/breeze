import { useMemo } from 'react';
import { AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { severityConfig, severityOrder, type AlertSeverity } from './alertConfig';

type AlertCount = {
  severity: AlertSeverity;
  count: number;
  previousCount?: number;
};

type AlertsSummaryProps = {
  alerts: AlertCount[];
  onFilterBySeverity?: (severity: AlertSeverity) => void;
  className?: string;
};

function getTrendInfo(count: number, previousCount?: number) {
  if (previousCount === undefined || previousCount === count) {
    return { direction: 'stable' as const, change: 0 };
  }
  if (count > previousCount) {
    return { direction: 'up' as const, change: count - previousCount };
  }
  return { direction: 'down' as const, change: previousCount - count };
}

export default function AlertsSummary({
  alerts,
  onFilterBySeverity,
  className
}: AlertsSummaryProps) {
  const sortedAlerts = useMemo(() => {
    const alertMap = new Map(alerts.map(a => [a.severity, a]));
    return severityOrder.map(severity => {
      const alert = alertMap.get(severity);
      return {
        severity,
        count: alert?.count ?? 0,
        previousCount: alert?.previousCount
      };
    });
  }, [alerts]);

  const totalActive = useMemo(() => {
    return sortedAlerts.reduce((sum, a) => sum + a.count, 0);
  }, [sortedAlerts]);

  const totalPrevious = useMemo(() => {
    const previousCounts = sortedAlerts.map(a => a.previousCount).filter(p => p !== undefined);
    if (previousCounts.length === 0) return undefined;
    return previousCounts.reduce((sum, p) => sum + (p ?? 0), 0);
  }, [sortedAlerts]);

  const totalTrend = getTrendInfo(totalActive, totalPrevious);

  return (
    <div className={cn(
      'rounded-lg border bg-gradient-to-b from-card to-secondary/30 p-5',
      className
    )}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Active Alerts</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-3xl font-bold tracking-tight">{totalActive}</span>
          {totalTrend.direction !== 'stable' && (
            <div
              className={cn(
                'flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium',
                totalTrend.direction === 'up'
                  ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                  : 'bg-green-500/15 text-green-700 dark:text-green-400'
              )}
            >
              {totalTrend.direction === 'up' ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {totalTrend.change}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-stretch gap-1.5">
        {sortedAlerts.map(alert => {
          const config = severityConfig[alert.severity];
          const trend = getTrendInfo(alert.count, alert.previousCount);
          const hasAlerts = alert.count > 0;
          const isUrgent = hasAlerts && (alert.severity === 'critical' || alert.severity === 'high');

          return (
            <button
              key={alert.severity}
              type="button"
              onClick={() => onFilterBySeverity?.(alert.severity)}
              className={cn(
                'flex flex-1 flex-col items-center justify-center rounded-lg border py-3 transition-all',
                hasAlerts
                  ? cn(config.bg, config.border, 'hover:shadow-sm')
                  : 'border-transparent bg-muted/30 hover:bg-muted/50',
                isUrgent && 'ring-1 ring-inset',
                alert.severity === 'critical' && hasAlerts && 'ring-red-500/40',
                alert.severity === 'high' && hasAlerts && 'ring-orange-500/30',
                'cursor-pointer'
              )}
              title={`View ${config.label.toLowerCase()} alerts`}
            >
              <span className={cn(
                'font-bold tabular-nums',
                hasAlerts ? config.color : 'text-muted-foreground/50',
                isUrgent ? 'text-2xl' : 'text-xl'
              )}>
                {alert.count}
              </span>
              <span className={cn(
                'text-[11px] mt-0.5',
                hasAlerts ? 'text-muted-foreground font-medium' : 'text-muted-foreground/50'
              )}>
                {config.label}
              </span>
              {trend.direction !== 'stable' && (
                <div
                  className={cn(
                    'flex items-center gap-0.5 mt-1 text-[10px] font-medium',
                    trend.direction === 'up' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                  )}
                >
                  {trend.direction === 'up' ? (
                    <TrendingUp className="h-2.5 w-2.5" />
                  ) : (
                    <TrendingDown className="h-2.5 w-2.5" />
                  )}
                  {trend.change}
                </div>
              )}
              {trend.direction === 'stable' && alert.previousCount !== undefined && (
                <div className="flex items-center gap-0.5 mt-1 text-[10px] font-medium text-muted-foreground/50">
                  <Minus className="h-2.5 w-2.5" />
                  0
                </div>
              )}
            </button>
          );
        })}
      </div>

      {totalPrevious !== undefined && (
        <p className="text-[11px] text-muted-foreground/70 text-center mt-3">
          vs. yesterday: {totalPrevious} total
        </p>
      )}
    </div>
  );
}

// Compact version for smaller dashboard widgets
export function AlertsSummaryCompact({
  alerts,
  onFilterBySeverity,
  className
}: AlertsSummaryProps) {
  const sortedAlerts = useMemo(() => {
    const alertMap = new Map(alerts.map(a => [a.severity, a]));
    return severityOrder.map(severity => {
      const alert = alertMap.get(severity);
      return {
        severity,
        count: alert?.count ?? 0,
        previousCount: alert?.previousCount
      };
    });
  }, [alerts]);

  const totalActive = useMemo(() => {
    return sortedAlerts.reduce((sum, a) => sum + a.count, 0);
  }, [sortedAlerts]);

  return (
    <div className={cn('rounded-lg border bg-card p-4', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Alerts</span>
        </div>
        <span className="text-lg font-bold">{totalActive}</span>
      </div>

      <div className="flex items-center gap-1 mt-3">
        {sortedAlerts.map(alert => {
          const config = severityConfig[alert.severity];
          if (alert.count === 0) return null;

          return (
            <button
              key={alert.severity}
              type="button"
              onClick={() => onFilterBySeverity?.(alert.severity)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition hover:opacity-80',
                config.bg,
                config.border,
                config.color,
                'cursor-pointer'
              )}
              title={`${alert.count} ${config.label.toLowerCase()} alerts`}
            >
              {alert.count}
            </button>
          );
        })}
        {totalActive === 0 && (
          <span className="text-xs text-muted-foreground">No active alerts</span>
        )}
      </div>
    </div>
  );
}
