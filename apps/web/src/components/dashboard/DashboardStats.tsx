import { useEffect, useState } from 'react';
import { Monitor, CheckCircle, AlertTriangle, XCircle, AlertCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useAiStore } from '@/stores/aiStore';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';

interface DashboardStatsData {
  totalDevices: number;
  onlineDevices: number;
  warningAlerts: number;
  criticalAlerts: number;
  onlinePercentage: number;
}

function getGreetingKey(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'dashboard.greeting.morning';
  if (hour < 17) return 'dashboard.greeting.afternoon';
  return 'dashboard.greeting.evening';
}

export default function DashboardStats() {
  const { t } = useTranslation('common');
  const { user } = useAuthStore();
  const [greeting, setGreeting] = useState(t('dashboard.greeting.welcome'));
  const [stats, setStats] = useState<DashboardStatsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [updatedText, setUpdatedText] = useState('');

  // Re-fetch when the selected org changes so the tiles track the All-orgs /
  // Current view like the rest of the app. Without this in the fetch effect's
  // deps the stats are stale after a scope change.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);

  useEffect(() => { setGreeting(t(/* i18n-dynamic */ getGreetingKey())); }, [t]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const [devicesResponse, alertsResponse] = await Promise.all([
          fetchWithAuth('/devices'),
          fetchWithAuth('/alerts?status=active')
        ]);

        if (!devicesResponse.ok) throw devicesResponse;
        if (!alertsResponse.ok) throw alertsResponse;

        const devicesData = await devicesResponse.json();
        const alertsData = await alertsResponse.json();

        const devices = devicesData.devices ?? devicesData.data ?? (Array.isArray(devicesData) ? devicesData : []);
        const alerts = alertsData.alerts ?? alertsData.data ?? (Array.isArray(alertsData) ? alertsData : []);

        const totalDevices = devices.length;
        const onlineDevices = devices.filter((d: { status: string }) => d.status === 'online').length;
        const warningAlerts = alerts.filter((a: { severity: string }) => a.severity === 'warning' || a.severity === 'medium').length;
        const criticalAlerts = alerts.filter((a: { severity: string }) => a.severity === 'critical' || a.severity === 'high').length;
        const onlinePercentage = totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 1000) / 10 : 0;

        setStats({ totalDevices, onlineDevices, warningAlerts, criticalAlerts, onlinePercentage });
        setLastUpdated(new Date());

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
  }, [retryCount, currentOrgId]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => setRetryCount(c => c + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Update the "updated" text every 10 seconds
  useEffect(() => {
    if (!lastUpdated) return;
    const tick = () => {
      const diffMs = Date.now() - lastUpdated.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffMs / 60000);
      if (diffSecs < 10) setUpdatedText(t('dashboard.updated.justNow'));
      else if (diffMins < 1) setUpdatedText(t('dashboard.updated.secondsAgo', { count: diffSecs }));
      else if (diffMins < 60) setUpdatedText(t('dashboard.updated.minutesAgo', { count: diffMins }));
      else setUpdatedText(t('dashboard.updated.hoursAgo', { count: Math.floor(diffMs / 3600000) }));
    };
    tick();
    const interval = setInterval(tick, 10_000);
    return () => clearInterval(interval);
  }, [lastUpdated, t]);

  const refresh = () => setRetryCount(c => c + 1);
  const firstName = user?.name?.split(' ')[0];

  const statItems = stats ? [
    {
      name: 'Total Devices',
      label: t('dashboard.stats.totalDevices'),
      value: formatNumber(stats.totalDevices),
      icon: Monitor,
      href: '/devices',
      change: '',
      changeType: 'neutral' as const
    },
    {
      name: 'Online',
      label: t('states.online'),
      value: formatNumber(stats.onlineDevices),
      icon: CheckCircle,
      href: '/devices?status=online',
      change: `${stats.onlinePercentage}%`,
      changeType: 'positive' as const
    },
    {
      name: 'Warnings',
      label: t('dashboard.stats.warnings'),
      value: formatNumber(stats.warningAlerts),
      icon: AlertTriangle,
      href: '/alerts?severity=warning&status=active',
      change: '',
      changeType: 'neutral' as const
    },
    {
      name: 'Critical',
      label: t('dashboard.stats.critical'),
      value: formatNumber(stats.criticalAlerts),
      icon: XCircle,
      href: '/alerts?severity=critical&status=active',
      change: '',
      changeType: stats.criticalAlerts > 0 ? 'negative' as const : 'neutral' as const
    }
  ] : [];

  const header = (
    <div className="flex items-center justify-between">
      <h1 data-testid="dashboard-heading" className="text-xl font-semibold tracking-tight">
        {greeting}{firstName ? `, ${firstName}` : ''}
      </h1>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {updatedText && <span aria-live="polite">{updatedText}</span>}
        <button
          onClick={refresh}
          className="rounded-md p-1 hover:bg-muted transition-colors"
          title={t('dashboard.refresh')}
          aria-label={t('dashboard.refresh')}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </button>
      </div>
    </div>
  );

  if (isLoading && !stats) {
    return (
      <div className="space-y-3">
        {header}
        <div className="grid grid-cols-2 lg:grid-cols-4 rounded-lg border bg-card overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn(
              'flex items-center gap-3 px-6 py-4',
              i % 2 !== 0 && 'border-l border-border',
              i >= 2 && 'border-t border-border lg:border-t-0',
              i >= 2 && i % 2 === 0 && 'lg:border-l lg:border-border'
            )}>
              <div className="h-5 w-5 rounded bg-muted animate-pulse" />
              <div>
                <div className="h-3 w-16 rounded bg-muted animate-pulse mb-1.5" />
                <div className="h-7 w-10 rounded bg-muted animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded-lg border bg-card px-6 py-4">
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="rounded-full bg-destructive/10 p-3 mb-3">
              <AlertCircle className="h-5 w-5 text-destructive" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">{getErrorTitle(error)}</p>
            <p className="text-xs text-muted-foreground mb-3">{getErrorMessage(error)}</p>
            <button onClick={refresh} className="text-xs font-medium text-primary hover:underline">
              {t('actions.retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (stats && stats.totalDevices === 0) {
    return (
      <div className="space-y-3">
        {header}
        <div className="flex items-center gap-4 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-6 py-5">
          <div className="rounded-full bg-primary/10 p-2.5">
            <Monitor className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{t('dashboard.emptyDevices.title')}</p>
            <p className="text-xs text-muted-foreground">{t('dashboard.emptyDevices.description')}</p>
          </div>
          <a href="/devices#add-device" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            {t('dashboard.emptyDevices.add')}
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="dashboard-stats">
      {header}
      <div className="grid grid-cols-2 lg:grid-cols-4 rounded-lg border bg-card overflow-hidden">
        {statItems.map((stat, idx) => (
          <a
            key={stat.name}
            href={stat.href}
            data-testid={`dashboard-${stat.name.toLowerCase().replace(/\s+/g, '-')}-card`}
            className={cn(
              'flex items-center gap-3 px-6 py-4 transition-colors hover:bg-muted/30',
              idx % 2 !== 0 && 'border-l border-border',
              idx >= 2 && 'border-t border-border lg:border-t-0',
              idx >= 2 && idx % 2 === 0 && 'lg:border-l lg:border-border'
            )}
          >
            <stat.icon
              className={cn(
                'h-5 w-5',
                stat.name === 'Online' && 'text-success',
                stat.name === 'Warnings' && (stats!.warningAlerts > 0 ? 'text-warning' : 'text-muted-foreground'),
                stat.name === 'Critical' && (stats!.criticalAlerts > 0 ? 'text-destructive' : 'text-muted-foreground'),
                !['Online', 'Warnings', 'Critical'].includes(stat.name) && 'text-muted-foreground'
              )}
            />
            <div>
              <div className="text-xs font-medium text-muted-foreground">{stat.label}</div>
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
          </a>
        ))}
      </div>
    </div>
  );
}
