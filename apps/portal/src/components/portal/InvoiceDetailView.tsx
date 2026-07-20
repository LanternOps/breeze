import { withBase } from '@/lib/basePath';
import { useEffect, useState } from 'react';
import { ArrowLeft, AlertCircle, Download, CreditCard } from 'lucide-react';
import { type InvoiceDetail, type InvoiceStatus, buildPortalApiUrl, portalApi } from '@/lib/api';
import { STATUS_LABELS, statusColor } from '@/lib/invoiceStatus';
import { computeChargeNow } from '@/lib/invoiceDeposit';
import { cn } from '@/lib/utils';
import { DocumentPaper, DocumentHeader, DocumentTerms, type DocSeller } from './documentShell';

// Invoice statuses that can be paid online (mirrors the API's PAYABLE set).
const PAYABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(['sent', 'partially_paid', 'overdue']);

interface InvoiceDetailViewProps {
  detail: InvoiceDetail | null;
  error?: string | null;
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

/** Per-line tax amount for the Tax column: taxable lines get lineTotal × rate
 *  rounded to cents; non-taxable lines / a non-positive rate return null (shown
 *  as '—'). The header Tax stays invoice.taxTotal (authoritative). */
function lineTax(lineTotal: string | number, taxable: boolean, rate: number): number | null {
  if (!taxable || !(rate > 0)) return null;
  const cents = Math.round(Number(lineTotal) * 100);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

function shortDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

export function InvoiceDetailView({ detail, error }: InvoiceDetailViewProps) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  // Verify-on-return settle state. 'idle' until we detect the post-Checkout return.
  const [settleState, setSettleState] = useState<'idle' | 'settling' | 'pending'>('idle');

  // Instant settle on return from Stripe Checkout. success_url lands the customer back
  // here as ?paid=1&session_id=cs_… — POST that session to the settle route so the
  // status flips to Paid immediately (the API-key model has no inbound webhook; the
  // reconcile sweep is the eventual backstop). Idempotent, so a stray re-run is safe.
  useEffect(() => {
    if (!detail) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('paid') !== '1') return;
    const sessionId = params.get('session_id');
    if (!sessionId) return;

    const invoiceId = detail.invoice.id;
    let cancelled = false;
    setSettleState('settling');
    void portalApi.settleInvoice(invoiceId, sessionId)
      .then((res) => {
        if (cancelled) return;
        if (res.data?.settled) {
          // Reload WITHOUT the return params (replace, not push) so the page re-fetches
          // fresh server data showing Paid — and a manual refresh won't re-trigger settle.
          window.location.replace(withBase(`/invoices/${invoiceId}`));
        } else {
          // Not yet settled (async method, or instant-settle hiccup) — the sweep will
          // catch it. Tell the customer rather than silently leaving it "Sent".
          setSettleState('pending');
        }
      })
      .catch(() => { if (!cancelled) setSettleState('pending'); });
    return () => { cancelled = true; };
  }, [detail]);

  if (error || !detail) {
    return (
      <div className="text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
        <h3 className="mt-4 text-lg font-medium">Invoice not found</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {error || 'The invoice you are looking for does not exist.'}
        </p>
        <a href={withBase("/invoices")} className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" />
          Back to invoices
        </a>
      </div>
    );
  }

  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;
  const canPay = PAYABLE_STATUSES.has(invoice.status) && Number(invoice.balance) > 0;
  // Deposit-aware charge amount — matches what the server's pay route charges (Task 8),
  // so the button label and the deposit strip never diverge from the actual charge.
  const hasDeposit = invoice.depositDue != null;
  const chargeNow = computeChargeNow({
    depositDue: invoice.depositDue ?? null,
    amountPaid: invoice.amountPaid,
    balance: invoice.balance,
  });
  const payLabel = chargeNow.isDeposit
    ? `Pay deposit ${money(chargeNow.amount, currency)}`
    : `Pay ${money(chargeNow.amount, currency)}`;
  // Per-line Tax column only when this invoice carries tax (mirrors the Tax row).
  const taxRate = invoice.taxRate ? Number(invoice.taxRate) : 0;
  const showTax = Number(invoice.taxTotal) > 0;
  const taxPct = taxRate > 0 ? Number((taxRate * 100).toFixed(3)) : 0;

  const seller = (invoice.sellerSnapshot ?? null) as DocSeller | null;
  const headerDates = [
    { label: 'Issued', value: shortDate(invoice.issueDate) },
    { label: 'Due', value: shortDate(invoice.dueDate) },
  ];

  const payInvoice = async () => {
    if (paying) return;
    setPaying(true);
    setPayError(null);
    const result = await portalApi.payInvoice(invoice.id);
    if (result.data?.url) {
      window.location.href = result.data.url;
      return; // keep the button disabled while the browser navigates to Checkout
    }
    if (result.statusCode === 409) {
      // Terminal condition (online payment unavailable / invoice not payable). Show the
      // server's reason verbatim — "Please try again" would mislead since a retry won't help.
      setPayError(result.error || 'Online payment is not available for this invoice.');
    } else {
      setPayError(result.error || 'Could not start the payment. Please try again.');
    }
    setPaying(false);
  };

