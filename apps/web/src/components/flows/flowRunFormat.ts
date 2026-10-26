import { isTerminalFlowRunStatus } from '@breeze/shared';
import type { FlowRunStatus } from '@breeze/shared';

/** Compact duration: 850ms, 12s, 3m 05s, 2h 10m. Null/negative renders an em dash. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function runDurationMs(run: { startedAt: string | null; finishedAt: string | null; status: FlowRunStatus }): number | null {
  if (!run.startedAt) return null;
  if (!run.finishedAt) return isTerminalFlowRunStatus(run.status) ? null : Date.now() - new Date(run.startedAt).getTime();
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

const STATUS_CLASS: Record<string, string> = {
  completed: 'bg-green-500/15 text-green-700 dark:text-green-400',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  queued: 'bg-muted text-muted-foreground',
  waiting: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  awaiting_approval: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-400',
  unknown_outcome: 'bg-red-500/15 text-red-700 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
  skipped: 'bg-muted text-muted-foreground',
};

export function statusChipClass(status: string): string {
  return `rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[status] ?? 'bg-muted'}`;
}
