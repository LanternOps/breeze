import { useState } from 'react';
import { ArrowLeft, AlertCircle, Download } from 'lucide-react';
import { type QuoteDetail, buildPortalApiUrl, portalApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { QuoteBlocks, money } from './quoteBlocks';
import { DocumentPaper, DocumentHeader, DocumentTerms, type DocSeller } from './documentShell';
import { SignaturePanel } from './SignaturePanel';

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

  const { quote, blocks, lines, branding } = detail;
  const currency = quote.currencyCode;
  const open = status === 'sent' || status === 'viewed';

  const seller = (quote.sellerSnapshot ?? null) as DocSeller | null;
  const headerDates = [
    { label: 'Issued', value: shortDate(quote.issueDate) },
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

  const pay = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    setMsgError(false);
    const res = await portalApi.payQuote(quote.id);
    setBusy(false);
    if (res.error || !res.data?.data?.url) {
      setMsg(res.error ?? 'Online payment is not available for this proposal.');
      setMsgError(true);
      return;
    }
    window.location.href = res.data.data.url;
  };

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

  return (
    <div className="space-y-5" data-testid="quote-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href="/quotes" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" />
          Back to proposals
        </a>
        <a
          href={buildPortalApiUrl(`/portal/quotes/${quote.id}/pdf`)}
          download={`${quote.quoteNumber ?? `quote-${quote.id}`}.pdf`}
          target="_blank"
          rel="noreferrer"
          data-testid="quote-download-pdf"
          className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <Download className="h-4 w-4" />
          Download PDF
        </a>
      </div>

      <DocumentPaper primaryColor={branding?.primaryColor}>
        <DocumentHeader
          logoUrl={branding?.logoUrl}
          partnerName={branding?.partnerName}
          seller={seller}
          eyebrow="Proposal"
          title={quote.quoteNumber ?? 'Proposal'}
          statusLabel={STATUS_LABELS[status] ?? status}
          statusClass={statusColor(status)}
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
          imageUrl={(imageId) => buildPortalApiUrl(`/portal/quotes/${quote.id}/images/${imageId}`)}
          buildUrl={buildPortalApiUrl}
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
                <div className="flex justify-between border-t pt-3 text-sm" style={{ borderColor: 'var(--doc-accent)' }} data-testid="quote-due-on-acceptance">
                  <span className="font-medium text-foreground">Due on acceptance</span>
                  <span className="font-medium tabular-nums text-foreground">{money(dueOnAcceptance, currency)}</span>
                </div>
                <div className="flex items-baseline justify-between" data-testid="quote-deposit-due">
                  <span className="text-sm font-semibold text-foreground">Deposit due now</span>
                  <span className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--doc-accent)' }}>
                    {money(depositDue, currency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm" data-testid="quote-deposit-remainder">
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
          <DocumentTerms label="Terms & Conditions" testId="quote-terms-conditions">{quote.termsAndConditions}</DocumentTerms>
        )}
      </DocumentPaper>

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
        <SignaturePanel
          onAccept={(signerName) => void accept(signerName)}
          onDecline={() => void decline()}
          busy={busy}
          testIdPrefix="quote"
        />
      )}

      {status === 'converted' && (
        <button
          type="button"
          data-testid="quote-pay"
          disabled={busy}
          onClick={() => void pay()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Pay now'}
        </button>
      )}
    </div>
  );
}

export default QuoteDetailView;
