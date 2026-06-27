import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  type QuoteLineRecurrence,
  formatMoney,
  formatRecurrence,
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

  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [ecActive, setEcActive] = useState(false);
  const [terms, setTerms] = useState(quote.termsAndConditions ?? '');
  const [termsDirty, setTermsDirty] = useState(false);
  const canCatalogWrite = can('catalog', 'write');

  // ---- add-block form ------------------------------------------------------
  const [addType, setAddType] = useState<AddableBlockType>('heading');
  const [headingText, setHeadingText] = useState('');
  const [richText, setRichText] = useState('');
  const [tableLabel, setTableLabel] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageCaption, setImageCaption] = useState('');

  useEffect(() => { setTerms(quote.termsAndConditions ?? ''); setTermsDirty(false); }, [quote.termsAndConditions]);

  const refresh = useCallback(() => onChanged(), [onChanged]);

  const saveTerms = useCallback(async () => {
    if (busy || !termsDirty) return;
    setBusy(true);
    try {
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
    } catch (err) {
      handleActionError(err, 'Could not save terms.');
    } finally {
      setBusy(false);
    }
  }, [busy, termsDirty, terms, quote.id, refresh]);

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
    if (busy) return;

    // Image blocks have no block-update endpoint, so the file must exist before
    // the block: upload it (POST /:id/images → { data: { imageId } }), then add
    // an image block with that imageId already in its content. Both steps go
    // through runAction so success/failure is always surfaced.
    if (addType === 'image') {
      const file = imageFile;
      if (!file) return;
      setBusy(true);
      try {
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
      } catch (err) {
        handleActionError(err, 'Could not add the image block.');
      } finally {
        setBusy(false);
      }
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
  }, [busy, addType, headingText, richText, tableLabel, imageFile, imageCaption, quote.id, refresh]);

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
  const doAddCatalog = useCallback(async (blockId: string, item: CatalogItem) => {
    await runAction({
      request: () => addCatalogLine(quote.id, { catalogItemId: item.id, quantity: 1, blockId }),
      errorFallback: 'Could not add the catalog item.',
      successMessage: 'Item added',
      onUnauthorized: UNAUTHORIZED,
    });
    refresh();
  }, [quote.id, refresh]);

  const addCatalog = useCallback(async (blockId: string, item: CatalogItem) => {
    if (busy) return;
    setBusy(true);
    try { await doAddCatalog(blockId, item); }
    catch (err) { handleActionError(err, 'Could not add the catalog item.'); }
    finally { setBusy(false); }
  }, [busy, doAddCatalog]);

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

  const importAndAddDistributor = useCallback(async (blockId: string, product: EcProduct, sellPrice: number) => {
    if (busy) return;
    setBusy(true);
    try {
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
    } catch (err) {
      handleActionError(err, 'Could not add the distributor item.');
    } finally {
      setBusy(false);
    }
  }, [busy, doAddCatalog, resolveCatalogBySku, loadCatalog]);

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

  // Inline edit of an existing line. `body` carries only the changed fields
  // (matches updateQuoteLineSchema). Routed through runAction so success/failure
  // is surfaced, then refresh() re-pulls the quote so totals recompute.
  const editLine = useCallback(async (lineId: string, body: LineUpdate) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateLine(quote.id, lineId, body),
        errorFallback: 'Could not update the line.',
        successMessage: 'Line updated',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not update the line.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, refresh]);

  // Inline edit of a block's content (heading text/level, rich-text html). The
  // block type is restated so the server validates the content shape; it is
  // immutable and never changes here.
  const editBlock = useCallback(async (block: QuoteBlock, content: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateBlock(quote.id, block.id, { blockType: block.blockType, content } as QuoteBlockInput),
        errorFallback: 'Could not update the block.',
        successMessage: 'Block updated',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not update the block.');
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
                quoteId={quote.id}
                lines={linesForBlock(block.id)}
                currency={currency}
                catalog={catalog}
                busy={busy}
                canWrite={canWrite}
                ecActive={ecActive}
                onAddCatalog={addCatalog}
                onImportAddDistributor={importAndAddDistributor}
                onAddManual={addManual}
                onEditLine={editLine}
                onEditBlock={editBlock}
                onRemoveLine={deleteLine}
                onRemoveBlock={removeBlock}
              />
            ))
          )}

          {/* Add block */}
          {canWrite && (
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-add-block">
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
                className="mb-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            )}
            {addType === 'rich_text' && (
              <textarea
                value={richText}
                onChange={(e) => setRichText(e.target.value)}
                placeholder="Proposal text…"
                rows={4}
                data-testid="quote-block-rich-text"
                className="mb-3 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                className="mb-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void submitBlock()}
                disabled={
                  busy ||
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
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-live-totals">
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
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Due on acceptance</span>
              <span className="text-2xl font-semibold tabular-nums" data-testid="quote-total-due-on-acceptance">
                {formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency)}
              </span>
            </div>
            {hasRecurring && (
              <>
                <div className="mt-2 flex items-baseline justify-between text-sm tabular-nums">
                  <span className="text-muted-foreground">First-period total (incl. recurring)</span>
                  <span className="font-medium" data-testid="quote-total-first-period">{formatMoney(quote.total, currency)}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground" data-testid="quote-totals-recurring-hint">
                  Accepting this quote invoices only the one-time charges now. Recurring lines (monthly + annual) bill on their own schedule via the contract. The first-period total combines the one-time charges with the first period of each recurring cadence.
                </p>
              </>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
            <textarea
              value={terms}
              onChange={(e) => { setTerms(e.target.value); setTermsDirty(true); }}
              onBlur={() => { if (canWrite) void saveTerms(); }}
              disabled={!canWrite}
              data-testid="quote-terms"
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
              placeholder="Payment terms, warranty clauses, etc."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── A single block, with an inline line builder when it is a pricing table ──
function BlockCard({
  block, quoteId, lines, currency, catalog, busy, canWrite, ecActive, onAddCatalog, onImportAddDistributor, onAddManual, onEditLine, onEditBlock, onRemoveLine, onRemoveBlock,
}: {
  block: QuoteBlock;
  quoteId: string;
  lines: QuoteLine[];
  currency: string;
  catalog: CatalogItem[];
  busy: boolean;
  canWrite: boolean;
  ecActive: boolean;
  onAddCatalog: (blockId: string, item: CatalogItem) => void;
  onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void;
  onAddManual: (
    blockId: string,
    form: { description: string; quantity: string; unitPrice: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => void;
  onEditLine: (lineId: string, body: LineUpdate) => void;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => void;
  onRemoveLine: (lineId: string) => void;
  onRemoveBlock: (block: QuoteBlock) => void;
}) {
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
  useEffect(() => { setHeadingDraft(heading); }, [heading]);
  useEffect(() => { setRichDraft(html); }, [html]);

  const commitHeading = () => {
    const text = headingDraft.trim();
    if (!text || text === heading) { setHeadingDraft(heading); return; }
    onEditBlock(block, { text, level: (block.content?.level as number | undefined) ?? 2 });
  };
  const commitRich = () => {
    if (richDraft === html) return;
    onEditBlock(block, { html: richDraft });
  };

  const submitManual = () => {
    onAddManual(block.id, { description: desc, quantity: qty, unitPrice: price, taxable, recurrence, saveToCatalog });
    setDesc(''); setQty('1'); setPrice('0.00'); setTaxable(false); setRecurrence('one_time'); setSaveToCatalog(false);
  };

  return (
    <div className="rounded-lg border bg-card shadow-xs" data-testid={`quote-block-${block.id}`}>
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
          canWrite ? (
            <input
              value={headingDraft}
              onChange={(e) => setHeadingDraft(e.target.value)}
              onBlur={commitHeading}
              disabled={busy}
              data-testid={`quote-block-heading-input-${block.id}`}
              className="w-full rounded-md border bg-background px-2 py-1 text-lg font-semibold"
            />
          ) : (
            <p className="text-lg font-semibold" data-testid={`quote-block-heading-content-${block.id}`}>{heading}</p>
          )
        )}
        {block.blockType === 'rich_text' && (
          canWrite ? (
            <textarea
              value={richDraft}
              onChange={(e) => setRichDraft(e.target.value)}
              onBlur={commitRich}
              disabled={busy}
              rows={4}
              data-testid={`quote-block-rich-input-${block.id}`}
              className="w-full resize-y rounded-md border bg-background px-2 py-1 text-sm"
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
                        busy={busy}
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
                          <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
                  busy={busy}
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
                    disabled={busy}
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
                      placeholder="Description" value={desc}
                      onChange={(e) => setDesc(e.target.value)}
                      rows={2}
                      data-testid={`quote-manual-desc-${block.id}`}
                      className="min-h-9 resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="number" min="0" step="0.01" placeholder="Qty" value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      data-testid={`quote-manual-qty-${block.id}`}
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="number" min="0" step="0.01" placeholder="Unit price" value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      data-testid={`quote-manual-price-${block.id}`}
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <select
                      value={recurrence}
                      onChange={(e) => setRecurrence(e.target.value as QuoteLineRecurrence)}
                      data-testid={`quote-manual-recurrence-${block.id}`}
                      className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
  onEdit: (lineId: string, body: LineUpdate) => void;
  onRemove: (lineId: string) => void;
}) {
  const [desc, setDesc] = useState(line.description);
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);

  // Resync when the persisted line changes (after a refresh()).
  useEffect(() => { setDesc(line.description); }, [line.description]);
  useEffect(() => { setQty(line.quantity); }, [line.quantity]);
  useEffect(() => { setPrice(line.unitPrice); }, [line.unitPrice]);

  const commitDesc = () => {
    const next = desc.trim();
    if (!next || next === line.description) { setDesc(line.description); return; }
    onEdit(line.id, { description: next });
  };
  const commitQty = () => {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0 || n === Number(line.quantity)) { setQty(line.quantity); return; }
    onEdit(line.id, { quantity: n });
  };
  const commitPrice = () => {
    const n = Number(price);
    if (!Number.isFinite(n) || n < 0 || n === Number(line.unitPrice)) { setPrice(line.unitPrice); return; }
    onEdit(line.id, { unitPrice: n });
  };

  return (
    <tr className="border-t align-top" data-testid={`quote-line-${line.id}`}>
      <td className="px-2 py-2">
        <div className="flex items-start gap-2">
          {line.catalogItemId && <CatalogLineThumb catalogItemId={line.catalogItemId} />}
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={commitDesc}
            rows={2}
            disabled={busy}
            data-testid={`quote-line-desc-${line.id}`}
            className="min-h-9 w-full resize-y rounded-md border bg-background px-2 py-1 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </div>
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          onBlur={commitQty}
          disabled={busy}
          data-testid={`quote-line-qty-${line.id}`}
          className="h-9 w-16 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={commitPrice}
          disabled={busy}
          data-testid={`quote-line-price-${line.id}`}
          className="h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </td>
      <td className="px-2 py-2">
        <select
          value={line.recurrence}
          onChange={(e) => onEdit(line.id, { recurrence: e.target.value as QuoteLineRecurrence })}
          disabled={busy}
          data-testid={`quote-line-recurrence-${line.id}`}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        >
          <option value="one_time">One-time</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
        <label className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={line.taxable}
            onChange={(e) => onEdit(line.id, { taxable: e.target.checked })}
            disabled={busy}
            data-testid={`quote-line-taxable-${line.id}`}
          />
          Taxable
        </label>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(line.lineTotal, currency)}</td>
      <td className="px-2 py-2 text-right">
        <button
          type="button"
          onClick={() => onRemove(line.id)}
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
