import { memo } from 'react';
import { cn } from '@/lib/utils';
import { statusConfig, priorityConfig, type TicketSummary } from './ticketConfig';
import { priorityLabel, statusLabel, type TicketConfig } from '../../lib/ticketConfigApi';
import { formatDateTime } from '@/lib/dateTimeFormat';

interface Props {
  tickets: TicketSummary[];
  loading: boolean;
  /** Ticket config for custom-status names/colors and priority labels; null falls back to core config. */
  config?: TicketConfig | null;
  /** Restore a soft-deleted ticket (POST /tickets/:id/restore, wrapped in runAction by the host). */
  onRestore: (t: TicketSummary) => void;
  /** Ids with an in-flight restore — disables their button so a double-click can't double-POST. */
  restoringIds?: Set<string>;
}

// Local twin of TicketQueueList.timeAgo — "deleted 3d ago" reads relative to the
// soft-delete stamp. Duplicated (per CLAUDE.md) to keep this surface self-contained.
function timeAgo(iso: string): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 60) return `${Math.max(1, Math.floor(mins))}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function TicketArchivedList({ tickets, loading, config = null, onRestore, restoringIds }: Props) {
  if (loading && tickets.length === 0) {
    return (
      <div className="divide-y" data-testid="tickets-archived-loading">
        {Array.from({ length: 6 }).map((_, i) => (
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
      <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="tickets-archived-empty">
        <p>No archived tickets.</p>
        <p className="mt-1">Deleted tickets land here. Restore one to return it to the live queues.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y" aria-label="Archived tickets" data-testid="tickets-archived-list">
      {tickets.map((t) => (
        <li key={t.id} className="flex items-start gap-3 px-3 py-2.5" data-testid={`ticket-archived-row-${t.id}`}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground shrink-0">{t.internalNumber ?? '·'}</span>
              <span className="truncate text-sm font-medium">{t.subject}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium', priorityConfig[t.priority].color)}>
                {priorityLabel(config, t.priority)}
              </span>
              <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium', statusConfig[t.status].color)}>
                {t.statusColor && (
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: t.statusColor }} aria-hidden="true" />
                )}
                {statusLabel(config, t.status, t.statusName)}
              </span>
              <span className="truncate">{t.orgName ?? ''}</span>
              {t.deletedAt && (
                <span title={formatDateTime(t.deletedAt)}>deleted {timeAgo(t.deletedAt)}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRestore(t)}
            disabled={restoringIds?.has(t.id)}
            data-testid={`ticket-restore-${t.id}`}
            className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {restoringIds?.has(t.id) ? 'Restoring…' : 'Restore'}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Memoized for parity with TicketQueueList: the host re-renders on unrelated
// state (search box, reconcile timers) and the archived list can carry 100 rows.
export default memo(TicketArchivedList);
