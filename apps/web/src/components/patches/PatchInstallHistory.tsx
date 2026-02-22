import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Download,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type PatchResult = {
  id?: string;
  installId?: string;
  name?: string;
  title?: string;
  kb?: string;
  status?: string;
  rebootRequired?: boolean;
  errorMessage?: string;
};

type HistoryResult = {
  installedCount?: number;
  failedCount?: number;
  scannedCount?: number;
  pendingCount?: number;
  rebootRequired?: boolean;
  results?: PatchResult[];
  errorMessage?: string;
};

type PatchHistoryEntry = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  result?: HistoryResult;
  createdBy?: string;
  createdByEmail?: string;
};

type PatchInstallHistoryProps = {
  deviceId: string;
};

const PAGE_SIZE = 15;
const POLL_INTERVAL_MS = 30000;

const typeConfig: Record<string, { label: string; icon: typeof Download }> = {
  install_patches: { label: 'Install', icon: Download },
  install: { label: 'Install', icon: Download },
  patch_scan: { label: 'Scan', icon: Search },
  scan_patches: { label: 'Scan', icon: Search },
  scan: { label: 'Scan', icon: Search },
  rollback_patches: { label: 'Rollback', icon: RotateCcw },
  rollback: { label: 'Rollback', icon: RotateCcw },
  download_patches: { label: 'Download', icon: Download },
};

const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  completed: {
    label: 'Completed',
    color: 'bg-green-500/20 text-green-700 border-green-500/40',
    icon: CheckCircle,
  },
  failed: {
    label: 'Failed',
    color: 'bg-red-500/20 text-red-700 border-red-500/40',
    icon: XCircle,
  },
  pending: {
    label: 'Pending',
    color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
    icon: Clock,
  },
  running: {
    label: 'Running',
    color: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
    icon: Loader2,
  },
  timeout: {
    label: 'Timeout',
    color: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
    icon: AlertTriangle,
  },
};

function getTypeConfig(type: string) {
  const normalized = type.toLowerCase();
  return typeConfig[normalized] ?? { label: type, icon: Download };
}

function getStatusConfig(status: string) {
  const normalized = status.toLowerCase();
  return statusConfig[normalized] ?? statusConfig.pending;
}

