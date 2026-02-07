import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Filter,
  Info,
  ScrollText,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type LogLevel = 'info' | 'warning' | 'error' | 'critical';
type LogCategory = 'security' | 'hardware' | 'application' | 'system';

type DeviceLog = {
  id: string;
  deviceId: string;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  source: string;
  eventId: string | null;
  message: string;
  details: Record<string, unknown> | null;
  createdAt: string;
};

type DeviceLogsTabProps = {
  deviceId: string;
  timezone?: string;
};

const levelConfig: Record<LogLevel, { label: string; icon: typeof Info; badge: string }> = {
  critical: {
    label: 'Critical',
    icon: ShieldAlert,
    badge: 'bg-red-600/20 text-red-800 border-red-600/40',
  },
  error: {
    label: 'Error',
    icon: XCircle,
    badge: 'bg-red-500/20 text-red-700 border-red-500/40',
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    badge: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  },
  info: {
    label: 'Info',
    icon: Info,
    badge: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  },
};

const categoryConfig: Record<LogCategory, { label: string; color: string }> = {
  security: { label: 'Security', color: 'bg-purple-500/20 text-purple-700 border-purple-500/40' },
  hardware: { label: 'Hardware', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  application: { label: 'Application', color: 'bg-cyan-500/20 text-cyan-700 border-cyan-500/40' },
  system: { label: 'System', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' },
};

function formatDateTime(value: string, timezone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

const PAGE_SIZE = 50;

export default function DeviceLogsTab({ deviceId, timezone }: DeviceLogsTabProps) {
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [levelFilter, setLevelFilter] = useState<LogLevel | ''>('');
  const [categoryFilter, setCategoryFilter] = useState<LogCategory | ''>('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const effectiveTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(PAGE_SIZE));
      if (levelFilter) params.set('level', levelFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);

      const response = await fetchWithAuth(`/devices/${deviceId}/eventlogs?${params}`);
      if (!response.ok) {
        let detail = `Failed to fetch device logs (HTTP ${response.status})`;
        try {
          const body = await response.json();
          if (body.error) detail = body.error;
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
        throw new Error(detail);
      }
      const json = await response.json();
      setLogs(json.data ?? []);
      setTotal(json.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch device logs');
    } finally {
      setLoading(false);
    }
  }, [deviceId, page, levelFilter, categoryFilter, sourceFilter, startDate, endDate]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const clearFilters = () => {
    setLevelFilter('');
    setCategoryFilter('');
    setSourceFilter('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  const hasFilters = levelFilter || categoryFilter || sourceFilter || startDate || endDate;

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchLogs}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Filters</span>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Level</label>
            <select
              value={levelFilter}
              onChange={(e) => { setLevelFilter(e.target.value as LogLevel | ''); setPage(1); }}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="">All levels</option>
              {(Object.keys(levelConfig) as LogLevel[]).map((l) => (
                <option key={l} value={l}>{levelConfig[l].label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Category</label>
            <select
              value={categoryFilter}
              onChange={(e) => { setCategoryFilter(e.target.value as LogCategory | ''); setPage(1); }}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="">All categories</option>
              {(Object.keys(categoryConfig) as LogCategory[]).map((c) => (
                <option key={c} value={c}>{categoryConfig[c].label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Source</label>
            <input
              type="text"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setPage(1); }}
              onBlur={() => setPage(1)}
              placeholder="e.g. Windows Event Log"
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Start Date</label>
            <input
              type="datetime-local"
              value={startDate}
              onChange={(e) => { setStartDate(e.target.value); setPage(1); }}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">End Date</label>
            <input
              type="datetime-local"
              value={endDate}
              onChange={(e) => { setEndDate(e.target.value); setPage(1); }}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Results header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Device Logs</h3>
          <span className="text-sm text-muted-foreground">
            {loading ? '...' : `${total} log${total !== 1 ? 's' : ''}`}
          </span>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm text-muted-foreground">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-md border p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Log entries */}
      {loading ? (
        <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="mt-3 text-sm text-muted-foreground">Loading device logs...</p>
          </div>
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border bg-card py-12 text-center shadow-sm">
          <ScrollText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            {hasFilters ? 'No logs match the selected filters.' : 'No device logs recorded yet.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card shadow-sm divide-y">
          {logs.map((log) => {
            const lc = levelConfig[log.level] ?? levelConfig.info;
            const cc = categoryConfig[log.category] ?? categoryConfig.system;
            const Icon = lc.icon;
            const isExpanded = expandedId === log.id;

            return (
              <button
                key={log.id}
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : log.id)}
                className="w-full text-left px-4 py-3 hover:bg-muted/50 transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{log.message}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {log.source}
                        {log.eventId ? ` (${log.eventId})` : ''}
                        {' \u2022 '}
                        {formatDateTime(log.timestamp, effectiveTimezone)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cc.color}`}>
                      {cc.label}
                    </span>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${lc.badge}`}>
                      {lc.label}
                    </span>
                  </div>
                </div>
                {isExpanded && log.details && (
                  <div className="mt-3 ml-7 rounded-md bg-muted/60 p-3">
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all">
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
