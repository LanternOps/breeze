import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, ChevronUp, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelative, slaState, ticketDisplayNumber, type TicketSummary } from './ticketConfig';

interface StripProps {
  tabLabel: string;
  /** 1-based position in the list, with the list size; null when the ticket is not in it. */
  position: { index: number; total: number } | null;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious: boolean;
  canNext: boolean;
}

const NAV_BUTTON =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

/** "← All open · 3 of 9" with previous/next: the way back to the board and
 *  along it without leaving the ticket's place. */
export function TicketFocusStrip({ tabLabel, position, onBack, onPrevious, onNext, canPrevious, canNext }: StripProps) {
  const { t } = useTranslation('tickets');
  return (
    <nav className="flex shrink-0 items-center gap-2 border-b px-4 pb-2" aria-label={t('ticketFocus.navLabel')} data-testid="ticket-focus-strip">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        aria-label={t('ticketFocus.backTo', { tab: tabLabel })}
        aria-keyshortcuts="Escape"
        data-testid="ticket-focus-back"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{tabLabel}</span>
      </button>
      {position && (
        <span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground" data-testid="ticket-focus-position">
          <span aria-hidden="true">· </span>
          {t('ticketFocus.position', { index: position.index, total: position.total })}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onPrevious} disabled={!canPrevious} className={NAV_BUTTON} aria-label={t('ticketFocus.previous')} title={t('ticketFocus.previous')} aria-keyshortcuts="k" data-testid="ticket-focus-prev">
          <ChevronUp className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" onClick={onNext} disabled={!canNext} className={NAV_BUTTON} aria-label={t('ticketFocus.next')} title={t('ticketFocus.next')} aria-keyshortcuts="j" data-testid="ticket-focus-next">
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

function slaText(ticket: TicketSummary, t: ReturnType<typeof useTranslation>['t']): string {
  const s = slaState(ticket);
  if (s.kind === 'breached') return t('slaChip.breached');
  if (s.kind === 'paused') return t('slaChip.pausedLeft', { relative: formatRelative(s.minutesLeft) });
  if (s.kind === 'at-risk') return t('ticketFocus.nextOffer.atRisk', { relative: formatRelative(s.minutesLeft) });
  if (s.kind === 'ok') return t('slaChip.left', { relative: formatRelative(s.minutesLeft) });
  return t('ticketFocus.nextOffer.noSla');
}

/** After a resolve: the next ticket, offered, never opened for you. */
export function TicketNextOffer({ ticket, onOpen }: { ticket: TicketSummary; onOpen: () => void }) {
  const { t } = useTranslation('tickets');
  const sla = slaState(ticket);
  const number = ticketDisplayNumber(ticket);
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm" data-testid="ticket-next-offer" role="status">
      <span className="shrink-0 text-muted-foreground">{t('ticketFocus.nextOffer.label')}</span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{number}</span>
      <span className="min-w-0 truncate font-medium">{ticket.subject}</span>
      <span
        className={cn(
          'shrink-0 whitespace-nowrap text-xs',
          sla.kind === 'breached' ? 'font-medium text-destructive-ink' : sla.kind === 'at-risk' ? 'font-medium text-warning-ink' : 'text-muted-foreground'
        )}
      >
        · {slaText(ticket, t)}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        aria-label={t('ticketFocus.nextOffer.openAria', { number, subject: ticket.subject })}
        aria-keyshortcuts="Enter"
        data-testid="ticket-next-offer-open"
      >
        {t('ticketFocus.nextOffer.open')}
        <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
