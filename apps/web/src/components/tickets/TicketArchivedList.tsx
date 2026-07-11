import { memo } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { statusConfig, priorityConfig, type TicketPriority, type TicketStatus, type TicketSummary } from './ticketConfig';
import { type TicketConfig } from '../../lib/ticketConfigApi';
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
type TFunction = ReturnType<typeof useTranslation>['t'];

function timeAgo(iso: string, t: TFunction): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 60) return t('ticketArchivedList.timeAgo.minutes', { count: Math.max(1, Math.floor(mins)) });
  if (mins < 60 * 24) return t('ticketArchivedList.timeAgo.hours', { count: Math.floor(mins / 60) });
  return t('ticketArchivedList.timeAgo.days', { count: Math.floor(mins / (60 * 24)) });
}

function translatedPriorityLabel(config: TicketConfig | null, priority: TicketPriority, t: TFunction): string {
  return config?.priorities[priority]?.label ?? t(`ticketArchivedList.priority.${priority}`);
}

function translatedStatusLabel(config: TicketConfig | null, status: TicketStatus, statusName: string | null | undefined, t: TFunction): string {
  if (statusName) return statusName;
  const systemRow = config?.statuses.find((s) => s.coreStatus === status && s.isSystem);
  return systemRow?.name ?? t(`ticketArchivedList.status.${status}`);
}

function TicketArchivedList({ tickets, loading, config = null, onRestore, restoringIds }: Props) {
  const { t } = useTranslation('tickets');
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
        <p>{t('ticketArchivedList.emptyTitle')}</p>
        <p className="mt-1">{t('ticketArchivedList.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y" aria-label={t('ticketArchivedList.ariaLabel')} data-testid="tickets-archived-list">
      {tickets.map((ticket) => (
        <li key={ticket.id} className="flex items-start gap-3 px-3 py-2.5" data-testid={`ticket-archived-row-${ticket.id}`}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground shrink-0">{ticket.internalNumber ?? '·'}</span>
              <span className="truncate text-sm font-medium">{ticket.subject}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium', priorityConfig[ticket.priority].color)}>
                {translatedPriorityLabel(config, ticket.priority, t)}
              </span>
              <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium', statusConfig[ticket.status].color)}>
                {ticket.statusColor && (
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: ticket.statusColor }} aria-hidden="true" />
                )}
                {translatedStatusLabel(config, ticket.status, ticket.statusName, t)}
              </span>
              <span className="truncate">{ticket.orgName ?? ''}</span>
              {ticket.deletedAt && (
                <span title={formatDateTime(ticket.deletedAt)}>{t('ticketArchivedList.deleted', { relative: timeAgo(ticket.deletedAt, t) })}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRestore(ticket)}
            disabled={restoringIds?.has(ticket.id)}
            data-testid={`ticket-restore-${ticket.id}`}
            className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {restoringIds?.has(ticket.id) ? t('ticketArchivedList.restoring') : t('ticketArchivedList.restore')}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Memoized for parity with TicketQueueList: the host re-renders on unrelated
// state (search box, reconcile timers) and the archived list can carry 100 rows.
export default memo(TicketArchivedList);
