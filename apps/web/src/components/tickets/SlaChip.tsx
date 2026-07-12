import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { slaState, formatRelative, type TicketSummary } from './ticketConfig';

export default function SlaChip({ ticket }: { ticket: TicketSummary }) {
  const { t } = useTranslation('tickets');
  const s = slaState(ticket);
  if (s.kind === 'none') return null;
  if (s.kind === 'ok') {
    return <span className="text-xs text-muted-foreground" data-testid={`ticket-sla-${ticket.id}`}>{formatRelative(s.minutesLeft)}</span>;
  }
  if (s.kind === 'paused') {
    return (
      <span
        className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground border-border"
        data-testid={`ticket-sla-${ticket.id}`}
      >
        {t('slaChip.pausedLeft', { relative: formatRelative(s.minutesLeft) })}
      </span>
    );
  }
  if (s.kind === 'at-risk') {
    return (
      <span
        className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium bg-warning/15 text-warning border-warning/30"
        data-testid={`ticket-sla-${ticket.id}`}
      >
        {t('slaChip.left', { relative: formatRelative(s.minutesLeft) })}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium bg-destructive/15 text-destructive border-destructive/30"
      data-testid={`ticket-sla-${ticket.id}`}
    >
      {t('slaChip.breached')}
    </span>
  );
}
