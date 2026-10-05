import { Fragment } from 'react';
import { lineWorkedVsBilledNote } from '@/lib/api';
import { groupInvoiceLinesByTicket } from '@/lib/invoiceLineGroups';
import { money } from '@/lib/money';

/**
 * The invoice paper's line table and totals, shared by the public (emailed link)
 * and portal invoice pages so the same invoice reads the same on both (visual QA
 * 2026-10-05: V-6 phone clipping, V-26 balance figure faces).
 */
export interface PaperLine {
  ticketNumber: string | null;
  ticketCategory?: string | null;
  name?: string | null;
  description?: string | null;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxable: boolean;
  workedMinutes?: number | null;
}

/** Per-line tax amount (same derivation as the API's invoice PDF). */
export function lineTax(lineTotal: string | number, taxable: boolean, rate: number): number | null {
  if (!taxable || !(rate > 0)) return null;
  const cents = Math.round(Number(lineTotal) * 100);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

const NUM = 'hidden whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground sm:table-cell';

export function InvoiceLineTable({ lines, currency, taxRate, showTax, showLineTicket = false }: {
  lines: PaperLine[]; currency: string; taxRate: number; showTax: boolean;
  /** The portal also names each line's ticket under its description. */
  showLineTicket?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium sm:px-5">Description</th>
              <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Qty</th>
              <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Price</th>
              {showTax && <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">Tax</th>}
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-medium sm:px-5">Amount</th>
            </tr>
          </thead>
          <tbody>
            {groupInvoiceLinesByTicket(lines).map(group => (
              <Fragment key={group.key}>
                {group.ticketNumber && (
                  <tr className="border-b bg-muted/30">
                    <td colSpan={showTax ? 5 : 4} className="px-4 py-2 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-foreground">{`Ticket #${group.ticketNumber}`}</span>
                        {group.ticketCategory && (
                          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{group.ticketCategory}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                {group.lines.map(l => {
                  const index = lines.indexOf(l);
                  const tax = showTax ? lineTax(l.lineTotal, l.taxable, taxRate) : null;
                  const title = (l.name ?? l.description ?? '').trim() || '—';
                  const blurb = l.name ? (l.description ?? '').trim() : '';
                  // #6467: worked-vs-billed disclosure (§3.5), from structured data, never `description`.
                  const note = lineWorkedVsBilledNote(l);
                  return (
                    <tr key={`${title}-${index}`} className="border-b align-top last:border-0">
                      {/* V-6: an unbroken token (a URL, a part number) wraps instead of pushing the
                          Amount column out of the paper at phone width. */}
                      <td className="w-full min-w-0 px-4 py-3 text-foreground [overflow-wrap:anywhere] sm:px-5">
                        {title}
                        {/* P-7: on phones Qty and Price fold under the description instead of clipping the table. */}
                        <div className="mt-0.5 text-xs tabular-nums text-muted-foreground sm:hidden" data-testid={`invoice-line-qty-${index}`}>{l.quantity} × {money(l.unitPrice, currency)}</div>
                        {blurb && <div className="mt-0.5 text-xs text-muted-foreground">{blurb}</div>}
                        {note && <div className="mt-0.5 text-xs text-muted-foreground" data-testid={`invoice-line-worked-vs-billed-${index}`}>{note}</div>}
                        {showLineTicket && l.ticketNumber && (
                          <div className="mt-0.5 text-xs text-muted-foreground" data-testid={`invoice-line-ticket-${index}`}>Ticket #{l.ticketNumber}</div>
                        )}
                      </td>
                      <td className={NUM}>{l.quantity}</td>
                      <td className={NUM}>{money(l.unitPrice, currency)}</td>
                      {showTax && <td className={NUM}>{tax === null ? '—' : money(tax, currency)}</td>}
                      <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-foreground sm:px-5">{money(l.lineTotal, currency)}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function InvoiceTotals({ currency, subtotal, taxTotal, taxPct, total, amountPaid, balance, paid, deposit, testIds }: {
  currency: string; subtotal: string | number; taxTotal: string | number; taxPct: number; total: string | number;
  amountPaid: string | number; balance: string | number; paid: boolean;
  /** Shown when the invoice carries a deposit and is not paid. */
  deposit: { due: string; isDeposit: boolean } | null;
  testIds: { balance: string; deposit: string };
}) {
  return (
    <section className="flex justify-end">
      <div className="w-full max-w-xs space-y-2.5">
        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums text-foreground">{money(subtotal, currency)}</span></div>
        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Tax{taxPct ? ` (${taxPct}%)` : ''}</span><span className="tabular-nums text-foreground">{money(taxTotal, currency)}</span></div>
        <div className="flex justify-between border-t pt-2.5 text-sm"><span className="font-medium text-foreground">Total</span><span className="font-medium tabular-nums text-foreground">{money(total, currency)}</span></div>
        {Number(amountPaid) > 0 && (
          <div className="flex justify-between text-sm"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-foreground">−{money(amountPaid, currency)}</span></div>
        )}
        <div className="doc-accent-border flex items-baseline justify-between gap-3 border-t pt-3">
          <span className="text-sm font-semibold text-foreground">{paid ? 'Balance' : 'Balance due'}</span>
          {/* V-26: the hero balance speaks the serif (DESIGN.md), on both pages. */}
          <span className="doc-accent-text font-display text-2xl font-semibold tabular-nums" data-testid={testIds.balance}>{money(balance, currency)}</span>
        </div>
        {deposit && !paid && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid={testIds.deposit}>
            {deposit.isDeposit ? (
              <>Deposit of <strong className="text-foreground">{money(deposit.due, currency)}</strong> due — {money(amountPaid, currency)} of {money(total, currency)} paid.</>
            ) : (
              <>Deposit paid — remaining balance {money(balance, currency)}.</>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
