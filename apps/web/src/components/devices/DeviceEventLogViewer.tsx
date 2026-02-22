import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Filter,
  HardDrive,
  Monitor,
  Package,
  Plug,
  Search,
  Shield,
  Terminal,
  User,
  Wifi,
  XCircle,
  Wrench,
  Activity,
  Bot,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type ActivityEntry = {
  id: string;
  timestamp: string;
  action: string;
  message: string;
  category: string;
  result: string;
  actor: {
    type: string;
    name: string;
    email: string | null;
  };
  resource: {
    type: string;
    id: string | null;
    name: string | null;
  };
  initiatedBy: string | null;
  details: Record<string, unknown> | null;
  errorMessage: string | null;
  ipAddress: string | null;
};

type DeviceEventLogViewerProps = {
  deviceId: string;
  timezone?: string;
};

const categoryConfig: Record<string, { label: string; icon: typeof Monitor; color: string }> = {
  device: { label: 'Device', icon: Monitor, color: 'border-blue-500/30 bg-blue-500/10 text-blue-600' },
  agent: { label: 'Agent', icon: Wifi, color: 'border-teal-500/30 bg-teal-500/10 text-teal-600' },
  script: { label: 'Script', icon: Terminal, color: 'border-violet-500/30 bg-violet-500/10 text-violet-600' },
  patch: { label: 'Patch', icon: Package, color: 'border-amber-500/30 bg-amber-500/10 text-amber-600' },
  alert: { label: 'Alert', icon: AlertTriangle, color: 'border-red-500/30 bg-red-500/10 text-red-600' },
  policy: { label: 'Policy', icon: Shield, color: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600' },
  deployment: { label: 'Deployment', icon: Package, color: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600' },
  software: { label: 'Software', icon: Package, color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' },
  backup: { label: 'Backup', icon: HardDrive, color: 'border-slate-500/30 bg-slate-500/10 text-slate-600' },
  discovery: { label: 'Discovery', icon: Wifi, color: 'border-sky-500/30 bg-sky-500/10 text-sky-600' },
  automation: { label: 'Automation', icon: Activity, color: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-600' },
  maintenance: { label: 'Maintenance', icon: Wrench, color: 'border-orange-500/30 bg-orange-500/10 text-orange-600' },
  monitoring: { label: 'Monitoring', icon: Activity, color: 'border-lime-500/30 bg-lime-500/10 text-lime-600' },
  ai: { label: 'AI', icon: Bot, color: 'border-purple-500/30 bg-purple-500/10 text-purple-600' },
  system: { label: 'System', icon: Monitor, color: 'border-gray-500/30 bg-gray-500/10 text-gray-600' },
};

const resultConfig: Record<string, { label: string; dot: string }> = {
  success: { label: 'Success', dot: 'bg-green-500' },
  failure: { label: 'Failed', dot: 'bg-red-500' },
  denied: { label: 'Denied', dot: 'bg-yellow-500' },
};

const initiatedByConfig: Record<string, { label: string; icon: typeof User; color: string }> = {
  manual: { label: 'Manual', icon: User, color: 'border-gray-400/30 bg-gray-400/10 text-gray-500' },
  ai: { label: 'AI', icon: Bot, color: 'border-purple-500/30 bg-purple-500/10 text-purple-600' },
  automation: { label: 'Automation', icon: Activity, color: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-600' },
  policy: { label: 'Policy', icon: Shield, color: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600' },
  schedule: { label: 'Schedule', icon: Clock, color: 'border-orange-500/30 bg-orange-500/10 text-orange-600' },
  agent: { label: 'Agent', icon: Wifi, color: 'border-teal-500/30 bg-teal-500/10 text-teal-600' },
  integration: { label: 'Integration', icon: Plug, color: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600' },
};

const INITIATED_BY_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'manual', label: 'Manual' },
  { value: 'ai', label: 'AI' },
  { value: 'automation', label: 'Automation' },
  { value: 'policy', label: 'Policy' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'agent', label: 'Agent' },
  { value: 'integration', label: 'Integration' },
];

function formatDateTime(value?: string | null, timezone?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    ...(timezone ? { timeZone: timezone } : {}),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatRelativeTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return '';
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'All categories' },
  { value: 'device', label: 'Device' },
  { value: 'agent', label: 'Agent' },
  { value: 'script', label: 'Script' },
  { value: 'patch', label: 'Patch' },
  { value: 'alert', label: 'Alert' },
  { value: 'config_policy', label: 'Policy' },
  { value: 'deployment', label: 'Deployment' },
  { value: 'software', label: 'Software' },
  { value: 'backup', label: 'Backup' },
  { value: 'discovery', label: 'Discovery' },
  { value: 'automation', label: 'Automation' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'monitor', label: 'Monitoring' },
  { value: 'ai', label: 'AI' },
];

export default function DeviceEventLogViewer({ deviceId, timezone }: DeviceEventLogViewerProps) {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(timezone);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [initiatedByFilter, setInitiatedByFilter] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0 });

  const effectiveTimezone = timezone ?? siteTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [categoryFilter, initiatedByFilter, resultFilter, debouncedSearch]);

  const fetchActivities = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '50');
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (categoryFilter) params.set('category', categoryFilter);
      if (initiatedByFilter) params.set('initiatedBy', initiatedByFilter);
      if (resultFilter) params.set('result', resultFilter);

      const response = await fetchWithAuth(`/devices/${deviceId}/events?${params}`);
      if (!response.ok) throw new Error('Failed to fetch activities');
      const json = await response.json();
      setActivities(json?.data ?? []);
      if (json?.pagination) setPagination(json.pagination);
      if (json?.timezone || json?.siteTimezone) {
        setSiteTimezone(json.timezone ?? json.siteTimezone);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch activities');
    } finally {
      setLoading(false);
    }
  }, [deviceId, debouncedSearch, categoryFilter, initiatedByFilter, resultFilter, page]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchActivities}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3">
          {/* Title */}
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Activities</h3>
            {!loading && (
              <span className="ml-1 text-sm text-muted-foreground">
                ({pagination.total.toLocaleString()} total)
              </span>
            )}
          </div>

          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/* Search */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search activities..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 w-full rounded-md border bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Category filter */}
            <div className="flex items-center gap-1">
              <Filter className="h-3 w-3 text-muted-foreground" />
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Initiated by filter */}
            <select
              value={initiatedByFilter}
              onChange={(e) => setInitiatedByFilter(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {INITIATED_BY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {/* Result filter */}
            <div className="flex items-center rounded-md border bg-background">
              {[
                { value: '', label: 'All' },
                { value: 'success', label: 'Success' },
                { value: 'failure', label: 'Failed' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setResultFilter(opt.value)}
                  className={`px-2.5 py-1 text-xs font-medium transition first:rounded-l-md last:rounded-r-md ${
                    resultFilter === opt.value
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Activity list */}
      <div className="rounded-lg border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="mt-3 text-sm text-muted-foreground">Loading activities...</p>
            </div>
          </div>
        ) : activities.length === 0 ? (
          <div className="py-12 text-center">
            <FileText className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">No activities match the current filters.</p>
          </div>
        ) : (
          <div className="divide-y">
            {activities.map((activity) => {
              const isExpanded = expandedId === activity.id;
              const relTime = formatRelativeTime(activity.timestamp);
              const rc = resultConfig[activity.result] ?? resultConfig.success;
              const cc = categoryConfig[activity.category] ?? categoryConfig.system;
              const CatIcon = cc.icon;

              return (
                <div key={activity.id} className="group">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : activity.id)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-muted/50"
                  >
                    {/* Result dot */}
                    <div className="mt-1.5">
                      <span className={`inline-block h-2 w-2 rounded-full ${rc.dot}`} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium leading-snug">{activity.message}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatDateTime(activity.timestamp, effectiveTimezone) ?? 'Unknown'}
                              {relTime && <span className="text-muted-foreground/60">({relTime})</span>}
                            </span>

                            <span className="flex items-center gap-1">
                              <User className="h-3 w-3" />
                              {activity.actor.name}
                            </span>

                            {activity.result === 'failure' && activity.errorMessage && (
                              <span className="flex items-center gap-1 text-red-600">
                                <XCircle className="h-3 w-3" />
                                {activity.errorMessage.length > 60
                                  ? `${activity.errorMessage.slice(0, 60)}...`
                                  : activity.errorMessage}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Badges */}
                        <div className="flex shrink-0 items-center gap-2">
                          {/* Initiated by badge */}
                          {activity.initiatedBy && initiatedByConfig[activity.initiatedBy] && (() => {
                            const ib = initiatedByConfig[activity.initiatedBy!];
                            const IbIcon = ib.icon;
                            return (
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${ib.color}`}>
                                <IbIcon className="h-2.5 w-2.5" />
                                {ib.label}
                              </span>
                            );
                          })()}

                          {/* Category badge */}
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${cc.color}`}>
                            <CatIcon className="h-2.5 w-2.5" />
                            {cc.label}
                          </span>

                          {/* Result badge */}
                          {activity.result !== 'success' && (
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                              activity.result === 'failure'
                                ? 'border-red-500/30 bg-red-500/10 text-red-600'
                                : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600'
                            }`}>
                              {rc.label}
                            </span>
                          )}

                          <ChevronDown
                            className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          />
                        </div>
                      </div>
                    </div>
                  </button>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="border-t bg-muted/30 px-4 py-3">
                      <div className="ml-5 space-y-3">
                        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
                          <div>
                            <span className="font-medium text-muted-foreground">Action</span>
                            <p className="mt-0.5 font-mono text-[11px]">{activity.action}</p>
                          </div>
                          <div>
                            <span className="font-medium text-muted-foreground">Result</span>
                            <p className="mt-0.5 flex items-center gap-1.5">
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${rc.dot}`} />
                              <span className="capitalize">{activity.result}</span>
                            </p>
                          </div>
                          <div>
                            <span className="font-medium text-muted-foreground">Actor</span>
                            <p className="mt-0.5">
                              {activity.actor.name}
                              <span className="ml-1 text-muted-foreground">({activity.actor.type})</span>
                            </p>
                          </div>
                          {activity.actor.email && (
                            <div>
                              <span className="font-medium text-muted-foreground">Email</span>
                              <p className="mt-0.5">{activity.actor.email}</p>
                            </div>
                          )}
                          <div>
                            <span className="font-medium text-muted-foreground">Timestamp</span>
                            <p className="mt-0.5">{formatDateTime(activity.timestamp, effectiveTimezone)}</p>
                          </div>
                          {activity.resource.type && (
                            <div>
                              <span className="font-medium text-muted-foreground">Resource Type</span>
                              <p className="mt-0.5">{activity.resource.type}</p>
                            </div>
                          )}
                          {activity.resource.name && (
                            <div>
                              <span className="font-medium text-muted-foreground">Resource</span>
                              <p className="mt-0.5">{activity.resource.name}</p>
                            </div>
                          )}
                          {activity.ipAddress && (
                            <div>
                              <span className="font-medium text-muted-foreground">IP Address</span>
                              <p className="mt-0.5 font-mono text-[11px]">{activity.ipAddress}</p>
                            </div>
                          )}
                          <div>
                            <span className="font-medium text-muted-foreground">ID</span>
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{activity.id}</p>
                          </div>
                        </div>

                        {activity.errorMessage && (
                          <div>
                            <span className="text-xs font-medium text-red-600">Error</span>
                            <p className="mt-1 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
                              {activity.errorMessage}
                            </p>
                          </div>
                        )}

                        {activity.details && Object.keys(activity.details).length > 0 && (
                          <div>
                            <span className="text-xs font-medium text-muted-foreground">Details</span>
                            <pre className="mt-1 max-h-48 overflow-auto rounded-md border bg-background p-3 text-[11px] leading-relaxed font-mono">
                              {JSON.stringify(activity.details, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {!loading && pagination.total > pagination.limit && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Showing {((page - 1) * pagination.limit) + 1}–{Math.min(page * pagination.limit, pagination.total)} of{' '}
              {pagination.total.toLocaleString()}
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-2 text-xs text-muted-foreground">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
