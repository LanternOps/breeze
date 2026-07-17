// Shared block/line rendering for the portal proposal views (authed
// QuoteDetailView + public PublicQuoteView). Mirrors the block walk in the web
// dashboard's QuoteDocument.tsx (DocBlock) and the quote PDF renderer (quotePdf.ts): blocks
// are drawn in sortOrder, and a `line_items` block renders its own lines as a
// pricing table grouped by recurrence (one-time / monthly / annual). Orphan
// lines (no blockId) fall into a trailing default pricing table — same as the
// PDF, which appends un-blocked lines after the block walk.
import { Fragment } from 'react';
import type { QuoteBlock, QuoteContractBlockContent, QuoteLine } from '@/lib/api';

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
  buildUrl,
  taxRate = 0,
  showTax = false,
}: {
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  currency: string;
  // Builds the (authed or token-scoped) URL to fetch a quote image by id.
  imageUrl: (imageId: string) => string;
  // Resolves a server-returned relative route (e.g. a contract block's
  // `fileUrl`, already the full `/portal/quotes/:id/contract-file/:blockId` or
  // `/quotes/public/:token/contract-file/:blockId` path) into a fetchable URL —
  // `buildPortalApiUrl` in both callers. Unlike `imageUrl`, the route itself
  // (not just an id) comes from the API, since a contract block's fileUrl is
  // part of the serialization contract.
  buildUrl: (path: string) => string;
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
      // The API sanitizes every rich_text block's content.html on both write and
      // read serialization (richTextSanitize.ts's fixed p/br/strong/em/u/h3/h4/
      // ul/ol/li/a allowlist) before it ever reaches this component — including
      // on the unauthenticated public quote link — so rendering it here is safe.
      const html = String(content.html ?? '');
      if (!html.trim()) return null;
      return (
        <div
          key={block.id}
          className="quote-rich-text text-sm leading-relaxed text-foreground"
          data-testid={`quote-block-${block.id}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
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

    if (block.blockType === 'contract') {
      // Typed as QuoteContractBlockContent (never `authoring`) for documentation —
      // still narrowed field-by-field below rather than trusted outright, since a
      // TS type doesn't validate the JSON actually on the wire. `Record<string,
      // unknown>` doesn't structurally overlap with the (mostly-required) typed
      // shape, so route through `unknown` — the same escape hatch this
      // component already leans on for `content` itself.
      const c = content as unknown as QuoteContractBlockContent;
      const label = typeof c.label === 'string' ? c.label : '';
      const templateName = typeof c.templateName === 'string' ? c.templateName : 'Contract';
      const versionNumber = Number(c.versionNumber ?? 0);
      const sourceType = c.sourceType === 'uploaded' ? 'uploaded' : 'authored';
      const renderedHtml = typeof c.renderedHtml === 'string' ? c.renderedHtml : null;
      const fileUrl = typeof c.fileUrl === 'string' ? c.fileUrl : null;
      return (
        <div key={block.id} className="space-y-3 rounded-lg border bg-card p-4 sm:p-5" data-testid="contract-block">
          {label && <h3 className="text-base font-semibold text-foreground">{label}</h3>}
          {sourceType === 'authored' ? (
            renderedHtml ? (
              // Server-substituted HTML from an authored contract template — same
              // sanitizer output + HTML-escaped substitution path as rich_text
              // blocks (see the rich_text case above), safe to render as-is.
              <div className="quote-rich-text text-sm leading-relaxed text-foreground" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            ) : (
              <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">Contract content unavailable</div>
            )
          ) : fileUrl ? (
            <div className="space-y-2">
              <iframe src={buildUrl(fileUrl)} title={templateName} className="h-[32rem] w-full rounded-lg border" />
              <a href={buildUrl(fileUrl)} target="_blank" rel="noreferrer" data-testid="contract-block-download" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                Download contract
              </a>
            </div>
          ) : (
            <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">Contract file unavailable</div>
          )}
          <p className="text-xs text-muted-foreground">{templateName} — v{versionNumber}</p>
        </div>
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
