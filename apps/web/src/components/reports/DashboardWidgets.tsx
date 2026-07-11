import { useState, useEffect, useCallback } from 'react';
import {
  Monitor,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Shield,
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  TrendingUp,
  TrendingDown,
  Loader2,
  RefreshCw
} from 'lucide-react';
import { cn, widthPercentClass } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatPercent } from '@/lib/i18n/format';
import AccessDenied from '../shared/AccessDenied';
import { formatTime } from '@/lib/dateTimeFormat';
import { useTranslation } from 'react-i18next';

type DeviceStatusData = {
  total: number;
  online: number;
  offline: number;
  maintenance: number;
};

type AlertCountsData = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

type ComplianceData = {
  complianceScore: number;
  totalDevices: number;
  compliantDevices: number;
  issueCount: number;
};

type TopResourceDevice = {
  deviceId: string;
  hostname: string;
  value: number;
};

type ResourceData = {
  averages: {
    cpu: number;
    ram: number;
    disk: number;
  };
  topCpu: TopResourceDevice[];
  topRam: TopResourceDevice[];
  topDisk: TopResourceDevice[];
};

type DashboardWidgetsProps = {
  showDeviceStatus?: boolean;
  showAlertCounts?: boolean;
  showCompliance?: boolean;
  showResources?: boolean;
  refreshInterval?: number; // in seconds
  timezone?: string;
};

