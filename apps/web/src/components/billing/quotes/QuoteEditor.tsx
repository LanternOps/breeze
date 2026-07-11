import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Eye, EyeOff, Loader2, FolderInput } from 'lucide-react';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, handleActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import { formatPercent } from '@/lib/i18n/format';
import {
  addBlock,
  updateBlock,
  deleteBlock,
  addManualLine,
  addCatalogLine,
  updateLine,
  removeLine,
  moveLine as moveLineApi,
  reorderBlocks as reorderBlocksApi,
  reorderLines as reorderLinesApi,
  uploadQuoteImage,
  addQuoteImageFromUrl,
  quoteImageUrl,
} from '../../../lib/api/quotes';
import type { QuoteBlockInput } from '@breeze/shared';
import { computeQuoteTotals, computeQuoteProfit, computeLineTotal, markupPct, priceFromMarkup, toCents, fromCents, type QuoteLineForMath, type QuoteProfit, type QuoteTotals, type QuoteDepositType, type QuoteDepositConfig } from '@breeze/shared';
import { listCatalog, createCatalogItem, catalogItemImagePath, type CatalogItem } from '../../../lib/api/catalog';
import { ecExpressStatus, ecExpressImport, type EcProduct, type EcStatus, pax8Status, pax8Import, type Pax8Product, type Pax8PriceOption } from '../../../lib/api/distributors';
import CatalogItemPicker from '../../catalog/CatalogItemPicker';
import CatalogEnrichButton from '../../catalog/CatalogEnrichButton';
import PolishButton from '../../catalog/PolishButton';
import DistributorLookup from './DistributorLookup';
import Pax8ProductLookup from './Pax8ProductLookup';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { UnsavedBadge, RecurringBillingNote, MarginPanel } from '../billingUi';
import { useAuthedImage } from './useQuoteImage';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  type QuoteLineRecurrence,
  formatMoney,
  formatRecurrence,
  pctFromFraction,
  lineTaxAmount,
  lineTitle,
  lineBlurb,
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
  name: string | null;
  description: string | null;
  quantity: number;
  unitPrice: number;
  taxable: boolean;
  recurrence: QuoteLineRecurrence;
  unitCost: number | null;
  sku: string | null;
  partNumber: string | null;
  imageId: string | null;
  depositEligible: boolean;
}>;

interface Props {
  detail: QuoteDetailData;
  onChanged: () => void;
  /** Fires whenever the editor's save state changes: true while any mutation is
   *  in flight or a rail field (terms/tax) sits dirty. The workspace uses it to
   *  hold Send until the quote is quiescent, so the irreversible money-moment
   *  can't race a blur-save. */
  onPendingEditsChange?: (hasPendingEdits: boolean) => void;
}

// Per-field blur-saves are confirmed by the amber dirty-ring clearing (sighted)
// plus the SrSaved live region (screen readers) — NOT a toast. Toasts are
// reserved for action-level events the user can't otherwise see (Line added,
// Section removed, Proposal sent, Draft deleted), which fire their own
// runAction successMessage. Per-field toasts were a storm during editing and
// double-announced alongside SrSaved, so they were removed.

// A transient "Saved" cue for the right-rail blur-to-save fields (terms, tax).
// BlockCard and EditableLineRow replicate this same pattern inline rather than
// calling the hook. Returns the on-flag (drives the SR live region) and a
// trigger; clears its timer on unmount so a late fire can't setState a gone node.
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

// Visually-hidden polite live region — announces a transient "Saved" to screen
// readers without taking visual space, pairing with the dirty-ring clearing that
// sighted users see. The single per-field announcer (no toast), so SR users hear
// "Saved" once, not twice. testId lets tests assert the cue fired.
function SrSaved({ show, label = 'Saved', testId }: { show: boolean; label?: string; testId?: string }) {
  // role="status" already implies aria-live="polite" — don't double it.
  return <span role="status" className="sr-only" data-testid={testId}>{show ? label : ''}</span>;
}

