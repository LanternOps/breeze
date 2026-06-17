import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import {
  addBlock,
  deleteBlock,
  addManualLine,
  addCatalogLine,
  removeLine,
} from '../../../lib/api/quotes';
import { listCatalog, createCatalogItem, type CatalogItem } from '../../../lib/api/catalog';
import CatalogItemPicker from '../../catalog/CatalogItemPicker';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  type QuoteLineRecurrence,
  formatMoney,
  formatRecurrence,
} from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

// Phase 1: only these three block kinds are offered. The schema + PDF renderer
// support `image`, but there is no image-upload endpoint yet (Phase 2), so the
// add-block menu intentionally does NOT expose it.
type AddableBlockType = 'heading' | 'rich_text' | 'line_items';
const ADD_BLOCK_OPTIONS: { value: AddableBlockType; label: string }[] = [
  { value: 'heading', label: 'Heading' },
  { value: 'rich_text', label: 'Rich text' },
  { value: 'line_items', label: 'Pricing table' },
];

const BLOCK_TYPE_LABELS: Record<string, string> = {
  heading: 'Heading',
  rich_text: 'Rich text',
  image: 'Image',
  line_items: 'Pricing table',
};

interface Props {
  detail: QuoteDetailData;
  onChanged: () => void;
}

export default function QuoteEditor({ detail, onChanged }: Props) {
  const { can } = usePermissions();
  const canWrite = can('quotes', 'write');
  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;

  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);

  // ---- add-block form ------------------------------------------------------
  const [addType, setAddType] = useState<AddableBlockType>('heading');
  const [headingText, setHeadingText] = useState('');
  const [richText, setRichText] = useState('');
  const [tableLabel, setTableLabel] = useState('');

  const refresh = useCallback(() => onChanged(), [onChanged]);

  const loadCatalog = useCallback(async () => {
    const res = await listCatalog({ isActive: true, limit: 200 });
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) return; // catalog is optional context; don't block the editor
    const body = (await res.json().catch(() => null)) as { data?: CatalogItem[] } | null;
    if (!body) return;
    setCatalog((body.data ?? []).filter((i) => !i.isBundle));
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const sortedBlocks = useMemo(
    () => [...blocks].sort((a, b) => a.sortOrder - b.sortOrder),
    [blocks],
  );

  const linesForBlock = useCallback(
    (blockId: string) =>
      lines
        .filter((l) => l.blockId === blockId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [lines],
  );

  // ---- add block -----------------------------------------------------------
  const submitBlock = useCallback(async () => {
    if (busy) return;
    let body;
    if (addType === 'heading') {
      if (!headingText.trim()) return;
      body = { blockType: 'heading' as const, content: { text: headingText.trim(), level: 2 } };
    } else if (addType === 'rich_text') {
      if (!richText.trim()) return;
      body = { blockType: 'rich_text' as const, content: { html: richText } };
    } else {
      body = {
        blockType: 'line_items' as const,
        content: tableLabel.trim() ? { label: tableLabel.trim() } : {},
      };
    }
    setBusy(true);
    try {
      await runAction({
        request: () => addBlock(quote.id, body),
        errorFallback: 'Could not add the block.',
        successMessage: 'Block added',
        onUnauthorized: UNAUTHORIZED,
      });
      setHeadingText(''); setRichText(''); setTableLabel('');
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not add the block.');
    } finally {
      setBusy(false);
    }
  }, [busy, addType, headingText, richText, tableLabel, quote.id, refresh]);

  // Real block delete: removes the block and (server-side) any lines attached to
  // it. Works for every block type — heading, rich_text, and line_items — so the
  // "Remove" button is no longer a silent no-op for heading/rich_text blocks.
  const removeBlock = useCallback(async (block: QuoteBlock) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => deleteBlock(quote.id, block.id),
        errorFallback: 'Could not remove the block.',
        successMessage: 'Block removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not remove the block.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, refresh]);

  // ---- line mutations (scoped to a line_items block) ----------------------
  const addCatalog = useCallback(async (blockId: string, item: CatalogItem) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => addCatalogLine(quote.id, { catalogItemId: item.id, quantity: 1, blockId }),
        errorFallback: 'Could not add the catalog item.',
        successMessage: 'Item added',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not add the catalog item.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, refresh]);

  const addManual = useCallback(async (
    blockId: string,
    form: { description: string; quantity: string; unitPrice: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => {
    if (busy || !form.description.trim()) return;
    setBusy(true);
    try {
      await runAction({
        request: () => addManualLine(quote.id, {
          sourceType: 'manual',
          blockId,
          description: form.description.trim(),
          quantity: Number(form.quantity),
          unitPrice: Number(form.unitPrice),
          taxable: form.taxable,
          customerVisible: true,
          recurrence: form.recurrence,
        }),
        errorFallback: 'Could not add the line.',
        successMessage: 'Line added',
        onUnauthorized: UNAUTHORIZED,
      });
      // Optionally persist the manual line to the product catalog for reuse.
      if (form.saveToCatalog) {
        await runAction({
          request: () => createCatalogItem({
            itemType: 'service',
            name: form.description.trim(),
            billingType: form.recurrence === 'one_time' ? 'one_time' : 'recurring',
            billingFrequency: form.recurrence === 'monthly'
              ? 'monthly'
              : form.recurrence === 'annual'
                ? 'annual'
                : null,
            unitPrice: Number(form.unitPrice),
            taxable: form.taxable,
          }),
          errorFallback: 'Line added, but saving it to the catalog failed.',
          successMessage: 'Saved to catalog',
          onUnauthorized: UNAUTHORIZED,
        });
        void loadCatalog();
      }
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not add the line.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, refresh, loadCatalog]);

  const deleteLine = useCallback(async (lineId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => removeLine(quote.id, lineId),
        errorFallback: 'Could not remove the line.',
        successMessage: 'Line removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not remove the line.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, refresh]);

  const hasRecurring =
    Number(quote.monthlyRecurringTotal) > 0 || Number(quote.annualRecurringTotal) > 0;

  return (
    <div className="space-y-6" data-testid="quote-editor">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── blocks ─────────────────────────────────────────────────── */}
        <div className="space-y-4">
          {sortedBlocks.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground" data-testid="quote-blocks-empty">
              No content yet. Add a heading, rich text, or a pricing table below.
            </div>
          ) : (
            sortedBlocks.map((block) => (
              <BlockCard
                key={block.id}
                block={block}
                lines={linesForBlock(block.id)}
                currency={currency}
                catalog={catalog}
                busy={busy}
                canWrite={canWrite}
                onAddCatalog={addCatalog}
                onAddManual={addManual}
                onRemoveLine={deleteLine}
                onRemoveBlock={removeBlock}
              />
            ))
          )}

          {/* Add block */}
          {canWrite && (
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-add-block">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add block</h3>
            <div className="mb-3 flex flex-wrap gap-2">
              {ADD_BLOCK_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setAddType(o.value)}
                  data-testid={`quote-add-block-type-${o.value}`}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                    addType === o.value ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {addType === 'heading' && (
              <input
                type="text"
                value={headingText}
                onChange={(e) => setHeadingText(e.target.value)}
                placeholder="Heading text"
                data-testid="quote-block-heading-text"
                className="mb-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
            {addType === 'rich_text' && (
              <textarea
                value={richText}
                onChange={(e) => setRichText(e.target.value)}
                placeholder="Proposal text…"
                rows={4}
                data-testid="quote-block-rich-text"
                className="mb-3 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
            {addType === 'line_items' && (
              <input
                type="text"
                value={tableLabel}
                onChange={(e) => setTableLabel(e.target.value)}
                placeholder="Table label (optional, e.g. Monthly services)"
                data-testid="quote-block-table-label"
                className="mb-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void submitBlock()}
                disabled={
                  busy ||
                  (addType === 'heading' && !headingText.trim()) ||
                  (addType === 'rich_text' && !richText.trim())
                }
                data-testid="quote-add-block-submit"
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                Add block
              </button>
            </div>
          </div>
          )}
        </div>

        {/* ── live totals ────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-live-totals">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live totals</h3>
            <dl className="space-y-2 text-sm tabular-nums">
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">One-time</dt>
                <dd data-testid="quote-total-onetime">{formatMoney(quote.oneTimeTotal, currency)}</dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">Monthly recurring</dt>
                <dd data-testid="quote-total-monthly">{formatMoney(quote.monthlyRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/mo</span></dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">Annual recurring</dt>
                <dd data-testid="quote-total-annual">{formatMoney(quote.annualRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/yr</span></dd>
              </div>
              {Number(quote.taxTotal) > 0 && (
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">Tax</dt>
                  <dd>{formatMoney(quote.taxTotal, currency)}</dd>
                </div>
              )}
            </dl>
            <div className="mt-3 flex items-end justify-between border-t pt-3">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">First-invoice total</span>
              <span className="text-2xl font-semibold tabular-nums" data-testid="quote-total-first-invoice">
                {formatMoney(quote.total, currency)}
              </span>
            </div>
            {hasRecurring && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="quote-totals-recurring-hint">
                First-invoice total combines one-time charges with the first period of each recurring cadence (monthly + annual).
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── A single block, with an inline line builder when it is a pricing table ──
function BlockCard({
  block, lines, currency, catalog, busy, canWrite, onAddCatalog, onAddManual, onRemoveLine, onRemoveBlock,
}: {
  block: QuoteBlock;
  lines: QuoteLine[];
  currency: string;
  catalog: CatalogItem[];
  busy: boolean;
  canWrite: boolean;
  onAddCatalog: (blockId: string, item: CatalogItem) => void;
  onAddManual: (
    blockId: string,
    form: { description: string; quantity: string; unitPrice: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => void;
  onRemoveLine: (lineId: string) => void;
  onRemoveBlock: (block: QuoteBlock) => void;
}) {
  const [mode, setMode] = useState<'catalog' | 'manual'>('catalog');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('0.00');
  const [taxable, setTaxable] = useState(false);
  const [recurrence, setRecurrence] = useState<QuoteLineRecurrence>('one_time');
  const [saveToCatalog, setSaveToCatalog] = useState(false);

  const isTable = block.blockType === 'line_items';
  const heading = (block.content?.text as string | undefined) ?? '';
  const html = (block.content?.html as string | undefined) ?? '';
  const tableLabel = (block.content?.label as string | undefined) ?? '';

  const submitManual = () => {
    onAddManual(block.id, { description: desc, quantity: qty, unitPrice: price, taxable, recurrence, saveToCatalog });
    setDesc(''); setQty('1'); setPrice('0.00'); setTaxable(false); setRecurrence('one_time'); setSaveToCatalog(false);
  };

  return (
    <div className="rounded-lg border bg-card shadow-sm" data-testid={`quote-block-${block.id}`}>
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {BLOCK_TYPE_LABELS[block.blockType] ?? block.blockType}
          {isTable && tableLabel ? ` · ${tableLabel}` : ''}
        </span>
        {canWrite && (
          <button
            type="button"
            onClick={() => onRemoveBlock(block)}
            disabled={busy}
            data-testid={`quote-block-remove-${block.id}`}
            className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>

      <div className="p-4">
        {block.blockType === 'heading' && (
          <p className="text-lg font-semibold" data-testid={`quote-block-heading-content-${block.id}`}>{heading}</p>
        )}
        {block.blockType === 'rich_text' && (
          <p className="whitespace-pre-wrap text-sm text-foreground" data-testid={`quote-block-rich-content-${block.id}`}>{html}</p>
        )}
        {block.blockType === 'image' && (
          <p className="text-sm text-muted-foreground">Image block (rendered in the PDF).</p>
        )}

        {isTable && (
          <div className="space-y-3">
            <table className="w-full text-sm" data-testid={`quote-block-lines-${block.id}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Description</th>
                  <th className="px-2 py-2 text-right font-medium">Qty</th>
                  <th className="px-2 py-2 text-right font-medium">Unit</th>
                  <th className="px-2 py-2 font-medium">Recurrence</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-sm text-muted-foreground">
                      No lines yet. Add a catalog item or a manual line below.
                    </td>
                  </tr>
                ) : (
                  lines.map((l) => (
                    <tr key={l.id} className="border-t" data-testid={`quote-line-${l.id}`}>
                      <td className="px-2 py-2">{l.description}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{l.quantity}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.unitPrice, currency)}</td>
                      <td className="px-2 py-2">
                        <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {formatRecurrence(l.recurrence)}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.lineTotal, currency)}</td>
                      <td className="px-2 py-2 text-right">
                        {canWrite && (
                          <button
                            type="button"
                            onClick={() => onRemoveLine(l.id)}
                            disabled={busy}
                            data-testid={`quote-line-remove-${l.id}`}
                            className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {/* Add line to this pricing table */}
            {canWrite && (
            <div className="rounded-md border bg-background/40 p-3" data-testid={`quote-block-add-line-${block.id}`}>
              <div className="mb-2 flex gap-2">
                {(['catalog', 'manual'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    data-testid={`quote-line-mode-${block.id}-${m}`}
                    className={`rounded-md border px-3 py-1 text-xs font-medium ${
                      mode === m ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                    }`}
                  >
                    {m === 'catalog' ? 'Catalog item' : 'Manual line'}
                  </button>
                ))}
              </div>

              {mode === 'catalog' ? (
                catalog.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid={`quote-catalog-empty-${block.id}`}>
                    No catalog items.{' '}
                    <a href="/settings/catalog" className="underline hover:text-foreground">Add some in Product Catalog</a>.
                  </p>
                ) : (
                  <CatalogItemPicker
                    items={catalog}
                    includeBundles={false}
                    onSelect={(it) => onAddCatalog(block.id, it)}
                    testId={`quote-catalog-picker-${block.id}`}
                    placeholder="Search catalog by name or SKU"
                    disabled={busy}
                  />
                )
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_70px_90px_110px]">
                    <input
                      type="text" placeholder="Description" value={desc}
                      onChange={(e) => setDesc(e.target.value)}
                      data-testid={`quote-manual-desc-${block.id}`}
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="number" min="0" step="0.01" placeholder="Qty" value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      data-testid={`quote-manual-qty-${block.id}`}
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="number" min="0" step="0.01" placeholder="Unit price" value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      data-testid={`quote-manual-price-${block.id}`}
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <select
                      value={recurrence}
                      onChange={(e) => setRecurrence(e.target.value as QuoteLineRecurrence)}
                      data-testid={`quote-manual-recurrence-${block.id}`}
                      className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="one_time">One-time</option>
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} data-testid={`quote-manual-taxable-${block.id}`} />
                        Taxable
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={saveToCatalog} onChange={(e) => setSaveToCatalog(e.target.checked)} data-testid={`quote-manual-save-catalog-${block.id}`} />
                        Save to catalog
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={submitManual}
                      disabled={busy || !desc.trim()}
                      data-testid={`quote-manual-add-${block.id}`}
                      className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      Add line
                    </button>
                  </div>
                </div>
              )}
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
