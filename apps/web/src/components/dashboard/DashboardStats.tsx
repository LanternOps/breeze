import { useEffect, useState } from 'react';
import { Monitor, CheckCircle, AlertTriangle, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

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
  const [error, setError] = useState<string | null>(null);

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
          throw new Error('Failed to fetch devices');
        }
        if (!alertsResponse.ok) {
          throw new Error('Failed to fetch alerts');
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
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard stats');
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, []);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-center h-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
        <div className="flex items-center gap-2 text-destructive">
          <XCircle className="h-5 w-5" />
          <span className="text-sm font-medium">{error}</span>
        </div>
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {statItems.map((stat) => (
        <div
          key={stat.name}
          className="rounded-lg border bg-card p-6 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <stat.icon
              className={cn(
                'h-5 w-5',
                stat.name === 'Online' && 'text-success',
                stat.name === 'Warnings' && 'text-warning',
                stat.name === 'Critical' && 'text-destructive'
              )}
            />
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
          <div className="mt-4">
            <div className="text-2xl font-bold">{stat.value}</div>
            <div className="text-sm text-muted-foreground">{stat.name}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
