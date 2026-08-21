import { withBase } from '@/lib/basePath';
import { FileText, AlertCircle } from 'lucide-react';
import { type QuoteSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

interface QuoteListProps {
  quotes: QuoteSummary[];
  error?: string | null;
}

// Below `sm` the row reflows from a table row into a stacked card — proposals are
// usually opened on a phone from an email, where the old `overflow-hidden` wrapper
// clipped the rightmost columns with no scrollbar. At `sm` and up the real table
// semantics come back. One DOM tree either way, so data-testids stay unique.
const ROW = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:table-row sm:p-0';
const CELL = 'block sm:table-cell sm:px-4 sm:py-3';
const TH = 'px-4 py-3 text-sm font-medium text-muted-foreground';

// 'converted' is shown to the customer as 'Accepted' — the conversion to an
// invoice is an internal detail; from the prospect's point of view they accepted.
const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  converted: 'Accepted',
};

// Foregrounds use the `-on-tint` tokens: the base status tokens are tuned as
// backgrounds and fail WCAG AA when set on their own /10 tint.
function statusColor(status: string): string {
  switch (status) {
    case 'accepted':
    case 'converted':
      return 'bg-success/10 text-success-on-tint';
    case 'declined':
    case 'expired':
      return 'bg-destructive/10 text-destructive-on-tint';
    // Informational, not a warning. A proposal that has merely been sent or
    // opened needs nothing from the customer yet; amber read as "something is
    // wrong" on the recipient's own list. Same inversion fixed in
    // lib/invoiceStatus.ts for a freshly issued invoice.
    case 'viewed':
    case 'sent':
      return 'bg-primary/10 text-primary-on-tint';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function money(value: string | number, currencyCode: string): string {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return safe.toLocaleString('en-US', { style: 'currency', currency: currencyCode || 'USD' });
  } catch {
    return `${safe.toFixed(2)} ${currencyCode || ''}`.trim();
  }
}

function shortDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

export function QuoteList({ quotes, error }: QuoteListProps) {
  if (error) {
    return (
      <div role="alert" className="rounded-md bg-destructive/10 p-4 text-center text-destructive-on-tint">
        <AlertCircle className="mx-auto h-8 w-8" />
        <p className="mt-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Proposals</h2>
      </div>

      {quotes.length === 0 ? (
        <div
          data-testid="portal-quotes-empty"
          className="rounded-md border border-dashed p-8 text-center"
        >
          <FileText className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium">No proposals</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You don't have any proposals yet.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="overflow-x-auto">
            <table className="block w-full sm:table sm:min-w-[38rem]">
              <thead className="hidden bg-muted/50 sm:table-header-group">
                <tr>
                  <th scope="col" className={cn(TH, 'text-left')}>Number</th>
                  <th scope="col" className={cn(TH, 'text-left')}>Issued</th>
                  <th scope="col" className={cn(TH, 'text-left')}>Valid until</th>
                  <th scope="col" className={cn(TH, 'text-right')}>Total</th>
                  <th scope="col" className={cn(TH, 'text-left')}>Status</th>
                </tr>
              </thead>
              <tbody className="block divide-y sm:table-row-group">
                {quotes.map((q) => (
                  <tr key={q.id} data-testid={`quote-row-${q.id}`} className={ROW}>
                    {/* order-* reorders the card: number and status share the first
                        line, the total is the largest element, dates trail muted. */}
                    <td className={cn(CELL, 'order-1 grow')}>
                      <a className="font-medium hover:underline" href={withBase(`/quotes/${q.id}`)}>
                        {q.quoteNumber ?? q.id.slice(0, 8)}
                      </a>
                    </td>
                    <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Issued </span>
                      {shortDate(q.issueDate)}
                    </td>
                    <td className={cn(CELL, 'order-5 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Valid until </span>
                      {shortDate(q.expiryDate)}
                    </td>
                    <td className={cn(CELL, 'order-3 basis-full sm:basis-auto sm:text-right sm:text-sm')}>
                      <span className="text-xl font-semibold sm:text-sm sm:font-normal">
                        {money(q.total, q.currencyCode)}
                      </span>
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <span className={cn('inline-flex rounded-full px-2 py-1 text-xs font-medium', statusColor(q.status))}>
                        {STATUS_LABELS[q.status] ?? q.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default QuoteList;
