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
import { useTranslation } from 'react-i18next';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
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
  pending: { label: 'devicePlaybookHistory.status.pending', icon: Clock, color: 'text-gray-600' },
  running: { label: 'devicePlaybookHistory.status.running', icon: Loader2, color: 'text-blue-600' },
  waiting: { label: 'devicePlaybookHistory.status.waiting', icon: Clock, color: 'text-yellow-600' },
  completed: { label: 'devicePlaybookHistory.status.completed', icon: CheckCircle, color: 'text-green-600' },
  failed: { label: 'devicePlaybookHistory.status.failed', icon: XCircle, color: 'text-red-600' },
  rolled_back: { label: 'devicePlaybookHistory.status.rolledBack', icon: Undo2, color: 'text-orange-600' },
  cancelled: { label: 'devicePlaybookHistory.status.cancelled', icon: Ban, color: 'text-gray-500' },
};

const stepStatusConfig: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'devicePlaybookHistory.stepStatus.pending', color: 'text-gray-600', bg: 'bg-gray-100' },
  running: { label: 'devicePlaybookHistory.stepStatus.running', color: 'text-blue-600', bg: 'bg-blue-50' },
  completed: { label: 'devicePlaybookHistory.stepStatus.completed', color: 'text-green-600', bg: 'bg-green-50' },
  failed: { label: 'devicePlaybookHistory.stepStatus.failed', color: 'text-red-600', bg: 'bg-red-50' },
  skipped: { label: 'devicePlaybookHistory.stepStatus.skipped', color: 'text-gray-400', bg: 'bg-gray-50' },
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
    : formatUserDateTime(date, timezone ? { timeZone: timezone } : undefined);
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
  const { t } = useTranslation('devices');
  const [expanded, setExpanded] = useState(false);
  const { execution, playbook } = exec;
  const config = statusConfig[execution.status] ?? statusConfig.pending;
  const StatusIcon = config.icon;
  const catStyle = categoryStyles[playbook?.category ?? ''] ?? 'bg-gray-100 text-gray-600 border-gray-300';

  return (
    <div className="rounded-lg border bg-card shadow-xs">
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
            <span className="font-medium truncate">{playbook?.name ?? t('devicePlaybookHistory.unknownPlaybook')}</span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catStyle}`}>
              {playbook?.category ?? '—'}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{formatDateTime(execution.createdAt, timezone)}</span>
            <span>{t('devicePlaybookHistory.duration', { duration: computeDuration(execution.startedAt, execution.completedAt) })}</span>
            <span>{t('devicePlaybookHistory.triggeredBy', { user: execution.triggeredBy })}</span>
          </div>
        </div>
        <span className={`text-xs font-medium ${config.color}`}>{t(/* i18n-dynamic */ config.label)}</span>
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
              {t('devicePlaybookHistory.rollbackExecuted')}
            </div>
          )}

          {execution.steps.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground mb-2">{t('devicePlaybookHistory.steps')}</p>
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
                    <span className={`text-xs font-medium ${sc.color}`}>{t(/* i18n-dynamic */ sc.label)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('devicePlaybookHistory.noStepResults')}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function DevicePlaybookHistory({ deviceId, timezone }: DevicePlaybookHistoryProps) {
  const { t } = useTranslation('devices');
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
          {t('devicePlaybookHistory.title')}
        </h2>
        <button
          type="button"
          onClick={fetchExecutions}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('common:actions.refresh')}
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
          {t('devicePlaybookHistory.loading')}
        </div>
      ) : executions.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <PlayCircle className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t('devicePlaybookHistory.empty')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t('devicePlaybookHistory.emptyHelp')}
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
