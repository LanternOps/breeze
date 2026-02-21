import { useCallback, useEffect, useState } from 'react';
import {
  PlayCircle,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Undo2,
  Ban,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type PlaybookStepResult = {
  stepIndex: number;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  toolUsed?: string;
  toolOutput?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

type PlaybookExecution = {
  execution: {
    id: string;
    status: string;
    currentStepIndex: number;
    steps: PlaybookStepResult[];
    errorMessage?: string;
    rollbackExecuted: boolean;
    triggeredBy: string;
    startedAt?: string;
    completedAt?: string;
    createdAt: string;
  };
  playbook: {
    id: string;
    name: string;
    category: string;
  } | null;
  device: {
    id: string;
    hostname: string;
  } | null;
};

type DevicePlaybookHistoryProps = {
  deviceId: string;
  timezone?: string;
};

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle; color: string }> = {
  pending: { label: 'Pending', icon: Clock, color: 'text-gray-600' },
  running: { label: 'Running', icon: Loader2, color: 'text-blue-600' },
  waiting: { label: 'Waiting', icon: Clock, color: 'text-yellow-600' },
  completed: { label: 'Completed', icon: CheckCircle, color: 'text-green-600' },
  failed: { label: 'Failed', icon: XCircle, color: 'text-red-600' },
  rolled_back: { label: 'Rolled Back', icon: Undo2, color: 'text-orange-600' },
  cancelled: { label: 'Cancelled', icon: Ban, color: 'text-gray-500' },
};

const stepStatusConfig: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'Pending', color: 'text-gray-600', bg: 'bg-gray-100' },
  running: { label: 'Running', color: 'text-blue-600', bg: 'bg-blue-50' },
  completed: { label: 'Done', color: 'text-green-600', bg: 'bg-green-50' },
  failed: { label: 'Failed', color: 'text-red-600', bg: 'bg-red-50' },
  skipped: { label: 'Skipped', color: 'text-gray-400', bg: 'bg-gray-50' },
};

const categoryStyles: Record<string, string> = {
  disk: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  service: 'bg-purple-500/15 text-purple-700 border-purple-500/30',
  memory: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  patch: 'bg-green-500/15 text-green-700 border-green-500/30',
  security: 'bg-red-500/15 text-red-700 border-red-500/30',
};

function formatDateTime(value?: string, timezone?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

function formatDurationMs(ms?: number) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function computeDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt || !completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  return formatDurationMs(ms);
}

function ExecutionRow({
  exec,
  timezone,
}: {
  exec: PlaybookExecution;
  timezone?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { execution, playbook } = exec;
  const config = statusConfig[execution.status] ?? statusConfig.pending;
  const StatusIcon = config.icon;
  const catStyle = categoryStyles[playbook?.category ?? ''] ?? 'bg-gray-100 text-gray-600 border-gray-300';

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/50 transition"
      >
        <StatusIcon
          className={`h-5 w-5 shrink-0 ${config.color} ${execution.status === 'running' ? 'animate-spin' : ''}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{playbook?.name ?? 'Unknown Playbook'}</span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catStyle}`}>
              {playbook?.category ?? '—'}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{formatDateTime(execution.createdAt, timezone)}</span>
            <span>Duration: {computeDuration(execution.startedAt, execution.completedAt)}</span>
            <span>Triggered by: {execution.triggeredBy}</span>
          </div>
        </div>
        <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3">
          {execution.errorMessage && (
            <div className="flex items-start gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{execution.errorMessage}</span>
            </div>
          )}

          {execution.rollbackExecuted && (
            <div className="flex items-center gap-2 rounded-md bg-orange-50 border border-orange-200 p-2 text-sm text-orange-700">
              <Undo2 className="h-4 w-4 shrink-0" />
              Rollback was executed
            </div>
          )}

          {execution.steps.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground mb-2">Steps</p>
              {execution.steps.map((step) => {
                const sc = stepStatusConfig[step.status] ?? stepStatusConfig.pending;
                return (
                  <div
                    key={step.stepIndex}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${sc.bg}`}
                  >
                    <span className="w-5 text-center text-xs text-muted-foreground font-mono">
                      {step.stepIndex + 1}
                    </span>
                    <span className="flex-1 truncate">{step.stepName}</span>
                    {step.toolUsed && (
                      <code className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {step.toolUsed}
                      </code>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDurationMs(step.durationMs)}
                    </span>
                    <span className={`text-xs font-medium ${sc.color}`}>{sc.label}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No step results recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function DevicePlaybookHistory({ deviceId, timezone }: DevicePlaybookHistoryProps) {
  const [executions, setExecutions] = useState<PlaybookExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchExecutions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/playbooks/executions?deviceId=${deviceId}&limit=50`);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = await res.json();
      setExecutions(data.executions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load playbook history');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <PlayCircle className="h-5 w-5" />
          Playbook History
        </h2>
        <button
          type="button"
          onClick={fetchExecutions}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && executions.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading playbook history...
        </div>
      ) : executions.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <PlayCircle className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">
            No playbook executions found for this device.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Playbooks can be triggered via the AI assistant to automate remediation tasks.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {executions.map((exec) => (
            <ExecutionRow key={exec.execution.id} exec={exec} timezone={timezone} />
          ))}
        </div>
      )}
    </div>
  );
}
