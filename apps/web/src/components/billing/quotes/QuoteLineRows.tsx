// The pricing-table rows: GhostRow (fast manual entry), EditableLineRow,
// ReadonlyLineRow, and the per-line thumbnails. Split from QuoteEditor.tsx —
// see quoteEditorShared.tsx for the shared save-language plumbing.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronRight, GripVertical, Loader2, MoreHorizontal, Sparkles } from 'lucide-react';
import '../../../lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, handleActionError } from '../../../lib/runAction';
import { formatPercent } from '@/lib/i18n/format';
import { uploadQuoteImage, addQuoteImageFromUrl, quoteImageUrl } from '../../../lib/api/quotes';
import { catalogItemImagePath } from '../../../lib/api/catalog';
import { computeLineTotal, markupPct, priceFromMarkup, toCents, fromCents, type QuoteLineForMath } from '@breeze/shared';
import PolishButton from '../../catalog/PolishButton';
import { useMenuKeyboard } from '../shared/menuKeyboard';
import { useAuthedImage } from './useQuoteImage';
import {
  type QuoteLine,
  type QuoteLineRecurrence,
  formatMoney,
  formatQuantity,
  lineTaxAmount,
  lineTitle,
  lineBlurb,
} from './quoteTypes';
import { UNAUTHORIZED, type LineUpdate, SrSaved, fieldRing, pendingKey, seamless, unsavedHintId, UnsavedFieldHint } from './quoteEditorShared';

/** A line's reveal-on-demand target for the rail's actionable "missing cost"
 *  notice (MarginPanel → QuoteEditor → here): `nonce` bumps on every click so
 *  the SAME first-offending line can be re-revealed after the user scrolls
 *  away, since a repeated `lineId` alone wouldn't re-trigger the effect. */
export interface LineRevealRequest {
  lineId: string;
  nonce: number;
}

/** Joins conditional aria-describedby ids (error + unsaved can co-occur). */
function describedByIds(...ids: (string | null | undefined | false)[]): string | undefined {
  const list = ids.filter((x): x is string => Boolean(x));
  return list.length ? list.join(' ') : undefined;
}

// ── Money-input helpers (unit price / internal cost / ghost price) ────────
// These fields show a currency-formatted value ("$1,234.56") while blurred and
// the raw editable decimal while focused — the adjacent read-only cells (Total,
// Cost/Markup/Profit summary) already render via formatMoney, so a plain
// "1234.56" in the editable twin read as a formatting bug. Values keep
// committing off the RAW decimal string (unchanged commit* functions below);
// only the rendered `value` and the onChange filter live here.

// Keystroke filter: keep digits and at most one decimal point. These fields are
// all min=0 (price/cost never go negative), so stripping everything else means
// a garbage/non-numeric commit is structurally impossible from typing — no "."-
// only edge case aside, which the existing commit-time Number.isFinite guard
// already rejects without losing the user's entry.
function filterMoneyChars(raw: string): string {
  let out = '';
  let seenDot = false;
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '.' && !seenDot) { out += ch; seenDot = true; }
  }
  return out;
}

// ch-based width so a 7-digit price or a "155.1" markup is never clipped by the
// old fixed w-20/w-24/w-16 — grows with the displayed value, clamped so a
// single keystroke can't make the row jump wildly and floored so short values
// keep the prior visual width (row rhythm unchanged).
function growWidth(value: string, minCh: number, maxCh: number): string {
  const ch = Math.min(maxCh, Math.max(minCh, value.length + 2));
  return `${ch}ch`;
}

// ── Internal-band progressive disclosure (shared by both row variants) ────
// The cost/markup band defaults to a compact one-line summary per line
// ("Cost $45.00 · Markup 20% · Profit $108.00"); the full micro-form only
// appears after a per-line expand. Ten controls per line across a long quote
// was a wall of forms — the summary keeps the glanceable numbers without it.

// Compact summary shown while a line's band is collapsed. Values arrive as
// pre-formatted strings so the editable variant can reflect live (uncommitted)
// field state and the readonly variant the persisted line.
function InternalBandSummary({ lineId, sku, costStr, costMissing, markupStr, profitStr }: {
  lineId: string; sku: string; costStr: string;
  /** True when the line has no cost — flags the "Cost —" figure warning-colored
   *  (with an icon + aria-label) so the gap is visible even collapsed, not just
   *  once the band is expanded. */
  costMissing: boolean;
  markupStr: string; profitStr: string;
}) {
  const { t } = useTranslation('billing');
  const dot = <span aria-hidden="true">·</span>;
  return (
    <span
      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-left font-normal normal-case tracking-normal"
      data-testid={`quote-line-internal-summary-${lineId}`}
    >
      {sku && (
        <>
          <span className="max-w-40 truncate">{t('quotes.editor.line.sku')} {sku}</span>
          {dot}
        </>
      )}
      {costMissing ? (
        <span
          className="inline-flex items-center gap-1 tabular-nums text-warning-foreground dark:text-warning"
          aria-label={t('quotes.editor.line.costMissingAria')}
          data-testid={`quote-line-cost-missing-${lineId}`}
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {t('quotes.editor.line.cost')} {costStr}
        </span>
      ) : (
        <span className="tabular-nums">{t('quotes.editor.line.cost')} {costStr}</span>
      )}
      {dot}
      <span className="tabular-nums">{t('quotes.editor.line.markup')} {markupStr}</span>
      {dot}
      <span>{t('quotes.editor.line.profit')}{' '}
        <span className="font-medium tabular-nums text-foreground">{profitStr}</span>
      </span>
    </span>
  );
}

