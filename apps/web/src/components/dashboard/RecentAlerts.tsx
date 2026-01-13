import { AlertTriangle, AlertCircle, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const alerts = [
  {
    id: 1,
    title: 'High CPU usage on SERVER-01',
    severity: 'critical',
    time: '5 minutes ago',
    device: 'SERVER-01'
  },
  {
    id: 2,
    title: 'Disk space low on WS-042',
    severity: 'high',
    time: '23 minutes ago',
    device: 'WS-042'
  },
  {
    id: 3,
    title: 'Service restart on DB-PRIMARY',
    severity: 'medium',
    time: '1 hour ago',
    device: 'DB-PRIMARY'
  },
  {
    id: 4,
    title: 'Agent update available',
    severity: 'low',
    time: '2 hours ago',
    device: 'Multiple'
  }
];

const severityConfig = {
  critical: {
    icon: XCircle,
    bgColor: 'bg-destructive/10',
    textColor: 'text-destructive',
    borderColor: 'border-l-destructive'
  },
  high: {
    icon: AlertCircle,
    bgColor: 'bg-warning/10',
    textColor: 'text-warning',
    borderColor: 'border-l-warning'
  },
  medium: {
    icon: AlertTriangle,
    bgColor: 'bg-primary/10',
    textColor: 'text-primary',
    borderColor: 'border-l-primary'
  },
  low: {
    icon: Info,
    bgColor: 'bg-muted',
    textColor: 'text-muted-foreground',
    borderColor: 'border-l-muted-foreground'
  }
};

export default function RecentAlerts() {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">Recent Alerts</h3>
        <a href="/alerts" className="text-sm text-primary hover:underline">
          View all
        </a>
      </div>
      <div className="space-y-3">
        {alerts.map((alert) => {
          const config = severityConfig[alert.severity as keyof typeof severityConfig];
          const Icon = config.icon;
          return (
            <div
              key={alert.id}
              className={cn(
                'flex items-start gap-3 rounded-md border-l-4 p-3',
                config.bgColor,
                config.borderColor
              )}
            >
              <Icon className={cn('mt-0.5 h-5 w-5 flex-shrink-0', config.textColor)} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{alert.title}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{alert.device}</span>
                  <span>•</span>
                  <span>{alert.time}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
