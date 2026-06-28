import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
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
  reorderBlocks as reorderBlocksApi,
  reorderLines as reorderLinesApi,
  uploadQuoteImage,
  quoteImageUrl,
} from '../../../lib/api/quotes';
import type { QuoteBlockInput } from '@breeze/shared';
import { computeQuoteTotals, computeLineTotal, type QuoteLineForMath, type QuoteTotals } from '@breeze/shared';
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
  lineTaxAmount,
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

// A quiet, transient "Saved" cue used consistently for every blur-to-save field
// in the editor (terms, tax, block content, line fields). Returns the on-flag
// and a trigger; clears its timer on unmount so a late fire can't setState a
// gone node.
function useSavedFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = useCallback(() => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 1500);
  }, []);
  return [on, flash];
}

// Visually-hidden polite live region — announces a transient message (e.g.
// "Saved") to screen readers without taking visual space. Pairs with the visible
// cue so sighted and SR users get the same feedback.
function SrSaved({ show, label = 'Saved' }: { show: boolean; label?: string }) {
  // role="status" already implies aria-live="polite" — don't double it.
  return <span role="status" className="sr-only">{show ? label : ''}</span>;
}

// Up/down reorder controls: lucide chevrons in 28px targets (clears the WCAG
// 2.5.8 24×24 minimum) instead of raw glyphs, disabled only at the list ends.
// When the pressed direction hits an end and self-disables, focus hops to the
// still-enabled sibling so a keyboard user never drops to <body>.
function MoveControls({
  disabledUp, disabledDown, onUp, onDown, labelUp, labelDown, testIdUp, testIdDown,
}: {
  disabledUp: boolean;
  disabledDown: boolean;
  onUp: () => void;
  onDown: () => void;
  labelUp: string;
  labelDown: string;
  testIdUp: string;
  testIdDown: string;
}) {
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const move = (dir: 'up' | 'down') => {
    (dir === 'up' ? onUp : onDown)();
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => {
      const pressed = dir === 'up' ? upRef.current : downRef.current;
      const other = dir === 'up' ? downRef.current : upRef.current;
      if (pressed && !pressed.disabled) pressed.focus();
      else other?.focus();
    });
  };
  const cls = 'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30';
  return (
    <>
      <button ref={upRef} type="button" onClick={() => move('up')} disabled={disabledUp} aria-label={labelUp} data-testid={testIdUp} className={cls}>
        <ChevronUp className="h-4 w-4" aria-hidden />
      </button>
      <button ref={downRef} type="button" onClick={() => move('down')} disabled={disabledDown} aria-label={labelDown} data-testid={testIdDown} className={cls}>
        <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}

