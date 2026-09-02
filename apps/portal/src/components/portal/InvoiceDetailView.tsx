import { withBase } from '@/lib/basePath';
import { useEffect, useState } from 'react';
import { ArrowLeft, AlertCircle, Download, CreditCard } from 'lucide-react';
import { type BrandingConfig, type InvoiceDetail, type InvoiceStatus, buildPortalApiUrl, portalApi } from '@/lib/api';
import { money, shortDate } from '@/lib/format';
import { STATUS_LABELS, statusTone } from '@/lib/invoiceStatus';
import { computeChargeNow } from '@/lib/invoiceDeposit';
import { DocumentPaper, DocumentHeader, DocumentTerms, type DocSeller } from './documentShell';
import { BTN_PRIMARY, BTN_SECONDARY } from './ui';

// Invoice statuses that can be paid online (mirrors the API's PAYABLE set).
const PAYABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(['sent', 'partially_paid', 'overdue']);

interface InvoiceDetailViewProps {
  detail: InvoiceDetail | null;
  error?: string | null;
  /** HTTP status of the failed load: 404 reads as \"not found\"; anything else is an outage. */
  statusCode?: number;
}

/** The three fields the document shell actually needs, normalised from either
 *  branding source below. */
interface DocBranding {
  partnerName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
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

export function InvoiceDetailView({ detail, error, statusCode }: InvoiceDetailViewProps) {
  // Partner branding for the document shell. Invoices used to render unbranded
  // while proposals rendered branded, because only the quote payloads carried
  // `branding`; GET /portal/invoices/:id now returns the same shape, so the
  // common path needs no client fetch at all.
  //
  // The fetch below is the fallback for an API that predates that field. It
  // reads GET /portal/branding, which resolves by verified custom domain and so
  // 404s on the shared hosted domain — fine as a fallback, not as the source.
  const payloadBranding = detail?.branding;
  const [fetchedBranding, setFetchedBranding] = useState<BrandingConfig | null>(null);
  const branding: DocBranding | null = payloadBranding
    ? {
        partnerName: payloadBranding.partnerName ?? null,
        logoUrl: payloadBranding.logoUrl,
        primaryColor: payloadBranding.primaryColor,
      }
    : fetchedBranding
      ? {
          partnerName: fetchedBranding.name ?? null,
          logoUrl: fetchedBranding.logoUrl ?? null,
          primaryColor: fetchedBranding.primaryColor ?? null,
        }
      : null;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  // Verify-on-return settle state. 'idle' until we detect the post-Checkout return.
  const [settleState, setSettleState] = useState<'idle' | 'settling' | 'pending' | 'failed'>('idle');

  useEffect(() => {
    if (payloadBranding) return;
    let cancelled = false;
    void portalApi.getBranding().then((res) => {
      if (!cancelled) setFetchedBranding(res.data ?? null);
    });
    return () => { cancelled = true; };
  }, [payloadBranding]);

  // Instant settle on return from Stripe Checkout. success_url lands the customer back
  // here as ?paid=1&session_id=cs_… — POST that session to the settle route so the
  // status flips to Paid immediately (the API-key model has no inbound webhook; the
  // reconcile sweep is the eventual backstop). Idempotent, so a stray re-run is safe.
  useEffect(() => {
    if (!detail) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('paid') !== '1') return;
    const sessionId = params.get('session_id');
    if (!sessionId) {
      // Came back from Checkout without a session id: we can't confirm, but
      // the customer just paid and must not see a silent "Sent".
      console.error('[portal] checkout return without session_id', { invoiceId: detail.invoice.id });
      setSettleState('pending');
      return;
    }

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
        } else if (res.error) {
          // A failed settle call is not "still confirming": say so, and log it.
          console.error('[portal] settle failed', { invoiceId, sessionId, statusCode: res.statusCode, error: res.error });
          setSettleState('failed');
        } else {
          // A genuine {settled:false}: async payment method — the reconcile sweep
          // will catch it. Tell the customer rather than silently leaving it "Sent".
          setSettleState('pending');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[portal] settle request threw', { invoiceId, sessionId, err });
        setSettleState('failed');
      });
    return () => { cancelled = true; };
  }, [detail]);

  if (error || !detail) {
    return (
      <div className="border-y border-border/70 py-14 text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-destructive-on-tint" strokeWidth={1.5} />
        <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
          {statusCode === 404 || !error ? 'Invoice not found' : "We couldn't load this invoice"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {statusCode === 404 || !error
            ? "We couldn't find that invoice — it may have been reissued. Your invoice list is up to date."
            : 'Something went wrong on our side. Try again in a moment; nothing about your account has changed.'}
        </p>
        <a href={withBase("/invoices")} className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary-on-tint underline-offset-4 hover:underline">
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
  }, invoice.currencyCode);
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
    if (!result.error) {
      // A 200 without a Checkout URL is a contract error, not a customer condition.
      console.error('[portal] pay returned no checkout url', { invoiceId: invoice.id, statusCode: result.statusCode });
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
        console.error('[portal] invoice pdf download failed', { invoiceId: invoice.id, status: res.status });
        setDownloadError(res.status === 401 ? 'Your session has expired. Sign in again to download.' : 'Could not download the invoice PDF. Try again in a moment.');
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
    } catch (err) {
      console.error('[portal] invoice pdf download threw', { invoiceId: invoice.id, err });
      setDownloadError('Could not download the invoice PDF. Try again in a moment.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href={withBase("/invoices")} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
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
              className={BTN_PRIMARY}
            >
              <CreditCard className="h-4 w-4" />
              {paying ? 'Opening secure checkout' : payLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => void downloadPdf()}
            disabled={downloading}
            className={canPay ? BTN_SECONDARY : BTN_PRIMARY}
          >
            <Download className="h-4 w-4" />
            {downloading ? 'Preparing' : 'Download PDF'}
          </button>
        </div>
      </div>

      {settleState === 'settling' && (
        <div role="status" className="rounded-md bg-warning/10 p-3 text-sm font-medium text-warning-on-tint" data-testid="invoice-settle-confirming">
          Confirming your payment…
        </div>
      )}
      {settleState === 'failed' && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive-on-tint" data-testid="invoice-settle-failed">
          We couldn't confirm your payment just now. If your card was charged, it will be applied shortly — and your IT team can confirm it for you.
        </div>
      )}
      {settleState === 'pending' && (
        <div role="status" className="rounded-md bg-warning/10 p-3 text-sm font-medium text-warning-on-tint" data-testid="invoice-settle-pending">
          Thanks! We're still confirming your payment — this can take a moment. Refresh shortly to see it applied.
        </div>
      )}
      {payError && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive-on-tint" data-testid="invoice-pay-error">{payError}</div>
      )}
      {downloadError && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive-on-tint">{downloadError}</div>
      )}

      <DocumentPaper testId="invoice-document" primaryColor={branding?.primaryColor}>
        <DocumentHeader
          logoUrl={branding?.logoUrl}
          partnerName={branding?.partnerName}
          seller={seller}
          eyebrow="Invoice"
          title={invoice.invoiceNumber ?? 'Invoice'}
          statusLabel={STATUS_LABELS[invoice.status]}
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
                  // Title/blurb split (#3319), matching invoicePdf's lineTitle/
                  // lineBlurb so the portal and the PDF the customer receives
                  // label the same line identically.
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
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums text-foreground">{money(invoice.subtotal, currency)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Tax{taxPct ? ` (${taxPct}%)` : ''}</span><span className="tabular-nums text-foreground">{money(invoice.taxTotal, currency)}</span></div>
            <div className="flex justify-between border-t pt-2.5 text-sm"><span className="font-medium text-foreground">Total</span><span className="font-medium tabular-nums text-foreground">{money(invoice.total, currency)}</span></div>
            {Number(invoice.amountPaid) > 0 && (
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-foreground">−{money(invoice.amountPaid, currency)}</span></div>
            )}
            <div className="doc-accent-border flex items-baseline justify-between border-t pt-3">
              <span className="text-sm font-semibold text-foreground">Balance due</span>
              <span className="doc-accent-text font-display text-2xl font-semibold tabular-nums" data-testid="invoice-balance-due">{money(invoice.balance, currency)}</span>
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
