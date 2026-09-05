import { quoteStatusTone } from '@/lib/quoteStatus';
import { useState } from 'react';
import { portalApi, publicApiPath, type PublicQuoteDetail } from '@/lib/api';
import { cn } from '@/lib/utils';
import { QuoteBlocks, money } from './quoteBlocks';
import { DocumentPaper, DocumentHeader, DocumentTerms, type DocSeller } from './documentShell';
import { SignaturePanel } from './SignaturePanel';

interface PublicQuoteViewProps {
  token: string;
  initial: PublicQuoteDetail | null;
  error?: string | null;
  /** Set when the API answered 410 QUOTE_SUPERSEDED: this proposal was replaced
   *  by a newer revision and its link was revoked. Carries only the partner's
   *  name — the server withholds everything else, including the successor's id. */
  superseded?: { partnerName?: string | null } | null;
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

export function PublicQuoteView({ token, initial, error, superseded }: PublicQuoteViewProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initial?.quote.status ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [msgError, setMsgError] = useState(false);

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

  if (error || !initial) {
    return (
      <div data-testid="public-quote-error" role="alert" className="mx-auto max-w-lg p-8 text-center text-destructive">
        <p className="text-sm">{error ?? 'This proposal link is invalid or has expired.'}</p>
      </div>
    );
  }

  const { quote, blocks, lines, branding, presentation } = initial;
  const currency = quote.currencyCode;
  const open = status === 'sent' || status === 'viewed';
  const lineHasCadence = (cadence: 'monthly' | 'annual') => lines.some(
    (l) => l.customerVisible !== false && l.recurrence === cadence,
  );
  const hasRecurring = lineHasCadence('monthly') || lineHasCadence('annual');
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

  const seller = (quote.sellerSnapshot ?? null) as DocSeller | null;

  const statusLabel =
    status === 'accepted' || status === 'converted'
      ? 'Accepted'
      : status === 'declined'
        ? 'Declined'
        : status === 'expired'
          ? 'Expired'
          : status === 'superseded'
            ? 'Replaced'
            : undefined;

  const headerDates = [
    ...(quote.issueDate ? [{ label: 'Issued', value: shortDate(quote.issueDate) }] : []),
    ...(quote.expiryDate ? [{ label: 'Valid until', value: shortDate(quote.expiryDate) }] : []),
  ];

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
    // The accept response carries the invoice's DURABLE public url (the quote
    // accept token is now spent). Land the customer straight on it — it shows
    // the invoice with its Pay button and keeps working after the tab closes
    // (replace, not assign: back must not return to the dead accept form).
    // The invoice is also auto-emailed server-side, so losing this navigation
    // is harmless. payDeferred = the link couldn't be minted right now.
    const invoiceUrl = res.data?.data?.invoiceUrl ?? null;
    if (invoiceUrl) {
      setMsg('Signed and accepted. Taking you to your invoice.');
      window.location.replace(invoiceUrl);
      return;
    }
    setMsg(
      res.data?.data?.payDeferred
        ? "Signed and accepted. We'll email you your invoice shortly."
        : 'Signed and accepted. Thank you.'
    );
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
      <DocumentPaper primaryColor={branding.primaryColor} testId="public-quote" docTheme={presentation?.theme}>
        <DocumentHeader
          logoUrl={branding.logoUrl}
          partnerName={branding.partnerName}
          seller={seller}
          eyebrow="Proposal"
          title={quote.quoteNumber ?? 'Proposal'}
          statusLabel={statusLabel}
          statusTone={statusLabel ? quoteStatusTone(status) : undefined}
          dates={headerDates}
          preparedForName={quote.billToName ?? undefined}
        />

        {quote.introNotes && (
          <p className="max-w-prose whitespace-pre-wrap text-pretty text-sm leading-relaxed text-foreground/90">
            {quote.introNotes}
          </p>
        )}

        <QuoteBlocks
          blocks={blocks}
          lines={lines}
          currency={currency}
          imageUrl={(imageId) =>
            publicApiPath(`/quotes/public/${encodeURIComponent(token)}/images/${imageId}`)
          }
          buildUrl={publicApiPath}
          taxRate={taxRate}
          showTax={showTax}
        />

        <section className="flex justify-end">
          <div className="w-full max-w-xs space-y-2.5">
            {showTax && (
              <>
                <div className="flex justify-between text-sm">
                  {/* Basis qualifier — see QuoteDetailView: with recurring lines
                      a bare "Subtotal" never reconciles against the
                      due-on-acceptance figures below. */}
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
              <div className="space-y-0.5 text-sm text-muted-foreground" data-testid="public-quote-category-breakdown">
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
                {/* Anchor row — due on acceptance = deposit due now + remaining
                    balance, stated instead of implied (see QuoteDetailView). */}
                <div className="doc-accent-border flex justify-between border-t pt-3 text-sm" data-testid="public-quote-due-on-acceptance">
                  <span className="font-medium text-foreground">Due on acceptance</span>
                  <span className="font-medium tabular-nums text-foreground">{money(dueOnAcceptance, currency)}</span>
                </div>
                <div className="flex items-baseline justify-between" data-testid="public-quote-deposit-due">
                  <span className="text-sm font-semibold text-foreground">Deposit due now</span>
                  <span className="doc-accent-text text-2xl font-semibold tabular-nums">
                    {money(depositDue, currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm" data-testid="public-quote-deposit-remainder">
                  <span className="text-muted-foreground">Remaining balance (due per terms)</span>
                  <span className="tabular-nums text-foreground">{money(remainderCents / 100, currency)}</span>
                </div>
              </>
            ) : (
              <div className="doc-accent-border flex items-baseline justify-between border-t pt-3">
                <span className="text-sm font-semibold text-foreground">{hasRecurring ? 'Due on acceptance' : 'Total'}</span>
                <span className="doc-accent-text text-2xl font-semibold tabular-nums">
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
          <DocumentTerms label="Terms & Conditions" testId="public-quote-terms-conditions">{quote.termsAndConditions}</DocumentTerms>
        )}
      </DocumentPaper>

      {status === 'converted' && (
        <div data-testid="public-quote-accepted" role="status" className="space-y-3 rounded-md bg-success/10 p-4 text-sm text-success-on-tint">
          <p>{msg ?? 'This proposal has already been accepted.'}</p>
        </div>
      )}
      {status === 'declined' && msg && (
        <div role="status" className="rounded-md bg-muted p-3 text-sm">{msg}</div>
      )}
      {open && msg && (
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

      {open && (
        <SignaturePanel
          onAccept={(signerName) => void accept(signerName)}
          onDecline={(reason) => void decline(reason)}
          busy={busy}
          testIdPrefix="public-quote"
        />
      )}
    </div>
  );
}

export default PublicQuoteView;
