import { useCallback, useMemo } from 'react';
import { usePermissions } from '../../../lib/permissions';
import { useOrgStore } from '../../../stores/orgStore';
import { quoteImageUrl } from '../../../lib/api/quotes';
import { useAuthedImage } from './useQuoteImage';
import QuoteActions from './QuoteActions';
import { RecurringBillingNote, MarginPanel } from '../billingUi';
import { computeQuoteProfit, type QuoteProfit } from '@breeze/shared';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  STATUS_ROLES,
  statusLabel,
  stripHtml,
  formatDate,
  formatMoney,
  formatRecurrence,
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
  const { can } = usePermissions();
  // Margin/profit is internal-but-not-restricted: any user who can read the quote
  // sees it. Gating on read (not write) keeps cost visibility consistent with the
  // editor's read-only line rows, which show the cost band to read users too.
  const canSeeMargin = can('quotes', 'read');
  const organizations = useOrgStore((s) => s.organizations);
  const { quote, blocks, lines } = detail;
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

  const hasRecurring =
    Number(quote.monthlyRecurringTotal) > 0 || Number(quote.annualRecurringTotal) > 0;
  // Show the per-line Tax column only when this quote carries tax (mirrors the
  // header Tax row); otherwise it'd be a column of dashes.
  const showTax = Number(quote.taxTotal) > 0;

  // Customer label: prefer the explicit bill-to name; otherwise resolve the real
  // organization name from the client-side org list (same source the org switcher
  // renders). Fall back to the UUID prefix only when neither is available (e.g.
  // the quote's org isn't in the currently-loaded list, such as All-orgs scope).
  // Use truthiness after trim, not `??`: the bill-to validator allows an empty
  // string, and a blank/whitespace billToName would otherwise render an empty
  // Customer cell — the same "unfinished header" symptom (#1712) via a different
  // input.
  const orgName = useMemo(() => {
    const billTo = quote.billToName?.trim();
    if (billTo) return billTo;
    const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
    if (resolved) return resolved;
    return quote.orgId.slice(0, 8);
  }, [quote.billToName, quote.orgId, organizations]);

  return (
    <div className="space-y-6" data-testid="quote-detail">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── rendered blocks + lines ───────────────────────────────────── */}
        {/* min-w-0 lets this 1fr track shrink below its tables' content width so
            the page doesn't scroll horizontally on a phone. */}
        <div className="min-w-0 space-y-4">
          {sortedBlocks.length === 0 && looseLines.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card p-8 text-center" data-testid="quote-detail-empty">
              <p className="text-sm text-muted-foreground">This quote has no content yet.</p>
              {quote.status === 'draft' && can('quotes', 'write') && (
                <button
                  type="button"
                  onClick={() => { if (typeof window !== 'undefined') window.location.hash = '#editor'; }}
                  data-testid="quote-detail-empty-edit"
                  className="mt-3 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Add content in the Editor
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
            <LineTable lines={looseLines} currency={currency} label="Additional items" testId="quote-detail-loose-lines" taxRate={quote.taxRate} showTax={showTax} />
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
                label={statusLabel(quote)}
                className={STATUS_ROLES[quote.status].className}
                testId="quote-detail-status"
              />
              {quote.expiryDate && (
                <span className="text-xs text-muted-foreground">Expires {formatDate(quote.expiryDate)}</span>
              )}
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Customer</dt><dd className="text-right" data-testid="quote-detail-customer">{orgName}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Issued</dt><dd>{formatDate(quote.issueDate)}</dd></div>
              {(!quote.issueDate || formatDate(quote.issueDate) !== formatDate(quote.createdAt)) && (
                <div className="flex justify-between"><dt className="text-muted-foreground">Created</dt><dd>{formatDate(quote.createdAt)}</dd></div>
              )}
            </dl>
            {/* Lifecycle strip — the customer-journey milestones (Sent → Viewed →
                Accepted, or Declined) that used to be visible only as a status pill.
                Only stamped stages render; a plain draft has none, so nothing shows.
                Declined is the one destructive outcome and gets the danger token. */}
            {(quote.sentAt || quote.viewedAt || quote.acceptedAt || quote.declinedAt) && (
              <dl className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t pt-3 text-xs" data-testid="quote-detail-lifecycle">
                {quote.sentAt && <LifecycleStage label="Sent" date={quote.sentAt} first />}
                {quote.viewedAt && <LifecycleStage label="Viewed" date={quote.viewedAt} first={!quote.sentAt} />}
                {quote.acceptedAt && <LifecycleStage label="Accepted" date={quote.acceptedAt} first={!quote.sentAt && !quote.viewedAt} />}
                {quote.declinedAt && <LifecycleStage label="Declined" date={quote.declinedAt} first={!quote.sentAt && !quote.viewedAt && !quote.acceptedAt} danger testId="quote-detail-lifecycle-declined" />}
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
                View invoice <span aria-hidden>→</span>
              </a>
            )}
          </div>

          {/* Recurring + totals summary — the rail's anchor (shadow + large figure). */}
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-detail-totals">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Totals</h3>
            <dl className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between"><dt className="text-muted-foreground">One-time</dt><dd>{formatMoney(quote.oneTimeTotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Monthly recurring</dt><dd>{formatMoney(quote.monthlyRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/mo</span></dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Annual recurring</dt><dd>{formatMoney(quote.annualRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/yr</span></dd></div>
              {showTax && (
                <div className="flex justify-between"><dt className="text-muted-foreground">Tax{quote.taxRate ? ` (${pctFromFraction(quote.taxRate)}%)` : ''}</dt><dd>{formatMoney(quote.taxTotal, currency)}</dd></div>
              )}
            </dl>
            <div className="mt-3 flex items-end justify-between gap-2 border-t pt-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Due on acceptance</span>
              <span className="min-w-0 break-words text-right text-2xl font-semibold tabular-nums" data-testid="quote-detail-due-on-acceptance">{formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency)}</span>
            </div>
            {hasRecurring && (
              <>
                <div className="mt-2 flex justify-between text-sm tabular-nums">
                  <span className="text-muted-foreground">First-period total (incl. recurring)</span>
                  <span className="font-medium" data-testid="quote-detail-first-period">{formatMoney(quote.total, currency)}</span>
                </div>
                <RecurringBillingNote className="mt-2" />
              </>
            )}
            {/* Internal cost / profit — same shared panel and figures as the editor
                rail, so profitability survives past draft when the Editor tab is
                hidden for non-draft quotes. */}
            {canSeeMargin && <MarginPanel profit={profit} currency={currency} />}
          </div>

          {/* Seller From block */}
          {quote.sellerSnapshot && (
            <div className="rounded-lg border bg-card p-4" data-testid="quote-detail-from">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</h3>
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
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
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
  const { url, failed } = useAuthedImage(quoteImageUrl(quoteId, imageId));
  if (failed) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center text-xs text-muted-foreground">
        Image unavailable
      </div>
    );
  }
  if (!url) return <div className="h-40 animate-pulse rounded-lg bg-muted/60" aria-hidden />;
  return <img src={url} alt={caption || 'Proposal image'} className="w-full rounded-lg border bg-card object-contain" />;
}

function BlockView({ block, lines, currency, taxRate, showTax }: { block: QuoteBlock; lines: QuoteLine[]; currency: string; taxRate: string | null; showTax: boolean }) {
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
      <LineTable lines={lines} currency={currency} label={tableLabel || 'Pricing'} testId={`quote-detail-lines-${block.id}`} taxRate={taxRate} showTax={showTax} />
    </div>
  );
}

