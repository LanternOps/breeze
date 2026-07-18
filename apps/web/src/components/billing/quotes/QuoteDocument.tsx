import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { useOrgStore } from '../../../stores/orgStore';
import { quoteImageUrl } from '../../../lib/api/quotes';
import { catalogItemImagePath } from '../../../lib/api/catalog';
import { useAuthedImage, useQuotePdfDownload } from './useQuoteImage';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  type ContractBlockContent,
  STATUS_ROLES,
  statusLabel,
  formatDate,
  formatMoney,
  formatQuantity,
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

/** Quote images require the Bearer header, so a bare <img src> would 401. The
 *  shared useAuthedImage hook fetches the authed bytes → blob → object URL,
 *  revoked on unmount/change. Same loader the editor and detail views use. */
function DocImage({ quoteId, imageId, caption }: { quoteId: string; imageId: string; caption?: string }) {
  const { t } = useTranslation('billing');
  const { url, failed } = useAuthedImage(quoteImageUrl(quoteId, imageId));
  const [zoomed, setZoomed] = useState(false);

  // Escape closes the zoom overlay (parity with clicking the backdrop).
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  if (failed) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center text-xs text-muted-foreground">
        {t('quotes.document.imageUnavailable')}
      </div>
    );
  }
  if (!url) {
    return <div className="h-40 animate-pulse rounded-lg bg-muted/60" aria-hidden />;
  }
  const alt = caption || t('quotes.document.proposalImageAlt');
  return (
    <figure className="space-y-2">
      {/* Click to view a larger version — a button keeps it keyboard-reachable. */}
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label={t('quotes.document.imageZoomAria')}
        data-testid="quote-image-zoom-trigger"
        className="block w-full cursor-zoom-in rounded-lg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img src={url} alt={alt} className="w-full rounded-lg border bg-card object-contain" />
      </button>
      {caption && <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>}
      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setZoomed(false)}
          data-testid="quote-image-lightbox"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
        >
          <img src={url} alt={alt} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        </div>
      )}
    </figure>
  );
}

/** Uploaded contract PDF requires the Bearer header, so a bare `<iframe src>`
 *  would 401 — reuse useAuthedImage's fetch-as-blob mechanics (it works for any
 *  binary response, not just images) so the preview + download link get an
 *  authed, revoked-on-unmount blob URL, same pattern as DocImage above. */
function DocContractFile({ fileUrl, templateName }: { fileUrl: string; templateName: string }) {
  const { t } = useTranslation('billing');
  const { url, failed } = useAuthedImage(fileUrl);
  if (failed) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center text-xs text-muted-foreground">
        {t('quotes.document.contract.unavailable')}
      </div>
    );
  }
  if (!url) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted/60" aria-hidden />;
  }
  return (
    <div className="space-y-2">
      <iframe
        src={url}
        title={t('quotes.document.contract.previewTitle', { name: templateName })}
        className="h-[32rem] w-full rounded-lg border"
      />
      <a
        href={url}
        download
        data-testid="quote-contract-download"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        {t('quotes.document.contract.download')}
      </a>
    </div>
  );
}

