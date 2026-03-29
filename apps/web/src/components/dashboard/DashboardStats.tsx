import { useEffect, useState } from 'react';
import { Monitor, CheckCircle, AlertTriangle, XCircle, AlertCircle, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { fetchWithAuth } from '../../stores/auth';
import { useAiStore } from '@/stores/aiStore';

interface DashboardStatsData {
  totalDevices: number;
  onlineDevices: number;
  warningAlerts: number;
  criticalAlerts: number;
  onlinePercentage: number;
}

export default function DashboardStats() {
  const [stats, setStats] = useState<DashboardStatsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Fetch devices and alerts in parallel
        const [devicesResponse, alertsResponse] = await Promise.all([
          fetchWithAuth('/devices'),
          fetchWithAuth('/alerts?status=active')
        ]);

        if (!devicesResponse.ok) {
          throw devicesResponse;
        }
        if (!alertsResponse.ok) {
          throw alertsResponse;
        }

        const devicesData = await devicesResponse.json();
        const alertsData = await alertsResponse.json();

        const devices = devicesData.devices ?? devicesData.data ?? (Array.isArray(devicesData) ? devicesData : []);
        const alerts = alertsData.alerts ?? alertsData.data ?? (Array.isArray(alertsData) ? alertsData : []);

        const totalDevices = devices.length;
        const onlineDevices = devices.filter((d: { status: string }) => d.status === 'online').length;
        const warningAlerts = alerts.filter((a: { severity: string }) => a.severity === 'warning' || a.severity === 'medium').length;
        const criticalAlerts = alerts.filter((a: { severity: string }) => a.severity === 'critical' || a.severity === 'high').length;
        const onlinePercentage = totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 1000) / 10 : 0;

        setStats({
          totalDevices,
          onlineDevices,
          warningAlerts,
          criticalAlerts,
          onlinePercentage
        });

        // Inject AI context with dashboard stats
        useAiStore.getState().setPageContext({
          type: 'dashboard',
          deviceCount: totalDevices,
          alertCount: warningAlerts + criticalAlerts
        });
      } catch (err) {
        setError(err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, [retryCount]);

  const retry = () => {
    setRetryCount(c => c + 1);
    setError(null);
  };

  if (isLoading) {
    return (
      <div className="flex flex-wrap gap-x-0 gap-y-4 bg-card/50 px-6 py-4">
        {[1, 2, 3, 4].map((i, idx) => (
          <div key={i} className={`flex items-center gap-3 pr-8 ${idx < 3 ? 'border-r border-border mr-8' : ''}`}>
            <div className="h-5 w-5 rounded bg-muted animate-pulse" />
            <div>
              <div className="h-3 w-16 rounded bg-muted animate-pulse mb-1.5" />
              <div className="h-7 w-10 rounded bg-muted animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-card/50 px-6 py-4">
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

  if (stats && stats.totalDevices === 0) {
    return (
      <div className="flex items-center gap-4 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-6 py-5">
        <div className="rounded-full bg-primary/10 p-2.5">
          <Monitor className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">No devices enrolled yet</p>
          <p className="text-xs text-muted-foreground">Enroll your first device to start monitoring your fleet.</p>
        </div>
        <a href="/settings/enrollment-keys" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
          Get enrollment key
          <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  const statItems = [
    {
      name: 'Total Devices',
      value: stats?.totalDevices.toLocaleString() ?? '0',
      icon: Monitor,
      change: '',
      changeType: 'neutral' as const
    },
    {
      name: 'Online',
      value: stats?.onlineDevices.toLocaleString() ?? '0',
      icon: CheckCircle,
      change: `${stats?.onlinePercentage ?? 0}%`,
      changeType: 'positive' as const
    },
    {
      name: 'Warnings',
      value: stats?.warningAlerts.toLocaleString() ?? '0',
      icon: AlertTriangle,
      change: '',
      changeType: 'neutral' as const
    },
    {
      name: 'Critical',
      value: stats?.criticalAlerts.toLocaleString() ?? '0',
      icon: XCircle,
      change: '',
      changeType: (stats?.criticalAlerts ?? 0) > 0 ? 'negative' as const : 'neutral' as const
    }
  ];

  return (
    <div className="flex flex-wrap gap-x-0 gap-y-4 bg-card/50 px-6 py-4">
      {statItems.map((stat, idx) => (
        <div key={stat.name} className={`flex items-center gap-3 pr-8 ${idx < statItems.length - 1 ? 'border-r border-border mr-8' : ''}`}>
          <stat.icon
            className={cn(
              'h-5 w-5',
              stat.name === 'Online' && 'text-success',
              stat.name === 'Warnings' && 'text-warning',
              stat.name === 'Critical' && 'text-destructive',
              !['Online', 'Warnings', 'Critical'].includes(stat.name) && 'text-muted-foreground'
            )}
          />
          <div>
            <div className="text-xs font-medium text-muted-foreground">{stat.name}</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tracking-tight tabular-nums">{stat.value}</span>
              {stat.change && (
                <span
                  className={cn(
                    'text-xs font-medium',
                    stat.changeType === 'positive' && 'text-success',
                    stat.changeType === 'negative' && 'text-destructive',
                    stat.changeType === 'neutral' && 'text-muted-foreground'
                  )}
                >
                  {stat.change}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
