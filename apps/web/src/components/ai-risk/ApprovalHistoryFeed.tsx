import { useState } from 'react';
import { CheckCircle, XCircle, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { formatRelativeTime, formatToolName } from '../../lib/utils';
import type { ToolExecution } from './AiRiskDashboard';

interface Props {
  executions: ToolExecution[];
  loading: boolean;
}

type FilterStatus = 'all' | 'pending' | 'approved' | 'rejected';

const TIER3_TOOLS = new Set([
  'execute_command',
  'run_script',
  'manage_services',
  'security_scan',
  'file_operations',
  'disk_cleanup',
  'create_automation',
  'network_discovery',
]);

const STATUS_BADGE: Record<string, { icon: typeof CheckCircle; className: string }> = {
  approved: { icon: CheckCircle, className: 'bg-green-500/15 text-green-700 border-green-500/30' },
  completed: { icon: CheckCircle, className: 'bg-green-500/15 text-green-700 border-green-500/30' },
  rejected: { icon: XCircle, className: 'bg-red-500/15 text-red-700 border-red-500/30' },
  pending: { icon: Clock, className: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
};

export function ApprovalHistoryFeed({ executions, loading }: Props) {
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filter to Tier 3 tools only
  const tier3Execs = executions.filter((e) => TIER3_TOOLS.has(e.toolName));
  const filtered = filter === 'all'
    ? tier3Execs
    : tier3Execs.filter((e) => {
        if (filter === 'approved') return e.status === 'approved' || e.status === 'completed';
        return e.status === filter;
      });

  const filters: { label: string; value: FilterStatus }[] = [
    { label: 'All', value: 'all' },
    { label: 'Pending', value: 'pending' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rejected', value: 'rejected' },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Tier 3 Approval History</h2>
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
          No Tier 3 tool executions found.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((exec) => {
            const badge = STATUS_BADGE[exec.status] ?? STATUS_BADGE.pending;
            const BadgeIcon = badge.icon;
            const isExpanded = expandedId === exec.id;
            const waitMs =
              exec.approvedAt && exec.createdAt
                ? new Date(exec.approvedAt).getTime() - new Date(exec.createdAt).getTime()
                : null;

            return (
              <div
                key={exec.id}
                className="rounded-lg border bg-card shadow-sm"
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : exec.id)}
                  className="flex w-full items-center gap-3 p-4 text-left"
                >
                  <div className="flex-shrink-0">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {formatToolName(exec.toolName)}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}
                      >
                        <BadgeIcon className="h-3 w-3" />
                        {exec.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{formatRelativeTime(new Date(exec.createdAt))}</span>
                      {waitMs !== null && (
                        <span>Wait: {formatDuration(waitMs)}</span>
                      )}
                      {exec.durationMs !== null && (
                        <span>Exec: {exec.durationMs}ms</span>
                      )}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 pb-4 pt-3">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      Tool Input
                    </p>
                    <pre className="max-h-40 overflow-auto rounded bg-muted/30 p-2 text-xs">
                      {JSON.stringify(exec.toolInput, null, 2)}
                    </pre>
                    {exec.errorMessage && (
                      <div className="mt-2">
                        <p className="mb-1 text-xs font-medium text-red-600">Error</p>
                        <p className="text-xs text-red-600">{exec.errorMessage}</p>
                      </div>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      Session: {exec.sessionId}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
