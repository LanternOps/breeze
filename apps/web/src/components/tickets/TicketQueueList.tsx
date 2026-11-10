import { memo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import SlaChip from './SlaChip';
import TicketTypeChip from './TicketTypeChip';
import { statusConfig, priorityConfig, type TicketPriority, type TicketStatus, type TicketSummary } from './ticketConfig';
import { type TicketConfig } from '../../lib/ticketConfigApi';
import { formatDateTime } from '@/lib/dateTimeFormat';

interface Props {
  tickets: TicketSummary[];
  selectedId: string | null;
  onSelect: (t: TicketSummary) => void;
  loading: boolean;
  /** Ticket config for custom-status names/colors and priority labels; null falls back to core config. */
  config?: TicketConfig | null;
  /** When set, the empty state offers a "Clear filters" action (UI brief: "View empty (filters)"). */
  onClearFilters?: () => void;
  /** Bulk selection (UI brief §6). Checkboxes render only when onToggleSelect is provided. */
  bulkSelectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  /** Suppresses the per-row org name — for a host that already pins one org
   *  (the organization record's Tickets tab), where every row would otherwise
   *  repeat the same name the page's own header already shows. */
  hideOrg?: boolean;
  /** The host moves the selection with ArrowUp/ArrowDown itself (TicketsPage's
   *  window-level j/k hook). Otherwise the list moves focus between rows. */
  hostHandlesArrowKeys?: boolean;
}

type TFunction = ReturnType<typeof useTranslation>['t'];

/** DOM id of a queue row, so the page can move focus to it on j/k. */
export function queueOptionId(ticketId: string): string {
  return `ticket-option-${ticketId}`;
}

function timeAgo(iso: string, t: TFunction): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 60) return t('ticketQueueList.timeAgo.minutes', { count: Math.max(1, Math.floor(mins)) });
  if (mins < 60 * 24) return t('ticketQueueList.timeAgo.hours', { count: Math.floor(mins / 60) });
  return t('ticketQueueList.timeAgo.days', { count: Math.floor(mins / (60 * 24)) });
}

function translatedPriorityLabel(config: TicketConfig | null, priority: TicketPriority, t: TFunction): string {
  return config?.priorities[priority]?.label ?? t(/* i18n-dynamic */ `ticketQueueList.priority.${priority}`);
}

function translatedStatusLabel(config: TicketConfig | null, status: TicketStatus, statusName: string | null | undefined, t: TFunction): string {
  if (statusName) return statusName;
  const systemRow = config?.statuses.find((s) => s.coreStatus === status && s.isSystem);
  return systemRow?.name ?? t(/* i18n-dynamic */ `ticketQueueList.status.${status}`);
}

