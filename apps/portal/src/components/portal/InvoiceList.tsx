import { withBase } from '@/lib/basePath';
import { Receipt, AlertCircle } from 'lucide-react';
import { type InvoiceSummary } from '@/lib/api';
import { STATUS_LABELS, statusColor } from '@/lib/invoiceStatus';
import { depositBadgeState } from '@/lib/invoiceDeposit';
import { cn } from '@/lib/utils';

interface InvoiceListProps {
  invoices: InvoiceSummary[];
  error?: string | null;
}

// Below `sm` the row reflows from a table row into a stacked card. Portal readers
// usually open an invoice on a phone from an email, where six columns either clip
// (the old `overflow-hidden` wrapper hid Status entirely) or demand sideways
// scrolling. At `sm` and up the real table semantics come back — this is a CSS
// reflow of ONE DOM tree, not a duplicate mobile list, so every data-testid and
// every `scope="col"` header stays unique.
const ROW = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:table-row sm:p-0';
const CELL = 'block sm:table-cell sm:px-4 sm:py-3';
const TH = 'px-4 py-3 text-sm font-medium text-muted-foreground';

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

export function InvoiceList({ invoices, error }: InvoiceListProps) {
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
        <h2 className="text-lg font-semibold">Invoices</h2>
      </div>

      {invoices.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center">
          <Receipt className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium">No invoices</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You don't have any invoices yet.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="overflow-x-auto">
            <table className="block w-full sm:table sm:min-w-[44rem]">
              <thead className="hidden bg-muted/50 sm:table-header-group">
                <tr>
                  <th scope="col" className={cn(TH, 'text-left')}>Number</th>
                  <th scope="col" className={cn(TH, 'text-left')}>Issued</th>
                  <th scope="col" className={cn(TH, 'text-left')}>Due</th>
                  <th scope="col" className={cn(TH, 'text-right')}>Total</th>
                  <th scope="col" className={cn(TH, 'text-right')}>Balance</th>
                  <th scope="col" className={cn(TH, 'text-left')}>Status</th>
                </tr>
              </thead>
              <tbody className="block divide-y sm:table-row-group">
                {invoices.map((inv) => (
                  <tr key={inv.id} className={ROW}>
                    {/* order-* reorders the card: identifier and status share the
                        first line, the balance owed is the largest element, and
                        the totals and dates trail as muted supporting detail. */}
                    <td className={cn(CELL, 'order-1 grow')}>
                      <a className="font-medium hover:underline" href={withBase(`/invoices/${inv.id}`)}>
                        {inv.invoiceNumber ?? inv.id.slice(0, 8)}
                      </a>
                    </td>
                    <td className={cn(CELL, 'order-5 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Issued </span>
                      {shortDate(inv.issueDate)}
                    </td>
                    <td className={cn(CELL, 'order-6 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Due </span>
                      {shortDate(inv.dueDate)}
                    </td>
                    <td
                      className={cn(
                        CELL,
                        'order-4 text-xs text-muted-foreground sm:text-right sm:text-sm sm:text-foreground'
                      )}
                    >
                      <span className="sm:hidden">Total </span>
                      {money(inv.total, inv.currencyCode)}
                    </td>
                    <td className={cn(CELL, 'order-3 basis-full sm:basis-auto sm:text-right sm:text-sm')}>
                      <span className="text-xl font-semibold sm:text-sm sm:font-normal">
                        {money(inv.balance, inv.currencyCode)}
                      </span>
                      <span className="ml-1.5 text-xs text-muted-foreground sm:hidden">balance due</span>
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn('inline-flex rounded-full px-2 py-1 text-xs font-medium', statusColor(inv.status))}>
                          {STATUS_LABELS[inv.status]}
                        </span>
                        {(() => {
                          const deposit = depositBadgeState(inv);
                          if (!deposit) return null;
                          return deposit === 'unpaid' ? (
                            <span className="inline-flex rounded-full px-2 py-1 text-xs font-medium bg-warning/10 text-warning-on-tint" data-testid="deposit-unpaid-badge">
                              Deposit unpaid
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full px-2 py-1 text-xs font-medium bg-success/10 text-success-on-tint" data-testid="deposit-paid-badge">
                              Deposit paid
                            </span>
                          );
                        })()}
                      </div>
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

export default InvoiceList;
