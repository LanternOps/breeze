import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import type { TicketConfig } from '../../lib/ticketConfigApi';
import type { TicketStatus } from './ticketConfig';

// Bulk status options exclude 'resolved': resolving requires a per-ticket
// resolution note, so it stays a per-ticket action (focus view).
const BULK_STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'closed'];

interface Props {
  count: number;
  assignees: Array<{ id: string; name: string | null; email: string }> | null;
  config: TicketConfig | null;
  bulkAssignee: string;
  bulkStatus: string;
  onBulkAssignee: (value: string) => void;
  onBulkStatus: (value: string) => void;
  onSelectAll: () => void;
  onApply: () => void;
  onDelete?: () => void;
  onClear: () => void;
}

function statusLabel(config: TicketConfig | null, status: TicketStatus, t: ReturnType<typeof useTranslation>['t']): string {
  const systemRow = config?.statuses.find((s) => s.coreStatus === status && s.isSystem);
  return systemRow?.name ?? t(/* i18n-dynamic */ `ticketsPage.status.${status}`);
}

/** Slide-up bar at the bottom of the queue while rows are selected (brief §6). */
export default function TicketBulkBar({ count, assignees, config, bulkAssignee, bulkStatus, onBulkAssignee, onBulkStatus, onSelectAll, onApply, onDelete, onClear }: Props) {
  const { t } = useTranslation('tickets');
  return (
    // Reuses the global fade-up keyframes (translate-y + fade) at 180ms ease-out.
    <div
      className="absolute inset-x-0 bottom-0 z-10 border-t bg-background px-3 py-2 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.15)] animate-[fade-up_0.18s_ease-out_both]"
      data-testid="tickets-bulk-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium tabular-nums">{t('ticketsPage.selectedCount', { count })}</span>
        <button
          type="button"
          // Union, not replace: cross-tab selections off-view must survive.
          onClick={onSelectAll}
          data-testid="tickets-bulk-select-all"
          className="text-sm text-primary-ink hover:underline"
        >
          {t('ticketsPage.selectAll')}
        </button>
        <select
          value={bulkAssignee}
          onChange={(e) => onBulkAssignee(e.target.value)}
          aria-label={t('ticketsPage.bulk.assignToAria')}
          data-testid="tickets-bulk-assignee"
          className="h-8 max-w-[150px] rounded-md border bg-background px-2 py-1 text-sm leading-tight"
        >
          <option value="">{t('ticketsPage.bulk.assignTo')}</option>
          <option value="unassign">{t('ticketsPage.bulk.unassign')}</option>
          {(assignees ?? []).map((u) => (
            <option key={u.id} value={u.id}>{u.name || u.email}</option>
          ))}
        </select>
        <select
          value={bulkStatus}
          onChange={(e) => onBulkStatus(e.target.value)}
          aria-label={t('ticketsPage.bulk.setStatusAria')}
          data-testid="tickets-bulk-status"
          className="h-8 max-w-[130px] rounded-md border bg-background px-2 py-1 text-sm leading-tight"
        >
          <option value="">{t('ticketsPage.bulk.setStatus')}</option>
          {BULK_STATUSES.map((s) => (
            <option key={s} value={s}>{statusLabel(config, s, t)}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onApply}
          disabled={!bulkAssignee && !bulkStatus}
          data-testid="tickets-bulk-apply"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('common:actions.apply')}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            data-testid="tickets-bulk-delete"
            className="rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive-ink hover:bg-destructive/10"
          >
            {t('common:actions.delete')}
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          data-testid="tickets-bulk-clear"
          className="ml-auto rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
        >
          {t('ticketsPage.clearSelection')}
        </button>
      </div>
    </div>
  );
}