// Animated expand/collapse shell for the band's full detail. A <tr> can't
// height-animate, so the inner grid does (rows 0fr→1fr), 200ms ease-out with
// an instant motion-reduce variant. Collapsed content stays MOUNTED — local
// field state, draft wiring and testids survive — but is inert + aria-hidden
// so it leaves the tab order and the a11y tree.
function InternalBandCollapse({ expanded, testId, children }: { expanded: boolean; testId: string; children: ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      inert={!expanded || undefined}
      aria-hidden={!expanded}
      data-testid={testId}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

// The band's disclosure trigger: chevron + "Internal" tag + (when collapsed)
// the summary. The whole strip is the button — a bigger target than a lone
// chevron — with the focus-visible ring pattern used across the editor.
function InternalBandToggle({ lineId, isFirst, expanded, onToggle, summary }: {
  lineId: string; isFirst: boolean; expanded: boolean; onToggle: () => void; summary: ReactNode;
}) {
  const { t } = useTranslation('billing');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={t('quotes.editor.internal.full')}
      data-testid={`quote-line-internal-toggle-${lineId}`}
      className="flex w-full items-center gap-2 rounded text-left focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRight
        className={`h-3 w-3 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
        aria-hidden="true"
      />
      {/* Full disclaimer on the first row, the subtle "Internal" tag on the
          rest (the title tooltip carries the full wording everywhere). */}
      <span className="shrink-0 font-medium uppercase tracking-wide">
        {isFirst ? t('quotes.editor.internal.full') : t('quotes.editor.internal.short')}
      </span>
      {!expanded && summary}
    </button>
  );
}

// Read-only long-description clamp: > ~4 lines collapses behind a Show more /
// Show less affordance. Pure presentation — the full text always renders into
// the DOM. jsdom reports zero heights, so unit tests exercise the unclamped path.
function ClampedBlurb({ lineId, text }: { lineId: string; text: string }) {
  const { t } = useTranslation('billing');
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Measure overflow only while clamped (expanded content never overflows);
  // once `long` latches the toggle persists so the user can re-collapse.
  useEffect(() => {
    if (showAll) return;
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, showAll]);
  return (
    <>
      <div ref={ref} className={`whitespace-pre-line text-xs text-muted-foreground ${showAll ? '' : 'line-clamp-4'}`}>{text}</div>
      {long && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          data-testid={`quote-line-blurb-toggle-${lineId}`}
          className="mt-0.5 inline-flex items-center rounded text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? t('quotes.editor.line.showLess') : t('quotes.editor.line.showMore')}
        </button>
      )}
    </>
  );
}

// The ghost row: an always-ready entry row at the foot of every pricing table.
// Type a name, Tab through qty/price/cadence, press Enter — the line commits
// and focus returns to the name for the next one. This is the fast lane for the
// daily compose loop; the full picker (catalog / AI lookup / distributor / SKU
// and cost fields) stays available behind the explicit "Add from catalog" /
// "AI lookup" / "More details" entry points (QuoteBlockCard).
export function GhostRow({ blockId, busy, currency, onAdd, colSpan }: {
  blockId: string;
  busy: boolean;
  currency: string;
  onAdd: (form: { name: string; description: string; quantity: string; unitPrice: string; cost: string; sku: string; partNumber: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean }) => Promise<boolean>;
  colSpan: number;
}) {
  const { t } = useTranslation('billing');
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [priceFocused, setPriceFocused] = useState(false);
  const [rec, setRec] = useState<QuoteLineRecurrence>('one_time');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const commit = async () => {
    if (!name.trim()) return; // nothing typed — Enter is a no-op, not an error
    const qtyNum = Number(qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || !Number.isInteger(qtyNum)) {
      setError(t('quotes.editor.errors.quantityWholeGreaterThanZero'));
      return;
    }
    const priceNum = price.trim() === '' ? 0 : Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      setError(t('quotes.editor.errors.unitPriceZeroOrMore'));
      return;
    }
    setError(null);
    const ok = await onAdd({
      name, description: '', quantity: qty, unitPrice: price.trim() === '' ? '0' : price,
      cost: '', sku: '', partNumber: '', taxable: false, recurrence: rec, saveToCatalog: false,
    });
    if (ok) {
      setName(''); setQty('1'); setPrice(''); setRec('one_time');
      // Refocus after React re-enables the input: the field is disabled during
      // the save (which also DROPS focus — disabling the focused element moves
      // focus to <body>), and the busy=false re-render lands async. Retry over
      // a few frames until the node is focusable again.
      const refocus = (tries: number) => {
        const el = nameRef.current;
        if (el && !el.disabled) { el.focus(); return; }
        if (tries > 0) requestAnimationFrame(() => refocus(tries - 1));
      };
      requestAnimationFrame(() => refocus(10));
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
  };
  const ghostField = 'h-9 rounded-md border border-transparent bg-transparent transition-colors hover:border-border focus:border-border focus:outline-hidden disabled:opacity-60';

  // An untouched ghost row is a single quiet affordance: only the name field
  // shows until the user types a name or focuses into the row — then the
  // qty/price/cadence chrome appears. Focus is tracked on the row (bubbling
  // focus/blur) so tabbing between the row's own fields never hides them.
  const [focusWithin, setFocusWithin] = useState(false);
  const active = name.trim() !== '' || focusWithin;
  // Width is sized off whichever string is actually on screen — the formatted
  // display ("$1,234.56") is longer than the raw decimal, so basing width on
  // the raw value alone would clip the currency symbol/separators once unfocused.
  const ghostPriceDisplay = priceFocused || price.trim() === '' ? price : formatMoney(price, currency);

  return (
    <>
      <tr
        className="border-t"
        data-testid={`quote-ghost-row-${blockId}`}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false); }}
      >
        <td className="px-1.5 py-1.5">
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={onKeyDown}
            disabled={busy}
            placeholder={t('quotes.editor.ghost.placeholder')}
            aria-label={t('quotes.editor.ghost.nameAria')}
            data-testid={`quote-ghost-name-${blockId}`}
            className={`${ghostField} w-full px-2 text-sm placeholder:text-muted-foreground/70`}
          />
        </td>
        <td className="px-1.5 py-1.5 text-right">
          <input
            type="number" min="1" step="1"
            value={qty}
            onChange={(e) => { setQty(e.target.value); setError(null); }}
            onKeyDown={onKeyDown}
            disabled={busy}
            aria-label={t('quotes.editor.line.quantityAria')}
            data-testid={`quote-ghost-qty-${blockId}`}
            className={`${ghostField} w-14 px-2 text-right text-sm tabular-nums ${active ? '' : 'hidden'}`}
          />
        </td>
        <td className="px-1.5 py-1.5 text-right">
          <input
            type="text" inputMode="decimal"
            value={ghostPriceDisplay}
            onFocus={() => setPriceFocused(true)}
            onChange={(e) => { setPrice(filterMoneyChars(e.target.value)); setError(null); }}
            onBlur={() => setPriceFocused(false)}
            onKeyDown={onKeyDown}
            disabled={busy}
            placeholder="0.00"
            aria-label={t('quotes.editor.table.unitPrice')}
            data-testid={`quote-ghost-price-${blockId}`}
            style={{ width: growWidth(ghostPriceDisplay, 8, 16) }}
            className={`${ghostField} px-2 text-right text-sm tabular-nums ${active ? '' : 'hidden'}`}
          />
          <select
            value={rec}
            onChange={(e) => setRec(e.target.value as QuoteLineRecurrence)}
            onKeyDown={onKeyDown}
            disabled={busy}
            aria-label={t('quotes.editor.line.billingFrequencyAria')}
            data-testid={`quote-ghost-recurrence-${blockId}`}
            className={`ml-auto mt-1 h-7 w-24 rounded-md border border-transparent bg-transparent py-0 pl-2 pr-6 text-xs text-muted-foreground transition-colors hover:border-border focus:border-border focus:outline-hidden disabled:opacity-60 ${active ? 'block' : 'hidden'}`}
          >
            <option value="one_time">{t('quotes.editor.recurrence.one_time')}</option>
            <option value="monthly">{t('quotes.editor.recurrence.monthly')}</option>
            <option value="annual">{t('quotes.editor.recurrence.annual')}</option>
          </select>
        </td>
        <td className="px-1.5 py-1.5 text-right align-middle">
          {name.trim() && (
            <button
              type="button"
              onClick={() => void commit()}
              disabled={busy}
              data-testid={`quote-ghost-add-${blockId}`}
              className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              {t('quotes.editor.ghost.add')}
            </button>
          )}
        </td>
        <td className="px-1.5 py-1.5" />
      </tr>
      {error && (
        <tr className="border-0">
          <td colSpan={colSpan} className="px-1.5 pb-1.5">
            <p className="text-xs text-destructive" data-testid={`quote-ghost-error-${blockId}`}>{error}</p>
          </td>
        </tr>
      )}
    </>
  );
}

// ── A single read-only pricing-table line (no write permission) ───────────
// Mirrors EditableLineRow's two-row shape — the customer-facing cells plus the
// internal cost/markup/net band — but renders everything as plain text.
export function ReadonlyLineRow({ line: l, quoteId, currency, taxRate, isFirst, showInternal, mixedCadence, revealRequest }: { line: QuoteLine; quoteId: string; currency: string; taxRate: string | null; isFirst: boolean; showInternal: boolean; mixedCadence: boolean; revealRequest?: LineRevealRequest | null }) {
  const { t } = useTranslation('billing');
  const na = t('quotes.editor.symbols.notAvailable');
  const mk = markupPct(l.unitPrice, l.unitCost);
  const markupStr = mk === null ? na : formatPercent(mk / 100, { maximumFractionDigits: 2 });
  const netCents = l.unitCost === null
    ? null
    : toCents(computeLineTotal(l.quantity, l.unitPrice)) - toCents(computeLineTotal(l.quantity, l.unitCost));
  const tax = lineTaxAmount(l.lineTotal, l.taxable, taxRate);
  // Billing cadence rides in the money cells ('/mo', '/yr'); one-time is
  // unmarked. When every line on the quote shares one cadence the suffix is
  // pure repetition, so it only renders when cadences are actually mixed.
  const suffix = !mixedCadence ? '' : l.recurrence === 'monthly' ? t('quotes.editor.units.perMonth') : l.recurrence === 'annual' ? t('quotes.editor.units.perYear') : '';
  const blurb = lineBlurb(l);
  // Collapsed summary by default; expanding shows the full SKU/PN/cost detail.
  const [internalOpen, setInternalOpen] = useState(false);
  // Reveal-on-demand: the rail's "missing cost" notice can request this exact
  // line be scrolled into view + expanded (see EditableLineRow for the fuller
  // writer-side version, which also focuses the cost input). Read-only rows
  // have no cost input to focus, so this is scroll + expand only.
  const rowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!revealRequest || revealRequest.lineId !== l.id) return;
    setInternalOpen(true);
    const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rowRef.current?.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }, [revealRequest?.nonce, revealRequest?.lineId, l.id]);
  return (
    <>
      <tr ref={rowRef} className="border-t [&>td]:pt-4" data-testid={`quote-line-${l.id}`}>
        <td className="px-1.5 py-2">
          <div className="flex items-start gap-2">
            {l.imageId
              ? <LineImageThumb quoteId={quoteId} imageId={l.imageId} />
              : l.catalogItemId && <CatalogLineThumb catalogItemId={l.catalogItemId} />}
            <div>
              <div className="font-medium">{lineTitle(l)}</div>
              {blurb && <ClampedBlurb lineId={l.id} text={blurb} />}
            </div>
          </div>
        </td>
        <td className="px-1.5 py-2 text-right tabular-nums">{formatQuantity(l.quantity)}</td>
        <td className="whitespace-nowrap px-1.5 py-2 text-right tabular-nums">
          {formatMoney(l.unitPrice, currency)}{suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
        </td>
        <td className="whitespace-nowrap px-1.5 py-2 text-right tabular-nums">
          {formatMoney(l.lineTotal, currency)}{suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
          <div className="text-xs font-normal text-muted-foreground" data-testid={`quote-line-tax-${l.id}`}>
            {tax !== null
              ? t('quotes.editor.table.taxSuffix', { amount: formatMoney(tax, currency) })
              : l.taxable ? t('quotes.editor.table.taxable') : null}
          </div>
        </td>
      </tr>
      <tr className={`border-0 ${showInternal ? '' : 'hidden'}`} data-testid={`quote-line-internal-${l.id}`}>
        <td colSpan={4} className="px-2 pb-2">
          <div className="rounded-md bg-muted/40 px-2 py-1 text-xs text-foreground/70 dark:text-muted-foreground">
            <InternalBandToggle
              lineId={l.id}
              isFirst={isFirst}
              expanded={internalOpen}
              onToggle={() => setInternalOpen((v) => !v)}
              summary={
                <InternalBandSummary
                  lineId={l.id}
                  sku={l.sku ?? ''}
                  costStr={l.unitCost === null ? na : formatMoney(l.unitCost, currency)}
                  costMissing={l.unitCost === null}
                  markupStr={markupStr}
                  profitStr={netCents === null ? na : formatMoney(fromCents(netCents), currency)}
                />
              }
            />
            <InternalBandCollapse expanded={internalOpen} testId={`quote-line-internal-detail-${l.id}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-0.5 pt-1.5">
                <span data-testid={`quote-line-sku-${l.id}`}>{t('quotes.editor.line.sku')} {l.sku || na}</span>
                <span data-testid={`quote-line-partnumber-${l.id}`}>{t('quotes.editor.line.partNumberAbbr')} {l.partNumber || na}</span>
                <span data-testid={`quote-line-cost-${l.id}`}>{t('quotes.editor.line.cost')} {l.unitCost === null ? na : formatMoney(l.unitCost, currency)}</span>
                <span data-testid={`quote-line-markup-${l.id}`}>{t('quotes.editor.line.markup')} {markupStr}</span>
                <span className="ml-auto">{t('quotes.editor.line.profit')}{' '}
                  <span className="font-medium tabular-nums text-foreground" data-testid={`quote-line-net-${l.id}`}>
                    {netCents === null ? na : formatMoney(fromCents(netCents), currency)}
                  </span>
                </span>
              </div>
            </InternalBandCollapse>
          </div>
        </td>
      </tr>
    </>
  );
}

// ── A single editable pricing-table line (writers only) ───────────────────
// Each field is locally controlled and committed on blur (text/number) or on
// change (taxable checkbox, recurrence select) — but only when the value
// actually differs from the persisted line, so a focus-without-edit doesn't
// fire a redundant PATCH. The parent's onEdit routes through updateLine +
// runAction and then refresh()es, which re-pulls the line; we resync local
// state to the incoming prop so server-side normalization (e.g. recomputed
// totals, clamped quantity) wins.
export function EditableLineRow({
  line, quoteId, currency, taxRate, isPending, isFirst, isLast, showInternal, mixedCadence, depositSelectMode, onEdit, onMove, onRemove, onDraft,
  moveTargets, onMoveTo, revealRequest, dragging, onDragStartRow, onDragEndRow,
}: {
  line: QuoteLine;
  quoteId: string;
  currency: string;
  taxRate: string | null;
  isPending: (key: string) => boolean;
  isFirst: boolean;
  isLast: boolean;
  showInternal: boolean;
  /** True when the quote's lines span more than one billing cadence — only then
   *  does the Total cell repeat the '/mo' | '/yr' suffix. */
  mixedCadence: boolean;
  /** Show the deposit-eligible checkbox (quote deposit = 'selected_lines'). */
  depositSelectMode: boolean;
  onEdit: (lineId: string, body: LineUpdate, scopeKey?: string) => Promise<boolean>;
  onMove: (line: QuoteLine, direction: 'up' | 'down') => void;
  onRemove: (line: QuoteLine) => void;
  onDraft: (lineId: string, draft: QuoteLineForMath | null) => void;
  /** Other pricing panels (empty → the Move-to control is hidden). */
  moveTargets: { id: string; label: string }[];
  onMoveTo: (line: QuoteLine, targetBlockId: string) => void;
  /** Set (with a bumped nonce) when the rail's "missing cost" notice targets
   *  THIS line: scrolls it into view, expands the internal band, and focuses
   *  the cost input. See the effect below and LineRevealRequest's doc. */
  revealRequest?: LineRevealRequest | null;
  /** True while THIS row is being dragged (dims the row, like block drags). */
  dragging?: boolean;
  /** Wired by BlockCard when within-block drag-reorder is available: the grip
   *  handle renders only when this is set. Keyboard users keep the ⋯ menu's
   *  Move up/down as the accessible alternative (noted in the handle's title). */
  onDragStartRow?: () => void;
  onDragEndRow?: () => void;
}) {
  const { t } = useTranslation('billing');
  // Per-field pending: only the in-flight control disables, so a slow qty save
  // never freezes price/name/desc (the scoped-pending backport — InvoiceEditor's
  // LineRow got this first). Remove keeps the whole-row key: the confirm-dialog
  // removal flow runs under `line:<id>` and should hold the row's actions.
  const fieldBusy = (field: string) => isPending(pendingKey.lineField(line.id, field));
  const removeBusy = isPending(pendingKey.line(line.id));
  const [name, setName] = useState(line.name ?? '');
  const [desc, setDesc] = useState(line.description ?? '');
  // Rest-state density: an EMPTY description renders no textarea — a compact
  // "+ description" affordance opens it. Lines with prose keep it open (and a
  // server resync that lands prose re-opens it).
  const [descOpen, setDescOpen] = useState(Boolean((line.description ?? '').trim()));
  useEffect(() => { if ((line.description ?? '').trim()) setDescOpen(true); }, [line.description]);
  // Quantity edits/displays in its bare form ('3', not the stored '3.00') so the
  // input matches its own step="1" and the customer-facing rendering.
  const [qty, setQty] = useState(formatQuantity(line.quantity));
  const [price, setPrice] = useState(line.unitPrice);
  // Money-input focus tracking: formatted (currency, thousands-separated) while
  // blurred, raw editable decimal while focused — see the filterMoneyChars /
  // growWidth helpers above. An in-flight field error keeps the RAW string
  // visible even unfocused, so a rejected entry stays legible to correct rather
  // than collapsing into a misleading "$0.00".
  const [priceFocused, setPriceFocused] = useState(false);
  const [costFocused, setCostFocused] = useState(false);
  // recurrence/taxable are committed on change (not blur); keep them in local
  // state so the control updates instantly rather than lagging until the
  // refresh() round-trip lands, and revert if the save fails.
  const [rec, setRec] = useState(line.recurrence);
  const [taxable, setTaxable] = useState(line.taxable);
  // Deposit-eligibility is committed on change (like taxable) and reverts on a
  // failed save; resynced from the server prop after each refresh().
  const [depositEligible, setDepositEligible] = useState(line.depositEligible ?? false);
  // Internal cost/identity fields (cost drives the markup/net strip below the row).
  const [cost, setCost] = useState(line.unitCost ?? '');
  const [sku, setSku] = useState(line.sku ?? '');
  const [partNumber, setPartNumber] = useState(line.partNumber ?? '');

  // Line-actions overflow menu (move up/down/to, image, remove).
  // Fixed-position so the overflow-x-auto table wrapper can't
  // clip it; closes on outside click or Escape (which refocuses the trigger —
  // focus moved into the menu on open, so it would otherwise drop to <body>).
  const [movePos, setMovePos] = useState<{ top: number; left: number; flip?: boolean } | null>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const { listRef: moveListRef, onKeyDown: onMoveListKeyDown } = useMenuKeyboard(movePos !== null, () => setMovePos(null));
  useEffect(() => {
    if (!movePos) return;
    const onDown = (e: MouseEvent) => {
      if (moveMenuRef.current && !moveMenuRef.current.contains(e.target as Node)) setMovePos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMovePos(null); moveTriggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [movePos]);

  // Resync the typed fields from the server, but never over an edit in progress.
  // We track "has the user typed since the last commit?" rather than comparing
  // values: local state holds a raw string ('9.999') while the prop is a
  // formatted decimal ('10.00'), so a value comparison both (a) fails to re-adopt
  // a server-normalized value — leaving the row stuck amber-dirty showing a wrong
  // optimistic total when the server rounds — and (b) is fragile across formats.
  // The flag is set on keystroke and cleared when a commit is initiated (on blur), so:
  //   • a quiet/leading-edge refresh landing mid-type keeps the user's keystrokes
  //     ("edit qty→5, blur, type 7" never loses the 7), and
  //   • after the user stops editing, the next prop adopts the server's canonical
  //     value (e.g. 9.999 → 10.00), clearing the dirty ring and the optimism.
  const nameEdited = useRef(false);
  const descEdited = useRef(false);
  // Auto-grow the (full-width) description textarea to fit its content, while
  // still allowing the user to drag the resize handle for a bigger/smaller box.
  // Long descriptions (> ~4 lines) clamp to a fixed cap while the field is
  // neither focused nor explicitly expanded — a Show more/less affordance and
  // focus both lift the cap. Presentation only: the full text always stays in
  // the field value. (jsdom reports scrollHeight 0, so unit tests always take
  // the unclamped path unless they stub the metric.)
  const DESC_CLAMP_PX = 88; // ≈ 4 lines of text-sm (20px line-height) + padding
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [descFocused, setDescFocused] = useState(false);
  const [descShowAll, setDescShowAll] = useState(false);
  const [descLong, setDescLong] = useState(false);
  const descClamped = descLong && !descFocused && !descShowAll;
  const qtyEdited = useRef(false);
  const priceEdited = useRef(false);
  const costEdited = useRef(false);
  const skuEdited = useRef(false);
  const partEdited = useRef(false);
  useEffect(() => { if (!nameEdited.current) setName(line.name ?? ''); }, [line.name]);
  useEffect(() => { if (!descEdited.current) setDesc(line.description ?? ''); }, [line.description]);
  // Re-fit the description box after any value change (typing or server resync)
  // or clamp-state flip: measure the full height at auto, latch whether the
  // content is long, then apply either the cap or the full height.
  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const full = el.scrollHeight;
    setDescLong(full > DESC_CLAMP_PX + 8);
    el.style.height = `${descClamped ? Math.min(full, DESC_CLAMP_PX) : full}px`;
  }, [desc, descClamped, descOpen]);
  useEffect(() => { if (!qtyEdited.current) setQty(formatQuantity(line.quantity)); }, [line.quantity]);
  useEffect(() => { if (!priceEdited.current) setPrice(line.unitPrice); }, [line.unitPrice]);
  useEffect(() => { if (!costEdited.current) setCost(line.unitCost ?? ''); }, [line.unitCost]);
  useEffect(() => { if (!skuEdited.current) setSku(line.sku ?? ''); }, [line.sku]);
  useEffect(() => { if (!partEdited.current) setPartNumber(line.partNumber ?? ''); }, [line.partNumber]);
  // recurrence/taxable are committed on change (the PATCH resolves before the
  // refresh GET fires), so a stale resync can't race them — a plain resync wins.
  useEffect(() => { setRec(line.recurrence); }, [line.recurrence]);
  useEffect(() => { setTaxable(line.taxable); }, [line.taxable]);
  useEffect(() => { setDepositEligible(line.depositEligible ?? false); }, [line.depositEligible]);

  // Inline validation errors for the money/qty fields. A rejected entry keeps
  // the user's input in the field (to correct, not re-type) with the message
  // rendered directly under the row — replacing the old toast-1000px-away +
  // silent snap-back. Same visual contract as the contract-variable errors
  // (aria-invalid + destructive border + text). Cleared on the next keystroke.
  // Server-side rejections still surface through runAction's toast.
  const [fieldErrors, setFieldErrors] = useState<{ qty?: string; price?: string; cost?: string }>({});
  const setFieldError = useCallback((field: 'qty' | 'price' | 'cost', msg: string | null) => {
    setFieldErrors((e) => {
      if (msg === null) {
        if (!(field in e)) return e;
        const n = { ...e }; delete n[field]; return n;
      }
      return { ...e, [field]: msg };
    });
  }, []);

  // Quiet "Saved" flash in place of the old per-field success toast. This is a
  // single row-level flag on purpose: committing any one field briefly pulses the
  // green ring across the row's fields, reading as "this line saved" rather than
  // tracking which individual cell changed.
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, []);
  // `field` scopes the pending key to the one control being committed; commits
  // without a field (none today) would fall back to freezing the whole row.
  const edit = useCallback(async (body: LineUpdate, field?: string): Promise<boolean> => {
    const ok = await onEdit(line.id, body, field ? pendingKey.lineField(line.id, field) : undefined);
    if (ok) flashSaved();
    return ok;
  }, [onEdit, line.id, flashSaved]);

  // Per-line product image: resolve an imageId from an uploaded file OR a pasted
  // URL (the server copies the bytes in — not a hotlink), then PATCH the line's
  // imageId. Local busy (not the pending map) because the upload itself runs
  // before any line mutation exists to scope. The URL path is a disclosure — a
  // "From URL" button reveals `imageUrlOpen`'s inline field — rather than a
  // per-row tab toggle, which would bloat every line; the add-block form (which
  // has room) uses tabs instead.
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageUrlOpen, setImageUrlOpen] = useState(false);
  const [imageUrlDraft, setImageUrlDraft] = useState('');
  // Attach `uploaded.imageId` to the line, and only on a successful PATCH reset the
  // URL disclosure. Shared by both the file and URL paths so success behaves
  // identically. `edit` swallows a failed PATCH inside runScoped (toasts, returns
  // false, never throws), so gating the reset on its result keeps the disclosure
  // open with the URL intact on failure — otherwise the panel would collapse and
  // wipe the URL exactly as if it had saved, contradicting the error toast.
  const applyImageId = useCallback(async (imageId: string) => {
    if (await edit({ imageId }, 'image')) {
      setImageUrlDraft('');
      setImageUrlOpen(false);
    }
  }, [edit]);
  const attachImage = useCallback((file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      handleActionError(new Error('image too large'), t('quotes.editor.errors.imageTooLarge'));
      return;
    }
    void (async () => {
      setImageBusy(true);
      try {
        const uploaded = await runAction<{ imageId: string }>({
          request: () => uploadQuoteImage(quoteId, file),
          errorFallback: t('quotes.editor.errors.uploadImage'),
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: { imageId: string } }).data,
        });
        await applyImageId(uploaded.imageId);
      } catch {
        // runAction already surfaced the failure (toast/redirect).
      } finally {
        setImageBusy(false);
      }
    })();
  }, [quoteId, applyImageId, t]);
  // URL path: the server fetches + copies the remote bytes (SSRF-guarded, 5 MB
  // cap enforced server-side — unlike the file path there's no local size check
  // because the bytes aren't in hand here). Mirrors the image block's URL flow.
  const attachImageFromUrl = useCallback(() => {
    const url = imageUrlDraft.trim();
    if (!url) return;
    void (async () => {
      setImageBusy(true);
      try {
        const uploaded = await runAction<{ imageId: string }>({
          request: () => addQuoteImageFromUrl(quoteId, url),
          errorFallback: t('quotes.editor.errors.fetchImageFromUrl'),
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: { imageId: string } }).data,
        });
        await applyImageId(uploaded.imageId);
      } catch {
        // runAction already surfaced the failure (toast/redirect).
      } finally {
        setImageBusy(false);
      }
    })();
  }, [quoteId, imageUrlDraft, applyImageId, t]);
  // Per-field dirty cue (mirrors the terms/tax ring) so every editable surface
  // signals unsaved state the same way.
  const nameDirty = name.trim() !== (line.name ?? '');
  const descDirty = desc.trim() !== (line.description ?? '');
  const qtyDirty = Number(qty) !== Number(line.quantity);
  const priceDirty = Number(price) !== Number(line.unitPrice);

  // Effective qty/price for the optimistic Total/Tax and the rail draft. A blank
  // or non-positive qty / negative price isn't an optimism input — it would flash
  // the line to $0 while the user is mid-retype (and `commitQty` rejects qty ≤ 0
  // anyway), so fall back to the persisted value until the field holds a real one.
  const qtyNum = Number(qty);
  const priceNum = Number(price);
  const qtyValid = qty.trim() !== '' && Number.isFinite(qtyNum) && qtyNum > 0;
  const priceValid = price.trim() !== '' && Number.isFinite(priceNum) && priceNum >= 0;
  const effQty = qtyValid ? qty : line.quantity;
  const effPrice = priceValid ? price : line.unitPrice;
  const totalDiverged = Number(effQty) !== Number(line.quantity) || Number(effPrice) !== Number(line.unitPrice);

  // The row's Total/Tax use the SAME shared cents math as the rail
  // (computeLineTotal — round-half-up at the cent boundary), so a sub-cent unit
  // price can't make the row Total and the rail contribution disagree by a cent
  // while typing. When qty/price are unchanged we defer to the authoritative
  // persisted lineTotal so server normalization still wins on settle.
  const displayTotal = totalDiverged ? computeLineTotal(effQty, effPrice) : line.lineTotal;
  const displayTax = lineTaxAmount(displayTotal, taxable, taxRate);

  // Markup is derived from price+cost. The input is controlled by local state that
  // resyncs from the derived value when price/cost change — but only while the
  // field is NOT focused, so a cross-field cost edit never yanks the caret. (This
  // replaces the old key={markupStr} remount, which dropped focus on every
  // commit.) Net is (price − cost) × qty in cents; "—" when no cost is set.
  const mk = markupPct(effPrice, cost);
  const markupStr = mk === null ? '' : String(Number(mk.toFixed(2)));
  const markupFocused = useRef(false);
  const [markupInput, setMarkupInput] = useState(markupStr);
  useEffect(() => { if (!markupFocused.current) setMarkupInput(markupStr); }, [markupStr]);
  const netCents = cost.trim() === ''
    ? null
    : toCents(computeLineTotal(effQty, effPrice)) - toCents(computeLineTotal(effQty, cost));
  const costDirty = cost.trim() === '' ? line.unitCost !== null : Number(cost) !== Number(line.unitCost);
  // Independent of `costDirty` (unsaved-vs-persisted): true whenever the FIELD
  // is currently empty, saved or not — drives the warning treatment (Task 2)
  // that flags a genuinely missing cost, as opposed to an in-flight edit.
  const costMissing = cost.trim() === '';
  // Displayed strings for the price/cost inputs — currency-formatted while
  // blurred (matching the adjacent read-only Total/summary cells), the raw
  // decimal while focused or mid-error (so a rejected entry stays legible to
  // correct). Width is sized off these — the formatted form ("$1,234.56") is
  // longer than the raw decimal, so basing width on the raw value alone would
  // clip the currency symbol/separators once unfocused.
  const priceDisplay = priceFocused || fieldErrors.price ? price : formatMoney(price, currency);
  const costDisplay = costFocused || fieldErrors.cost ? cost : (cost.trim() === '' ? '' : formatMoney(cost, currency));
  const skuDirty = sku.trim() !== (line.sku ?? '');
  const partDirty = partNumber.trim() !== (line.partNumber ?? '');

  // Per-line internal-band disclosure: collapsed (summary-only) by default,
  // component-local, never persisted. An unsaved cost/SKU/PN edit (or an inline
  // cost error) pins the band open — a collapse request only takes effect once
  // the edit lands and the server prop resync clears the dirty flag, so unsaved
  // internal edits are never hidden mid-flight.
  const [internalOpen, setInternalOpen] = useState(false);
  const internalDirty = costDirty || skuDirty || partDirty;
  const internalExpanded = internalOpen || internalDirty || Boolean(fieldErrors.cost);

  // Reveal-on-demand (Task 3 UX pass): the rail's actionable "missing cost"
  // notice can target THIS line — scroll it into view, force the internal band
  // open, and focus the cost input. `rowRef` anchors the scroll; `costInputRef`
  // is the focus target.
  const rowRef = useRef<HTMLTableRowElement>(null);
  const costInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!revealRequest || revealRequest.lineId !== line.id) return;
    setInternalOpen(true);
    const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rowRef.current?.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    // The band can still be `inert` for one render right after setInternalOpen
    // (React hasn't committed yet) — retry across a few frames until the input
    // is actually reachable, the same idiom as GhostRow's post-save refocus
    // above. Checked via the DOM attribute directly rather than relying on
    // `inert`'s focus-blocking behavior, which jsdom doesn't implement.
    const tryFocus = (tries: number) => {
      const el = costInputRef.current;
      if (el && !el.closest('[inert]')) { el.focus(); return; }
      if (tries > 0) requestAnimationFrame(() => tryFocus(tries - 1));
    };
    requestAnimationFrame(() => tryFocus(10));
    // Only the reveal request identity should re-trigger this — line.id is
    // stable per row instance, and re-running on every internalOpen/dirty
    // change would fight the user's own toggle.
  }, [revealRequest?.nonce, revealRequest?.lineId, line.id]);

  // Report this row's effective values to the parent so the rail "Live totals"
  // recompute uses the same inputs. Emit null once nothing diverges, so the rail
  // reverts to the authoritative server figures; cleanup on unmount avoids a
  // phantom draft skewing the rail after a delete.
  const depositEligibleDirty = depositEligible !== (line.depositEligible ?? false);
  const diverged = totalDiverged || taxable !== line.taxable || rec !== line.recurrence || costDirty || depositEligibleDirty;
  useEffect(() => {
    onDraft(line.id, diverged
      ? { quantity: String(effQty), unitPrice: String(effPrice), unitCost: cost || null, taxable, customerVisible: line.customerVisible, recurrence: rec, depositEligible, itemType: line.itemType ?? null }
      : null);
  }, [onDraft, line.id, line.customerVisible, line.itemType, diverged, effQty, effPrice, cost, taxable, rec, depositEligible]);
  // Clear this row's draft when it unmounts (e.g. removed) so the rail doesn't
  // keep a phantom override.
  useEffect(() => () => onDraft(line.id, null), [onDraft, line.id]);

  const commitName = () => {
    const next = name.trim();
    nameEdited.current = false; // committing — let the server value re-adopt next
    if (next === (line.name ?? '')) { setName(line.name ?? ''); return; }
    // A line can't have both name and description blank (mirrors the API refine).
    if (!next && !(line.description ?? '').trim()) {
      handleActionError(new Error('empty line'), t('quotes.editor.errors.lineNeedsNameOrDescription'));
      setName(line.name ?? '');
      return;
    }
    void edit({ name: next || null }, 'name');
  };
  const commitDesc = () => {
    const next = desc.trim();
    descEdited.current = false; // committing — let the server value re-adopt next
    if (next === (line.description ?? '')) { setDesc(line.description ?? ''); return; }
    if (!next && !(line.name ?? '').trim()) {
      handleActionError(new Error('empty line'), t('quotes.editor.errors.lineNeedsNameOrDescription'));
      setDesc(line.description ?? '');
      return;
    }
    void edit({ description: next || null }, 'desc');
  };
  const commitQty = () => {
    const n = Number(qty);
    qtyEdited.current = false;
    if (n === Number(line.quantity)) { setQty(formatQuantity(line.quantity)); setFieldError('qty', null); return; } // unchanged — silent
    // A rejected entry stays in the field with an inline error under the row —
    // never a far-away toast plus a silent snap-back. The optimistic Total/rail
    // already fall back to the persisted value while the field holds an invalid
    // one (qtyValid), so nothing downstream computes from the bad input.
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      setFieldError('qty', t('quotes.editor.errors.quantityWholeGreaterThanZero'));
      return;
    }
    setFieldError('qty', null);
    void edit({ quantity: n }, 'qty');
  };
  const commitPrice = () => {
    const n = Number(price);
    priceEdited.current = false;
    if (n === Number(line.unitPrice)) { setPrice(line.unitPrice); setFieldError('price', null); return; } // unchanged — silent
    if (!Number.isFinite(n) || n < 0) {
      setFieldError('price', t('quotes.editor.errors.unitPriceZeroOrMore'));
      return;
    }
    setFieldError('price', null);
    void edit({ unitPrice: n }, 'price');
  };
  const commitCost = () => {
    costEdited.current = false;
    if (cost.trim() === '') { setFieldError('cost', null); if (line.unitCost !== null) void edit({ unitCost: null }, 'cost'); return; }
    const n = Number(cost);
    if (!Number.isFinite(n) || n < 0) {
      setFieldError('cost', t('quotes.editor.errors.costZeroOrMore'));
      return;
    }
    setFieldError('cost', null);
    if (n !== Number(line.unitCost)) void edit({ unitCost: n }, 'cost');
  };
  const commitSku = () => {
    skuEdited.current = false;
    const next = sku.trim();
    if (next !== (line.sku ?? '')) void edit({ sku: next || null }, 'sku');
  };
  const commitPartNumber = () => {
    partEdited.current = false;
    const next = partNumber.trim();
    if (next !== (line.partNumber ?? '')) void edit({ partNumber: next || null }, 'pn');
  };
  // Editing markup% commits a new unit price derived from cost: price = cost·(1+m).
  const onMarkupCommit = (raw: string) => {
    const m = Number(raw);
    // Need a cost base, and treat an emptied markup field as "leave price alone" —
    // Number('') is 0 (finite), which would otherwise rewrite unitPrice down to cost
    // (zero margin) just because the user cleared the field.
    if (cost.trim() === '' || raw.trim() === '' || !Number.isFinite(m)) return;
    const nextPrice = priceFromMarkup(cost, m);
    setPrice(nextPrice);
    priceEdited.current = false;
    if (Number(nextPrice) !== Number(line.unitPrice)) void edit({ unitPrice: Number(nextPrice) }, 'price');
  };

  return (
    <>
    <tr ref={rowRef} className={`border-t align-top [&>td]:pt-4 ${dragging ? 'opacity-40' : ''}`} data-testid={`quote-line-${line.id}`}>
      {/* Column min-width (min-w-[12rem]) is declared on the cell so table
          auto-layout reserves the name column instead of squeezing it below the
          input's width (which used to overflow into the qty cell). */}
      <td className="min-w-[12rem] px-1.5 py-2">
        <div className="flex min-w-0 items-start gap-2">
          {line.imageId
            ? <LineImageThumb quoteId={quoteId} imageId={line.imageId} />
            : line.catalogItemId && <CatalogLineThumb catalogItemId={line.catalogItemId} />}
          <div className="w-full min-w-0 space-y-1">
            <input
              type="text"
              value={name}
              aria-label={t('quotes.editor.line.nameAria')}
              placeholder={t('quotes.editor.line.namePlaceholder')}
              onChange={(e) => { setName(e.target.value); nameEdited.current = true; }}
              onBlur={commitName}
              disabled={fieldBusy('name')}
              aria-describedby={nameDirty ? unsavedHintId(line.id, 'name') : undefined}
              data-testid={`quote-line-name-${line.id}`}
              className={`h-9 w-full rounded-md border bg-transparent px-2 py-1 text-sm font-medium transition-colors focus:outline-hidden disabled:opacity-60 ${seamless(fieldRing(nameDirty, saved))}`}
            />
            <UnsavedFieldHint id={unsavedHintId(line.id, 'name')} show={nameDirty} />
          </div>
        </div>
      </td>
      <td className="px-1.5 py-2 text-right">
        <input
          type="number" min="1" step="1"
          value={qty}
          aria-label={t('quotes.editor.line.quantityAria')}
          onChange={(e) => { setQty(e.target.value); qtyEdited.current = true; setFieldError('qty', null); }}
          onBlur={commitQty}
          disabled={fieldBusy('qty')}
          aria-invalid={fieldErrors.qty ? true : undefined}
          aria-describedby={describedByIds(fieldErrors.qty && `quote-line-qty-error-${line.id}`, qtyDirty && unsavedHintId(line.id, 'qty'))}
          data-testid={`quote-line-qty-${line.id}`}
          className={`h-9 w-14 rounded-md border bg-transparent px-2 text-right text-sm tabular-nums transition-colors focus:outline-hidden disabled:opacity-60 ${fieldErrors.qty ? 'border-destructive' : seamless(fieldRing(qtyDirty, saved))}`}
        />
        <UnsavedFieldHint id={unsavedHintId(line.id, 'qty')} show={qtyDirty} />
      </td>
      <td className="px-1.5 py-2 text-right">
        <input
          type="text" inputMode="decimal"
          value={priceDisplay}
          aria-label={t('quotes.editor.table.unitPrice')}
          onFocus={() => setPriceFocused(true)}
          onChange={(e) => { setPrice(filterMoneyChars(e.target.value)); priceEdited.current = true; setFieldError('price', null); }}
          onBlur={() => { setPriceFocused(false); commitPrice(); }}
          disabled={fieldBusy('price')}
          aria-invalid={fieldErrors.price ? true : undefined}
          aria-describedby={describedByIds(fieldErrors.price && `quote-line-price-error-${line.id}`, priceDirty && unsavedHintId(line.id, 'price'))}
          data-testid={`quote-line-price-${line.id}`}
          style={{ width: growWidth(priceDisplay, 8, 16) }}
          className={`h-9 rounded-md border bg-transparent px-2 text-right text-sm tabular-nums transition-colors focus:outline-hidden disabled:opacity-60 ${fieldErrors.price ? 'border-destructive' : seamless(fieldRing(priceDirty, saved))}`}
        />
        <UnsavedFieldHint id={unsavedHintId(line.id, 'price')} show={priceDirty} />
        {/* Billing cadence belongs with the price ("$1,499.00 /mo"), so its
            select rides directly under the price input instead of claiming a
            table column of its own. */}
        <select
          value={rec}
          aria-label={t('quotes.editor.line.billingFrequencyAria')}
          onChange={(e) => {
            const next = e.target.value as QuoteLineRecurrence;
            setRec(next); // optimistic — revert if the save fails
            void edit({ recurrence: next }, 'rec').then((ok) => { if (!ok) setRec(line.recurrence); });
          }}
          disabled={fieldBusy('rec')}
          data-testid={`quote-line-recurrence-${line.id}`}
          className="ml-auto mt-1 block h-7 w-24 rounded-md border border-transparent bg-transparent py-0 pl-2 pr-6 text-xs text-muted-foreground transition-colors hover:border-border focus:border-border focus:outline-hidden disabled:opacity-60"
        >
          <option value="one_time">{t('quotes.editor.recurrence.one_time')}</option>
          <option value="monthly">{t('quotes.editor.recurrence.monthly')}</option>
          <option value="annual">{t('quotes.editor.recurrence.annual')}</option>
        </select>
      </td>
      <td className="whitespace-nowrap px-1.5 py-2 text-right tabular-nums">
        <span data-testid={`quote-line-total-${line.id}`}>{formatMoney(displayTotal, currency)}</span>
        {/* Cadence suffix only when the quote actually mixes cadences — on a
            uniform quote it's repetition (the recurrence select still shows it). */}
        {mixedCadence && rec !== 'one_time' && (
          <span className="text-xs text-muted-foreground">{rec === 'monthly' ? t('quotes.editor.units.perMonth') : t('quotes.editor.units.perYear')}</span>
        )}
        <div className="text-xs font-normal text-muted-foreground" data-testid={`quote-line-tax-${line.id}`}>
          {displayTax !== null
            ? t('quotes.editor.table.taxSuffix', { amount: formatMoney(displayTax, currency) })
            : taxable ? t('quotes.editor.table.taxable') : null}
        </div>
        <SrSaved show={saved} testId={`quote-line-saved-${line.id}`} />
      </td>
      <td className="whitespace-nowrap px-1.5 py-2 text-right">
        {/* Drag-to-reorder grip (writers, within this table only). Mouse/touch
            affordance — keyboard users reorder via the ⋯ menu's Move up/down,
            which the title spells out. Cross-block moves stay menu-only. */}
        {onDragStartRow && (
          <button
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', line.id);
              onDragStartRow();
            }}
            onDragEnd={() => onDragEndRow?.()}
            disabled={removeBusy}
            aria-label={t('quotes.editor.actions.dragLine')}
            title={t('quotes.editor.actions.dragLineTitle')}
            data-testid={`quote-line-drag-${line.id}`}
            className="mr-0.5 inline-flex h-7 w-7 cursor-grab items-center justify-center rounded align-middle text-muted-foreground hover:bg-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:opacity-30"
          >
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
        )}
        {/* ALL row-level actions live behind one overflow menu, so tabbing
            through a line is data-entry only — one stop instead of four, and
            no destructive button sitting mid-path between the price fields and
            the description. Same menu grammar as the header kebab
            (useMenuKeyboard: focus-on-open + arrow cycling; Esc-to-trigger is
            the local document-level handler above). */}
        <div ref={moveMenuRef} className="inline-block align-middle">
          <button
            ref={moveTriggerRef}
            type="button"
            onClick={(e) => {
              if (movePos) { setMovePos(null); return; }
              const r = e.currentTarget.getBoundingClientRect();
              // Flip above the trigger near the viewport bottom so the menu
              // never extends off-screen (fixed positioning doesn't scroll).
              const flip = r.bottom + 280 > window.innerHeight;
              setMovePos({ top: flip ? r.top - 4 : r.bottom + 4, left: r.right, flip });
            }}
            disabled={removeBusy}
            aria-label={t('quotes.editor.actions.lineActions')}
            aria-haspopup="menu"
            aria-expanded={movePos !== null}
            data-testid={`quote-line-actions-${line.id}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
          {movePos && (
            <div
              role="menu"
              ref={moveListRef}
              onKeyDown={onMoveListKeyDown}
              aria-label={t('quotes.editor.actions.lineActions')}
              style={{ position: 'fixed', top: movePos.top, left: movePos.left, transform: movePos.flip ? 'translateX(-100%) translateY(-100%)' : 'translateX(-100%)' }}
              className="z-50 w-max min-w-40 max-w-[min(20rem,calc(100vw-1rem))] rounded-md border bg-card py-1 shadow-md"
              data-testid={`quote-line-actions-menu-${line.id}`}
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={isFirst}
                onClick={() => { setMovePos(null); moveTriggerRef.current?.focus(); onMove(line, 'up'); }}
                data-testid={`quote-line-move-up-${line.id}`}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
              >
                {t('quotes.editor.actions.moveLineUp')}
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={isLast}
                onClick={() => { setMovePos(null); moveTriggerRef.current?.focus(); onMove(line, 'down'); }}
                data-testid={`quote-line-move-down-${line.id}`}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
              >
                {t('quotes.editor.actions.moveLineDown')}
              </button>
              {moveTargets.length > 0 && !line.parentLineId && (
                <>
                  <p className="mt-1 border-t px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.editor.actions.moveTo')}</p>
                  {moveTargets.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      title={t.label}
                      onClick={() => { setMovePos(null); onMoveTo(line, t.id); }}
                      data-testid={`quote-line-move-to-${line.id}-${t.id}`}
                      className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden"
                    >
                      {t.label}
                    </button>
                  ))}
                </>
              )}
              <div className="mt-1 border-t pt-1">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={imageBusy || fieldBusy('image')}
                  onClick={() => { setMovePos(null); imageInputRef.current?.click(); }}
                  data-testid={`quote-line-image-attach-${line.id}`}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
                >
                  {line.imageId ? t('quotes.editor.actions.replaceImage') : t('quotes.editor.actions.addImage')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={imageBusy || fieldBusy('image')}
                  onClick={() => { setMovePos(null); setImageUrlOpen(true); }}
                  data-testid={`quote-line-image-url-toggle-${line.id}`}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
                >
                  {t('quotes.editor.actions.imageFromUrl')}
                </button>
                {line.imageId && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={imageBusy || fieldBusy('image')}
                    onClick={() => { setMovePos(null); void edit({ imageId: null }, 'image'); }}
                    data-testid={`quote-line-image-remove-${line.id}`}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
                  >
                    {t('quotes.editor.actions.removeImage')}
                  </button>
                )}
              </div>
              <div className="mt-1 border-t pt-1">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => { setMovePos(null); onRemove(line); }}
                  data-testid={`quote-line-remove-${line.id}`}
                  className="block w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-hidden"
                >
                  {t('quotes.editor.actions.removeLine')}
                </button>
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
    {/* Full-width description row, so writers get a roomy, expandable box instead
        of a cramped textarea squeezed into the narrow Description column. */}
    <tr className={`border-0 ${dragging ? 'opacity-40' : ''}`} data-testid={`quote-line-desc-row-${line.id}`}>
      <td colSpan={5} className="px-2 pb-2">
        {/* Inline errors for the row's qty/price inputs — rendered full-width
            directly under the row (the narrow cells above can't hold a message);
            the offending input carries aria-invalid + a destructive ring. */}
        {(fieldErrors.qty || fieldErrors.price) && (
          <div className="mb-1 space-y-0.5">
            {fieldErrors.qty && (
              <p id={`quote-line-qty-error-${line.id}`} className="text-xs text-destructive" data-testid={`quote-line-qty-error-${line.id}`}>
                {fieldErrors.qty}
              </p>
            )}
            {fieldErrors.price && (
              <p id={`quote-line-price-error-${line.id}`} className="text-xs text-destructive" data-testid={`quote-line-price-error-${line.id}`}>
                {fieldErrors.price}
              </p>
            )}
          </div>
        )}
        {descOpen && (
          <>
            <textarea
              ref={descRef}
              value={desc}
              aria-label={t('quotes.editor.line.descriptionAria')}
              placeholder={t('quotes.editor.line.descriptionOptional')}
              onChange={(e) => { setDesc(e.target.value); descEdited.current = true; }}
              onFocus={() => setDescFocused(true)}
              onBlur={() => { setDescFocused(false); commitDesc(); }}
              rows={2}
              autoFocus={!(line.description ?? '').trim()}
              disabled={fieldBusy('desc')}
              aria-describedby={descDirty ? unsavedHintId(line.id, 'desc') : undefined}
              data-testid={`quote-line-desc-${line.id}`}
              className={`min-h-9 w-full resize-y overflow-hidden rounded-md border bg-transparent px-2 py-1 text-sm text-muted-foreground transition-colors focus:outline-hidden disabled:opacity-60 ${seamless(fieldRing(descDirty, saved))}`}
            />
            <UnsavedFieldHint id={unsavedHintId(line.id, 'desc')} show={descDirty} />
            {/* Show more/less for a clamped long description. Focusing the
                textarea also expands it, so this is mainly the mouse/AT path. */}
            {descLong && (
              <button
                type="button"
                onClick={() => setDescShowAll((v) => !v)}
                aria-expanded={!descClamped}
                data-testid={`quote-line-desc-clamp-toggle-${line.id}`}
                className="mt-0.5 inline-flex items-center rounded text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {descClamped ? t('quotes.editor.line.showMore') : t('quotes.editor.line.showLess')}
              </button>
            )}
          </>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* Taxable moved out of its own table column: it's an editing control,
              not a per-glance figure (the computed tax shows under the Total). */}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={taxable}
              onChange={(e) => {
                const next = e.target.checked;
                setTaxable(next); // optimistic — revert if the save fails
                void edit({ taxable: next }, 'taxable').then((ok) => { if (!ok) setTaxable(line.taxable); });
              }}
              disabled={fieldBusy('taxable')}
              data-testid={`quote-line-taxable-${line.id}`}
            />
            {t('quotes.editor.table.taxable')}
          </label>
          {/* Deposit-eligible toggle appears only when the quote's deposit is
              'selected_lines'. It's meaningful for one-time lines only (recurring
              lines never count toward a deposit), so it's hidden for recurring rows. */}
          {depositSelectMode && rec === 'one_time' && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={depositEligible}
                onChange={(e) => {
                  const next = e.target.checked;
                  setDepositEligible(next); // optimistic — revert if the save fails
                  void edit({ depositEligible: next }, 'deposit').then((ok) => { if (!ok) setDepositEligible(line.depositEligible ?? false); });
                }}
                disabled={fieldBusy('deposit')}
                data-testid={`line-deposit-eligible-${line.id}`}
              />
              {t('quotes.editor.deposit.eligibleAria')}
            </label>
          )}
          {!descOpen && (
            <button
              type="button"
              onClick={() => setDescOpen(true)}
              data-testid={`quote-line-desc-open-${line.id}`}
              className="inline-flex h-8 items-center rounded-md border border-transparent px-2 text-xs font-medium text-muted-foreground hover:border-border hover:text-foreground"
            >
              <span aria-hidden="true">+</span>&nbsp;{t('quotes.editor.line.addDescription')}
            </button>
          )}
          {descOpen && (name.trim() || desc.trim()) && (
            <PolishButton
              disabled={fieldBusy('polish')}
              idSuffix={`quote-line-${line.id}`}
              compact
              label={t('quotes.editor.line.tidyWithAi')}
              icon={<Sparkles className="h-3 w-3" aria-hidden="true" />}
              getText={() => ({ name, description: desc })}
              onApply={(r) => {
                const patch: { name?: string | null; description?: string | null } = {};
                if (r.name !== null) { setName(r.name); nameEdited.current = false; patch.name = r.name || null; }
                if (r.description !== null) { setDesc(r.description); descEdited.current = false; patch.description = r.description || null; }
                if (Object.keys(patch).length) void edit(patch, 'polish');
              }}
            />
          )}
          {/* Per-line product image controls. The thumbnail itself renders next
              to the name; these manage it. Same 5MB/type limits as image blocks. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            data-testid={`quote-line-image-input-${line.id}`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ''; // allow re-picking the same file
              if (f) attachImage(f);
            }}
          />
          {/* Image actions live in the line's ⋯ menu (rare actions off the
              daily scan path); the busy spinner is the only inline trace. */}
          {imageBusy && (
            <span className="inline-flex h-8 items-center gap-1 px-2 text-xs text-muted-foreground" data-testid={`quote-line-image-busy-${line.id}`}>
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('quotes.editor.actions.uploading')}
            </span>
          )}
          {/* URL disclosure: w-full forces it onto its own row under the parent's
              flex-wrap so the input has room. Server copies the bytes in
              (SSRF-guarded); Fetch is disabled until a URL is entered, matching
              the image block's submit gate. */}
          {imageUrlOpen && (
            <div className="flex w-full items-center gap-2">
              <input
                type="url"
                value={imageUrlDraft}
                onChange={(e) => setImageUrlDraft(e.target.value)}
                placeholder={t('quotes.editor.addSection.imageUrlPlaceholder')}
                disabled={imageBusy}
                aria-label={t('quotes.editor.line.imageUrlAria')}
                data-testid={`quote-line-image-url-input-${line.id}`}
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
              />
              <button
                type="button"
                onClick={attachImageFromUrl}
                disabled={imageBusy || fieldBusy('image') || !imageUrlDraft.trim()}
                data-testid={`quote-line-image-url-fetch-${line.id}`}
                className="inline-flex h-8 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {t('quotes.editor.actions.fetch')}
              </button>
              <button
                type="button"
                onClick={() => { setImageUrlOpen(false); setImageUrlDraft(''); }}
                disabled={imageBusy}
                data-testid={`quote-line-image-url-cancel-${line.id}`}
                className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {t('quotes.editor.actions.cancel')}
              </button>
            </div>
          )}
        </div>
      </td>
    </tr>
    {/* Internal-only cost/markup/profit band — never shown to the customer.
        Hidden entirely via the editor's "Show cost & margin" toggle; kept in
        the DOM (hidden) rather than unmounted so totals/draft wiring stays live.
        When shown, each line defaults to the compact summary; the full editing
        micro-form appears behind the per-line disclosure. */}
    <tr className={`border-0 ${showInternal ? '' : 'hidden'} ${dragging ? 'opacity-40' : ''}`} data-testid={`quote-line-internal-${line.id}`}>
      <td colSpan={5} className="px-2 pb-2">
        <div className="rounded-md bg-muted/40 px-2 py-1 text-xs text-foreground/70 dark:text-muted-foreground">
          {/* The toggle carries the disclaimer (full wording on the first row, the
              subtle "Internal" tag on the rest) so a writer scanning mid-table
              never mistakes the cost/markup band for customer-facing copy. The
              summary reflects LIVE field state, not just the persisted line. */}
          <InternalBandToggle
            lineId={line.id}
            isFirst={isFirst}
            expanded={internalExpanded}
            onToggle={() => setInternalOpen((v) => !v)}
            summary={
              <InternalBandSummary
                lineId={line.id}
                sku={sku.trim()}
                costStr={cost.trim() === '' ? t('quotes.editor.symbols.notAvailable') : formatMoney(cost, currency)}
                costMissing={costMissing}
                markupStr={markupStr === '' ? t('quotes.editor.symbols.notAvailable') : `${markupStr}${t('quotes.editor.symbols.percent')}`}
                profitStr={netCents === null ? t('quotes.editor.symbols.notAvailable') : formatMoney(fromCents(netCents), currency)}
              />
            }
          />
          <InternalBandCollapse expanded={internalExpanded} testId={`quote-line-internal-detail-${line.id}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-0.5 pt-1.5">
          <label className="flex items-center gap-1">{t('quotes.editor.line.sku')}
            <input
              type="text"
              value={sku}
              onChange={(e) => { setSku(e.target.value); skuEdited.current = true; }}
              onBlur={commitSku}
              disabled={fieldBusy('sku')}
              aria-describedby={skuDirty ? unsavedHintId(line.id, 'sku') : undefined}
              data-testid={`quote-line-sku-${line.id}`}
              className={`h-6 w-28 rounded border bg-background px-1 text-foreground transition-shadow ${fieldRing(skuDirty, saved)}`}
            />
            <UnsavedFieldHint id={unsavedHintId(line.id, 'sku')} show={skuDirty} />
          </label>
          <label className="flex items-center gap-1">{t('quotes.editor.line.partNumberAbbr')}
            <input
              type="text"
              value={partNumber}
              onChange={(e) => { setPartNumber(e.target.value); partEdited.current = true; }}
              onBlur={commitPartNumber}
              disabled={fieldBusy('pn')}
              aria-describedby={partDirty ? unsavedHintId(line.id, 'pn') : undefined}
              data-testid={`quote-line-partnumber-${line.id}`}
              className={`h-6 w-28 rounded border bg-background px-1 text-foreground transition-shadow ${fieldRing(partDirty, saved)}`}
            />
            <UnsavedFieldHint id={unsavedHintId(line.id, 'pn')} show={partDirty} />
          </label>
          <label className="flex items-center gap-1">{t('quotes.editor.line.cost')}
            <input
              ref={costInputRef}
              type="text" inputMode="decimal"
              value={costDisplay}
              onFocus={() => setCostFocused(true)}
              onChange={(e) => { setCost(filterMoneyChars(e.target.value)); costEdited.current = true; setFieldError('cost', null); }}
              onBlur={() => { setCostFocused(false); commitCost(); }}
              disabled={fieldBusy('cost')}
              aria-invalid={fieldErrors.cost ? true : undefined}
              aria-describedby={describedByIds(
                fieldErrors.cost && `quote-line-cost-error-${line.id}`,
                costDirty && unsavedHintId(line.id, 'cost'),
              )}
              data-testid={`quote-line-cost-${line.id}`}
              style={{ width: growWidth(costDisplay, 6, 14) }}
              // Priority: validation error (destructive) > unsaved edit (amber
              // dirty ring) > a genuinely missing cost (warning tint — Task 2's
              // "distinct from the amber dirty ring" treatment, using the same
              // warning token family at lower opacity so it reads as related but
              // not identical) > saved flash / rest.
              className={`h-6 rounded border bg-background px-1 text-right tabular-nums text-foreground transition-shadow ${
                fieldErrors.cost
                  ? 'border-destructive ring-1 ring-destructive'
                  : costDirty
                    ? fieldRing(costDirty, saved)
                    : costMissing
                      ? 'border-warning/50'
                      : fieldRing(false, saved)
              }`}
            />
            <UnsavedFieldHint id={unsavedHintId(line.id, 'cost')} show={costDirty} />
          </label>
          {fieldErrors.cost && (
            <p id={`quote-line-cost-error-${line.id}`} className="w-full text-xs font-normal normal-case tracking-normal text-destructive" data-testid={`quote-line-cost-error-${line.id}`}>
              {fieldErrors.cost}
            </p>
          )}
          <label className="flex items-center gap-1">{t('quotes.editor.line.markup')}
            <input
              type="number" step="0.1"
              value={markupInput}
              onFocus={() => { markupFocused.current = true; }}
              onChange={(e) => setMarkupInput(e.target.value)}
              onBlur={(e) => { markupFocused.current = false; onMarkupCommit(e.target.value); }}
              disabled={fieldBusy('price') || cost.trim() === ''}
              // Tell keyboard/SR users WHY the field is disabled — sighted users can
              // see the empty cost field, AT users can't.
              title={cost.trim() === '' ? t('quotes.editor.line.enterCostFirstMarkup') : undefined}
              aria-describedby={cost.trim() === '' ? `quote-line-markup-hint-${line.id}` : undefined}
              data-testid={`quote-line-markup-${line.id}`}
              style={{ width: growWidth(markupInput, 5, 10) }}
              className="h-6 rounded border bg-background px-1 text-right tabular-nums text-foreground disabled:opacity-60"
            />{t('quotes.editor.symbols.percent')}
            {cost.trim() === '' && <span id={`quote-line-markup-hint-${line.id}`} className="sr-only">{t('quotes.editor.line.enterCostFirstMarkupSentence')}</span>}
          </label>
          <span className="ml-auto">{t('quotes.editor.line.profit')}{' '}
            <span className="font-medium tabular-nums text-foreground" data-testid={`quote-line-net-${line.id}`}>
              {netCents === null ? t('quotes.editor.symbols.notAvailable') : formatMoney(fromCents(netCents), currency)}
            </span>
          </span>
          </div>
          </InternalBandCollapse>
        </div>
      </td>
    </tr>
    </>
  );
}

// Small product thumbnail for a catalog-sourced quote line. GET /catalog/:id/image
// needs the Bearer header (a bare <img src> would 401), and 404s when the item has
// no image — so we fetchWithAuth → blob → object URL and render nothing on miss.
export function CatalogLineThumb({ catalogItemId }: { catalogItemId: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(catalogItemImagePath(catalogItemId));
        if (!res.ok) return; // 404 = no image; render nothing
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = window.URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // no image / load failure — render nothing
      }
    })();
    return () => { cancelled = true; if (objectUrl) window.URL.revokeObjectURL(objectUrl); };
  }, [catalogItemId]);

  if (!url) return null;
  return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded border object-contain" data-testid="quote-line-thumb" />;
}

// Per-line uploaded image thumbnail (GET /quotes/:id/images/:imageId needs the
// Bearer header — same contract as CatalogLineThumb: render nothing on miss).
export function LineImageThumb({ quoteId, imageId }: { quoteId: string; imageId: string }) {
  const { url } = useAuthedImage(quoteImageUrl(quoteId, imageId));
  if (!url) return null;
  return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded border object-contain" data-testid="quote-line-image-thumb" />;
}
