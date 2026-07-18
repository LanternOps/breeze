// A single quote block on the editor canvas (heading / rich text / image /
// pricing table / contract), including the pricing table's row rendering and
// the collapsed add-line picker. Split from QuoteEditor.tsx — see
// quoteEditorShared.tsx for the shared save-language plumbing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import '../../../lib/i18n';
import { markupPct, priceFromMarkup, type QuoteLineForMath } from '@breeze/shared';
import { quoteImageUrl } from '../../../lib/api/quotes';
import { type CatalogItem } from '../../../lib/api/catalog';
import { type EcProduct, type Pax8Product, type Pax8PriceOption } from '../../../lib/api/distributors';
import RichTextEditor from '../../common/RichTextEditor';
import CatalogItemPicker from '../../catalog/CatalogItemPicker';
import CatalogEnrichButton from '../../catalog/CatalogEnrichButton';
import PolishButton from '../../catalog/PolishButton';
import DistributorLookup from './DistributorLookup';
import Pax8ProductLookup from './Pax8ProductLookup';
import {
  type QuoteBlock,
  type QuoteLine,
  type QuoteLineRecurrence,
  formatMoney,
} from './quoteTypes';
import { type LineUpdate, SrSaved, fieldRing, seamless } from './quoteEditorShared';
import { GhostRow, EditableLineRow, ReadonlyLineRow } from './QuoteLineRows';
import { ContractBlockEditor } from './QuoteContractBlockEditor';

