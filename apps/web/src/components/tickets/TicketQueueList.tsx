import { Fragment, memo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import SlaChip from './SlaChip';
import TicketTypeChip from './TicketTypeChip';
import { NEUTRAL_CHIP_TEXT, nameInitials, statusConfig, priorityConfig, type TicketPriority, type TicketStatus, type TicketSummary } from './ticketConfig';
import { type TicketConfig } from '../../lib/ticketConfigApi';
import { formatDateTime } from '@/lib/dateTimeFormat';

interface Props {
  tickets: TicketSummary[];
  selectedId: string | null;
  onSelect: (t: TicketSummary) => void;
  /** A row took keyboard or pointer focus: the host's active row follows it. */
  onRowFocus?: (t: TicketSummary) => void;
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

/** A row's "deviates from the default" chips: priority unless Normal, type
 *  unless Incident, status unless Open, plus the merged and checklist marks.
 *  Defaults carry no information on a board of mostly-default rows. */
function RowChips({ ticket, config, t }: { ticket: TicketSummary; config: TicketConfig | null; t: TFunction }) {
  const chip = 'inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium';
  const type = ticket.ticketType ?? 'incident';
  return (
    <>
      {ticket.priority !== 'normal' && (
        <span className={cn(chip, priorityConfig[ticket.priority].color)} data-testid={`ticket-priority-chip-${ticket.id}`}>
          {translatedPriorityLabel(config, ticket.priority, t)}
        </span>
      )}
      {ticket.status !== 'open' && (
        <span className={cn(chip, 'gap-1', statusConfig[ticket.status].color)} data-testid={`ticket-status-chip-${ticket.id}`}>
          {ticket.statusColor && (
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: ticket.statusColor }} aria-hidden="true" />
          )}
          {translatedStatusLabel(config, ticket.status, ticket.statusName, t)}
        </span>
      )}
      {type !== 'incident' && (
        <TicketTypeChip type={type} testId={`ticket-type-chip-${ticket.id}`} className="shrink-0 whitespace-nowrap" />
      )}
      {ticket.mergedIntoTicketId && (
        // #8972: a merged tombstone, listed only under "Show merged".
        <span className={cn(chip, 'border-primary/30 bg-primary/10 text-primary-ink')} data-testid={`ticket-row-merged-${ticket.id}`}>
          {t('ticketQueueList.merged')}
        </span>
      )}
      {ticket.checklist && ticket.checklist.total > 0 && (
        <span
          className={cn(chip, 'tabular-nums', ticket.checklist.done === ticket.checklist.total ? 'text-success-ink' : 'text-muted-foreground')}
          title={t('ticketQueueList.checklistTitle', { done: ticket.checklist.done, total: ticket.checklist.total })}
          data-testid={`ticket-checklist-chip-${ticket.id}`}
        >
          {t('ticketQueueList.checklistProgress', { done: ticket.checklist.done, total: ticket.checklist.total })}
        </span>
      )}
    </>
  );
}

type MetaPart = { kind: 'org' | 'requester' | 'device'; text: string; className: string };

/** Line 2 parts in reading order. Flex-shrink weights decide who gives way:
 *  the device first, then the requester; the org (the client) keeps a floor. */
function metaParts(ticket: TicketSummary, hideOrg: boolean): MetaPart[] {
  const parts: MetaPart[] = [];
  if (!hideOrg && ticket.orgName) parts.push({ kind: 'org', text: ticket.orgName, className: 'min-w-[6rem] max-w-[45%] shrink' });
  if (ticket.submitterName) parts.push({ kind: 'requester', text: ticket.submitterName, className: 'min-w-0 shrink-[3]' });
  if (ticket.deviceHostname) parts.push({ kind: 'device', text: ticket.deviceHostname, className: 'min-w-0 shrink-[6]' });
  return parts;
}

/** Owner: initials plus name, or a dashed empty avatar for "Unassigned". The
 *  name folds to screen-reader text in a narrow list. */
function OwnerBadge({ ticket, t }: { ticket: TicketSummary; t: TFunction }) {
  const name = ticket.assignedTo ? (ticket.assigneeName ?? t('ticketWorkbench.mspStaff')) : null;
  return (
    <span
      className="flex w-6 items-center gap-1.5 @xl:w-36"
      title={name ?? t('ticketWorkbench.unassigned')}
      data-testid={`ticket-owner-${ticket.id}`}
      data-unassigned={name ? undefined : 'true'}
    >
      {name ? (
        <span aria-hidden="true" className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold', NEUTRAL_CHIP_TEXT)}>
          {nameInitials(name)}
        </span>
      ) : (
        <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 rounded-full border border-dashed border-muted-foreground/60" />
      )}
      <span className={cn('sr-only truncate @xl:not-sr-only', name ? 'text-foreground' : 'italic text-muted-foreground')}>
        {name ?? t('ticketWorkbench.unassigned')}
      </span>
    </span>
  );
}

function TicketQueueList({ tickets, selectedId, onSelect, onRowFocus, loading, config = null, onClearFilters, bulkSelectedIds, onToggleSelect, hideOrg = false, hostHandlesArrowKeys = false }: Props) {
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
    <ul className="@container divide-y" role="listbox" aria-label={t('ticketQueueList.ariaLabel')} data-testid="tickets-queue">
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
                'absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 cursor-pointer accent-primary transition-opacity',
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
            onFocus={() => { setFocusedId(ticket.id); onRowFocus?.(ticket); }}
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
              // Narrow list: the owner / SLA / age cluster drops under the two
              // text lines so the subject keeps the row's width.
              'flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary @xl:flex-nowrap',
              onToggleSelect && 'pl-9', // reserve the checkbox gutter
              ticket.id === selectedId && 'bg-primary/10 hover:bg-primary/10' // active row; brand tint reserved for it
            )}
          >
            <div className="min-w-0 flex-1 basis-full @xl:basis-0">
              {/* Line 1: number, subject (gives way first), then only the
                  chips whose value is not the default; narrow, the chips
                  wrap under the subject instead of crushing it. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 @xl:flex-nowrap">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{ticket.internalNumber ?? '·'}</span>
                <span className="min-w-0 flex-1 basis-40 truncate text-sm font-medium @xl:flex-initial @xl:basis-auto">{ticket.subject}</span>
                <RowChips ticket={ticket} config={config} t={t} />
              </div>
              {/* Line 2: client, requester, device. Device and requester
                  give way before the org, which keeps a readable minimum. */}
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground" data-testid={`ticket-row-meta-${ticket.id}`}>
                {metaParts(ticket, hideOrg).map((part, i) => (
                  <Fragment key={part.kind}>
                    {i > 0 && <span aria-hidden="true" className="shrink-0">·</span>}
                    <span className={cn('truncate', part.className)} data-testid={`ticket-${part.kind}-${ticket.id}`}>{part.text}</span>
                  </Fragment>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs">
              <OwnerBadge ticket={ticket} t={t} />
              <span className="flex min-w-[4.5rem] justify-end"><SlaChip ticket={ticket} /></span>
              <span
                className="w-12 text-right tabular-nums text-muted-foreground"
                title={t('ticketQueueList.ageTitle', { created: formatDateTime(ticket.createdAt), updated: formatDateTime(ticket.updatedAt) })}
                data-testid={`ticket-age-${ticket.id}`}
              >
                {timeAgo(ticket.createdAt, t)}
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
