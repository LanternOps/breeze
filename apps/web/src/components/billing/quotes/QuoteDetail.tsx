import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { usePermissions } from '../../../lib/permissions';
import { useOrgStore } from '../../../stores/orgStore';
import { quoteImageUrl } from '../../../lib/api/quotes';
import { useReviseQuote } from './useReviseQuote';
import { navigateTo } from '@/lib/navigation';
import { useAuthedImage } from './useQuoteImage';
import QuoteActions, { QuoteSendOutcomeBanners } from './QuoteActions';
import QuoteOrderBreakdown, { orderableLines } from './QuoteOrderBreakdown';
import { RecurringBillingNote, MarginPanel, MarginToggle, useShowMargin } from '../billingUi';
import { computeQuoteProfit, type QuoteProfit } from '@breeze/shared';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  STATUS_ROLES,
  stripHtml,
  formatDate,
  formatMoney,
  formatQuantity,
  resolveQuoteOrgName,
  lineTaxAmount,
  lineTitle,
  lineBlurb,
  pctFromFraction,
  sellerLines,
} from './quoteTypes';
import { StatusPill } from '../shared/StatusPill';

interface Props {
  detail: QuoteDetailData;
  // The parent reloads the quote when an action mutates it (e.g. send flips the
  // status draft→sent and stamps sentAt).
  onChanged?: () => void;
  // When the workspace header renders the primary actions, the Detail rail
  // suppresses its own copy so Send/Download/Delete aren't doubled on the Detail
  // tab. Standalone (and in tests) Detail renders the actions itself.
  actionsInHeader?: boolean;
}

