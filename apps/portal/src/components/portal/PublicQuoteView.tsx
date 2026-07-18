import { useState } from 'react';
import { portalApi, buildPortalApiUrl, type PublicQuoteDetail } from '@/lib/api';
import { cn } from '@/lib/utils';
import { QuoteBlocks, money } from './quoteBlocks';
import { DocumentPaper, DocumentHeader, DocumentTerms, type DocSeller } from './documentShell';
import { SignaturePanel } from './SignaturePanel';

interface PublicQuoteViewProps {
  token: string;
  initial: PublicQuoteDetail | null;
  error?: string | null;
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

export function PublicQuoteView({ token, initial, error }: PublicQuoteViewProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initial?.quote.status ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [msgError, setMsgError] = useState(false);
  const [payUrl, setPayUrl] = useState<string | null>(null);

  if (error || !initial) {
    return (
      <div data-testid="public-quote-error" className="mx-auto max-w-lg p-8 text-center text-destructive">
        <p className="text-sm">{error ?? 'This proposal link is invalid or has expired.'}</p>
      </div>
    );
  }

  const { quote, blocks, lines, branding } = initial;
  const currency = quote.currencyCode;
  const open = status === 'sent' || status === 'viewed';
  const hasRecurring =
    Number(quote.monthlyRecurringTotal ?? 0) > 0 || Number(quote.annualRecurringTotal ?? 0) > 0;
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

  const statusBadge =
    status === 'accepted' || status === 'converted'
      ? { label: 'Accepted', cls: 'bg-success/10 text-success' }
      : status === 'declined'
        ? { label: 'Declined', cls: 'bg-destructive/10 text-destructive' }
        : status === 'expired'
          ? { label: 'Expired', cls: 'bg-destructive/10 text-destructive' }
          : null;

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
    // Phase 3: the accept response carries a one-shot Stripe checkout URL (the accept
    // token is now spent, so it can't be re-minted). payDeferred means a link was
    // expected but couldn't be minted right now (e.g. a transient Stripe error) — tell
    // the customer a link is coming rather than silently dropping the payment CTA.
    setPayUrl(res.data?.data?.payUrl ?? null);
    setMsg(
      res.data?.data?.payDeferred
        ? 'Thank you — your acceptance has been recorded. We’ll email you a payment link shortly.'
        : 'Thank you — your acceptance has been recorded.'
    );
  };

  const decline = async () => {
    if (busy) return;
    const reason = window.prompt('Optionally, tell us why:') ?? undefined;
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
    setMsg('You have declined this proposal.');
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-2 sm:p-4">
      <DocumentPaper primaryColor={branding.primaryColor} testId="public-quote">
        <DocumentHeader
          logoUrl={branding.logoUrl}
          partnerName={branding.partnerName}
          seller={seller}
          eyebrow="Proposal"
          title={quote.quoteNumber ?? 'Proposal'}
          statusLabel={statusBadge?.label}
          statusClass={statusBadge?.cls}
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
            buildPortalApiUrl(`/quotes/public/${encodeURIComponent(token)}/images/${imageId}`)
          }
          buildUrl={buildPortalApiUrl}
          taxRate={taxRate}
          showTax={showTax}
        />

        <section className="flex justify-end">
          <div className="w-full max-w-xs space-y-2.5">
            {showTax && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums text-foreground">{money(quote.subtotal ?? 0, currency)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tax{taxPct ? ` (${taxPct}%)` : ''}</span>
                  <span className="tabular-nums text-foreground">{money(quote.taxTotal ?? 0, currency)}</span>
                </div>
              </>
            )}
            {hasRecurring && Number(quote.monthlyRecurringTotal ?? 0) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Monthly recurring</span>
                <span className="tabular-nums text-foreground">{money(quote.monthlyRecurringTotal ?? 0, currency)}<span className="text-xs text-muted-foreground">/mo</span></span>
              </div>
            )}
            {hasRecurring && Number(quote.annualRecurringTotal ?? 0) > 0 && (
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
                <div className="flex items-baseline justify-between border-t pt-3" style={{ borderColor: 'var(--doc-accent)' }} data-testid="public-quote-deposit-due">
                  <span className="text-sm font-semibold text-foreground">Deposit due on acceptance</span>
                  <span className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--doc-accent)' }}>
                    {money(depositDue, currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm" data-testid="public-quote-deposit-remainder">
                  <span className="text-muted-foreground">Remaining balance (due per terms)</span>
                  <span className="tabular-nums text-foreground">{money(remainderCents / 100, currency)}</span>
                </div>
              </>
            ) : (
              <div className="flex items-baseline justify-between border-t pt-3" style={{ borderColor: 'var(--doc-accent)' }}>
                <span className="text-sm font-semibold text-foreground">{hasRecurring ? 'Due on acceptance' : 'Total'}</span>
                <span className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--doc-accent)' }}>
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
        <div data-testid="public-quote-accepted" className="space-y-3 rounded-md bg-success/10 p-4 text-sm text-success">
          <p>{msg ?? 'This proposal has already been accepted.'}</p>
          {payUrl && (
            <a
              href={payUrl}
              data-testid="public-quote-pay"
              className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Pay now
            </a>
          )}
        </div>
      )}
      {status === 'declined' && msg && (
        <div className="rounded-md bg-muted p-3 text-sm">{msg}</div>
      )}
      {open && msg && (
        <div
          className={cn(
            'rounded-md p-3 text-sm',
            msgError ? 'bg-destructive/10 text-destructive' : 'bg-muted'
          )}
        >
          {msg}
        </div>
      )}

      {open && (
        <SignaturePanel
          onAccept={(signerName) => void accept(signerName)}
          onDecline={() => void decline()}
          busy={busy}
          testIdPrefix="public-quote"
        />
      )}
    </div>
  );
}

export default PublicQuoteView;