function TicketQueueList({ tickets, selectedId, onSelect, loading, config = null, onClearFilters, bulkSelectedIds, onToggleSelect, hideOrg = false, hostHandlesArrowKeys = false }: Props) {
  const { t } = useTranslation('tickets');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const anyBulkSelected = (bulkSelectedIds?.size ?? 0) > 0;
  // Roving tabindex: the list is one tab stop, on the selected row, else the
  // last focused row, else the first. On TicketsPage j/k move DOM focus with
  // the selection (TicketsPage.move); elsewhere the arrows move focus.
  const inList = (id: string | null) => id !== null && tickets.some((tk) => tk.id === id);
  const tabStopId = inList(selectedId) ? selectedId : inList(focusedId) ? focusedId : tickets[0]?.id ?? null;

  const onRowArrowKey = (e: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    if (hostHandlesArrowKeys) return;
    const last = tickets.length - 1;
    const target =
      e.key === 'ArrowDown' ? Math.min(last, index + 1)
      : e.key === 'ArrowUp' ? Math.max(0, index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (target === null) return;
    e.preventDefault();
    document.getElementById(queueOptionId(tickets[target].id))?.focus();
  };

  // Skeleton only on a cold load (no rows yet). A background reconcile after a
  // mutation keeps `loading` true briefly — blanking the populated list with the
  // skeleton on every action is the visible "flash" that made the queue feel slow.
  if (loading && tickets.length === 0) {
    return (
      <div className="divide-y" data-testid="tickets-queue-loading">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-3 py-3 animate-pulse">
            <div className="h-3.5 w-3/4 rounded bg-muted" />
            <div className="mt-2 h-3 w-1/2 rounded bg-muted/60" />
          </div>
        ))}
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="tickets-queue-empty">
        <p>{t('ticketQueueList.empty')}</p>
        {onClearFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            data-testid="tickets-filters-clear"
            className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('ticketQueueList.clearFilters')}
          </button>
        )}
      </div>
    );
  }

  return (
    <ul className="divide-y" role="listbox" aria-label={t('ticketQueueList.ariaLabel')} data-testid="tickets-queue">
      {tickets.map((ticket, index) => (
        // presentation: the listbox owns options only; the li is layout.
        <li key={ticket.id} role="presentation" className="group relative">
          {/* Sibling of the row (not nested) so checkbox clicks never trigger
              row selection. Pointer-only: out of the tab order and hidden from
              assistive tech (a checkbox is not a valid listbox child). The row
              carries the same state as aria-checked and `x` toggles it.
              Hidden until row hover, keyboard focus on the row, or an active
              selection (brief §6). */}
          {onToggleSelect && (
            <input
              type="checkbox"
              tabIndex={-1}
              aria-hidden="true"
              checked={bulkSelectedIds?.has(ticket.id) ?? false}
              onChange={() => onToggleSelect(ticket.id)}
              onClick={(e) => e.stopPropagation()}
              title={t('ticketQueueList.selectTicket', { ticket: ticket.internalNumber ?? ticket.subject })}
              data-testid={`ticket-select-${ticket.id}`}
              className={cn(
                'absolute left-2 top-3 z-10 h-4 w-4 cursor-pointer accent-primary transition-opacity',
                anyBulkSelected || bulkSelectedIds?.has(ticket.id)
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100'
              )}
            />
          )}
          {/* role="option" + roving tabIndex + onKeyDown give the row a
              button's focus and Enter/Space activation. Keep it free of nested
              links: the whole row is the select target, and an anchor inside it
              (the org name used to be one) captures clicks in the middle of the
              row and navigates away instead of opening the ticket (#9564). The
              workbench header carries the org record link. */}
          <div
            id={queueOptionId(ticket.id)}
            role="option"
            tabIndex={ticket.id === tabStopId ? 0 : -1}
            aria-selected={ticket.id === selectedId}
            aria-checked={onToggleSelect ? (bulkSelectedIds?.has(ticket.id) ?? false) : undefined}
            onClick={() => onSelect(ticket)}
            onFocus={() => setFocusedId(ticket.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(ticket);
                return;
              }
              onRowArrowKey(e, index);
            }}
            data-testid={`ticket-row-${ticket.id}`}
            className={cn(
              'block w-full cursor-pointer px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary',
              onToggleSelect && 'pl-8', // reserve the checkbox gutter
              ticket.id === selectedId && 'bg-primary/5 border-l-0' // selection tint; brand color reserved for selection
            )}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground shrink-0">{ticket.internalNumber ?? '·'}</span>
              <span className="truncate text-sm font-medium">{ticket.subject}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium', priorityConfig[ticket.priority].color)}
              >
                {translatedPriorityLabel(config, ticket.priority, t)}
              </span>
              <span
                className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium', statusConfig[ticket.status].color)}
              >
                {ticket.statusColor && (
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: ticket.statusColor }}
                    aria-hidden="true"
                  />
                )}
                {translatedStatusLabel(config, ticket.status, ticket.statusName, t)}
              </span>
              <TicketTypeChip type={ticket.ticketType} testId={`ticket-type-chip-${ticket.id}`} />
              {ticket.mergedIntoTicketId && (
                // #8972: a merged tombstone, listed only under "Show merged".
                <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-medium text-primary-ink" data-testid={`ticket-row-merged-${ticket.id}`}>
                  {t('ticketQueueList.merged')}
                </span>
              )}
              {ticket.checklist && ticket.checklist.total > 0 && (
                <span
                  className={cn(
                    'inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium tabular-nums',
                    ticket.checklist.done === ticket.checklist.total && 'text-success-ink'
                  )}
                  title={t('ticketQueueList.checklistTitle', { done: ticket.checklist.done, total: ticket.checklist.total })}
                  data-testid={`ticket-checklist-chip-${ticket.id}`}
                >
                  {t('ticketQueueList.checklistProgress', { done: ticket.checklist.done, total: ticket.checklist.total })}
                </span>
              )}
              {!hideOrg && ticket.orgName && (
                <span className="min-w-0 truncate" data-testid={`ticket-org-${ticket.id}`}>{ticket.orgName}</span>
              )}
              <span className="ml-auto shrink-0 flex items-center gap-2">
                <SlaChip ticket={ticket} />
                <span title={formatDateTime(ticket.updatedAt)}>{timeAgo(ticket.updatedAt, t)}</span>
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// Memoized: the parent (TicketsPage) re-renders on unrelated state (search box,
// bulk menu, reconcile timers); without this the whole list (up to 100 rows)
// re-renders on every keystroke and every background refresh.
export default memo(TicketQueueList);