export default function QuoteDetail({ detail, onChanged, actionsInHeader }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  // Margin/profit is internal-but-not-restricted: any user who can read the quote
  // sees it. Gating on read (not write) keeps cost visibility consistent with the
  // editor's read-only line rows, which show the cost band to read users too.
  const canSeeMargin = can('quotes', 'read');
  // Same persisted preference the editor's "Show cost & margin" toggle writes
  // (shared billing-wide via useShowMargin). That toggle's contract is "no
  // margin on screen" — it must hold when a screen-sharing tech switches tabs
  // or opens an invoice, so Detail reads (and can flip) the same key. Detail
  // needs its own control anyway: for non-draft quotes the editor tab (and its
  // toggle) doesn't exist.
  const [showMargin, toggleMargin] = useShowMargin();
  const organizations = useOrgStore((s) => s.organizations);
  const { quote, blocks, lines } = detail;
  const recipients = detail.recipients ?? [];
  const currency = quote.currencyCode;

  // Same cents math as the editor rail (computeQuoteProfit), fed the read-model
  // strings, so the Detail margin can never diverge from the editor margin.
  const profit = useMemo<QuoteProfit>(
    () => computeQuoteProfit(lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
      customerVisible: l.customerVisible,
      recurrence: l.recurrence,
      unitCost: l.unitCost,
    }))),
    [lines],
  );

  const sortedBlocks = useMemo(
    () => [...blocks].sort((a, b) => a.sortOrder - b.sortOrder),
    [blocks],
  );

  const linesForBlock = useCallback(
    (blockId: string | null) =>
      lines
        .filter((l) => l.blockId === blockId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [lines],
  );

  // Lines not attached to any block (direct/unsectioned lines) render in a trailing
  // table so nothing is dropped from the view.
  const looseLines = useMemo(() => linesForBlock(null), [linesForBlock]);

  // Once the quote is won (accepted or converted — the enum has no separate
  // "completed"), the Detail tab grows a procurement view of the SKU-bearing
  // lines so the tech can order without re-deriving a PO from the pricing tables.
  const orderLines = useMemo(() => orderableLines(lines), [lines]);
  const quoteWon = quote.status === 'accepted' || quote.status === 'converted';

  const hasRecurring =
    Number(quote.monthlyRecurringTotal) > 0 || Number(quote.annualRecurringTotal) > 0;
  // Show the per-line Tax column only when this quote carries tax (mirrors the
  // header Tax row); otherwise it'd be a column of dashes.
  const showTax = Number(quote.taxTotal) > 0;

  const orgName = useMemo(
    () => resolveQuoteOrgName(quote, organizations),
    [quote.billToName, quote.orgId, organizations],
  );

  return (
    <div className="space-y-6" data-testid="quote-detail">
      {/* Persisted send-outcome banners: a fire-time-failed scheduled send
          (draft) or a committed send whose email never went out (sent). Toasts
          alone are race-dependent — these survive reload/return visits. */}
      <QuoteSendOutcomeBanners quote={quote} orgName={orgName} />
      <QuoteDeclinedBanner quote={quote} canWrite={can('quotes', 'write')} />
      <QuoteLineageBanner detail={detail} />
      {/* xl (not lg): matches the editor tab — below xl the rail stacks under the
          content so the line tables aren't starved into sideways scrolling. */}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        {/* ── rendered blocks + lines ───────────────────────────────────── */}
        {/* min-w-0 lets this 1fr track shrink below its tables' content width so
            the page doesn't scroll horizontally on a phone. */}
        <div className="min-w-0 space-y-4">
          {sortedBlocks.length === 0 && looseLines.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card p-8 text-center" data-testid="quote-detail-empty">
              <p className="text-sm text-muted-foreground">{t('quotes.detail.empty')}</p>
              {quote.status === 'draft' && can('quotes', 'write') && (
                <button
                  type="button"
                  onClick={() => { if (typeof window !== 'undefined') window.location.hash = '#editor'; }}
                  data-testid="quote-detail-empty-edit"
                  className="mt-3 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t('quotes.detail.addContentInEditor')}
                </button>
              )}
            </div>
          ) : (
            sortedBlocks.map((block) => (
              <BlockView
                key={block.id}
                block={block}
                lines={linesForBlock(block.id)}
                currency={currency}
                taxRate={quote.taxRate}
                showTax={showTax}
              />
            ))
          )}

          {looseLines.length > 0 && (
            <LineTable lines={looseLines} currency={currency} label={t('quotes.document.additionalItems')} testId="quote-detail-loose-lines" taxRate={quote.taxRate} showTax={showTax} />
          )}

          {quoteWon && orderLines.length > 0 && (
            <QuoteOrderBreakdown
              lines={orderLines}
              currency={currency}
              showCost={canSeeMargin && showMargin}
              quoteId={quote.id}
              quoteNumber={quote.quoteNumber}
              pax8Order={detail.pax8Order}
              orders={detail.orders}
              onChanged={onChanged}
            />
          )}
        </div>

        {/* ── summary + actions ─────────────────────────────────────────── */}
        {/* The Totals card keeps the shadow and the large "due" figure so it reads
            as the anchor; the surrounding meta/from/terms cards are flatter (border
            only) so the rail isn't a stack of equal-weight boxes. */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4" data-testid="quote-detail-summary">
            <div className="mb-3 flex items-center justify-between">
              <StatusPill
                role={STATUS_ROLES[quote.status].role}
              label={t(/* i18n-dynamic */ `quotes.status.${quote.status}`)}
                className={STATUS_ROLES[quote.status].className}
                testId="quote-detail-status"
              />
              {quote.expiryDate && (
                <span className="text-xs text-muted-foreground">{t('quotes.detail.expires', { date: formatDate(quote.expiryDate) })}</span>
              )}
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('quotes.detail.customer')}</dt><dd className="text-right" data-testid="quote-detail-customer">{orgName}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('quotes.detail.issued')}</dt><dd>{formatDate(quote.issueDate)}</dd></div>
              {(!quote.issueDate || formatDate(quote.issueDate) !== formatDate(quote.createdAt)) && (
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('quotes.detail.created')}</dt><dd>{formatDate(quote.createdAt)}</dd></div>
              )}
            </dl>
            {/* Lifecycle strip — the customer-journey milestones (Sent → Viewed →
                Accepted, or Declined) that used to be visible only as a status pill.
                Only stamped stages render; a plain draft has none, so nothing shows.
                Declined is the one destructive outcome and gets the danger token. */}
            {(quote.sentAt || quote.viewedAt || quote.acceptedAt || quote.declinedAt) && (
              <dl className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t pt-3 text-xs" data-testid="quote-detail-lifecycle">
                {quote.sentAt && <LifecycleStage label={t('quotes.detail.lifecycle.sent')} date={quote.sentAt} first />}
                {quote.viewedAt && <LifecycleStage label={t('quotes.detail.lifecycle.viewed')} date={quote.viewedAt} first={!quote.sentAt} />}
                {quote.acceptedAt && <LifecycleStage label={t('quotes.detail.lifecycle.accepted')} date={quote.acceptedAt} first={!quote.sentAt && !quote.viewedAt} />}
                {quote.declinedAt && <LifecycleStage label={t('quotes.detail.lifecycle.declined')} date={quote.declinedAt} first={!quote.sentAt && !quote.viewedAt && !quote.acceptedAt} danger testId="quote-detail-lifecycle-declined" />}
              </dl>
            )}
            {/* Who the quote actually went to. Recorded at send but previously
                invisible to the tech who sent it. Rendered only when we have
                addresses: an ABSENT `recipients` (older payload) and an EMPTY
                one both mean "nothing to show" rather than "sent to nobody". */}
            {quote.sentAt && recipients.length > 0 && (
              <dl className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-xs" data-testid="quote-detail-recipients">
                <dt className="text-muted-foreground">{t('quotes.detail.sentTo')}</dt>
                <dd className="break-all font-medium">{recipients.join(', ')}</dd>
              </dl>
            )}
            {/* Once accepted → converted, the resulting invoice is the next stop; a
                direct link beats hunting for it in the invoices list. */}
            {quote.convertedInvoiceId && (
              <a
                href={`/billing/invoices/${quote.convertedInvoiceId}`}
                data-testid="quote-view-invoice"
                className="mt-3 inline-flex items-center gap-1 rounded-xs text-sm font-medium text-primary hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('quotes.detail.viewInvoice')} <span aria-hidden>→</span>
              </a>
            )}
          </div>

          {quote.status === 'converted' && detail.pax8OrderId && (
            <aside
              className="rounded-lg border border-primary/25 bg-primary/5 p-4"
              data-testid="quote-staged-pax8-order"
            >
              <p className="text-sm text-foreground">
                {t('quotes.detail.pax8Order.message', { count: detail.pax8OrderLineCount ?? 0 })}
              </p>
              <a
                href={`/settings/organizations/${quote.orgId}#pax8/${detail.pax8OrderId}`}
                data-testid="quote-staged-pax8-order-link"
                className="mt-2 inline-flex items-center gap-1 rounded-xs text-sm font-medium text-primary hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('quotes.detail.pax8Order.open')} <span aria-hidden>→</span>
              </a>
            </aside>
          )}

          {/* Recurring + totals summary — the rail's anchor (shadow + large figure). */}
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-detail-totals">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.detail.totals.title')}</h3>
              {canSeeMargin && (
                <MarginToggle show={showMargin} onToggle={toggleMargin} testId="quote-detail-toggle-margin" />
              )}
            </div>
            <dl className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('quotes.detail.totals.oneTime')}</dt><dd>{formatMoney(quote.oneTimeTotal, currency)}</dd></div>
              {/* Zero-value cadences stay silent — parity with the editor rail
                  and the customer document, which both suppress $0.00 rows. */}
              {Number(quote.monthlyRecurringTotal) > 0 && (
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('quotes.detail.totals.monthlyRecurring')}</dt><dd>{formatMoney(quote.monthlyRecurringTotal, currency)}<span className="text-xs text-muted-foreground">{t('billingUi.units.perMonth')}</span></dd></div>
              )}
              {Number(quote.annualRecurringTotal) > 0 && (
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('quotes.detail.totals.annualRecurring')}</dt><dd>{formatMoney(quote.annualRecurringTotal, currency)}<span className="text-xs text-muted-foreground">{t('billingUi.units.perYear')}</span></dd></div>
              )}
              {showTax && (
                <div className="flex justify-between"><dt className="text-muted-foreground">{t('quotes.detail.totals.tax')}{quote.taxRate ? ` (${pctFromFraction(quote.taxRate)}%)` : ''}</dt><dd>{formatMoney(quote.taxTotal, currency)}</dd></div>
              )}
            </dl>
            <div className="mt-3 border-t pt-3">
              <div className="flex items-end justify-between gap-2">
                <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('quotes.detail.totals.dueOnAcceptance')}</span>
                <span className="min-w-0 break-words text-right text-2xl font-semibold tabular-nums" data-testid="quote-detail-due-on-acceptance">{formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency)}</span>
              </div>
              {/* Deposit as a child of Due on acceptance — the same shape the editor
                  rail uses, and the row the Totals card previously dropped even
                  though the editor and the customer document both showed it. */}
              {quote.depositDueTotal != null && Number(quote.depositDueTotal) > 0 && (
                <div className="mt-1 flex items-baseline justify-between gap-2 pl-3 text-sm" data-testid="quote-detail-deposit-due">
                  <span className="text-muted-foreground">{t('quotes.editor.deposit.dueUpFront')}</span>
                  <span className="font-medium tabular-nums">{formatMoney(quote.depositDueTotal, currency)}</span>
                </div>
              )}
            </div>
            {hasRecurring && (
              <>
                <div className="mt-2 flex justify-between text-sm tabular-nums">
                  <span className="text-muted-foreground">{t('quotes.detail.totals.firstPeriod')}</span>
                  <span className="font-medium" data-testid="quote-detail-first-period">{formatMoney(quote.total, currency)}</span>
                </div>
                <RecurringBillingNote className="mt-2" />
              </>
            )}
            {/* Internal cost / profit — same shared panel and figures as the editor
                rail, so profitability survives past draft when the Editor tab is
                hidden for non-draft quotes. Gated on the SAME persisted toggle as
                the editor so "hide cost & margin" holds across tabs. */}
            {canSeeMargin && showMargin && <MarginPanel profit={profit} currency={currency} />}
          </div>

          {/* Seller From block */}
          {quote.sellerSnapshot && (
            <div className="rounded-lg border bg-card p-4" data-testid="quote-detail-from">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.detail.from')}</h3>
              <div className="space-y-0.5 text-sm">
                {quote.sellerSnapshot.name && (
                  <p className="font-medium" data-testid="quote-detail-from-name">{quote.sellerSnapshot.name}</p>
                )}
                {sellerLines(quote.sellerSnapshot.address).map((line, i) => (
                  <p key={i} className="text-muted-foreground">{line}</p>
                ))}
                {quote.sellerSnapshot.phone && (
                  <p className="text-muted-foreground" data-testid="quote-detail-from-phone">{quote.sellerSnapshot.phone}</p>
                )}
                {quote.sellerSnapshot.email && (
                  <p className="text-muted-foreground" data-testid="quote-detail-from-email">{quote.sellerSnapshot.email}</p>
                )}
                {quote.sellerSnapshot.website && (
                  <p className="text-muted-foreground" data-testid="quote-detail-from-website">{quote.sellerSnapshot.website}</p>
                )}
              </div>
            </div>
          )}

          {/* Terms & Conditions */}
          {quote.termsAndConditions && (
            <div className="rounded-lg border bg-card p-4" data-testid="quote-detail-terms">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.detail.terms')}</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{quote.termsAndConditions}</p>
            </div>
          )}

          {/* Actions — suppressed here when the workspace header owns them, so the
              primary Send action isn't doubled on the Detail tab. */}
          {!actionsInHeader && <QuoteActions detail={detail} onChanged={onChanged} variant="rail" />}
        </div>
      </div>
    </div>
  );
}

