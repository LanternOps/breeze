import { useMemo, useState } from 'react';
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  XCircle,
  AlertTriangle
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type RollbackStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export type RollbackRecord = {
  id: string;
  patchId: string;
  patchName: string;
  patchVersion: string;
  date: string;
  reason: string;
  devicesAffected: number;
  devicesCompleted: number;
  status: RollbackStatus;
  initiatedBy: {
    id: string;
    name: string;
    email: string;
  };
  scheduledFor?: string;
  completedAt?: string;
  errorMessage?: string;
};

type PatchRollbackHistoryProps = {
  rollbacks: RollbackRecord[];
  patchId?: string;
  onViewDetails?: (rollback: RollbackRecord) => void;
  onRetry?: (rollback: RollbackRecord) => void;
  onCancel?: (rollback: RollbackRecord) => void;
  pageSize?: number;
};

const statusConfig: Record<
  RollbackStatus,
  { label: string; color: string; icon: typeof CheckCircle }
> = {
  pending: {
    label: 'Pending',
    color: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
    icon: Clock
  },
  in_progress: {
    label: 'In Progress',
    color: 'bg-amber-500/20 text-amber-700 border-amber-500/40',
    icon: Loader2
  },
  completed: {
    label: 'Completed',
    color: 'bg-green-500/20 text-green-700 border-green-500/40',
    icon: CheckCircle
  },
  failed: {
    label: 'Failed',
    color: 'bg-red-500/20 text-red-700 border-red-500/40',
    icon: XCircle
  },
  cancelled: {
    label: 'Cancelled',
    color: 'bg-gray-500/20 text-gray-700 border-gray-500/40',
    icon: XCircle
  }
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatRelativeTime(dateString: string): string {
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

  return formatDate(dateString);
}

export default function PatchRollbackHistory({
  rollbacks,
  patchId,
  onViewDetails,
  onRetry,
  onCancel,
  pageSize = 10
}: PatchRollbackHistoryProps) {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredRollbacks = useMemo(() => {
    let filtered = rollbacks;

    // Filter by patch if patchId is provided
    if (patchId) {
      filtered = filtered.filter(r => r.patchId === patchId);
    }

    // Filter by status
    if (statusFilter !== 'all') {
      filtered = filtered.filter(r => r.status === statusFilter);
    }

    // Sort by date descending
    return [...filtered].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }, [rollbacks, patchId, statusFilter]);

  const totalPages = Math.ceil(filteredRollbacks.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRollbacks = filteredRollbacks.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Rollback History</h2>
          <p className="text-sm text-muted-foreground">
            {filteredRollbacks.length} rollback{filteredRollbacks.length !== 1 ? 's' : ''}
            {patchId && ' for this patch'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={e => {
              setStatusFilter(e.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Date</th>
              {!patchId && <th className="px-4 py-3">Patch</th>}
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Devices</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Initiated By</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedRollbacks.length === 0 ? (
              <tr>
                <td
                  colSpan={patchId ? 6 : 7}
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                >
                  <div className="flex flex-col items-center gap-2">
                    <AlertTriangle className="h-8 w-8 text-muted-foreground/50" />
                    <p>No rollback history found</p>
                    {statusFilter !== 'all' && (
                      <button
                        type="button"
                        onClick={() => setStatusFilter('all')}
                        className="text-primary hover:underline"
                      >
                        Clear filter
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              paginatedRollbacks.map(rollback => {
                const status = statusConfig[rollback.status];
                const StatusIcon = status.icon;
                const progressPercent =
                  rollback.devicesAffected > 0
                    ? Math.round((rollback.devicesCompleted / rollback.devicesAffected) * 100)
                    : 0;

                return (
                  <tr key={rollback.id} className="text-sm">
                    <td className="px-4 py-3">
                      <div className="font-medium">{formatRelativeTime(rollback.date)}</div>
                      {rollback.scheduledFor && rollback.status === 'pending' && (
                        <div className="text-xs text-muted-foreground">
                          Scheduled: {formatDate(rollback.scheduledFor)}
                        </div>
                      )}
                    </td>
                    {!patchId && (
                      <td className="px-4 py-3">
                        <div className="font-medium">{rollback.patchName}</div>
                        <div className="text-xs text-muted-foreground">
                          v{rollback.patchVersion}
                        </div>
                      </td>
                    )}
                    <td className="max-w-xs px-4 py-3">
                      <div className="truncate" title={rollback.reason}>
                        {rollback.reason}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span>
                          {rollback.devicesCompleted}/{rollback.devicesAffected}
                        </span>
                        {rollback.status === 'in_progress' && (
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-amber-500 transition-all"
                              style={{ width: `${progressPercent}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                          status.color
                        )}
                      >
                        <StatusIcon
                          className={cn(
                            'h-3.5 w-3.5',
                            rollback.status === 'in_progress' && 'animate-spin'
                          )}
                        />
                        {status.label}
                      </span>
                      {rollback.status === 'failed' && rollback.errorMessage && (
                        <div
                          className="mt-1 max-w-[200px] truncate text-xs text-red-600"
                          title={rollback.errorMessage}
                        >
                          {rollback.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{rollback.initiatedBy.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {rollback.initiatedBy.email}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {onViewDetails && (
                          <button
                            type="button"
                            onClick={() => onViewDetails(rollback)}
                            className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
                          >
                            Details
                          </button>
                        )}
                        {rollback.status === 'failed' && onRetry && (
                          <button
                            type="button"
                            onClick={() => onRetry(rollback)}
                            className="inline-flex h-8 items-center rounded-md bg-amber-600 px-3 text-xs font-medium text-white hover:bg-amber-700"
                          >
                            Retry
                          </button>
                        )}
                        {rollback.status === 'pending' && onCancel && (
                          <button
                            type="button"
                            onClick={() => onCancel(rollback)}
                            className="inline-flex h-8 items-center rounded-md border border-red-500/40 px-3 text-xs font-medium text-red-600 hover:bg-red-500/10"
                          >
                            Cancel
                          </button>
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

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {startIndex + 1} to{' '}
            {Math.min(startIndex + pageSize, filteredRollbacks.length)} of{' '}
            {filteredRollbacks.length}
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
