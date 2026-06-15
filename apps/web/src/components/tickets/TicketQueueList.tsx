import { memo } from 'react';
import { cn } from '@/lib/utils';
import SlaChip from './SlaChip';
import { statusConfig, priorityConfig, type TicketSummary } from './ticketConfig';
import { priorityLabel, statusLabel, type TicketConfig } from '../../lib/ticketConfigApi';

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
}

function timeAgo(iso: string): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 60) return `${Math.max(1, Math.floor(mins))}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function TicketQueueList({ tickets, selectedId, onSelect, loading, config = null, onClearFilters, bulkSelectedIds, onToggleSelect }: Props) {
  const anyBulkSelected = (bulkSelectedIds?.size ?? 0) > 0;

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
        <p>No tickets match.</p>
        {onClearFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            data-testid="tickets-filters-clear"
            className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Clear filters
          </button>
        )}
      </div>
    );
  }

  return (
    <ul className="divide-y" role="listbox" aria-label="Ticket queue" data-testid="tickets-queue">
      {tickets.map((t) => (
        <li key={t.id} className="group relative">
          {/* Sibling of the row button (not nested) so checkbox clicks never trigger
              row selection. Hidden until row hover or an active selection (brief §6). */}
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={bulkSelectedIds?.has(t.id) ?? false}
              onChange={() => onToggleSelect(t.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${t.internalNumber ?? t.subject}`}
              data-testid={`ticket-select-${t.id}`}
              className={cn(
                'absolute left-2 top-3 z-10 h-4 w-4 cursor-pointer accent-primary transition-opacity',
                anyBulkSelected || bulkSelectedIds?.has(t.id)
                  ? 'opacity-100'
                  : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
              )}
            />
          )}
          <button
            type="button"
            role="option"
            aria-selected={t.id === selectedId}
            onClick={() => onSelect(t)}
            data-testid={`ticket-row-${t.id}`}
            className={cn(
              'w-full px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              onToggleSelect && 'pl-8', // reserve the checkbox gutter
              t.id === selectedId && 'bg-primary/5 border-l-0' // selection tint; brand color reserved for selection
            )}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground shrink-0">{t.internalNumber ?? '·'}</span>
              <span className="truncate text-sm font-medium">{t.subject}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium', priorityConfig[t.priority].color)}
              >
                {priorityLabel(config, t.priority)}
              </span>
              <span
                className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium', statusConfig[t.status].color)}
              >
                {t.statusColor && (
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: t.statusColor }}
                    aria-hidden="true"
                  />
                )}
                {statusLabel(config, t.status, t.statusName)}
              </span>
              <span className="truncate">{t.orgName ?? ''}</span>
              <span className="ml-auto shrink-0 flex items-center gap-2">
                <SlaChip ticket={t} />
                <span title={new Date(t.updatedAt).toLocaleString()}>{timeAgo(t.updatedAt)}</span>
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Memoized: the parent (TicketsPage) re-renders on unrelated state (search box,
// bulk menu, reconcile timers); without this the whole list (up to 100 rows)
// re-renders on every keystroke and every background refresh.
export default memo(TicketQueueList);
