import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, handleActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import {
  addBlock,
  updateBlock,
  deleteBlock,
  addManualLine,
  addCatalogLine,
  updateLine,
  removeLine,
  uploadQuoteImage,
  quoteImageUrl,
} from '../../../lib/api/quotes';
import type { QuoteBlockInput } from '@breeze/shared';
import { listCatalog, createCatalogItem, catalogItemImagePath, type CatalogItem } from '../../../lib/api/catalog';
import { ecExpressStatus, ecExpressImport, type EcProduct, type EcStatus } from '../../../lib/api/distributors';
import CatalogItemPicker from '../../catalog/CatalogItemPicker';
import CatalogEnrichButton from '../../catalog/CatalogEnrichButton';
import DistributorLookup from './DistributorLookup';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { UnsavedBadge, RecurringBillingNote } from '../billingUi';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  type QuoteLineRecurrence,
  formatMoney,
  formatRecurrence,
  pctFromFraction,
} from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

// Phase 2: the add-block menu now offers `image` as well. An image block is
// created with its uploaded `imageId` already in `content` — the editor uploads
// the file first (POST /:id/images), then adds the block with `{ imageId }`.
// Heading/rich-text block content is editable in place via PATCH /:id/blocks/:blockId
// (updateBlock); the block type itself is immutable.
type AddableBlockType = 'heading' | 'rich_text' | 'image' | 'line_items';
const ADD_BLOCK_OPTIONS: { value: AddableBlockType; label: string }[] = [
  { value: 'heading', label: 'Heading' },
  { value: 'rich_text', label: 'Rich text' },
  { value: 'image', label: 'Image' },
  { value: 'line_items', label: 'Pricing table' },
];

const BLOCK_TYPE_LABELS: Record<string, string> = {
  heading: 'Heading',
  rich_text: 'Rich text',
  image: 'Image',
  line_items: 'Pricing table',
};

// Changed-fields payload for an inline line edit. Subset of
// updateQuoteLineSchema (description/quantity/unitPrice/taxable/recurrence) —
// the only fields the inline editor exposes.
type LineUpdate = Partial<{
  description: string;
  quantity: number;
  unitPrice: number;
  taxable: boolean;
  recurrence: QuoteLineRecurrence;
}>;

interface Props {
  detail: QuoteDetailData;
  onChanged: () => void;
}

