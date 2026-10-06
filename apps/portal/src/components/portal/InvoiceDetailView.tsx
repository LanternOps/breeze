import { InvoicePaymentPanel } from './autopay/InvoicePaymentPanel';
import { runAction } from '@/lib/runAction';
import { invoiceAutopayInput } from '@/lib/api';
import { withBase } from '@/lib/basePath';
import { useEffect, useState } from 'react';
import { ArrowLeft, AlertCircle, Download } from 'lucide-react';
import { type BrandingConfig, type InvoiceDetail, type InvoiceStatus, buildPortalApiUrl, portalApi } from '@/lib/api';
import { longDate } from '@/lib/format';
import { STATUS_LABELS, statusTone } from '@/lib/invoiceStatus';
import { computeChargeNow } from '@/lib/invoiceDeposit';
import { DocumentPaper, DocumentHeader, DocumentTerms, DocumentTermsCollapsible, type DocSeller } from './documentShell';
import { InvoiceLineTable, InvoiceTotals } from './invoicePaper';
import { INVOICE_GRID, RAIL } from './autopay/InvoicePaymentPanel';
import { BTN_PRIMARY, BTN_SECONDARY, Notice } from './ui';
import { cn } from '@/lib/utils';

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

export function InvoiceDetailView({ detail, error, statusCode }: InvoiceDetailViewProps) {
  // Partner branding for the document shell. Invoices used to render unbranded
  // while proposals rendered branded, because only the quote payloads carried
  // `branding`; GET /portal/invoices/:id now returns the same shape, so the
  // common path needs no client fetch at all.
  //
  // The fetch below is the fallback for an API that predates that field. It
  // reads GET /portal/branding, which is authenticated and org-scoped; it 404s
  // only when the org has never saved portal settings, in which case defaults
  // apply — fine as a fallback, not as the source.
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
  const [payTerminal, setPayTerminal] = useState(false);
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
    void runAction<{ settled: boolean; invoiceId?: string }>({
      request: () => portalApi.settleInvoice(invoiceId, sessionId),
      onOutcome: (message, error) => {
        if (!cancelled && error) { setPayError(message); setSettleState('failed'); }
      },
      successMessage: 'Payment checked.', errorFallback: 'Could not confirm payment. Please try again.',
    }).then(result => {
      if (cancelled) return;
      if (result?.settled) window.location.replace(withBase(`/invoices/${invoiceId}`));
      else if (result) setSettleState('pending');
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
  const canPay = PAYABLE_STATUSES.has(invoice.status) && Number(invoice.balance) > 0
    && detail.onlinePaymentAvailable !== false; // #7509
  // Deposit-aware charge amount — matches what the server's pay route charges (Task 8),
  // so the button label and the deposit strip never diverge from the actual charge.
  const hasDeposit = invoice.depositDue != null;
  const chargeNow = computeChargeNow({
    depositDue: invoice.depositDue ?? null,
    amountPaid: invoice.amountPaid,
    balance: invoice.balance,
  }, invoice.currencyCode);
  // #7824: the server reservation. Once the customer releases a payment waiting on
  // their bank, the panel clears it locally and the Pay button is the way to pay.
  const collectionInProgress = detail.collectionInProgress ?? null;
  // Per-line Tax column only when this invoice carries tax (mirrors the Tax row).
  const taxRate = invoice.taxRate ? Number(invoice.taxRate) : 0;
  const showTax = Number(invoice.taxTotal) > 0;
  const taxPct = taxRate > 0 ? Number((taxRate * 100).toFixed(3)) : 0;

  const seller = (invoice.sellerSnapshot ?? null) as DocSeller | null;
  const headerDates = [
    { label: 'Issued', value: longDate(invoice.issueDate) || '—' },
    { label: 'Due', value: longDate(invoice.dueDate) || '—' },
  ];

  const payInvoice = async (saveForAutopay: boolean) => {
    if (paying) return; setPaying(true); setPayError(null);
    const result = await runAction({
      request: async () => {
        const response = await portalApi.payInvoice(invoice.id, {}, invoiceAutopayInput(saveForAutopay, detail.autopay));
        setPayTerminal(response.statusCode === 409); return response;
      },
      onOutcome: (message, error) => { if (error) setPayError(message); },
      successMessage: 'Opening secure checkout…', errorFallback: 'Could not start payment. Please try again.',
      validate: value => typeof value.url === 'string' && value.url.startsWith('https://checkout.stripe.com/'),
    });
    if (result && typeof result.url === 'string') window.location.href = result.url; else setPaying(false);
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

  const notices = (
    <>
      {settleState === 'settling' && <Notice tone="primary" title="Confirming your payment…" data-testid="invoice-settle-confirming" />}
      {settleState === 'failed' && (
        <Notice tone="destructive" title="We couldn't confirm your payment just now." data-testid="invoice-settle-failed">
          <p>{`If your card was charged, it will be applied shortly, and ${branding?.partnerName ?? 'your IT team'} can confirm it for you.`}</p>
        </Notice>
      )}
      {settleState === 'pending' && (
        <Notice tone="primary" title="Thanks! We're still confirming your payment." data-testid="invoice-settle-pending">
          <p>This can take a moment. Refresh shortly to see it applied.</p>
        </Notice>
      )}
      {invoice.status === 'paid' && !detail.autopayStatus && <Notice tone="success" title="Paid. Thank you." />}
      {payError && (
        <Notice tone="destructive" title={payError} data-testid="invoice-pay-error">
          {/* A terminal 409 leaves a dead button; the customer still has a bill.
              Name the next step so the page does not end on a refusal. */}
          {payTerminal && (
            <p data-testid="invoice-pay-next-step">
              {branding?.partnerName
                ? `Ask ${branding.partnerName} how to pay this invoice. They can take payment another way.`
                : 'Ask your IT team how to pay this invoice. They can take payment another way.'}
            </p>
          )}
        </Notice>
      )}
      {downloadError && <Notice tone="destructive" title={downloadError} />}
    </>
  );

  return (
    <div className="space-y-5">
      <a href={withBase("/invoices")} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to invoices
      </a>
      <div className={cn('grid gap-5', INVOICE_GRID)}>
      {/* The panel comes first on phones; at lg it sits beside the invoice (D-4). */}
      <div className={RAIL}>
        <InvoicePaymentPanel portal
          currency={currency} balance={invoice.balance} dueDate={invoice.dueDate} status={invoice.status}
          canPay={canPay} onlinePaymentUnavailable={detail.onlinePaymentAvailable === false && PAYABLE_STATUSES.has(invoice.status)}
          charge={chargeNow} autopayStatus={detail.autopayStatus ?? null} autopayEnrolled={detail.autopayEnrolled === true}
          saveOffer={detail.autopay} bankTarget={{ invoiceId: invoice.id }} bankOffer={detail.bankAutopay}
          collectionInProgress={collectionInProgress} partnerName={branding?.partnerName}
          paying={paying} onPay={save => void payInvoice(save)} payTestId="invoice-pay-button" processingTestId="invoice-collection-processing"
          release={() => portalApi.releaseAutopayConfirmation(invoice.id)} notices={notices}
          download={(
            <button type="button" onClick={() => void downloadPdf()} disabled={downloading} className={cn(canPay ? BTN_SECONDARY : BTN_PRIMARY, 'w-full')}>
              <Download className="h-4 w-4" aria-hidden="true" />
              {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
          )}
        />
      </div>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
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

        <InvoiceLineTable lines={lines} currency={currency} taxRate={taxRate} showTax={showTax} showLineTicket />

        <InvoiceTotals currency={currency} subtotal={invoice.subtotal} taxTotal={invoice.taxTotal} taxPct={taxPct}
          total={invoice.total} amountPaid={invoice.amountPaid} balance={invoice.balance} paid={invoice.status === 'paid'}
          deposit={hasDeposit ? { due: invoice.depositDue!, isDeposit: chargeNow.isDeposit } : null}
          testIds={{ balance: 'invoice-balance-due', deposit: 'invoice-deposit-strip' }} />

        {invoice.notes && <DocumentTerms label="Notes">{invoice.notes}</DocumentTerms>}
        {invoice.termsAndConditions && (
          <DocumentTermsCollapsible text={invoice.termsAndConditions} testId="invoice-terms-conditions" />
        )}
      </DocumentPaper>
      </div>
      </div>
    </div>
  );
}

export default InvoiceDetailView;
