import { FileText, AlertCircle } from 'lucide-react';
import { type QuoteSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

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
};

function statusColor(status: string): string {
  switch (status) {
    case 'accepted':
    case 'converted':
      return 'bg-success/10 text-success';
    case 'declined':
    case 'expired':
      return 'bg-destructive/10 text-destructive';
    case 'viewed':
    case 'sent':
      return 'bg-warning/10 text-warning';
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
      <div className="rounded-md bg-destructive/10 p-4 text-center text-destructive">
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
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Number</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Issued</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Valid until</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">Total</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {quotes.map((q) => (
                <tr key={q.id} data-testid={`quote-row-${q.id}`} className="hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <a className="font-medium hover:underline" href={`/quotes/${q.id}`}>
                      {q.quoteNumber ?? q.id.slice(0, 8)}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{shortDate(q.issueDate)}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{shortDate(q.expiryDate)}</td>
                  <td className="px-4 py-3 text-right text-sm">{money(q.total, q.currencyCode)}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex rounded-full px-2 py-1 text-xs font-medium', statusColor(q.status))}>
                      {STATUS_LABELS[q.status] ?? q.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default QuoteList;
