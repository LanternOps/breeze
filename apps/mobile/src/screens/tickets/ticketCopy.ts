import type { TicketPriority, TicketStatus, TicketSummary } from '../../services/tickets';
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
 * `#1041` when the tenant has internal numbers, else a short id fallback.
 * `internalNumber` (not `ticketNumber`) is the display reference — it is what
 * the web queue renders, and it is a nullable varchar rather than an integer.
 */
export function ticketRef(ticket: Pick<TicketSummary, 'internalNumber' | 'id'>): string {
  const n = ticket.internalNumber?.trim();
  if (n) return n.startsWith('#') ? n : `#${n}`;
  return `#${ticket.id.slice(0, 8)}`;
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
