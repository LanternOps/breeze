import { useMemo, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  XCircle,
  Bell,
  BellOff,
  MoreHorizontal,
  ExternalLink,
  Calendar
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'suppressed';

export type Alert = {
  id: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  status: AlertStatus;
  deviceId: string;
  deviceName: string;
  ruleId?: string;
  ruleName?: string;
  triggeredAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  contextData?: Record<string, unknown>;
};

type AlertListProps = {
  alerts: Alert[];
  devices?: { id: string; name: string }[];
  onSelect?: (alert: Alert) => void;
  onAcknowledge?: (alert: Alert) => void;
  onResolve?: (alert: Alert) => void;
  onSuppress?: (alert: Alert) => void;
  onBulkAction?: (action: string, alerts: Alert[]) => void;
  pageSize?: number;
};

const severityConfig: Record<AlertSeverity, { label: string; color: string; bgColor: string }> = {
  critical: {
    label: 'Critical',
    color: 'text-red-700 dark:text-red-400',
    bgColor: 'bg-red-500/20 border-red-500/40'
  },
  high: {
    label: 'High',
    color: 'text-orange-700 dark:text-orange-400',
    bgColor: 'bg-orange-500/20 border-orange-500/40'
  },
  medium: {
    label: 'Medium',
    color: 'text-yellow-700 dark:text-yellow-400',
    bgColor: 'bg-yellow-500/20 border-yellow-500/40'
  },
  low: {
    label: 'Low',
    color: 'text-blue-700 dark:text-blue-400',
    bgColor: 'bg-blue-500/20 border-blue-500/40'
  },
  info: {
    label: 'Info',
    color: 'text-gray-700 dark:text-gray-400',
    bgColor: 'bg-gray-500/20 border-gray-500/40'
  }
};

const statusConfig: Record<AlertStatus, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-destructive/15 text-destructive border-destructive/30 dark:bg-destructive/20 dark:border-destructive/30' },
  acknowledged: { label: 'Acknowledged', color: 'bg-primary/15 text-primary border-primary/30 dark:bg-primary/20 dark:border-primary/30' },
  resolved: { label: 'Resolved', color: 'bg-success/15 text-success border-success/30 dark:bg-success/20 dark:border-success/30' },
  suppressed: { label: 'Suppressed', color: 'bg-muted text-muted-foreground border-border' }
};

function formatDate(dateString: string): string {
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
  return date.toLocaleDateString();
}

