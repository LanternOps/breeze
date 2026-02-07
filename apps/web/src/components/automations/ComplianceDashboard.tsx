import { useMemo, useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle,
  XCircle,
  AlertCircle,
  Monitor,
  Shield,
  ChevronRight,
  Calendar,
  Search,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type ComplianceStatus = 'compliant' | 'non_compliant' | 'unknown';

export type DeviceCompliance = {
  deviceId: string;
  deviceName: string;
  siteName?: string;
  status: ComplianceStatus;
  violationCount: number;
  violations: {
    policyId: string;
    policyName: string;
    ruleName: string;
    message: string;
  }[];
  lastCheckedAt: string;
};

export type PolicyCompliance = {
  policyId: string;
  policyName: string;
  enforcementLevel: 'monitor' | 'warn' | 'enforce';
  compliance: {
    total: number;
    compliant: number;
    nonCompliant: number;
    unknown: number;
  };
};

export type ComplianceTrend = {
  date: string;
  compliancePercent: number;
};

type ComplianceDashboardProps = {
  overallCompliance: {
    total: number;
    compliant: number;
    nonCompliant: number;
    unknown: number;
  };
  trend: ComplianceTrend[];
  policies: PolicyCompliance[];
  nonCompliantDevices: DeviceCompliance[];
  onViewDevice?: (deviceId: string) => void;
  onViewPolicy?: (policyId: string) => void;
  timezone?: string;
};

const statusConfig: Record<ComplianceStatus, { label: string; color: string; bgColor: string; icon: typeof CheckCircle }> = {
  compliant: {
    label: 'Compliant',
    color: 'text-green-600',
    bgColor: 'bg-green-500/20 border-green-500/40',
    icon: CheckCircle
  },
  non_compliant: {
    label: 'Non-Compliant',
    color: 'text-red-600',
    bgColor: 'bg-red-500/20 border-red-500/40',
    icon: XCircle
  },
  unknown: {
    label: 'Unknown',
    color: 'text-gray-500',
    bgColor: 'bg-gray-500/20 border-gray-500/40',
    icon: AlertCircle
  }
};

function formatDate(dateString: string, timezone: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString([], { timeZone: timezone });
}

function CompliancePieChart({ data }: { data: { compliant: number; nonCompliant: number; unknown: number } }) {
  const total = data.compliant + data.nonCompliant + data.unknown;
  if (total === 0) {
    return (
      <div className="flex h-40 w-40 items-center justify-center">
        <span className="text-sm text-muted-foreground">No data</span>
      </div>
    );
  }

  const compliantPercent = (data.compliant / total) * 100;
  const nonCompliantPercent = (data.nonCompliant / total) * 100;
  const unknownPercent = (data.unknown / total) * 100;

  // Calculate stroke dash offsets for pie segments
  const circumference = 2 * Math.PI * 45; // radius = 45
  const compliantDash = (compliantPercent / 100) * circumference;
  const nonCompliantDash = (nonCompliantPercent / 100) * circumference;
  const unknownDash = (unknownPercent / 100) * circumference;

  return (
    <div className="relative h-40 w-40">
      <svg className="h-40 w-40 -rotate-90 transform" viewBox="0 0 100 100">
        {/* Background circle */}
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          className="text-muted/20"
        />
        {/* Compliant segment */}
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeDasharray={`${compliantDash} ${circumference}`}
          strokeDashoffset="0"
          className="text-green-500"
        />
        {/* Non-compliant segment */}
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeDasharray={`${nonCompliantDash} ${circumference}`}
          strokeDashoffset={`${-compliantDash}`}
          className="text-red-500"
        />
        {/* Unknown segment */}
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeDasharray={`${unknownDash} ${circumference}`}
          strokeDashoffset={`${-(compliantDash + nonCompliantDash)}`}
          className="text-gray-400"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold">{Math.round(compliantPercent)}%</span>
        <span className="text-xs text-muted-foreground">Compliant</span>
      </div>
    </div>
  );
}

function TrendChart({ trend }: { trend: ComplianceTrend[] }) {
  if (trend.length < 2) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        Not enough data for trend
      </div>
    );
  }

  const maxPercent = Math.max(...trend.map(t => t.compliancePercent));
  const minPercent = Math.min(...trend.map(t => t.compliancePercent));
  const range = maxPercent - minPercent || 1;

  const points = trend
    .map((t, i) => {
      const x = (i / (trend.length - 1)) * 100;
      const y = 100 - ((t.compliancePercent - minPercent) / range) * 80 - 10;
      return `${x},${y}`;
    })
    .join(' ');

  const firstPercent = trend[0]?.compliancePercent ?? 0;
  const lastPercent = trend[trend.length - 1]?.compliancePercent ?? 0;
  const trendDirection = lastPercent > firstPercent ? 'up' : lastPercent < firstPercent ? 'down' : 'flat';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {trendDirection === 'up' && (
          <>
            <TrendingUp className="h-4 w-4 text-green-500" />
            <span className="text-sm text-green-600">+{(lastPercent - firstPercent).toFixed(1)}%</span>
          </>
        )}
        {trendDirection === 'down' && (
          <>
            <TrendingDown className="h-4 w-4 text-red-500" />
            <span className="text-sm text-red-600">{(lastPercent - firstPercent).toFixed(1)}%</span>
          </>
        )}
        {trendDirection === 'flat' && (
          <>
            <Minus className="h-4 w-4 text-gray-500" />
            <span className="text-sm text-muted-foreground">No change</span>
          </>
        )}
        <span className="text-xs text-muted-foreground">vs last period</span>
      </div>
      <svg className="h-24 w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-primary"
        />
        {/* Data points */}
        {trend.map((t, i) => {
          const x = (i / (trend.length - 1)) * 100;
          const y = 100 - ((t.compliancePercent - minPercent) / range) * 80 - 10;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r="2"
              fill="currentColor"
              className="text-primary"
            />
          );
        })}
      </svg>
    </div>
  );
}