// A field's save-state outline: amber while the edit is unsaved, a brief green
// pulse when it lands (driven by a ~1.5s saved-flash), nothing at rest. It's a
// box-shadow (ring), so it NEVER reflows neighbouring content — unlike the inline
// "Saved" text we tried before, which shifted layout as it appeared/disappeared.
// Pair with a constant `transition-shadow` on the field so both states fade.
function fieldRing(dirty: boolean, saved: boolean): string {
  return dirty ? 'ring-1 ring-warning' : saved ? 'ring-1 ring-success' : '';
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

export default function QuoteEditor({ detail, onChanged, onPendingEditsChange }: Props) {
  const { can } = usePermissions();
  const canWrite = can('quotes', 'write');
  // Cost/margin is a read affordance, not a write one: read-only users already see
  // the per-line internal cost bands (ReadonlyLineRow) + the toggle, so the rail
  // Margin summary is gated the same way QuoteDetail gates it — on quotes:read —
  // rather than on write, which would hide the aggregate while showing the parts.
  const canSeeMargin = can('quotes', 'read');
  // The per-line internal cost/markup/profit strip duplicates the rail's Margin
  // summary and roughly doubles the height of every line, so it's collapsed by
  // default; the rail summary stays always-on. Threaded down to each line row.
  const [showInternal, setShowInternal] = useState(false);
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
  // Distinguishes "catalog genuinely empty" from "catalog failed to load" so the
  // picker's empty state never tells a tech to re-create items they already have.
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  const [ecActive, setEcActive] = useState(false);
  const [pax8Active, setPax8Active] = useState(false);
  const [terms, setTerms] = useState(quote.termsAndConditions ?? '');
  const [termsDirty, setTermsDirty] = useState(false);
  // Editable quote title (shown in the workspace header, document, and PDF).
  const [title, setTitle] = useState(quote.title ?? '');
  const [titleDirty, setTitleDirty] = useState(false);
  // Quiet "Saved" cues for the blur-to-save title/terms fields, matching the
  // per-line/per-block cue so the whole editor speaks one save language.
  const [termsSaved, flashTermsSaved] = useSavedFlash();
  const [titleSaved, flashTitleSaved] = useSavedFlash();
  const canCatalogWrite = can('catalog', 'write');

  // Surface "is anything still saving / sitting dirty?" to the workspace so the
  // Send button can wait for quiescence. Pending covers every in-flight mutation
  // (line/block/terms/add/remove); the terms dirty flag covers the rail's
  // blur-to-save field. Per-line dirty state isn't lifted — clicking Send blurs
  // the focused field, whose commit lands in `pending` before the dialog opens.
  const hasPendingEdits = pending.size > 0 || termsDirty || titleDirty;
  useEffect(() => { onPendingEditsChange?.(hasPendingEdits); }, [hasPendingEdits, onPendingEditsChange]);
  // Clear on unmount so a stale `true` can't lock Send after the editor is gone
  // (e.g. the quote was just issued and the tab switched).
  useEffect(() => () => onPendingEditsChange?.(false), [onPendingEditsChange]);

  // ---- add-block form ------------------------------------------------------
  const [addType, setAddType] = useState<AddableBlockType>('heading');
  const [headingText, setHeadingText] = useState('');
  const [richText, setRichText] = useState('');
  const [tableLabel, setTableLabel] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageCaption, setImageCaption] = useState('');
  const [imageSource, setImageSource] = useState<'file' | 'url'>('file');
  const [imageUrl, setImageUrl] = useState('');

  useEffect(() => { setTerms(quote.termsAndConditions ?? ''); setTermsDirty(false); }, [quote.termsAndConditions]);
  useEffect(() => { setTitle(quote.title ?? ''); setTitleDirty(false); }, [quote.title]);

  // ---- deposit controls ----------------------------------------------------
  // Local mirrors of the persisted deposit config so the type select + percent
  // input update instantly and the rail's live deposit figure recomputes
  // mid-edit; both resync from the server after each blur-save's refresh().
  const [depositType, setDepositType] = useState<QuoteDepositType>(quote.depositType ?? 'none');
  const [depositPercentDraft, setDepositPercentDraft] = useState<string>(quote.depositPercent ?? '');
  useEffect(() => { setDepositType(quote.depositType ?? 'none'); }, [quote.depositType]);
  useEffect(() => { setDepositPercentDraft(quote.depositPercent ?? ''); }, [quote.depositPercent]);

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

  const saveTitle = useCallback(async () => {
    if (!titleDirty) return;
    const ok = await runScoped('title', async () => {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify({ title: title.trim() || null }),
        }),
        errorFallback: 'Could not save the title.',
        onUnauthorized: UNAUTHORIZED,
      });
      setTitleDirty(false);
      refresh();
    }, 'Could not save the title.');
    if (ok) flashTitleSaved();
  }, [titleDirty, title, quote.id, refresh, runScoped, flashTitleSaved]);

  // Persist a deposit-config change via the quote-header PATCH. runAction surfaces
  // the API's 400 DEPOSIT_* validation message (e.g. "Deposit must be less than the
  // amount due on acceptance") as the standard failure toast; runScoped clears the
  // pending key. refresh() re-pulls so the server-recomputed deposit_amount and the
  // authoritative depositDueTotal land in the rail.
  const saveDeposit = useCallback((patch: { depositType?: QuoteDepositType; depositPercent?: number | null }) =>
    runScoped('deposit', async () => {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify(patch),
        }),
        errorFallback: 'Could not update the deposit.',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not update the deposit.'),
  [quote.id, refresh, runScoped]);

  // Snap the local mirrors back to the server-persisted deposit config. Used when
  // a deposit PATCH is rejected (e.g. 400 DEPOSIT_NOT_BELOW_TOTAL or
  // DEPOSIT_NO_ELIGIBLE_LINES): runAction already toasts the API's reason, but the
  // optimistic type select / percent draft would otherwise keep showing a mode that
  // never saved — a dropdown that lies about persisted state until the next reload.
  const revertDepositMirrors = useCallback(() => {
    setDepositType(quote.depositType ?? 'none');
    setDepositPercentDraft(quote.depositPercent ?? '');
  }, [quote.depositType, quote.depositPercent]);

  const onDepositTypeChange = useCallback((next: QuoteDepositType) => {
    setDepositType(next);
    if (next === 'percent') {
      // Saving type='percent' with a null percent would 400 DEPOSIT_PERCENT_INVALID,
      // so defer the PATCH until a percent exists — persist immediately only when one
      // is already entered (the percent input's onBlur handles the first entry).
      const pct = depositPercentDraft.trim() === '' ? null : Number(depositPercentDraft);
      if (pct != null && Number.isFinite(pct)) {
        void saveDeposit({ depositType: 'percent', depositPercent: pct }).then((ok) => { if (!ok) revertDepositMirrors(); });
      }
    } else {
      void saveDeposit({ depositType: next }).then((ok) => { if (!ok) revertDepositMirrors(); });
    }
  }, [depositPercentDraft, saveDeposit, revertDepositMirrors]);

  const onDepositPercentBlur = useCallback(() => {
    if (depositType !== 'percent') return;
    const pct = depositPercentDraft.trim() === '' ? null : Number(depositPercentDraft);
    if (pct == null || !Number.isFinite(pct)) return;
    // Only fire when it actually differs from the persisted value (avoids a
    // redundant PATCH on a focus-through).
    if (quote.depositType === 'percent' && quote.depositPercent != null && Number(quote.depositPercent) === pct) return;
    void saveDeposit({ depositType: 'percent', depositPercent: pct }).then((ok) => { if (!ok) revertDepositMirrors(); });
  }, [depositType, depositPercentDraft, quote.depositType, quote.depositPercent, saveDeposit, revertDepositMirrors]);

  const loadCatalog = useCallback(async () => {
    const res = await listCatalog({ isActive: true, limit: 200 });
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { setCatalogLoadFailed(true); return; } // don't block the editor, but remember it failed
    const body = (await res.json().catch(() => null)) as { data?: CatalogItem[] } | null;
    if (!body) { setCatalogLoadFailed(true); return; }
    setCatalogLoadFailed(false);
    setCatalog((body.data ?? []).filter((i) => !i.isBundle));
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  // Partner default markup % (billing settings) — lets "Auto-fill from web"
  // pre-price a manual line at cost × (1 + default markup). Optional context:
  // org-scoped tokens or a failed fetch leave it null, and auto-fill then fills
  // the cost but leaves pricing to the user.
  const [defaultMarkupPct, setDefaultMarkupPct] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (!res.ok) return; // optional context; never block the editor
        const body = (await res.json().catch(() => null)) as { defaultMarkupPercent?: string | number | null } | null;
        const n = body?.defaultMarkupPercent == null ? NaN : Number(body.defaultMarkupPercent);
        if (!cancelled && Number.isFinite(n) && n >= 0) setDefaultMarkupPct(n);
      } catch { /* optional context — auto-fill simply won't pre-price */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadEcStatus = useCallback(async () => {
    if (!canCatalogWrite) { setEcActive(false); return; }
    const res = await ecExpressStatus();
    if (!res.ok) return; // optional context; never block the editor
    const body = (await res.json().catch(() => null)) as { data?: EcStatus } | null;
    setEcActive(Boolean(body?.data?.configured && body?.data?.enabled));
  }, [canCatalogWrite]);

  useEffect(() => { void loadEcStatus(); }, [loadEcStatus]);

  const loadPax8Status = useCallback(async () => {
    if (!canCatalogWrite) { setPax8Active(false); return; }
    try {
      const res = await pax8Status();
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as { data?: { configured?: boolean; enabled?: boolean } } | null;
      setPax8Active(Boolean(body?.data?.configured && body?.data?.enabled));
    } catch { /* leave hidden */ }
  }, [canCatalogWrite]);

  useEffect(() => { void loadPax8Status(); }, [loadPax8Status]);

  // Optimistic order overrides so a reorder reflects instantly instead of waiting
  // for the round-trip + (coalesced) refetch. Each is cleared the moment fresh
  // server data arrives (the prop array identity changes on refresh), so the
  // server order always wins once it lands; a failed reorder reverts immediately.
  const [blockOrder, setBlockOrder] = useState<string[] | null>(null);
  const [lineOrder, setLineOrder] = useState<Record<string, string[]>>({});
  // Cross-panel move override: lineId → target blockId. Layered UNDER lineOrder
  // (the override changes which panel a line filters into; lineOrder then fixes
  // its position within that panel). Cleared when fresh server data lands, same
  // as lineOrder.
  const [lineBlockOverride, setLineBlockOverride] = useState<Record<string, string>>({});
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
  useEffect(() => { setLineOrder({}); lineReorderBase.current = {}; setLineBlockOverride({}); }, [lines]);
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
        && (prev.unitCost ?? null) === (draft.unitCost ?? null)
        && prev.taxable === draft.taxable && prev.recurrence === draft.recurrence
        && (prev.depositEligible ?? false) === (draft.depositEligible ?? false)) return m;
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

  // The tax rate is fixed at quote creation (org tax settings → partner default)
  // and read-only in the editor, so the rail always computes with the committed
  // server rate.
  const effectiveRate = quote.taxRate ? parseFloat(quote.taxRate) : null;

  // The figures the rail renders: optimistic recompute when any line is mid-edit,
  // otherwise the authoritative server values.
  const optimisticTotals = useMemo<QuoteTotals | null>(() => {
    if (Object.keys(lineDrafts).length === 0) return null;
    const merged: QuoteLineForMath[] = lines.map((l) => {
      const d = lineDrafts[l.id];
      return d ?? {
        quantity: l.quantity, unitPrice: l.unitPrice, taxable: l.taxable,
        customerVisible: l.customerVisible, recurrence: l.recurrence,
      };
    });
    return computeQuoteTotals(merged, effectiveRate);
  }, [lineDrafts, lines, effectiveRate]);
  const railOneTime = optimisticTotals?.oneTimeTotal ?? quote.oneTimeTotal;
  const railMonthly = optimisticTotals?.monthlyRecurringTotal ?? quote.monthlyRecurringTotal;
  const railAnnual = optimisticTotals?.annualRecurringTotal ?? quote.annualRecurringTotal;
  const railTax = optimisticTotals?.taxTotal ?? quote.taxTotal;
  const railTotal = optimisticTotals?.total ?? quote.total;
  const railDue = optimisticTotals?.dueOnAcceptanceTotal ?? quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal;

  // Live deposit + category breakdown. Unlike the figures above (which fall back
  // to the server values at rest), these ALWAYS recompute from the current lines
  // (persisted + in-progress drafts) and the current deposit-control state, so the
  // "Deposit due" figure tracks a percent edit or a deposit-eligible toggle before
  // the blur-save round-trips. It uses the SAME shared computeQuoteTotals the server
  // recomputes with, so it can never settle to a different figure than the next GET
  // returns. Deposit-eligibility/itemType come from the persisted line unless a row
  // reported them in its draft (a deposit-eligibility toggle).
  const mergedLines = useMemo<QuoteLineForMath[]>(
    () => lines.map((l) => {
      const d = lineDrafts[l.id];
      return {
        quantity: d?.quantity ?? l.quantity,
        unitPrice: d?.unitPrice ?? l.unitPrice,
        unitCost: d?.unitCost ?? l.unitCost,
        taxable: d?.taxable ?? l.taxable,
        customerVisible: l.customerVisible,
        recurrence: d?.recurrence ?? l.recurrence,
        depositEligible: d?.depositEligible ?? l.depositEligible ?? false,
        itemType: d?.itemType ?? l.itemType ?? null,
      };
    }),
    [lines, lineDrafts],
  );
  const depositConfig = useMemo<QuoteDepositConfig>(
    () => ({
      type: depositType,
      percent: depositType === 'percent' && depositPercentDraft.trim() !== '' ? Number(depositPercentDraft) : null,
    }),
    [depositType, depositPercentDraft],
  );
  const liveDepositTotals = useMemo(
    () => computeQuoteTotals(mergedLines, effectiveRate, depositConfig),
    [mergedLines, effectiveRate, depositConfig],
  );
  const railDeposit = liveDepositTotals.depositDueTotal;
  const railBreakdown = liveDepositTotals.categoryBreakdown;
  const depositSelectMode = depositType === 'selected_lines';

  // The full "Live totals" sentence a screen reader would announce. The visible
  // figures above update live (per keystroke), but re-announcing this whole
  // sentence on every keypress is SR chatter, so the announcement is DEBOUNCED to
  // settle-time (below) — only the debounced copy feeds the role="status" node.
  const srSentence = useMemo(
    () =>
      `Totals updated. One-time ${formatMoney(railOneTime, currency)}, `
      + `monthly recurring ${formatMoney(railMonthly, currency)}, `
      + `annual recurring ${formatMoney(railAnnual, currency)}`
      + (Number(railTax) > 0 ? `, tax ${formatMoney(railTax, currency)}` : '')
      + `, due on acceptance ${formatMoney(railDue, currency)}.`,
    [railOneTime, railMonthly, railAnnual, railTax, railDue, currency],
  );

  // Debounced announcement: the status node's text only updates ~800ms after the
  // last change, so a screen reader announces the settled totals once per edit
  // burst instead of re-reading the sentence on every keystroke. The VISIBLE
  // numbers are unaffected — they still track `rail*` live. Starts empty so the
  // very first settle is the first announcement (a status node ignores its
  // initial content anyway).
  const SR_SETTLE_MS = 800;
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const srTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (srTimer.current) clearTimeout(srTimer.current);
    srTimer.current = setTimeout(() => setSrAnnouncement(srSentence), SR_SETTLE_MS);
    return () => { if (srTimer.current) clearTimeout(srTimer.current); };
  }, [srSentence]);

  // Internal net-profit summary for the rail's "Margin (internal)" block. Built
  // over the SAME merged line set as the totals: draft-or-persisted values plus
  // each line's cost (draft cost from a cost-only edit, else the persisted cost).
  // computeQuoteProfit does the cents math — pass it the raw read-model strings.
  const profit = useMemo<QuoteProfit>(
    () => computeQuoteProfit(lines.map((l) => {
      const d = lineDrafts[l.id];
      return {
        quantity: d?.quantity ?? l.quantity,
        unitPrice: d?.unitPrice ?? l.unitPrice,
        taxable: d?.taxable ?? l.taxable,
        customerVisible: l.customerVisible,
        recurrence: d?.recurrence ?? l.recurrence,
        unitCost: d?.unitCost ?? l.unitCost,
      };
    })),
    [lines, lineDrafts],
  );

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

  // The quote's pricing panels, in document order — the "Move to…" menu offers
  // every panel except the line's own. Label precedence mirrors the BlockCard
  // header: the author's table label, else "Pricing table N" by position.
  const pricingBlocks = useMemo(
    () => sortedBlocks.filter((b) => b.blockType === 'line_items'),
    [sortedBlocks],
  );
  const pricingBlockLabel = useCallback((b: QuoteBlock) => {
    const label = ((b.content?.label as string | undefined) ?? '').trim();
    if (label) return label;
    return `Pricing table ${pricingBlocks.findIndex((x) => x.id === b.id) + 1}`;
  }, [pricingBlocks]);

  const linesForBlock = useCallback(
    (blockId: string) =>
      applyOrder(
        lines
          .filter((l) => (lineBlockOverride[l.id] ?? l.blockId) === blockId)
          .sort((a, b) => a.sortOrder - b.sortOrder),
        lineOrder[blockId],
      ),
    [lines, lineOrder, lineBlockOverride],
  );

  // ---- add block -----------------------------------------------------------
  const submitBlock = useCallback(async () => {
    // Image blocks have no block-update endpoint, so the file must exist before
    // the block: upload it (POST /:id/images → { data: { imageId } }), then add
    // an image block with that imageId already in its content. Both steps go
    // through runAction so success/failure is always surfaced.
    if (addType === 'image') {
      // Resolve an imageId from EITHER an uploaded file or a pasted URL (the
      // server copies the bytes in — not a hotlink), then attach an image block.
      const source = imageSource;
      if (source === 'file' && !imageFile) return;
      if (source === 'url' && !imageUrl.trim()) return;
      // File path keeps the immediate client-side 5 MB check; for URLs the server
      // is the size authority (the fetched bytes aren't known here).
      if (source === 'file' && imageFile && imageFile.size > 5 * 1024 * 1024) {
        handleActionError(new Error('image too large'), 'Image must be 5 MB or smaller.');
        return;
      }
      await runScoped('add-block', async () => {
        const uploaded = await runAction<{ imageId: string }>({
          request: () => source === 'file'
            ? uploadQuoteImage(quote.id, imageFile!)
            : addQuoteImageFromUrl(quote.id, imageUrl.trim()),
          errorFallback: source === 'file'
            ? 'Could not upload the image.'
            : 'Could not fetch the image from that URL.',
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
          errorFallback: 'Image added, but adding the section failed.',
          successMessage: 'Image section added',
          onUnauthorized: UNAUTHORIZED,
        });
        setImageFile(null); setImageCaption(''); setImageUrl('');
        refresh();
      }, 'Could not add the image section.');
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
        errorFallback: 'Could not add the section.',
        successMessage: 'Section added',
        onUnauthorized: UNAUTHORIZED,
      });
      setHeadingText(''); setRichText(''); setTableLabel('');
      refresh();
    }, 'Could not add the section.');
  }, [addType, headingText, richText, tableLabel, imageFile, imageCaption, imageSource, imageUrl, quote.id, refresh, runScoped]);

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
        errorFallback: 'Could not remove the section.',
        successMessage: 'Section removed',
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, 'Could not remove the section.'),
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

  const importAndAddPax8 = useCallback((blockId: string, product: Pax8Product, term: Pax8PriceOption, sellPrice: number) =>
    runScoped(`add-line:${blockId}`, async () => {
      let item = product.vendorSku ? await resolveCatalogBySku(product.vendorSku) : null;
      if (!item) {
        item = await runAction<CatalogItem>({
          request: () => pax8Import({
            product: {
              source: 'pax8', pax8ProductId: product.pax8ProductId, name: product.name,
              vendorName: product.vendorName, vendorSku: product.vendorSku,
              commitmentTerm: term.commitmentTerm, billingTerm: term.billingTerm,
              partnerBuyRate: term.partnerBuyRate, currency: term.currencyCode, raw: product.raw,
            },
            item: {
              name: product.name.slice(0, 255), sku: product.vendorSku, description: product.shortDescription,
              unitPrice: sellPrice, costBasis: term.partnerBuyRate != null ? Number(term.partnerBuyRate) : null,
            },
            // Match the EC Express add-line and the settings drawers: web-enrich
            // the raw vendor listing on import (best-effort; falls back to raw).
            aiCleanup: true,
          }),
          errorFallback: 'Could not import the Pax8 product.',
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: CatalogItem }).data,
        });
      }
      await doAddCatalog(blockId, item);
      void loadCatalog();
    }, 'Could not add the Pax8 product.'),
  [doAddCatalog, resolveCatalogBySku, loadCatalog, runScoped]);

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
            // Tidy the raw distributor title into a readable name + description
            // server-side (best-effort; falls back to the raw values).
            aiCleanup: true,
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
    form: { name: string; description: string; quantity: string; unitPrice: string; cost: string; sku: string; partNumber: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => {
    // A line needs at least a title (name) or a description (mirrors the API refine).
    if (!form.name.trim() && !form.description.trim()) return Promise.resolve(false);
    // Guard qty 0 / non-numeric here too — the inline edit path already does, and
    // a silent $0-quantity line is a real footgun on the add path.
    const qtyNum = Number(form.quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || !Number.isInteger(qtyNum)) {
      handleActionError(new Error('invalid quantity'), 'Enter a whole-number quantity greater than 0.');
      return Promise.resolve(false);
    }
    // Guard the unit price too (parity with the inline edit path's commitPrice):
    // a negative/NaN price shouldn't depend on the server to reject it.
    const priceNum = Number(form.unitPrice);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      handleActionError(new Error('invalid price'), 'Enter a unit price of 0 or more.');
      return Promise.resolve(false);
    }
    // Cost is optional, but a non-empty entry must be valid — reject it the same way
    // commitCost does inline, rather than silently coercing bad input to null (which
    // would drop the user's cost and understate the margin with no feedback).
    const costEmpty = form.cost.trim() === '';
    const costNum = Number(form.cost);
    if (!costEmpty && (!Number.isFinite(costNum) || costNum < 0)) {
      handleActionError(new Error('invalid cost'), 'Enter a cost of 0 or more.');
      return Promise.resolve(false);
    }
    return runScoped(`add-line:${blockId}`, async () => {
      await runAction({
        request: () => addManualLine(quote.id, {
          sourceType: 'manual',
          blockId,
          name: form.name.trim() || null,
          description: form.description.trim() || null,
          quantity: qtyNum,
          unitPrice: priceNum,
          unitCost: costEmpty ? null : costNum,
          sku: form.sku.trim() || null,
          partNumber: form.partNumber.trim() || null,
          taxable: form.taxable,
          customerVisible: true,
          recurrence: form.recurrence,
          // Manual lines are never deposit-eligible by default (no catalog itemType
          // to infer hardware from); the user flags it later in the line editor.
          depositEligible: false,
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
            name: form.name.trim() || form.description.trim(),
            description: form.description.trim() || null,
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
  // `scopeKey` narrows the pending key to one field (`line:<id>:<field>`) so a
  // slow qty save never disables the price input mid-tab (the scoped-pending
  // backport from InvoiceEditor); omitting it falls back to the whole row.
  const editLine = useCallback((lineId: string, body: LineUpdate, scopeKey?: string) =>
    runScoped(scopeKey ?? `line:${lineId}`, async () => {
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
        errorFallback: 'Could not update the section.',
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
            errorFallback: 'Could not reorder sections.',
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

  // Cross-panel move: optimistic on both panels at once (the line leaves its
  // source table and appends to the target, bundle children in tow), committed
  // via the dedicated move endpoint. No debounce — unlike the chevrons, a move
  // is one discrete action. Failure reverts both panels and re-pulls the
  // authoritative server order (same recovery shape as moveBlock/moveLine).
  const moveLineTo = useCallback((line: QuoteLine, targetBlockId: string) => {
    const sourceBlockId = line.blockId;
    if (!sourceBlockId || sourceBlockId === targetBlockId) return;
    // A pending chevron-reorder PATCH for either panel would fire with a stale
    // id list that still contains the moved line — the server rejects it
    // (REORDER_IDS_MISMATCH) and its catch handler would then wipe this move's
    // optimistic order. Cancel those timers; the move's refresh() re-syncs
    // order from the server anyway.
    for (const bid of [sourceBlockId, targetBlockId]) {
      const t = lineReorderTimers.current[bid];
      if (t) { clearTimeout(t); delete lineReorderTimers.current[bid]; }
    }
    const movedIds = [line.id, ...lines.filter((l) => l.parentLineId === line.id).map((l) => l.id)];
    const sourceIds = (lineReorderBase.current[sourceBlockId] ?? linesForBlock(sourceBlockId).map((l) => l.id))
      .filter((id) => !movedIds.includes(id));
    const targetIds = [
      ...(lineReorderBase.current[targetBlockId] ?? linesForBlock(targetBlockId).map((l) => l.id))
        .filter((id) => !movedIds.includes(id)),
      ...movedIds,
    ];
    lineReorderBase.current = { ...lineReorderBase.current, [sourceBlockId]: sourceIds, [targetBlockId]: targetIds };
    setLineBlockOverride((m) => {
      const n = { ...m };
      for (const id of movedIds) n[id] = targetBlockId;
      return n;
    });
    setLineOrder((m) => ({ ...m, [sourceBlockId]: sourceIds, [targetBlockId]: targetIds }));
    void (async () => {
      try {
        await runAction({
          request: () => moveLineApi(quote.id, line.id, { blockId: targetBlockId }),
          errorFallback: 'Could not move the line.',
          successMessage: 'Line moved',
          onUnauthorized: UNAUTHORIZED,
        });
        refresh();
      } catch (err) {
        handleActionError(err, 'Could not move the line.');
        setLineBlockOverride((m) => {
          const n = { ...m };
          for (const id of movedIds) delete n[id];
          return n;
        });
        setLineOrder((m) => { const n = { ...m }; delete n[sourceBlockId]; delete n[targetBlockId]; return n; });
        delete lineReorderBase.current[sourceBlockId];
        delete lineReorderBase.current[targetBlockId];
        refresh();
      }
    })();
  }, [lines, linesForBlock, quote.id, refresh]);

  const hasRecurring = Number(railMonthly) > 0 || Number(railAnnual) > 0;

  return (
    <div className="space-y-6" data-testid="quote-editor">
      {/* The autosave hint is writer-only, but the cost/margin toggle is offered to
          everyone who can see the editor: read-only users also have per-line cost
          bands and deserve the same collapse control (ml-auto keeps it right-aligned
          whether or not the hint renders). */}
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && (
          <p className="text-xs text-muted-foreground" data-testid="quote-editor-autosave-hint">
            Changes save automatically as you edit. An amber outline marks an edit that hasn’t saved yet.
          </p>
        )}
        <button
          type="button"
          onClick={() => setShowInternal((v) => !v)}
          aria-pressed={showInternal}
          data-testid="quote-editor-toggle-internal"
          className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted ${showInternal ? 'border-primary/40 bg-primary/10 text-primary' : ''}`}
        >
          {showInternal ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
          {showInternal ? 'Hide cost & margin' : 'Show cost & margin'}
        </button>
      </div>
      {canWrite && (
        <div className="max-w-xl">
          <label htmlFor="quote-title" className="mb-1 block text-xs text-muted-foreground">Quote title</label>
          <input
            id="quote-title"
            type="text"
            value={title}
            maxLength={200}
            placeholder="e.g. Office network refresh"
            onChange={(e) => { setTitle(e.target.value); setTitleDirty(true); }}
            onBlur={() => void saveTitle()}
            disabled={isPending('title')}
            data-testid="quote-title"
            className={`h-9 w-full rounded-md border bg-background px-3 text-sm font-medium transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(titleDirty, titleSaved)}`}
          />
          <SrSaved show={titleSaved} testId="quote-title-saved" />
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── blocks ─────────────────────────────────────────────────── */}
        {/* min-w-0: this 1fr grid track holds a pricing table with min-w-[640px]
            inside an overflow-x-auto wrapper. Without min-w-0 the track refuses to
            shrink below the table's min-content and the whole editor blows out to
            ~758px on a phone (page-level horizontal scroll). */}
        <div
          className="min-w-0 space-y-4 rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                catalogLoadFailed={catalogLoadFailed}
                isPending={isPending}
                canWrite={canWrite}
                showInternal={showInternal}
                depositSelectMode={depositSelectMode}
                ecActive={ecActive}
                pax8Active={pax8Active}
                defaultMarkupPct={defaultMarkupPct}
                isFirst={idx === 0}
                isLast={idx === sortedBlocks.length - 1}
                onAddCatalog={addCatalog}
                onImportAddDistributor={importAndAddDistributor}
                onImportAddPax8={importAndAddPax8}
                onAddManual={addManual}
                onEditLine={editLine}
                onEditBlock={editBlock}
                onMoveBlock={moveBlock}
                onMoveLine={(line, dir) => moveLine(block.id, line, dir)}
                onMoveLineToBlock={moveLineTo}
                moveTargets={
                  block.blockType === 'line_items'
                    ? pricingBlocks.filter((b) => b.id !== block.id).map((b) => ({ id: b.id, label: pricingBlockLabel(b) }))
                    : []
                }
                onRemoveLine={setPendingLineRemove}
                onRemoveBlock={setPendingRemove}
                onLineDraft={setLineDraft}
              />
            ))
          )}

          {/* Add block */}
          {canWrite && (
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-add-block">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add section</h3>
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
                <div className="inline-flex rounded-md border p-0.5 text-xs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={imageSource === 'file'}
                    onClick={() => { setImageSource('file'); setImageUrl(''); }}
                    data-testid="quote-block-image-source-file"
                    className={`rounded px-3 py-1 font-medium ${imageSource === 'file' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >
                    Upload file
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={imageSource === 'url'}
                    onClick={() => { setImageSource('url'); setImageFile(null); }}
                    data-testid="quote-block-image-source-url"
                    className={`rounded px-3 py-1 font-medium ${imageSource === 'url' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >
                    From URL
                  </button>
                </div>
                {imageSource === 'file' ? (
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
                    data-testid="quote-block-image-file"
                    className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium"
                  />
                ) : (
                  <input
                    type="url"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://example.com/photo.png"
                    data-testid="quote-block-image-url"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                )}
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
                  isPending('add-block') ||
                  (addType === 'heading' && !headingText.trim()) ||
                  (addType === 'rich_text' && !richText.trim()) ||
                  (addType === 'image' && imageSource === 'file' && !imageFile) ||
                  (addType === 'image' && imageSource === 'url' && !imageUrl.trim())
                }
                data-testid="quote-add-block-submit"
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {addType === 'image'
                  ? (imageSource === 'url' ? 'Fetch & add image' : 'Upload & add image')
                  : 'Add section'}
              </button>
            </div>
          </div>
          )}
        </div>

        {/* ── live totals + terms ────────────────────────────────────── */}
        {/* Sticky on lg so the totals you're building against stay visible while
            scrolling the blocks; on narrow widths this column stacks below. */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-live-totals">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live totals</h3>
            {/* One concise SR announcement covering every figure, so editing a
                recurring line (which doesn't move "due on acceptance") still tells
                a screen-reader user the totals recomputed. Debounced to settle-time
                (srAnnouncement) so rapid edits don't machine-gun the same sentence
                at the screen reader — the visible figures below stay live. */}
            <p className="sr-only" role="status" data-testid="quote-totals-sr">
              {srAnnouncement}
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
            {/* Per-category subtotals (hardware / software / service / other) — only
                worth showing once the quote spans more than one category. Mirrors the
                customer document + PDF breakdown so the builder sees what the customer will. */}
            {railBreakdown.length > 1 && (
              <div className="mt-2 space-y-0.5 border-t pt-2 text-sm text-muted-foreground" data-testid="quote-category-breakdown">
                {railBreakdown.map((b) => (
                  <div key={b.category} className="flex justify-between gap-2">
                    <span className="capitalize">{b.category}</span>
                    <span className="tabular-nums">
                      {[
                        Number(b.oneTimeTotal) > 0 ? formatMoney(b.oneTimeTotal, currency) : null,
                        Number(b.monthlyTotal) > 0 ? `${formatMoney(b.monthlyTotal, currency)}/mo` : null,
                        Number(b.annualTotal) > 0 ? `${formatMoney(b.annualTotal, currency)}/yr` : null,
                      ].filter(Boolean).join(' + ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {canSeeMargin && <MarginPanel profit={profit} currency={currency} />}
            {/* Read-only: the rate is resolved at quote creation (org tax settings,
                falling back to the partner default) and isn't editable per-quote. */}
            <div className="mt-2 border-t pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Tax rate</span>
                <span className="text-sm tabular-nums" data-testid="quote-tax-rate">
                  {quote.taxRate ? `${pctFromFraction(quote.taxRate)}%` : '—'}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Applies to lines marked taxable. Set in the organization&rsquo;s tax settings.
              </p>
            </div>
            {/* Deposit controls — writer-only. Selecting a type saves it (the server
                surfaces DEPOSIT_* validation as a toast); the percent input blur-saves.
                The live "Deposit due" figure recomputes from the same shared math. */}
            {canWrite && (
              <div className="mt-2 space-y-2 border-t pt-2" data-testid="quote-deposit-controls">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="quote-deposit-type" className="text-sm text-muted-foreground">Deposit</label>
                  <select
                    id="quote-deposit-type"
                    value={depositType}
                    onChange={(e) => onDepositTypeChange(e.target.value as QuoteDepositType)}
                    disabled={isPending('deposit')}
                    data-testid="quote-deposit-type"
                    className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                  >
                    <option value="none">No deposit</option>
                    <option value="percent">Percent of due-on-acceptance</option>
                    <option value="selected_lines">Selected lines</option>
                  </select>
                </div>
                {depositType === 'percent' && (
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="quote-deposit-percent" className="text-sm text-muted-foreground">Percent</label>
                    <div className="flex items-center gap-1">
                      <input
                        id="quote-deposit-percent"
                        type="number" min={0.01} max={99.99} step={0.01}
                        value={depositPercentDraft}
                        onChange={(e) => setDepositPercentDraft(e.target.value)}
                        onBlur={onDepositPercentBlur}
                        disabled={isPending('deposit')}
                        data-testid="deposit-percent-input"
                        className="h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                      />
                      <span className="text-sm text-muted-foreground">%</span>
                    </div>
                  </div>
                )}
                {depositType === 'selected_lines' && (
                  <p className="text-xs text-muted-foreground">
                    Check the deposit-eligible one-time lines in each pricing table.
                  </p>
                )}
                {railDeposit != null && Number(railDeposit) > 0 && (
                  <div className="flex items-baseline justify-between gap-2 text-sm font-medium" data-testid="deposit-due-figure">
                    <span>Deposit due</span>
                    <span className="tabular-nums">{formatMoney(railDeposit, currency)}</span>
                  </div>
                )}
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

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
              <span className="flex items-center gap-2">
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
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(termsDirty, termsSaved)}`}
              placeholder="Payment terms, warranty clauses, etc."
            />
            <SrSaved show={termsSaved} testId="quote-terms-saved" />
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
          // until the delete resolves. On failure (already toasted by runAction)
          // leave the dialog open so the user can retry or cancel — don't close as
          // if it worked while the block is still there. On success, close and move
          // focus to a stable anchor — the triggering Remove button is gone.
          void (async () => {
            if (!(await removeBlock(block))) return;
            setPendingRemove(null);
            blocksColRef.current?.focus();
          })();
        }}
        isLoading={pendingRemove ? isPending(`block:${pendingRemove.id}`) : false}
        title="Remove section"
        message={
          pendingRemove?.blockType === 'line_items' && linesForBlock(pendingRemove.id).length > 0
            ? `This removes the pricing table and its ${linesForBlock(pendingRemove.id).length} line item${
                linesForBlock(pendingRemove.id).length === 1 ? '' : 's'
              }. This can't be undone.`
            : "This removes this section. This can't be undone."
        }
        confirmLabel="Remove section"
        confirmTestId="quote-block-remove-confirm"
      />

      <ConfirmDialog
        open={pendingLineRemove !== null}
        onClose={() => setPendingLineRemove(null)}
        onConfirm={() => {
          const line = pendingLineRemove;
          if (!line) return;
          // Leave the dialog open on failure (already toasted) so the user can
          // retry; only close + restore focus once the line is actually gone.
          void (async () => {
            if (!(await deleteLine(line.id))) return;
            setPendingLineRemove(null);
            blocksColRef.current?.focus();
          })();
        }}
        isLoading={pendingLineRemove ? isPending(`line:${pendingLineRemove.id}`) : false}
        title="Remove line"
        message={
          pendingLineRemove
            ? `This removes "${lineTitle(pendingLineRemove) || 'this line'}" from the quote. This can't be undone.`
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
  block, quoteId, lines, currency, taxRate, catalog, catalogLoadFailed, isPending, canWrite, showInternal, depositSelectMode, ecActive, pax8Active, defaultMarkupPct, isFirst, isLast, onAddCatalog, onImportAddDistributor, onImportAddPax8, onAddManual, onEditLine, onEditBlock, onMoveBlock, onMoveLine, onRemoveLine, onRemoveBlock, onLineDraft,
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
  isFirst: boolean;
  isLast: boolean;
  onAddCatalog: (blockId: string, item: CatalogItem) => void;
  onImportAddDistributor: (blockId: string, product: EcProduct, sellPrice: number) => void;
  onImportAddPax8: (blockId: string, product: Pax8Product, term: Pax8PriceOption, sellPrice: number) => void;
  onAddManual: (
    blockId: string,
    form: { name: string; description: string; quantity: string; unitPrice: string; cost: string; sku: string; partNumber: string; taxable: boolean; recurrence: QuoteLineRecurrence; saveToCatalog: boolean },
  ) => Promise<boolean>;
  onEditLine: (lineId: string, body: LineUpdate, scopeKey?: string) => Promise<boolean>;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
  onMoveBlock: (block: QuoteBlock, direction: 'up' | 'down') => void;
  onMoveLine: (line: QuoteLine, direction: 'up' | 'down') => void;
  onRemoveLine: (line: QuoteLine) => void;
  onRemoveBlock: (block: QuoteBlock) => void;
  onLineDraft: (lineId: string, draft: QuoteLineForMath | null) => void;
  /** Other pricing panels this block's lines can move to (empty → control hidden). */
  moveTargets: { id: string; label: string }[];
  onMoveLineToBlock: (line: QuoteLine, targetBlockId: string) => void;
}) {
  // Pending state scoped to this block: editing/removing this block, or adding a
  // line to it, never disables anything in a sibling block.
  const blockBusy = isPending(`block:${block.id}`);
  const addLineBusy = isPending(`add-line:${block.id}`);

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
  useEffect(() => {
    setHeadingDraft((cur) => (cur === lastHeading.current ? heading : cur));
    lastHeading.current = heading;
  }, [heading]);
  useEffect(() => {
    setRichDraft((cur) => (cur === lastHtml.current ? html : cur));
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
    if (await onEditBlock(block, { html: richDraft })) flashSaved();
  };
  // Rename a pricing table. An empty label is a valid clear (the document falls
  // back to its "Pricing" default), so — unlike heading — we commit the trimmed
  // value even when blank, only skipping when nothing actually changed.
  const commitLabel = async () => {
    const label = labelDraft.trim();
    if (label === tableLabel.trim()) { setLabelDraft(tableLabel); return; }
    if (await onEditBlock(block, label ? { label } : {})) flashSaved();
  };

  const submitManual = async () => {
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
    <div className="rounded-lg border bg-card shadow-xs" data-testid={`quote-block-${block.id}`}>
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {BLOCK_TYPE_LABELS[block.blockType] ?? block.blockType}
          {isTable && tableLabel ? ` · ${tableLabel}` : ''}
          <SrSaved show={blockSaved} testId={`quote-block-saved-${block.id}`} />
        </span>
        {canWrite && (
          <div className="flex items-center gap-1">
            <MoveControls
              disabledUp={isFirst}
              disabledDown={isLast}
              onUp={() => onMoveBlock(block, 'up')}
              onDown={() => onMoveBlock(block, 'down')}
              labelUp="Move section up"
              labelDown="Move section down"
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
              className={`w-full rounded-md border bg-background px-2 py-1 text-lg font-semibold transition-shadow disabled:opacity-60 ${fieldRing(headingDraft.trim() !== heading, blockSaved)}`}
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
              className={`w-full resize-y rounded-md border bg-background px-2 py-1 text-sm transition-shadow disabled:opacity-60 ${fieldRing(richDraft !== html, blockSaved)}`}
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
            <p className="text-sm text-muted-foreground">Image section (rendered in the PDF).</p>
          )
        )}

        {isTable && (
          <div className="space-y-3">
            {canWrite && (
              <input
                type="text"
                value={labelDraft}
                aria-label="Pricing table label"
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={() => void commitLabel()}
                disabled={blockBusy}
                placeholder="Table label (optional, e.g. Monthly services)"
                data-testid={`quote-block-table-label-input-${block.id}`}
                className={`h-9 w-full rounded-md border bg-background px-3 text-sm font-semibold transition-shadow disabled:opacity-60 ${fieldRing(labelDraft.trim() !== tableLabel.trim(), blockSaved)}`}
              />
            )}
            {/* The 7-column row (description + 4 inline controls + total + actions)
                can't compress gracefully on a tablet, so the table keeps a sensible
                min width and the wrapper scrolls horizontally below that. */}
            <div className="overflow-x-auto rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label="Pricing table — scroll sideways for tax, total and row actions" tabIndex={0}>
            <table className="w-full min-w-[640px] text-sm" data-testid={`quote-block-lines-${block.id}`}>
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Item</th>
                  <th className="px-2 py-2 text-right font-medium">Qty</th>
                  <th className="px-2 py-2 text-right font-medium">Unit price</th>
                  <th className="px-2 py-2 font-medium">Recurrence</th>
                  <th className="px-2 py-2 text-center font-medium">Taxable</th>
                  <th
                    className="px-2 py-2 text-right font-medium"
                    title="Per-line tax. The header Tax total is authoritative and may differ by a rounding cent."
                  >
                    Tax
                  </th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  {/* Row-actions column is pinned to the right edge so Up/Down/Remove
                      stay reachable when the wide table scrolls horizontally. */}
                  <th className="sticky right-0 border-l bg-card px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-2 py-6 text-center text-sm text-muted-foreground">
                      No lines yet. Add a catalog item or a manual line below.
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
              </tbody>
            </table>
            </div>

            {/* Add line to this pricing table */}
            {canWrite && (
            <div className="rounded-md border bg-background/40 p-3" data-testid={`quote-block-add-line-${block.id}`}>
              <div className="mb-2 flex gap-2">
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
                    {m === 'catalog' ? 'Catalog item' : m === 'manual' ? 'Manual line' : m === 'distributor' ? 'Search distributor' : 'Search Pax8'}
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
                      Couldn&apos;t load the catalog. Reopen the editor to retry — your existing items are safe.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground" data-testid={`quote-catalog-empty-${block.id}`}>
                      No catalog items.{' '}
                      <a href="/settings/catalog" className="underline hover:text-foreground">Add some in Product Catalog</a>.
                    </p>
                  )
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
                  <div className="flex flex-wrap items-center gap-2">
                    <CatalogEnrichButton
                      idSuffix={`quote-${block.id}`}
                      helpText={
                        defaultMarkupPct != null
                          ? `Searches the web, fills name, description and tax, estimates your cost, and prices the line at your default ${String(Number(defaultMarkupPct))}% markup.`
                          : 'Searches the web and fills name, description, tax, and an estimated cost. You set the price.'
                      }
                      guidanceSuffix={null}
                      onApply={(result) => {
                        const d = result.draft;
                        setName(d.name);
                        setDesc(d.description ?? '');
                        setTaxable(d.taxable);
                        const filled = ['name', 'description', d.taxable ? 'taxable: on' : 'taxable: off'];
                        // Pre-fill cost/price only into untouched fields — auto-fill
                        // must never overwrite a number the user already typed (read
                        // the refs: the lookup takes seconds and state may have moved).
                        if (result.estimatedCost != null && costRef.current.trim() === '') {
                          const c = result.estimatedCost.toFixed(2);
                          setCost(c);
                          filled.push(`estimated cost ${formatMoney(Number(c), currency)}`);
                          if (defaultMarkupPct != null && (priceRef.current.trim() === '' || Number(priceRef.current) === 0)) {
                            const p = priceFromMarkup(c, defaultMarkupPct);
                            setPrice(p);
                            setMarkup(String(Number(defaultMarkupPct)));
                            priceAuthority.current = 'markup';
                            filled.push(`price ${formatMoney(Number(p), currency)} (default ${String(Number(defaultMarkupPct))}% markup)`);
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
                      <span className="font-medium text-foreground">Auto-filled:</span> {autoFilled.join(' · ')}. Review and adjust before adding.
                    </p>
                  )}
                  <input
                    type="text" placeholder="Name" aria-label="Line name" value={name}
                    onChange={(e) => setName(e.target.value)}
                    data-testid={`quote-manual-name-${block.id}`}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_70px_90px_110px]">
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">Description (optional)</span>
                      <textarea
                        value={desc}
                        onChange={(e) => setDesc(e.target.value)}
                        rows={2}
                        data-testid={`quote-manual-desc-${block.id}`}
                        className="min-h-9 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">Qty</span>
                      <input
                        type="number" min="1" step="1" value={qty}
                        onChange={(e) => setQty(e.target.value)}
                        data-testid={`quote-manual-qty-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">Unit price</span>
                      <input
                        type="number" min="0" step="0.01" value={price}
                        onChange={(e) => onPriceChange(e.target.value)}
                        data-testid={`quote-manual-price-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">Billing</span>
                      <select
                        value={recurrence}
                        onChange={(e) => setRecurrence(e.target.value as QuoteLineRecurrence)}
                        data-testid={`quote-manual-recurrence-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      >
                        <option value="one_time">One-time</option>
                        <option value="monthly">Monthly</option>
                        <option value="annual">Annual</option>
                      </select>
                    </label>
                  </div>
                  {/* Internal-only cost & identity fields (never shown to the customer). */}
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Internal · not shown to customer</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_110px_100px]">
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">SKU (optional)</span>
                      <input
                        type="text" value={sku}
                        onChange={(e) => setSku(e.target.value)}
                        data-testid={`quote-manual-sku-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">Part # (optional)</span>
                      <input
                        type="text" value={partNumber}
                        onChange={(e) => setPartNumber(e.target.value)}
                        data-testid={`quote-manual-partnumber-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">Unit cost</span>
                      <input
                        type="number" min="0" step="0.01" value={cost}
                        onChange={(e) => onCostChange(e.target.value)}
                        data-testid={`quote-manual-cost-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">Markup %</span>
                      <input
                        type="number" step="0.1" value={markup}
                        onChange={(e) => onMarkupChange(e.target.value)}
                        disabled={cost.trim() === ''}
                        // Sighted users can see the empty cost field; AT users can't —
                        // mirror the edit-row band's disabled-reason wiring.
                        title={cost.trim() === '' ? 'Enter a cost first to set markup %' : undefined}
                        aria-describedby={cost.trim() === '' ? `quote-manual-markup-hint-${block.id}` : undefined}
                        data-testid={`quote-manual-markup-${block.id}`}
                        className="h-9 w-full rounded-md border bg-background px-3 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                      />
                      {cost.trim() === '' && <span id={`quote-manual-markup-hint-${block.id}`} className="sr-only">Enter a cost first to set markup %.</span>}
                    </label>
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
                      // A line needs a name OR a description (mirrors the API + addManual
                      // refine). Gating on description alone silently blocked valid
                      // name-only lines like a titled SKU with no prose.
                      disabled={addLineBusy || (!name.trim() && !desc.trim())}
                      aria-busy={addLineBusy}
                      data-testid={`quote-manual-add-${block.id}`}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {addLineBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                      {addLineBusy ? 'Adding…' : 'Add line'}
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

// ── A single read-only pricing-table line (no write permission) ───────────
// Mirrors EditableLineRow's two-row shape — the customer-facing cells plus the
// internal cost/markup/net band — but renders everything as plain text.
function ReadonlyLineRow({ line: l, quoteId, currency, taxRate, isFirst, showInternal }: { line: QuoteLine; quoteId: string; currency: string; taxRate: string | null; isFirst: boolean; showInternal: boolean }) {
  const mk = markupPct(l.unitPrice, l.unitCost);
  const markupStr = mk === null ? '—' : formatPercent(mk / 100, { maximumFractionDigits: 2 });
  const netCents = l.unitCost === null
    ? null
    : toCents(computeLineTotal(l.quantity, l.unitPrice)) - toCents(computeLineTotal(l.quantity, l.unitCost));
  const tax = lineTaxAmount(l.lineTotal, l.taxable, taxRate);
  return (
    <>
      <tr className="border-t [&>td]:pt-4" data-testid={`quote-line-${l.id}`}>
        <td className="px-2 py-2">
          <div className="flex items-start gap-2">
            {l.imageId
              ? <LineImageThumb quoteId={quoteId} imageId={l.imageId} />
              : l.catalogItemId && <CatalogLineThumb catalogItemId={l.catalogItemId} />}
            <div>
              <div className="font-medium">{lineTitle(l)}</div>
              {lineBlurb(l) && <div className="whitespace-pre-line text-xs text-muted-foreground">{lineBlurb(l)}</div>}
            </div>
          </div>
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{l.quantity}</td>
        <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.unitPrice, currency)}</td>
        <td className="px-2 py-2">
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {formatRecurrence(l.recurrence)}
          </span>
        </td>
        <td className="px-2 py-2 text-center text-muted-foreground" data-testid={`quote-line-taxable-${l.id}`}>
          {/* aria-label on a non-focusable span is ignored by AT, so hide the glyph
              and carry the meaning in an sr-only label instead. */}
          <span aria-hidden="true">{l.taxable ? '✓' : '—'}</span>
          <span className="sr-only">{l.taxable ? 'Taxable' : 'Not taxable'}</span>
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground" data-testid={`quote-line-tax-${l.id}`}>
          {tax === null ? '—' : formatMoney(tax, currency)}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.lineTotal, currency)}</td>
        <td className="sticky right-0 border-l bg-card px-2 py-2 text-right" />
      </tr>
      <tr className={`border-0 ${showInternal ? '' : 'hidden'}`} data-testid={`quote-line-internal-${l.id}`}>
        <td colSpan={8} className="px-2 pb-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-2 py-1 text-xs text-[hsl(220_12%_40%)] dark:text-muted-foreground">
            {/* Full disclaimer on the first row, a subtle "Internal" tag on the rest. */}
            <span className="font-medium uppercase tracking-wide">{isFirst ? 'Internal · not shown to customer' : 'Internal'}</span>
            <span data-testid={`quote-line-sku-${l.id}`}>SKU {l.sku || '—'}</span>
            <span data-testid={`quote-line-partnumber-${l.id}`}>PN {l.partNumber || '—'}</span>
            <span data-testid={`quote-line-cost-${l.id}`}>Cost {l.unitCost === null ? '—' : formatMoney(l.unitCost, currency)}</span>
            <span data-testid={`quote-line-markup-${l.id}`}>Markup {markupStr}</span>
            <span className="ml-auto">Profit{' '}
              <span className="font-medium tabular-nums text-foreground" data-testid={`quote-line-net-${l.id}`}>
                {netCents === null ? '—' : formatMoney(fromCents(netCents), currency)}
              </span>
            </span>
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
function EditableLineRow({
  line, quoteId, currency, taxRate, isPending, isFirst, isLast, showInternal, depositSelectMode, onEdit, onMove, onRemove, onDraft,
  moveTargets, onMoveTo,
}: {
  line: QuoteLine;
  quoteId: string;
  currency: string;
  taxRate: string | null;
  isPending: (key: string) => boolean;
  isFirst: boolean;
  isLast: boolean;
  showInternal: boolean;
  /** Show the deposit-eligible checkbox (quote deposit = 'selected_lines'). */
  depositSelectMode: boolean;
  onEdit: (lineId: string, body: LineUpdate, scopeKey?: string) => Promise<boolean>;
  onMove: (line: QuoteLine, direction: 'up' | 'down') => void;
  onRemove: (line: QuoteLine) => void;
  onDraft: (lineId: string, draft: QuoteLineForMath | null) => void;
  /** Other pricing panels (empty → the Move-to control is hidden). */
  moveTargets: { id: string; label: string }[];
  onMoveTo: (line: QuoteLine, targetBlockId: string) => void;
}) {
  // Per-field pending: only the in-flight control disables, so a slow qty save
  // never freezes price/name/desc (the scoped-pending backport — InvoiceEditor's
  // LineRow got this first). Remove keeps the whole-row key: the confirm-dialog
  // removal flow runs under `line:<id>` and should hold the row's actions.
  const fieldBusy = (field: string) => isPending(`line:${line.id}:${field}`);
  const removeBusy = isPending(`line:${line.id}`);
  const [name, setName] = useState(line.name ?? '');
  const [desc, setDesc] = useState(line.description ?? '');
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);
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

  // "Move to…" menu. Fixed-position so the overflow-x-auto table wrapper can't
  // clip it; closes on outside click or Escape.
  const [movePos, setMovePos] = useState<{ top: number; left: number } | null>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!movePos) return;
    const onDown = (e: MouseEvent) => {
      if (moveMenuRef.current && !moveMenuRef.current.contains(e.target as Node)) setMovePos(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMovePos(null); };
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
  const descRef = useRef<HTMLTextAreaElement>(null);
  const autoGrowDesc = () => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  const qtyEdited = useRef(false);
  const priceEdited = useRef(false);
  const costEdited = useRef(false);
  const skuEdited = useRef(false);
  const partEdited = useRef(false);
  useEffect(() => { if (!nameEdited.current) setName(line.name ?? ''); }, [line.name]);
  useEffect(() => { if (!descEdited.current) setDesc(line.description ?? ''); }, [line.description]);
  // Re-fit the description box after any value change (typing or server resync).
  useEffect(() => { autoGrowDesc(); }, [desc]);
  useEffect(() => { if (!qtyEdited.current) setQty(line.quantity); }, [line.quantity]);
  useEffect(() => { if (!priceEdited.current) setPrice(line.unitPrice); }, [line.unitPrice]);
  useEffect(() => { if (!costEdited.current) setCost(line.unitCost ?? ''); }, [line.unitCost]);
  useEffect(() => { if (!skuEdited.current) setSku(line.sku ?? ''); }, [line.sku]);
  useEffect(() => { if (!partEdited.current) setPartNumber(line.partNumber ?? ''); }, [line.partNumber]);
  // recurrence/taxable are committed on change (the PATCH resolves before the
  // refresh GET fires), so a stale resync can't race them — a plain resync wins.
  useEffect(() => { setRec(line.recurrence); }, [line.recurrence]);
  useEffect(() => { setTaxable(line.taxable); }, [line.taxable]);
  useEffect(() => { setDepositEligible(line.depositEligible ?? false); }, [line.depositEligible]);

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
    const ok = await onEdit(line.id, body, field ? `line:${line.id}:${field}` : undefined);
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
      handleActionError(new Error('image too large'), 'Image must be 5 MB or smaller.');
      return;
    }
    void (async () => {
      setImageBusy(true);
      try {
        const uploaded = await runAction<{ imageId: string }>({
          request: () => uploadQuoteImage(quoteId, file),
          errorFallback: 'Could not upload the image.',
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
  }, [quoteId, applyImageId]);
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
          errorFallback: 'Could not fetch the image from that URL.',
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
  }, [quoteId, imageUrlDraft, applyImageId]);
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
  const skuDirty = sku.trim() !== (line.sku ?? '');
  const partDirty = partNumber.trim() !== (line.partNumber ?? '');

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
      handleActionError(new Error('empty line'), 'A line needs a name or a description.');
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
      handleActionError(new Error('empty line'), 'A line needs a name or a description.');
      setDesc(line.description ?? '');
      return;
    }
    void edit({ description: next || null }, 'desc');
  };
  const commitQty = () => {
    const n = Number(qty);
    qtyEdited.current = false;
    if (n === Number(line.quantity)) { setQty(line.quantity); return; } // unchanged — silent
    // A rejected entry no longer snaps back silently: tell the user why (parity
    // with the tax field and the manual-add path) before reverting.
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      handleActionError(new Error('invalid quantity'), 'Enter a whole-number quantity greater than 0.');
      setQty(line.quantity);
      return;
    }
    void edit({ quantity: n }, 'qty');
  };
  const commitPrice = () => {
    const n = Number(price);
    priceEdited.current = false;
    if (n === Number(line.unitPrice)) { setPrice(line.unitPrice); return; } // unchanged — silent
    if (!Number.isFinite(n) || n < 0) {
      handleActionError(new Error('invalid price'), 'Enter a unit price of 0 or more.');
      setPrice(line.unitPrice);
      return;
    }
    void edit({ unitPrice: n }, 'price');
  };
  const commitCost = () => {
    costEdited.current = false;
    if (cost.trim() === '') { if (line.unitCost !== null) void edit({ unitCost: null }, 'cost'); return; }
    const n = Number(cost);
    if (!Number.isFinite(n) || n < 0) {
      handleActionError(new Error('invalid cost'), 'Enter a cost of 0 or more.');
      setCost(line.unitCost ?? '');
      return;
    }
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
    <tr className="border-t align-top [&>td]:pt-4" data-testid={`quote-line-${line.id}`}>
      <td className="px-2 py-2">
        {/* min-w-0 lets the name input honour its own min-w-[12rem] floor rather
            than the flex row's min-content, so a catalog thumbnail can't crush it. */}
        <div className="flex min-w-0 items-start gap-2">
          {line.imageId
            ? <LineImageThumb quoteId={quoteId} imageId={line.imageId} />
            : line.catalogItemId && <CatalogLineThumb catalogItemId={line.catalogItemId} />}
          <div className="w-full min-w-0 space-y-1">
            <input
              type="text"
              value={name}
              aria-label="Line name"
              placeholder="Name"
              onChange={(e) => { setName(e.target.value); nameEdited.current = true; }}
              onBlur={commitName}
              disabled={fieldBusy('name')}
              data-testid={`quote-line-name-${line.id}`}
              className={`h-9 w-full min-w-[12rem] rounded-md border bg-background px-2 py-1 text-sm font-medium transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(nameDirty, saved)}`}
            />
          </div>
        </div>
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="1" step="1"
          value={qty}
          aria-label="Quantity"
          onChange={(e) => { setQty(e.target.value); qtyEdited.current = true; }}
          onBlur={commitQty}
          disabled={fieldBusy('qty')}
          data-testid={`quote-line-qty-${line.id}`}
          className={`h-9 w-16 rounded-md border bg-background px-2 text-right text-sm tabular-nums transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(qtyDirty, saved)}`}
        />
      </td>
      <td className="px-2 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={price}
          aria-label="Unit price"
          onChange={(e) => { setPrice(e.target.value); priceEdited.current = true; }}
          onBlur={commitPrice}
          disabled={fieldBusy('price')}
          data-testid={`quote-line-price-${line.id}`}
          className={`h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(priceDirty, saved)}`}
        />
      </td>
      <td className="px-2 py-2">
        <select
          value={rec}
          aria-label="Billing frequency"
          onChange={(e) => {
            const next = e.target.value as QuoteLineRecurrence;
            setRec(next); // optimistic — revert if the save fails
            void edit({ recurrence: next }, 'rec').then((ok) => { if (!ok) setRec(line.recurrence); });
          }}
          disabled={fieldBusy('rec')}
          data-testid={`quote-line-recurrence-${line.id}`}
          className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        >
          <option value="one_time">One-time</option>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
      </td>
      <td className="px-2 py-2 text-center">
        <input
          type="checkbox"
          checked={taxable}
          aria-label="Taxable"
          onChange={(e) => {
            const next = e.target.checked;
            setTaxable(next); // optimistic — revert if the save fails
            void edit({ taxable: next }, 'taxable').then((ok) => { if (!ok) setTaxable(line.taxable); });
          }}
          disabled={fieldBusy('taxable')}
          data-testid={`quote-line-taxable-${line.id}`}
        />
        {/* Deposit-eligible toggle appears only when the quote's deposit is
            'selected_lines'. It's meaningful for one-time lines only (recurring
            lines never count toward a deposit), so it's hidden for recurring rows. */}
        {depositSelectMode && rec === 'one_time' && (
          <label className="mt-1 flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <input
              type="checkbox"
              checked={depositEligible}
              aria-label="Deposit eligible"
              onChange={(e) => {
                const next = e.target.checked;
                setDepositEligible(next); // optimistic — revert if the save fails
                void edit({ depositEligible: next }, 'deposit').then((ok) => { if (!ok) setDepositEligible(line.depositEligible ?? false); });
              }}
              disabled={fieldBusy('deposit')}
              data-testid={`line-deposit-eligible-${line.id}`}
            />
            Deposit
          </label>
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground" data-testid={`quote-line-tax-${line.id}`}>
        {displayTax === null ? '—' : formatMoney(displayTax, currency)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        <span data-testid={`quote-line-total-${line.id}`}>{formatMoney(displayTotal, currency)}</span>
        <SrSaved show={saved} testId={`quote-line-saved-${line.id}`} />
      </td>
      <td className="sticky right-0 border-l bg-card px-2 py-2 text-right">
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
          {moveTargets.length > 0 && !line.parentLineId && (
            <div ref={moveMenuRef}>
              <button
                type="button"
                onClick={(e) => {
                  if (movePos) { setMovePos(null); return; }
                  const r = e.currentTarget.getBoundingClientRect();
                  setMovePos({ top: r.bottom + 4, left: r.right });
                }}
                disabled={removeBusy}
                aria-label="Move line to another pricing table"
                aria-haspopup="menu"
                aria-expanded={movePos !== null}
                data-testid={`quote-line-move-to-${line.id}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                <FolderInput className="h-4 w-4" aria-hidden />
              </button>
              {movePos && (
                <div
                  role="menu"
                  aria-label="Move line to"
                  style={{ position: 'fixed', top: movePos.top, left: movePos.left, transform: 'translateX(-100%)' }}
                  className="z-50 w-max min-w-40 max-w-[min(20rem,calc(100vw-1rem))] rounded-md border bg-card py-1 shadow-md"
                  data-testid={`quote-line-move-to-menu-${line.id}`}
                >
                  <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Move to</p>
                  {moveTargets.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitem"
                      title={t.label}
                      onClick={() => { setMovePos(null); onMoveTo(line, t.id); }}
                      data-testid={`quote-line-move-to-${line.id}-${t.id}`}
                      className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => onRemove(line)}
            disabled={removeBusy}
            data-testid={`quote-line-remove-${line.id}`}
            className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      </td>
    </tr>
    {/* Full-width description row, so writers get a roomy, expandable box instead
        of a cramped textarea squeezed into the narrow Description column. */}
    <tr className="border-0" data-testid={`quote-line-desc-row-${line.id}`}>
      <td colSpan={8} className="px-2 pb-2">
        <textarea
          ref={descRef}
          value={desc}
          aria-label="Line description"
          placeholder="Description (optional)"
          onChange={(e) => { setDesc(e.target.value); descEdited.current = true; autoGrowDesc(); }}
          onBlur={commitDesc}
          rows={2}
          disabled={fieldBusy('desc')}
          data-testid={`quote-line-desc-${line.id}`}
          className={`min-h-9 w-full resize-y overflow-hidden rounded-md border bg-background px-2 py-1 text-sm text-muted-foreground transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(descDirty, saved)}`}
        />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {(name.trim() || desc.trim()) && (
            <PolishButton
              disabled={fieldBusy('polish')}
              idSuffix={`quote-line-${line.id}`}
              compact
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
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            disabled={imageBusy || fieldBusy('image')}
            aria-busy={imageBusy}
            data-testid={`quote-line-image-attach-${line.id}`}
            className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {imageBusy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {imageBusy ? 'Uploading…' : line.imageId ? 'Replace image' : 'Add image'}
          </button>
          <button
            type="button"
            onClick={() => setImageUrlOpen((v) => !v)}
            disabled={imageBusy || fieldBusy('image')}
            aria-expanded={imageUrlOpen}
            data-testid={`quote-line-image-url-toggle-${line.id}`}
            className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            From URL
          </button>
          {line.imageId && !imageBusy && (
            <button
              type="button"
              onClick={() => void edit({ imageId: null }, 'image')}
              disabled={fieldBusy('image')}
              data-testid={`quote-line-image-remove-${line.id}`}
              className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Remove image
            </button>
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
                placeholder="https://example.com/photo.png"
                disabled={imageBusy}
                aria-label="Image URL"
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
                Fetch
              </button>
              <button
                type="button"
                onClick={() => { setImageUrlOpen(false); setImageUrlDraft(''); }}
                disabled={imageBusy}
                data-testid={`quote-line-image-url-cancel-${line.id}`}
                className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </td>
    </tr>
    {/* Internal-only cost/markup/profit band — never shown to the customer.
        Collapsed by default via the editor's "Show cost & margin" toggle; kept in
        the DOM (hidden) rather than unmounted so totals/draft wiring stays live. */}
    <tr className={`border-0 ${showInternal ? '' : 'hidden'}`} data-testid={`quote-line-internal-${line.id}`}>
      <td colSpan={8} className="px-2 pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-2 py-1 text-xs text-[hsl(220_12%_40%)] dark:text-muted-foreground">
          {/* Full disclaimer on the first row; a subtle "Internal" tag persists on
              every following row so a writer scanning mid-table never mistakes the
              cost/markup band for customer-facing copy. */}
          <span className="font-medium uppercase tracking-wide">{isFirst ? 'Internal · not shown to customer' : 'Internal'}</span>
          <label className="flex items-center gap-1">SKU
            <input
              type="text"
              value={sku}
              onChange={(e) => { setSku(e.target.value); skuEdited.current = true; }}
              onBlur={commitSku}
              disabled={fieldBusy('sku')}
              data-testid={`quote-line-sku-${line.id}`}
              className={`h-6 w-28 rounded border bg-background px-1 text-foreground transition-shadow ${fieldRing(skuDirty, saved)}`}
            />
          </label>
          <label className="flex items-center gap-1">PN
            <input
              type="text"
              value={partNumber}
              onChange={(e) => { setPartNumber(e.target.value); partEdited.current = true; }}
              onBlur={commitPartNumber}
              disabled={fieldBusy('pn')}
              data-testid={`quote-line-partnumber-${line.id}`}
              className={`h-6 w-28 rounded border bg-background px-1 text-foreground transition-shadow ${fieldRing(partDirty, saved)}`}
            />
          </label>
          <label className="flex items-center gap-1">Cost
            <input
              type="number" min="0" step="0.01"
              value={cost}
              onChange={(e) => { setCost(e.target.value); costEdited.current = true; }}
              onBlur={commitCost}
              disabled={fieldBusy('cost')}
              data-testid={`quote-line-cost-${line.id}`}
              className={`h-6 w-20 rounded border bg-background px-1 text-right tabular-nums text-foreground transition-shadow ${fieldRing(costDirty, saved)}`}
            />
          </label>
          <label className="flex items-center gap-1">Markup
            <input
              type="number" step="0.1"
              value={markupInput}
              onFocus={() => { markupFocused.current = true; }}
              onChange={(e) => setMarkupInput(e.target.value)}
              onBlur={(e) => { markupFocused.current = false; onMarkupCommit(e.target.value); }}
              disabled={fieldBusy('price') || cost.trim() === ''}
              // Tell keyboard/SR users WHY the field is disabled — sighted users can
              // see the empty cost field, AT users can't.
              title={cost.trim() === '' ? 'Enter a cost first to set markup %' : undefined}
              aria-describedby={cost.trim() === '' ? `quote-line-markup-hint-${line.id}` : undefined}
              data-testid={`quote-line-markup-${line.id}`}
              className="h-6 w-16 rounded border bg-background px-1 text-right tabular-nums text-foreground disabled:opacity-60"
            />%
            {cost.trim() === '' && <span id={`quote-line-markup-hint-${line.id}`} className="sr-only">Enter a cost first to set markup %.</span>}
          </label>
          <span className="ml-auto">Profit{' '}
            <span className="font-medium tabular-nums text-foreground" data-testid={`quote-line-net-${line.id}`}>
              {netCents === null ? '—' : formatMoney(fromCents(netCents), currency)}
            </span>
          </span>
        </div>
      </td>
    </tr>
    </>
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

// Per-line uploaded image thumbnail (GET /quotes/:id/images/:imageId needs the
// Bearer header — same contract as CatalogLineThumb: render nothing on miss).
function LineImageThumb({ quoteId, imageId }: { quoteId: string; imageId: string }) {
  const { url } = useAuthedImage(quoteImageUrl(quoteId, imageId));
  if (!url) return null;
  return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded border object-contain" data-testid="quote-line-image-thumb" />;
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
