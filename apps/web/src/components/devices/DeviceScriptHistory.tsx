import { useCallback, useEffect, useMemo, useState } from 'react';
import { Terminal, RefreshCw, Eye, X, ChevronDown, ChevronUp, Copy, Check, CheckCircle, XCircle, Loader2, AlertTriangle, Clock, AlertOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type ScriptExecution = {
  id?: string;
  scriptId?: string;
  scriptName?: string;
  name?: string;
  status?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  durationMs?: number;
  durationSeconds?: number;
};

type DeviceScriptHistoryProps = {
  deviceId: string;
  timezone?: string;
};

const statusStyles: Record<string, string> = {
  success: 'bg-green-500/20 text-green-700 border-green-500/40',
  completed: 'bg-green-500/20 text-green-700 border-green-500/40',
  failed: 'bg-red-500/20 text-red-700 border-red-500/40',
  running: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  queued: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  pending: 'bg-gray-500/20 text-gray-700 border-gray-500/40',
  timeout: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  cancelled: 'bg-gray-500/20 text-gray-700 border-gray-500/40'
};

const statusConfig: Record<string, { label: string; color: string; bgColor: string; icon: typeof CheckCircle }> = {
  pending: { label: 'Pending', color: 'text-gray-700', bgColor: 'bg-gray-500/10', icon: Clock },
  running: { label: 'Running', color: 'text-blue-700', bgColor: 'bg-blue-500/10', icon: Loader2 },
  completed: { label: 'Completed', color: 'text-green-700', bgColor: 'bg-green-500/10', icon: CheckCircle },
  failed: { label: 'Failed', color: 'text-red-700', bgColor: 'bg-red-500/10', icon: XCircle },
  timeout: { label: 'Timeout', color: 'text-yellow-700', bgColor: 'bg-yellow-500/10', icon: AlertTriangle },
  cancelled: { label: 'Cancelled', color: 'text-gray-700', bgColor: 'bg-gray-500/10', icon: XCircle },
};

function formatDateTime(value?: string, timezone?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

function formatDuration(ms?: number, seconds?: number) {
  const totalSeconds = seconds ?? (ms ? Math.round(ms / 1000) : undefined);
  if (!totalSeconds && totalSeconds !== 0) return 'Not reported';
  if (totalSeconds < 1) return '<1s';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}m ${remaining}s`;
}

function computeDurationSeconds(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}

function OutputSection({
  title,
  content,
  icon: Icon,
  defaultOpen = true,
  variant = 'default'
}: {
  title: string;
  content?: string;
  icon: typeof Terminal;
  defaultOpen?: boolean;
  variant?: 'default' | 'error';
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const isEmpty = !content || content.trim() === '';

  return (
    <div className={cn(
      'rounded-md border',
      variant === 'error' && content && 'border-red-500/40'
    )}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsOpen(!isOpen); } }}
        className={cn(
          'flex w-full items-center justify-between px-4 py-3 text-left transition cursor-pointer',
          isOpen ? 'border-b' : '',
          variant === 'error' && content ? 'bg-red-500/5' : 'bg-muted/20'
        )}
      >
        <div className="flex items-center gap-2">
          <Icon className={cn(
            'h-4 w-4',
            variant === 'error' && content ? 'text-red-600' : 'text-muted-foreground'
          )} />
          <span className={cn(
            'text-sm font-medium',
            variant === 'error' && content && 'text-red-700'
          )}>
            {title}
          </span>
          {isEmpty && (
            <span className="text-xs text-muted-foreground">(empty)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isEmpty && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleCopy();
              }}
              className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
              title="Copy to clipboard"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-600" />
              ) : (
                <Copy className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          )}
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>
      {isOpen && (
        <div className="p-4">
          {isEmpty ? (
            <p className="text-sm text-muted-foreground italic">No output</p>
          ) : (
            <pre className={cn(
              'max-h-80 overflow-auto rounded-md p-4 text-sm font-mono whitespace-pre-wrap break-words',
              variant === 'error' ? 'bg-red-500/5 text-red-800' : 'bg-muted/40 text-foreground'
            )}>
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function DeviceScriptHistory({ deviceId, timezone }: DeviceScriptHistoryProps) {
  const [executions, setExecutions] = useState<ScriptExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(timezone);
  const [selectedExecution, setSelectedExecution] = useState<ScriptExecution | null>(null);

  const effectiveTimezone = timezone ?? siteTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const fetchHistory = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/scripts`);
      if (!response.ok) throw new Error('Failed to fetch script history');
      const json = await response.json();
      const payload = json?.data ?? json;
      setExecutions(Array.isArray(payload) ? payload : []);
      if (json?.timezone || json?.siteTimezone) {
        setSiteTimezone(json.timezone ?? json.siteTimezone);
      }
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to fetch script history');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(() => fetchHistory(true), 10000);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  const rows = useMemo(() => {
    return executions.map((item, index) => {
      const status = (item.status || 'unknown').toLowerCase();
      const duration = computeDurationSeconds(item.startedAt ?? item.createdAt, item.completedAt);
      return {
        id: item.id ?? `${item.scriptName ?? item.name ?? 'script'}-${index}`,
        name: item.scriptName ?? item.name ?? 'Unnamed script',
        status,
        startedAt: formatDateTime(item.startedAt ?? item.createdAt, effectiveTimezone),
        completedAt: formatDateTime(item.completedAt, effectiveTimezone),
        duration: formatDuration(item.durationMs, item.durationSeconds ?? duration),
        raw: item,
      };
    });
  }, [executions, effectiveTimezone]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading script history...</p>
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
          onClick={fetchHistory}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  const selected = selectedExecution;
  const selectedStatus = (selected?.status || 'pending').toLowerCase();
  const config = statusConfig[selectedStatus] || statusConfig.pending;
  const StatusIcon = config.icon;

  return (
    <>
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Script Execution History</h3>
          </div>
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
        <div className="mt-4 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Script</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Completed</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No script executions reported.
                  </td>
                </tr>
              ) : (
                rows.map(row => (
                  <tr
                    key={row.id}
                    className="text-sm cursor-pointer hover:bg-muted/40 transition"
                    onClick={() => setSelectedExecution(row.raw)}
                  >
                    <td className="px-4 py-3 font-medium">{row.name}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyles[row.status] || 'bg-muted/40 text-muted-foreground border-muted'}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{row.startedAt}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{row.completedAt}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{row.duration}</td>
                    <td className="px-4 py-3">
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Execution Details Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-lg border bg-card shadow-lg flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">Execution Details</h2>
                <p className="text-sm text-muted-foreground">{selected.scriptName ?? selected.name ?? 'Script'}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedExecution(null)}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Status Banner */}
              <div className={cn('rounded-md p-4', config.bgColor)}>
                <div className="flex items-center gap-3">
                  <StatusIcon className={cn(
                    'h-6 w-6',
                    config.color,
                    selectedStatus === 'running' && 'animate-spin'
                  )} />
                  <div>
                    <p className={cn('text-lg font-semibold', config.color)}>
                      {config.label}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {selectedStatus === 'running'
                        ? 'Script is currently executing...'
                        : selectedStatus === 'completed'
                          ? 'Script completed successfully'
                          : selectedStatus === 'failed'
                            ? selected.errorMessage || 'Script execution failed'
                            : selectedStatus === 'timeout'
                              ? 'Script execution timed out'
                              : 'Script is waiting to be executed'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Metadata Grid */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border bg-muted/20 p-4">
                  <p className="text-xs font-medium text-muted-foreground">Started At</p>
                  <p className="text-sm font-medium mt-1">
                    {formatDateTime(selected.startedAt ?? selected.createdAt, effectiveTimezone)}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/20 p-4">
                  <p className="text-xs font-medium text-muted-foreground">Completed At</p>
                  <p className="text-sm font-medium mt-1">
                    {formatDateTime(selected.completedAt, effectiveTimezone)}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/20 p-4">
                  <p className="text-xs font-medium text-muted-foreground">Duration</p>
                  <p className="text-sm font-medium mt-1">
                    {selectedStatus === 'running' ? (
                      <span className="flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Running...
                      </span>
                    ) : (
                      formatDuration(
                        selected.durationMs,
                        selected.durationSeconds ?? computeDurationSeconds(selected.startedAt ?? selected.createdAt, selected.completedAt)
                      )
                    )}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/20 p-4">
                  <p className="text-xs font-medium text-muted-foreground">Exit Code</p>
                  <p className="text-sm font-medium mt-1">
                    {selected.exitCode !== undefined && selected.exitCode !== null ? (
                      <span className={cn(
                        'inline-flex items-center rounded px-2 py-0.5 font-mono',
                        selected.exitCode === 0
                          ? 'bg-green-500/20 text-green-700'
                          : 'bg-red-500/20 text-red-700'
                      )}>
                        {selected.exitCode}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Output Sections */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">Output</h3>
                <OutputSection
                  title="Standard Output (stdout)"
                  content={selected.stdout}
                  icon={Terminal}
                  defaultOpen={true}
                />
                <OutputSection
                  title="Standard Error (stderr)"
                  content={selected.stderr}
                  icon={AlertOctagon}
                  defaultOpen={!!selected.stderr}
                  variant="error"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end border-t px-6 py-4">
              <button
                type="button"
                onClick={() => setSelectedExecution(null)}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
