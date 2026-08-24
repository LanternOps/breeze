import { quoteStatusTone } from '@/lib/quoteStatus';
import { withBase } from '@/lib/basePath';
import { FileText } from 'lucide-react';
import { type QuoteSummary } from '@/lib/api';
import { money, shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ROW, CELL, TH, PageHeader, StatusMark, EmptyState, ErrorNotice } from './ui';

interface QuoteListProps {
  quotes: QuoteSummary[];
  error?: string | null;
}

// 'converted' is shown to the customer as 'Accepted' — the conversion to an
// invoice is an internal detail; from the prospect's point of view they accepted.
const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  converted: 'Accepted',
  // Without this the `?? status` fallback renders the raw enum "superseded" to
  // the customer. This status only became reachable when revisions shipped.
  superseded: 'Replaced',
};


export function QuoteList({ quotes, error }: QuoteListProps) {
  if (error) {
    return <ErrorNotice>{error}</ErrorNotice>;
  }

  // The ledger totals itself: how many entries still need the customer's hand.
  const awaiting = quotes.filter((q) => q.status === 'sent' || q.status === 'viewed').length;

  return (
    <div>
      <PageHeader
        title="Proposals"
        lede="Work your IT team has prepared for your review and approval."
      />

      {quotes.length === 0 ? (
        <EmptyState
          data-testid="portal-quotes-empty"
          icon={<FileText className="h-10 w-10" strokeWidth={1.5} />}
          title="No proposals"
        >
          <p className="mt-1 text-sm text-muted-foreground">
            When your IT team prepares work for your approval, it appears here.
          </p>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="block w-full sm:table sm:min-w-[38rem]">
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>Number</th>
                <th scope="col" className={cn(TH, 'text-left')}>Issued</th>
                <th scope="col" className={cn(TH, 'text-left')}>Valid until</th>
                <th scope="col" className={cn(TH, 'text-right')}>Total</th>
                <th scope="col" className={cn(TH, 'text-left')}>Status</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {quotes.map((q) => {
                const tone = quoteStatusTone(q.status);
                return (
                  <tr key={q.id} data-testid={`quote-row-${q.id}`} className={ROW}>
                    {/* order-* reorders the card: number and status share the first
                        line, the total is the largest element, dates trail muted. */}
                    <td className={cn(CELL, 'order-1 grow')}>
                      {/* The proposal's name is how the customer knows it; the
                          number is the filing handle and trails muted. */}
                      <a className="font-semibold text-foreground underline-offset-4 hover:underline" href={withBase(`/quotes/${q.id}`)}>
                        {q.title || (q.quoteNumber ?? q.id.slice(0, 8))}
                      </a>
                      {q.title && (
                        <p className="text-figures text-xs text-muted-foreground sm:text-sm">
                          {q.quoteNumber ?? q.id.slice(0, 8)}
                        </p>
                      )}
                    </td>
                    <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Issued </span>
                      <span className="text-figures">{shortDate(q.issueDate)}</span>
                    </td>
                    <td className={cn(CELL, 'order-5 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Valid until </span>
                      <span className="text-figures">{shortDate(q.expiryDate)}</span>
                    </td>
                    <td className={cn(CELL, 'order-3 basis-full sm:basis-auto sm:text-right sm:text-sm')}>
                      <span className="text-figures font-display text-xl font-semibold sm:text-base">
                        {money(q.total, q.currencyCode)}
                      </span>
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <StatusMark tone={tone}>
                        {STATUS_LABELS[q.status] ?? q.status}
                      </StatusMark>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="quote-ledger-foot"
          >
            {awaiting === 0
              ? 'Nothing awaiting your review'
              : awaiting === 1
                ? '1 proposal awaiting your review'
                : `${awaiting} proposals awaiting your review`}
          </div>
        </div>
      )}
    </div>
  );
}

export default QuoteList;
