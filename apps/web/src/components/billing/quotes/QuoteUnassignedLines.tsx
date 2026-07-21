// The editor's orphan bucket.
//
// `quote_lines.block_id` is nullable, and a line with a NULL block_id is a
// first-class citizen on every CUSTOMER-FACING surface: the PDF renders it
// (quotePdf.ts), the portal renders it as a "Pricing" table (quoteBlocks.tsx),
// the in-app Preview renders it under "Additional items" (QuoteDocument.tsx),
// and quoteMath.ts counts it in every total — it ignores blockId entirely.
//
// The BUILDER, however, draws lines block-by-block (`sortedBlocks.map`), so an
// orphan was money on the customer's quote that the editor refused to show. A
// $42 line shipped to a real customer that way. This component is the missing
// bucket: it renders after the document's blocks (matching where the customer
// sees these lines), states plainly that they are on the quote and in the
// total, and offers the one repair that fixes it — move the line into a real
// pricing section via the existing PATCH /quotes/:id/lines/:lineId/move.
//
// Deliberately NOT styled as another document section: this is a repair
// affordance, not content the author arranged. It renders only when orphans
// exist, so a healthy quote is visually unchanged.
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import '../../../lib/i18n';
import {
  type QuoteLine,
  formatMoney,
  formatQuantity,
  lineTitle,
} from './quoteTypes';

export interface UnassignedLinesProps {
  /** Lines whose effective blockId is null, in sort order. */
  lines: QuoteLine[];
  /** Pricing panels a line can be moved into, in document order. */
  moveTargets: { id: string; label: string }[];
  currency: string;
  canWrite: boolean;
  /** Commits the move through the quote editor's shared move handler. */
  onMoveLineToBlock: (line: QuoteLine, targetBlockId: string) => void;
}

export function UnassignedLines({
  lines,
  moveTargets,
  currency,
  canWrite,
  onMoveLineToBlock,
}: UnassignedLinesProps) {
  const { t } = useTranslation('billing');
  // Zero orphans must change nothing about the editor — no empty state, no
  // spacing, no rule. The healthy quote is the overwhelming majority case.
  if (lines.length === 0) return null;

  const showPicker = canWrite && moveTargets.length > 0;

  return (
    <section
      data-testid="quote-unassigned-lines"
      aria-labelledby="quote-unassigned-title"
      className="rounded-lg border border-warning/40 bg-warning/10 p-4"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="quote-unassigned-title" className="text-sm font-semibold text-foreground">
            {t('quotes.editor.unassigned.title')}
          </h3>
          {/* The whole point of this bucket. Full-contrast body text, not muted:
              a tech who skims this as decoration ships the line unnoticed. */}
          <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-foreground" data-testid="quote-unassigned-explainer">
            {t('quotes.editor.unassigned.explainer')}
          </p>
        </div>
      </div>

      {/* A divided list, not a stack of inner cards — this panel is already a
          surface, and nesting cards inside it reads as chrome-on-chrome. */}
      <ul className="mt-3 divide-y divide-warning/25 border-t border-warning/25">
        {lines.map((line) => {
          const unit = t('quotes.editor.unassigned.qtyPrice', {
            qty: formatQuantity(line.quantity),
            price: formatMoney(line.unitPrice, currency),
          });
          const amount = formatMoney(line.lineTotal, currency);
          return (
            <li
              key={line.id}
              data-testid={`quote-unassigned-line-${line.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5"
            >
              <span className="min-w-0 flex-1 basis-48 truncate text-sm text-foreground" title={lineTitle(line)}>
                {lineTitle(line)}
              </span>
              <span className="text-sm tabular-nums text-muted-foreground">{unit}</span>
              <span className="text-sm font-medium tabular-nums text-foreground">
                {amount}
                {line.recurrence === 'monthly' && (
                  <span className="text-xs font-normal text-muted-foreground">{t('quotes.editor.units.perMonth')}</span>
                )}
                {line.recurrence === 'annual' && (
                  <span className="text-xs font-normal text-muted-foreground">{t('quotes.editor.units.perYear')}</span>
                )}
              </span>
              {showPicker && (
                // A native select: it escapes the canvas's overflow context for
                // free (no portal), keyboards and screen readers get it without
                // extra ARIA, and the target list is short. Value is never held
                // in state — the row leaves the bucket the moment the move is
                // applied optimistically upstream.
                <select
                  value=""
                  aria-label={t('quotes.editor.unassigned.moveAria', { line: lineTitle(line) })}
                  data-testid={`quote-unassigned-move-${line.id}`}
                  onChange={(e) => { if (e.target.value) onMoveLineToBlock(line, e.target.value); }}
                  className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">{t('quotes.editor.unassigned.movePlaceholder')}</option>
                  {moveTargets.map((target) => (
                    <option key={target.id} value={target.id}>{target.label}</option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ul>

      {canWrite && moveTargets.length === 0 && (
        // Nowhere to move them yet — say what to do instead of showing a dead
        // control. (A quote can legitimately have orphans and no pricing table.)
        <p className="mt-3 text-sm text-foreground" data-testid="quote-unassigned-no-targets">
          {t('quotes.editor.unassigned.noTargets')}
        </p>
      )}
    </section>
  );
}

export default UnassignedLines;
