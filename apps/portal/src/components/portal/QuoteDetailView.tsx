import { useState } from 'react';
import { ArrowLeft, AlertCircle, Download } from 'lucide-react';
import { type QuoteDetail, buildPortalApiUrl, portalApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { QuoteBlocks, money } from './quoteBlocks';

interface QuoteDetailViewProps {
  detail: QuoteDetail | null;
  error?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  converted: 'Accepted',
};

function statusColor(status: string): string {
  switch (status) {
    case 'accepted':
    case 'converted':
      return 'bg-success/10 text-success';
    case 'declined':
    case 'expired':
      return 'bg-destructive/10 text-destructive';
    case 'viewed':
    case 'sent':
      return 'bg-warning/10 text-warning';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

export function QuoteDetailView({ detail, error }: QuoteDetailViewProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgError, setMsgError] = useState(false);
  const [status, setStatus] = useState(detail?.quote.status ?? '');

  if (error || !detail) {
    return (
      <div className="text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
        <h3 className="mt-4 text-lg font-medium">Proposal not found</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {error || 'The proposal you are looking for does not exist.'}
        </p>
        <a href="/quotes" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" />
          Back to proposals
        </a>
      </div>
    );
  }

  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;
  const open = status === 'sent' || status === 'viewed';

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.acceptQuote(quote.id);
    setBusy(false);
    if (res.error) {
      setMsg(res.error);
      setMsgError(true);
      return;
    }
    setStatus('converted');
    setMsg('Accepted — an invoice has been created.');
  };

  const decline = async () => {
    if (busy) return;
    const reason = window.prompt('Optionally, tell us why you are declining:') ?? undefined;
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
    setMsg('Proposal declined.');
  };

  const hasRecurring =
    Number(quote.monthlyRecurringTotal ?? 0) > 0 || Number(quote.annualRecurringTotal ?? 0) > 0;

  return (
    <div className="space-y-6" data-testid="quote-detail">
      <a href="/quotes" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" />
        Back to proposals
      </a>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Proposal {quote.quoteNumber ?? ''}</h1>
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <span className={cn('inline-flex rounded-full px-2 py-1 text-xs font-medium', statusColor(status))}>
              {STATUS_LABELS[status] ?? status}
            </span>
            <span>Issued {shortDate(quote.issueDate)}</span>
            {quote.expiryDate && (
              <>
                <span>·</span>
                <span>Valid until {shortDate(quote.expiryDate)}</span>
              </>
            )}
          </div>
        </div>
        <a
          href={buildPortalApiUrl(`/portal/quotes/${quote.id}/pdf`)}
          target="_blank"
          rel="noreferrer"
          data-testid="quote-download-pdf"
          className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <Download className="h-4 w-4" />
          Download PDF
        </a>
      </div>

      {quote.introNotes && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{quote.introNotes}</p>
      )}

      <QuoteBlocks
        blocks={blocks}
        lines={lines}
        currency={currency}
        imageUrl={(imageId) => buildPortalApiUrl(`/portal/quotes/${quote.id}/images/${imageId}`)}
      />

      <div className="ml-auto max-w-xs space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">One-time</span>
          <span>{money(quote.oneTimeTotal ?? 0, currency)}</span>
        </div>
        {hasRecurring && (
          <>
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
          </>
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

      {msg && (
        <div
          data-testid={status === 'converted' ? 'quote-accept-success' : 'quote-msg'}
          className={cn(
            'rounded-md p-3 text-sm',
            msgError ? 'bg-destructive/10 text-destructive' : 'bg-muted'
          )}
        >
          {msg}
        </div>
      )}

      {open && (
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="quote-accept"
            disabled={busy}
            onClick={() => void accept()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Accept & sign'}
          </button>
          <button
            type="button"
            data-testid="quote-decline"
            disabled={busy}
            onClick={() => void decline()}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

export default QuoteDetailView;
