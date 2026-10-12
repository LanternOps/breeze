import { notifyApprovalChanged, useTicketApprovalSummary } from '../../lib/ticketApproval';
import TicketBudgetCard from './TicketBudgetCard';
import TicketApprovalsPanel from './TicketApprovalsPanel';

/**
 * Rail section for customer work approval (#8196): one summary fetch shared by
 * the budget card and the approvals panel. Mutations broadcast the billing
 * event, which reloads this summary, the time list and the workbench feed.
 */
export default function TicketApprovalRail({ ticketId }: { ticketId: string }) {
  const { summary } = useTicketApprovalSummary(ticketId);
  if (!summary) return null;
  return (
    <>
      <TicketBudgetCard ticketId={ticketId} summary={summary} onChanged={notifyApprovalChanged} />
      <TicketApprovalsPanel summary={summary} onChanged={notifyApprovalChanged} />
    </>
  );
}