// One `Label date` pair in the lifecycle strip, with a `·` separator before every
// stage except the first-rendered one. Declined is the sole destructive outcome
// and paints its label + date in the danger token.
function LifecycleStage({ label, date, first, danger, testId }: { label: string; date: string; first?: boolean; danger?: boolean; testId?: string }) {
  const tone = danger ? 'text-destructive' : '';
  return (
    <div className={`flex items-center gap-1 ${tone}`} data-testid={testId}>
      {!first && <span aria-hidden className="text-muted-foreground">·</span>}
      <dt className={danger ? undefined : 'text-muted-foreground'}>{label}</dt>
      <dd className={danger ? undefined : 'text-foreground'}>{formatDate(date)}</dd>
    </div>
  );
}

// Authed image for the internal detail view — same loader and treatment as the
// customer document, so the Detail tab shows the real image (not a placeholder).
function DetailImage({ quoteId, imageId, caption }: { quoteId: string; imageId: string; caption?: string }) {
  const { t } = useTranslation('billing');
  const { url, failed } = useAuthedImage(quoteImageUrl(quoteId, imageId));
  if (failed) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center text-xs text-muted-foreground">
        {t('quotes.detail.imageUnavailable')}
      </div>
    );
  }
  if (!url) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" aria-hidden />;
  return <img src={url} alt={caption || t('quotes.detail.proposalImageAlt')} className="w-full rounded-lg border bg-card object-contain" />;
}

