import { useEffect, useState } from 'react';
import { AlertTriangle, AlertCircle, Info, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

interface Alert {
  id: string;
  title: string;
  message?: string;
  severity: string;
  createdAt: string;
  device?: {
    id: string;
    name: string;
  };
  deviceId?: string;
  deviceName?: string;
}

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

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

export default function RecentAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetchWithAuth('/alerts?limit=5&sort=-createdAt');

        if (!response.ok) {
          throw new Error('Failed to fetch alerts');
        }

        const data = await response.json();
        const alertsArray = data.alerts ?? data.data ?? (Array.isArray(data) ? data : []);
        setAlerts(alertsArray);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load alerts');
      } finally {
        setIsLoading(false);
      }
    };

    fetchAlerts();
  }, []);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">Recent Alerts</h3>
          <a href="/alerts" className="text-sm text-primary hover:underline">
            View all
          </a>
        </div>
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">Recent Alerts</h3>
          <a href="/alerts" className="text-sm text-primary hover:underline">
            View all
          </a>
        </div>
        <div className="flex h-48 items-center justify-center">
          <div className="flex items-center gap-2 text-destructive">
            <XCircle className="h-5 w-5" />
            <span className="text-sm">{error}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">Recent Alerts</h3>
        <a href="/alerts" className="text-sm text-primary hover:underline">
          View all
        </a>
      </div>
      <div className="space-y-3">
        {alerts.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No recent alerts
          </div>
        ) : (
          alerts.map((alert) => {
            const severityKey = alert.severity.toLowerCase() as keyof typeof severityConfig;
            const config = severityConfig[severityKey] || severityConfig.low;
            const Icon = config.icon;
            const deviceName = alert.device?.name || alert.deviceName || 'Unknown';
            const alertTitle = alert.title || alert.message || 'Alert';

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
                  <div className="text-sm font-medium truncate">{alertTitle}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{deviceName}</span>
                    <span>-</span>
                    <span>{formatTimeAgo(alert.createdAt)}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
