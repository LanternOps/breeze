import { withBase } from '@/lib/basePath';
import { useMemo, useState } from 'react';
import { ArrowLeft, AlertCircle, Download } from 'lucide-react';
import { QuoteDocumentView, quoteAgreementLinks, type DocumentHostComponents } from '@breeze/document-ui';
import { type QuoteDetail, publicApiPath, portalApi } from '@/lib/api';
import { money, shortDate } from '@/lib/format';
import { computeChargeNow } from '@/lib/invoiceDeposit';
import { quoteModelFor } from '@/lib/quoteDocument';
import { portalQuoteHostComponents, quoteAssetSource } from './documentHostComponents';
import { BTN_PRIMARY, BTN_SECONDARY } from './ui';
import { SignaturePanel } from './SignaturePanel';

interface QuoteDetailViewProps {
  detail?: QuoteDetail | null;
  /** Alias of `detail` (test seam mirroring PublicQuoteView / InvoiceDetailView). */
  initial?: QuoteDetail | null;
  /** Test seam: parity tests inject deterministic stand-ins for the asset components. */
  components?: DocumentHostComponents;
  error?: string | null;
  /** HTTP status of the failed load: 404 reads as \"not found\"; anything else is an outage. */
  statusCode?: number;
}

export function QuoteDetailView({ detail: detailProp, initial, components, error, statusCode }: QuoteDetailViewProps) {
  const detail = detailProp ?? initial ?? null;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgError, setMsgError] = useState(false);
  const [status, setStatus] = useState(detail?.quote.status ?? '');
  // Invoice created by THIS acceptance (the accept response's invoiceId). Null on a
  // quote that was already converted when the page loaded — the portal's QuoteHeader
  // type doesn't expose convertedInvoiceId, so those customers get the invoice list.
  const [acceptedInvoiceId, setAcceptedInvoiceId] = useState<string | null>(null);
  // The pay route 409s when this proposal can't be paid online (no Stripe connection,
  // nothing left to charge). That's terminal, so drop the CTA instead of leaving a
  // button whose only outcome is the same error again.
  const [payUnavailable, setPayUnavailable] = useState(false);
  // Same source of truth as the invoice page (#7509): GET /portal/invoices/:id's
  // onlinePaymentAvailable. Only an explicit false hides the CTA; a failed lookup
  // keeps it, and the pay route's 409 stays the backstop.
  const [onlinePaymentOff, setOnlinePaymentOff] = useState(false);
  // The model follows the status this page moved the proposal into, so the header pill changes without a refetch.
  const model = useMemo(() => (detail ? quoteModelFor(detail, status) : null), [detail, status]);
  const hostComponents = useMemo(
    () => components ?? (detail
      ? portalQuoteHostComponents(quoteAssetSource(detail, (imageId) => publicApiPath(`/portal/quotes/${detail.quote.id}/images/${imageId}`)))
      : null),
    [components, detail],
  );

  if (error || !detail || !model || !hostComponents) {
    return (
      <div className="border-y border-border/70 py-14 text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-destructive-on-tint" strokeWidth={1.5} />
        <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
          {statusCode === 404 || !error ? 'Proposal not found' : "We couldn't load this proposal"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {statusCode === 404 || !error
            ? "We couldn't find that proposal — it may have been withdrawn or replaced. Your proposals list is current."
            : 'Something went wrong on our side. Try again in a moment; your proposals list is unaffected.'}
        </p>
        <a href={withBase("/quotes")} className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary-on-tint underline-offset-4 hover:underline">
          <ArrowLeft className="h-4 w-4" />
          Back to proposals
        </a>
      </div>
    );
  }

  const { quote, branding } = detail;
  const open = status === 'sent' || status === 'viewed';

  const depositDue = quote.depositDueTotal ?? null;
  const dueOnAcceptance = quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal ?? quote.total;
  const currency = quote.currencyCode;

  const accept = async (signerName: string) => {
    if (busy || !signerName.trim()) return;
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.acceptQuote(quote.id, signerName.trim());
    if (res.error) {
      setBusy(false);
      setMsg(res.error);
      setMsgError(true);
      return;
    }
    const invoiceId = res.data?.data?.invoiceId ?? null;
    // Resolve availability before flipping to the accepted state so the CTA never
    // flashes in and then disappears.
    // The quote is already accepted, so a failed lookup must never block the
    // accepted state; busy stays set meanwhile so Accept can't be re-sent.
    if (invoiceId) {
      try {
        const inv = await portalApi.getInvoice(invoiceId);
        if (inv.data?.onlinePaymentAvailable === false) setOnlinePaymentOff(true);
      } catch (err) {
        console.error('[portal] post-accept invoice availability lookup failed', err);
      }
    }
    setBusy(false);
    setStatus('converted');
    setAcceptedInvoiceId(invoiceId);
    setMsg('Accepted. Your invoice is ready.');
  };

  // The reason comes from SignaturePanel's inline confirm block, which is the only
  // path that reaches here. It used to come from window.prompt(), whose null on
  // Cancel/Escape was coerced to undefined and fell straight through to the API —
  // so backing out of the prompt declined the proposal anyway.
  const decline = async (reason?: string) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.declineQuote(quote.id, reason);
    setBusy(false);
    if (res.error) {
      setMsg(res.error);
      setMsgError(true);
      return;
    }
    setStatus('declined');
    setMsg('Proposal declined — your provider has been notified.');
  };

  const pay = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.payQuote(quote.id);
    setBusy(false);
    const url = res.data?.data?.url;
    if (url) {
      window.location.href = url;
      return;
    }
    // 409 means payment is off the table for this proposal. A 200 with no link is a
    // contract error on our side: log it and keep the button so a retry is possible.
    if (!res.error) console.error('[portal] quote pay returned no checkout url', { quoteId: quote.id, statusCode: res.statusCode });
    if (res.statusCode === 409) setPayUnavailable(true);
    setMsg(res.error ?? 'Online payment is not available for this proposal.');
    setMsgError(true);
  };

  // Post-accept CTA. The label states what Stripe will charge: the invoice was just
  // created by this acceptance, so amountPaid is 0 and the shared deposit-first rule
  // reduces to "deposit if one is set, else the due-on-acceptance total".
  const payCharge = computeChargeNow({
    depositDue: depositDue != null ? String(depositDue) : null,
    amountPaid: '0.00',
    balance: String(dueOnAcceptance),
  });
  const payLabel = payCharge.isDeposit
    ? `Pay deposit ${money(payCharge.amount, currency)}`
    : `Pay ${money(payCharge.amount, currency)}`;
  // Offer the button only for an invoice this session created — then the amount above
  // is known-good. A quote that was already converted when the page loaded carries no
  // invoice figures (or payment state), so that customer gets the invoice link only,
  // where InvoiceDetailView pays against a live balance.
  const canPay = acceptedInvoiceId !== null && !payUnavailable && !onlinePaymentOff && Number(payCharge.amount) > 0;
  const invoiceHref = withBase(acceptedInvoiceId ? `/invoices/${acceptedInvoiceId}` : '/invoices');

  return (
    <div className="space-y-5" data-testid="quote-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href={withBase("/quotes")} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to proposals
        </a>
        <a
          href={publicApiPath(`/portal/quotes/${quote.id}/pdf`)}
          download={`${quote.quoteNumber ?? `quote-${quote.id}`}.pdf`}
          target="_blank"
          rel="noreferrer"
          data-testid="quote-download-pdf"
          className={BTN_SECONDARY}
        >
          <Download className="h-4 w-4" />
          Download PDF
        </a>
      </div>

      {/* A replaced proposal is read-only and its public link is dead. Say so
          plainly, and link the replacement when the API supplied one — in-portal
          by id, which the customer's own portal auth and the successor's
          recipient list still gate. */}
      {status === 'superseded' && (
        <div className="rounded-md border border-muted-foreground/30 bg-muted/40 p-4 text-sm" data-testid="portal-quote-superseded">
          <p>This proposal has been replaced by a newer version.</p>
          {quote.supersededByQuoteId && (
            <a className="underline" href={withBase(`/quotes/${quote.supersededByQuoteId}`)} data-testid="portal-quote-successor-link">
              View the current proposal
            </a>
          )}
        </div>
      )}

      <QuoteDocumentView
        model={model}
        components={hostComponents}
        slots={{
          signature: open ? (
            <div className="space-y-10">
              <SignaturePanel
                onAccept={(signerName) => void accept(signerName)}
                onDecline={(reason) => void decline(reason)}
                busy={busy}
                testIdPrefix="quote"
                agreements={quoteAgreementLinks(model)}
              />
              {/* While signing is open, feedback stays adjacent to the button (below the
                  paper it would land under the expanded agreement). */}
              {msg && (
                <div
                  data-testid="quote-msg"
                  role={msgError ? 'alert' : 'status'}
                  className={
                    msgError
                      ? 'rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint'
                      : 'rounded-md bg-muted p-3 text-sm'
                  }
                >
                  {msg}
                </div>
              )}
            </div>
          ) : undefined,
        }}
      />

      {/* Failures render on their own, outside the accepted panel, so a failed pay
          attempt is never dressed up in success styling. */}
      {!open && msg && msgError && (
        <div data-testid="quote-msg" role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint">
          {msg}
        </div>
      )}
      {!open && msg && !msgError && status !== 'converted' && (
        <div data-testid="quote-msg" role="status" className="rounded-md bg-muted p-3 text-sm">
          {msg}
        </div>
      )}

      {status === 'converted' && (
        <div
          data-testid="quote-accept-success"
          role="status"
          className="space-y-3 rounded-md bg-success/10 p-4 text-sm text-success-on-tint"
        >
          <p>{!msgError && msg ? msg : 'This proposal has been accepted.'}</p>
          {quote.acceptanceOrigin === 'on_behalf' && (
            // The customer never clicked anything — their provider recorded an
            // agreement reached elsewhere. Saying so plainly is what makes the
            // record honest from their side; the method and the reference are
            // the provider's internal detail and are deliberately absent.
            // Both values are nullable (unbranded portal / an acceptance whose
            // accepted_at never landed), and a blank name or a dangling "on ."
            // reads as a bug to the customer — fall back, and drop the date
            // clause entirely rather than printing an empty one.
            <p data-testid="quote-accepted-on-behalf">
              Accepted on your behalf by {branding?.partnerName || 'your provider'}
              {quote.acceptedAt ? ` on ${shortDate(quote.acceptedAt)}` : ''}.
            </p>
          )}
          {onlinePaymentOff && acceptedInvoiceId !== null && (
            <p data-testid="quote-pay-offline">
              {`Online payment isn't available for this invoice. Please contact ${branding?.partnerName || 'your provider'} to pay.`}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {canPay && (
              <button
                type="button"
                data-testid="quote-pay"
                disabled={busy}
                onClick={() => void pay()}
                className={BTN_PRIMARY}
              >
                {busy ? 'Opening secure checkout' : payLabel}
              </button>
            )}
            <a
              href={invoiceHref}
              data-testid="quote-accepted-invoice"
              className="text-sm font-medium underline underline-offset-2"
            >
              {acceptedInvoiceId ? 'View invoice' : 'View your invoices'}
            </a>
          </div>
        </div>
      )}

    </div>
  );
}

export default QuoteDetailView;
