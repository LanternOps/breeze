import type { TicketStatus } from '@/lib/api';

export type StatusMarkClasses = { dot: string; text: string };

const NEUTRAL: StatusMarkClasses = { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' };

/**
 * The one source for how a ticket's STATUS renders as a StatusMark (ui.tsx) —
 * priority is deliberately plain text in both views, one mark per row:
 * a dot of the background-tuned token beside text in the AA-safe `-on-tint`
 * foreground. Shared by TicketList and TicketDetails so the same datum never
 * wears two treatments.
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
export function ticketStatusMark(status: TicketStatus): StatusMarkClasses {
  switch (status) {
    case 'new':
    case 'open':
      return { dot: 'bg-primary', text: 'text-primary-on-tint' };
    case 'pending':
      return { dot: 'bg-warning', text: 'text-warning-on-tint' };
    case 'resolved':
      return { dot: 'bg-success', text: 'text-success-on-tint' };
    case 'on_hold':
    case 'closed':
      return NEUTRAL;
    default:
      console.error('[portal] unknown ticket status', status);
      return NEUTRAL;
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
