import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CheckCircle,
  XCircle,
  BellOff,
  MoreHorizontal,
  ExternalLink,
  Calendar,
  GitBranch,
  Activity,
  SlidersHorizontal,
  X,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  severityConfig,
  statusConfig,
  formatRelativeTime,
  type AlertSeverity,
  type AlertStatus,
} from './alertConfig';
import {
  formatAnomalyConfidence,
  formatAnomalyType,
  type MetricAnomalyAlertContext,
} from './alertMlContext';

export type { AlertSeverity, AlertStatus };

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
  context?: Record<string, unknown>;
  contextData?: Record<string, unknown>;
  anomalyContext?: MetricAnomalyAlertContext | null;
  correlationGroupId?: string | null;
  correlationRole?: string | null;
  correlationGroupStatus?: string | null;
  correlationMemberCount?: number;
  correlationChildCount?: number;
  noiseReductionPercent?: number | null;
  orgId?: string | null;
  orgName?: string | null;
};

type AlertListProps = {
  alerts: Alert[];
  devices?: { id: string; name: string }[];
  onSelect?: (alert: Alert) => void;
  onAcknowledge?: (alert: Alert) => void;
  onResolve?: (alert: Alert) => void;
  onSuppress?: (alert: Alert) => void;
  onDismiss?: (alert: Alert) => void;
  onBulkAction?: (action: string, alerts: Alert[]) => void;
  submittingId?: string | null;
  pageSize?: number;
  alertCorrelationDisabled?: boolean;
  /** Fleet (All-organizations) view: show which org each alert belongs to. */
  showOrgColumn?: boolean;
};

