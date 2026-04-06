import { useEffect, useState } from 'react';
import { AlertTriangle, AlertCircle, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { fetchWithAuth } from '../../stores/auth';
import { formatTimeAgo } from '@/lib/formatTime';

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

export default function RecentAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetchWithAuth('/alerts?limit=5&sort=-createdAt');

        if (!response.ok) {
          throw response;
        }

        const data = await response.json();
        const alertsArray = data.alerts ?? data.data ?? (Array.isArray(data) ? data : []);
        setAlerts(alertsArray);
      } catch (err) {
        setError(err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchAlerts();
  }, [retryCount]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => setRetryCount(c => c + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const retry = () => {
    setRetryCount(c => c + 1);
    setError(null);
  };

  if (isLoading && alerts.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent Alerts</h3>
          <a href="/alerts" className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
            View all
          </a>
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="flex items-start gap-3 rounded-md border-l-4 border-l-muted p-3">
              <div className="skeleton mt-0.5 h-5 w-5 rounded" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-3/4" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && alerts.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent Alerts</h3>
          <a href="/alerts" className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
            View all
          </a>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="rounded-full bg-destructive/10 p-3 mb-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">{getErrorTitle(error)}</p>
          <p className="text-xs text-muted-foreground mb-3">{getErrorMessage(error)}</p>
          <button onClick={retry} className="text-xs font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Recent Alerts</h3>
        <a href="/alerts" className="text-sm text-primary hover:underline">
          View all
        </a>
      </div>
      <div className="space-y-3">
        {alerts.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm font-medium text-foreground/70">All clear</p>
            <p className="text-xs text-muted-foreground">No active alerts across your fleet</p>
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
