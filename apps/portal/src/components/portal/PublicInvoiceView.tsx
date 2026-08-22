import { useEffect, useState } from 'react';
import { CreditCard, Download } from 'lucide-react';
import { withBase } from '@/lib/basePath';
import { portalApi, buildPortalApiUrl, type PublicInvoiceDetail } from '@/lib/api';
import { STATUS_LABELS, statusTone } from '@/lib/invoiceStatus';
import { DocumentPaper, DocumentHeader, DocumentTerms, type DocSeller } from './documentShell';
import { money } from '@/lib/money';

/**
 * The public (token-gated) invoice page — the customer's durable no-login
 * view-and-pay view, mirroring PublicQuoteView's composition and reusing the
 * authenticated InvoiceDetailView's table/totals rhythm. The MSP is the brand;
 * the platform stays anonymous (matching the email envelope).
 *
 * States (spec §4): payable (deposit-aware Pay CTA) · paid (calm confirmation)
 * · overdue (amber banner, still payable) · void (no amounts, contact line) ·
 * online-payment-unavailable (view + PDF only). ?paid=1 / ?pending=1 arrive
 * from the checkout-return page (InvoiceReturn) after settle.
 */

interface PublicInvoiceViewProps {
  token: string;
  /** Test seam — production always fetches client-side (see [token].astro:
   *  SSR fetches would share one rate-limit slot for every customer). */
  initial?: PublicInvoiceDetail | null;
  error?: string | null;
}


function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