export default function AlertList({
  alerts,
  devices = [],
  onSelect,
  onAcknowledge,
  onResolve,
  onSuppress,
  onDismiss,
  onBulkAction,
  submittingId,
  pageSize = 25,
  alertCorrelationDisabled = false,
  showOrgColumn = false
}: AlertListProps) {
  const { t } = useTranslation('alerts');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [dateRangeFilter, setDateRangeFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  const hasActiveFilters = statusFilter !== 'all' || severityFilter !== 'all' || deviceFilter !== 'all' || dateRangeFilter !== 'all';
  const activeFilterCount = [statusFilter, severityFilter, deviceFilter, dateRangeFilter].filter(f => f !== 'all').length;

  const filteredAlerts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return alerts.filter(alert => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : alert.title.toLowerCase().includes(normalizedQuery) ||
            alert.message.toLowerCase().includes(normalizedQuery) ||
            alert.deviceName.toLowerCase().includes(normalizedQuery);
      // "All Status" still hides dismissed alerts — they're permanently closed
      // and only show when the Dismissed filter is selected explicitly.
      const matchesStatus = statusFilter === 'all' ? alert.status !== 'dismissed' : alert.status === statusFilter;
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
    const selected = alerts.filter(a => selectedIds.has(a.id));
    onBulkAction?.(action, selected);
    setBulkMenuOpen(false);
    setSelectedIds(new Set());
  };

  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setSeverityFilter('all');
    setDeviceFilter('all');
    setDateRangeFilter('all');
    setCurrentPage(1);
  };

  const allSelected =
    paginatedAlerts.length > 0 && paginatedAlerts.every(a => selectedIds.has(a.id));
  const someSelected = paginatedAlerts.some(a => selectedIds.has(a.id));

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
    <div className="rounded-lg border bg-card shadow-xs">
      {/* Search + filter toggle bar */}
      <div className="flex items-center gap-2 p-4 border-b">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={t('alertList.searchAlerts')}
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setCurrentPage(1);
            }}
            className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => setFiltersExpanded(!filtersExpanded)}
          aria-expanded={filtersExpanded}
          className={cn(
            'flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition',
            filtersExpanded || hasActiveFilters
              ? 'border-primary/40 bg-primary/5 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('alertList.filters')}
          {activeFilterCount > 0 && (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {activeFilterCount}
            </span>
          )}
        </button>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filteredAlerts.length} {t('alertList.of')} {alerts.length}
        </span>
      </div>

      {/* Collapsible filter panel */}
      {filtersExpanded && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-3">
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="all">{t('alertList.allStatus')}</option>
            <option value="active">{t('alertList.active')}</option>
            <option value="acknowledged">{t('alertList.acknowledged')}</option>
            <option value="resolved">{t('alertList.resolved')}</option>
            <option value="suppressed">{t('alertList.suppressed')}</option>
            <option value="dismissed">{t('alertList.dismissed')}</option>
          </select>
          <select
            value={severityFilter}
            onChange={event => {
              setSeverityFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="all">{t('alertList.allSeverity')}</option>
            <option value="critical">{t('alertList.critical')}</option>
            <option value="high">{t('alertList.high')}</option>
            <option value="medium">{t('alertList.medium')}</option>
            <option value="low">{t('alertList.low')}</option>
            <option value="info">{t('alertList.info')}</option>
          </select>
          {availableDevices.length > 0 && (
            <select
              value={deviceFilter}
              onChange={event => {
                setDeviceFilter(event.target.value);
                setCurrentPage(1);
              }}
              className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('alertList.allDevices')}</option>
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
            className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="all">{t('alertList.allTime')}</option>
            <option value="1h">{t('alertList.lastHour')}</option>
            <option value="24h">{t('alertList.last24h')}</option>
            <option value="7d">{t('alertList.last7Days')}</option>
            <option value="30d">{t('alertList.last30Days')}</option>
          </select>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
              {t('alertList.clearAll')}
            </button>
          )}
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2">
          <span className="text-sm font-medium">{selectedIds.size} {t('alertList.selected')}</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setBulkMenuOpen(!bulkMenuOpen)}
              aria-expanded={bulkMenuOpen}
              aria-haspopup="menu"
              className="flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('alertList.bulkActions')}
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {bulkMenuOpen && (
              <div role="menu" className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleBulkAction('acknowledge')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <CheckCircle className="h-4 w-4" />
                  {t('alertList.acknowledge')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleBulkAction('resolve')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <CheckCircle className="h-4 w-4 text-success" />
                  {t('alertList.resolve')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleBulkAction('suppress')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <BellOff className="h-4 w-4" />
                  {t('alertList.suppress')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleBulkAction('dismiss')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <XCircle className="h-4 w-4" />
                  {t('alertList.dismissPermanently')}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t('alertList.clearSelection')}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label={t('alertList.selectAllAlerts')}
                  ref={el => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={e => handleSelectAll(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
              </th>
              <th className="px-4 py-3">{t('alertList.device')}</th>
              {showOrgColumn && <th className="px-4 py-3">{t('common:labels.organization')}</th>}
              <th className="px-4 py-3">{t('alertList.title')}</th>
              <th className="px-4 py-3">{t('alertList.severity')}</th>
              <th className="px-4 py-3">{t('alertList.status')}</th>
              <th className="px-4 py-3">{t('alertList.triggered')}</th>
              <th className="px-4 py-3 text-right">{t('alertList.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedAlerts.length === 0 ? (
              <tr>
                <td colSpan={showOrgColumn ? 8 : 7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('alertList.noAlertsMatchYourFilters')}
                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="ml-1 text-primary hover:underline"
                    >
                      {t('alertList.clearFilters')}
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              paginatedAlerts.map(alert => {
                const isSubmitting = submittingId === alert.id;
                const correlationChildCount =
                  alert.correlationChildCount ?? Math.max((alert.correlationMemberCount ?? 0) - 1, 0);
                const hasCorrelationSummary = Boolean(alert.correlationGroupId && correlationChildCount > 0);
                return (
                  <tr
                    key={alert.id}
                    onClick={() => onSelect?.(alert)}
                    className={cn(
                      'cursor-pointer transition hover:bg-muted/40',
                      isSubmitting && 'opacity-60 pointer-events-none'
                    )}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(alert.id)}
                        aria-label={t('alertList.selectAlert', { title: alert.title })}
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
                    {showOrgColumn && (
                      <td className="max-w-[140px] px-4 py-3">
                        <span className="block truncate text-sm text-muted-foreground" title={alert.orgName ?? undefined}>
                          {alert.orgName ?? '—'}
                        </span>
                      </td>
                    )}
                    <td className="max-w-[280px] px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium" title={alert.title}>{alert.title}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-xs">
                          {alert.message}
                        </p>
                        {hasCorrelationSummary && alertCorrelationDisabled && (
                          <span
                            className="mt-1 inline-flex max-w-full cursor-not-allowed items-center gap-1 rounded-md border border-muted-foreground/30 bg-muted/40 px-1.5 py-0.5 chart-legend-xs font-medium text-muted-foreground"
                            title={t('alertList.alertCorrelationIsDisabledForThisOrganization')}
                            aria-disabled="true"
                          >
                            <GitBranch className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {t('alertList.groupedIncidentUnavailableAlertCorrelationDisabled')}
                            </span>
                          </span>
                        )}
                        {hasCorrelationSummary && !alertCorrelationDisabled && (
                          <a
                            href="/alerts/correlations"
                            onClick={e => e.stopPropagation()}
                            className="mt-1 inline-flex max-w-full items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 chart-legend-xs font-medium text-primary hover:bg-primary/10"
                            title={t('alertList.openIncidentGroup', { groupId: alert.correlationGroupId })}
                          >
                            <GitBranch className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {t('alertList.groupedIncident')} {correlationChildCount} {t('alertList.related')}
                              {alert.noiseReductionPercent != null
                                ? t('alertList.noiseCut', { percent: alert.noiseReductionPercent })
                                : ''}
                            </span>
                          </a>
                        )}
                        {alert.anomalyContext && (
                          <span
                            className="mt-1 inline-flex max-w-full items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 chart-legend-xs font-medium text-sky-700"
                            title={t('alertList.promotedMetricAnomaly')}
                          >
                            <Activity className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {t('alertList.mlAnomalySummary', {
                                metric: alert.anomalyContext.metricName ?? t('alertList.metricFallback'),
                                type: formatAnomalyType(alert.anomalyContext.anomalyType),
                                confidence: formatAnomalyConfidence(alert.anomalyContext.confidence),
                              })}
                            </span>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          severityConfig[alert.severity].bg,
                          severityConfig[alert.severity].border,
                          severityConfig[alert.severity].color
                        )}
                      >
                        {t(/* i18n-dynamic */ `alertList.severityLabel.${alert.severity}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          statusConfig[alert.status].color
                        )}
                      >
                        {t(/* i18n-dynamic */ `alertList.statusLabel.${alert.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatRelativeTime(alert.triggeredAt)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {isSubmitting ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <>
                            {alert.status === 'active' && (
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation();
                                  onAcknowledge?.(alert);
                                }}
                                title={t('alertList.markAsSeenStopsEscalationButKeeps')}
                                aria-label={t('alertList.acknowledgeAlert', { title: alert.title })}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                              >
                                <CheckCircle className="h-3.5 w-3.5" />
                                {t('alertList.ack')}
                              </button>
                            )}
                            {(alert.status === 'active' || alert.status === 'acknowledged') && (
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation();
                                  onResolve?.(alert);
                                }}
                                title={t('alertList.closeThisAlertMarksTheIssueAs')}
                                aria-label={t('alertList.resolveAlert', { title: alert.title })}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-success hover:bg-success/10"
                              >
                                <CheckCircle className="h-3.5 w-3.5" />
                                {t('alertList.resolve')}
                              </button>
                            )}
                            {alert.status !== 'suppressed' && alert.status !== 'resolved' && alert.status !== 'dismissed' && (
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation();
                                  onSuppress?.(alert);
                                }}
                                title={t('alertList.silenceThisAlertStopsNotificationsWithoutResolving')}
                                aria-label={t('alertList.suppressAlert', { title: alert.title })}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                              >
                                <BellOff className="h-3.5 w-3.5" />
                                {t('alertList.mute')}
                              </button>
                            )}
                            {alert.status !== 'dismissed' && (
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation();
                                  onDismiss?.(alert);
                                }}
                                title={t('alertList.dismissPermanentlyHidesThisAlertForGood')}
                                aria-label={t('alertList.dismissAlert', { title: alert.title })}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                {t('alertList.dismiss')}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {startIndex + 1}–{Math.min(startIndex + pageSize, filteredAlerts.length)} {t('alertList.of')}{' '}
            {filteredAlerts.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm tabular-nums">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
