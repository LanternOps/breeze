/**
 * Single source of truth for script-execution status presentation.
 *
 * Both ExecutionHistory and ExecutionDetails previously kept private 5-member
 * maps keyed on a private 5-member union, while the DB enum has 8 values. Both
 * indexed the map unguarded, so a `queued` or `cancelled` row crashed the whole
 * list render (#3525). Keying these maps on the SHARED union makes a missing
 * member a `tsc --noEmit` error, and executionStatus.test.tsx makes it a
 * runtime assertion too.
 */
import { AlertTriangle, Ban, CheckCircle, Clock, Loader2, XCircle } from 'lucide-react';
import type { ExecutionStatus, CancelState } from '@breeze/shared';

type RowEntry = { label: string; color: string; icon: typeof CheckCircle };
type DetailEntry = { label: string; color: string; bgColor: string; icon: typeof CheckCircle };

export const executionRowStatusConfig: Record<ExecutionStatus, RowEntry> = {
  pending: { label: 'status.pending', color: 'bg-muted text-muted-foreground border-border', icon: Clock },
  queued: { label: 'status.queued', color: 'bg-muted text-muted-foreground border-border', icon: Clock },
  running: { label: 'status.running', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Loader2 },
  cancelling: { label: 'status.cancelling', color: 'bg-warning/15 text-warning border-warning/30', icon: Loader2 },
  completed: { label: 'status.completed', color: 'bg-success/15 text-success border-success/30', icon: CheckCircle },
  failed: { label: 'status.failed', color: 'bg-destructive/15 text-destructive border-destructive/30', icon: XCircle },
  timeout: { label: 'status.timeout', color: 'bg-warning/15 text-warning border-warning/30', icon: AlertTriangle },
  cancelled: { label: 'status.cancelled', color: 'bg-muted text-muted-foreground border-border', icon: Ban },
};

export const executionDetailStatusConfig: Record<ExecutionStatus, DetailEntry> = {
  pending: { label: 'status.pending', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Clock },
  queued: { label: 'status.queued', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Clock },
  running: { label: 'status.running', color: 'text-blue-700 dark:text-blue-400', bgColor: 'bg-blue-500/10', icon: Loader2 },
  cancelling: { label: 'status.cancelling', color: 'text-warning', bgColor: 'bg-warning/10', icon: Loader2 },
  completed: { label: 'status.completed', color: 'text-success', bgColor: 'bg-success/10', icon: CheckCircle },
  failed: { label: 'status.failed', color: 'text-destructive', bgColor: 'bg-destructive/10', icon: XCircle },
  timeout: { label: 'status.timeout', color: 'text-warning', bgColor: 'bg-warning/10', icon: AlertTriangle },
  cancelled: { label: 'status.cancelled', color: 'text-muted-foreground', bgColor: 'bg-muted', icon: Ban },
};

/** Terminal execution statuses — the only ones a cancel_state can meaningfully
 * qualify. The API only ever sets cancel_state to 'requested' (or leaves it
 * null) while an execution is still in flight, but that's a server-side
 * invariant, not one this union enforces — so this guards it defensively
 * instead of trusting the caller. */
const TERMINAL_EXECUTION_STATUSES = new Set<ExecutionStatus>(['completed', 'failed', 'timeout', 'cancelled']);

/**
 * The status alone is not the whole truth once a cancel was requested. See the
 * OD8-C state table in the plan: (completed, unconfirmed) is "your stop request
 * arrived too late", (cancelled, confirmed) is a proven stop, and a terminal
 * status with cancel_state 'failed' means the device could not kill it. A
 * non-terminal status (pending/queued/running/cancelling) always resolves to
 * its own base label, regardless of cancel_state — there is no
 * "${status}CancelTooLate" i18n key for those, only for the three non-cancelled
 * terminal statuses (see the i18n step in the plan).
 */
export function resolveExecutionStatusLabel(
  status: ExecutionStatus,
  cancelState: CancelState | null | undefined,
): string {
  if (!cancelState || cancelState === 'requested' || !TERMINAL_EXECUTION_STATUSES.has(status)) {
    return executionRowStatusConfig[status].label;
  }
  if (status === 'cancelled') return 'status.cancelled';
  if (cancelState === 'failed') return 'status.cancelFailed';
  return `status.${status}CancelTooLate`;
}
