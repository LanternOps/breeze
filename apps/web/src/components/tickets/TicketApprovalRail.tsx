import { useTranslation } from 'react-i18next';
import { notifyApprovalChanged, useTicketApprovalSummary } from '../../lib/ticketApproval';
import TicketBudgetCard from './TicketBudgetCard';
import TicketApprovalsPanel from './TicketApprovalsPanel';

/**
 * Rail section for customer work approval (#8196): one summary fetch shared by
 * the budget card and the approvals panel. Mutations broadcast the billing
 * event, which reloads this summary, the time list and the workbench feed.
 */
export default function TicketApprovalRail({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation('tickets');
  const { summary, error, reload } = useTicketApprovalSummary(ticketId);
  if (!summary && !error) return null;
  return (
    <>
      {error && (
        <div
          data-testid="ticket-approval-load-error"
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <span>{t('ticketApproval.loadError')}</span>
          <button
            type="button"
            data-testid="ticket-approval-retry"
            onClick={() => void reload()}
            className="rounded border border-destructive/40 px-2 py-0.5 font-medium hover:bg-destructive/10"
          >
            {t('ticketApproval.retry')}
          </button>
        </div>
      )}
      {summary && (
        <>
          <TicketBudgetCard ticketId={ticketId} summary={summary} onChanged={notifyApprovalChanged} />
          <TicketApprovalsPanel summary={summary} onChanged={notifyApprovalChanged} />
        </>
      )}
    </>
  );
}
