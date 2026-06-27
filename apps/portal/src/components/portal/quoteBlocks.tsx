// Shared block/line rendering for the portal proposal views (authed
// QuoteDetailView + public PublicQuoteView). Mirrors the block walk in the web
// dashboard's QuoteDocument.tsx (DocBlock) and the quote PDF renderer (quotePdf.ts): blocks
// are drawn in sortOrder, and a `line_items` block renders its own lines as a
// pricing table grouped by recurrence (one-time / monthly / annual). Orphan
// lines (no blockId) fall into a trailing default pricing table — same as the
// PDF, which appends un-blocked lines after the block walk.
import { Fragment } from 'react';
import type { QuoteBlock, QuoteLine } from '@/lib/api';

export function money(value: string | number, currencyCode: string): string {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return safe.toLocaleString('en-US', { style: 'currency', currency: currencyCode || 'USD' });
  } catch {
    return `${safe.toFixed(2)} ${currencyCode || ''}`.trim();
  }
}

/** Per-line tax amount for the Tax column: taxable lines get lineTotal × rate
 *  rounded to cents; non-taxable lines / a non-positive rate return null (shown
 *  as '—'). The header Tax stays the server's authoritative figure, so the summed
 *  column can differ by a rounding cent on many-line quotes. */
function lineTax(lineTotal: string | number, taxable: boolean | undefined, rate: number): number | null {
  if (!taxable || !(rate > 0)) return null;
  const cents = Math.round(Number(lineTotal) * 100);
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

// rich_text blocks store author HTML. The portal has no HTML sanitizer
// dependency, and rendering untrusted HTML on the *unauthenticated* public page
// would be an XSS sink, so we strip all tags to plain text (matching the PDF's
// stripHtml + the web detail view, which also renders rich_text as text) and
// preserve line breaks with whitespace-pre-wrap. This is the safe sanitization.
function stripHtml(html: string): string {
  // Output is rendered as a React text node (auto-escaped), so this is display
  // cleanup. Strip tags to a fixpoint so a split tag can't survive one pass, and
  // decode `&amp;` LAST so it can't re-introduce an entity a later rule re-decodes.
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

const RECURRENCE_GROUPS: ReadonlyArray<{ key: string; label: string; suffix: string }> = [
  { key: 'one_time', label: 'One-time', suffix: '' },
  { key: 'monthly', label: 'Monthly', suffix: '/mo' },
  { key: 'annual', label: 'Annual', suffix: '/yr' },
];

function PricingTable({
  lines,
  currency,
  label,
  testId,
  taxRate,
  showTax,
}: {
  lines: QuoteLine[];
  currency: string;
  label?: string;
  testId: string;
  taxRate: number;
  showTax: boolean;
}) {
  if (lines.length === 0) return null;
  // Preserve sortOrder within each recurrence group, in the canonical group order.
  const grouped = RECURRENCE_GROUPS.map((g) => ({
    ...g,
    rows: lines.filter((l) => (l.recurrence || 'one_time') === g.key),
  })).filter((g) => g.rows.length > 0);
  const groupColSpan = showTax ? 5 : 4;

  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid={testId}>
      {label && (
        <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold text-foreground sm:px-5">
          {label}
        </div>
      )}
      <div className="overflow-x-auto">
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
            {grouped.map((g) => (
              <Fragment key={g.key}>
                {grouped.length > 1 && (
                  <tr className="bg-muted/20">
                    <td colSpan={groupColSpan} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-5">
                      {g.label}
                    </td>
                  </tr>
                )}
                {g.rows.map((l) => {
                  const tax = showTax ? lineTax(l.lineTotal, l.taxable, taxRate) : null;
                  return (
                  <tr key={l.id} data-testid={`quote-line-${l.id}`} className="border-b align-top last:border-0">
                    <td className="px-4 py-3 text-foreground sm:px-5">{l.description}</td>
                    <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">{Number(l.quantity)}</td>
                    <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">
                      {money(l.unitPrice, currency)}{g.suffix && <span className="text-xs">{g.suffix}</span>}
                    </td>
                    {showTax && (
                      <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground">
                        {tax === null ? '—' : money(tax, currency)}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-foreground sm:px-5">
                      {money(l.lineTotal, currency)}{g.suffix && <span className="text-xs text-muted-foreground">{g.suffix}</span>}
                    </td>
                  </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function QuoteBlocks({
  blocks,
  lines,
  currency,
  imageUrl,
  taxRate = 0,
  showTax = false,
}: {
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  currency: string;
  // Builds the (authed or token-scoped) URL to fetch a quote image by id.
  imageUrl: (imageId: string) => string;
  /** Quote tax rate as a fraction (e.g. 0.085); used for the per-line Tax column. */
  taxRate?: number;
  /** Whether the quote carries tax — shows the per-line Tax column when true. */
  showTax?: boolean;
}) {
  const ordered = [...blocks].sort((a, b) => a.sortOrder - b.sortOrder);
  // Track lines already consumed by a line_items block so orphan lines render once.
  const consumed = new Set<string>();

  const rendered = ordered.map((block) => {
    const content = (block.content ?? {}) as Record<string, unknown>;

    if (block.blockType === 'heading') {
      const level = Number(content.level ?? 1);
      const text = String(content.text ?? '');
      const cls = level <= 1 ? 'text-2xl font-bold' : level === 2 ? 'text-xl font-semibold' : 'text-lg font-semibold';
      return (
        <h2 key={block.id} className={cls} data-testid={`quote-block-${block.id}`}>
          {text}
        </h2>
      );
    }

    if (block.blockType === 'rich_text') {
      const text = stripHtml(String(content.html ?? ''));
      if (!text) return null;
      return (
        <p
          key={block.id}
          className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"
          data-testid={`quote-block-${block.id}`}
        >
          {text}
        </p>
      );
    }

    if (block.blockType === 'image') {
      const imageId = typeof content.imageId === 'string' ? content.imageId : null;
      const caption = typeof content.caption === 'string' ? content.caption : '';
      const width = Number(content.width);
      return (
        <figure key={block.id} data-testid={`quote-block-${block.id}`}>
          {imageId ? (
            <img
              src={imageUrl(imageId)}
              alt={caption || 'Proposal image'}
              className="rounded-lg border"
              style={Number.isFinite(width) && width > 0 ? { maxWidth: `${width}px`, width: '100%' } : { maxWidth: '100%' }}
            />
          ) : (
            <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">Image unavailable</div>
          )}
          {caption && <figcaption className="mt-2 text-xs text-muted-foreground">{caption}</figcaption>}
        </figure>
      );
    }

    if (block.blockType === 'line_items') {
      const blockLines = lines.filter((l) => l.blockId === block.id);
      blockLines.forEach((l) => consumed.add(l.id));
      const label = typeof content.label === 'string' && content.label ? content.label : 'Pricing';
      return (
        <PricingTable
          key={block.id}
          lines={blockLines}
          currency={currency}
          label={label}
          testId={`quote-lines-${block.id}`}
          taxRate={taxRate}
          showTax={showTax}
        />
      );
    }

    return null;
  });

  // Any customer-visible lines not attached to a line_items block (orphans) get a
  // trailing default pricing table — mirrors quotePdf appending un-blocked lines.
  const orphanLines = lines.filter((l) => !consumed.has(l.id) && !l.blockId);

  return (
    <div className="space-y-6">
      {rendered}
      {orphanLines.length > 0 && (
        <PricingTable lines={orphanLines} currency={currency} label="Pricing" testId="quote-lines-default" taxRate={taxRate} showTax={showTax} />
      )}
    </div>
  );
}

export default QuoteBlocks;