function BlockView({ block, lines, currency, taxRate, showTax }: { block: QuoteBlock; lines: QuoteLine[]; currency: string; taxRate: string | null; showTax: boolean }) {
  const { t } = useTranslation('billing');
  const heading = (block.content?.text as string | undefined) ?? '';
  const html = (block.content?.html as string | undefined) ?? '';
  const tableLabel = (block.content?.label as string | undefined) ?? '';
  const imageId = (block.content?.imageId as string | undefined) ?? '';
  const caption = (block.content?.caption as string | undefined) ?? '';

  if (block.blockType === 'heading') {
    return <h2 className="text-lg font-semibold" data-testid={`quote-detail-block-${block.id}`}>{heading}</h2>;
  }
  if (block.blockType === 'rich_text') {
    // Flatten author HTML the same way the customer document does, so the Detail
    // tab never shows literal `<p>` tags where the proposal shows clean text.
    const text = stripHtml(html);
    if (!text) return null;
    return (
      <p className="whitespace-pre-wrap text-sm text-foreground" data-testid={`quote-detail-block-${block.id}`}>{text}</p>
    );
  }
  if (block.blockType === 'image') {
    if (!imageId) return null;
    return (
      <figure className="space-y-1" data-testid={`quote-detail-block-${block.id}`}>
        <DetailImage quoteId={block.quoteId} imageId={imageId} caption={caption} />
        {caption && <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>}
      </figure>
    );
  }
  // line_items
  return (
    <div data-testid={`quote-detail-block-${block.id}`}>
      <LineTable lines={lines} currency={currency} label={tableLabel || t('quotes.detail.pricing')} testId={`quote-detail-lines-${block.id}`} taxRate={taxRate} showTax={showTax} />
    </div>
  );
}

