import { useMemo } from 'react';
import { AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';

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

const severityConfig: Record<
  AlertSeverity,
  { label: string; color: string; bgColor: string; borderColor: string }
> = {
  critical: {
    label: 'Critical',
    color: 'text-red-700 dark:text-red-400',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30'
  },
  high: {
    label: 'High',
    color: 'text-orange-700 dark:text-orange-400',
    bgColor: 'bg-orange-500/10',
    borderColor: 'border-orange-500/30'
  },
  medium: {
    label: 'Medium',
    color: 'text-yellow-700 dark:text-yellow-400',
    bgColor: 'bg-yellow-500/10',
    borderColor: 'border-yellow-500/30'
  },
  low: {
    label: 'Low',
    color: 'text-blue-700 dark:text-blue-400',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/30'
  },
  info: {
    label: 'Info',
    color: 'text-gray-700 dark:text-gray-400',
    bgColor: 'bg-gray-500/10',
    borderColor: 'border-gray-500/30'
  }
};

const severityOrder: AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

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
    <div className={cn('rounded-lg border bg-card p-6 shadow-sm', className)}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Active Alerts</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold">{totalActive}</span>
          {totalTrend.direction !== 'stable' && (
            <div
              className={cn(
                'flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium',
                totalTrend.direction === 'up'
                  ? 'bg-red-500/20 text-red-700'
                  : 'bg-green-500/20 text-green-700'
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

      <div className="grid grid-cols-5 gap-2">
        {sortedAlerts.map(alert => {
          const config = severityConfig[alert.severity];
          const trend = getTrendInfo(alert.count, alert.previousCount);

          return (
            <button
              key={alert.severity}
              type="button"
              onClick={() => onFilterBySeverity?.(alert.severity)}
              className={cn(
                'flex flex-col items-center rounded-lg border p-3 transition hover:opacity-80',
                config.bgColor,
                config.borderColor,
                'cursor-pointer'
              )}
              title={`View ${config.label.toLowerCase()} alerts`}
            >
              <span className={cn('text-2xl font-bold', config.color)}>{alert.count}</span>
              <span className="text-xs text-muted-foreground mt-1">{config.label}</span>
              {trend.direction !== 'stable' && (
                <div
                  className={cn(
                    'flex items-center gap-0.5 mt-1 text-[10px] font-medium',
                    trend.direction === 'up' ? 'text-red-600' : 'text-green-600'
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
                <div className="flex items-center gap-0.5 mt-1 text-[10px] font-medium text-muted-foreground">
                  <Minus className="h-2.5 w-2.5" />
                  0
                </div>
              )}
            </button>
          );
        })}
      </div>

      {totalPrevious !== undefined && (
        <p className="text-xs text-muted-foreground text-center mt-4">
          Compared to yesterday: {totalPrevious} total alerts
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
    <div className={cn('rounded-lg border bg-card p-4 shadow-sm', className)}>
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
                config.bgColor,
                config.borderColor,
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
