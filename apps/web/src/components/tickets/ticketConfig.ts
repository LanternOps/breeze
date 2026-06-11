// Sourced from the shared Zod enums so the UI can't drift from the validators.
import type { TicketStatus, TicketPriority } from '@breeze/shared';
export type { TicketStatus, TicketPriority };

export interface TicketSummary {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  source: string;
  orgId: string;
  orgName: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  categoryId: string | null;
  dueDate: string | null;
  slaBreachedAt: string | null;
  resolutionSlaMinutes?: number | null;
  firstResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  userId: string | null;
  portalUserId: string | null;
  authorName: string | null;
  authorType: string | null;
  commentType: 'comment' | 'internal' | 'status_change' | 'assignment' | 'time_entry' | 'system';
  content: string;
  isPublic: boolean;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  pendingReason: string | null;
  resolutionNote: string | null;
  comments: TicketComment[];
  alertLinks: Array<{ id: string; alertId: string; linkType: string; alertTitle: string | null; alertSeverity: string | null; alertStatus: string | null }>;
}

export const statusConfig: Record<TicketStatus, { label: string; color: string }> = {
  new: { label: 'New', color: 'bg-primary/15 text-primary border-primary/30' },
  open: { label: 'Open', color: 'bg-success/15 text-success border-success/30' },
  pending: { label: 'Pending', color: 'bg-warning/15 text-warning border-warning/30' },
  on_hold: { label: 'On hold', color: 'bg-muted text-muted-foreground border-border' },
  resolved: { label: 'Resolved', color: 'bg-success/15 text-success border-success/30' },
  closed: { label: 'Closed', color: 'bg-muted text-muted-foreground border-border' },
};

export const priorityConfig: Record<TicketPriority, { label: string; color: string; weight: number }> = {
  urgent: { label: 'Urgent', color: 'text-red-700 dark:text-red-400 bg-red-500/10 border-red-500/30', weight: 0 },
  high: { label: 'High', color: 'text-orange-700 dark:text-orange-400 bg-orange-500/10 border-orange-500/30', weight: 1 },
  normal: { label: 'Normal', color: 'text-muted-foreground bg-muted border-border', weight: 2 },
  low: { label: 'Low', color: 'text-muted-foreground bg-muted/50 border-border', weight: 3 },
};

export function formatRelative(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes));
  const d = Math.floor(m / (60 * 24));
  const h = Math.floor((m % (60 * 24)) / 60);
  const mins = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
}

export type SlaState =
  | { kind: 'none' }
  | { kind: 'ok'; minutesLeft: number }
  | { kind: 'at-risk'; minutesLeft: number }
  | { kind: 'breached'; minutesAgo: number };

// "Quiet until it matters" — see SlaChip for per-state rendering. At-risk begins at 80% of resolutionSlaMinutes elapsed.
export function slaState(
  t: Pick<TicketSummary, 'slaBreachedAt' | 'createdAt' | 'status'> & { resolutionSlaMinutes?: number | null },
  now: Date = new Date()
): SlaState {
  if (t.status === 'resolved' || t.status === 'closed') return { kind: 'none' };
  if (t.slaBreachedAt) {
    return { kind: 'breached', minutesAgo: (now.getTime() - new Date(t.slaBreachedAt).getTime()) / 60_000 };
  }
  if (!t.resolutionSlaMinutes) return { kind: 'none' };
  const elapsed = (now.getTime() - new Date(t.createdAt).getTime()) / 60_000;
  const left = t.resolutionSlaMinutes - elapsed;
  if (left <= 0) return { kind: 'breached', minutesAgo: -left };
  if (elapsed >= 0.8 * t.resolutionSlaMinutes) return { kind: 'at-risk', minutesLeft: left };
  return { kind: 'ok', minutesLeft: left };
}