export default function QuoteEditor({ detail, onChanged }: Props) {
  const { can } = usePermissions();
  const canWrite = can('quotes', 'write');
  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;
  // Focus anchor: after a confirmed block/line removal the triggering button is
  // gone, so we move focus here instead of letting it fall to <body> (which dumps
  // a keyboard user to the top of the page).
  const blocksColRef = useRef<HTMLDivElement>(null);

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
  // Quiet "Saved" cues for the right-rail blur-to-save fields, matching the
  // per-line/per-block cue so the whole editor speaks one save language.
  const [termsSaved, flashTermsSaved] = useSavedFlash();
  const [taxSaved, flashTaxSaved] = useSavedFlash();
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

  // Coalesce re-pulls: each mutation calls refresh(), but tab-through editing
  // would otherwise fire one full GET /quotes/:id per field. This is a LEADING +
  // trailing throttle, not a pure trailing debounce: the first edit of a burst
  // refetches immediately (so the server-recomputed rail totals update at once),
  // then further edits within the window collapse into a single trailing refetch
  // that captures the final state. This caps requests at ~1 / window (guarding
  // the documented US DB connection pressure) while never leaving the "Live
  // totals" frozen mid-burst — a pure trailing debounce did exactly that.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTrailing = useRef(false);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);
  const refresh = useCallback(() => {
    if (refreshTimer.current) {
      // Inside the cooldown window — remember to fire once more when it closes.
      refreshTrailing.current = true;
      return;
    }
    onChanged(); // leading edge: refetch now
    const openWindow = () => {
      refreshTimer.current = setTimeout(function close() {
        refreshTimer.current = null;
        if (refreshTrailing.current) {
          refreshTrailing.current = false;
          onChanged();
          openWindow(); // reopen so a fresh burst keeps coalescing
        }
      }, 300);
    };
    openWindow();
  }, [onChanged]);

  const saveTerms = useCallback(async () => {
    if (!termsDirty) return;
    const ok = await runScoped('terms', async () => {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify({ termsAndConditions: terms }),
        }),
        errorFallback: 'Could not save terms.',
        onUnauthorized: UNAUTHORIZED,
      });
      setTermsDirty(false);
      refresh();
    }, 'Could not save terms.');
    if (ok) flashTermsSaved();
  }, [termsDirty, terms, quote.id, refresh, runScoped, flashTermsSaved]);

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
    const ok = await runScoped('tax', async () => {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify({ taxRate: fraction }),
        }),
        errorFallback: 'Could not save the tax rate.',
        onUnauthorized: UNAUTHORIZED,
      });
      setTaxDirty(false);
      refresh();
    }, 'Could not save the tax rate.');
    if (ok) flashTaxSaved();
  }, [taxDirty, taxPct, quote.id, refresh, runScoped, flashTaxSaved]);

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

  // Optimistic order overrides so a reorder reflects instantly instead of waiting
  // for the round-trip + (coalesced) refetch. Each is cleared the moment fresh
  // server data arrives (the prop array identity changes on refresh), so the
  // server order always wins once it lands; a failed reorder reverts immediately.
  const [blockOrder, setBlockOrder] = useState<string[] | null>(null);
  const [lineOrder, setLineOrder] = useState<Record<string, string[]>>({});
  // Debounced reorder commit: repeat chevron clicks accumulate into the optimistic
  // order instantly (no click is dropped while a PATCH is "in flight"); a single
  // trailing PATCH per axis sends the final full id list. The server renumbers
  // 0..n-1 from that list, so a coalesced final order is always correct. The
  // `*Base` refs hold the latest optimistic id order so successive clicks within
  // one tick stack on each other rather than re-reading a stale render.
  const blockReorderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockReorderBase = useRef<string[] | null>(null);
  const lineReorderTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lineReorderBase = useRef<Record<string, string[]>>({});
  useEffect(() => { setBlockOrder(null); blockReorderBase.current = null; }, [blocks]);
  useEffect(() => { setLineOrder({}); lineReorderBase.current = {}; }, [lines]);
  useEffect(() => () => {
    if (blockReorderTimer.current) clearTimeout(blockReorderTimer.current);
    Object.values(lineReorderTimers.current).forEach(clearTimeout);
  }, []);

  // Optimistic line drafts so the right-rail "Live totals" can recompute from
  // in-progress edits instead of lagging behind the per-row optimistic totals.
  // Each EditableLineRow reports its effective values while they diverge from the
  // persisted line (and null once settled); the rail recomputes via the SAME
  // computeQuoteTotals the server uses, so it can never settle to a different
  // figure than the next GET returns.
  const [lineDrafts, setLineDrafts] = useState<Record<string, QuoteLineForMath>>({});
  const setLineDraft = useCallback((id: string, draft: QuoteLineForMath | null) => {
    setLineDrafts((m) => {
      if (!draft) {
        if (!(id in m)) return m;
        const n = { ...m }; delete n[id]; return n;
      }
      const prev = m[id];
      if (prev && prev.quantity === draft.quantity && prev.unitPrice === draft.unitPrice
        && prev.taxable === draft.taxable && prev.recurrence === draft.recurrence) return m;
      return { ...m, [id]: draft };
    });
  }, []);
  // Drop drafts for lines that no longer exist (removed) so a stale draft can't
  // skew the rail after a delete.
  useEffect(() => {
    setLineDrafts((m) => {
      const live = new Set(lines.map((l) => l.id));
      const stale = Object.keys(m).filter((id) => !live.has(id));
      if (stale.length === 0) return m;
      const n = { ...m }; stale.forEach((id) => delete n[id]); return n;
    });
  }, [lines]);

  // The figures the rail renders: optimistic recompute when any line is mid-edit,
  // otherwise the authoritative server values verbatim.
  const optimisticTotals = useMemo<QuoteTotals | null>(() => {
    if (Object.keys(lineDrafts).length === 0) return null;
    const merged: QuoteLineForMath[] = lines.map((l) => {
      const d = lineDrafts[l.id];
      return d ?? {
        quantity: l.quantity, unitPrice: l.unitPrice, taxable: l.taxable,
        customerVisible: l.customerVisible, recurrence: l.recurrence,
      };
    });
    return computeQuoteTotals(merged, quote.taxRate ? parseFloat(quote.taxRate) : null);
  }, [lineDrafts, lines, quote.taxRate]);
  const railOneTime = optimisticTotals?.oneTimeTotal ?? quote.oneTimeTotal;
  const railMonthly = optimisticTotals?.monthlyRecurringTotal ?? quote.monthlyRecurringTotal;
  const railAnnual = optimisticTotals?.annualRecurringTotal ?? quote.annualRecurringTotal;
  const railTax = optimisticTotals?.taxTotal ?? quote.taxTotal;
  const railTotal = optimisticTotals?.total ?? quote.total;
  const railDue = optimisticTotals?.dueOnAcceptanceTotal ?? quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal;

  // Apply an optimistic id ordering over a base list, but only if it's a clean
  // permutation (same membership) — otherwise fall back to the server order.
  const applyOrder = <T extends { id: string }>(base: T[], order: string[] | undefined): T[] => {
    if (!order) return base;
    const byId = new Map(base.map((x) => [x.id, x]));
    const ordered = order.map((id) => byId.get(id)).filter((x): x is T => x !== undefined);
    return ordered.length === base.length ? ordered : base;
  };

  const sortedBlocks = useMemo(
    () => applyOrder([...blocks].sort((a, b) => a.sortOrder - b.sortOrder), blockOrder ?? undefined),
    [blocks, blockOrder],
  );

  const linesForBlock = useCallback(
    (blockId: string) =>
      applyOrder(
        lines.filter((l) => l.blockId === blockId).sort((a, b) => a.sortOrder - b.sortOrder),
        lineOrder[blockId],
      ),
    [lines, lineOrder],
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
    // Guard the unit price too (parity with the inline edit path's commitPrice):
    // a negative/NaN price shouldn't depend on the server to reject it.
    const priceNum = Number(form.unitPrice);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      handleActionError(new Error('invalid price'), 'Enter a unit price of 0 or more.');
      return Promise.resolve(false);
    }
    return runScoped(`add-line:${blockId}`, async () => {
      await runAction({
        request: () => addManualLine(quote.id, {
          sourceType: 'manual',
          blockId,
          description: form.description.trim(),
          quantity: qtyNum,
          unitPrice: priceNum,
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
            unitPrice: priceNum,
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

  // Reorder a block one slot up/down. The optimistic order updates instantly on
  // every click (clicks accumulate — none are dropped while a PATCH is pending),
  // and a single trailing PATCH per burst sends the final full id list, which the
  // server renumbers 0..n-1. Each click stacks on `blockReorderBase` so a flurry
  // of clicks moves an item several slots before one request goes out. A failed
  // reorder clears the override and re-pulls the authoritative server order.
  const moveBlock = useCallback((block: QuoteBlock, direction: 'up' | 'down') => {
    const currentIds = blockReorderBase.current ?? sortedBlocks.map((b) => b.id);
    const idx = currentIds.indexOf(block.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= currentIds.length) return;
    const ids = [...currentIds];
    [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
    blockReorderBase.current = ids;
    setBlockOrder(ids); // optimistic, instant
    // Debounce the PATCH (not runScoped — its shared key would drop a second
    // reorder that fires while the first is still in flight; the debounce already
    // coalesces a burst). runAction surfaces failures; on failure we drop the
    // override and re-pull the authoritative order.
    if (blockReorderTimer.current) clearTimeout(blockReorderTimer.current);
    blockReorderTimer.current = setTimeout(() => {
      blockReorderTimer.current = null;
      void (async () => {
        try {
          await runAction({
            request: () => reorderBlocksApi(quote.id, { blockIds: ids }),
            errorFallback: 'Could not reorder blocks.',
            onUnauthorized: UNAUTHORIZED,
          });
          refresh();
        } catch (err) {
          handleActionError(err, 'Could not reorder blocks.');
          setBlockOrder(null);
          blockReorderBase.current = null;
          refresh();
        }
      })();
    }, 250);
  }, [sortedBlocks, quote.id, refresh]);

  const moveLine = useCallback((blockId: string, line: QuoteLine, direction: 'up' | 'down') => {
    const currentIds = lineReorderBase.current[blockId] ?? linesForBlock(blockId).map((l) => l.id);
    const idx = currentIds.indexOf(line.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= currentIds.length) return;
    const ids = [...currentIds];
    [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
    lineReorderBase.current = { ...lineReorderBase.current, [blockId]: ids };
    setLineOrder((m) => ({ ...m, [blockId]: ids })); // optimistic, instant
    const existing = lineReorderTimers.current[blockId];
    if (existing) clearTimeout(existing);
    lineReorderTimers.current[blockId] = setTimeout(() => {
      delete lineReorderTimers.current[blockId];
      void (async () => {
        try {
          await runAction({
            request: () => reorderLinesApi(quote.id, blockId, { lineIds: ids }),
            errorFallback: 'Could not reorder lines.',
            onUnauthorized: UNAUTHORIZED,
          });
          refresh();
        } catch (err) {
          handleActionError(err, 'Could not reorder lines.');
          setLineOrder((m) => { const n = { ...m }; delete n[blockId]; return n; });
          delete lineReorderBase.current[blockId];
          refresh();
        }
      })();
    }, 250);
  }, [linesForBlock, quote.id, refresh]);

  const hasRecurring = Number(railMonthly) > 0 || Number(railAnnual) > 0;

  return (
    <div className="space-y-6" data-testid="quote-editor">
      {canWrite && (
        <p className="text-xs text-muted-foreground" data-testid="quote-editor-autosave-hint">
          Changes save automatically as you edit. An amber outline marks an edit that hasn’t saved yet.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── blocks ─────────────────────────────────────────────────── */}
        <div
          className="space-y-4 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          ref={blocksColRef}
          tabIndex={-1}
        >
          {sortedBlocks.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground" data-testid="quote-blocks-empty">
              No content yet. Add a heading, rich text, or a pricing table below.
            </div>
          ) : (
            sortedBlocks.map((block, idx) => (
              <BlockCard
                key={block.id}
                block={block}
                quoteId={quote.id}
                lines={linesForBlock(block.id)}
                currency={currency}
                taxRate={quote.taxRate}
                catalog={catalog}
                isPending={isPending}
                canWrite={canWrite}
                ecActive={ecActive}
                isFirst={idx === 0}
                isLast={idx === sortedBlocks.length - 1}
                onAddCatalog={addCatalog}
                onImportAddDistributor={importAndAddDistributor}
                onAddManual={addManual}
                onEditLine={editLine}
                onEditBlock={editBlock}
                onMoveBlock={moveBlock}
                onMoveLine={(line, dir) => moveLine(block.id, line, dir)}
                onRemoveLine={setPendingLineRemove}
                onRemoveBlock={setPendingRemove}
                onLineDraft={setLineDraft}
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
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-live-totals">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live totals</h3>
            {/* One concise SR announcement covering every figure, so editing a
                recurring line (which doesn't move "due on acceptance") still tells
                a screen-reader user the totals recomputed. */}
            <p className="sr-only" role="status" data-testid="quote-totals-sr">
              {`Totals updated. One-time ${formatMoney(railOneTime, currency)}, `
                + `monthly recurring ${formatMoney(railMonthly, currency)}, `
                + `annual recurring ${formatMoney(railAnnual, currency)}`
                + (Number(railTax) > 0 ? `, tax ${formatMoney(railTax, currency)}` : '')
                + `, due on acceptance ${formatMoney(railDue, currency)}.`}
            </p>
            <dl className="space-y-2 text-sm tabular-nums">
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">One-time</dt>
                <dd data-testid="quote-total-onetime">{formatMoney(railOneTime, currency)}</dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">Monthly recurring</dt>
                <dd data-testid="quote-total-monthly">{formatMoney(railMonthly, currency)}<span className="text-xs text-muted-foreground">/mo</span></dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">Annual recurring</dt>
                <dd data-testid="quote-total-annual">{formatMoney(railAnnual, currency)}<span className="text-xs text-muted-foreground">/yr</span></dd>
              </div>
              {Number(railTax) > 0 && (
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">Tax</dt>
                  <dd>{formatMoney(railTax, currency)}</dd>
                </div>
              )}
            </dl>
            {canWrite && (
              <div className="mt-2 border-t pt-2">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="quote-tax-rate" className="flex items-center gap-2 text-sm text-muted-foreground">
                    Tax rate
                    {taxSaved && <span className="text-xs font-medium text-success" data-testid="quote-tax-saved">Saved</span>}
                  </label>
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
                  <p className="mt-1 text-xs text-destructive" id="quote-tax-rate-error" role="alert" data-testid="quote-tax-rate-error">{taxError}</p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">Applies to lines marked taxable.</p>
                )}
                <SrSaved show={taxSaved} />
              </div>
            )}
            <div className="mt-3 flex items-end justify-between gap-2 border-t pt-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Due on acceptance</span>
              {/* Visual figure only; the SR-only summary node above announces the
                  full set of totals on any change. */}
              <span
                className="min-w-0 break-words text-right text-2xl font-semibold tabular-nums"
                data-testid="quote-total-due-on-acceptance"
              >
                {formatMoney(railDue, currency)}
              </span>
            </div>
            {hasRecurring && (
              <>
                <div className="mt-2 flex items-baseline justify-between text-sm tabular-nums">
                  <span className="text-muted-foreground">First-period total (incl. recurring)</span>
                  <span className="font-medium" data-testid="quote-total-first-period">{formatMoney(railTotal, currency)}</span>
                </div>
                <RecurringBillingNote className="mt-2" testId="quote-totals-recurring-hint" />
              </>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
              <span className="flex items-center gap-2">
                {termsSaved && <span className="text-xs font-medium text-success" data-testid="quote-terms-saved">Saved</span>}
                <UnsavedBadge show={termsDirty} />
              </span>
            </div>
            <textarea
              value={terms}
              onChange={(e) => { setTerms(e.target.value); setTermsDirty(true); }}
              onBlur={() => { if (canWrite) void saveTerms(); }}
              disabled={!canWrite || isPending('terms')}
              data-testid="quote-terms"
              rows={3}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${termsDirty ? 'ring-1 ring-warning' : ''}`}
              placeholder="Payment terms, warranty clauses, etc."
            />
            <SrSaved show={termsSaved} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={() => {
          const block = pendingRemove;
          if (!block) return;
          // Keep the dialog open and awaiting (so isLoading shows "Processing…")
          // until the delete resolves, then close and move focus to a stable
          // anchor — the triggering Remove button is gone with the block.
          void (async () => {
            await removeBlock(block);
            setPendingRemove(null);
            blocksColRef.current?.focus();
          })();
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
          if (!line) return;
          void (async () => {
            await deleteLine(line.id);
            setPendingLineRemove(null);
            blocksColRef.current?.focus();
          })();
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
  block, quoteId, lines, currency, taxRate, catalog, isPending, canWrite, ecActive, isFirst, isLast, onAddCatalog, onImportAddDistributor, onAddManual, onEditLine, onEditBlock, onMoveBlock, onMoveLine, onRemoveLine, onRemoveBlock, onLineDraft,
}: {
  block: QuoteBlock;
  quoteId: string;
  lines: QuoteLine[];
  currency: string;
  taxRate: string | null;
  catalog: CatalogItem[];
  isPending: (key: string) => boolean;
  canWrite: boolean;
  ecActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  onAddCatalog: (blockId: string, item: CatalogItem) => void;
  onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void;
  onAddManual: (
    blockId: string,
    form: { description: string; quantity: string; unitPrice: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => Promise<boolean>;
  onEditLine: (lineId: string, body: LineUpdate) => Promise<boolean>;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
  onMoveBlock: (block: QuoteBlock, direction: 'up' | 'down') => void;
  onMoveLine: (line: QuoteLine, direction: 'up' | 'down') => void;
  onRemoveLine: (line: QuoteLine) => void;
  onRemoveBlock: (block: QuoteBlock) => void;
  onLineDraft: (lineId: string, draft: QuoteLineForMath | null) => void;
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
          <SrSaved show={blockSaved} />
        </span>
        {canWrite && (
          <div className="flex items-center gap-1">
            <MoveControls
              disabledUp={isFirst}
              disabledDown={isLast}
              onUp={() => onMoveBlock(block, 'up')}
              onDown={() => onMoveBlock(block, 'down')}
              labelUp="Move block up"
              labelDown="Move block down"
              testIdUp={`quote-block-move-up-${block.id}`}
              testIdDown={`quote-block-move-down-${block.id}`}
            />
            <button
              type="button"
              onClick={() => onRemoveBlock(block)}
              disabled={blockBusy}
              data-testid={`quote-block-remove-${block.id}`}
              className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
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
              className={`w-full rounded-md border bg-background px-2 py-1 text-lg font-semibold disabled:opacity-60 ${headingDraft.trim() !== heading ? 'ring-1 ring-warning' : ''}`}
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
              className={`w-full resize-y rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-60 ${richDraft !== html ? 'ring-1 ring-warning' : ''}`}
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
            {/* The 7-column row (description + 4 inline controls + total + actions)
                can't compress gracefully on a tablet, so the table keeps a sensible
                min width and the wrapper scrolls horizontally below that. */}
            <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm" data-testid={`quote-block-lines-${block.id}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Description</th>
                  <th className="px-2 py-2 text-right font-medium">Qty</th>
                  <th className="px-2 py-2 text-right font-medium">Unit</th>
                  <th className="px-2 py-2 font-medium">Recurrence</th>
                  <th
                    className="px-2 py-2 text-right font-medium"
                    title="Per-line tax. The header Tax total is authoritative and may differ by a rounding cent."
                  >
                    Tax
                  </th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-2 py-6 text-center text-sm text-muted-foreground">
                      No lines yet. Add a catalog item or a manual line below.
                    </td>
                  </tr>
                ) : (
                  lines.map((l, idx) =>
                    canWrite ? (
                      <EditableLineRow
                        key={l.id}
                        line={l}
                        currency={currency}
                        taxRate={taxRate}
                        busy={isPending(`line:${l.id}`)}
                        isFirst={idx === 0}
                        isLast={idx === lines.length - 1}
                        onEdit={onEditLine}
                        onMove={onMoveLine}
                        onRemove={onRemoveLine}
                        onDraft={onLineDraft}
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
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {lineTaxAmount(l.lineTotal, l.taxable, taxRate) === null ? '—' : formatMoney(lineTaxAmount(l.lineTotal, l.taxable, taxRate)!, currency)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.lineTotal, currency)}</td>
                        <td className="px-2 py-2 text-right" />
                      </tr>
                    ),
                  )
                )}
              </tbody>
            </table>
            </div>

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
  line, currency, taxRate, busy, isFirst, isLast, onEdit, onMove, onRemove, onDraft,
}: {
  line: QuoteLine;
  currency: string;
  taxRate: string | null;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (lineId: string, body: LineUpdate) => Promise<boolean>;
  onMove: (line: QuoteLine, direction: 'up' | 'down') => void;
  onRemove: (line: QuoteLine) => void;
  onDraft: (lineId: string, draft: QuoteLineForMath | null) => void;
}) {
  const [desc, setDesc] = useState(line.description);
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);
  // recurrence/taxable are committed on change (not blur); keep them in local
  // state so the control updates instantly rather than lagging until the
  // refresh() round-trip lands, and revert if the save fails.
  const [rec, setRec] = useState(line.recurrence);
  const [taxable, setTaxable] = useState(line.taxable);

  // Resync the typed fields from the server, but never over an edit in progress.
  // We track "has the user typed since the last commit?" rather than comparing
  // values: local state holds a raw string ('9.999') while the prop is a
  // formatted decimal ('10.00'), so a value comparison both (a) fails to re-adopt
  // a server-normalized value — leaving the row stuck amber-dirty showing a wrong
  // optimistic total when the server rounds — and (b) is fragile across formats.
  // The flag is set on keystroke and cleared once a commit settles, so:
  //   • a quiet/leading-edge refresh landing mid-type keeps the user's keystrokes
  //     ("edit qty→5, blur, type 7" never loses the 7), and
  //   • after the user stops editing, the next prop adopts the server's canonical
  //     value (e.g. 9.999 → 10.00), clearing the dirty ring and the optimism.
  const descEdited = useRef(false);
  const qtyEdited = useRef(false);
  const priceEdited = useRef(false);
  useEffect(() => { if (!descEdited.current) setDesc(line.description); }, [line.description]);
  useEffect(() => { if (!qtyEdited.current) setQty(line.quantity); }, [line.quantity]);
  useEffect(() => { if (!priceEdited.current) setPrice(line.unitPrice); }, [line.unitPrice]);
  // recurrence/taxable are committed on change (the PATCH resolves before the
  // refresh GET fires), so a stale resync can't race them — a plain resync wins.
  useEffect(() => { setRec(line.recurrence); }, [line.recurrence]);
  useEffect(() => { setTaxable(line.taxable); }, [line.taxable]);

  // Quiet "Saved" flash in place of the old per-field success toast.
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, []);
  const edit = useCallback(async (body: LineUpdate): Promise<boolean> => {
    const ok = await onEdit(line.id, body);
    if (ok) flashSaved();
    return ok;
  }, [onEdit, line.id, flashSaved]);
  // Per-field dirty cue (mirrors the terms/tax ring) so every editable surface
  // signals unsaved state the same way.
  const descDirty = desc.trim() !== line.description;
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

  // Report this row's effective values to the parent so the rail "Live totals"
  // recompute uses the same inputs. Emit null once nothing diverges, so the rail
  // reverts to the authoritative server figures; cleanup on unmount avoids a
  // phantom draft skewing the rail after a delete.
  const diverged = totalDiverged || taxable !== line.taxable || rec !== line.recurrence;
  useEffect(() => {
    onDraft(line.id, diverged
      ? { quantity: String(effQty), unitPrice: String(effPrice), taxable, customerVisible: line.customerVisible, recurrence: rec }
      : null);
  }, [onDraft, line.id, line.customerVisible, diverged, effQty, effPrice, taxable, rec]);
  // Clear this row's draft when it unmounts (e.g. removed) so the rail doesn't
  // keep a phantom override.
  useEffect(() => () => onDraft(line.id, null), [onDraft, line.id]);

  const commitDesc = () => {
    const next = desc.trim();
    descEdited.current = false; // committing — let the server value re-adopt next
    if (!next || next === line.description) { setDesc(line.description); return; }
    void edit({ description: next });
  };
  const commitQty = () => {
    const n = Number(qty);
    qtyEdited.current = false;
    if (!Number.isFinite(n) || n <= 0 || n === Number(line.quantity)) { setQty(line.quantity); return; }
    void edit({ quantity: n });
  };
  const commitPrice = () => {
    const n = Number(price);
    priceEdited.current = false;
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
            onChange={(e) => { setDesc(e.target.value); descEdited.current = true; }}
            onBlur={commitDesc}
            rows={2}
            disabled={busy}
            data-testid={`quote-line-desc-${line.id}`}
            className={`min-h-[2.25rem] w-full resize-y rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${descDirty ? 'ring-1 ring-warning' : ''}`}
          />
        </div>
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={qty}
          aria-label="Quantity"
          onChange={(e) => { setQty(e.target.value); qtyEdited.current = true; }}
          onBlur={commitQty}
          disabled={busy}
          data-testid={`quote-line-qty-${line.id}`}
          className={`h-9 w-16 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${qtyDirty ? 'ring-1 ring-warning' : ''}`}
        />
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={price}
          aria-label="Unit price"
          onChange={(e) => { setPrice(e.target.value); priceEdited.current = true; }}
          onBlur={commitPrice}
          disabled={busy}
          data-testid={`quote-line-price-${line.id}`}
          className={`h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 ${priceDirty ? 'ring-1 ring-warning' : ''}`}
        />
      </td>
      <td className="px-2 py-2">
        <select
          value={rec}
          aria-label="Billing frequency"
          onChange={(e) => {
            const next = e.target.value as QuoteLineRecurrence;
            setRec(next); // optimistic — revert if the save fails
            void edit({ recurrence: next }).then((ok) => { if (!ok) setRec(line.recurrence); });
          }}
          disabled={busy}
          data-testid={`quote-line-recurrence-${line.id}`}
          className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        >
          <option value="one_time">One-time</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
      </td>
      <td className="px-2 py-2 text-right">
        <label className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={taxable}
            aria-label="Taxable"
            onChange={(e) => {
              const next = e.target.checked;
              setTaxable(next); // optimistic — revert if the save fails
              void edit({ taxable: next }).then((ok) => { if (!ok) setTaxable(line.taxable); });
            }}
            disabled={busy}
            data-testid={`quote-line-taxable-${line.id}`}
          />
          <span className="tabular-nums" data-testid={`quote-line-tax-${line.id}`}>
            {displayTax === null ? '—' : formatMoney(displayTax, currency)}
          </span>
        </label>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        <span data-testid={`quote-line-total-${line.id}`}>{formatMoney(displayTotal, currency)}</span>
        {saved && <span className="ml-1 text-xs font-medium text-success" data-testid={`quote-line-saved-${line.id}`}>Saved</span>}
        <SrSaved show={saved} />
      </td>
      <td className="px-2 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <MoveControls
            disabledUp={isFirst}
            disabledDown={isLast}
            onUp={() => onMove(line, 'up')}
            onDown={() => onMove(line, 'down')}
            labelUp="Move line up"
            labelDown="Move line down"
            testIdUp={`quote-line-move-up-${line.id}`}
            testIdDown={`quote-line-move-down-${line.id}`}
          />
          <button
            type="button"
            onClick={() => onRemove(line)}
            disabled={busy}
            data-testid={`quote-line-remove-${line.id}`}
            className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
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
