import { slaState, formatRelative, type TicketSummary } from './ticketConfig';

export default function SlaChip({ ticket }: { ticket: TicketSummary }) {
  const s = slaState(ticket);
  if (s.kind === 'none') return null;
  if (s.kind === 'ok') {
    return <span className="text-xs text-muted-foreground" data-testid={`ticket-sla-${ticket.id}`}>{formatRelative(s.minutesLeft)}</span>;
  }
  if (s.kind === 'at-risk') {
    return (
      <span
        className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium bg-warning/15 text-warning border-warning/30"
        data-testid={`ticket-sla-${ticket.id}`}
      >
        {formatRelative(s.minutesLeft)} left
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium bg-destructive/15 text-destructive border-destructive/30"
      data-testid={`ticket-sla-${ticket.id}`}
    >
      Breached
    </span>
  );
}