function LineTable({ lines, currency, label, testId, taxRate, showTax }: { lines: QuoteLine[]; currency: string; label: string; testId: string; taxRate: string | null; showTax: boolean }) {
  const colSpan = showTax ? 6 : 5;
  return (
    <div className="rounded-lg border bg-card shadow-xs">
      {label && (
        <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      )}
      <div className="overflow-x-auto" role="region" aria-label={`${label || 'Pricing'} — scroll sideways for more columns`} tabIndex={0}>
      <table className="w-full min-w-[30rem] text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Description</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Unit price</th>
            <th className="px-3 py-2 font-medium">Recurrence</th>
            {showTax && <th className="px-3 py-2 text-right font-medium">Tax</th>}
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="px-3 py-6 text-center text-sm text-muted-foreground">No lines.</td>
            </tr>
          ) : (
            lines.map((l) => {
              const tax = showTax ? lineTaxAmount(l.lineTotal, l.taxable, taxRate) : null;
              return (
                <tr key={l.id} className="border-t" data-testid={`quote-detail-line-${l.id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{lineTitle(l)}</div>
                    {lineBlurb(l) && <div className="text-xs text-muted-foreground">{lineBlurb(l)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.unitPrice, currency)}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[hsl(220_12%_40%)] dark:text-muted-foreground">
                      {formatRecurrence(l.recurrence)}
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