// ── A single block, with an inline line builder when it is a pricing table ──
export function BlockCard({
  block, quoteId, lines, currency, taxRate, catalog, catalogLoadFailed, isPending, canWrite, showInternal, depositSelectMode, ecActive, pax8Active, defaultMarkupPct, onAddCatalog, onImportAddDistributor, onImportAddPax8, onAddManual, onEditLine, onEditBlock, onMoveLine, onRemoveLine, onLineDraft,
  moveTargets, onMoveLineToBlock,
}: {
  block: QuoteBlock;
  quoteId: string;
  lines: QuoteLine[];
  currency: string;
  taxRate: string | null;
  catalog: CatalogItem[];
  catalogLoadFailed: boolean;
  isPending: (key: string) => boolean;
  canWrite: boolean;
  showInternal: boolean;
  /** When true (quote deposit = 'selected_lines'), each editable line row shows a
   *  deposit-eligible checkbox. */
  depositSelectMode: boolean;
  ecActive: boolean;
  pax8Active: boolean;
  /** Partner default markup % for pre-pricing AI auto-filled lines; null = unknown. */
  defaultMarkupPct: number | null;
  onAddCatalog: (blockId: string, item: CatalogItem) => void;
  onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void;
  onImportAddPax8: (blockId: string, product: Pax8Product, term: Pax8PriceOption, sellPrice: number) => void;
  onAddManual: (
    blockId: string,
    form: { name: string; description: string; quantity: string; unitPrice: string; cost: string; sku: string; partNumber: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => Promise<boolean>;
  onEditLine: (lineId: string, body: LineUpdate, scopeKey?: string) => Promise<boolean>;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
  onMoveLine: (line: QuoteLine, direction: 'up' | 'down') => void;
  onRemoveLine: (line: QuoteLine) => void;
  onLineDraft: (lineId: string, draft: QuoteLineForMath | null) => void;
  /** Other pricing panels this block's lines can move to (empty → control hidden). */
  moveTargets: { id: string; label: string }[];
  onMoveLineToBlock: (line: QuoteLine, targetBlockId: string) => void;
}) {
  const { t } = useTranslation('billing');
  // Pending state scoped to this block: editing/removing this block, or adding a
  // line to it, never disables anything in a sibling block.
  const blockBusy = isPending(`block:${block.id}`);
  const addLineBusy = isPending(`add-line:${block.id}`);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [mode, setMode] = useState<'catalog' | 'manual' | 'distributor' | 'pax8'>('catalog');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('0.00');
  const [cost, setCost] = useState('');
  const [markup, setMarkup] = useState('');
  const [sku, setSku] = useState('');
  const [partNumber, setPartNumber] = useState('');
  const [taxable, setTaxable] = useState(false);
  const [recurrence, setRecurrence] = useState<QuoteLineRecurrence>('one_time');
  const [saveToCatalog, setSaveToCatalog] = useState(false);
  // What the last auto-fill touched, for the "Auto-filled: …" summary line.
  // Cleared when the form resets (successful add) or a new query starts.
  const [autoFilled, setAutoFilled] = useState<string[] | null>(null);

  // Two-way price ↔ markup% coupling (cost is always an input, never derived).
  // Whichever of price/markup the user set last stays authoritative: editing it
  // recomputes the other, and a later cost edit recomputes the derived one.
  const priceAuthority = useRef<'price' | 'markup'>('price');
  // Live mirrors for the enrich onApply callback: the web lookup takes seconds,
  // so the closure's cost/price are stale by the time the result lands — the
  // pristine-field checks must read the CURRENT values or auto-fill could
  // overwrite a number the user typed mid-search.
  const costRef = useRef(cost); costRef.current = cost;
  const priceRef = useRef(price); priceRef.current = price;
  const deriveMarkup = (nextPrice: string, nextCost: string) => {
    // A zero/empty price is the form's pristine state, not a -100% pricing
    // decision — show no markup rather than a misleading negative.
    if (nextPrice.trim() === '' || Number(nextPrice) === 0) { setMarkup(''); return; }
    const mk = markupPct(nextPrice, nextCost);
    setMarkup(mk === null ? '' : String(Number(mk.toFixed(2))));
  };
  const derivePrice = (nextMarkup: string, nextCost: string) => {
    const m = Number(nextMarkup);
    if (nextCost.trim() === '' || nextMarkup.trim() === '' || !Number.isFinite(m) || Number(nextCost) <= 0) return;
    setPrice(priceFromMarkup(nextCost, m));
  };
  const onPriceChange = (v: string) => {
    setPrice(v);
    priceAuthority.current = 'price';
    deriveMarkup(v, cost);
  };
  const onMarkupChange = (v: string) => {
    setMarkup(v);
    priceAuthority.current = 'markup';
    derivePrice(v, cost);
  };
  const onCostChange = (v: string) => {
    setCost(v);
    if (priceAuthority.current === 'markup') derivePrice(markup, v);
    else deriveMarkup(price, v);
  };

  const isTable = block.blockType === 'line_items';
  const heading = (block.content?.text as string | undefined) ?? '';
  const html = (block.content?.html as string | undefined) ?? '';
  const tableLabel = (block.content?.label as string | undefined) ?? '';
  const showSubtotal = (block.content?.showSubtotal as boolean | undefined) === true;
  const imageId = (block.content?.imageId as string | undefined) ?? '';
  const imageCaption = (block.content?.caption as string | undefined) ?? '';

  // Inline drafts for editable block content; resync if the persisted value
  // changes (e.g. after a refresh) so server normalization wins.
  const [headingDraft, setHeadingDraft] = useState(heading);
  const [richDraft, setRichDraft] = useState(html);
  const [labelDraft, setLabelDraft] = useState(tableLabel);
  // Resync drafts from the server only when the user hasn't diverged from what we
  // last showed. A quiet reload (fired by an unrelated inline edit elsewhere) must
  // not clobber heading/rich text this user is mid-edit in: if the local draft no
  // longer matches the prop we last synced, the user has typed — keep their text.
  const lastHeading = useRef(heading);
  const lastHtml = useRef(html);
  const lastLabel = useRef(tableLabel);
  // Set right after our own rich_text save so the next html-prop resync adopts
  // the server-normalized body unconditionally (see commitRich).
  const forceRichResync = useRef(false);
  useEffect(() => {
    setHeadingDraft((cur) => (cur === lastHeading.current ? heading : cur));
    lastHeading.current = heading;
  }, [heading]);
  useEffect(() => {
    setRichDraft((cur) => (forceRichResync.current || cur === lastHtml.current ? html : cur));
    forceRichResync.current = false;
    lastHtml.current = html;
  }, [html]);
  useEffect(() => {
    setLabelDraft((cur) => (cur === lastLabel.current ? tableLabel : cur));
    lastLabel.current = tableLabel;
  }, [tableLabel]);

  // Quiet "Saved" flash for inline content edits (replaces the old per-edit
  // success toast). Cleared on unmount so a late timer can't setState a gone row.
  const [blockSaved, setBlockSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flashSaved = useCallback(() => {
    setBlockSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setBlockSaved(false), 1500);
  }, []);

  const commitHeading = async () => {
    const text = headingDraft.trim();
    if (!text || text === heading) { setHeadingDraft(heading); return; }
    if (await onEditBlock(block, { text, level: (block.content?.level as number | undefined) ?? 2 })) flashSaved();
  };
  const commitRich = async () => {
    if (richDraft === html) return;
    if (await onEditBlock(block, { html: richDraft })) {
      // The server sanitizes the body on write (rel/attribute normalization), so
      // the reloaded html prop is the source of truth. Force the next resync to
      // adopt it — otherwise a residual TipTap-vs-sanitizer string mismatch would
      // keep the block flagged "unsaved" and re-PATCH on every blur. Mirrors the
      // force-reseed TemplateEditor uses after saveDraft.
      forceRichResync.current = true;
      flashSaved();
    }
  };
  // Rename a pricing table. An empty label is a valid clear (the document falls
  // back to its "Pricing" default), so — unlike heading — we commit the trimmed
  // value even when blank, only skipping when nothing actually changed.
  // Both the label and the subtotal toggle live in the SAME line_items content
  // object, and onEditBlock REPLACES content wholesale — so each edit must carry
  // the other's current value forward or it gets dropped.
  const lineItemsContent = (nextLabel: string, nextSubtotal: boolean) => ({
    ...(nextLabel.trim() ? { label: nextLabel.trim() } : {}),
    ...(nextSubtotal ? { showSubtotal: true } : {}),
  });
  const commitLabel = async () => {
    const label = labelDraft.trim();
    if (label === tableLabel.trim()) { setLabelDraft(tableLabel); return; }
    if (await onEditBlock(block, lineItemsContent(label, showSubtotal))) flashSaved();
  };
  const toggleSubtotal = async (next: boolean) => {
    if (await onEditBlock(block, lineItemsContent(tableLabel, next))) flashSaved();
  };

  // Inline errors for the manual-line form's qty/price/cost — same contract as
  // the edit-row fields (aria-invalid + destructive ring + text under the input).
  // The parent's addManual gates stay as a backstop, but validating here means
  // the message lands next to the field, not in a bottom-corner toast.
  const [manualErrors, setManualErrors] = useState<{ qty?: string; price?: string; cost?: string }>({});
  const clearManualError = (field: 'qty' | 'price' | 'cost') =>
    setManualErrors((e) => { if (!(field in e)) return e; const n = { ...e }; delete n[field]; return n; });

  const submitManual = async () => {
    const errs: { qty?: string; price?: string; cost?: string } = {};
    const qtyNum = Number(qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || !Number.isInteger(qtyNum)) errs.qty = t('quotes.editor.errors.quantityWholeGreaterThanZero');
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) errs.price = t('quotes.editor.errors.unitPriceZeroOrMore');
    if (cost.trim() !== '' && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) errs.cost = t('quotes.editor.errors.costZeroOrMore');
    setManualErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const ok = await onAddManual(block.id, { name, description: desc, quantity: qty, unitPrice: price, cost, sku, partNumber, taxable, recurrence, saveToCatalog });
    // Only clear the form on success, so a rejected add (e.g. qty 0) keeps the
    // user's input to correct rather than wiping it.
    if (ok) {
      setName(''); setDesc(''); setQty('1'); setPrice('0.00'); setCost(''); setMarkup(''); setSku(''); setPartNumber('');
      setTaxable(false); setRecurrence('one_time'); setSaveToCatalog(false); setAutoFilled(null);
      priceAuthority.current = 'price';
    }
  };

  return (
    <section data-testid={`quote-block-${block.id}`}>
      {/* No card chrome, no uppercase type-label bar: on the canvas a block IS
          its content (a heading looks like a heading, a table like a table).
          The type is self-evident; arrangement lives in the gutter controls. */}
      <SrSaved show={blockSaved} testId={`quote-block-saved-${block.id}`} />
      <div>
        {block.blockType === 'heading' && (
          canWrite ? (
            <input
              value={headingDraft}
              aria-label={t('quotes.editor.addSection.headingPlaceholder')}
              onChange={(e) => setHeadingDraft(e.target.value)}
              onBlur={() => void commitHeading()}
              disabled={blockBusy}
              data-testid={`quote-block-heading-input-${block.id}`}
              className={`w-full rounded-md border bg-transparent px-2 py-1 text-lg font-semibold transition-colors focus:outline-hidden disabled:opacity-60 ${seamless(fieldRing(headingDraft.trim() !== heading, blockSaved))}`}
            />
          ) : (
            <p className="text-lg font-semibold" data-testid={`quote-block-heading-content-${block.id}`}>{heading}</p>
          )
        )}
        {block.blockType === 'rich_text' && (
          canWrite ? (
            // The editor commits on blur (same as the old textarea). React's
            // onBlur fires on focusout of the contenteditable; toolbar buttons
            // preventDefault their mousedown so clicking them never blurs the
            // editor and never triggers a spurious commit.
            <div
              onBlur={() => void commitRich()}
              data-testid={`quote-block-rich-input-${block.id}`}
              className={`rounded-md transition-shadow ${fieldRing(richDraft !== html, blockSaved)}`}
            >
              <RichTextEditor
                value={richDraft}
                onChange={setRichDraft}
                ariaLabel={t('quotes.editor.block.richTextContentAria')}
                testId={`quote-block-rich-editor-${block.id}`}
              />
            </div>
          ) : (
            // Read-only (no write permission): the API sanitizes every rich_text
            // block to the fixed p/br/strong/em/u/h3/h4/ul/ol/li/a allowlist on
            // read serialization (richTextSanitize.ts), so rendering it as real
            // HTML here is safe — same pattern as QuoteDocument.
            <div
              className="quote-rich-text prose prose-sm max-w-none text-sm text-foreground dark:prose-invert"
              data-testid={`quote-block-rich-content-${block.id}`}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )
        )}
        {block.blockType === 'image' && (
          imageId ? (
            <figure className="space-y-1" data-testid={`quote-block-image-content-${block.id}`}>
              <QuoteImagePreview quoteId={quoteId} imageId={imageId} caption={imageCaption} />
              {imageCaption && <figcaption className="text-xs text-muted-foreground">{imageCaption}</figcaption>}
            </figure>
          ) : (
            <p className="text-sm text-muted-foreground">{t('quotes.editor.block.imageSectionPdf')}</p>
          )
        )}

        {block.blockType === 'contract' && (
          <ContractBlockEditor block={block} canWrite={canWrite} onEditBlock={onEditBlock} />
        )}

        {isTable && (
          <div className="space-y-3">
            {canWrite && (
              <input
                type="text"
                value={labelDraft}
                aria-label={t('quotes.editor.table.labelAria')}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={() => void commitLabel()}
                disabled={blockBusy}
                placeholder={t('quotes.editor.table.labelPlaceholder')}
                data-testid={`quote-block-table-label-input-${block.id}`}
                className={`h-9 w-full rounded-md border bg-transparent px-2 text-sm font-semibold transition-colors focus:outline-hidden disabled:opacity-60 ${seamless(fieldRing(labelDraft.trim() !== tableLabel.trim(), blockSaved))}`}
              />
            )}
            {canWrite && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showSubtotal}
                  onChange={(e) => void toggleSubtotal(e.target.checked)}
                  disabled={blockBusy}
                  data-testid={`quote-block-subtotal-toggle-${block.id}`}
                />
                {t('quotes.editor.table.showSubtotal')}
              </label>
            )}
            {/* Four data columns (Item flexes, Qty/Price/Total are content-sized) so
                the per-line Total — the most-checked figure on a quote — is always
                visible without sideways scrolling at desktop widths. Billing cadence
                rides in the Price cell; Taxable moved to each line's controls row;
                per-line tax renders as a sub-line under the Total. The wrapper still
                scrolls on genuinely narrow screens (phone), without a sticky column. */}
            <div className="overflow-x-auto rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label={t('quotes.editor.table.scrollAria')} tabIndex={0}>
            <table className="w-full min-w-[36rem] text-sm" data-testid={`quote-block-lines-${block.id}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="min-w-[12rem] px-1.5 py-2 font-medium">{t('quotes.editor.table.item')}</th>
                  <th className="px-1.5 py-2 text-right font-medium">{t('quotes.editor.table.qty')}</th>
                  <th className="px-1.5 py-2 text-right font-medium">{t('quotes.editor.table.unitPrice')}</th>
                  <th className="px-1.5 py-2 text-right font-medium">{t('quotes.editor.table.total')}</th>
                  {canWrite && <th className="px-1.5 py-2" />}
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && !canWrite ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-6 text-center text-sm text-muted-foreground">
                      {t('quotes.editor.table.emptyLines')}
                    </td>
                  </tr>
                ) : (
                  lines.map((l, idx) =>
                    canWrite ? (
                      <EditableLineRow
                        key={l.id}
                        line={l}
                        quoteId={quoteId}
                        currency={currency}
                        taxRate={taxRate}
                        isPending={isPending}
                        isFirst={idx === 0}
                        isLast={idx === lines.length - 1}
                        showInternal={showInternal}
                        depositSelectMode={depositSelectMode}
                        onEdit={onEditLine}
                        onMove={onMoveLine}
                        onRemove={onRemoveLine}
                        onDraft={onLineDraft}
                        moveTargets={moveTargets}
                        onMoveTo={onMoveLineToBlock}
                      />
                    ) : (
                      <ReadonlyLineRow key={l.id} line={l} quoteId={quoteId} currency={currency} taxRate={taxRate} isFirst={idx === 0} showInternal={showInternal} />
                    ),
                  )
                )}
                {/* Ghost row: the fast lane for manual entry — always ready at
                    the table foot, Enter commits and refocuses for the next. */}
                {canWrite && (
                  <GhostRow
                    blockId={block.id}
                    busy={addLineBusy}
                    onAdd={(form) => onAddManual(block.id, form)}
                    colSpan={5}
                  />
                )}
              </tbody>
            </table>
            </div>

            {/* The full add-line picker (catalog / AI lookup / distributor /
                SKU + cost fields) collapses behind a disclosure — the ghost row
                covers the fast manual path, so this chrome only renders when a
                tech asks for the heavier modes. */}
            {canWrite && (
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                aria-expanded={pickerOpen}
                data-testid={`quote-block-add-line-toggle-${block.id}`}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-xs font-medium text-muted-foreground hover:border-border hover:text-foreground"
              >
                <span aria-hidden="true">{pickerOpen ? '−' : '+'}</span> {t('quotes.editor.addLine.moreWays')}
              </button>
            )}
            {canWrite && pickerOpen && (
            <div className="mt-1 rounded-md border bg-background/40 p-4" data-testid={`quote-block-add-line-${block.id}`}>
              <div className="mb-3 flex gap-2">
                {(['catalog', 'manual', ...(ecActive ? ['distributor'] as const : []), ...(pax8Active ? ['pax8'] as const : [])] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    data-testid={`quote-line-mode-${block.id}-${m}`}
                    className={`rounded-md border px-3 py-1 text-xs font-medium ${
                      mode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                    }`}
                  >
                    {m === 'catalog'
                      ? t('quotes.editor.addLine.catalogItem')
                      : m === 'manual'
                        ? t('quotes.editor.addLine.manualLine')
                        : m === 'distributor'
                          ? t('quotes.editor.addLine.searchDistributor')
                          : t('quotes.editor.addLine.searchPax8')}
                  </button>
                ))}
              </div>

              {mode === 'distributor' ? (
                <DistributorLookup
                  blockId={block.id}
                  busy={addLineBusy}
                  onImportAdd={(product, sellPrice) => onImportAddDistributor(block.id, product, sellPrice)}
                />
              ) : mode === 'pax8' ? (
                <Pax8ProductLookup
                  blockId={block.id}
                  busy={addLineBusy}
                  onImportAdd={(product, term, sellPrice) => onImportAddPax8(block.id, product, term, sellPrice)}
                />
              ) : mode === 'catalog' ? (
                catalog.length === 0 ? (
                  catalogLoadFailed ? (
                    <p className="text-xs text-muted-foreground" data-testid={`quote-catalog-error-${block.id}`}>
                      {t('quotes.editor.catalog.loadError')}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground" data-testid={`quote-catalog-empty-${block.id}`}>
                      {t('quotes.editor.catalog.empty')}{' '}
                      <a href="/settings/catalog" className="underline hover:text-foreground">{t('quotes.editor.catalog.addSome')}</a>.
                    </p>
                  )
                ) : (
                  <CatalogItemPicker
                    items={catalog}
                    includeBundles={false}
                    onSelect={(it) => onAddCatalog(block.id, it)}
                    testId={`quote-catalog-picker-${block.id}`}
                    placeholder={t('quotes.editor.catalog.searchPlaceholder')}
                    disabled={addLineBusy}
                  />
                )
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <CatalogEnrichButton
                      idSuffix={`quote-${block.id}`}
                      helpText={
                        defaultMarkupPct != null
                          ? t('quotes.editor.autoFill.helpWithDefaultMarkup', { markup: String(Number(defaultMarkupPct)) })
                          : t('quotes.editor.autoFill.help')
                      }
                      guidanceSuffix={null}
                      onApply={(result) => {
                        const d = result.draft;
                        setName(d.name);
                        setDesc(d.description ?? '');
                        setTaxable(d.taxable);
                        const filled = [
                          t('quotes.editor.autoFill.filledName'),
                          t('quotes.editor.autoFill.filledDescription'),
                          d.taxable ? t('quotes.editor.autoFill.filledTaxableOn') : t('quotes.editor.autoFill.filledTaxableOff'),
                        ];
                        // Pre-fill cost/price only into untouched fields — auto-fill
                        // must never overwrite a number the user already typed (read
                        // the refs: the lookup takes seconds and state may have moved).
                        if (result.estimatedCost != null && costRef.current.trim() === '') {
                          const c = result.estimatedCost.toFixed(2);
                          setCost(c);
                          filled.push(t('quotes.editor.autoFill.filledEstimatedCost', { amount: formatMoney(Number(c), currency) }));
                          if (defaultMarkupPct != null && (priceRef.current.trim() === '' || Number(priceRef.current) === 0)) {
                            const p = priceFromMarkup(c, defaultMarkupPct);
                            setPrice(p);
                            setMarkup(String(Number(defaultMarkupPct)));
                            priceAuthority.current = 'markup';
                            filled.push(t('quotes.editor.autoFill.filledPriceWithDefaultMarkup', { amount: formatMoney(Number(p), currency), markup: String(Number(defaultMarkupPct)) }));
                          }
                        }
                        setAutoFilled(filled);
                      }}
                    />
                    {(name.trim() || desc.trim()) && (
                      <PolishButton
                        idSuffix={`quote-manual-${block.id}`}
                        getText={() => ({ name, description: desc })}
                        onApply={(r) => {
                          if (r.name !== null) setName(r.name);
                          if (r.description !== null) setDesc(r.description);
                        }}
                      />
                    )}
                  </div>
                  {/* What the last auto-fill actually touched — the AI applies
                      directly to the form, so the user must be told what changed. */}
                  {autoFilled && (
                    <p role="status" data-testid={`quote-manual-autofilled-${block.id}`} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{t('quotes.editor.autoFill.label')}</span> {autoFilled.join(' · ')}. {t('quotes.editor.autoFill.review')}
                    </p>
                  )}
                  <input
                    type="text" placeholder={t('quotes.editor.line.namePlaceholder')} aria-label={t('quotes.editor.line.nameAria')} value={name}
                    onChange={(e) => setName(e.target.value)}
                    data-testid={`quote-manual-name-${block.id}`}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_70px_90px_110px]">
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.line.descriptionOptional')}</span>
                      <textarea
                        value={desc}
                        onChange={(e) => setDesc(e.target.value)}
                        rows={2}
                        data-testid={`quote-manual-desc-${block.id}`}
                        className="min-h-9 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.table.qty')}</span>
                      <input
                        type="number" min="1" step="1" value={qty}
                        onChange={(e) => { setQty(e.target.value); clearManualError('qty'); }}
                        aria-invalid={manualErrors.qty ? true : undefined}
                        aria-describedby={manualErrors.qty ? `quote-manual-qty-error-${block.id}` : undefined}
                        data-testid={`quote-manual-qty-${block.id}`}
                        className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring ${manualErrors.qty ? 'border-destructive' : ''}`}
                      />
                      {manualErrors.qty && (
                        <span id={`quote-manual-qty-error-${block.id}`} className="mt-0.5 block text-xs text-destructive" data-testid={`quote-manual-qty-error-${block.id}`}>
                          {manualErrors.qty}
                        </span>
                      )}
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.table.unitPrice')}</span>
                      <input
                        type="number" min="0" step="0.01" value={price}
                        onChange={(e) => { onPriceChange(e.target.value); clearManualError('price'); }}
                        aria-invalid={manualErrors.price ? true : undefined}
                        aria-describedby={manualErrors.price ? `quote-manual-price-error-${block.id}` : undefined}
                        data-testid={`quote-manual-price-${block.id}`}
                        className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring ${manualErrors.price ? 'border-destructive' : ''}`}
                      />
                      {manualErrors.price && (
                        <span id={`quote-manual-price-error-${block.id}`} className="mt-0.5 block text-xs text-destructive" data-testid={`quote-manual-price-error-${block.id}`}>
                          {manualErrors.price}
                        </span>
                      )}
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.line.billing')}</span>
                      <select
                        value={recurrence}
                        onChange={(e) => setRecurrence(e.target.value as QuoteLineRecurrence)}
                        data-testid={`quote-manual-recurrence-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      >
                        <option value="one_time">{t('quotes.editor.recurrence.one_time')}</option>
                        <option value="monthly">{t('quotes.editor.recurrence.monthly')}</option>
                        <option value="annual">{t('quotes.editor.recurrence.annual')}</option>
                      </select>
                    </label>
                  </div>
                  {/* Internal-only cost & identity fields (never shown to the customer).
                      Divider + top padding sets them apart from the customer-facing
                      fields above so the two groups don't read as one dense block. */}
                  <p className="mt-1 border-t pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('quotes.editor.internal.full')}</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_110px_100px]">
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.line.skuOptional')}</span>
                      <input
                        type="text" value={sku}
                        onChange={(e) => setSku(e.target.value)}
                        data-testid={`quote-manual-sku-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.line.partNumberOptional')}</span>
                      <input
                        type="text" value={partNumber}
                        onChange={(e) => setPartNumber(e.target.value)}
                        data-testid={`quote-manual-partnumber-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.line.unitCost')}</span>
                      <input
                        type="number" min="0" step="0.01" value={cost}
                        onChange={(e) => { onCostChange(e.target.value); clearManualError('cost'); }}
                        aria-invalid={manualErrors.cost ? true : undefined}
                        aria-describedby={manualErrors.cost ? `quote-manual-cost-error-${block.id}` : undefined}
                        data-testid={`quote-manual-cost-${block.id}`}
                        className={`h-9 w-full rounded-md border bg-background px-3 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring ${manualErrors.cost ? 'border-destructive' : ''}`}
                      />
                      {manualErrors.cost && (
                        <span id={`quote-manual-cost-error-${block.id}`} className="mt-0.5 block text-xs text-destructive" data-testid={`quote-manual-cost-error-${block.id}`}>
                          {manualErrors.cost}
                        </span>
                      )}
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.line.markupPercent')}</span>
                      <input
                        type="number" step="0.1" value={markup}
                        onChange={(e) => onMarkupChange(e.target.value)}
                        disabled={cost.trim() === ''}
                        // Sighted users can see the empty cost field; AT users can't —
                        // mirror the edit-row band's disabled-reason wiring.
                        title={cost.trim() === '' ? t('quotes.editor.line.enterCostFirstMarkup') : undefined}
                        aria-describedby={cost.trim() === '' ? `quote-manual-markup-hint-${block.id}` : undefined}
                        data-testid={`quote-manual-markup-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                      />
                      {cost.trim() === '' && <span id={`quote-manual-markup-hint-${block.id}`} className="sr-only">{t('quotes.editor.line.enterCostFirstMarkupSentence')}</span>}
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} data-testid={`quote-manual-taxable-${block.id}`} />
                        {t('quotes.editor.table.taxable')}
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={saveToCatalog} onChange={(e) => setSaveToCatalog(e.target.checked)} data-testid={`quote-manual-save-catalog-${block.id}`} />
                        {t('quotes.editor.line.saveToCatalog')}
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => void submitManual()}
                      // A line needs a name OR a description (mirrors the API + addManual
                      // refine). Gating on description alone silently blocked valid
                      // name-only lines like a titled SKU with no prose.
                      disabled={addLineBusy || (!name.trim() && !desc.trim())}
                      aria-busy={addLineBusy}
                      data-testid={`quote-manual-add-${block.id}`}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {addLineBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                      {addLineBusy ? t('quotes.editor.actions.adding') : t('quotes.editor.actions.addLine')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// Editor image preview. GET /quotes/:id/images/:imageId requires the Bearer auth
// header, so a bare <img src> would 401 (web-1). Mirror QuoteWorkspace's PDF
// preview: fetchWithAuth → blob → object URL, revoked on unmount/change.
export function QuoteImagePreview({ quoteId, imageId, caption }: { quoteId: string; imageId: string; caption?: string }) {
  const { t } = useTranslation('billing');
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(quoteImageUrl(quoteId, imageId));
        if (!res.ok) { if (!cancelled) setFailed(true); return; }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = window.URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; if (objectUrl) window.URL.revokeObjectURL(objectUrl); };
  }, [quoteId, imageId]);

  if (failed) return <p className="text-sm text-muted-foreground">{t('quotes.editor.image.previewUnavailable')}</p>;
  if (!url) return <div className="h-24 w-full animate-pulse rounded border bg-muted" data-testid="quote-image-loading" />;
  return <img src={url} alt={caption || t('quotes.editor.image.alt')} className="max-h-64 rounded border" />;
}
