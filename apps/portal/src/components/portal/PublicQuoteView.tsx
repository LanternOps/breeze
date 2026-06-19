import { useState } from 'react';
import { portalApi, buildPortalApiUrl, type PublicQuoteDetail } from '@/lib/api';
import { cn } from '@/lib/utils';
import { QuoteBlocks, money } from './quoteBlocks';

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
  const [name, setName] = useState('');
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

  const accept = async () => {
    if (busy) return;
    if (!name.trim()) {
      setMsg('Please type your full name to sign.');
      setMsgError(true);
      return;
    }
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.acceptPublicQuote(token, name.trim());
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
    <div data-testid="public-quote" className="mx-auto w-full max-w-2xl space-y-6 p-2 sm:p-6">
      <header className="flex items-center gap-3 border-b pb-4">
        {branding.logoUrl && (
          <img src={branding.logoUrl} alt={branding.partnerName} className="h-10 w-auto" />
        )}
        <div>
          <h1 className="text-xl font-semibold">
            Proposal {quote.quoteNumber ?? ''}
          </h1>
          <p className="text-sm text-muted-foreground">
            from {branding.partnerName}
            {quote.expiryDate ? ` · valid until ${shortDate(quote.expiryDate)}` : ''}
          </p>
        </div>
      </header>

      {quote.introNotes && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{quote.introNotes}</p>
      )}

      <QuoteBlocks
        blocks={blocks}
        lines={lines}
        currency={currency}
        imageUrl={(imageId) =>
          buildPortalApiUrl(`/quotes/public/${encodeURIComponent(token)}/images/${imageId}`)
        }
      />

      <div className="ml-auto max-w-xs space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">One-time</span>
          <span>{money(quote.oneTimeTotal ?? 0, currency)}</span>
        </div>
        {Number(quote.monthlyRecurringTotal ?? 0) > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Monthly</span>
            <span>{money(quote.monthlyRecurringTotal ?? 0, currency)}/mo</span>
          </div>
        )}
        {Number(quote.annualRecurringTotal ?? 0) > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Annual</span>
            <span>{money(quote.annualRecurringTotal ?? 0, currency)}/yr</span>
          </div>
        )}
        <div className="flex justify-between border-t pt-1 font-semibold">
          <span>{hasRecurring ? 'First invoice total' : 'Total'}</span>
          <span>{money(quote.total, currency)}</span>
        </div>
      </div>

      {quote.terms && (
        <div className="rounded-lg border p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Terms</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{quote.terms}</p>
        </div>
      )}

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
        <div className="space-y-3 rounded-md border p-4">
          <label htmlFor="public-quote-signer" className="block text-sm font-medium">
            Type your full name to accept &amp; sign
          </label>
          <input
            id="public-quote-signer"
            data-testid="public-quote-signer"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className="w-full rounded-md border px-3 py-2 text-sm disabled:opacity-50"
            placeholder="Your full name"
          />
          <div className="flex gap-3">
            <button
              type="button"
              data-testid="public-quote-accept"
              disabled={busy}
              onClick={() => void accept()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Accept & sign'}
            </button>
            <button
              type="button"
              data-testid="public-quote-decline"
              disabled={busy}
              onClick={() => void decline()}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PublicQuoteView;