function LineTable({ lines, currency, label, testId, taxRate, showTax }: { lines: QuoteLine[]; currency: string; label: string; testId: string; taxRate: string | null; showTax: boolean }) {
  const { t } = useTranslation('billing');
  const colSpan = showTax ? 6 : 5;
  return (
    <div className="rounded-lg border bg-card shadow-xs">
      {label && (
        <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      )}
      <div className="overflow-x-auto" role="region" aria-label={t('quotes.detail.tableScrollAria', { label: label || t('quotes.detail.pricing') })} tabIndex={0}>
      <table className="w-full min-w-[30rem] text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t('quotes.detail.table.item')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.table.qty')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.table.unitPrice')}</th>
            <th className="px-3 py-2 font-medium">{t('quotes.detail.table.recurrence')}</th>
            {showTax && <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.table.tax')}</th>}
            <th className="px-3 py-2 text-right font-medium">{t('quotes.detail.table.total')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="px-3 py-6 text-center text-sm text-muted-foreground">{t('quotes.detail.table.noLines')}</td>
            </tr>
          ) : (
            lines.map((l) => {
              const tax = showTax ? lineTaxAmount(l.lineTotal, l.taxable, taxRate) : null;
              return (
                <tr key={l.id} className="border-t" data-testid={`quote-detail-line-${l.id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{lineTitle(l)}</div>
                    {lineBlurb(l) && <div className="whitespace-pre-line text-xs text-muted-foreground">{lineBlurb(l)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.quantity)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.unitPrice, currency)}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70 dark:text-muted-foreground">
                      {t(/* i18n-dynamic */ `quotes.recurrence.${l.recurrence}`)}
                    </span>
                  </td>
                  {showTax && (
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{tax === null ? '—' : formatMoney(tax, currency)}</td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.lineTotal, currency)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Declined-outcome banner (decline-completion spec §B/§D): the one destructive
 *  outcome, surfaced at the top with the customer's verbatim note — previously
 *  `decline_reason` was stored but rendered nowhere — and the recovery path
 *  (declined is a settled state; revision is a NEW document via clone, so the
 *  audit trail of the declined quote stays intact). */
function QuoteDeclinedBanner({ quote, canWrite }: { quote: QuoteDetailData['quote']; canWrite: boolean }) {
  const { t } = useTranslation('billing');
  // This button used to CLONE, which produced an unlinked quote and left the
  // declined original live — the same word meaning something different from the
  // Revise action in the toolbar. It now creates the linked revision, which is
  // what "revise a declined quote" actually means: sending it retires the
  // original. (A declined quote is in the server's supersedable set.)
  const { revise, revising: cloning } = useReviseQuote(quote.id);
  if (quote.status !== 'declined') return null;
  const reason = quote.declineReason?.trim();


  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4" data-testid="quote-declined-banner">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">
            {t('quotes.detail.declinedBanner.title', { date: quote.declinedAt ? new Date(quote.declinedAt).toLocaleDateString() : '' })}
          </p>
          {reason && (
            <p className="mt-1 text-sm text-foreground/90" data-testid="quote-declined-reason">
              {t('quotes.detail.declinedBanner.reasonLabel')}{' '}
              <span className="whitespace-pre-wrap">“{reason}”</span>
            </p>
          )}
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => void revise()}
            disabled={cloning}
            data-testid="quote-declined-revise"
            className="inline-flex shrink-0 items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {cloning ? t('quotes.detail.declinedBanner.revising') : t('quotes.detail.declinedBanner.revise')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Lineage banner: where this quote sits in a revision chain.
 *
 * Three distinct situations, each with a different urgency, so they get
 * different treatment rather than one generic "related quote" line:
 *  - This quote HAS BEEN replaced (status superseded) — terminal. The customer's
 *    link is dead; the replacement is where the conversation now lives.
 *  - This quote IS a revision of an earlier one — orienting context.
 *  - A revision of this quote is being DRAFTED — a warning, because sending that
 *    draft will retire THIS quote and revoke the link the customer is holding.
 *
 * Links are plain in-app hrefs by id; the server already scoped `revisionOf` and
 * `successor` to what this viewer may see (site scope), so an id present here is
 * one they are allowed to open.
 */
function QuoteLineageBanner({ detail }: { detail: QuoteDetailData }) {
  const { t } = useTranslation('billing');
  const { quote, revisionOf, successor } = detail;
  const supersededBy = quote.status === 'superseded' ? successor : null;
  const pendingRevision = successor && successor.status === 'draft' && quote.status !== 'superseded'
    ? successor
    : null;
  if (!supersededBy && !revisionOf && !pendingRevision) return null;

  return (
    <div className="space-y-2" data-testid="quote-lineage-banner">
      {supersededBy && (
        <div className="rounded-md border border-muted-foreground/30 bg-muted/40 p-4 text-sm" data-testid="quote-lineage-superseded">
          <span className="font-medium">{t('quotes.detail.lineage.supersededTitle')}</span>{' '}
          <a className="underline" href={`/billing/quotes/${supersededBy.id}`} data-testid="quote-lineage-successor-link">
            {supersededBy.quoteNumber ?? t('quotes.detail.lineage.untitled')}
          </a>
        </div>
      )}
      {pendingRevision && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm" data-testid="quote-lineage-in-progress">
          <span className="font-medium">{t('quotes.detail.lineage.inProgressTitle')}</span>{' '}
          <a className="underline" href={`/billing/quotes/${pendingRevision.id}`} data-testid="quote-lineage-draft-link">
            {pendingRevision.quoteNumber ?? t('quotes.detail.lineage.untitled')}
          </a>
        </div>
      )}
      {revisionOf && (
        <div className="rounded-md border bg-card p-4 text-sm" data-testid="quote-lineage-parent">
          <span className="font-medium">{t('quotes.detail.lineage.revisionOfTitle')}</span>{' '}
          <a className="underline" href={`/billing/quotes/${revisionOf.id}`} data-testid="quote-lineage-parent-link">
            {revisionOf.quoteNumber ?? t('quotes.detail.lineage.untitled')}
          </a>
        </div>
      )}
    </div>
  );
}
