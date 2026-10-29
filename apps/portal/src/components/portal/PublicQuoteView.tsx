import { computeChargeNow } from '@/lib/invoiceDeposit';
import { replaceLocation } from '@/lib/replaceLocation';
import { useMemo, useState } from 'react';
import { QuoteDocumentView, quoteAgreementLinks, type DocumentHostComponents } from '@breeze/document-ui';
import { portalApi, publicApiPath, type PublicQuoteAccepted, type PublicQuoteDetail, type PublicQuotePayment } from '@/lib/api';
import { cn } from '@/lib/utils';
import { money } from '@/lib/format';
import { quoteModelFor } from '@/lib/quoteDocument';
import { portalQuoteHostComponents, quoteAssetSource } from './documentHostComponents';
import { SignaturePanel } from './SignaturePanel';
import { PublicQuotePaymentStep } from './PublicQuotePaymentStep';

interface PublicQuoteViewProps {
  token: string;
  initial: PublicQuoteDetail | null;
  error?: string | null;
  /** Set when the API answered 410 QUOTE_SUPERSEDED: this proposal was replaced
   *  by a newer revision and its link was revoked. Carries only the partner's
   *  name — the server withholds everything else, including the successor's id. */
  superseded?: { partnerName?: string | null } | null;
  /** #3740: the quote is accepted and this link may still pay its invoice
   *  (GET /quotes/public/:token/payment). Alone (initial null) when accepting
   *  spent the link: the page then shows only the payment step, never the
   *  proposal again. */
  accepted?: PublicQuoteAccepted | null;
  /** Test seam: parity tests inject deterministic stand-ins for the asset components. */
  components?: DocumentHostComponents;
}