  const downloadPdf = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(buildPortalApiUrl(`/portal/invoices/${invoice.id}/pdf`), {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) {
        setDownloadError('Could not download the invoice PDF.');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.invoiceNumber ?? `invoice-${invoice.id}`}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Could not download the invoice PDF.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href={withBase("/invoices")} className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" />
          Back to invoices
        </a>
        <div className="flex flex-wrap items-center gap-2">
          {canPay && (
            <button
              type="button"
              onClick={() => void payInvoice()}
              disabled={paying}
              data-testid="invoice-pay-button"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <CreditCard className="h-4 w-4" />
              {paying ? 'Redirecting…' : payLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => void downloadPdf()}
            disabled={downloading}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50',
              canPay
                ? 'border text-foreground hover:bg-muted'
                : 'bg-primary text-primary-foreground'
            )}
          >
            <Download className="h-4 w-4" />
            {downloading ? 'Preparing…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {settleState === 'settling' && (
        <div className="rounded-md bg-warning/10 p-3 text-sm text-warning" data-testid="invoice-settle-confirming">
          Confirming your payment…
        </div>
      )}
      {settleState === 'pending' && (
        <div className="rounded-md bg-warning/10 p-3 text-sm text-warning" data-testid="invoice-settle-pending">
          Thanks! We're still confirming your payment — this can take a moment. Refresh shortly to see it applied.
        </div>
      )}
      {payError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="invoice-pay-error">{payError}</div>
      )}
      {downloadError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{downloadError}</div>
      )}

      <DocumentPaper testId="invoice-document">
        <DocumentHeader
          seller={seller}
          eyebrow="Invoice"
          title={invoice.invoiceNumber ?? 'Invoice'}
          statusLabel={STATUS_LABELS[invoice.status]}
          statusClass={statusColor(invoice.status)}
          dates={headerDates}
          preparedForLabel="Bill to"
          preparedForName={invoice.billToName ?? undefined}
        />

        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium sm:px-5">Description</th>
                  <th className="px-2 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-2 py-2.5 text-right font-medium">Price</th>
                  {showTax && <th className="px-2 py-2.5 text-right font-medium">Tax</th>}
                  <th className="px-4 py-2.5 text-right font-medium sm:px-5">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, index) => {
                  const tax = showTax ? lineTax(l.lineTotal, l.taxable, taxRate) : null;
                  return (
                  <tr key={`${l.description}-${index}`} className="border-b align-top last:border-0">
                    <td className="px-4 py-3 text-foreground sm:px-5">{l.description}</td>
                    <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{l.quantity}</td>
                    <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{money(l.unitPrice, currency)}</td>
                    {showTax && <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{tax === null ? '—' : money(tax, currency)}</td>}
                    <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-foreground sm:px-5">{money(l.lineTotal, currency)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <section className="flex justify-end">
          <div className="w-full max-w-xs space-y-2.5">
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums text-foreground">{money(invoice.subtotal, currency)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Tax{taxPct ? ` (${taxPct}%)` : ''}</span><span className="tabular-nums text-foreground">{money(invoice.taxTotal, currency)}</span></div>
            <div className="flex justify-between border-t pt-2.5 text-sm"><span className="font-medium text-foreground">Total</span><span className="font-medium tabular-nums text-foreground">{money(invoice.total, currency)}</span></div>
            {Number(invoice.amountPaid) > 0 && (
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-foreground">−{money(invoice.amountPaid, currency)}</span></div>
            )}
            <div className="flex items-baseline justify-between border-t pt-3" style={{ borderColor: 'var(--doc-accent)' }}>
              <span className="text-sm font-semibold text-foreground">Balance due</span>
              <span className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--doc-accent)' }} data-testid="invoice-balance-due">{money(invoice.balance, currency)}</span>
            </div>
            {hasDeposit && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="invoice-deposit-strip">
                {chargeNow.isDeposit ? (
                  <>Deposit of <strong className="text-foreground">{money(invoice.depositDue!, currency)}</strong> due — {money(invoice.amountPaid, currency)} of {money(invoice.total, currency)} paid.</>
                ) : (
                  <>Deposit paid — remaining balance {money(invoice.balance, currency)}.</>
                )}
              </div>
            )}
          </div>
        </section>

        {invoice.notes && <DocumentTerms label="Notes">{invoice.notes}</DocumentTerms>}
        {invoice.termsAndConditions && (
          <DocumentTerms label="Terms & Conditions" testId="invoice-terms-conditions">{invoice.termsAndConditions}</DocumentTerms>
        )}
      </DocumentPaper>
    </div>
  );
}

export default InvoiceDetailView;
