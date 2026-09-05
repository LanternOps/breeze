import type { SlaDto } from '@breeze/shared';
import type { TicketStatus } from '@/lib/api';
import type { MarkTone } from './ui';

/**
 * The one source for a ticket STATUS's tone (StatusMark in ui.tsx) — priority
 * is deliberately plain text in both views, one mark per row. Shared by
 * TicketList and TicketDetails so the same datum never wears two treatments.
 *
 * Customer-facing semantics, not the technician's queue: 'new' and 'open' both
 * read as Open (triage state is the MSP's business); 'pending' means the ball
 * is with the customer, so it is the ONE amber state; 'on_hold' is quiet.
 *
 * Every switch here is total over the enum AND carries a default: a status the
 * API adds tomorrow must render as a neutral mark, never throw during SSR.
 * (An earlier version returned undefined for 'new' — the most common status —
 * and took the whole Support page down.)
 */
export function ticketStatusTone(status: TicketStatus): MarkTone {
  switch (status) {
    case 'new':
    case 'open':
      return 'primary';
    case 'pending':
      return 'warning';
    case 'resolved':
      return 'success';
    case 'on_hold':
    case 'closed':
      return 'neutral';
    default:
      console.error('[portal] unknown ticket status', status);
      return 'neutral';
  }
}

export function ticketStatusLabel(status: TicketStatus): string {
  switch (status) {
    case 'new':
    case 'open':
      return 'Open';
    case 'pending':
      return 'Awaiting your reply';
    case 'on_hold':
      return 'On hold';
    case 'resolved':
      return 'Resolved';
    case 'closed':
      return 'Closed';
    default:
      return String(status);
  }
}

/** A request still needs attention from someone while it is in any of these. */
export function isTicketOpen(status: TicketStatus): boolean {
  return status !== 'resolved' && status !== 'closed';
}

/**
 * SLA state is CONTEXT on a row that already carries one StatusMark, so it is
 * plain quiet text — never a second dot. Only a breached target earns a tinted
 * foreground: an at-risk target is the MSP's problem to solve, not something
 * the customer can act on, and amber in this world is reserved for the states
 * they can (see DESIGN.md, "One mark per row").
 *
 * Wording is shared with the ticket detail header so the same datum never
 * wears two voices.
 */
export type SlaStatus = SlaDto['status'];

const SLA_LABELS: Record<SlaStatus, string> = {
  breached: 'SLA breached',
  at_risk: 'SLA at risk',
  paused: 'SLA paused',
  on_track: 'SLA on track',
  met: 'SLA met',
  not_configured: 'No SLA configured',
};

export function ticketSlaLabel(status: SlaStatus): string {
  return SLA_LABELS[status] ?? String(status);
}

export function ticketSlaTextClass(status: SlaStatus): string {
  return status === 'breached' ? 'text-destructive-on-tint' : 'text-muted-foreground';
}