export default function QuoteEditor({ detail, onChanged }: Props) {
  const { can } = usePermissions();
  const canWrite = can('quotes', 'write');
  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;

  // Per-item "saving" state, keyed so one in-flight mutation never freezes the
  // rest of the editor. Keys: 'terms', 'tax', 'add-block', `block:<id>`,
  // `add-line:<blockId>`, `line:<id>`. `pending` drives disabled styling;
  // `inFlight` is the synchronous double-submit guard (state updates are async).
  const inFlight = useRef<Set<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const isPending = useCallback((key: string) => pending.has(key), [pending]);

  // Run a scoped mutation: mark the key pending, run, surface failures via the
  // standard handleActionError path, and always clear the key. Returns whether
  // the mutation succeeded so callers can flash a quiet "Saved" cue.
  const runScoped = useCallback(
    async (key: string, fn: () => Promise<void>, errMsg: string): Promise<boolean> => {
      if (inFlight.current.has(key)) return false;
      inFlight.current.add(key);
      setPending((s) => { const n = new Set(s); n.add(key); return n; });
      try {
        await fn();
        return true;
      } catch (err) {
        handleActionError(err, errMsg);
        return false;
      } finally {
        inFlight.current.delete(key);
        setPending((s) => { const n = new Set(s); n.delete(key); return n; });
      }
    },
    [],
  );

  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [ecActive, setEcActive] = useState(false);
  const [terms, setTerms] = useState(quote.termsAndConditions ?? '');
  const [termsDirty, setTermsDirty] = useState(false);
  // Tax rate is stored as a fraction ('0.07'); the input edits it as a percent ('7').
  const [taxPct, setTaxPct] = useState(pctFromFraction(quote.taxRate));
  const [taxDirty, setTaxDirty] = useState(false);
  // Inline validation message for the tax field — an out-of-range/non-numeric
  // entry no longer silently reverts; we keep the bad value and explain why.
  const [taxError, setTaxError] = useState<string | null>(null);
  const canCatalogWrite = can('catalog', 'write');

  // ---- add-block form ------------------------------------------------------
  const [addType, setAddType] = useState<AddableBlockType>('heading');
  const [headingText, setHeadingText] = useState('');
  const [richText, setRichText] = useState('');
  const [tableLabel, setTableLabel] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageCaption, setImageCaption] = useState('');

  useEffect(() => { setTerms(quote.termsAndConditions ?? ''); setTermsDirty(false); }, [quote.termsAndConditions]);
  useEffect(() => { setTaxPct(pctFromFraction(quote.taxRate)); setTaxDirty(false); }, [quote.taxRate]);

  const refresh = useCallback(() => onChanged(), [onChanged]);

  const saveTerms = useCallback(async () => {
    if (!termsDirty) return;
    await runScoped('terms', async () => {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify({ termsAndConditions: terms }),
        }),
        errorFallback: 'Could not save terms.',
        successMessage: 'Terms saved',
        onUnauthorized: UNAUTHORIZED,
      });
      setTermsDirty(false);
      refresh();
    }, 'Could not save terms.');
  }, [termsDirty, terms, quote.id, refresh, runScoped]);

  // Persist the tax rate as a fraction. Empty clears it (null); otherwise the
  // percent is clamped to 0–100 (fraction 0–1, matching updateQuoteSchema) and an
  // out-of-range/non-numeric entry resets to the persisted value rather than
  // saving garbage. The server recomputes taxTotal/total, so refresh() re-pulls.
  const saveTaxRate = useCallback(async () => {
    if (!taxDirty) return;
    const trimmed = taxPct.trim();
    let fraction: number | null;
    if (trimmed === '') {
      fraction = null;
    } else {
      const pct = Number(trimmed);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        // Keep the user's entry (don't snap it away) and explain the constraint
        // inline instead of swallowing it.
        setTaxError('Enter a rate from 0 to 100.');
        return;
      }
      fraction = Number((pct / 100).toFixed(5));
    }
    setTaxError(null);
    await runScoped('tax', async () => {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify({ taxRate: fraction }),
        }),
        errorFallback: 'Could not save the tax rate.',
        successMessage: 'Tax rate saved',
        onUnauthorized: UNAUTHORIZED,
      });
      setTaxDirty(false);
      refresh();
    }, 'Could not save the tax rate.');
  }, [taxDirty, taxPct, quote.id, refresh, runScoped]);

  const loadCatalog = useCallback(async () => {
    const res = await listCatalog({ isActive: true, limit: 200 });
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) return; // catalog is optional context; don't block the editor
    const body = (await res.json().catch(() => null)) as { data?: CatalogItem[] } | null;
    if (!body) return;
    setCatalog((body.data ?? []).filter((i) => !i.isBundle));
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const loadEcStatus = useCallback(async () => {
    if (!canCatalogWrite) { setEcActive(false); return; }
    const res = await ecExpressStatus();
    if (!res.ok) return; // optional context; never block the editor
    const body = (await res.json().catch(() => null)) as { data?: EcStatus } | null;
    setEcActive(Boolean(body?.data?.configured && body?.data?.enabled));
  }, [canCatalogWrite]);

  useEffect(() => { void loadEcStatus(); }, [loadEcStatus]);

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
    // Image blocks have no block-update endpoint, so the file must exist before
    // the block: upload it (POST /:id/images → { data: { imageId } }), then add
    // an image block with that imageId already in its content. Both steps go
    // through runAction so success/failure is always surfaced.
    if (addType === 'image') {
      const file = imageFile;
      if (!file) return;
      // Honor the "up to 5 MB" promise client-side so the user gets an immediate,
      // specific message instead of a generic server-side upload failure.
      if (file.size > 5 * 1024 * 1024) {
        handleActionError(new Error('image too large'), 'Image must be 5 MB or smaller.');
        return;
      }
      await runScoped('add-block', async () => {
        const uploaded = await runAction<{ imageId: string }>({
          request: () => uploadQuoteImage(quote.id, file),
          errorFallback: 'Could not upload the image.',
          // No success toast: the upload is an internal step of "add image block";
          // only the final "Image block added" toast below is meaningful (web-2).
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: { imageId: string } }).data,
        });
        await runAction({
          request: () => addBlock(quote.id, {
            blockType: 'image' as const,
            content: imageCaption.trim()
              ? { imageId: uploaded.imageId, caption: imageCaption.trim() }
              : { imageId: uploaded.imageId },
          }),
          errorFallback: 'Image uploaded, but adding the block failed.',
          successMessage: 'Image block added',
          onUnauthorized: UNAUTHORIZED,
        });
        setImageFile(null); setImageCaption('');
        refresh();
      }, 'Could not add the image block.');
      return;
    }

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
    await runScoped('add-block', async () => {
      await runAction({
        request: () => addBlock(quote.id, body),
        errorFallback: 'Could not add the block.',
        successMessage: 'Block added',
        onUnauthorized: UNAUTHORIZED,
      });
      setHeadingText(''); setRichText(''); setTableLabel('');
      refresh();
    }, 'Could not add the block.');
  }, [addType, headingText, richText, tableLabel, imageFile, imageCaption, quote.id, refresh, runScoped]);

  // Removing a line_items block cascades to every line under it (server-side), so
  // the card's Remove button opens a confirm step instead of deleting outright.
  const [pendingRemove, setPendingRemove] = useState<QuoteBlock | null>(null);
  // Line removal is equally irreversible, so it gets the same confirm step the
  // block remove has (rather than deleting on a single click).
  const [pendingLineRemove, setPendingLineRemove] = useState<QuoteLine | null>(null);

  // Real block delete: removes the block and (server-side) any lines attached to
  // it. Works for every block type — heading, rich_text, and line_items — so the
  // "Remove" button is no longer a silent no-op for heading/rich_text blocks.
  const removeBlock = useCallback((block: QuoteBlock) =>
    runScoped(`block:${block.id}`, async () => {
      await runAction({
        request: () => deleteBlock(quote.id, block.id),
        errorFallback: 'Could not remove the block.',
        successMessage: 'Block removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not remove the block.'),
  [quote.id, refresh, runScoped]);

  // ---- line mutations (scoped to a line_items block) ----------------------
  const doAddCatalog = useCallback(async (blockId: string, item: CatalogItem) => {
    await runAction({
      request: () => addCatalogLine(quote.id, { catalogItemId: item.id, quantity: 1, blockId }),
      errorFallback: 'Could not add the catalog item.',
      successMessage: 'Item added',
      onUnauthorized: UNAUTHORIZED,
    });
    refresh();
  }, [quote.id, refresh]);

  const addCatalog = useCallback((blockId: string, item: CatalogItem) =>
    runScoped(`add-line:${blockId}`, () => doAddCatalog(blockId, item), 'Could not add the catalog item.'),
  [doAddCatalog, runScoped]);

  const resolveCatalogBySku = useCallback(async (sku: string): Promise<CatalogItem | null> => {
    const fromState = catalog.find((i) => i.sku === sku);
    if (fromState) return fromState;
    const res = await listCatalog({ search: sku, isActive: true, limit: 200 });
    // A failed lookup must NOT be treated as "not in catalog" — that would
    // re-import and could strand the line. Throw a plain Error so the caller's
    // handleActionError surfaces it (a manual ActionError would be assumed
    // already-toasted and swallowed).
    if (!res.ok) throw new Error('catalog lookup failed');
    const body = (await res.json().catch(() => null)) as { data?: CatalogItem[] } | null;
    return (body?.data ?? []).find((i) => i.sku === sku) ?? null;
  }, [catalog]);

  const importAndAddDistributor = useCallback((blockId: string, product: EcProduct, sellPrice: number) =>
    runScoped(`add-line:${blockId}`, async () => {
      // Check the catalog first: if this SKU is already imported, add the existing
      // item directly. This avoids the duplicate-SKU error toast (runAction toasts
      // the failure before throwing) firing on the common "already in catalog" path,
      // which otherwise produced a red error flash immediately followed by green
      // "Item added".
      let item = await resolveCatalogBySku(product.synnexSku);
      if (!item) {
        item = await runAction<CatalogItem>({
          request: () => ecExpressImport({
            product,
            item: {
              name: product.name,
              sku: product.synnexSku || product.mfgPartNo || null,
              description: product.description ?? null,
              unitPrice: sellPrice,
              costBasis: product.cost != null && Number.isFinite(product.cost) ? Number(product.cost.toFixed(2)) : null,
            },
          }),
          errorFallback: 'Could not import the distributor item.',
          // no success toast here — the "Item added" toast from doAddCatalog is the meaningful one
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: CatalogItem }).data,
        });
      }
      await doAddCatalog(blockId, item);
      void loadCatalog(); // surface a newly-imported item in the catalog picker too
    }, 'Could not add the distributor item.'),
  [doAddCatalog, resolveCatalogBySku, loadCatalog, runScoped]);

  const addManual = useCallback((
    blockId: string,
    form: { description: string; quantity: string; unitPrice: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => {
    if (!form.description.trim()) return Promise.resolve(false);
    // Guard qty 0 / non-numeric here too — the inline edit path already does, and
    // a silent $0-quantity line is a real footgun on the add path.
    const qtyNum = Number(form.quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      handleActionError(new Error('invalid quantity'), 'Enter a quantity greater than 0.');
      return Promise.resolve(false);
    }
    return runScoped(`add-line:${blockId}`, async () => {
      await runAction({
        request: () => addManualLine(quote.id, {
          sourceType: 'manual',
          blockId,
          description: form.description.trim(),
          quantity: qtyNum,
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
    }, 'Could not add the line.');
  }, [quote.id, refresh, loadCatalog, runScoped]);

  const deleteLine = useCallback((lineId: string) =>
    runScoped(`line:${lineId}`, async () => {
      await runAction({
        request: () => removeLine(quote.id, lineId),
        errorFallback: 'Could not remove the line.',
        successMessage: 'Line removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not remove the line.'),
  [quote.id, refresh, runScoped]);

  // Inline edit of an existing line. `body` carries only the changed fields
  // (matches updateQuoteLineSchema). Routed through runAction so failures are
  // surfaced, then refresh() re-pulls the quote so totals recompute. Returns
  // whether it succeeded so the row can flash a quiet "Saved" cue — routine
  // inline edits no longer fire a success toast (that was per-field spam).
  const editLine = useCallback((lineId: string, body: LineUpdate) =>
    runScoped(`line:${lineId}`, async () => {
      await runAction({
        request: () => updateLine(quote.id, lineId, body),
        errorFallback: 'Could not update the line.',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not update the line.'),
  [quote.id, refresh, runScoped]);

  // Inline edit of a block's content (heading text/level, rich-text html). The
  // block type is restated so the server validates the content shape; it is
  // immutable and never changes here. Like editLine, success is quiet (the row
  // flashes "Saved"); only failures toast.
  const editBlock = useCallback((block: QuoteBlock, content: Record<string, unknown>) =>
    runScoped(`block:${block.id}`, async () => {
      await runAction({
        request: () => updateBlock(quote.id, block.id, { blockType: block.blockType, content } as QuoteBlockInput),
        errorFallback: 'Could not update the block.',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not update the block.'),
  [quote.id, refresh, runScoped]);

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
                quoteId={quote.id}
                lines={linesForBlock(block.id)}
                currency={currency}
                catalog={catalog}
                isPending={isPending}
                canWrite={canWrite}
                ecActive={ecActive}
                onAddCatalog={addCatalog}
                onImportAddDistributor={importAndAddDistributor}
                onAddManual={addManual}
                onEditLine={editLine}
                onEditBlock={editBlock}
                onRemoveLine={setPendingLineRemove}
                onRemoveBlock={setPendingRemove}
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
                  aria-pressed={addType === o.value}
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
            {addType === 'image' && (
              <div className="mb-3 space-y-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
                  data-testid="quote-block-image-file"
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium"
                />
                <input
                  type="text"
                  value={imageCaption}
                  onChange={(e) => setImageCaption(e.target.value)}
                  placeholder="Caption (optional)"
                  data-testid="quote-block-image-caption"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">PNG, JPEG, or WebP, up to 5 MB.</p>
              </div>
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
                  isPending('add-block') ||
                  (addType === 'heading' && !headingText.trim()) ||
                  (addType === 'rich_text' && !richText.trim()) ||
                  (addType === 'image' && !imageFile)
                }
                data-testid="quote-add-block-submit"
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {addType === 'image' ? 'Upload & add image' : 'Add block'}
              </button>
            </div>
          </div>
          )}
        </div>

        {/* ── live totals + terms ────────────────────────────────────── */}
        {/* Sticky on lg so the totals you're building against stay visible while
            scrolling the blocks; on narrow widths this column stacks below. */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-live-totals" aria-live="polite">
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
            {canWrite && (
              <div className="mt-2 border-t pt-2">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="quote-tax-rate" className="text-sm text-muted-foreground">Tax rate</label>
                  <div className="flex items-center gap-1">
                    <input
                      id="quote-tax-rate"
                      type="number"
                      min="0"
                      max="100"
                      step="0.001"
                      value={taxPct}
                      onChange={(e) => { setTaxPct(e.target.value); setTaxDirty(true); if (taxError) setTaxError(null); }}
                      onBlur={() => void saveTaxRate()}
                      disabled={isPending('tax')}
                      placeholder="0"
                      aria-invalid={taxError !== null}
                      aria-describedby={taxError ? 'quote-tax-rate-error' : undefined}
                      data-testid="quote-tax-rate"
                      className={`h-8 w-20 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${
                        taxError ? 'border-destructive ring-1 ring-destructive' : taxDirty ? 'ring-1 ring-warning' : ''
                      }`}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
                {taxError ? (
                  <p className="mt-1 text-xs text-destructive" id="quote-tax-rate-error" data-testid="quote-tax-rate-error">{taxError}</p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">Applies to lines marked taxable.</p>
                )}
              </div>
            )}
            <div className="mt-3 flex items-end justify-between gap-2 border-t pt-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Due on acceptance</span>
              <span className="min-w-0 break-words text-right text-2xl font-semibold tabular-nums" data-testid="quote-total-due-on-acceptance">
                {formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency)}
              </span>
            </div>
            {hasRecurring && (
              <>
                <div className="mt-2 flex items-baseline justify-between text-sm tabular-nums">
                  <span className="text-muted-foreground">First-period total (incl. recurring)</span>
                  <span className="font-medium" data-testid="quote-total-first-period">{formatMoney(quote.total, currency)}</span>
                </div>
                <RecurringBillingNote className="mt-2" testId="quote-totals-recurring-hint" />
              </>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
              <UnsavedBadge show={termsDirty} />
            </div>
            <textarea
              value={terms}
              onChange={(e) => { setTerms(e.target.value); setTermsDirty(true); }}
              onBlur={() => { if (canWrite) void saveTerms(); }}
              disabled={!canWrite}
              data-testid="quote-terms"
              rows={3}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${termsDirty ? 'ring-1 ring-warning' : ''}`}
              placeholder="Payment terms, warranty clauses, etc."
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={() => {
          const block = pendingRemove;
          setPendingRemove(null);
          if (block) void removeBlock(block);
        }}
        isLoading={pendingRemove ? isPending(`block:${pendingRemove.id}`) : false}
        title="Remove block"
        message={
          pendingRemove?.blockType === 'line_items' && linesForBlock(pendingRemove.id).length > 0
            ? `This removes the pricing table and its ${linesForBlock(pendingRemove.id).length} line item${
                linesForBlock(pendingRemove.id).length === 1 ? '' : 's'
              }. This can't be undone.`
            : 'This removes this block. This can’t be undone.'
        }
        confirmLabel="Remove block"
        confirmTestId="quote-block-remove-confirm"
      />

      <ConfirmDialog
        open={pendingLineRemove !== null}
        onClose={() => setPendingLineRemove(null)}
        onConfirm={() => {
          const line = pendingLineRemove;
          setPendingLineRemove(null);
          if (line) void deleteLine(line.id);
        }}
        isLoading={pendingLineRemove ? isPending(`line:${pendingLineRemove.id}`) : false}
        title="Remove line"
        message={
          pendingLineRemove
            ? `This removes "${pendingLineRemove.description || 'this line'}" from the quote. This can’t be undone.`
            : ''
        }
        confirmLabel="Remove line"
        confirmTestId="quote-line-remove-confirm"
      />
    </div>
  );
}

// ── A single block, with an inline line builder when it is a pricing table ──
function BlockCard({
  block, quoteId, lines, currency, catalog, isPending, canWrite, ecActive, onAddCatalog, onImportAddDistributor, onAddManual, onEditLine, onEditBlock, onRemoveLine, onRemoveBlock,
}: {
  block: QuoteBlock;
  quoteId: string;
  lines: QuoteLine[];
  currency: string;
  catalog: CatalogItem[];
  isPending: (key: string) => boolean;
  canWrite: boolean;
  ecActive: boolean;
  onAddCatalog: (blockId: string, item: CatalogItem) => void;
  onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void;
  onAddManual: (
    blockId: string,
    form: { description: string; quantity: string; unitPrice: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => Promise<boolean>;
  onEditLine: (lineId: string, body: LineUpdate) => Promise<boolean>;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
  onRemoveLine: (line: QuoteLine) => void;
  onRemoveBlock: (block: QuoteBlock) => void;
}) {
  // Pending state scoped to this block: editing/removing this block, or adding a
  // line to it, never disables anything in a sibling block.
  const blockBusy = isPending(`block:${block.id}`);
  const addLineBusy = isPending(`add-line:${block.id}`);

  const [mode, setMode] = useState<'catalog' | 'manual' | 'distributor'>('catalog');
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
  const imageId = (block.content?.imageId as string | undefined) ?? '';
  const imageCaption = (block.content?.caption as string | undefined) ?? '';

  // Inline drafts for editable block content; resync if the persisted value
  // changes (e.g. after a refresh) so server normalization wins.
  const [headingDraft, setHeadingDraft] = useState(heading);
  const [richDraft, setRichDraft] = useState(html);
  // Resync drafts from the server only when the user hasn't diverged from what we
  // last showed. A quiet reload (fired by an unrelated inline edit elsewhere) must
  // not clobber heading/rich text this user is mid-edit in: if the local draft no
  // longer matches the prop we last synced, the user has typed — keep their text.
  const lastHeading = useRef(heading);
  const lastHtml = useRef(html);
  useEffect(() => {
    setHeadingDraft((cur) => (cur === lastHeading.current ? heading : cur));
    lastHeading.current = heading;
  }, [heading]);
  useEffect(() => {
    setRichDraft((cur) => (cur === lastHtml.current ? html : cur));
    lastHtml.current = html;
  }, [html]);

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
    if (await onEditBlock(block, { html: richDraft })) flashSaved();
  };

  const submitManual = async () => {
    const ok = await onAddManual(block.id, { description: desc, quantity: qty, unitPrice: price, taxable, recurrence, saveToCatalog });
    // Only clear the form on success, so a rejected add (e.g. qty 0) keeps the
    // user's input to correct rather than wiping it.
    if (ok) { setDesc(''); setQty('1'); setPrice('0.00'); setTaxable(false); setRecurrence('one_time'); setSaveToCatalog(false); }
  };

  return (
    <div className="rounded-lg border bg-card shadow-sm" data-testid={`quote-block-${block.id}`}>
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {BLOCK_TYPE_LABELS[block.blockType] ?? block.blockType}
          {isTable && tableLabel ? ` · ${tableLabel}` : ''}
          {blockSaved && (
            <span className="font-medium normal-case tracking-normal text-success" data-testid={`quote-block-saved-${block.id}`}>Saved</span>
          )}
        </span>
        {canWrite && (
          <button
            type="button"
            onClick={() => onRemoveBlock(block)}
            disabled={blockBusy}
            data-testid={`quote-block-remove-${block.id}`}
            className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>

      <div className="p-4">
        {block.blockType === 'heading' && (
          canWrite ? (
            <input
              value={headingDraft}
              aria-label="Heading text"
              onChange={(e) => setHeadingDraft(e.target.value)}
              onBlur={() => void commitHeading()}
              disabled={blockBusy}
              data-testid={`quote-block-heading-input-${block.id}`}
              className="w-full rounded-md border bg-background px-2 py-1 text-lg font-semibold disabled:opacity-60"
            />
          ) : (
            <p className="text-lg font-semibold" data-testid={`quote-block-heading-content-${block.id}`}>{heading}</p>
          )
        )}
        {block.blockType === 'rich_text' && (
          canWrite ? (
            <textarea
              value={richDraft}
              aria-label="Rich text content"
              onChange={(e) => setRichDraft(e.target.value)}
              onBlur={() => void commitRich()}
              disabled={blockBusy}
              rows={4}
              data-testid={`quote-block-rich-input-${block.id}`}
              className="w-full resize-y rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-60"
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-foreground" data-testid={`quote-block-rich-content-${block.id}`}>{html}</p>
          )
        )}
        {block.blockType === 'image' && (
          imageId ? (
            <figure className="space-y-1" data-testid={`quote-block-image-content-${block.id}`}>
              <QuoteImagePreview quoteId={quoteId} imageId={imageId} caption={imageCaption} />
              {imageCaption && <figcaption className="text-xs text-muted-foreground">{imageCaption}</figcaption>}
            </figure>
          ) : (
            <p className="text-sm text-muted-foreground">Image block (rendered in the PDF).</p>
          )
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
                  lines.map((l) =>
                    canWrite ? (
                      <EditableLineRow
                        key={l.id}
                        line={l}
                        currency={currency}
                        busy={isPending(`line:${l.id}`)}
                        onEdit={onEditLine}
                        onRemove={onRemoveLine}
                      />
                    ) : (
                      <tr key={l.id} className="border-t" data-testid={`quote-line-${l.id}`}>
                        <td className="px-2 py-2">
                          <div className="flex items-start gap-2">
                            {l.catalogItemId && <CatalogLineThumb catalogItemId={l.catalogItemId} />}
                            <span>{l.description}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{l.quantity}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.unitPrice, currency)}</td>
                        <td className="px-2 py-2">
                          <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {formatRecurrence(l.recurrence)}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.lineTotal, currency)}</td>
                        <td className="px-2 py-2 text-right" />
                      </tr>
                    ),
                  )
                )}
              </tbody>
            </table>

            {/* Add line to this pricing table */}
            {canWrite && (
            <div className="rounded-md border bg-background/40 p-3" data-testid={`quote-block-add-line-${block.id}`}>
              <div className="mb-2 flex gap-2">
                {(['catalog', 'manual', ...(ecActive ? ['distributor'] as const : [])] as const).map((m) => (
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
                    {m === 'catalog' ? 'Catalog item' : m === 'manual' ? 'Manual line' : 'Search distributor'}
                  </button>
                ))}
              </div>

              {mode === 'distributor' ? (
                <DistributorLookup
                  blockId={block.id}
                  busy={addLineBusy}
                  onImportAdd={(product, sellPrice) => onImportAddDistributor(block.id, product, sellPrice)}
                />
              ) : mode === 'catalog' ? (
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
                    disabled={addLineBusy}
                  />
                )
              ) : (
                <div className="space-y-2">
                  <CatalogEnrichButton
                    idSuffix={`quote-${block.id}`}
                    onApply={(result) => {
                      const d = result.draft;
                      setDesc(d.description ? `${d.name} — ${d.description}` : d.name);
                      setTaxable(d.taxable);
                    }}
                  />
                  <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_70px_90px_110px]">
                    <textarea
                      placeholder="Description" aria-label="Line description" value={desc}
                      onChange={(e) => setDesc(e.target.value)}
                      rows={2}
                      data-testid={`quote-manual-desc-${block.id}`}
                      className="min-h-[2.25rem] resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="number" min="0" step="0.01" placeholder="Qty" aria-label="Quantity" value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      data-testid={`quote-manual-qty-${block.id}`}
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="number" min="0" step="0.01" placeholder="Unit price" aria-label="Unit price" value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      data-testid={`quote-manual-price-${block.id}`}
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <select
                      value={recurrence}
                      aria-label="Billing frequency"
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
                      onClick={() => void submitManual()}
                      disabled={addLineBusy || !desc.trim()}
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

// ── A single editable pricing-table line (writers only) ───────────────────
// Each field is locally controlled and committed on blur (text/number) or on
// change (taxable checkbox, recurrence select) — but only when the value
// actually differs from the persisted line, so a focus-without-edit doesn't
// fire a redundant PATCH. The parent's onEdit routes through updateLine +
// runAction and then refresh()es, which re-pulls the line; we resync local
// state to the incoming prop so server-side normalization (e.g. recomputed
// totals, clamped quantity) wins.
function EditableLineRow({
  line, currency, busy, onEdit, onRemove,
}: {
  line: QuoteLine;
  currency: string;
  busy: boolean;
  onEdit: (lineId: string, body: LineUpdate) => Promise<boolean>;
  onRemove: (line: QuoteLine) => void;
}) {
  const [desc, setDesc] = useState(line.description);
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);

  // Resync when the persisted line changes (after a refresh()).
  useEffect(() => { setDesc(line.description); }, [line.description]);
  useEffect(() => { setQty(line.quantity); }, [line.quantity]);
  useEffect(() => { setPrice(line.unitPrice); }, [line.unitPrice]);

  // Quiet "Saved" flash in place of the old per-field success toast.
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, []);
  const edit = useCallback(async (body: LineUpdate) => { if (await onEdit(line.id, body)) flashSaved(); }, [onEdit, line.id, flashSaved]);

  const commitDesc = () => {
    const next = desc.trim();
    if (!next || next === line.description) { setDesc(line.description); return; }
    void edit({ description: next });
  };
  const commitQty = () => {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0 || n === Number(line.quantity)) { setQty(line.quantity); return; }
    void edit({ quantity: n });
  };
  const commitPrice = () => {
    const n = Number(price);
    if (!Number.isFinite(n) || n < 0 || n === Number(line.unitPrice)) { setPrice(line.unitPrice); return; }
    void edit({ unitPrice: n });
  };

  return (
    <tr className="border-t align-top" data-testid={`quote-line-${line.id}`}>
      <td className="px-2 py-2">
        <div className="flex items-start gap-2">
          {line.catalogItemId && <CatalogLineThumb catalogItemId={line.catalogItemId} />}
          <textarea
            value={desc}
            aria-label="Line description"
            onChange={(e) => setDesc(e.target.value)}
            onBlur={commitDesc}
            rows={2}
            disabled={busy}
            data-testid={`quote-line-desc-${line.id}`}
            className="min-h-[2.25rem] w-full resize-y rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </div>
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={qty}
          aria-label="Quantity"
          onChange={(e) => setQty(e.target.value)}
          onBlur={commitQty}
          disabled={busy}
          data-testid={`quote-line-qty-${line.id}`}
          className="h-9 w-16 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={price}
          aria-label="Unit price"
          onChange={(e) => setPrice(e.target.value)}
          onBlur={commitPrice}
          disabled={busy}
          data-testid={`quote-line-price-${line.id}`}
          className="h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </td>
      <td className="px-2 py-2">
        <select
          value={line.recurrence}
          aria-label="Billing frequency"
          onChange={(e) => void edit({ recurrence: e.target.value as QuoteLineRecurrence })}
          disabled={busy}
          data-testid={`quote-line-recurrence-${line.id}`}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        >
          <option value="one_time">One-time</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
        <label className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={line.taxable}
            aria-label="Taxable"
            onChange={(e) => void edit({ taxable: e.target.checked })}
            disabled={busy}
            data-testid={`quote-line-taxable-${line.id}`}
          />
          Taxable
        </label>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {formatMoney(line.lineTotal, currency)}
        {saved && <span className="ml-1 text-xs font-medium text-success" data-testid={`quote-line-saved-${line.id}`}>Saved</span>}
      </td>
      <td className="px-2 py-2 text-right">
        <button
          type="button"
          onClick={() => onRemove(line)}
          disabled={busy}
          data-testid={`quote-line-remove-${line.id}`}
          className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

// Small product thumbnail for a catalog-sourced quote line. GET /catalog/:id/image
// needs the Bearer header (a bare <img src> would 401), and 404s when the item has
// no image — so we fetchWithAuth → blob → object URL and render nothing on miss.
function CatalogLineThumb({ catalogItemId }: { catalogItemId: string }) {
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

// Editor image preview. GET /quotes/:id/images/:imageId requires the Bearer auth
// header, so a bare <img src> would 401 (web-1). Mirror QuoteWorkspace's PDF
// preview: fetchWithAuth → blob → object URL, revoked on unmount/change.
function QuoteImagePreview({ quoteId, imageId, caption }: { quoteId: string; imageId: string; caption?: string }) {
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

  if (failed) return <p className="text-sm text-muted-foreground">Image preview unavailable.</p>;
  if (!url) return <div className="h-24 w-full animate-pulse rounded border bg-muted" data-testid="quote-image-loading" />;
  return <img src={url} alt={caption || 'Quote image'} className="max-h-64 rounded border" />;
}
