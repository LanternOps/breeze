import type { SupportUsageDto } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { ROW, CELL, TH, ErrorNotice } from './ui';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The API sends the period as a `YYYY-MM` key. "2026-09" is a database value,
 * not something a customer's office manager reads on a billing summary.
 */
export function formatUsageMonth(month: string): string {
  const parsed = /^(\d{4})-(\d{2})$/.exec(month);
  if (!parsed) return month;
  const index = Number(parsed[2]) - 1;
  if (index < 0 || index > 11) return month;
  return `${MONTH_NAMES[index]} ${parsed[1]}`;
}

/**
 * The zone the API sends is the org's own effective timezone, which is the
 * reader's obvious default — naming it is noise. 'UTC' is the fallback the
 * chain lands on when nobody configured one, so it is the one case where the
 * month's boundaries are probably NOT the reader's and saying so is honest.
 */
export function usagePeriodLabel(month: string, timezone: string): string {
  const formatted = formatUsageMonth(month);
  return timezone === 'UTC' ? `${formatted} (UTC)` : formatted;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function minutesLabel(minutes: number, hours: number): string {
  return `${plural(minutes, 'minute')} (${plural(hours, 'hour')})`;
}

function SectionHeading({ usage }: { usage: SupportUsageDto }) {
  return (
    <div className="mb-4">
      <h2 className="font-display text-lg font-semibold text-foreground">
        Support time
      </h2>
      <p
        className="mt-1 text-sm text-muted-foreground"
        data-testid="portal-support-usage-period"
      >
        {usagePeriodLabel(usage.month, usage.timezone)}
      </p>
    </div>
  );
}

/** The four buckets, as a ruled summary rather than a definition list adrift
 *  above an unlabeled table. */
function Totals({ usage }: { usage: SupportUsageDto }) {
  const rows = [
    { key: 'billed', label: 'Billed', value: usage.totals.billed },
    { key: 'to-be-billed', label: 'To be billed', value: usage.totals.toBeBilled },
    { key: 'contract', label: 'Covered by contract', value: usage.totals.coveredByContract },
    { key: 'pending', label: 'Pending review', value: usage.totals.pendingReview },
  ] as const;

  return (
    <dl className="mb-8 divide-y divide-border/70 border-y border-border/70">
      {rows.map((row) => (
        <div
          key={row.key}
          className="flex items-baseline justify-between gap-4 px-4 py-3"
          data-testid={`portal-support-usage-${row.key}`}
        >
          <dt className="text-sm text-muted-foreground">{row.label}</dt>
          <dd className="text-figures text-sm font-medium text-foreground">
            {minutesLabel(row.value.minutes, row.value.hours)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

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
        <SectionHeading usage={usage} />
        <div className="border-y border-border/70 px-4 py-8">
          <p
            className="text-sm text-muted-foreground"
            data-testid="portal-support-usage-empty"
          >
            No billable support time has been recorded this month.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="portal-support-usage">
      <SectionHeading usage={usage} />
      <Totals usage={usage} />

      <div className="overflow-x-auto">
        <table
          className="block w-full sm:table sm:min-w-[36rem]"
          data-testid="portal-support-usage-tickets"
        >
          {/* Five minute columns with no header is a billing figure the reader
              has to guess at — every column names itself. */}
          <thead className="hidden border-b border-border sm:table-header-group">
            <tr>
              <th scope="col" className={cn(TH, 'text-left')}>Request</th>
              <th scope="col" className={cn(TH, 'text-right')}>Billed</th>
              <th scope="col" className={cn(TH, 'text-right')}>To be billed</th>
              <th scope="col" className={cn(TH, 'text-right')}>Covered</th>
              <th scope="col" className={cn(TH, 'text-right')}>Pending review</th>
            </tr>
          </thead>
          <tbody className="block divide-y divide-border/70 sm:table-row-group">
            {usage.tickets.map((ticket) => (
              <tr
                key={ticket.ticketNumber}
                className={ROW}
                data-testid={`portal-support-usage-ticket-${ticket.ticketNumber}`}
              >
                <td className={cn(CELL, 'order-1 basis-full font-medium text-foreground sm:basis-auto')}>
                  {ticket.title ?? `Ticket #${ticket.ticketNumber}`}
                </td>
                <td className={cn(CELL, 'order-2 text-xs text-muted-foreground sm:text-right sm:text-sm')}>
                  <span className="sm:hidden">Billed </span>
                  <span className="text-figures">{ticket.billedMinutes} min</span>
                </td>
                <td className={cn(CELL, 'order-3 text-xs text-muted-foreground sm:text-right sm:text-sm')}>
                  <span className="sm:hidden">To be billed </span>
                  <span className="text-figures">{ticket.toBeBilledMinutes} min</span>
                </td>
                <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-right sm:text-sm')}>
                  <span className="sm:hidden">Covered </span>
                  <span className="text-figures">{ticket.coveredByContractMinutes} min</span>
                </td>
                <td className={cn(CELL, 'order-5 text-xs text-muted-foreground sm:text-right sm:text-sm')}>
                  <span className="sm:hidden">Pending review </span>
                  <span className="text-figures">{ticket.pendingReviewMinutes} min</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default SupportUsagePanel;
