import { quoteStatusTone } from '@/lib/quoteStatus';
import { withBase } from '@/lib/basePath';
import { useState } from 'react';
import { ArrowLeft, AlertCircle, Download } from 'lucide-react';
import { type QuoteDetail, publicApiPath, portalApi } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { computeChargeNow } from '@/lib/invoiceDeposit';
import { QuoteBlocks, money } from './quoteBlocks';
import { DocumentPaper, DocumentHeader, DocumentTerms, type DocSeller } from './documentShell';
import { BTN_PRIMARY, BTN_SECONDARY } from './ui';
import { SignaturePanel } from './SignaturePanel';

interface QuoteDetailViewProps {
  detail: QuoteDetail | null;
  error?: string | null;
  /** HTTP status of the failed load: 404 reads as \"not found\"; anything else is an outage. */
  statusCode?: number;
}

const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  converted: 'Accepted',
  // Without this the `?? status` fallback renders the raw enum "superseded" to
  // the customer. This status only became reachable when revisions shipped.
  superseded: 'Replaced',
};

export function QuoteDetailView({ detail, error, statusCode }: QuoteDetailViewProps) {
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

  if (error || !detail) {
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

  const { quote, blocks, lines, branding, presentation } = detail;
  const currency = quote.currencyCode;
  const open = status === 'sent' || status === 'viewed';

  const seller = (quote.sellerSnapshot ?? null) as DocSeller | null;
  // Omit a missing date rather than printing an em-dash placeholder on a
  // document the customer forwards (the public token view already does this).
  const headerDates = [
    ...(quote.issueDate ? [{ label: 'Issued', value: shortDate(quote.issueDate) }] : []),
    ...(quote.expiryDate ? [{ label: 'Valid until', value: shortDate(quote.expiryDate) }] : []),
  ];

  const accept = async (signerName: string) => {
    if (busy || !signerName.trim()) return;
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.acceptQuote(quote.id, signerName.trim());
    setBusy(false);
    if (res.error) {
      setMsg(res.error);
      setMsgError(true);
      return;
    }
    setStatus('converted');
    setAcceptedInvoiceId(res.data?.data?.invoiceId ?? null);
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

  // Derived from the LINES as well as the header aggregates: a payload that
  // omits monthlyRecurringTotal/annualRecurringTotal used to silently drop the
  // "First period subtotal" qualifier and the recurring reassurance rows,
  // leaving a bare serif Total that visibly doesn't sum from the lines shown.
  // The lines are always delivered, so cadence presence never depends on
  // optional header fields.
  const lineHasRecurring = lines.some(
    (l) => l.customerVisible !== false && (l.recurrence === 'monthly' || l.recurrence === 'annual')
  );
  const lineHasCadence = (cadence: 'monthly' | 'annual') => lines.some(
    (l) => l.customerVisible !== false && l.recurrence === cadence,
  );
  const hasRecurring =
    lineHasRecurring ||
    Number(quote.monthlyRecurringTotal ?? 0) > 0 ||
    Number(quote.annualRecurringTotal ?? 0) > 0;
  // Per-line Tax column + a Subtotal/Tax breakdown appear only when this quote
  // carries tax (otherwise the totals stay focused on due-on-acceptance).
  const taxRate = quote.taxRate ? Number(quote.taxRate) : 0;
  const showTax = Number(quote.taxTotal ?? 0) > 0;
  const taxPct = taxRate > 0 ? Number((taxRate * 100).toFixed(3)) : 0;
  const categoryBreakdown = quote.categoryBreakdown ?? [];
  const depositDue = quote.depositDueTotal ?? null;
  const dueOnAcceptance = quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal ?? quote.total;
  // Remaining balance in integer cents so the subtraction never drifts on floats.
  const remainderCents = depositDue != null
    ? Math.round(Number(dueOnAcceptance) * 100) - Math.round(Number(depositDue) * 100)
    : 0;

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
  const canPay = acceptedInvoiceId !== null && !payUnavailable && Number(payCharge.amount) > 0;
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

      <DocumentPaper primaryColor={branding?.primaryColor} docTheme={presentation?.theme}>
        <DocumentHeader
          logoUrl={branding?.logoUrl}
          partnerName={branding?.partnerName}
          seller={seller}
          eyebrow="Proposal"
          title={quote.quoteNumber ?? 'Proposal'}
          subtitle={quote.title}
          statusLabel={STATUS_LABELS[status] ?? status}
          statusTone={quoteStatusTone(status)}
          dates={headerDates}
          preparedForName={quote.billToName ?? undefined}
        />

        {quote.introNotes && (
          <p className="max-w-prose whitespace-pre-wrap text-pretty text-sm leading-relaxed text-foreground/90">{quote.introNotes}</p>
        )}

        <QuoteBlocks
          blocks={blocks}
          lines={lines}
          currency={currency}
          imageUrl={(imageId) => publicApiPath(`/portal/quotes/${quote.id}/images/${imageId}`)}
          buildUrl={publicApiPath}
          taxRate={taxRate}
          showTax={showTax}
        />

        <section className="flex justify-end">
          <div className="w-full max-w-xs space-y-2.5">
            {showTax && (
              <>
                <div className="flex justify-between text-sm">
                  {/* `subtotal` sums ALL lines (one-time + first period of each
                      recurring cadence), so with recurring lines a bare
                      "Subtotal" invites the reader to reconcile it against the
                      due-on-acceptance figures below — which never add up. The
                      qualifier names the basis. */}
                  <span className="text-muted-foreground">{hasRecurring ? 'First period subtotal' : 'Subtotal'}</span>
                  <span className="tabular-nums text-foreground">{money(quote.subtotal ?? 0, currency)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tax{taxPct ? ` (${taxPct}%)` : ''}</span>
                  <span className="tabular-nums text-foreground">{money(quote.taxTotal ?? 0, currency)}</span>
                </div>
              </>
            )}
            {hasRecurring && lineHasCadence('monthly') && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Monthly recurring</span>
                <span className="tabular-nums text-foreground">{money(quote.monthlyRecurringTotal ?? 0, currency)}<span className="text-xs text-muted-foreground">/mo</span></span>
              </div>
            )}
            {hasRecurring && lineHasCadence('annual') && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Annual recurring</span>
                <span className="tabular-nums text-foreground">{money(quote.annualRecurringTotal ?? 0, currency)}<span className="text-xs text-muted-foreground">/yr</span></span>
              </div>
            )}
            {categoryBreakdown.length > 1 && (
              <div className="space-y-0.5 text-sm text-muted-foreground" data-testid="quote-category-breakdown">
                {categoryBreakdown.map((b) => (
                  <div key={b.category} className="flex justify-between">
                    <span className="capitalize">{b.category}</span>
                    <span className="tabular-nums">
                      {[
                        Number(b.oneTimeTotal) > 0 ? money(b.oneTimeTotal, currency) : null,
                        Number(b.monthlyTotal) > 0 ? `${money(b.monthlyTotal, currency)}/mo` : null,
                        Number(b.annualTotal) > 0 ? `${money(b.annualTotal, currency)}/yr` : null,
                      ].filter(Boolean).join(' + ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {depositDue != null ? (
              <>
                {/* Anchor row: the deposit stays the hero (it's what's payable
                    now), but the three figures must visibly sum — due on
                    acceptance = deposit due now + remaining balance. */}
                <div className="doc-accent-border flex justify-between border-t pt-3 text-sm" data-testid="quote-due-on-acceptance">
                  <span className="font-medium text-foreground">Due on acceptance</span>
                  <span className="font-medium tabular-nums text-foreground">{money(dueOnAcceptance, currency)}</span>
                </div>
                <div className="flex items-baseline justify-between" data-testid="quote-deposit-due">
                  <span className="text-sm font-semibold text-foreground">Deposit due now</span>
                  <span className="doc-accent-text font-display text-2xl font-semibold tabular-nums">
                    {money(depositDue, currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm" data-testid="quote-deposit-remainder">
                  <span className="text-muted-foreground">Remaining balance (due per terms)</span>
                  <span className="tabular-nums text-foreground">{money(remainderCents / 100, currency)}</span>
                </div>
              </>
            ) : (
              <div className="doc-accent-border flex items-baseline justify-between border-t pt-3">
                <span className="text-sm font-semibold text-foreground">{hasRecurring ? 'Due on acceptance' : 'Total'}</span>
                <span className="doc-accent-text font-display text-2xl font-semibold tabular-nums">
                  {money(dueOnAcceptance, currency)}
                </span>
              </div>
            )}
            {hasRecurring && (
              <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">First-period total</span>
                  <span className="tabular-nums text-foreground">{money(quote.total, currency)}</span>
                </div>
                <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                  Accepting this proposal bills only the one-time charges now. Recurring lines bill on their own schedule.
                </p>
              </div>
            )}
          </div>
        </section>

        {quote.terms && <DocumentTerms label="Terms">{quote.terms}</DocumentTerms>}
        {quote.termsAndConditions && (
          <DocumentTerms label="Terms & Conditions" testId="quote-terms-conditions">{quote.termsAndConditions}</DocumentTerms>
        )}
      </DocumentPaper>

      {/* Failures render on their own, outside the accepted panel, so a failed pay
          attempt is never dressed up in success styling. */}
      {msg && msgError && (
        <div data-testid="quote-msg" role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint">
          {msg}
        </div>
      )}
      {msg && !msgError && status !== 'converted' && (
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

      {open && (
        <SignaturePanel
          onAccept={(signerName) => void accept(signerName)}
          onDecline={(reason) => void decline(reason)}
          busy={busy}
          testIdPrefix="quote"
        />
      )}
    </div>
  );
}

export default QuoteDetailView;