export function PublicQuoteView({ token, initial, error, superseded, accepted, components }: PublicQuoteViewProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initial?.quote.status ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [msgError, setMsgError] = useState(false);
  // What is payable now, when this page offers the payment step (#3740).
  const [payment, setPayment] = useState<PublicQuotePayment | null>(accepted?.payment ?? null);
  // The model follows the status this page moved the proposal into (accepted, declined),
  // so the header pill changes without a refetch.
  const model = useMemo(() => (initial ? quoteModelFor(initial, status) : null), [initial, status]);
  const hostComponents = useMemo(
    () => components ?? (initial
      ? portalQuoteHostComponents(quoteAssetSource(initial, (imageId) => publicApiPath(`/quotes/public/${encodeURIComponent(token)}/images/${imageId}`)))
      : null),
    [components, initial, token],
  );

  // A replaced proposal is NOT a broken link, and telling the customer their
  // link is "invalid or expired" would send them back to the MSP for a fix that
  // is already in their inbox. Checked before the generic fallback for that
  // reason. Deliberately renders no totals, no accept/decline, and no link to
  // the successor — they reach it through the newer email, and the id is not
  // ours to hand out here.
  if (superseded) {
    return (
      <div data-testid="public-quote-superseded" role="status" className="mx-auto max-w-lg p-8 text-center">
        <p className="text-sm">
          This proposal has been replaced by an updated version — please use the link in the latest email
          {superseded.partnerName ? `, or contact ${superseded.partnerName}` : ''}.
        </p>
      </div>
    );
  }

  // #3740: a revisit of a link that accepting spent. Only the payment step
  // (or a plain "accepted") — the proposal itself is no longer served to it.
  if (!initial && accepted) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 p-4">
        <div data-testid="public-quote-accepted" role="status" className="rounded-md bg-success/10 p-4 text-sm text-success-on-tint">
          <p>
            {payment
              ? 'This proposal has been accepted.'
              : `This proposal has been accepted. There is nothing to pay online here${accepted.partnerName ? ` — contact ${accepted.partnerName} with any questions` : ''}.`}
          </p>
        </div>
        {payment && <PublicQuotePaymentStep token={token} payment={payment} />}
      </div>
    );
  }

  if (error || !initial || !model || !hostComponents) {
    return (
      <div data-testid="public-quote-error" role="alert" className="mx-auto max-w-lg p-8 text-center text-destructive">
        <p className="text-sm">{error ?? 'This proposal link is invalid or has expired.'}</p>
      </div>
    );
  }

  const { quote, branding } = initial;
  const currency = quote.currencyCode;
  const open = status === 'sent' || status === 'viewed';
  const depositDue = quote.depositDueTotal ?? null;
  const dueOnAcceptance = quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal ?? quote.total;

  // #8231 Sign & pay. The invoice this accept creates starts with nothing
  // paid, so the shared deposit-first rule reduces to "deposit if one is set,
  // else the due-on-acceptance total" — the same derivation QuoteDetailView
  // labels its post-accept Pay button with. Only promised when the server says
  // payment follows (partner takes online payment) AND something is due.
  const payCharge = computeChargeNow({
    depositDue: depositDue != null ? String(depositDue) : null,
    amountPaid: '0.00',
    balance: String(dueOnAcceptance),
  }, currency);
  const signAndPay = initial.payOnAccept === true && Number(payCharge.amount) > 0;
  const acceptLabel = signAndPay
    ? (payCharge.isDeposit
      ? `Sign & pay deposit ${money(payCharge.amount, currency)}`
      : `Sign & pay ${money(payCharge.amount, currency)}`)
    : undefined;
  const afterSignNote = signAndPay ? "You'll then go to secure payment." : undefined;

  const accept = async (signerName: string) => {
    if (busy || !signerName.trim()) return;
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.acceptPublicQuote(token, signerName.trim());
    setBusy(false);
    if (res.error) {
      setMsg(res.error);
      setMsgError(true);
      return;
    }
    setStatus('converted');
    // #8231: when the server minted a checkout, go straight to it. Its success
    // and cancel urls both return to the invoice's durable page, so nothing is
    // held here (spec §8) — replace, not assign: back must not return to the
    // spent accept form.
    const checkoutUrl = res.data?.data?.checkoutUrl ?? null;
    if (checkoutUrl) {
      setMsg('Signed and accepted. Taking you to secure payment.');
      replaceLocation(checkoutUrl);
      return;
    }
    // Otherwise the accept response carries the invoice's DURABLE public url
    // (the quote accept token is now spent). Land the customer straight on it
    // — it shows the invoice with its Pay button and keeps working after the
    // tab closes. The invoice is also auto-emailed server-side, so losing this
    // navigation is harmless. payDeferred = the link couldn't be minted now.
    const invoiceUrl = res.data?.data?.invoiceUrl ?? null;
    if (invoiceUrl) {
      // The button promised payment but none could be started (Stripe down,
      // state changed since the page loaded): say so instead of going quiet.
      setMsg(signAndPay
        ? "Signed and accepted. We couldn't open payment just now — you can pay from your invoice."
        : 'Signed and accepted. Taking you to your invoice.');
      replaceLocation(invoiceUrl);
      return;
    }
    // No invoice page to land on. payDeferred = an invoice was issued but its
    // link could not be minted just now: when something is payable, payment is
    // the next step right here (#3740) — this link may still pay it. No email
    // is promised: the auto-send is a partner setting and best-effort.
    if (res.data?.data?.payDeferred) {
      const due = res.data.data.payment ?? null;
      setPayment(due);
      setMsg(due
        ? 'Signed and accepted.'
        : `Signed and accepted. Your invoice isn't ready to open yet — come back to this link later, or contact ${branding.partnerName}.`);
      return;
    }
    setMsg('Signed and accepted. Thank you.');
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
    const res = await portalApi.declinePublicQuote(token, reason);
    setBusy(false);
    if (res.error) {
      setMsg(res.error);
      setMsgError(true);
      return;
    }
    setStatus('declined');
    setMsg(`Thanks — ${branding.partnerName} has been notified.`);
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-2 sm:p-4">
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
                testIdPrefix="public-quote"
                agreements={quoteAgreementLinks(model)}
                acceptLabel={acceptLabel}
                afterSignNote={afterSignNote}
              />
              {/* Accept/decline feedback stays adjacent to the button, not below the agreement. */}
              {msg && (
                <div
                  role={msgError ? 'alert' : 'status'}
                  className={cn(
                    'rounded-md p-3 text-sm',
                    msgError ? 'bg-destructive/10 text-destructive-on-tint' : 'bg-muted'
                  )}
                >
                  {msg}
                </div>
              )}
            </div>
          ) : undefined,
        }}
      />

      {status === 'converted' && (
        <div data-testid="public-quote-accepted" role="status" className="space-y-3 rounded-md bg-success/10 p-4 text-sm text-success-on-tint">
          <p>{msg ?? 'This proposal has already been accepted.'}</p>
        </div>
      )}
      {status === 'converted' && payment && <PublicQuotePaymentStep token={token} payment={payment} />}
      {status === 'declined' && msg && (
        <div role="status" className="rounded-md bg-muted p-3 text-sm">{msg}</div>
      )}
    </div>
  );
}

export default PublicQuoteView;
