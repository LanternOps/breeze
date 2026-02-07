import { useState, useMemo } from 'react';
import {
  X,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
  Monitor,
  Terminal,
  Calendar,
  Timer
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type DeviceRunResult = {
  deviceId: string;
  deviceName: string;
  status: 'success' | 'failed' | 'skipped' | 'running';
  startedAt: string;
  completedAt?: string;
  duration?: number;
  output?: string;
  error?: string;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  automationName: string;
  triggeredBy: 'schedule' | 'event' | 'webhook' | 'manual' | 'api';
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'failed' | 'partial';
  devicesTotal: number;
  devicesSuccess: number;
  devicesFailed: number;
  devicesSkipped: number;
  deviceResults: DeviceRunResult[];
  logs?: string[];
};

type AutomationRunHistoryProps = {
  runs: AutomationRun[];
  isOpen: boolean;
  onClose: () => void;
  automationName?: string;
  timezone?: string;
};

type StatusKey = 'running' | 'success' | 'failed' | 'partial' | 'skipped';
const statusConfig: Record<StatusKey, { label: string; color: string; bgColor: string; icon: typeof CheckCircle }> = {
  running: {
    label: 'Running',
    color: 'text-blue-600',
    bgColor: 'bg-blue-500/20 border-blue-500/40',
    icon: Clock
  },
  success: {
    label: 'Success',
    color: 'text-green-600',
    bgColor: 'bg-green-500/20 border-green-500/40',
    icon: CheckCircle
  },
  failed: {
    label: 'Failed',
    color: 'text-red-600',
    bgColor: 'bg-red-500/20 border-red-500/40',
    icon: XCircle
  },
  partial: {
    label: 'Partial',
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-500/20 border-yellow-500/40',
    icon: AlertTriangle
  },
  skipped: {
    label: 'Skipped',
    color: 'text-gray-600',
    bgColor: 'bg-gray-500/20 border-gray-500/40',
    icon: Clock
  }
};

const triggerLabels: Record<string, string> = {
  schedule: 'Scheduled',
  event: 'Event Triggered',
  webhook: 'Webhook',
  manual: 'Manual',
  api: 'API Call'
};

function formatDate(dateString: string, timezone: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString([], { timeZone: timezone });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatRelativeTime(dateString: string, timezone: string): string {
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

function RunItem({ run, timezone }: { run: AutomationRun; timezone: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const StatusIcon = statusConfig[run.status].icon;
  const duration = run.completedAt
    ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
    : null;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/40"
      >
        <div className="flex items-center gap-3">
          <StatusIcon className={cn('h-5 w-5', statusConfig[run.status].color)} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{formatRelativeTime(run.startedAt, timezone)}</span>
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                  statusConfig[run.status].bgColor,
                  statusConfig[run.status].color
                )}
              >
                {statusConfig[run.status].label}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {triggerLabels[run.triggeredBy]} - {run.devicesTotal} devices
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-green-600">{run.devicesSuccess} passed</span>
              {run.devicesFailed > 0 && (
                <span className="text-red-600">{run.devicesFailed} failed</span>
              )}
              {run.devicesSkipped > 0 && (
                <span className="text-gray-500">{run.devicesSkipped} skipped</span>
              )}
            </div>
            {duration && (
              <p className="text-muted-foreground">Duration: {formatDuration(duration)}</p>
            )}
          </div>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-muted/20 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h4 className="text-sm font-medium">Device Results</h4>
            {run.logs && run.logs.length > 0 && (
              <button
                type="button"
                onClick={() => setShowLogs(!showLogs)}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Terminal className="h-3 w-3" />
                {showLogs ? 'Hide Logs' : 'View Logs'}
              </button>
            )}
          </div>

          {showLogs && run.logs && run.logs.length > 0 && (
            <div className="mb-4 rounded-md bg-gray-900 p-3 text-xs font-mono text-gray-100 overflow-x-auto max-h-48 overflow-y-auto">
              {run.logs.map((log, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  {log}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {run.deviceResults.map(result => {
              const DeviceStatusIcon = statusConfig[result.status].icon;
              return (
                <div
                  key={result.deviceId}
                  className="flex items-center justify-between rounded-md border bg-background p-3"
                >
                  <div className="flex items-center gap-3">
                    <Monitor className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{result.deviceName}</p>
                      {result.error && (
                        <p className="text-xs text-red-600">{result.error}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {result.duration && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Timer className="h-3 w-3" />
                        {formatDuration(result.duration)}
                      </span>
                    )}
                    <DeviceStatusIcon
                      className={cn('h-4 w-4', statusConfig[result.status].color)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              Started: {formatDate(run.startedAt, timezone)}
            </div>
            {run.completedAt && (
              <div className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Completed: {formatDate(run.completedAt, timezone)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AutomationRunHistory({
  runs,
  isOpen,
  onClose,
  automationName,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
}: AutomationRunHistoryProps) {
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filteredRuns = useMemo(() => {
    if (statusFilter === 'all') return runs;
    return runs.filter(run => run.status === statusFilter);
  }, [runs, statusFilter]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-lg border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Run History</h2>
            {automationName && (
              <p className="text-sm text-muted-foreground">{automationName}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {filteredRuns.length} of {runs.length} runs
            </p>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Status</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="partial">Partial</option>
              <option value="running">Running</option>
            </select>
          </div>

          {filteredRuns.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center">
              <Clock className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                No run history available.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredRuns.map(run => (
                <RunItem key={run.id} run={run} timezone={timezone} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