function formatDuration(createdAt?: string, completedAt?: string): string {
  if (!createdAt || !completedAt) return '--';
  const start = new Date(createdAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return '--';
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  if (totalSeconds < 1) return '<1s';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}m ${remaining}s`;
}

function formatRelativeTime(dateString?: string): string {
  if (!dateString) return '--';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAbsoluteDate(dateString?: string): string {
  if (!dateString) return '--';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getPatchCount(entry: PatchHistoryEntry): string {
  const result = entry.result;
  if (!result) return '--';

  const installed = result.installedCount ?? 0;
  const failed = result.failedCount ?? 0;
  const total = installed + failed;

  if (result.results && result.results.length > 0) {
    return String(result.results.length);
  }

  if (total > 0) return String(total);
  if (result.scannedCount != null) return String(result.scannedCount);
  if (result.pendingCount != null) return String(result.pendingCount);

  return '--';
}

function getPatchResultName(patch: PatchResult): string {
  if (patch.name || patch.title) return patch.name || patch.title || '';
  if (patch.kb) return patch.kb.toUpperCase().startsWith('KB') ? patch.kb : `KB${patch.kb}`;
  if (patch.installId) return patch.installId;
  return 'Unknown patch';
}

function getPatchResultKb(patch: PatchResult): string | null {
  const kb = (patch.kb || '').trim();
  if (!kb) {
    const name = patch.name || patch.title || '';
    const match = name.match(/kb\d{4,8}/i);
    return match ? match[0].toUpperCase() : null;
  }
  return kb.toUpperCase().startsWith('KB') ? kb.toUpperCase() : `KB${kb}`;
}

export default function PatchInstallHistory({ deviceId }: PatchInstallHistoryProps) {
  const [history, setHistory] = useState<PatchHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const hasInProgress = useMemo(
    () => history.some(h => h.status === 'pending' || h.status === 'running'),
    [history]
  );

  const fetchHistory = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(undefined);
      try {
        const offset = (currentPage - 1) * PAGE_SIZE;
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        if (typeFilter !== 'all') params.set('type', typeFilter);
        if (statusFilter !== 'all') params.set('status', statusFilter);

        const response = await fetchWithAuth(
          `/devices/${deviceId}/patches/history?${params.toString()}`
        );
        if (!response.ok) {
          if (response.status === 401) {
            window.location.href = '/login';
            return;
          }
          throw new Error('Failed to fetch patch history');
        }
        const json = await response.json();
        const data = json?.data ?? json;
        const entries: PatchHistoryEntry[] = Array.isArray(data?.history ?? data)
          ? (data?.history ?? data)
          : [];
        setHistory(entries);
        setTotal(typeof data?.total === 'number' ? data.total : entries.length);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : 'Failed to fetch patch history');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [deviceId, currentPage, typeFilter, statusFilter]
  );

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Auto-refresh polling when in-progress operations exist
  useEffect(() => {
    if (!hasInProgress) return;
    const interval = setInterval(() => fetchHistory(true), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasInProgress, fetchHistory]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading patch history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => {
            void fetchHistory();
          }}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold">Patch Operation History</h3>
            <p className="text-sm text-muted-foreground">
              {total} operation{total !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <select
            value={typeFilter}
            onChange={e => {
              setTypeFilter(e.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Types</option>
            <option value="install">Install</option>
            <option value="scan">Scan</option>
            <option value="rollback">Rollback</option>
          </select>
          <select
            value={statusFilter}
            onChange={e => {
              setStatusFilter(e.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Status</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
            <option value="timeout">Timeout</option>
          </select>
          <button
            type="button"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              await fetchHistory(true);
              setRefreshing(false);
            }}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Operation</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Patches</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3 w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {history.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <History className="h-8 w-8 text-muted-foreground/50" />
                    <p>No patch operations found.</p>
                    {(typeFilter !== 'all' || statusFilter !== 'all') && (
                      <button
                        type="button"
                        onClick={() => {
                          setTypeFilter('all');
                          setStatusFilter('all');
                          setCurrentPage(1);
                        }}
                        className="text-primary hover:underline"
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              history.map(entry => {
                const typeConf = getTypeConfig(entry.type);
                const TypeIcon = typeConf.icon;
                const statusConf = getStatusConfig(entry.status);
                const StatusIcon = statusConf.icon;
                const isExpanded = expandedId === entry.id;

                return (
                  <HistoryRow
                    key={entry.id}
                    entry={entry}
                    typeConf={typeConf}
                    TypeIcon={TypeIcon}
                    statusConf={statusConf}
                    StatusIcon={StatusIcon}
                    isExpanded={isExpanded}
                    onToggle={() => setExpandedId(isExpanded ? null : entry.id)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {(currentPage - 1) * PAGE_SIZE + 1} to{' '}
            {Math.min(currentPage * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  typeConf,
  TypeIcon,
  statusConf,
  StatusIcon,
  isExpanded,
  onToggle,
}: {
  entry: PatchHistoryEntry;
  typeConf: { label: string; icon: typeof Download };
  TypeIcon: typeof Download;
  statusConf: { label: string; color: string; icon: typeof CheckCircle };
  StatusIcon: typeof CheckCircle;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const patchCount = getPatchCount(entry);
  const duration = formatDuration(entry.createdAt, entry.completedAt);
  const relDate = formatRelativeTime(entry.createdAt);
  const absDate = formatAbsoluteDate(entry.createdAt);
  const isRunning = entry.status === 'running' || entry.status === 'pending';

  return (
    <>
      <tr
        className="text-sm cursor-pointer hover:bg-muted/40 transition"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{typeConf.label}</span>
          </div>
          {entry.createdByEmail && (
            <p className="text-xs text-muted-foreground mt-0.5">{entry.createdByEmail}</p>
          )}
        </td>
        <td className="px-4 py-3">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
              statusConf.color
            )}
          >
            <StatusIcon
              className={cn('h-3.5 w-3.5', isRunning && 'animate-spin')}
            />
            {statusConf.label}
          </span>
        </td>
        <td className="px-4 py-3 text-muted-foreground">{patchCount}</td>
        <td className="px-4 py-3 text-xs text-muted-foreground">
          {isRunning ? (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Running...
            </span>
          ) : (
            duration
          )}
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground" title={absDate}>
          {relDate}
        </td>
        <td className="px-4 py-3">
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={6} className="px-0 py-0">
            <HistoryDetail entry={entry} />
          </td>
        </tr>
      )}
    </>
  );
}

function HistoryDetail({ entry }: { entry: PatchHistoryEntry }) {
  const result = entry.result;
  const type = entry.type.toLowerCase();
  const isScan = type.includes('scan');

  return (
    <div className="border-t bg-muted/10 px-6 py-4 space-y-4">
      {/* Summary stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {result?.installedCount != null && (
          <div className="rounded-md border bg-card p-3">
            <p className="text-xs font-medium text-muted-foreground">Installed</p>
            <p className="text-lg font-semibold text-green-700">{result.installedCount}</p>
          </div>
        )}
        {result?.failedCount != null && (
          <div className="rounded-md border bg-card p-3">
            <p className="text-xs font-medium text-muted-foreground">Failed</p>
            <p className="text-lg font-semibold text-red-700">{result.failedCount}</p>
          </div>
        )}
        {isScan && result?.pendingCount != null && (
          <div className="rounded-md border bg-card p-3">
            <p className="text-xs font-medium text-muted-foreground">Pending</p>
            <p className="text-lg font-semibold text-yellow-700">{result.pendingCount}</p>
          </div>
        )}
        {isScan && result?.scannedCount != null && (
          <div className="rounded-md border bg-card p-3">
            <p className="text-xs font-medium text-muted-foreground">Scanned</p>
            <p className="text-lg font-semibold">{result.scannedCount}</p>
          </div>
        )}
        {result?.rebootRequired && (
          <div className="rounded-md border border-yellow-400/50 bg-yellow-500/10 p-3">
            <p className="text-xs font-medium text-yellow-700">Reboot Required</p>
            <p className="text-sm font-medium text-yellow-800">Yes</p>
          </div>
        )}
        <div className="rounded-md border bg-card p-3">
          <p className="text-xs font-medium text-muted-foreground">Started</p>
          <p className="text-sm font-medium">{formatAbsoluteDate(entry.createdAt)}</p>
        </div>
        {entry.completedAt && (
          <div className="rounded-md border bg-card p-3">
            <p className="text-xs font-medium text-muted-foreground">Completed</p>
            <p className="text-sm font-medium">{formatAbsoluteDate(entry.completedAt)}</p>
          </div>
        )}
      </div>

      {/* Error message */}
      {(entry.status === 'failed' || entry.status === 'timeout') && result?.errorMessage && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-4">
          <p className="text-xs font-semibold text-red-700 mb-1">Error</p>
          <p className="text-sm text-red-800 whitespace-pre-wrap">{result.errorMessage}</p>
        </div>
      )}

      {/* Individual patch results */}
      {result?.results && result.results.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Patch Results</h4>
          <div className="overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2">Patch</th>
                    <th className="px-4 py-2">KB</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {result.results.map((patch, index) => {
                    const patchStatus = (patch.status || 'unknown').toLowerCase();
                    const isInstalled = patchStatus === 'installed' || patchStatus === 'success' || patchStatus === 'completed';
                    const isFailed = patchStatus === 'failed' || patchStatus === 'error';
                    const kb = getPatchResultKb(patch);

                    return (
                      <tr key={patch.id ?? patch.installId ?? index} className="text-sm">
                        <td className="px-4 py-2 font-medium">{getPatchResultName(patch)}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {kb ? (
                            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                              {kb}
                            </span>
                          ) : (
                            '--'
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {isInstalled ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 border border-green-500/40 px-2 py-0.5 text-xs font-medium text-green-700">
                              <CheckCircle className="h-3 w-3" />
                              Installed
                            </span>
                          ) : isFailed ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-700">
                              <XCircle className="h-3 w-3" />
                              Failed
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-muted/40 border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              {patch.status || 'Unknown'}
                            </span>
                          )}
                          {patch.rebootRequired && (
                            <span className="ml-1.5 inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200">
                              Reboot
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground max-w-xs">
                          {patch.errorMessage ? (
                            <span className="text-red-600 truncate block" title={patch.errorMessage}>
                              {patch.errorMessage}
                            </span>
                          ) : (
                            '--'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* No detailed results */}
      {(!result?.results || result.results.length === 0) && !result?.errorMessage && (
        <p className="text-sm text-muted-foreground italic">No detailed patch results available.</p>
      )}
    </div>
  );
}
