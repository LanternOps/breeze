import { useCallback, useMemo, type CSSProperties } from 'react';
import { useOrgStore } from '../../../stores/orgStore';
import { quoteImageUrl } from '../../../lib/api/quotes';
import { catalogItemImagePath } from '../../../lib/api/catalog';
import { useAuthedImage, useQuotePdfDownload } from './useQuoteImage';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  STATUS_ROLES,
  statusLabel,
  stripHtml,
  formatDate,
  formatMoney,
  lineTaxAmount,
  lineTitle,
  lineBlurb,
  pctFromFraction,
  sellerLines,
} from './quoteTypes';
import { StatusPill } from '../shared/StatusPill';

/** Uniform product thumbnail (per-line uploaded image or the catalog item's).
 *  Authed fetch (a bare `img src` would 401 — same pattern as DocImage); renders
 *  nothing on miss so image-less lines don't get an empty placeholder box. */
function DocLineThumb({ path }: { path: string }) {
  const { url } = useAuthedImage(path);
  if (!url) return null;
  return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded border bg-card object-contain" />;
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

/** Quote images require the Bearer header, so a bare <img src> would 401. The
 *  shared useAuthedImage hook fetches the authed bytes → blob → object URL,
 *  revoked on unmount/change. Same loader the editor and detail views use. */
function DocImage({ quoteId, imageId, caption }: { quoteId: string; imageId: string; caption?: string }) {
  const { url, failed } = useAuthedImage(quoteImageUrl(quoteId, imageId));

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

function PricingTable({ lines, quoteId, currency, label, taxRate, showTax }: { lines: QuoteLine[]; quoteId: string; currency: string; label?: string; taxRate: string | null; showTax: boolean }) {
  if (lines.length === 0) return null;
  const sorted = [...lines].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {label && (
        <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold text-foreground sm:px-5">{label}</div>
      )}
      <div className="overflow-x-auto" role="region" aria-label={`${label || 'Pricing'} — scroll sideways for more columns`} tabIndex={0}>
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium sm:px-5">Description</th>
              <th className="px-2 py-2.5 text-right font-medium">Qty</th>
              <th className="px-2 py-2.5 text-right font-medium">Unit price</th>
              {showTax && <th className="px-2 py-2.5 text-right font-medium">Tax</th>}
              <th className="px-4 py-2.5 text-right font-medium sm:px-5">Amount</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l) => {
              const suffix = RECURRENCE_SUFFIX[l.recurrence];
              const tag = RECURRENCE_LABEL[l.recurrence];
              const tax = showTax ? lineTaxAmount(l.lineTotal, l.taxable, taxRate) : null;
              return (
                <tr key={l.id} className="border-b align-top last:border-0">
                  <td className="px-4 py-3 text-foreground sm:px-5">
                    <div className="flex items-start gap-2.5">
                      {(l.imageId || l.catalogItemId) && (
                        <DocLineThumb path={l.imageId ? quoteImageUrl(quoteId, l.imageId) : catalogItemImagePath(l.catalogItemId!)} />
                      )}
                      <div className="min-w-0">
                        <span className="font-medium">{lineTitle(l)}</span>
                        {tag && (
                          <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[hsl(220_12%_40%)] dark:text-muted-foreground">
                            {tag}
                          </span>
                        )}
                        {lineBlurb(l) && (
                          <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{lineBlurb(l)}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{l.quantity}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">
                    {formatMoney(l.unitPrice, currency)}{suffix && <span className="text-xs">{suffix}</span>}
                  </td>
                  {showTax && (
                    <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">
                      {tax === null ? '—' : formatMoney(tax, currency)}
                    </td>
                  )}
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

function DocBlock({ block, lines, quoteId, currency, taxRate, showTax }: { block: QuoteBlock; lines: QuoteLine[]; quoteId: string; currency: string; taxRate: string | null; showTax: boolean }) {
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
  return <PricingTable lines={lines} quoteId={quoteId} currency={currency} label={label} taxRate={taxRate} showTax={showTax} />;
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
  // Only surface the per-line Tax column when this quote actually carries tax —
  // otherwise it's a column of dashes. Mirrors the header Tax row's visibility.
  const showTax = Number(quote.taxTotal) > 0;

  return (
    <div
      style={accentStyle}
      data-testid="quote-document"
      className="mx-auto max-w-3xl overflow-hidden rounded-xl border bg-card shadow-xs"
    >
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
            {/* Brand letterhead rule — a short, deliberate accent mark, not a full-bleed stripe. */}
            <div className="h-0.5 w-10 rounded-full" style={{ backgroundColor: 'var(--doc-accent)' }} aria-hidden />
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
            <p className="text-[1.75rem] font-semibold leading-none tracking-tight text-foreground" data-testid="quote-document-number">
              {quote.quoteNumber ?? 'Draft'}
            </p>
            <p className="text-sm font-medium text-muted-foreground">Proposal</p>
            <StatusPill
              role={STATUS_ROLES[quote.status].role}
              label={statusLabel(quote)}
              className={STATUS_ROLES[quote.status].className}
            />
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
          {quote.title?.trim() && (
            <h1 className="text-xl font-semibold tracking-tight text-foreground" data-testid="quote-document-title">
              {quote.title}
            </h1>
          )}
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
              <DocBlock key={block.id} block={block} lines={linesForBlock(block.id)} quoteId={quote.id} currency={currency} taxRate={quote.taxRate} showTax={showTax} />
            ))}
            {looseLines.length > 0 && <PricingTable lines={looseLines} quoteId={quote.id} currency={currency} label="Additional items" taxRate={quote.taxRate} showTax={showTax} />}
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
              {showTax && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Tax{quote.taxRate ? ` (${pctFromFraction(quote.taxRate)}%)` : ''}
                  </span>
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
  const { busy, downloadPdf } = useQuotePdfDownload(quote);

  const customerName = useMemo(() => {
    const billTo = quote.billToName?.trim();
    if (billTo) return billTo;
    const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
    // Never leak a raw org UUID fragment onto a customer-facing document — if the
    // org store hasn't resolved a name yet, show a neutral em-dash instead.
    return resolved || '—';
  }, [quote.billToName, quote.orgId, organizations]);

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