export default function ComplianceDashboard({
  overallCompliance,
  trend,
  policies,
  nonCompliantDevices,
  onViewDevice,
  onViewPolicy,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
}: ComplianceDashboardProps) {
  const [deviceQuery, setDeviceQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  const filteredDevices = useMemo(() => {
    const query = deviceQuery.trim().toLowerCase();
    if (!query) return nonCompliantDevices;
    return nonCompliantDevices.filter(
      d =>
        d.deviceName.toLowerCase().includes(query) ||
        d.siteName?.toLowerCase().includes(query) ||
        d.violations.some(v => v.policyName.toLowerCase().includes(query))
    );
  }, [nonCompliantDevices, deviceQuery]);

  const totalPages = Math.ceil(filteredDevices.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedDevices = filteredDevices.slice(startIndex, startIndex + pageSize);

  const compliancePercent =
    overallCompliance.total > 0
      ? Math.round((overallCompliance.compliant / overallCompliance.total) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Shield className="h-5 w-5" />
            <span className="text-sm font-medium">Overall Compliance</span>
          </div>
          <p className={cn(
            'mt-2 text-3xl font-bold',
            compliancePercent >= 90 ? 'text-green-600' :
            compliancePercent >= 70 ? 'text-yellow-600' : 'text-red-600'
          )}>
            {compliancePercent}%
          </p>
          <p className="text-sm text-muted-foreground">
            {overallCompliance.compliant} of {overallCompliance.total} devices
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle className="h-5 w-5" />
            <span className="text-sm font-medium">Compliant</span>
          </div>
          <p className="mt-2 text-3xl font-bold">{overallCompliance.compliant}</p>
          <p className="text-sm text-muted-foreground">devices passing all policies</p>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-red-600">
            <XCircle className="h-5 w-5" />
            <span className="text-sm font-medium">Non-Compliant</span>
          </div>
          <p className="mt-2 text-3xl font-bold">{overallCompliance.nonCompliant}</p>
          <p className="text-sm text-muted-foreground">devices with violations</p>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertCircle className="h-5 w-5" />
            <span className="text-sm font-medium">Unknown</span>
          </div>
          <p className="mt-2 text-3xl font-bold">{overallCompliance.unknown}</p>
          <p className="text-sm text-muted-foreground">devices pending evaluation</p>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Pie Chart */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold mb-4">Compliance by Status</h3>
          <div className="flex items-center justify-center gap-8">
            <CompliancePieChart data={overallCompliance} />
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-green-500" />
                <span className="text-sm">Compliant ({overallCompliance.compliant})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-red-500" />
                <span className="text-sm">Non-Compliant ({overallCompliance.nonCompliant})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-gray-400" />
                <span className="text-sm">Unknown ({overallCompliance.unknown})</span>
              </div>
            </div>
          </div>
        </div>

        {/* Trend Chart */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold mb-4">Compliance Trend</h3>
          <TrendChart trend={trend} />
        </div>
      </div>

      {/* Policy Breakdown */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h3 className="text-sm font-semibold mb-4">Policy Breakdown</h3>
        <div className="space-y-3">
          {policies.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No policies configured
            </p>
          ) : (
            policies.map(policy => {
              const policyPercent =
                policy.compliance.total > 0
                  ? Math.round((policy.compliance.compliant / policy.compliance.total) * 100)
                  : 0;

              return (
                <div
                  key={policy.policyId}
                  className="flex items-center justify-between rounded-md border bg-muted/20 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Shield className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{policy.policyName}</p>
                      <p className="text-xs text-muted-foreground">
                        {policy.compliance.compliant} / {policy.compliance.total} compliant
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            policyPercent >= 90 ? 'bg-green-500' :
                            policyPercent >= 70 ? 'bg-yellow-500' : 'bg-red-500'
                          )}
                          style={{ width: `${policyPercent}%` }}
                        />
                      </div>
                      <span className={cn(
                        'text-sm font-medium',
                        policyPercent >= 90 ? 'text-green-600' :
                        policyPercent >= 70 ? 'text-yellow-600' : 'text-red-600'
                      )}>
                        {policyPercent}%
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onViewPolicy?.(policy.policyId)}
                      className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Non-Compliant Devices */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h3 className="text-sm font-semibold">Non-Compliant Devices</h3>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search devices..."
              value={deviceQuery}
              onChange={e => {
                setDeviceQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-64"
            />
          </div>
        </div>

        {filteredDevices.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center">
            <CheckCircle className="mx-auto h-8 w-8 text-green-500" />
            <p className="mt-2 text-sm text-muted-foreground">
              {nonCompliantDevices.length === 0
                ? 'All devices are compliant!'
                : 'No matching devices found.'}
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {paginatedDevices.map(device => (
                <div
                  key={device.deviceId}
                  className="rounded-md border bg-muted/20 p-4"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <Monitor className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">{device.deviceName}</p>
                        {device.siteName && (
                          <p className="text-xs text-muted-foreground">{device.siteName}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                        statusConfig[device.status].bgColor,
                        statusConfig[device.status].color
                      )}>
                        {device.violationCount} violation{device.violationCount !== 1 ? 's' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => onViewDevice?.(device.deviceId)}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  {device.violations.length > 0 && (
                    <div className="mt-3 space-y-1 pl-8">
                      {device.violations.slice(0, 3).map((violation, i) => (
                        <p key={i} className="text-xs text-muted-foreground">
                          <span className="font-medium">{violation.policyName}:</span>{' '}
                          {violation.message}
                        </p>
                      ))}
                      {device.violations.length > 3 && (
                        <p className="text-xs text-primary">
                          +{device.violations.length - 3} more violations
                        </p>
                      )}
                    </div>
                  )}
                  <div className="mt-2 pl-8">
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Calendar className="h-3 w-3" />
                      Last checked: {formatDate(device.lastCheckedAt, timezone)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredDevices.length)} of{' '}
                  {filteredDevices.length}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                  </button>
                  <span className="text-sm">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronRightIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