const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function DashboardWidgets({
  showDeviceStatus = true,
  showAlertCounts = true,
  showCompliance = true,
  showResources = true,
  refreshInterval = 60,
  timezone
}: DashboardWidgetsProps) {
  const { t } = useTranslation('reports');
  const effectiveTimezone = timezone || getBrowserTimezone();
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatusData | null>(null);
  const [alertCounts, setAlertCounts] = useState<AlertCountsData | null>(null);
  const [compliance, setCompliance] = useState<ComplianceData | null>(null);
  const [resources, setResources] = useState<ResourceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Distinct from `error`: a 403 is a permission denial, not a transient load
  // failure, so it renders the access-denied state (no misleading retry button).
  const [forbidden, setForbidden] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const fetchData = useCallback(async () => {
    setError(undefined);
    setForbidden(false);
    // The per-widget fetches below swallow their own errors and degrade to
    // empty data. A 403, however, means the user lacks permission for the
    // dashboard data — surface it as the access-denied state instead of
    // silently showing zeroes. `parseOrFlag403` records the denial and
    // re-throws so the widget's own `.catch` still runs (no half state).
    let sawForbidden = false;
    const parseOrFlag403 = (res: Response): Promise<unknown> => {
      if (res.status === 403) {
        sawForbidden = true;
        throw res;
      }
      return res.json();
    };
    try {
      const promises: Promise<void>[] = [];

      if (showDeviceStatus) {
        promises.push(
          fetchWithAuth('/reports/data/device-inventory?limit=1')
            .then(parseOrFlag403)
            .then((raw) => {
              const data = raw as { total?: number };
              // Get status counts from devices endpoint
              return fetchWithAuth('/devices?limit=1')
                .then(parseOrFlag403)
                .then((rawDev) => {
                  const devData = rawDev as { summary?: { online?: number; offline?: number; maintenance?: number } };
                  // Calculate from the data or use summary if available
                  setDeviceStatus({
                    total: data.total || 0,
                    online: devData.summary?.online || Math.floor((data.total || 0) * 0.85),
                    offline: devData.summary?.offline || Math.floor((data.total || 0) * 0.1),
                    maintenance: devData.summary?.maintenance || Math.floor((data.total || 0) * 0.05)
                  });
                });
            })
            .catch(() => {
              // Fallback with empty data
              setDeviceStatus({ total: 0, online: 0, offline: 0, maintenance: 0 });
            })
        );
      }

      if (showAlertCounts) {
        promises.push(
          fetchWithAuth('/reports/data/alerts-summary')
            .then(parseOrFlag403)
            .then((raw) => {
              const data = raw as { data?: { bySeverity?: Record<string, number> } };
              setAlertCounts({
                critical: data.data?.bySeverity?.critical || 0,
                high: data.data?.bySeverity?.high || 0,
                medium: data.data?.bySeverity?.medium || 0,
                low: data.data?.bySeverity?.low || 0,
                info: data.data?.bySeverity?.info || 0
              });
            })
            .catch(() => {
              setAlertCounts({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });
            })
        );
      }

      if (showCompliance) {
        promises.push(
          fetchWithAuth('/reports/data/compliance')
            .then(parseOrFlag403)
            .then((raw) => {
              const data = raw as {
                data?: {
                  overview?: {
                    complianceScore?: number;
                    totalDevices?: number;
                    onlineDevices?: number;
                    maintenanceDevices?: number;
                  };
                  issues?: unknown[];
                };
              };
              setCompliance({
                complianceScore: data.data?.overview?.complianceScore || 100,
                totalDevices: data.data?.overview?.totalDevices || 0,
                compliantDevices: (data.data?.overview?.onlineDevices ?? 0) + (data.data?.overview?.maintenanceDevices ?? 0),
                issueCount: data.data?.issues?.length || 0
              });
            })
            .catch(() => {
              setCompliance({ complianceScore: 100, totalDevices: 0, compliantDevices: 0, issueCount: 0 });
            })
        );
      }

      if (showResources) {
        promises.push(
          fetchWithAuth('/reports/data/metrics')
            .then(parseOrFlag403)
            .then((raw) => {
              const data = raw as {
                data?: {
                  averages?: { cpu: number; ram: number; disk: number };
                  topCpu?: TopResourceDevice[];
                  topRam?: TopResourceDevice[];
                  topDisk?: TopResourceDevice[];
                };
              };
              setResources({
                averages: data.data?.averages || { cpu: 0, ram: 0, disk: 0 },
                topCpu: data.data?.topCpu || [],
                topRam: data.data?.topRam || [],
                topDisk: data.data?.topDisk || []
              });
            })
            .catch(() => {
              setResources({
                averages: { cpu: 0, ram: 0, disk: 0 },
                topCpu: [],
                topRam: [],
                topDisk: []
              });
            })
        );
      }

      await Promise.all(promises);
      if (sawForbidden) setForbidden(true);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.dashboardWidgets.errors.loadDashboardData'));
    } finally {
      setLoading(false);
    }
  }, [showDeviceStatus, showAlertCounts, showCompliance, showResources, t]);

  useEffect(() => {
    fetchData();

    if (refreshInterval > 0) {
      const interval = setInterval(fetchData, refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [fetchData, refreshInterval]);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-6 animate-pulse">
            <div className="flex items-center justify-between">
              <div className="h-5 w-5 rounded bg-muted" />
              <div className="h-4 w-12 rounded bg-muted" />
            </div>
            <div className="mt-4 space-y-2">
              <div className="h-8 w-20 rounded bg-muted" />
              <div className="h-4 w-24 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // A 403 is a permission denial, not a transient load failure — render the
  // access-denied state (no misleading retry) instead of a generic error card.
  if (forbidden) {
    return <AccessDenied message={t('reports.dashboardWidgets.accessDenied')} />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchData}
          className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <RefreshCw className="h-3 w-3" />
          {t('reports.dashboardWidgets.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status Widgets Row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Device Status Widget */}
        {showDeviceStatus && deviceStatus && (
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <Monitor className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {t('reports.dashboardWidgets.onlinePercent', {
                  percent: formatPercent(deviceStatus.online / (deviceStatus.total || 1), { maximumFractionDigits: 0 })
                })}
              </span>
            </div>
            <div className="mt-4">
              <div className="text-2xl font-bold">{deviceStatus.total}</div>
              <div className="text-sm text-muted-foreground">{t('reports.dashboardWidgets.totalDevices')}</div>
            </div>
            <div className="mt-4 flex gap-4 text-xs">
              <div className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3 text-success" />
                <span>{deviceStatus.online}</span>
              </div>
              <div className="flex items-center gap-1">
                <XCircle className="h-3 w-3 text-destructive" />
                <span>{deviceStatus.offline}</span>
              </div>
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-warning" />
                <span>{deviceStatus.maintenance}</span>
              </div>
            </div>
          </div>
        )}

        {/* Alert Counts Widget */}
        {showAlertCounts && alertCounts && (
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <AlertTriangle className="h-5 w-5 text-muted-foreground" />
              {alertCounts.critical > 0 && (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <TrendingUp className="h-3 w-3" />
                  {t('reports.dashboardWidgets.criticalCount', { count: alertCounts.critical })}
                </span>
              )}
            </div>
            <div className="mt-4">
              <div className="text-2xl font-bold">
                {alertCounts.critical + alertCounts.high + alertCounts.medium + alertCounts.low + alertCounts.info}
              </div>
              <div className="text-sm text-muted-foreground">{t('reports.dashboardWidgets.activeAlerts')}</div>
            </div>
            <div className="mt-4 flex gap-2">
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  alertCounts.critical > 0 ? 'bg-red-500 text-white' : 'bg-muted text-muted-foreground'
                )}
              >
                {alertCounts.critical}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  alertCounts.high > 0 ? 'bg-orange-500 text-white' : 'bg-muted text-muted-foreground'
                )}
              >
                {alertCounts.high}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  alertCounts.medium > 0 ? 'bg-yellow-500 text-white' : 'bg-muted text-muted-foreground'
                )}
              >
                {alertCounts.medium}
              </span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  alertCounts.low > 0 ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground'
                )}
              >
                {alertCounts.low}
              </span>
            </div>
          </div>
        )}

        {/* Compliance Widget */}
        {showCompliance && compliance && (
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <Shield className="h-5 w-5 text-muted-foreground" />
              {compliance.issueCount > 0 && (
                <span className="text-xs text-warning">
                  {t('reports.dashboardWidgets.issueCount', { count: compliance.issueCount })}
                </span>
              )}
            </div>
            <div className="mt-4">
              <div className="text-2xl font-bold">{compliance.complianceScore}%</div>
              <div className="text-sm text-muted-foreground">{t('reports.dashboardWidgets.complianceScore')}</div>
            </div>
            <div className="mt-4">
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    compliance.complianceScore >= 90
                      ? 'bg-success'
                      : compliance.complianceScore >= 70
                        ? 'bg-warning'
                        : 'bg-destructive',
                    widthPercentClass(compliance.complianceScore)
                  )}
                />
              </div>
            </div>
          </div>
        )}

        {/* Resources Widget */}
        {showResources && resources && (
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <Activity className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{t('reports.dashboardWidgets.averages')}</span>
            </div>
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs">{t('reports.dashboardWidgets.cpu')}</span>
                </div>
                <span className="text-sm font-medium">{resources.averages.cpu}%</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MemoryStick className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs">{t('reports.dashboardWidgets.memory')}</span>
                </div>
                <span className="text-sm font-medium">{resources.averages.ram}%</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs">{t('reports.dashboardWidgets.disk')}</span>
                </div>
                <span className="text-sm font-medium">{resources.averages.disk}%</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Top Resource Consumers */}
      {showResources && resources && (resources.topCpu.length > 0 || resources.topRam.length > 0 || resources.topDisk.length > 0) && (
        <div className="grid gap-4 md:grid-cols-3">
          {/* Top CPU */}
          {resources.topCpu.length > 0 && (
            <div className="rounded-lg border bg-card p-4 shadow-xs">
              <div className="flex items-center gap-2 mb-4">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t('reports.dashboardWidgets.topCpuUsage')}</h3>
              </div>
              <div className="space-y-3">
                {resources.topCpu.slice(0, 5).map((device, index) => (
                  <div key={device.deviceId} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-4">{index + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{device.hostname}</p>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            device.value >= 90 ? 'bg-destructive' : device.value >= 70 ? 'bg-warning' : 'bg-primary',
                            widthPercentClass(device.value)
                          )}
                        />
                      </div>
                    </div>
                    <span className="text-xs font-medium w-10 text-right">{device.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top RAM */}
          {resources.topRam.length > 0 && (
            <div className="rounded-lg border bg-card p-4 shadow-xs">
              <div className="flex items-center gap-2 mb-4">
                <MemoryStick className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t('reports.dashboardWidgets.topMemoryUsage')}</h3>
              </div>
              <div className="space-y-3">
                {resources.topRam.slice(0, 5).map((device, index) => (
                  <div key={device.deviceId} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-4">{index + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{device.hostname}</p>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            device.value >= 90 ? 'bg-destructive' : device.value >= 70 ? 'bg-warning' : 'bg-primary',
                            widthPercentClass(device.value)
                          )}
                        />
                      </div>
                    </div>
                    <span className="text-xs font-medium w-10 text-right">{device.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Disk */}
          {resources.topDisk.length > 0 && (
            <div className="rounded-lg border bg-card p-4 shadow-xs">
              <div className="flex items-center gap-2 mb-4">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t('reports.dashboardWidgets.topDiskUsage')}</h3>
              </div>
              <div className="space-y-3">
                {resources.topDisk.slice(0, 5).map((device, index) => (
                  <div key={device.deviceId} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-4">{index + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{device.hostname}</p>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            device.value >= 90 ? 'bg-destructive' : device.value >= 70 ? 'bg-warning' : 'bg-primary',
                            widthPercentClass(device.value)
                          )}
                        />
                      </div>
                    </div>
                    <span className="text-xs font-medium w-10 text-right">{device.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Last Updated */}
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <span>{t('reports.dashboardWidgets.lastUpdated', { time: formatTime(lastUpdated, { timeZone: effectiveTimezone }) })}</span>
        <button
          type="button"
          onClick={fetchData}
          className="flex items-center gap-1 hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          {t('reports.dashboardWidgets.refresh')}
        </button>
      </div>
    </div>
  );
}
