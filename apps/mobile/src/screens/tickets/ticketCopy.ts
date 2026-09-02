import type {
  TicketComment,
  TicketPriority,
  TicketStatus,
  TicketSummary,
} from '../../services/tickets';
// Value import, deliberately from the leaf module rather than services/tickets:
// that module pulls `./api` (expo-secure-store, react-native) and would drag the
// RN runtime into this otherwise node-testable copy module.
import { SYSTEM_COMMENT_TYPES } from '../../services/ticketCommentTypes';
// Import the pure token module rather than the `../../theme` barrel: the barrel
// re-exports `useApprovalTheme`, which imports `useColorScheme` from react-native
// and drags the RN runtime into this otherwise node-testable copy module.
import { palette } from '../../theme/tokens';

/** Human label for a status, preferring the tenant's custom status name. */
export function statusLabel(ticket: Pick<TicketSummary, 'status' | 'statusName'>): string {
  if (ticket.statusName && ticket.statusName.trim()) return ticket.statusName.trim();
  switch (ticket.status) {
    case 'on_hold':
      return 'On hold';
    case 'new':
      return 'New';
    case 'open':
      return 'Open';
    case 'pending':
      return 'Pending';
    case 'resolved':
      return 'Resolved';
    case 'closed':
      return 'Closed';
    default:
      return ticket.status;
  }
}

export function priorityLabel(priority: TicketPriority): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

export function priorityColor(priority: TicketPriority): string {
  switch (priority) {
    case 'urgent':
      return palette.deny.base;
    case 'high':
      return palette.warning.base;
    case 'normal':
      return palette.brand.soft;
    case 'low':
    default:
      return palette.dark.textLo;
  }
}

/**
 * `#1041` when the ticket has an internal number, else `null` so the caller
 * hides the reference entirely.
 *
 * `internalNumber` (not `ticketNumber`) is the display reference: it is what the
 * web queue renders, and it is a nullable varchar rather than an integer. The
 * service allocates one on every create (`T-YYYY-NNNN`), so a production ticket
 * always has one; only hand-inserted rows (fixtures, a seeded review tenant)
 * lack it. Web renders nothing for those rather than inventing a reference, and
 * so does mobile: an id-derived fallback either collides (seeded ids share a
 * long prefix, so `id.slice(0, 8)` showed three tickets as the same "#11110000")
 * or looks like a real number it is not.
 */
export function ticketRef(ticket: Pick<TicketSummary, 'internalNumber'>): string | null {
  const n = ticket.internalNumber?.trim();
  if (!n) return null;
  return n.startsWith('#') ? n : `#${n}`;
}

export function isBreached(ticket: Pick<TicketSummary, 'slaBreachedAt'>): boolean {
  return Boolean(ticket.slaBreachedAt);
}

/**
 * Empty-state copy depends on both filters — "no tickets at all" and "none
 * assigned to you" are different situations and a single string reads as a bug
 * when the tech knows the queue is not empty.
 */
export function emptyStateCopy(
  queue: 'open' | 'closed',
  assignee: 'me' | 'all'
): { title: string; body: string } {
  if (assignee === 'me') {
    return queue === 'open'
      ? { title: 'Nothing assigned to you', body: 'Switch to All to see the rest of the queue.' }
      : { title: 'Nothing closed by you', body: 'Switch to All to see closed tickets.' };
  }
  return queue === 'open'
    ? { title: 'No open tickets', body: 'The open queue is clear.' }
    : { title: 'No closed tickets', body: 'Closed tickets will appear here.' };
}

/**
 * Which empty state the list should show, if any.
 *
 * `error` is part of the decision, not just decoration. A rejected fetch leaves
 * `tickets` empty, so a list gated on `loading` alone rendered the error line
 * and the reassuring "The open queue is clear." copy together, in one viewport.
 * The empty-state copy above describes a queue we successfully read; it must
 * never narrate a queue we failed to reach.
 */
export function emptyStateKind(
  loading: boolean,
  error: string | null
): 'none' | 'error' | 'empty' {
  if (loading) return 'none';
  return error ? 'error' : 'empty';
}

/**
 * Whether an activity-feed row should be rendered at all.
 *
 * A system entry (status change, assignment, time entry) with blank
 * `content` carries no information: the row has only `content` and a
 * timestamp, no author chip or subject line to anchor it, so an empty one
 * rendered as a lone "10w ago" with nothing to its left — observed live
 * against a real tenant. Skip it rather than render it blank.
 *
 * A person comment always renders, even with empty content: it can
 * legitimately be attachment-only, and its own render branch already has
 * placeholder handling (soft-deleted / attachment-only) — that's not this
 * function's call to make.
 */
export function isVisibleActivityEntry(
  comment: Pick<TicketComment, 'commentType' | 'content'>
): boolean {
  const isSystem = Boolean(comment.commentType && SYSTEM_COMMENT_TYPES.has(comment.commentType));
  if (!isSystem) return true;
  return Boolean(comment.content && comment.content.trim());
}

/**
 * Count of rows the "ACTIVITY" feed actually renders below its header.
 *
 * Must stay in lockstep with `isVisibleActivityEntry` above — the header
 * previously counted only non-system comments while the list below also
 * rendered every system row, so a tenant saw "ACTIVITY (1)" printed over
 * five visible rows (four system rows plus one comment). Counting exactly
 * what's rendered keeps the number honest.
 */
export function visibleActivityCount(
  comments: ReadonlyArray<Pick<TicketComment, 'commentType' | 'content'>>
): number {
  return comments.filter(isVisibleActivityEntry).length;
}