function PricingTable({ lines, quoteId, currency, label, taxRate, showTax, showSubtotal }: { lines: QuoteLine[]; quoteId: string; currency: string; label?: string; taxRate: string | null; showTax: boolean; showSubtotal?: boolean }) {
  const { t } = useTranslation('billing');
  if (lines.length === 0) return null;
  const sorted = [...lines].sort((a, b) => a.sortOrder - b.sortOrder);
  // Opt-in per-table subtotal, summed from THIS table's rows and split by
  // recurrence (a table can mix one-time / monthly / annual). Only non-zero
  // buckets are shown, joined with " + " — matching the document footer style.
  const subtotalParts: string[] = [];
  if (showSubtotal) {
    const sums = { one_time: 0, monthly: 0, annual: 0 };
    for (const l of sorted) {
      // Fold any unrecognized recurrence into one_time so the subtotal always
      // covers every rendered row (parity with the PDF renderer).
      const key = l.recurrence === 'monthly' || l.recurrence === 'annual' ? l.recurrence : 'one_time';
      sums[key] += Number(l.lineTotal);
    }
    if (sums.one_time > 0) subtotalParts.push(formatMoney(sums.one_time, currency));
    if (sums.monthly > 0) subtotalParts.push(`${formatMoney(sums.monthly, currency)}${t('billingUi.units.perMonth')}`);
    if (sums.annual > 0) subtotalParts.push(`${formatMoney(sums.annual, currency)}${t('billingUi.units.perYear')}`);
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {label && (
        <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold text-foreground sm:px-5">{label}</div>
      )}
      <div className="overflow-x-auto" role="region" aria-label={t('quotes.document.pricingScrollAria', { label: label || t('quotes.document.pricing') })} tabIndex={0}>
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium sm:px-5">{t('quotes.document.table.description')}</th>
              <th className="px-2 py-2.5 text-right font-medium">{t('quotes.document.table.qty')}</th>
              <th className="px-2 py-2.5 text-right font-medium">{t('quotes.document.table.unitPrice')}</th>
              {showTax && <th className="px-2 py-2.5 text-right font-medium">{t('quotes.document.table.tax')}</th>}
              <th className="px-4 py-2.5 text-right font-medium sm:px-5">{t('quotes.document.table.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l) => {
              const suffix = l.recurrence === 'monthly' ? t('billingUi.units.perMonth') : l.recurrence === 'annual' ? t('billingUi.units.perYear') : '';
              const tag = l.recurrence === 'monthly' ? t('quotes.document.recurrence.monthly') : l.recurrence === 'annual' ? t('quotes.document.recurrence.annual') : '';
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
                          <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70 dark:text-muted-foreground">
                            {tag}
                          </span>
                        )}
                        {lineBlurb(l) && (
                          <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{lineBlurb(l)}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{formatQuantity(l.quantity)}</td>
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
          {showSubtotal && subtotalParts.length > 0 && (
            <tfoot>
              <tr className="border-t-2 bg-muted/20" data-testid="quote-table-subtotal">
                <td className="px-4 py-2.5 text-right text-sm font-semibold text-foreground sm:px-5" colSpan={showTax ? 4 : 3}>
                  {t('quotes.document.totals.subtotal')}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-foreground sm:px-5">
                  {subtotalParts.join(' + ')}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function DocBlock({ block, lines, quoteId, currency, taxRate, showTax }: { block: QuoteBlock; lines: QuoteLine[]; quoteId: string; currency: string; taxRate: string | null; showTax: boolean }) {
  const { t } = useTranslation('billing');
  if (block.blockType === 'heading') {
    const text = (block.content?.text as string | undefined)?.trim();
    if (!text) return null;
    return <h2 className="text-balance text-lg font-semibold text-foreground">{text}</h2>;
  }
  if (block.blockType === 'rich_text') {
    // The API sanitizes every rich_text block's content.html on both write and
    // read serialization (richTextSanitize.ts's fixed p/br/strong/em/u/h3/h4/
    // ul/ol/li/a allowlist) before it ever reaches this component, so rendering
    // it as real HTML here is safe.
    const html = (block.content?.html as string | undefined) ?? '';
    if (!html.trim()) return null;
    return (
      <div
        className="quote-rich-text prose prose-sm max-w-prose text-pretty leading-relaxed text-foreground/90 dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  if (block.blockType === 'image') {
    const imageId = (block.content?.imageId as string | undefined) ?? '';
    const caption = (block.content?.caption as string | undefined) ?? '';
    if (!imageId) return null;
    return <DocImage quoteId={block.quoteId} imageId={imageId} caption={caption} />;
  }
  if (block.blockType === 'contract') {
    // Server-rendered content (renderContractBlocksForClient) — never the raw
    // templateId/templateVersionId/variableValues authoring shape.
    const content = (block.content ?? {}) as Partial<ContractBlockContent>;
    const templateName = content.templateName?.trim() || '';
    const versionNumber = content.versionNumber ?? 0;
    const label = content.label?.trim();
    return (
      <div className="space-y-3 rounded-lg border bg-card p-4 sm:p-5" data-testid="contract-block">
        {label && <h3 className="text-base font-semibold text-foreground">{label}</h3>}
        {content.sourceType === 'authored' ? (
          content.renderedHtml ? (
            // Server-substituted HTML from an authored contract template — same
            // sanitizer output + HTML-escaped substitution path as rich_text
            // blocks above, safe to render as-is.
            <div
              className="quote-rich-text prose prose-sm max-w-prose text-pretty leading-relaxed text-foreground/90 dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: content.renderedHtml }}
            />
          ) : (
            <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">
              {t('quotes.document.contract.unavailable')}
            </div>
          )
        ) : content.fileUrl ? (
          <DocContractFile fileUrl={content.fileUrl} templateName={templateName} />
        ) : (
          <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">
            {t('quotes.document.contract.unavailable')}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t('quotes.document.contract.versionFooter', { name: templateName, version: versionNumber })}
        </p>
      </div>
    );
  }
  // line_items
  const label = (block.content?.label as string | undefined)?.trim() || t('quotes.document.pricing');
  const showSubtotal = block.content?.showSubtotal === true;
  return <PricingTable lines={lines} quoteId={quoteId} currency={currency} label={label} taxRate={taxRate} showTax={showTax} showSubtotal={showSubtotal} />;
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
  const { t } = useTranslation('billing');
  const { quote, blocks, lines, branding, billTo } = detail;
  // Customer billing address lines (resolved server-side from the org's Billing
  // settings for drafts, or the frozen snapshot once sent). Empty when the org
  // has saved no billing address — the block then shows just the name.
  const billToLines = useMemo(() => {
    const a = billTo?.address;
    if (!a) return [] as string[];
    const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ');
    return [a.line1, a.line2, cityLine, a.country].filter((s): s is string => !!s && s.trim().length > 0);
  }, [billTo?.address]);
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
  // Deposit summary — mirrors the customer portal (Task 10) so the in-app Preview
  // matches the proposal link and PDF. `depositDueTotal` null = no deposit.
  const categoryBreakdown = quote.categoryBreakdown ?? [];
  const depositDue = quote.depositDueTotal ?? null;
  // Remaining balance in integer cents so the subtraction never drifts on floats.
  const remainderCents = depositDue != null
    ? Math.round(Number(dueOnAcceptance) * 100) - Math.round(Number(depositDue) * 100)
    : 0;

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
                {branding?.partnerName ?? t('quotes.document.proposal')}
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
              {quote.quoteNumber ?? t('quotes.document.draft')}
            </p>
            <p className="text-sm font-medium text-muted-foreground">{t('quotes.document.proposal')}</p>
            <StatusPill
              role={STATUS_ROLES[quote.status].role}
              label={statusLabel(quote)}
              className={STATUS_ROLES[quote.status].className}
            />
            <dl className="space-y-0.5 pt-1 text-xs text-muted-foreground sm:flex sm:flex-col sm:items-end">
              <div className="flex gap-2"><dt>{t('quotes.document.issued')}</dt><dd className="font-medium text-foreground/80">{formatDate(quote.issueDate)}</dd></div>
              {quote.expiryDate && (
                <div className="flex gap-2"><dt>{t('quotes.document.validUntil')}</dt><dd className="font-medium text-foreground/80">{formatDate(quote.expiryDate)}</dd></div>
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
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.document.preparedFor')}</p>
            <p className="mt-1 text-base font-medium text-foreground" data-testid="quote-document-customer">{customerName}</p>
            {billToLines.length > 0 && (
              <address className="mt-0.5 not-italic text-sm leading-relaxed text-muted-foreground" data-testid="quote-document-billto-address">
                {billToLines.map((l, i) => <div key={i}>{l}</div>)}
              </address>
            )}
            {billTo?.taxId?.trim() && (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="quote-document-billto-taxid">
                {t('quotes.document.taxId', { id: billTo.taxId })}
              </p>
            )}
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
            {t('quotes.document.empty')}
          </div>
        ) : (
          <div className="space-y-6">
            {sortedBlocks.map((block) => (
              <DocBlock key={block.id} block={block} lines={linesForBlock(block.id)} quoteId={quote.id} currency={currency} taxRate={quote.taxRate} showTax={showTax} />
            ))}
            {looseLines.length > 0 && <PricingTable lines={looseLines} quoteId={quote.id} currency={currency} label={t('quotes.document.additionalItems')} taxRate={quote.taxRate} showTax={showTax} />}
          </div>
        )}

        {/* ── Totals ─────────────────────────────────────────────── */}
        {!isEmpty && (
          <section className="flex justify-end">
            <div className="w-full max-w-xs space-y-2.5">
              <div className="flex justify-between text-sm">
                {/* `subtotal` sums ALL lines (one-time + first period of each
                    recurring cadence) — with recurring lines a bare "Subtotal"
                    never reconciles against the due-on-acceptance figures below,
                    so the qualifier names the basis. Mirrors both portal views. */}
                <span className="text-muted-foreground">{hasRecurring ? t('quotes.document.totals.firstPeriodSubtotal') : t('quotes.document.totals.subtotal')}</span>
                <span className="tabular-nums text-foreground">{formatMoney(quote.subtotal, currency)}</span>
              </div>
              {showTax && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('quotes.document.totals.tax')}{quote.taxRate ? ` (${pctFromFraction(quote.taxRate)}%)` : ''}
                  </span>
                  <span className="tabular-nums text-foreground">{formatMoney(quote.taxTotal, currency)}</span>
                </div>
              )}
              {categoryBreakdown.length > 1 && (
                <div className="space-y-0.5 text-sm text-muted-foreground" data-testid="quote-document-category-breakdown">
                  {categoryBreakdown.map((b) => (
                    <div key={b.category} className="flex justify-between">
                      <span className="capitalize">{b.category}</span>
                      <span className="tabular-nums">
                        {[
                          Number(b.oneTimeTotal) > 0 ? formatMoney(b.oneTimeTotal, currency) : null,
                          Number(b.monthlyTotal) > 0 ? `${formatMoney(b.monthlyTotal, currency)}/mo` : null,
                          Number(b.annualTotal) > 0 ? `${formatMoney(b.annualTotal, currency)}/yr` : null,
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
                      acceptance = deposit due now + remaining balance. Same
                      presentation contract as the portal views and the PDF. */}
                  <div
                    className="flex justify-between border-t pt-3 text-sm"
                    style={{ borderColor: 'var(--doc-accent)' }}
                    data-testid="quote-document-due"
                  >
                    <span className="font-medium text-foreground">{t('quotes.document.totals.dueOnAcceptance')}</span>
                    <span className="font-medium tabular-nums text-foreground">{formatMoney(dueOnAcceptance, currency)}</span>
                  </div>
                  <div className="flex items-baseline justify-between" data-testid="quote-document-deposit-due">
                    <span className="text-sm font-semibold text-foreground">{t('quotes.document.totals.depositDueNow')}</span>
                    <span className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--doc-accent)' }}>
                      {formatMoney(depositDue, currency)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm" data-testid="quote-document-deposit-remainder">
                    <span className="text-muted-foreground">{t('quotes.document.totals.remainingBalance')}</span>
                    <span className="tabular-nums text-foreground">{formatMoney(remainderCents / 100, currency)}</span>
                  </div>
                </>
              ) : (
                <div
                  className="flex items-baseline justify-between border-t pt-3"
                  style={{ borderColor: 'var(--doc-accent)' }}
                >
                  <span className="text-sm font-semibold text-foreground">{t('quotes.document.totals.dueOnAcceptance')}</span>
                  <span
                    className="text-2xl font-semibold tabular-nums"
                    style={{ color: 'var(--doc-accent)' }}
                    data-testid="quote-document-due"
                  >
                    {formatMoney(dueOnAcceptance, currency)}
                  </span>
                </div>
              )}

              {hasRecurring && (
                <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
                  {/* First-period total row (matches both portal views + the PDF):
                      the recurring-inclusive figure, clearly boxed apart from the
                      invoiced-now amounts above. */}
                  <div className="flex justify-between" data-testid="quote-document-first-period">
                    <span className="text-muted-foreground">{t('quotes.document.totals.firstPeriodTotal')}</span>
                    <span className="tabular-nums text-foreground">{formatMoney(quote.total, currency)}</span>
                  </div>
                  {Number(quote.monthlyRecurringTotal) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('quotes.document.totals.monthlyRecurring')}</span>
                      <span className="tabular-nums text-foreground">{formatMoney(quote.monthlyRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/mo</span></span>
                    </div>
                  )}
                  {Number(quote.annualRecurringTotal) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('quotes.document.totals.annualRecurring')}</span>
                      <span className="tabular-nums text-foreground">{formatMoney(quote.annualRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/yr</span></span>
                    </div>
                  )}
                  <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                    {t('quotes.document.totals.recurringNote')}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Terms & footer ─────────────────────────────────────── */}
        {quote.termsAndConditions?.trim() && (
          <section className="space-y-2 border-t pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.document.terms')}</h3>
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
  const { t } = useTranslation('billing');
  const { quote } = detail;
  const organizations = useOrgStore((s) => s.organizations);
  const { busy, downloadPdf } = useQuotePdfDownload(quote);

  const customerName = useMemo(() => {
    // Server-resolved name wins (billToName override, else the org's name); the
    // org store is only a backstop for payloads/fixtures without a resolved billTo.
    const resolvedBillTo = detail.billTo?.name?.trim() || quote.billToName?.trim();
    if (resolvedBillTo) return resolvedBillTo;
    const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
    // Never leak a raw org UUID fragment onto a customer-facing document — if the
    // org store hasn't resolved a name yet, show a neutral em-dash instead.
    return resolved || '—';
  }, [detail.billTo?.name, quote.billToName, quote.orgId, organizations]);

  return (
    <div className="space-y-4" data-testid="quote-preview">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('quotes.document.preview.description')}</p>
        <button
          type="button"
          onClick={() => void downloadPdf()}
          disabled={busy}
          data-testid="quote-preview-download-pdf"
          className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? t('quotes.document.preview.preparing') : t('quotes.document.preview.downloadPdf')}
        </button>
      </div>
      <div className="rounded-xl bg-muted/30 p-2 sm:p-8">
        <QuoteDocument detail={detail} customerName={customerName} />
      </div>
    </div>
  );
}
