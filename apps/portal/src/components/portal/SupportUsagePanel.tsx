import type { SupportUsageDto } from '@breeze/shared';
import { ErrorNotice } from './ui';

export function SupportUsagePanel({
  usage,
  error,
}: {
  usage: SupportUsageDto | null;
  error?: string;
}) {
  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!usage) return null;

  if (usage.dataStatus === 'no_data') {
    return (
      <section data-testid="portal-support-usage">
        <h2>Support usage</h2>
        <p>{usage.month} · {usage.timezone}</p>
        <p data-testid="portal-support-usage-empty">
          No billable support time has been recorded this month.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="portal-support-usage">
      <h2>Support usage</h2>
      <p>{usage.month} · {usage.timezone}</p>
      <dl>
        <div data-testid="portal-support-usage-billed">
          <dt>Billed</dt>
          <dd>{usage.totals.billed.minutes} minutes ({usage.totals.billed.hours} hours)</dd>
        </div>
        <div data-testid="portal-support-usage-to-be-billed">
          <dt>To be billed</dt>
          <dd>{usage.totals.toBeBilled.minutes} minutes ({usage.totals.toBeBilled.hours} hours)</dd>
        </div>
        <div data-testid="portal-support-usage-contract">
          <dt>Covered by contract</dt>
          <dd>{usage.totals.coveredByContract.minutes} minutes ({usage.totals.coveredByContract.hours} hours)</dd>
        </div>
        <div data-testid="portal-support-usage-pending">
          <dt>Pending review</dt>
          <dd>{usage.totals.pendingReview.minutes} minutes ({usage.totals.pendingReview.hours} hours)</dd>
        </div>
      </dl>
      <table>
        <tbody>
          {usage.tickets.map((ticket) => (
            <tr
              key={ticket.ticketNumber}
              data-testid={`portal-support-usage-ticket-${ticket.ticketNumber}`}
            >
              <td>{ticket.title ?? `Ticket #${ticket.ticketNumber}`}</td>
              <td>{ticket.billedMinutes}</td>
              <td>{ticket.toBeBilledMinutes}</td>
              <td>{ticket.coveredByContractMinutes}</td>
              <td>{ticket.pendingReviewMinutes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
