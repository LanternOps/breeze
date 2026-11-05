// Sourced from the shared Zod enums so the UI can't drift from the validators.
import type { TicketStatus, TicketPriority, TicketAttachmentMeta, TicketType } from '@breeze/shared';
export type { TicketStatus, TicketPriority, TicketAttachmentMeta, TicketType };

export interface TicketSummary {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: TicketStatus;
  // Custom-status decoration from the API (null for legacy tickets). `status`
  // remains the core state; `statusName`/`statusColor` describe the custom row.
  statusName?: string | null;
  statusColor?: string | null;
  priority: TicketPriority;
  // #7900. Optional so older payloads/fixtures read as incident (the DB default).
  ticketType?: TicketType;
  source: string;
  orgId: string;
  orgName: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  categoryId: string | null;
  dueDate: string | null;
  tags?: string[];
  /** Checklist progress for the queue (#9180). null/absent = no steps (or an org-scoped viewer). */
  checklist?: { done: number; total: number } | null;
  slaBreachedAt: string | null;
  resolutionSlaMinutes?: number | null;
  responseSlaMinutes?: number | null;
  slaPausedAt?: string | null;
  slaPausedMinutes?: number | null;
  // #8973 stored SLA deadlines (server-computed; the client never derives them from targets)
  responseDueAt?: string | null;
  resolutionDueAt?: string | null;
  responseWarnAt?: string | null;
  resolutionWarnAt?: string | null;
  slaBusinessMinutesRemaining?: { response: number | null; resolution: number | null } | null;
  slaBreachReason?: string | null;
  firstResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Only present on the soft-deleted "Archived" queue (GET /tickets?deleted=only).
  // ISO timestamp of when the ticket was soft-deleted; null/absent on live rows.
  deletedAt?: string | null;
  // #8972: set on a merged tombstone (the survivor's id / when). null on live
  // tickets; optional so older payloads and fixtures read as not merged.
  mergedIntoTicketId?: string | null;
  mergedAt?: string | null;
}

export interface TicketComment {
  id: string;
  userId: string | null;
  portalUserId: string | null;
  authorName: string | null;
  authorType: string | null;
  /** Who wrote the row: 'user', 'ai_agent', 'service_principal', 'system', …
   *  'system' marks a note Breeze posted itself (#9960). Absent on older payloads. */
  originPrincipalKind?: string | null;
  commentType: 'comment' | 'internal' | 'status_change' | 'assignment' | 'time_entry' | 'system';
  content: string;
  isPublic: boolean;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  editedAt?: string | null;
  deleted?: boolean;
  /** W08 #3902 — photo/PDF attachments on this comment. Absent on older
   *  payloads and always [] for a soft-deleted comment. */
  attachments?: TicketAttachmentMeta[];
  /** #8972: the tombstone this comment was moved from by a merge (the earliest
   *  origin on a twice-merged comment); null/absent on native comments. */
  mergedFromTicketId?: string | null;
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  // Requester. submittedBy links a portal_users row (portal/picked requester);
  // submitterName/Email are the display name + reply address (also set for
  // free-text requesters that have no portal account).
  submittedBy: string | null;
  // org contact the ticket is for (caller verification keys on it); absent on older APIs.
  requesterContactId?: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  pendingReason: string | null;
  resolutionNote: string | null;
  // Stamped by the API on resolve/close, cleared on reopen. The detail endpoint
  // returns the full ticket row, so this is always present (unlike the list).
  resolvedAt: string | null;
  // Legacy display number; the UI prefers internalNumber (see ticketDisplayNumber).
  ticketNumber?: string | null;
  // #8972: who merged this tombstone (null once that user is deleted).
  mergedByUserId?: string | null;
  comments: TicketComment[];
  alertLinks: Array<{ id: string; alertId: string; linkType: string; alertTitle: string | null; alertSeverity: string | null; alertStatus: string | null }>;
}

/** The number a technician reads for a ticket: internal number, then the
 *  legacy ticket number, then a short id. */
export function ticketDisplayNumber(t: { id: string; internalNumber?: string | null; ticketNumber?: string | null }): string {
  return t.internalNumber ?? t.ticketNumber ?? t.id.slice(0, 8);
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
  | { kind: 'paused'; minutesLeft: number }
  | { kind: 'breached'; minutesAgo: number };

// "Quiet until it matters" — see SlaChip for per-state rendering. Reads the server-stored deadlines only (#8973):
// *DueAt already includes paused time and *WarnAt is the server's "breaching soon" point. No target arithmetic here.
// Client twin of the stored-deadline SQL in apps/api/src/routes/tickets/tickets.ts (SLA_AT_RISK) and
// apps/api/src/services/ticketSlaDeadlines.ts — change together.
export function slaState(
  t: Pick<TicketSummary, 'slaBreachedAt' | 'status' | 'firstResponseAt' | 'responseDueAt' | 'resolutionDueAt' |
    'responseWarnAt' | 'resolutionWarnAt' | 'slaPausedAt' | 'slaBusinessMinutesRemaining'>,
  now: Date = new Date()
): SlaState {
  if (t.status === 'resolved' || t.status === 'closed') return { kind: 'none' };
  if (t.slaBreachedAt) {
    return { kind: 'breached', minutesAgo: (now.getTime() - new Date(t.slaBreachedAt).getTime()) / 60_000 };
  }
  const arms: Array<{ arm: 'response' | 'resolution'; due: Date; warn: Date | null }> = [];
  if (!t.firstResponseAt && t.responseDueAt) {
    arms.push({ arm: 'response', due: new Date(t.responseDueAt), warn: t.responseWarnAt ? new Date(t.responseWarnAt) : null });
  }
  if (t.resolutionDueAt) {
    arms.push({ arm: 'resolution', due: new Date(t.resolutionDueAt), warn: t.resolutionWarnAt ? new Date(t.resolutionWarnAt) : null });
  }
  if (arms.length === 0) return { kind: 'none' };

  const chosen = arms.reduce((a, b) => (b.due.getTime() < a.due.getTime() ? b : a));
  const clockEnd = t.slaPausedAt ? new Date(t.slaPausedAt) : now; // frozen while paused
  const business = t.slaBusinessMinutesRemaining?.[chosen.arm];
  const left = typeof business === 'number' ? business : (chosen.due.getTime() - clockEnd.getTime()) / 60_000;
  if (t.slaPausedAt) return { kind: 'paused', minutesLeft: Math.max(0, left) };
  if (left <= 0) return { kind: 'breached', minutesAgo: -left };
  if (arms.some((a) => a.warn && now.getTime() >= a.warn.getTime())) return { kind: 'at-risk', minutesLeft: left };
  return { kind: 'ok', minutesLeft: left };
}
