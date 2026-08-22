import { withBase } from '@/lib/basePath';
import { Receipt } from 'lucide-react';
import { type InvoiceSummary } from '@/lib/api';
import { money, shortDate } from '@/lib/format';
import { STATUS_LABELS, statusTone } from '@/lib/invoiceStatus';
import { depositBadgeState } from '@/lib/invoiceDeposit';
import { cn } from '@/lib/utils';
import { ROW, CELL, TH, PageHeader, StatusMark, EmptyState, ErrorNotice } from './ui';

interface InvoiceListProps {
  invoices: InvoiceSummary[];
  error?: string | null;
}

export function InvoiceList({ invoices, error }: InvoiceListProps) {
  if (error) {
    return <ErrorNotice>{error}</ErrorNotice>;
  }

  // The ledger totals itself, like a real register. Only when every invoice
  // shares one currency — a mixed-currency sum would be a made-up number.
  const currencies = new Set(invoices.map((i) => i.currencyCode));
  const outstanding =
    currencies.size === 1
      ? invoices.reduce((sum, i) => sum + (Number(i.balance) || 0), 0)
      : null;

  return (
    <div>
      <PageHeader title="Invoices" lede="Your account with us, always current." />

      {invoices.length === 0 ? (
        <EmptyState icon={<Receipt className="h-10 w-10" strokeWidth={1.5} />} title="No invoices">
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing on file yet — your first invoice will land here.
          </p>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="block w-full sm:table sm:min-w-[44rem]">
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>Number</th>
                <th scope="col" className={cn(TH, 'text-left')}>Issued</th>
                <th scope="col" className={cn(TH, 'text-left')}>Due</th>
                <th scope="col" className={cn(TH, 'text-right')}>Total</th>
                <th scope="col" className={cn(TH, 'text-right')}>Balance</th>
                <th scope="col" className={cn(TH, 'text-left')}>Status</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {invoices.map((inv) => (
                <tr key={inv.id} className={ROW}>
                  {/* order-* reorders the card: identifier and status share the
                      first line, the balance owed is the largest element, and
                      the totals and dates trail as muted supporting detail. */}
                  <td className={cn(CELL, 'order-1 grow')}>
                    {/* The work's name is how the customer knows the bill; the
                        number is the filing handle and trails muted. */}
                    <a className="font-semibold text-foreground underline-offset-4 hover:underline" href={withBase(`/invoices/${inv.id}`)}>
                      {inv.title || (inv.invoiceNumber ?? inv.id.slice(0, 8))}
                    </a>
                    {inv.title && (
                      <p className="text-figures text-xs text-muted-foreground sm:text-sm">
                        {inv.invoiceNumber ?? inv.id.slice(0, 8)}
                      </p>
                    )}
                  </td>
                  <td className={cn(CELL, 'order-5 text-xs text-muted-foreground sm:text-sm')}>
                    <span className="sm:hidden">Issued </span>
                    <span className="text-figures">{shortDate(inv.issueDate)}</span>
                  </td>
                  <td className={cn(CELL, 'order-6 text-xs text-muted-foreground sm:text-sm')}>
                    <span className="sm:hidden">Due </span>
                    <span className="text-figures">{shortDate(inv.dueDate)}</span>
                  </td>
                  <td
                    className={cn(
                      CELL,
                      'order-4 text-xs text-muted-foreground sm:text-right sm:text-sm sm:text-foreground'
                    )}
                  >
                    <span className="sm:hidden">Total </span>
                    <span className="text-figures">{money(inv.total, inv.currencyCode)}</span>
                  </td>
                  <td className={cn(CELL, 'order-3 basis-full sm:basis-auto sm:text-right sm:text-sm')}>
                    {/* A settled invoice must not headline "$0.00 balance due"
                        on the phone card — lead with what was paid instead. */}
                    {Number(inv.balance) > 0 ? (
                      <>
                        <span className="text-figures font-display text-xl font-semibold sm:text-base">
                          {money(inv.balance, inv.currencyCode)}
                        </span>
                        <span className="ml-1.5 text-xs text-muted-foreground sm:hidden">balance due</span>
                      </>
                    ) : (
                      <>
                        <span className="text-figures font-display text-xl font-semibold text-muted-foreground sm:hidden">
                          {money(inv.total, inv.currencyCode)}
                        </span>
                        <span className="ml-1.5 text-xs text-muted-foreground sm:hidden">paid in full</span>
                        {/* A settled balance is not a serif moment: the money
                            voice speaking "$0.00" dilutes the one figure that
                            matters. Quiet sans, muted. */}
                        <span className="text-figures hidden text-muted-foreground sm:inline sm:text-sm">
                          {money(inv.balance, inv.currencyCode)}
                        </span>
                      </>
                    )}
                  </td>
                  <td className={cn(CELL, 'order-2 shrink-0')}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <StatusMark tone={statusTone(inv.status)}>
                        {STATUS_LABELS[inv.status]}
                      </StatusMark>
                      {/* Deposit is context, not a second state: plain text so
                          the row keeps ONE mark. Unpaid keeps the amber text
                          (the customer should act); paid stays muted. */}
                      {(() => {
                        const deposit = depositBadgeState(inv);
                        if (!deposit) return null;
                        return deposit === 'unpaid' ? (
                          <span className="text-xs font-medium text-warning-on-tint" data-testid="deposit-unpaid-badge">
                            Deposit unpaid
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-muted-foreground" data-testid="deposit-paid-badge">
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
          {outstanding !== null && (
            <div
              className="flex items-baseline justify-between border-t border-border px-4 pt-3.5"
              data-testid="invoice-ledger-foot"
            >
              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {outstanding > 0 ? 'Total outstanding' : 'All settled'}
              </span>
              <span className="text-figures font-display text-lg font-semibold text-foreground">
                {money(outstanding, invoices[0].currencyCode)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default InvoiceList;
