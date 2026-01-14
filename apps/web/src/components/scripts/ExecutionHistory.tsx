import { useMemo, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, Eye, Clock, CheckCircle, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

const REFERENCE_DATE = new Date('2024-01-15T12:00:00.000Z');

export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';

export type ScriptExecution = {
  id: string;
  scriptId: string;
  scriptName: string;
  deviceId: string;
  deviceHostname: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  duration?: number; // in seconds
};

type ExecutionHistoryProps = {
  executions: ScriptExecution[];
  onViewDetails?: (execution: ScriptExecution) => void;
  pageSize?: number;
  showScriptName?: boolean;
};

const statusConfig: Record<ExecutionStatus, { label: string; color: string; icon: typeof CheckCircle }> = {
  pending: { label: 'Pending', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: Clock },
  running: { label: 'Running', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Loader2 },
  completed: { label: 'Completed', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: XCircle },
  timeout: { label: 'Timeout', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: AlertTriangle }
};

function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '-';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = REFERENCE_DATE;
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isYesterday) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function ExecutionHistory({
  executions,
  onViewDetails,
  pageSize = 10,
  showScriptName = true
}: ExecutionHistoryProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredExecutions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const now = REFERENCE_DATE;

    return executions.filter(execution => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : execution.scriptName.toLowerCase().includes(normalizedQuery) ||
          execution.deviceHostname.toLowerCase().includes(normalizedQuery);

      const matchesStatus = statusFilter === 'all' ? true : execution.status === statusFilter;

      let matchesDate = true;
      if (dateFilter !== 'all') {
        const executionDate = new Date(execution.startedAt);
        const diffMs = now.getTime() - executionDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        switch (dateFilter) {
          case 'hour':
            matchesDate = diffHours <= 1;
            break;
          case 'day':
            matchesDate = diffDays <= 1;
            break;
          case 'week':
            matchesDate = diffDays <= 7;
            break;
          case 'month':
            matchesDate = diffDays <= 30;
            break;
        }
      }

      return matchesQuery && matchesStatus && matchesDate;
    });
  }, [executions, query, statusFilter, dateFilter]);

  const totalPages = Math.ceil(filteredExecutions.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedExecutions = filteredExecutions.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Execution History</h2>
          <p className="text-sm text-muted-foreground">
            {filteredExecutions.length} of {executions.length} executions
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search..."
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
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="timeout">Timeout</option>
          </select>
          <select
            value={dateFilter}
            onChange={event => {
              setDateFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Time</option>
            <option value="hour">Last Hour</option>
            <option value="day">Last 24 Hours</option>
            <option value="week">Last 7 Days</option>
            <option value="month">Last 30 Days</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {showScriptName && <th className="px-4 py-3">Script</th>}
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Exit Code</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedExecutions.length === 0 ? (
              <tr>
                <td colSpan={showScriptName ? 7 : 6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No executions found. Try adjusting your filters.
                </td>
              </tr>
            ) : (
              paginatedExecutions.map(execution => {
                const StatusIcon = statusConfig[execution.status].icon;
                return (
                  <tr
                    key={execution.id}
                    className="transition hover:bg-muted/40 cursor-pointer"
                    onClick={() => onViewDetails?.(execution)}
                  >
                    {showScriptName && (
                      <td className="px-4 py-3 text-sm font-medium">{execution.scriptName}</td>
                    )}
                    <td className="px-4 py-3 text-sm">{execution.deviceHostname}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                        statusConfig[execution.status].color
                      )}>
                        <StatusIcon className={cn(
                          'h-3 w-3',
                          execution.status === 'running' && 'animate-spin'
                        )} />
                        {statusConfig[execution.status].label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDateTime(execution.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {execution.status === 'running' ? (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3 animate-pulse" />
                          Running...
                        </span>
                      ) : (
                        formatDuration(execution.duration)
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {execution.exitCode !== undefined ? (
                        <span className={cn(
                          'inline-flex items-center rounded px-2 py-0.5 text-xs font-mono',
                          execution.exitCode === 0
                            ? 'bg-green-500/20 text-green-700'
                            : 'bg-red-500/20 text-red-700'
                        )}>
                          {execution.exitCode}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onViewDetails?.(execution);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          title="View details"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredExecutions.length)} of {filteredExecutions.length}
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
