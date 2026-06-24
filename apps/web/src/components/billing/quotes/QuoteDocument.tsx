import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { handleActionError } from '../../../lib/runAction';
import { useOrgStore } from '../../../stores/orgStore';
import { quotePdfUrl, quoteImageUrl } from '../../../lib/api/quotes';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  STATUS_COLORS,
  statusLabel,
  formatDate,
  formatMoney,
  sellerLines,
} from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

// rich_text blocks store author HTML. We render the result as a React text node
// (auto-escaped) — never via dangerouslySetInnerHTML — so this is display
// cleanup, not a security boundary. The tag strip runs to a fixpoint so a split
// tag (e.g. `<<script>script>`) can't survive a single pass, and `&amp;` is
// decoded LAST so it can't re-introduce an entity that a later rule re-decodes.
function stripHtml(html: string): string {
  let out = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n');
  let prev: string;
  do { prev = out; out = out.replace(/<[^>]*>/g, ''); } while (out !== prev);
  return out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const RECURRENCE_LABEL: Record<QuoteLine['recurrence'], string> = {
  one_time: '',
  monthly: 'Monthly',
  annual: 'Annual',
};
const RECURRENCE_SUFFIX: Record<QuoteLine['recurrence'], string> = {
  one_time: '',
  monthly: '/mo',
  annual: '/yr',
};

/** Quote images require the Bearer header, so a bare <img src> would 401. Fetch
 *  the authed bytes → blob → object URL, revoked on unmount/change. Mirrors the
 *  editor's QuoteImagePreview. */
function DocImage({ quoteId, imageId, caption }: { quoteId: string; imageId: string; caption?: string }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | undefined;
    let active = true;
    (async () => {
      try {
        const res = await fetchWithAuth(quoteImageUrl(quoteId, imageId));
        if (!res.ok) { if (active) setFailed(true); return; }
        const blob = await res.blob();
        objectUrl = window.URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
        else window.URL.revokeObjectURL(objectUrl);
      } catch (err) {
        console.error('[QuoteDocument] image load failed', imageId, err instanceof Error ? err.message : err);
        if (active) setFailed(true);
      }
    })();
    return () => { active = false; if (objectUrl) window.URL.revokeObjectURL(objectUrl); };
  }, [quoteId, imageId]);

  if (failed) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center text-xs text-muted-foreground">
        Image unavailable
      </div>
    );
  }
  if (!url) {
    return <div className="h-40 animate-pulse rounded-lg bg-muted/60" aria-hidden />;
  }
  return (
    <figure className="space-y-2">
      <img src={url} alt={caption || 'Proposal image'} className="w-full rounded-lg border bg-card object-contain" />
      {caption && <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}

function PricingTable({ lines, currency, label }: { lines: QuoteLine[]; currency: string; label?: string }) {
  if (lines.length === 0) return null;
  const sorted = [...lines].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {label && (
        <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold text-foreground sm:px-5">{label}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium sm:px-5">Description</th>
              <th className="px-2 py-2.5 text-right font-medium">Qty</th>
              <th className="px-2 py-2.5 text-right font-medium">Unit price</th>
              <th className="px-4 py-2.5 text-right font-medium sm:px-5">Amount</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l) => {
              const suffix = RECURRENCE_SUFFIX[l.recurrence];
              const tag = RECURRENCE_LABEL[l.recurrence];
              return (
                <tr key={l.id} className="border-b align-top last:border-0">
                  <td className="px-4 py-3 text-foreground sm:px-5">
                    <span>{l.description}</span>
                    {tag && (
                      <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {tag}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{l.quantity}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">
                    {formatMoney(l.unitPrice, currency)}{suffix && <span className="text-xs">{suffix}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-foreground sm:px-5">
                    {formatMoney(l.lineTotal, currency)}{suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocBlock({ block, lines, currency }: { block: QuoteBlock; lines: QuoteLine[]; currency: string }) {
  if (block.blockType === 'heading') {
    const text = (block.content?.text as string | undefined)?.trim();
    if (!text) return null;
    return <h2 className="text-balance text-lg font-semibold text-foreground">{text}</h2>;
  }
  if (block.blockType === 'rich_text') {
    const text = stripHtml((block.content?.html as string | undefined) ?? '');
    if (!text) return null;
    return <p className="max-w-prose whitespace-pre-wrap text-pretty text-sm leading-relaxed text-foreground/90">{text}</p>;
  }
  if (block.blockType === 'image') {
    const imageId = (block.content?.imageId as string | undefined) ?? '';
    const caption = (block.content?.caption as string | undefined) ?? '';
    if (!imageId) return null;
    return <DocImage quoteId={block.quoteId} imageId={imageId} caption={caption} />;
  }
  // line_items
  const label = (block.content?.label as string | undefined)?.trim() || 'Pricing';
  return <PricingTable lines={lines} currency={currency} label={label} />;
}

interface DocumentProps {
  detail: QuoteDetailData;
  /** Resolved customer/bill-to name (parent looks it up against the org list). */
  customerName: string;
}

/** Pure, presentational customer-facing proposal document. Renders the same
 *  content the customer sees on their portal link, branded with the partner's
 *  logo/accent. Works for drafts (no portal round-trip). */
export function QuoteDocument({ detail, customerName }: DocumentProps) {
  const { quote, blocks, lines, branding } = detail;
  const currency = branding?.currencyCode ?? quote.currencyCode;
  const seller = branding?.seller ?? quote.sellerSnapshot ?? null;
  const accent = branding?.primaryColor || 'hsl(var(--primary))';
  const accentStyle = { ['--doc-accent']: accent } as CSSProperties;

  const sortedBlocks = useMemo(() => [...blocks].sort((a, b) => a.sortOrder - b.sortOrder), [blocks]);
  const linesForBlock = useCallback(
    (blockId: string | null) => lines.filter((l) => l.blockId === blockId).sort((a, b) => a.sortOrder - b.sortOrder),
    [lines],
  );
  const looseLines = useMemo(() => linesForBlock(null), [linesForBlock]);
  const isEmpty = sortedBlocks.length === 0 && looseLines.length === 0;

  const hasRecurring =
    Number(quote.monthlyRecurringTotal) > 0 || Number(quote.annualRecurringTotal) > 0;
  const dueOnAcceptance = quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal;

  return (
    <div
      style={accentStyle}
      data-testid="quote-document"
      className="mx-auto max-w-3xl overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      {/* Accent top rule */}
      <div className="h-1.5 w-full" style={{ backgroundColor: 'var(--doc-accent)' }} aria-hidden />

      <div className="space-y-10 px-4 py-7 sm:px-12 sm:py-10">
        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            {branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.partnerName} className="h-11 w-auto max-w-[220px] object-contain" />
            ) : (
              <p className="text-xl font-semibold tracking-tight text-foreground" data-testid="quote-document-wordmark">
                {branding?.partnerName ?? 'Proposal'}
              </p>
            )}
            {seller && (
              <address className="space-y-0.5 text-xs not-italic leading-relaxed text-muted-foreground">
                {seller.name && <p className="font-medium text-foreground/80">{seller.name}</p>}
                {sellerLines(seller.address).map((line, i) => <p key={i}>{line}</p>)}
                {seller.phone && <p>{seller.phone}</p>}
                {seller.email && <p>{seller.email}</p>}
                {seller.website && <p>{seller.website}</p>}
              </address>
            )}
          </div>

          <div className="space-y-2 sm:text-right">
            <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--doc-accent)' }}>
              Proposal
            </p>
            <p className="text-2xl font-semibold tracking-tight text-foreground" data-testid="quote-document-number">
              {quote.quoteNumber ?? 'Draft'}
            </p>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[quote.status]}`}
            >
              {statusLabel(quote)}
            </span>
            <dl className="space-y-0.5 pt-1 text-xs text-muted-foreground sm:flex sm:flex-col sm:items-end">
              <div className="flex gap-2"><dt>Issued</dt><dd className="font-medium text-foreground/80">{formatDate(quote.issueDate)}</dd></div>
              {quote.expiryDate && (
                <div className="flex gap-2"><dt>Valid until</dt><dd className="font-medium text-foreground/80">{formatDate(quote.expiryDate)}</dd></div>
              )}
            </dl>
          </div>
        </header>

        {/* ── Prepared for + intro ───────────────────────────────── */}
        <section className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prepared for</p>
            <p className="mt-1 text-base font-medium text-foreground" data-testid="quote-document-customer">{customerName}</p>
          </div>
          {quote.introNotes?.trim() && (
            <p className="max-w-prose whitespace-pre-wrap text-pretty text-sm leading-relaxed text-foreground/90">
              {quote.introNotes.trim()}
            </p>
          )}
        </section>

        {/* ── Body blocks ────────────────────────────────────────── */}
        {isEmpty ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
            This proposal doesn’t have any content yet.
          </div>
        ) : (
          <div className="space-y-6">
            {sortedBlocks.map((block) => (
              <DocBlock key={block.id} block={block} lines={linesForBlock(block.id)} currency={currency} />
            ))}
            {looseLines.length > 0 && <PricingTable lines={looseLines} currency={currency} label="Additional items" />}
          </div>
        )}

        {/* ── Totals ─────────────────────────────────────────────── */}
        {!isEmpty && (
          <section className="flex justify-end">
            <div className="w-full max-w-xs space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums text-foreground">{formatMoney(quote.subtotal, currency)}</span>
              </div>
              {Number(quote.taxTotal) > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="tabular-nums text-foreground">{formatMoney(quote.taxTotal, currency)}</span>
                </div>
              )}
              <div
                className="flex items-baseline justify-between border-t pt-3"
                style={{ borderColor: 'var(--doc-accent)' }}
              >
                <span className="text-sm font-semibold text-foreground">Due on acceptance</span>
                <span
                  className="text-2xl font-semibold tabular-nums"
                  style={{ color: 'var(--doc-accent)' }}
                  data-testid="quote-document-due"
                >
                  {formatMoney(dueOnAcceptance, currency)}
                </span>
              </div>

              {hasRecurring && (
                <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
                  {Number(quote.monthlyRecurringTotal) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Monthly recurring</span>
                      <span className="tabular-nums text-foreground">{formatMoney(quote.monthlyRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/mo</span></span>
                    </div>
                  )}
                  {Number(quote.annualRecurringTotal) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Annual recurring</span>
                      <span className="tabular-nums text-foreground">{formatMoney(quote.annualRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/yr</span></span>
                    </div>
                  )}
                  <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                    Accepting this proposal bills the one-time charges now. Recurring lines bill on their own schedule.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Terms & footer ─────────────────────────────────────── */}
        {quote.termsAndConditions?.trim() && (
          <section className="space-y-2 border-t pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms &amp; Conditions</h3>
            <p className="max-w-prose whitespace-pre-wrap text-pretty text-xs leading-relaxed text-muted-foreground">
              {quote.termsAndConditions.trim()}
            </p>
          </section>
        )}
        {branding?.footer?.trim() && (
          <footer className="border-t pt-6 text-center text-xs leading-relaxed text-muted-foreground">
            {branding.footer.trim()}
          </footer>
        )}
      </div>
    </div>
  );
}

/** Preview-tab wrapper: resolves the customer name from the loaded org list (same
 *  source as QuoteDetail), renders the document, and offers a PDF download. */
export default function QuoteDocumentPreview({ detail }: { detail: QuoteDetailData }) {
  const { quote } = detail;
  const organizations = useOrgStore((s) => s.organizations);
  const [busy, setBusy] = useState(false);

  const customerName = useMemo(() => {
    const billTo = quote.billToName?.trim();
    if (billTo) return billTo;
    const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
    return resolved || quote.orgId.slice(0, 8);
  }, [quote.billToName, quote.orgId, organizations]);

  const downloadPdf = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth(quotePdfUrl(quote.id));
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) { handleActionError(new Error('pdf'), 'Could not download the quote PDF.'); return; }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${quote.quoteNumber ?? `quote-${quote.id}`}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      handleActionError(err, 'Could not download the quote PDF.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, quote.quoteNumber]);

  return (
    <div className="space-y-4" data-testid="quote-preview">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">This is what your customer sees on their proposal link.</p>
        <button
          type="button"
          onClick={() => void downloadPdf()}
          disabled={busy}
          data-testid="quote-preview-download-pdf"
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      <div className="rounded-xl bg-muted/30 p-2 sm:p-8">
        <QuoteDocument detail={detail} customerName={customerName} />
      </div>
    </div>
  );
}