/** Per-line tax amount — same derivation as InvoiceDetailView.lineTax. */
function lineTax(lineTotal: string | number, taxable: boolean, rate: number): number | null {
  if (!taxable || !(rate > 0)) return null;
  const cents = Math.round(Number(lineTotal) * 100);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

export function PublicInvoiceView({ token, initial = null, error }: PublicInvoiceViewProps) {
  const [detail, setDetail] = useState<PublicInvoiceDetail | null>(initial);
  const [loadError, setLoadError] = useState<string | null>(error ?? null);
  const [loading, setLoading] = useState(initial == null && !error);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Client-side fetch (see [token].astro). A 401 gets ONE generic message —
  // never a login redirect for an anonymous customer.
  useEffect(() => {
    if (detail || loadError) return;
    let cancelled = false;
    void portalApi.getPublicInvoice(token, { redirectOnUnauthorized: false })
      .then((res) => {
        if (cancelled) return;
        if (res.data?.data) setDetail(res.data.data);
        else setLoadError(res.statusCode === 401 ? '' : (res.error || ''));
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setLoadError(''); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div data-testid="public-invoice-loading" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">
        Loading invoice…
      </div>
    );
  }
  if (loadError != null || !detail) {
    return (
      <div data-testid="public-invoice-error" className="mx-auto max-w-lg p-8 text-center">
        <p className="text-sm text-destructive">
          {loadError || 'This invoice link is invalid or has expired. Please contact the sender for a new one.'}
        </p>
      </div>
    );
  }

  const { invoice, lines, chargeNow, payable, branding } = detail;
  const returnFlag = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const justPaid = returnFlag.get('paid') === '1';
  const paymentPending = returnFlag.get('pending') === '1';

  // ---- Void: the calm no-amounts state -------------------------------------
  if (invoice.status === 'void') {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-5 p-2 sm:p-4">
        <DocumentPaper primaryColor={branding.primaryColor} testId="public-invoice-void" docTheme={branding.theme}>
          <DocumentHeader
            logoUrl={branding.logoUrl}
            partnerName={branding.partnerName}
            seller={null}
            eyebrow="Invoice"
            title={invoice.invoiceNumber ?? 'Invoice'}
            statusLabel="No longer due"
            statusTone="neutral"
            dates={[]}
          />
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>This invoice is no longer due.</p>
            {invoice.replaced && <p>An updated invoice has been issued — please use the link in its email.</p>}
            {branding.contactEmail && (
              <p>
                Questions? Contact{' '}
                <a href={`mailto:${branding.contactEmail}`} className="text-primary hover:underline">{branding.contactEmail}</a>.
              </p>
            )}
          </div>
        </DocumentPaper>
      </div>
    );
  }

  const currency = invoice.currencyCode ?? 'USD';
  const isPaid = invoice.status === 'paid';
  const isOverdue = invoice.status === 'overdue';
  const hasDeposit = invoice.depositDue != null;
  const taxRate = invoice.taxRate ? Number(invoice.taxRate) : 0;
  const showTax = Number(invoice.taxTotal ?? 0) > 0;
  const taxPct = taxRate > 0 ? Number((taxRate * 100).toFixed(3)) : 0;
  const seller = (invoice.sellerSnapshot ?? null) as DocSeller | null;
  const canPay = payable && chargeNow != null && !justPaid && !paymentPending;
  const payLabel = chargeNow?.isDeposit
    ? `Pay deposit ${money(chargeNow.amount, currency)}`
    : `Pay ${money(chargeNow?.amount ?? 0, currency)}`;

  const headerDates = [
    { label: 'Issued', value: shortDate(invoice.issueDate ?? null) },
    { label: 'Due', value: shortDate(invoice.dueDate ?? null) },
  ];

  const pay = async () => {
    if (paying) return;
    setPaying(true);
    setPayError(null);
    const res = await portalApi.payPublicInvoice(token);
    if (res.data?.data?.url) {
      window.location.href = res.data.data.url;
      return; // keep the button disabled while the browser navigates to Checkout
    }
    // 409 is terminal (online payment unavailable / not payable) — show the
    // server's reason verbatim; "try again" would mislead.
    setPayError(res.error || 'Could not start the payment. Please try again.');
    setPaying(false);
  };

  const downloadPdf = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(buildPortalApiUrl(`/invoices/public/${encodeURIComponent(token)}/pdf`));
      if (!res.ok) { setDownloadError('Could not download the invoice PDF.'); return; }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.invoiceNumber ?? 'invoice'}.pdf`;
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
    <div className="mx-auto w-full max-w-3xl space-y-5 p-2 sm:p-4">
      {/* Amount panel + actions — the reason the customer is here, above the paper. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canPay && (
          <button
            type="button"
            onClick={() => void pay()}
            disabled={paying}
            data-testid="public-invoice-pay"
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
          data-testid="public-invoice-download"
          className={
            canPay
              ? 'inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50'
              : 'inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
          }
        >
          <Download className="h-4 w-4" />
          {downloading ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>

      {(justPaid || isPaid) && (
        <div className="rounded-md bg-success/10 p-3 text-sm text-success" data-testid="public-invoice-paid-banner">
          {isPaid
            ? `Paid${invoice.paidAt ? ` on ${shortDate(invoice.paidAt)}` : ''} — thank you! You can download a copy for your records below.`
            : 'Payment received — thank you! It may take a moment to appear on the invoice.'}
        </div>
      )}
      {paymentPending && !isPaid && (
        <div className="rounded-md bg-warning/10 p-3 text-sm text-warning" data-testid="public-invoice-pending-banner">
          Thanks! We're still confirming your payment — this can take a moment. Refresh shortly to see it applied.
        </div>
      )}
      {isOverdue && !justPaid && (
        <div className="rounded-md bg-warning/10 p-3 text-sm text-warning" data-testid="public-invoice-overdue-banner">
          This invoice was due {shortDate(invoice.dueDate ?? null)}.
        </div>
      )}
      {payError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="public-invoice-pay-error">{payError}</div>
      )}
      {downloadError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{downloadError}</div>
      )}

      <DocumentPaper primaryColor={branding.primaryColor} testId="public-invoice" docTheme={branding.theme}>
        <DocumentHeader
          logoUrl={branding.logoUrl}
          partnerName={branding.partnerName}
          seller={seller}
          eyebrow="Invoice"
          title={invoice.invoiceNumber ?? 'Invoice'}
          statusLabel={STATUS_LABELS[invoice.status] ?? invoice.status}
          statusTone={statusTone(invoice.status)}
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
                  const title = (l.name ?? l.description ?? '').trim() || '—';
                  const blurb = l.name ? (l.description ?? '').trim() : '';
                  return (
                    <tr key={`${title}-${index}`} className="border-b align-top last:border-0">
                      <td className="px-4 py-3 text-foreground sm:px-5">
                        {title}
                        {blurb && <div className="mt-0.5 text-xs text-muted-foreground">{blurb}</div>}
                      </td>
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
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums text-foreground">{money(invoice.subtotal ?? 0, currency)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Tax{taxPct ? ` (${taxPct}%)` : ''}</span><span className="tabular-nums text-foreground">{money(invoice.taxTotal ?? 0, currency)}</span></div>
            <div className="flex justify-between border-t pt-2.5 text-sm"><span className="font-medium text-foreground">Total</span><span className="font-medium tabular-nums text-foreground">{money(invoice.total ?? 0, currency)}</span></div>
            {Number(invoice.amountPaid ?? 0) > 0 && (
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-foreground">−{money(invoice.amountPaid ?? 0, currency)}</span></div>
            )}
            <div className="doc-accent-border flex items-baseline justify-between border-t pt-3">
              <span className="text-sm font-semibold text-foreground">{isPaid ? 'Balance' : 'Balance due'}</span>
              <span className="doc-accent-text text-2xl font-semibold tabular-nums" data-testid="public-invoice-balance">{money(invoice.balance ?? 0, currency)}</span>
            </div>
            {hasDeposit && chargeNow && !isPaid && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="public-invoice-deposit-strip">
                {chargeNow.isDeposit ? (
                  <>Deposit of <strong className="text-foreground">{money(invoice.depositDue!, currency)}</strong> due — {money(invoice.amountPaid ?? 0, currency)} of {money(invoice.total ?? 0, currency)} paid.</>
                ) : (
                  <>Deposit paid — remaining balance {money(invoice.balance ?? 0, currency)}.</>
                )}
              </div>
            )}
          </div>
        </section>

        {invoice.notes && <DocumentTerms label="Notes">{invoice.notes}</DocumentTerms>}
        {invoice.termsAndConditions && (
          <DocumentTerms label="Terms & Conditions" testId="public-invoice-terms">{invoice.termsAndConditions}</DocumentTerms>
        )}
      </DocumentPaper>

      <p className="pb-4 text-center text-xs text-muted-foreground">
        Have a customer portal account?{' '}
        <a href={withBase('/login')} className="text-primary hover:underline">Sign in</a>{' '}
        to see all your invoices.
      </p>
    </div>
  );
}

export default PublicInvoiceView;