export default function AlertList({
  alerts,
  devices = [],
  onSelect,
  onAcknowledge,
  onResolve,
  onSuppress,
  onBulkAction,
  pageSize = 10
}: AlertListProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [dateRangeFilter, setDateRangeFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);

  const filteredAlerts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return alerts.filter(alert => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : alert.title.toLowerCase().includes(normalizedQuery) ||
            alert.message.toLowerCase().includes(normalizedQuery) ||
            alert.deviceName.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : alert.status === statusFilter;
      const matchesSeverity = severityFilter === 'all' ? true : alert.severity === severityFilter;
      const matchesDevice = deviceFilter === 'all' ? true : alert.deviceId === deviceFilter;

      let matchesDateRange = true;
      if (dateRangeFilter !== 'all') {
        const alertDate = new Date(alert.triggeredAt);
        const now = new Date();
        const diffMs = now.getTime() - alertDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);

        switch (dateRangeFilter) {
          case '1h':
            matchesDateRange = diffHours <= 1;
            break;
          case '24h':
            matchesDateRange = diffHours <= 24;
            break;
          case '7d':
            matchesDateRange = diffHours <= 24 * 7;
            break;
          case '30d':
            matchesDateRange = diffHours <= 24 * 30;
            break;
        }
      }

      return matchesQuery && matchesStatus && matchesSeverity && matchesDevice && matchesDateRange;
    });
  }, [alerts, query, statusFilter, severityFilter, deviceFilter, dateRangeFilter]);

  const totalPages = Math.ceil(filteredAlerts.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedAlerts = filteredAlerts.slice(startIndex, startIndex + pageSize);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(paginatedAlerts.map(a => a.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: string, checked: boolean) => {
    const newSet = new Set(selectedIds);
    if (checked) {
      newSet.add(id);
    } else {
      newSet.delete(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkAction = (action: string) => {
    const selectedAlerts = alerts.filter(a => selectedIds.has(a.id));
    onBulkAction?.(action, selectedAlerts);
    setBulkMenuOpen(false);
    setSelectedIds(new Set());
  };

  const allSelected =
    paginatedAlerts.length > 0 && paginatedAlerts.every(a => selectedIds.has(a.id));
  const someSelected = paginatedAlerts.some(a => selectedIds.has(a.id));

  // Extract unique devices from alerts if not provided
  const availableDevices = useMemo(() => {
    if (devices.length > 0) return devices;
    const deviceMap = new Map<string, string>();
    alerts.forEach(a => {
      if (!deviceMap.has(a.deviceId)) {
        deviceMap.set(a.deviceId, a.deviceName);
      }
    });
    return Array.from(deviceMap.entries()).map(([id, name]) => ({ id, name }));
  }, [alerts, devices]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Alerts</h2>
          <p className="text-sm text-muted-foreground">
            {filteredAlerts.length} of {alerts.length} alerts
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search alerts..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="suppressed">Suppressed</option>
          </select>
          <select
            value={severityFilter}
            onChange={event => {
              setSeverityFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">All Severity</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="info">Info</option>
          </select>
          {availableDevices.length > 0 && (
            <select
              value={deviceFilter}
              onChange={event => {
                setDeviceFilter(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
            >
              <option value="all">All Devices</option>
              {availableDevices.map(device => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={dateRangeFilter}
            onChange={event => {
              setDateRangeFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">All Time</option>
            <option value="1h">Last Hour</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>
          {(query || statusFilter !== 'all' || severityFilter !== 'all' || deviceFilter !== 'all' || dateRangeFilter !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setStatusFilter('all');
                setSeverityFilter('all');
                setDeviceFilter('all');
                setDateRangeFilter('all');
                setCurrentPage(1);
              }}
              className="h-10 whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setBulkMenuOpen(!bulkMenuOpen)}
              className="flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Bulk Actions
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {bulkMenuOpen && (
              <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
                <button
                  type="button"
                  onClick={() => handleBulkAction('acknowledge')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <CheckCircle className="h-4 w-4" />
                  Acknowledge
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('resolve')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <XCircle className="h-4 w-4" />
                  Resolve
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('suppress')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <BellOff className="h-4 w-4" />
                  Suppress
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={e => handleSelectAll(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
              </th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Triggered</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedAlerts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No alerts found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              paginatedAlerts.map(alert => (
                <tr
                  key={alert.id}
                  onClick={() => onSelect?.(alert)}
                  className="cursor-pointer transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(alert.id)}
                      onClick={e => e.stopPropagation()}
                      onChange={e => handleSelectOne(alert.id, e.target.checked)}
                      className="h-4 w-4 rounded border-border"
                    />
                  </td>
                  <td className="max-w-[160px] px-4 py-3">
                    <a
                      href={`/devices/${alert.deviceId}`}
                      onClick={e => e.stopPropagation()}
                      className="flex items-center gap-1 text-sm font-medium hover:underline min-w-0"
                      title={alert.deviceName}
                    >
                      <span className="truncate">{alert.deviceName}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </td>
                  <td className="max-w-[280px] px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={alert.title}>{alert.title}</p>
                      <p className="text-xs text-muted-foreground truncate max-w-xs">
                        {alert.message}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        severityConfig[alert.severity].bgColor,
                        severityConfig[alert.severity].color
                      )}
                    >
                      {severityConfig[alert.severity].label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        statusConfig[alert.status].color
                      )}
                    >
                      {statusConfig[alert.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(alert.triggeredAt)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      {alert.status === 'active' && (
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            onAcknowledge?.(alert);
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <CheckCircle className="h-3.5 w-3.5" />
                          Ack
                        </button>
                      )}
                      {(alert.status === 'active' || alert.status === 'acknowledged') && (
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            onResolve?.(alert);
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-success hover:bg-success/10"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Resolve
                        </button>
                      )}
                      {alert.status !== 'suppressed' && (
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            onSuppress?.(alert);
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                          title="Suppress"
                        >
                          <BellOff className="h-3.5 w-3.5" />
                          Mute
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredAlerts.length)} of{' '}
            {filteredAlerts.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
