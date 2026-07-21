import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, GripVertical, MoreHorizontal } from 'lucide-react';
import '../../../lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
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
  updateQuote,
} from '../../../lib/api/quotes';
import {
  listContractTemplates,
  getContractTemplate,
  type ContractTemplateWithLatest,
  type ContractTemplateDetail,
  type TemplateVersionSummary,
} from '../../../lib/api/contractTemplates';
import type { QuoteBlockInput, CoverPage } from '@breeze/shared';
import { computeQuoteTotals, computeQuoteProfit, toQuoteDepositConfig, type QuoteLineForMath, type QuoteProfit, type QuoteTotals, type QuoteDepositType, type QuoteDepositConfig } from '@breeze/shared';
import { listCatalog, createCatalogItem, type CatalogItem } from '../../../lib/api/catalog';
import { ecExpressStatus, ecExpressImport, type EcProduct, type EcStatus, pax8Status, pax8Import, type Pax8Product, type Pax8PriceOption } from '../../../lib/api/distributors';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { showToast } from '../../shared/Toast';
import RichTextEditor from '../../common/RichTextEditor';
import PolishButton from '../../catalog/PolishButton';
import { BlockCard, QuoteImagePreview } from './QuoteBlockCard';
import { UnassignedLines } from './QuoteUnassignedLines';
import { UNAUTHORIZED, type LineUpdate, SrSaved, fieldRing, pendingKey, useSavedFlash } from './quoteEditorShared';
import { useMenuKeyboard } from '../shared/menuKeyboard';
import { UnsavedBadge, RecurringBillingNote, MarginPanel } from '../billingUi';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  type QuoteLineRecurrence,
  formatMoney,
  pctFromFraction,
  lineTitle,
} from './quoteTypes';

// Phase 2: the add-block menu now offers `image` as well. An image block is
// created with its uploaded `imageId` already in `content` — the editor uploads
// the file first (POST /:id/images), then adds the block with `{ imageId }`.
// Heading/rich-text block content is editable in place via PATCH /:id/blocks/:blockId
// (updateBlock); the block type itself is immutable.
type AddableBlockType = 'heading' | 'rich_text' | 'image' | 'line_items' | 'contract';
const ADD_BLOCK_OPTIONS: { value: AddableBlockType; labelKey: string }[] = [
  { value: 'heading', labelKey: 'quotes.editor.blockTypes.heading' },
  { value: 'rich_text', labelKey: 'quotes.editor.blockTypes.richText' },
  { value: 'image', labelKey: 'quotes.editor.blockTypes.image' },
  { value: 'line_items', labelKey: 'quotes.editor.blockTypes.pricingTable' },
  { value: 'contract', labelKey: 'quotes.editor.blockTypes.contract' },
];


/** Latest PUBLISHED version of a template (design: attach pins the latest
 *  published version, never a newer draft). Returns null when the template has
 *  no published version yet — the picker blocks the attach in that case. */
function latestPublishedVersion(detail: ContractTemplateDetail): TemplateVersionSummary | null {
  // versions arrive newest-first (desc versionNumber), so the first published
  // one is the latest published.
  return detail.versions.find((v) => v.status === 'published') ?? null;
}

/** Parse the variable names out of a send-time 422 CONTRACT_VARIABLES_UNRESOLVED
 *  message ("Contract variables unresolved: a, b") by substring-matching the
 *  known names, so a wording change never silently drops the inline errors. */
function unresolvedNamesFromMessage(message: string, knownNames: string[]): string[] {
  return knownNames.filter((name) => message.includes(name));
}

interface Props {
  detail: QuoteDetailData;
  onChanged: () => void;
  /** Fires whenever the editor's save state changes: true while any mutation is
   *  in flight or the terms field sits dirty. The workspace uses it to hold
   *  Send until the quote is quiescent, so the irreversible money-moment
   *  can't race a blur-save. */
  onPendingEditsChange?: (hasPendingEdits: boolean) => void;
}


export default function QuoteEditor({ detail, onChanged, onPendingEditsChange }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const canWrite = can('quotes', 'write');
  // Cost/margin is a read affordance, not a write one: read-only users already see
  // the per-line internal cost bands (ReadonlyLineRow) + the toggle, so the rail
  // Margin summary is gated the same way QuoteDetail gates it — on quotes:read —
  // rather than on write, which would hide the aggregate while showing the parts.
  const canSeeMargin = can('quotes', 'read');
  // "Show cost & margin" governs EVERY internal-economics surface — the per-line
  // cost/markup bands AND the rail's Margin panel — so one toggle honestly means
  // "no margin on screen" (a tech screen-sharing with a client must be able to
  // trust it). Collapsed by default; the choice persists per browser so daily
  // margin-watchers aren't re-toggling on every quote.
  const SHOW_INTERNAL_KEY = 'breeze:quote-editor-show-margin';
  const [showInternal, setShowInternalState] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_INTERNAL_KEY) === '1',
  );
  const setShowInternal = useCallback((updater: (v: boolean) => boolean) => {
    setShowInternalState((v) => {
      const next = updater(v);
      try { localStorage.setItem(SHOW_INTERNAL_KEY, next ? '1' : '0'); } catch { /* private mode — session-only */ }
      return next;
    });
  }, []);
  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;
  // Rows only repeat the '/mo' | '/yr' cadence suffix when the quote actually
  // mixes cadences — on a uniform quote the suffix is per-line noise (the rail
  // totals and each editable row's recurrence select still carry the cadence).
  const mixedCadence = useMemo(() => new Set(lines.map((l) => l.recurrence)).size > 1, [lines]);
  // Focus anchor: after a confirmed block/line removal the triggering button is
  // gone, so we move focus here instead of letting it fall to <body> (which dumps
  // a keyboard user to the top of the page).
  const blocksColRef = useRef<HTMLDivElement>(null);

  // Per-item "saving" state, keyed so one in-flight mutation never freezes the
  // rest of the editor. Scoped keys come from `pendingKey` (quoteEditorShared)
  // plus a few editor-local literals ('terms', 'deposit', 'add-block',
  // 'cover-page', 'cover-image'). `pending` drives disabled styling;
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
  // Quiet "Saved" cue for the blur-to-save terms field (title moved to the
  // workspace header — see QuoteHeaderMeta).
  const [termsSaved, flashTermsSaved] = useSavedFlash();
  const canCatalogWrite = can('catalog', 'write');

  // Surface "is anything still saving / sitting dirty?" to the workspace so the
  // Send button can wait for quiescence. Pending covers every in-flight mutation
  // (line/block/terms/add/remove); the terms dirty flag covers the rail's
  // blur-to-save field. Per-line dirty state isn't lifted — clicking Send blurs
  // the focused field, whose commit lands in `pending` before the dialog opens.
  const hasPendingEdits = pending.size > 0 || termsDirty;
  useEffect(() => { onPendingEditsChange?.(hasPendingEdits); }, [hasPendingEdits, onPendingEditsChange]);
  // Clear on unmount so a stale `true` can't lock Send after the editor is gone
  // (e.g. the quote was just issued and the tab switched).
  useEffect(() => () => onPendingEditsChange?.(false), [onPendingEditsChange]);

  // ---- add-block form ------------------------------------------------------
  // Where the add-section form renders: a gap index inserts between blocks
  // (the created block is reordered into place after the POST); null renders
  // the form at the canvas foot, as before.
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [addType, setAddType] = useState<AddableBlockType>('heading');

  // Per-block arrangement menu (grip + kebab live in the canvas margin, not in
  // a per-block header bar). One open menu at a time; same keyboard grammar as
  // every other menu (useMenuKeyboard).
  const [blockMenu, setBlockMenu] = useState<{ id: string; top: number; left: number; flip?: boolean } | null>(null);
  const blockMenuWrapRef = useRef<HTMLDivElement>(null);
  const blockMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const { listRef: blockMenuListRef, onKeyDown: onBlockMenuKeyDown } = useMenuKeyboard(blockMenu !== null, () => setBlockMenu(null));
  useEffect(() => {
    if (!blockMenu) return;
    const onDown = (e: MouseEvent) => {
      if (blockMenuWrapRef.current && !blockMenuWrapRef.current.contains(e.target as Node)) setBlockMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setBlockMenu(null); blockMenuTriggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [blockMenu]);

  // "Tidy all descriptions" (block kebab menu, pricing blocks only): queues the
  // SAME per-line PolishButton preview+fact-guard flow across every line with a
  // description, one dialog at a time — never applies without the user
  // approving each preview. `tidyQueue` holds the remaining line ids for
  // `tidyBlockId`; the invisible driver below (autoRun + hideTrigger, remounted
  // per line via `key`) fires the next preview and `onSettled` advances the
  // queue once the user approves or cancels.
  const [tidyBlockId, setTidyBlockId] = useState<string | null>(null);
  const [tidyQueue, setTidyQueue] = useState<string[]>([]);

  const [headingText, setHeadingText] = useState('');
  const [richText, setRichText] = useState('');
  const [tableLabel, setTableLabel] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageCaption, setImageCaption] = useState('');
  const [imageSource, setImageSource] = useState<'file' | 'url'>('file');
  const [imageUrl, setImageUrl] = useState('');

  // ---- add contract block --------------------------------------------------
  // The template library for the picker, loaded lazily the first time the
  // "Contract" add type is opened. `contractTemplateId` is the picked template;
  // `contractVersion` is its pinned latest-published version (id + declared
  // variables). Manual variable inputs write into `contractVarValues`;
  // `contractVarErrors` holds inline "required"/send-blocked errors keyed by
  // variable name.
  const [contractTemplates, setContractTemplates] = useState<ContractTemplateWithLatest[]>([]);
  const [contractTemplatesLoaded, setContractTemplatesLoaded] = useState(false);
  const [contractTemplateId, setContractTemplateId] = useState('');
  const [contractVersion, setContractVersion] = useState<TemplateVersionSummary | null>(null);
  const [contractNoPublished, setContractNoPublished] = useState(false);
  const [contractVarValues, setContractVarValues] = useState<Record<string, string>>({});
  const [contractVarErrors, setContractVarErrors] = useState<Record<string, string>>({});
  const [contractLabel, setContractLabel] = useState('');

  useEffect(() => { setTerms(quote.termsAndConditions ?? ''); setTermsDirty(false); }, [quote.termsAndConditions]);

  // ---- deposit controls ----------------------------------------------------
  // Local mirrors of the persisted deposit config so the type select + percent
  // input update instantly and the rail's live deposit figure recomputes
  // mid-edit; both resync from the server after each blur-save's refresh().
  const [depositType, setDepositType] = useState<QuoteDepositType>(quote.depositType ?? 'none');
  const [depositPercentDraft, setDepositPercentDraft] = useState<string>(quote.depositPercent ?? '');
  // Inline error for an out-of-range/non-numeric percent — the same error
  // contract the line qty/price/cost fields follow (aria-invalid + message +
  // input preserved), instead of a corner toast while the field silently
  // reverts itself. Cleared on the next keystroke. Server-side DEPOSIT_*
  // rejections (business rules the client can't know) still toast + resync.
  const [depositPctError, setDepositPctError] = useState<string | null>(null);
  // Declared here (before the resync effect below) — see the staged
  // selected_lines block further down for the rationale.
  const stagedSelectedLines = useRef(false);
  useEffect(() => { if (!stagedSelectedLines.current) setDepositType(quote.depositType ?? 'none'); }, [quote.depositType]);
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
        errorFallback: t('quotes.editor.errors.saveTerms'),
        onUnauthorized: UNAUTHORIZED,
      });
      setTermsDirty(false);
      refresh();
    }, t('quotes.editor.errors.saveTerms'));
    if (ok) flashTermsSaved();
  }, [termsDirty, terms, quote.id, refresh, runScoped, flashTermsSaved, t]);

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
        errorFallback: t('quotes.editor.errors.updateDeposit'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('quotes.editor.errors.updateDeposit')),
  [quote.id, refresh, runScoped, t]);

  // Snap the local mirrors back to the server-persisted deposit config. Used when
  // a deposit PATCH is rejected (e.g. 400 DEPOSIT_NOT_BELOW_TOTAL or
  // DEPOSIT_NO_ELIGIBLE_LINES): runAction already toasts the API's reason, but the
  // optimistic type select / percent draft would otherwise keep showing a mode that
  // never saved — a dropdown that lies about persisted state until the next reload.
  const revertDepositMirrors = useCallback(() => {
    setDepositType(quote.depositType ?? 'none');
    setDepositPercentDraft(quote.depositPercent ?? '');
  }, [quote.depositType, quote.depositPercent]);

  // Client-side range gate (mirrors the API's 0.01–99.99 constraint) so an
  // out-of-range entry gets an inline error with the input preserved instead of
  // a doomed PATCH. Returns null for "no percent entered yet".
  const parseDepositPercent = useCallback((raw: string): { pct: number | null; error: string | null } => {
    if (raw.trim() === '') return { pct: null, error: null };
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct < 0.01 || pct > 99.99) {
      return { pct: null, error: t('quotes.editor.errors.depositPercentRange') };
    }
    return { pct, error: null };
  }, [t]);

  // 'selected_lines' with no eligible lines yet is a STAGED state, not an
  // error: PATCHing immediately made the server reject, the select snap back,
  // and the eligibility checkboxes (which only render in this mode) unmount —
  // the error instructed an action the UI had just made impossible. Instead the
  // mode holds locally (checkboxes + inline hint visible) and persists itself
  // the moment the first line is flagged. The ref guards the server-resync
  // effect from clobbering the staged mode on unrelated refreshes.
  const hasEligibleLines = lines.some((l) => l.depositEligible);
  useEffect(() => {
    if (!stagedSelectedLines.current) return;
    if (!hasEligibleLines) return;
    stagedSelectedLines.current = false;
    void saveDeposit({ depositType: 'selected_lines' }).then((ok) => { if (!ok) revertDepositMirrors(); });
    // saveDeposit/revertDepositMirrors are stable useCallbacks from above.
  }, [hasEligibleLines]);

  const onDepositTypeChange = useCallback((next: QuoteDepositType) => {
    setDepositType(next);
    stagedSelectedLines.current = false;
    if (next !== 'percent') setDepositPctError(null);
    if (next === 'selected_lines' && !lines.some((l) => l.depositEligible)) {
      // Stage: show the per-line checkboxes + hint; persist on first flag.
      stagedSelectedLines.current = true;
      return;
    }
    if (next === 'percent') {
      // Saving type='percent' with a null percent would 400 DEPOSIT_PERCENT_INVALID,
      // so defer the PATCH until a valid percent exists — persist immediately only
      // when one is already entered (the percent input's onBlur handles the first
      // entry; an out-of-range leftover surfaces its inline error instead).
      const { pct, error } = parseDepositPercent(depositPercentDraft);
      setDepositPctError(error);
      if (pct != null) {
        void saveDeposit({ depositType: 'percent', depositPercent: pct }).then((ok) => { if (!ok) revertDepositMirrors(); });
      }
    } else {
      void saveDeposit({ depositType: next }).then((ok) => { if (!ok) revertDepositMirrors(); });
    }
  }, [depositPercentDraft, parseDepositPercent, saveDeposit, revertDepositMirrors]);

  const onDepositPercentBlur = useCallback(() => {
    if (depositType !== 'percent') return;
    const { pct, error } = parseDepositPercent(depositPercentDraft);
    setDepositPctError(error);
    if (pct == null) return; // empty (defer) or invalid (inline error shown, input kept)
    // Only fire when it actually differs from the persisted value (avoids a
    // redundant PATCH on a focus-through).
    if (quote.depositType === 'percent' && quote.depositPercent != null && Number(quote.depositPercent) === pct) return;
    void saveDeposit({ depositType: 'percent', depositPercent: pct }).then((ok) => { if (!ok) revertDepositMirrors(); });
  }, [depositType, depositPercentDraft, parseDepositPercent, quote.depositType, quote.depositPercent, saveDeposit, revertDepositMirrors]);

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
    // A blank percent draft normalizes to NaN, which computeQuoteTotals treats
    // as "no deposit" — the live rail simply shows no deposit row mid-edit.
    // An OUT-OF-RANGE draft (kept in the field with its inline error) is fed
    // through as blank too, so the rail never computes a deposit from a value
    // that can't be saved (e.g. 150% showing 1.5× the due figure).
    () => toQuoteDepositConfig(depositType, parseDepositPercent(depositPercentDraft).pct != null ? depositPercentDraft.trim() : ''),
    [depositType, depositPercentDraft, parseDepositPercent],
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
    () => {
      const values = {
        oneTime: formatMoney(railOneTime, currency),
        monthly: formatMoney(railMonthly, currency),
        annual: formatMoney(railAnnual, currency),
        due: formatMoney(railDue, currency),
      };
      return Number(railTax) > 0
        ? t('quotes.editor.liveTotals.srUpdatedWithTax', { ...values, tax: formatMoney(railTax, currency) })
        : t('quotes.editor.liveTotals.srUpdated', values);
    },
    [railOneTime, railMonthly, railAnnual, railTax, railDue, currency, t],
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
  // Skip the very first sentence: without this the debounce fires ~800ms after
  // mount and announces the initial totals to an SR user who hasn't edited
  // anything yet. Only CHANGES announce.
  const srMounted = useRef(false);
  useEffect(() => {
    if (!srMounted.current) { srMounted.current = true; return; }
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
    return t('quotes.editor.table.fallbackName', { number: pricingBlocks.findIndex((x) => x.id === b.id) + 1 });
  }, [pricingBlocks, t]);

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

  // Kicks off the "Tidy all descriptions" queue for one block. Only lines that
  // currently have a description are queued — an empty description would just
  // hit PolishButton's "enter text first" guard for nothing. `tidyTotalRef`
  // remembers how many were queued so the completion toast can report a count
  // after `tidyQueue` has drained to empty.
  const tidyTotalRef = useRef(0);
  const startTidyAll = useCallback((blockId: string) => {
    const ids = linesForBlock(blockId)
      .filter((l) => (l.description ?? '').trim())
      .map((l) => l.id);
    if (ids.length === 0) {
      showToast({ message: t('quotes.editor.tidyAll.noDescriptions'), type: 'warning' });
      return;
    }
    tidyTotalRef.current = ids.length;
    setTidyBlockId(blockId);
    setTidyQueue(ids);
  }, [linesForBlock, t]);

  // Drop a queued line id that no longer exists (e.g. removed mid-tidy) without
  // opening a preview for it.
  useEffect(() => {
    if (tidyQueue.length === 0) return;
    if (!lines.some((l) => l.id === tidyQueue[0])) setTidyQueue((q) => q.slice(1));
  }, [tidyQueue, lines]);

  // Completion toast once the queue fully drains.
  useEffect(() => {
    if (tidyBlockId !== null && tidyQueue.length === 0) {
      setTidyBlockId(null);
      showToast({ message: t('quotes.editor.tidyAll.complete', { count: tidyTotalRef.current }), type: 'success' });
    }
  }, [tidyBlockId, tidyQueue, t]);

  // ---- document outline (rail "Contents") ---------------------------------
  // A quiet block-level nav for long quotes: each entry jumps to (and focuses)
  // its block. Labels mirror what the canvas shows — the author's own text
  // where one exists (table label, heading text, contract label), else the
  // block-type default the add menu uses. Only rendered with 2+ blocks: a
  // one-block quote has nothing to navigate.
  const blockContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setBlockContainerRef = useCallback((blockId: string, el: HTMLDivElement | null) => {
    if (el) blockContainerRefs.current.set(blockId, el);
    else blockContainerRefs.current.delete(blockId);
  }, []);
  const outlineLabel = useCallback((b: QuoteBlock): string => {
    if (b.blockType === 'line_items') return pricingBlockLabel(b);
    if (b.blockType === 'heading') {
      const text = ((b.content?.text as string | undefined) ?? '').trim();
      return text || t('quotes.editor.blockTypes.heading');
    }
    if (b.blockType === 'contract') {
      const label = ((b.content?.label as string | undefined) ?? '').trim();
      return label || t('quotes.editor.blockTypes.contract');
    }
    if (b.blockType === 'image') return t('quotes.editor.blockTypes.image');
    return t('quotes.editor.blockTypes.richText');
  }, [pricingBlockLabel, t]);
  // Scroll-position highlight: the outline marks the topmost block currently in
  // the viewport. IntersectionObserver is feature-detected — in jsdom (and any
  // environment without it) the outline simply renders with no active entry.
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const visibleBlockIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return; // graceful no-op (jsdom)
    const idsInOrder = sortedBlocks.map((b) => b.id);
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.outlineBlockId;
        if (!id) continue;
        if (entry.isIntersecting) visibleBlockIds.current.add(id);
        else visibleBlockIds.current.delete(id);
      }
      setActiveOutlineId(idsInOrder.find((id) => visibleBlockIds.current.has(id)) ?? null);
    });
    for (const id of idsInOrder) {
      const el = blockContainerRefs.current.get(id);
      if (el) io.observe(el);
    }
    return () => { io.disconnect(); visibleBlockIds.current.clear(); };
  }, [sortedBlocks]);
  // Jump: smooth-scroll the block into view (instant under reduced motion) and
  // move focus to the block container (tabIndex=-1) so a keyboard/SR user's
  // reading position follows the visual jump.
  const jumpToBlock = useCallback((blockId: string) => {
    const el = blockContainerRefs.current.get(blockId);
    if (!el) return;
    const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
  }, []);

  // Orphan lines: `block_id` is nullable, and `linesForBlock` can never surface
  // them (a null blockId matches no block id, ever). They are NOT invisible to
  // the customer — the PDF, the portal and the Preview all render them, and
  // quoteMath counts them in every total — so the editor renders them in a
  // dedicated bucket below the document (see UnassignedLines). An optimistic
  // move writes a real block id into lineBlockOverride, which drops the line
  // out of this list on the same tick it lands in its target panel.
  const orphanLines = useMemo(
    () =>
      lines
        .filter((l) => (lineBlockOverride[l.id] ?? l.blockId) === null)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [lines, lineBlockOverride],
  );

  // Reveal-on-demand plumbing for the rail's actionable "missing cost" notice
  // (MarginPanel → here → QuoteLineRows): line ids missing a cost, filtered to
  // customerVisible (mirroring computeQuoteProfit's own inclusion rule, so the
  // reveal target is always one of the lines the count actually describes) and
  // walked in the SAME document order the canvas renders — each pricing block
  // in sortOrder, then that block's own line order. Orphan lines (rendered by
  // UnassignedLines, a separate surface) are deliberately excluded: there is no
  // reveal target there, so a click that lands on one just no-ops rather than
  // throwing.
  const missingCostLineIds = useMemo(() => {
    const ids: string[] = [];
    for (const block of pricingBlocks) {
      for (const l of linesForBlock(block.id)) {
        if (!l.customerVisible) continue;
        const cost = lineDrafts[l.id]?.unitCost ?? l.unitCost;
        if (cost === null || cost === undefined || cost === '') ids.push(l.id);
      }
    }
    return ids;
  }, [pricingBlocks, linesForBlock, lineDrafts]);
  // Bumps on every click so the SAME first offender can be re-revealed (e.g.
  // the user scrolled away) — a repeated lineId alone wouldn't re-trigger the
  // row's reveal effect.
  const revealNonceRef = useRef(0);
  const [revealRequest, setRevealRequest] = useState<{ lineId: string; nonce: number } | null>(null);
  const revealFirstMissingCost = useCallback(() => {
    const id = missingCostLineIds[0];
    if (!id) return;
    revealNonceRef.current += 1;
    setRevealRequest({ lineId: id, nonce: revealNonceRef.current });
  }, [missingCostLineIds]);

  // ---- add contract block --------------------------------------------------
  // Lazy-load the template library the first time the Contract add type opens,
  // so the picker never fires a request for quotes the tech never attaches a
  // contract to. Failure surfaces via runAction's toast; the picker then just
  // shows "no templates".
  useEffect(() => {
    if (addType !== 'contract' || contractTemplatesLoaded) return;
    setContractTemplatesLoaded(true);
    void runAction<ContractTemplateWithLatest[]>({
      request: () => listContractTemplates(),
      errorFallback: t('quotes.editor.errors.loadContractTemplates'),
      onUnauthorized: UNAUTHORIZED,
      parseSuccess: (d) => (d as { data: ContractTemplateWithLatest[] }).data,
    })
      .then((list) => setContractTemplates(list))
      .catch(() => { /* toast already shown; keep the empty picker */ });
  }, [addType, contractTemplatesLoaded, t]);

  // Pick a template → resolve its latest PUBLISHED version (fetch the detail so a
  // newer unpublished draft never gets pinned) and seed the manual variable form.
  const pickContractTemplate = useCallback((templateId: string) => {
    setContractTemplateId(templateId);
    setContractVersion(null);
    setContractNoPublished(false);
    setContractVarValues({});
    setContractVarErrors({});
    if (!templateId) return;
    void runAction<ContractTemplateDetail>({
      request: () => getContractTemplate(templateId),
      errorFallback: t('quotes.editor.errors.loadContractTemplates'),
      onUnauthorized: UNAUTHORIZED,
      parseSuccess: (d) => (d as { data: ContractTemplateDetail }).data,
    })
      .then((tplDetail) => {
        const version = latestPublishedVersion(tplDetail);
        if (!version) { setContractNoPublished(true); return; }
        setContractVersion(version);
        // Seed manual variables to '' so the form is controlled from the start.
        const seed: Record<string, string> = {};
        for (const v of version.declaredVariables) {
          if (v.kind === 'manual') seed[v.name] = '';
        }
        setContractVarValues(seed);
      })
      .catch(() => { /* toast already shown */ });
  }, [t]);

  const resetContractForm = useCallback(() => {
    setContractTemplateId('');
    setContractVersion(null);
    setContractNoPublished(false);
    setContractVarValues({});
    setContractVarErrors({});
    setContractLabel('');
  }, []);

  // ---- cover page ----------------------------------------------------------
  // Local mirror of the persisted cover page, so the toggle/title/prepared-for
  // update instantly; resynced from the server after each save's refresh().
  const coverFromQuote = useCallback((cp: typeof quote.coverPage): CoverPage => ({
    enabled: cp?.enabled ?? false,
    showPreparedBy: cp?.showPreparedBy ?? true,
    ...(cp?.title != null ? { title: cp.title } : {}),
    ...(cp?.coverImageId != null ? { coverImageId: cp.coverImageId } : {}),
    ...(cp?.preparedForName != null ? { preparedForName: cp.preparedForName } : {}),
  }), []);
  const [cover, setCover] = useState<CoverPage>(() => coverFromQuote(quote.coverPage));
  // Guard the resync exactly like the ContractBlockEditor / heading / rich-text
  // mirrors: only overwrite the local draft from the server when the user hasn't
  // diverged (local === last-synced). Otherwise an unrelated save's refresh()
  // would clobber un-blurred title/prepared-for keystrokes mid-edit.
  const lastSyncedCover = useRef(JSON.stringify(coverFromQuote(quote.coverPage)));
  useEffect(() => {
    const next = coverFromQuote(quote.coverPage);
    const nextStr = JSON.stringify(next);
    // Capture the previously-synced value before mutating the ref so the
    // comparison is deterministic regardless of when React runs the updater.
    const previous = lastSyncedCover.current;
    lastSyncedCover.current = nextStr;
    setCover((cur) => (JSON.stringify(cur) === previous ? next : cur));
  }, [quote.coverPage, coverFromQuote]);
  // Always-current cover snapshot for async callbacks that must not capture a
  // stale `cover` closure (uploadCoverImage's post-upload saveCover).
  const coverRef = useRef(cover);
  useEffect(() => { coverRef.current = cover; }, [cover]);

  // Persist a cover-page change. Drops empty title/preparedForName so a cleared
  // field round-trips as "unset" rather than an empty string, and always carries
  // enabled + showPreparedBy forward (updateQuote replaces cover_page wholesale).
  const saveCover = useCallback((next: CoverPage) => {
    setCover(next);
    const body: CoverPage = { enabled: next.enabled, showPreparedBy: next.showPreparedBy };
    if (next.title?.trim()) body.title = next.title.trim();
    if (next.coverImageId) body.coverImageId = next.coverImageId;
    if (next.preparedForName?.trim()) body.preparedForName = next.preparedForName.trim();
    void runScoped('cover-page', async () => {
      await runAction({
        request: () => updateQuote(quote.id, { coverPage: body }),
        errorFallback: t('quotes.editor.errors.saveCoverPage'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('quotes.editor.errors.saveCoverPage'));
  }, [quote.id, refresh, runScoped, t]);

  const uploadCoverImage = useCallback((file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      handleActionError(new Error('image too large'), t('quotes.editor.errors.imageTooLarge'));
      return;
    }
    void runScoped('cover-image', async () => {
      const uploaded = await runAction<{ imageId: string }>({
        request: () => uploadQuoteImage(quote.id, file),
        errorFallback: t('quotes.editor.errors.uploadImage'),
        onUnauthorized: UNAUTHORIZED,
        parseSuccess: (d) => (d as { data: { imageId: string } }).data,
      });
      // Read the LATEST cover (ref, not the closure's `cover`) so a title typed
      // during a slow upload isn't dropped by this post-upload save.
      saveCover({ ...coverRef.current, coverImageId: uploaded.imageId });
    }, t('quotes.editor.errors.uploadImage'));
  }, [quote.id, saveCover, runScoped, t]);

  // ---- add block -----------------------------------------------------------
  // Reorder a just-created block into the gap the user picked (insertAt).
  // Best-effort: a failed reorder toasts and the block stays at the end.
  const positionNewBlock = useCallback(async (created: { id?: string } | undefined) => {
    if (insertAt == null || !created?.id) return;
    const ids = sortedBlocks.map((b) => b.id);
    ids.splice(Math.min(insertAt, ids.length), 0, created.id);
    try {
      await runAction({
        request: () => reorderBlocksApi(quote.id, { blockIds: ids }),
        errorFallback: t('quotes.editor.errors.reorderSections'),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch { /* toasted; the new section simply lands at the end */ }
  }, [insertAt, sortedBlocks, quote.id, t]);

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
        handleActionError(new Error('image too large'), t('quotes.editor.errors.imageTooLarge'));
        return;
      }
      await runScoped('add-block', async () => {
        const uploaded = await runAction<{ imageId: string }>({
          request: () => source === 'file'
            ? uploadQuoteImage(quote.id, imageFile!)
            : addQuoteImageFromUrl(quote.id, imageUrl.trim()),
          errorFallback: source === 'file'
            ? t('quotes.editor.errors.uploadImage')
            : t('quotes.editor.errors.fetchImageFromUrl'),
          // No success toast: the upload is an internal step of "add image block",
          // and the block itself appearing is the success signal (web-2).
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: { imageId: string } }).data,
        });
        const createdImg = await runAction<{ id?: string }>({
          request: () => addBlock(quote.id, {
            blockType: 'image' as const,
            content: imageCaption.trim()
              ? { imageId: uploaded.imageId, caption: imageCaption.trim() }
              : { imageId: uploaded.imageId },
          }),
          errorFallback: t('quotes.editor.errors.imageAddedSectionFailed'),
          // No success toast — the image block visibly appears.
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: { id?: string } }).data,
        });
        await positionNewBlock(createdImg);
        setImageFile(null); setImageCaption(''); setImageUrl('');
        setInsertAt(null);
        refresh();
      }, t('quotes.editor.errors.addImageSection'));
      return;
    }

    if (addType === 'contract') {
      const version = contractVersion;
      if (!contractTemplateId || !version) return;
      const manualNames = version.declaredVariables.filter((v) => v.kind === 'manual').map((v) => v.name);
      // Client-side gate: a blank manual variable would fail the send-time
      // CONTRACT_VARIABLES_UNRESOLVED check, so catch it here with an inline error
      // on the offending input rather than letting the doomed send happen later.
      const missing = manualNames.filter((name) => !(contractVarValues[name] ?? '').trim());
      if (missing.length > 0) {
        setContractVarErrors(Object.fromEntries(missing.map((name) => [name, t('quotes.editor.contract.variableRequired')])));
        return;
      }
      const variableValues: Record<string, string> = {};
      for (const name of manualNames) variableValues[name] = (contractVarValues[name] ?? '').trim();
      setContractVarErrors({});
      await runScoped('add-block', async () => {
        let createdContract: { id?: string } | undefined;
        try {
          createdContract = await runAction<{ id?: string }>({
            request: () => addBlock(quote.id, {
              blockType: 'contract' as const,
              content: {
                templateId: contractTemplateId,
                templateVersionId: version.id,
                variableValues,
                ...(contractLabel.trim() ? { label: contractLabel.trim() } : {}),
              },
            } as QuoteBlockInput),
            errorFallback: t('quotes.editor.errors.addContractSection'),
            // No success toast — the contract block visibly appears.
            onUnauthorized: UNAUTHORIZED,
            parseSuccess: (d) => (d as { data: { id?: string } }).data,
          });
        } catch (err) {
          // The attach route itself only rejects with INVALID_CONTRACT_TEMPLATE —
          // the unresolved-variables gate (CONTRACT_VARIABLES_UNRESOLVED) fires at
          // SEND, not here (the client-side gate above already blocks blank manual
          // vars pre-attach). Kept defensively: if a future server change ever
          // surfaces that code at attach, map the names back to inline input errors.
          if (err instanceof ActionError && err.code === 'CONTRACT_VARIABLES_UNRESOLVED') {
            const named = unresolvedNamesFromMessage(err.message, manualNames);
            const targets = named.length > 0 ? named : manualNames;
            setContractVarErrors(Object.fromEntries(targets.map((name) => [name, t('quotes.editor.contract.variableUnresolved')])));
          }
          throw err;
        }
        await positionNewBlock(createdContract);
        resetContractForm();
        setInsertAt(null);
        refresh();
      }, t('quotes.editor.errors.addContractSection'));
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
      const created = await runAction<{ id?: string }>({
        request: () => addBlock(quote.id, body),
        errorFallback: t('quotes.editor.errors.addSection'),
        // No success toast — the new section visibly appears in the block list.
        onUnauthorized: UNAUTHORIZED,
        parseSuccess: (d) => (d as { data: { id?: string } }).data,
      });
      await positionNewBlock(created);
      setHeadingText(''); setRichText(''); setTableLabel('');
      setInsertAt(null);
      refresh();
    }, t('quotes.editor.errors.addSection'));
  }, [addType, headingText, richText, tableLabel, imageFile, imageCaption, imageSource, imageUrl, contractTemplateId, contractVersion, contractVarValues, contractLabel, resetContractForm, positionNewBlock, quote.id, refresh, runScoped, t]);


  // Removing a line_items block cascades to every line under it (server-side), so
  // the section-actions menu's Remove opens a confirm step instead of deleting outright.
  const [pendingRemove, setPendingRemove] = useState<QuoteBlock | null>(null);
  // Line removal is equally irreversible, so it gets the same confirm step the
  // block remove has (rather than deleting on a single click).
  const [pendingLineRemove, setPendingLineRemove] = useState<QuoteLine | null>(null);

  // Real block delete: removes the block and (server-side) any lines attached to
  // it. Works for every block type — heading, rich_text, and line_items — so the
  // "Remove" button is no longer a silent no-op for heading/rich_text blocks.
  const removeBlock = useCallback((block: QuoteBlock) =>
    runScoped(pendingKey.block(block.id), async () => {
      await runAction({
        request: () => deleteBlock(quote.id, block.id),
        errorFallback: t('quotes.editor.errors.removeSection'),
        successMessage: t('quotes.editor.success.sectionRemoved'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('quotes.editor.errors.removeSection')),
  [quote.id, refresh, runScoped, t]);

  // ---- line mutations (scoped to a line_items block) ----------------------
  const doAddCatalog = useCallback(async (blockId: string, item: CatalogItem) => {
    await runAction({
      request: () => addCatalogLine(quote.id, { catalogItemId: item.id, quantity: 1, blockId }),
      errorFallback: t('quotes.editor.errors.addCatalogItem'),
      // No success toast: the new row visibly appears and the totals move —
      // toasting on top of that was noise that covered the rail's deposit
      // control. Failures still toast.
      onUnauthorized: UNAUTHORIZED,
    });
    refresh();
  }, [quote.id, refresh, t]);

  const addCatalog = useCallback((blockId: string, item: CatalogItem) =>
    runScoped(pendingKey.addLine(blockId), () => doAddCatalog(blockId, item), t('quotes.editor.errors.addCatalogItem')),
  [doAddCatalog, runScoped, t]);

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
    runScoped(pendingKey.addLine(blockId), async () => {
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
          errorFallback: t('quotes.editor.errors.importPax8Product'),
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: CatalogItem }).data,
        });
      }
      await doAddCatalog(blockId, item);
      void loadCatalog();
    }, t('quotes.editor.errors.addPax8Product')),
  [doAddCatalog, resolveCatalogBySku, loadCatalog, runScoped, t]);

  const importAndAddDistributor = useCallback((blockId: string, product: EcProduct, sellPrice: number) =>
    runScoped(pendingKey.addLine(blockId), async () => {
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
          errorFallback: t('quotes.editor.errors.importDistributorItem'),
          // no success toast here — doAddCatalog's new row visibly appearing is the success signal
          onUnauthorized: UNAUTHORIZED,
          parseSuccess: (d) => (d as { data: CatalogItem }).data,
        });
      }
      await doAddCatalog(blockId, item);
      void loadCatalog(); // surface a newly-imported item in the catalog picker too
    }, t('quotes.editor.errors.addDistributorItem')),
  [doAddCatalog, resolveCatalogBySku, loadCatalog, runScoped, t]);

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
      handleActionError(new Error('invalid quantity'), t('quotes.editor.errors.quantityWholeGreaterThanZero'));
      return Promise.resolve(false);
    }
    // Guard the unit price too (parity with the inline edit path's commitPrice):
    // a negative/NaN price shouldn't depend on the server to reject it.
    const priceNum = Number(form.unitPrice);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      handleActionError(new Error('invalid price'), t('quotes.editor.errors.unitPriceZeroOrMore'));
      return Promise.resolve(false);
    }
    // Cost is optional, but a non-empty entry must be valid — reject it the same way
    // commitCost does inline, rather than silently coercing bad input to null (which
    // would drop the user's cost and understate the margin with no feedback).
    const costEmpty = form.cost.trim() === '';
    const costNum = Number(form.cost);
    if (!costEmpty && (!Number.isFinite(costNum) || costNum < 0)) {
      handleActionError(new Error('invalid cost'), t('quotes.editor.errors.costZeroOrMore'));
      return Promise.resolve(false);
    }
    return runScoped(pendingKey.addLine(blockId), async () => {
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
        errorFallback: t('quotes.editor.errors.addLine'),
        // No success toast — the appended row is the feedback (see addCatalog).
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
          errorFallback: t('quotes.editor.errors.lineAddedCatalogSaveFailed'),
          successMessage: t('quotes.editor.success.savedToCatalog'),
          onUnauthorized: UNAUTHORIZED,
        });
        void loadCatalog();
      }
      refresh();
    }, t('quotes.editor.errors.addLine'));
  }, [quote.id, refresh, loadCatalog, runScoped, t]);

  const deleteLine = useCallback((lineId: string) =>
    runScoped(pendingKey.line(lineId), async () => {
      await runAction({
        request: () => removeLine(quote.id, lineId),
        errorFallback: t('quotes.editor.errors.removeLine'),
        successMessage: t('quotes.editor.success.lineRemoved'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('quotes.editor.errors.removeLine')),
  [quote.id, refresh, runScoped, t]);

  // Inline edit of an existing line. `body` carries only the changed fields
  // (matches updateQuoteLineSchema). Routed through runAction so failures are
  // surfaced, then refresh() re-pulls the quote so totals recompute. Returns
  // whether it succeeded so the row can flash a quiet "Saved" cue — routine
  // inline edits no longer fire a success toast (that was per-field spam).
  // `scopeKey` narrows the pending key to one field (`line:<id>:<field>`) so a
  // slow qty save never disables the price input mid-tab (the scoped-pending
  // backport from InvoiceEditor); omitting it falls back to the whole row.
  const editLine = useCallback((lineId: string, body: LineUpdate, scopeKey?: string) =>
    runScoped(scopeKey ?? pendingKey.line(lineId), async () => {
      await runAction({
        request: () => updateLine(quote.id, lineId, body),
        errorFallback: t('quotes.editor.errors.updateLine'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('quotes.editor.errors.updateLine')),
  [quote.id, refresh, runScoped, t]);

  // Inline edit of a block's content (heading text/level, rich-text html). The
  // block type is restated so the server validates the content shape; it is
  // immutable and never changes here. Like editLine, success is quiet (the row
  // flashes "Saved"); only failures toast.
  const editBlock = useCallback((block: QuoteBlock, content: Record<string, unknown>) =>
    runScoped(pendingKey.block(block.id), async () => {
      await runAction({
        request: () => updateBlock(quote.id, block.id, { blockType: block.blockType, content } as QuoteBlockInput),
        errorFallback: t('quotes.editor.errors.updateSection'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('quotes.editor.errors.updateBlock')),
  [quote.id, refresh, runScoped, t]);

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
            errorFallback: t('quotes.editor.errors.reorderSections'),
            onUnauthorized: UNAUTHORIZED,
          });
          refresh();
        } catch (err) {
          handleActionError(err, t('quotes.editor.errors.reorderBlocks'));
          setBlockOrder(null);
          blockReorderBase.current = null;
          refresh();
        }
      })();
    }, 250);
  }, [sortedBlocks, quote.id, refresh, t]);

  // Drag-to-reorder for blocks (HTML5 DnD on the grip). Drop commits the full
  // reordered id list through the same optimistic + PATCH path the menu moves
  // use, so a failed drop reverts identically.
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const commitBlockDrop = useCallback((targetIdx: number) => {
    if (!dragBlockId) return;
    const ids = sortedBlocks.map((b) => b.id);
    const from = ids.indexOf(dragBlockId);
    if (from < 0) return;
    ids.splice(from, 1);
    const to = targetIdx > from ? targetIdx - 1 : targetIdx;
    ids.splice(Math.min(to, ids.length), 0, dragBlockId);
    setDragBlockId(null); setDropIndex(null);
    if (ids.join() === sortedBlocks.map((b) => b.id).join()) return;
    blockReorderBase.current = ids;
    setBlockOrder(ids);
    void (async () => {
      try {
        await runAction({
          request: () => reorderBlocksApi(quote.id, { blockIds: ids }),
          errorFallback: t('quotes.editor.errors.reorderSections'),
          onUnauthorized: UNAUTHORIZED,
        });
        refresh();
      } catch (err) {
        handleActionError(err, t('quotes.editor.errors.reorderSections'));
        setBlockOrder(null);
        blockReorderBase.current = null;
        refresh();
      }
    })();
  }, [dragBlockId, sortedBlocks, quote.id, refresh, t]);


  // The ONE line-reorder persistence path: optimistic order + a debounced
  // trailing PATCH per block (the server renumbers 0..n-1 from the full id
  // list). Both the ⋯ menu's Move up/down (single-slot swap) and the row drag
  // handle's drop (arbitrary splice) commit through here, so a failed reorder
  // reverts identically regardless of which affordance drove it.
  const commitLineOrder = useCallback((blockId: string, ids: string[]) => {
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
            errorFallback: t('quotes.editor.errors.reorderLines'),
            onUnauthorized: UNAUTHORIZED,
          });
          refresh();
        } catch (err) {
          handleActionError(err, t('quotes.editor.errors.reorderLines'));
          setLineOrder((m) => { const n = { ...m }; delete n[blockId]; return n; });
          delete lineReorderBase.current[blockId];
          refresh();
        }
      })();
    }, 250);
  }, [quote.id, refresh, t]);

  const moveLine = useCallback((blockId: string, line: QuoteLine, direction: 'up' | 'down') => {
    const currentIds = lineReorderBase.current[blockId] ?? linesForBlock(blockId).map((l) => l.id);
    const idx = currentIds.indexOf(line.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= currentIds.length) return;
    const ids = [...currentIds];
    [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
    commitLineOrder(blockId, ids);
  }, [linesForBlock, commitLineOrder]);

  // Drag-to-reorder within one pricing table (HTML5 DnD on the row grip).
  // `targetIdx` is the gap index the row was dropped into (0..n). Same splice
  // arithmetic as commitBlockDrop; a no-op drop (same slot) sends nothing.
  const dropLineInBlock = useCallback((blockId: string, dragLineId: string, targetIdx: number) => {
    const currentIds = lineReorderBase.current[blockId] ?? linesForBlock(blockId).map((l) => l.id);
    const from = currentIds.indexOf(dragLineId);
    if (from < 0) return;
    const ids = [...currentIds];
    ids.splice(from, 1);
    const to = targetIdx > from ? targetIdx - 1 : targetIdx;
    ids.splice(Math.min(to, ids.length), 0, dragLineId);
    if (ids.join() === currentIds.join()) return;
    commitLineOrder(blockId, ids);
  }, [linesForBlock, commitLineOrder]);

  // Cross-panel move: optimistic on both panels at once (the line leaves its
  // source table and appends to the target, bundle children in tow), committed
  // via the dedicated move endpoint. No debounce — unlike the chevrons, a move
  // is one discrete action. Failure reverts both panels and re-pulls the
  // authoritative server order (same recovery shape as moveBlock/moveLine).
  const moveLineTo = useCallback((line: QuoteLine, targetBlockId: string) => {
    // Null source = an ORPHAN line (block_id NULL) being adopted out of the
    // Unassigned bucket. It has no source panel to re-order, so every
    // source-side step below is skipped — but the target-side optimism, the
    // PATCH and the revert path are identical, which is why this is the same
    // handler rather than a parallel one that could drift from it.
    const sourceBlockId = lineBlockOverride[line.id] ?? line.blockId;
    if (sourceBlockId === targetBlockId) return;
    // A pending chevron-reorder PATCH for either panel would fire with a stale
    // id list that still contains the moved line — the server rejects it
    // (REORDER_IDS_MISMATCH) and its catch handler would then wipe this move's
    // optimistic order. Cancel those timers; the move's refresh() re-syncs
    // order from the server anyway.
    for (const bid of [sourceBlockId, targetBlockId]) {
      if (!bid) continue;
      const t = lineReorderTimers.current[bid];
      if (t) { clearTimeout(t); delete lineReorderTimers.current[bid]; }
    }
    const movedIds = [line.id, ...lines.filter((l) => l.parentLineId === line.id).map((l) => l.id)];
    const sourceIds = sourceBlockId
      ? (lineReorderBase.current[sourceBlockId] ?? linesForBlock(sourceBlockId).map((l) => l.id))
        .filter((id) => !movedIds.includes(id))
      : null;
    const targetIds = [
      ...(lineReorderBase.current[targetBlockId] ?? linesForBlock(targetBlockId).map((l) => l.id))
        .filter((id) => !movedIds.includes(id)),
      ...movedIds,
    ];
    lineReorderBase.current = {
      ...lineReorderBase.current,
      ...(sourceBlockId && sourceIds ? { [sourceBlockId]: sourceIds } : {}),
      [targetBlockId]: targetIds,
    };
    setLineBlockOverride((m) => {
      const n = { ...m };
      for (const id of movedIds) n[id] = targetBlockId;
      return n;
    });
    setLineOrder((m) => ({
      ...m,
      ...(sourceBlockId && sourceIds ? { [sourceBlockId]: sourceIds } : {}),
      [targetBlockId]: targetIds,
    }));
    void (async () => {
      try {
        await runAction({
          request: () => moveLineApi(quote.id, line.id, { blockId: targetBlockId }),
          errorFallback: t('quotes.editor.errors.moveLine'),
          // No success toast — the line visibly lands in the target table.
          onUnauthorized: UNAUTHORIZED,
        });
        refresh();
      } catch (err) {
        handleActionError(err, t('quotes.editor.errors.moveLine'));
        setLineBlockOverride((m) => {
          const n = { ...m };
          for (const id of movedIds) delete n[id];
          return n;
        });
        setLineOrder((m) => {
          const n = { ...m };
          if (sourceBlockId) delete n[sourceBlockId];
          delete n[targetBlockId];
          return n;
        });
        if (sourceBlockId) delete lineReorderBase.current[sourceBlockId];
        delete lineReorderBase.current[targetBlockId];
        refresh();
      }
    })();
  }, [lines, lineBlockOverride, linesForBlock, quote.id, refresh, t]);

  const hasRecurring = Number(railMonthly) > 0 || Number(railAnnual) > 0;

  // The add-section form is a single instance rendered either at a chosen
  // insertion gap (insertAt) or at the canvas foot (default) — same testids,
  // same state, one form.
  const addSectionForm = (
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-add-block">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.editor.addSection.title')}</h2>
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
                  {t(/* i18n-dynamic */ o.labelKey)}
                </button>
              ))}
            </div>

            {addType === 'heading' && (
              <input
                type="text"
                value={headingText}
                onChange={(e) => setHeadingText(e.target.value)}
                placeholder={t('quotes.editor.addSection.headingPlaceholder')}
                data-testid="quote-block-heading-text"
                className="mb-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            )}
            {addType === 'rich_text' && (
              <div className="mb-3" data-testid="quote-block-rich-text">
                <RichTextEditor
                  value={richText}
                  onChange={setRichText}
                  ariaLabel={t('quotes.editor.addSection.richTextPlaceholder')}
                  testId="quote-block-rich-text-editor"
                />
              </div>
            )}
            {addType === 'image' && (
              <div className="mb-3 space-y-2">
                {/* Same aria-pressed segmented-control vocabulary as the add-block
                    chips above — NOT a tablist (tab semantics promise arrow-key
                    behavior these two buttons don't have). */}
                <div className="inline-flex rounded-md border p-0.5 text-xs">
                  <button
                    type="button"
                    aria-pressed={imageSource === 'file'}
                    onClick={() => { setImageSource('file'); setImageUrl(''); }}
                    data-testid="quote-block-image-source-file"
                    className={`rounded px-3 py-1 font-medium ${imageSource === 'file' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >
                    {t('quotes.editor.addSection.uploadFile')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={imageSource === 'url'}
                    onClick={() => { setImageSource('url'); setImageFile(null); }}
                    data-testid="quote-block-image-source-url"
                    className={`rounded px-3 py-1 font-medium ${imageSource === 'url' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >
                    {t('quotes.editor.actions.fromUrl')}
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
                    placeholder={t('quotes.editor.addSection.imageUrlPlaceholder')}
                    data-testid="quote-block-image-url"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                )}
                <input
                  type="text"
                  value={imageCaption}
                  onChange={(e) => setImageCaption(e.target.value)}
                    placeholder={t('quotes.editor.addSection.captionPlaceholder')}
                  data-testid="quote-block-image-caption"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">{t('quotes.editor.addSection.imageHelp')}</p>
              </div>
            )}
            {addType === 'line_items' && (
              <input
                type="text"
                value={tableLabel}
                onChange={(e) => setTableLabel(e.target.value)}
                placeholder={t('quotes.editor.table.labelPlaceholder')}
                data-testid="quote-block-table-label"
                className="mb-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            )}
            {addType === 'contract' && (
              <div className="mb-3 space-y-3" data-testid="quote-block-contract">
                <div>
                  <label htmlFor="quote-block-contract-template" className="mb-1 block text-xs text-muted-foreground">
                    {t('quotes.editor.contract.templateLabel')}
                  </label>
                  <select
                    id="quote-block-contract-template"
                    value={contractTemplateId}
                    onChange={(e) => pickContractTemplate(e.target.value)}
                    data-testid="quote-block-contract-template"
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('quotes.editor.contract.templatePlaceholder')}</option>
                    {contractTemplates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                    ))}
                  </select>
                  {contractTemplatesLoaded && contractTemplates.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="quote-block-contract-no-templates">
                      {t('quotes.editor.contract.noTemplates')}
                    </p>
                  )}
                </div>

                {contractNoPublished && (
                  <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground dark:text-warning" data-testid="quote-block-contract-no-version">
                    {t('quotes.editor.contract.noPublishedVersion')}
                  </p>
                )}

                {contractVersion && (
                  <>
                    <p className="text-xs text-muted-foreground" data-testid="quote-block-contract-version">
                      {t('quotes.editor.contract.pinnedVersion', { version: contractVersion.versionNumber })}
                    </p>

                    {contractVersion.declaredVariables.some((v) => v.kind === 'auto') && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">{t('quotes.editor.contract.autoVariablesTitle')}</p>
                        <ul className="space-y-1">
                          {contractVersion.declaredVariables.filter((v) => v.kind === 'auto').map((v) => (
                            <li
                              key={v.name}
                              data-testid={`quote-block-contract-auto-${v.name}`}
                              className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1 text-xs"
                            >
                              <span className="font-medium">{v.label ?? v.name}</span>
                              <span className="font-mono text-muted-foreground">{`{{${v.name}}}`}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1 text-[11px] text-muted-foreground">{t('quotes.editor.contract.autoHint')}</p>
                      </div>
                    )}

                    {contractVersion.declaredVariables.some((v) => v.kind === 'manual') && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">{t('quotes.editor.contract.manualVariablesTitle')}</p>
                        {contractVersion.declaredVariables.filter((v) => v.kind === 'manual').map((v) => (
                          <div key={v.name}>
                            <label htmlFor={`quote-block-contract-var-${v.name}`} className="mb-0.5 block text-xs text-muted-foreground">
                              {v.label ?? v.name}
                            </label>
                            <input
                              id={`quote-block-contract-var-${v.name}`}
                              type="text"
                              value={contractVarValues[v.name] ?? ''}
                              onChange={(e) => {
                                setContractVarValues((cur) => ({ ...cur, [v.name]: e.target.value }));
                                setContractVarErrors((cur) => {
                                  if (!cur[v.name]) return cur;
                                  const next = { ...cur }; delete next[v.name]; return next;
                                });
                              }}
                              data-testid={`quote-block-contract-var-${v.name}`}
                              aria-invalid={contractVarErrors[v.name] ? true : undefined}
                              className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring ${contractVarErrors[v.name] ? 'border-destructive' : ''}`}
                            />
                            {contractVarErrors[v.name] && (
                              <p className="mt-0.5 text-xs text-destructive" data-testid={`quote-block-contract-var-error-${v.name}`}>
                                {contractVarErrors[v.name]}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div>
                      <label htmlFor="quote-block-contract-label" className="mb-0.5 block text-xs text-muted-foreground">
                        {t('quotes.editor.contract.labelFieldLabel')}
                      </label>
                      <input
                        id="quote-block-contract-label"
                        type="text"
                        value={contractLabel}
                        maxLength={200}
                        onChange={(e) => setContractLabel(e.target.value)}
                        placeholder={t('quotes.editor.contract.labelPlaceholder')}
                        data-testid="quote-block-contract-label"
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </>
                )}
              </div>
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
                  (addType === 'image' && imageSource === 'url' && !imageUrl.trim()) ||
                  (addType === 'contract' && !contractVersion)
                }
                data-testid="quote-add-block-submit"
                className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {addType === 'image'
                  ? (imageSource === 'url' ? t('quotes.editor.actions.fetchAddImage') : t('quotes.editor.actions.uploadAddImage'))
                  : t('quotes.editor.actions.addSection')}
              </button>
            </div>
          </div>
  );

  return (
    <div className="space-y-6" data-testid="quote-editor">
      {/* The autosave hint is writer-only, but the cost/margin toggle is offered to
          everyone who can see the editor: read-only users also have per-line cost
          bands and deserve the same collapse control (ml-auto keeps it right-aligned
          whether or not the hint renders). */}
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && (
          <p className="text-xs text-muted-foreground" data-testid="quote-editor-autosave-hint">
            {t('quotes.editor.autosaveHint')}
          </p>
        )}
        {canWrite && (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" data-testid="quote-cover-page">
            <input
              type="checkbox"
              checked={cover.enabled}
              onChange={(e) => saveCover({ ...cover, enabled: e.target.checked })}
              disabled={isPending('cover-page')}
              data-testid="quote-cover-page-enabled"
              className="h-3.5 w-3.5"
            />
            {t('quotes.editor.coverPage.enable')}
          </label>
        )}
        <button
          type="button"
          onClick={() => setShowInternal((v) => !v)}
          aria-pressed={showInternal}
          data-testid="quote-editor-toggle-internal"
          className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted ${showInternal ? 'border-primary/40 bg-primary/10 text-primary' : ''}`}
        >
          {showInternal ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
          {showInternal ? t('quotes.editor.actions.hideCostMargin') : t('quotes.editor.actions.showCostMargin')}
        </button>
      </div>
      {/* Cover page: a toolbar toggle, not a permanent card — the once-per-quote
          setup stays out of the daily compose path. Fields appear only while
          enabled. */}
      {canWrite && cover.enabled && (
        <div className="max-w-3xl rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-cover-page-fields">
          {cover.enabled && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="quote-cover-page-title" className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.coverPage.titleLabel')}</label>
                <input
                  id="quote-cover-page-title"
                  type="text"
                  value={cover.title ?? ''}
                  maxLength={200}
                  placeholder={t('quotes.editor.coverPage.titlePlaceholder')}
                  onChange={(e) => setCover((c) => ({ ...c, title: e.target.value }))}
                  onBlur={() => saveCover(cover)}
                  disabled={isPending('cover-page')}
                  data-testid="quote-cover-page-title"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="quote-cover-page-prepared-for" className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.coverPage.preparedForLabel')}</label>
                <input
                  id="quote-cover-page-prepared-for"
                  type="text"
                  value={cover.preparedForName ?? ''}
                  maxLength={255}
                  placeholder={t('quotes.editor.coverPage.preparedForPlaceholder')}
                  onChange={(e) => setCover((c) => ({ ...c, preparedForName: e.target.value }))}
                  onBlur={() => saveCover(cover)}
                  disabled={isPending('cover-page')}
                  data-testid="quote-cover-page-prepared-for"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                />
              </div>
              <div className="flex items-end">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={cover.showPreparedBy}
                    onChange={(e) => saveCover({ ...cover, showPreparedBy: e.target.checked })}
                    disabled={isPending('cover-page')}
                    data-testid="quote-cover-page-show-prepared-by"
                    className="h-4 w-4"
                  />
                  {t('quotes.editor.coverPage.showPreparedBy')}
                </label>
              </div>
              <div className="sm:col-span-2">
                <span className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.coverPage.imageLabel')}</span>
                {cover.coverImageId ? (
                  <div className="flex items-center gap-3">
                    <QuoteImagePreview quoteId={quote.id} imageId={cover.coverImageId} caption={cover.title ?? ''} />
                    <button
                      type="button"
                      onClick={() => saveCover({ ...cover, coverImageId: null })}
                      disabled={isPending('cover-page') || isPending('cover-image')}
                      data-testid="quote-cover-page-image-remove"
                      className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {t('quotes.editor.coverPage.removeImage')}
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCoverImage(f); }}
                      disabled={isPending('cover-image')}
                      data-testid="quote-cover-page-image-file"
                      className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">{t('quotes.editor.coverPage.imageHelp')}</p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* The rail joins as a second column only at xl: below that the two-column
          split starves the pricing table (at 1100px the blocks track is ~420px
          against a ~650px table minimum) and forces sideways scrolling on the
          most-checked figures. Stacked, the table gets the full content width. */}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        {/* ── blocks ─────────────────────────────────────────────────── */}
        {/* min-w-0: this 1fr grid track holds a pricing table with a min-width
            (see BlockCard) inside an overflow-x-auto wrapper. Without min-w-0 the
            track refuses to shrink below the table's min-content and the editor
            blows out past the viewport on a phone (page-level horizontal scroll). */}
        <div
          className="min-w-0 space-y-4 rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          ref={blocksColRef}
          tabIndex={-1}
        >
          {/* The paper: one continuous document-shaped surface. Blocks render in
              document typography inside it; the per-block card chrome is gone.
              Arrangement controls (grip + kebab) live in the left gutter and
              appear on hover/focus so the content stays document-clean. */}
          <div className="rounded-xl border bg-card shadow-xs" data-testid="quote-canvas">
            <div className="space-y-5 py-5 pl-10 pr-4 sm:py-6 sm:pl-12 sm:pr-7">
              {sortedBlocks.length === 0 && (
                <div className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground" data-testid="quote-blocks-empty">
                  {t('quotes.editor.emptyBlocks')}
                </div>
              )}
              {sortedBlocks.map((block, idx) => (
                <Fragment key={block.id}>
                  {canWrite && (
                    <InsertGap
                      index={idx}
                      active={insertAt === idx}
                      onToggle={() => setInsertAt((cur) => (cur === idx ? null : idx))}
                      label={t('quotes.editor.addSection.insertHere')}
                      dropActive={dragBlockId !== null && dropIndex === idx}
                      onDragOver={dragBlockId ? (e) => { e.preventDefault(); setDropIndex(idx); } : undefined}
                      onDrop={dragBlockId ? (e) => { e.preventDefault(); commitBlockDrop(idx); } : undefined}
                    />
                  )}
                  {canWrite && insertAt === idx && addSectionForm}
                  {/* tabIndex=-1 + ref: the rail outline's jump target — focus
                      lands here so keyboard/SR reading position follows the
                      scroll. data-outline-block-id feeds the outline's
                      IntersectionObserver highlight. */}
                  <div
                    ref={(el) => setBlockContainerRef(block.id, el)}
                    tabIndex={-1}
                    data-outline-block-id={block.id}
                    data-testid={`quote-block-container-${block.id}`}
                    className={`group/block relative rounded-md focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${dragBlockId === block.id ? 'opacity-40' : ''}`}
                  >
                    {canWrite && (
                      <div className="absolute -left-7 top-0.5 flex flex-col items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/block:opacity-100">
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', block.id); setDragBlockId(block.id); }}
                          onDragEnd={() => { setDragBlockId(null); setDropIndex(null); }}
                          aria-label={t('quotes.editor.actions.dragSection')}
                          title={t('quotes.editor.actions.dragSection')}
                          data-testid={`quote-block-drag-${block.id}`}
                          className="inline-flex h-6 w-6 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                        >
                          <GripVertical className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          ref={blockMenu?.id === block.id ? blockMenuTriggerRef : undefined}
                          onClick={(e) => {
                            if (blockMenu?.id === block.id) { setBlockMenu(null); return; }
                            const r = e.currentTarget.getBoundingClientRect();
                            const flip = r.bottom + 160 > window.innerHeight;
                            setBlockMenu({ id: block.id, top: flip ? r.top - 4 : r.bottom + 4, left: r.left, flip });
                          }}
                          aria-haspopup="menu"
                          aria-expanded={blockMenu?.id === block.id}
                          aria-label={t('quotes.editor.actions.sectionActions')}
                          data-testid={`quote-block-actions-${block.id}`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    )}
                    {canWrite && blockMenu?.id === block.id && (
                      <div ref={blockMenuWrapRef}>
                        <div
                          role="menu"
                          ref={blockMenuListRef}
                          onKeyDown={onBlockMenuKeyDown}
                          aria-label={t('quotes.editor.actions.sectionActions')}
                          style={{ position: 'fixed', top: blockMenu.top, left: blockMenu.left, transform: blockMenu.flip ? 'translateY(-100%)' : undefined }}
                          className="z-50 w-max min-w-40 rounded-md border bg-card py-1 shadow-md"
                          data-testid={`quote-block-actions-menu-${block.id}`}
                        >
                          <button
                            type="button" role="menuitem" tabIndex={-1} disabled={idx === 0}
                            onClick={() => { setBlockMenu(null); blockMenuTriggerRef.current?.focus(); moveBlock(block, 'up'); }}
                            data-testid={`quote-block-move-up-${block.id}`}
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
                          >
                            {t('quotes.editor.actions.moveSectionUp')}
                          </button>
                          <button
                            type="button" role="menuitem" tabIndex={-1} disabled={idx === sortedBlocks.length - 1}
                            onClick={() => { setBlockMenu(null); blockMenuTriggerRef.current?.focus(); moveBlock(block, 'down'); }}
                            data-testid={`quote-block-move-down-${block.id}`}
                            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
                          >
                            {t('quotes.editor.actions.moveSectionDown')}
                          </button>
                          {block.blockType === 'line_items' && (
                            <div className="mt-1 border-t pt-1">
                              <button
                                type="button" role="menuitem" tabIndex={-1}
                                disabled={tidyQueue.length > 0}
                                onClick={() => { setBlockMenu(null); blockMenuTriggerRef.current?.focus(); startTidyAll(block.id); }}
                                data-testid={`quote-block-tidy-all-${block.id}`}
                                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-40"
                              >
                                {t('quotes.editor.actions.tidyAllDescriptions')}
                              </button>
                            </div>
                          )}
                          <div className="mt-1 border-t pt-1">
                            <button
                              type="button" role="menuitem" tabIndex={-1}
                              onClick={() => { setBlockMenu(null); setPendingRemove(block); }}
                              data-testid={`quote-block-remove-${block.id}`}
                              className="block w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-hidden"
                            >
                              {t('quotes.editor.actions.removeSection')}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
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
                mixedCadence={mixedCadence}
                depositSelectMode={depositSelectMode}
                ecActive={ecActive}
                pax8Active={pax8Active}
                defaultMarkupPct={defaultMarkupPct}
                onAddCatalog={addCatalog}
                onImportAddDistributor={importAndAddDistributor}
                onImportAddPax8={importAndAddPax8}
                onAddManual={addManual}
                onEditLine={editLine}
                onEditBlock={editBlock}
                onMoveLine={(line, dir) => moveLine(block.id, line, dir)}
                onMoveLineToBlock={moveLineTo}
                moveTargets={
                  block.blockType === 'line_items'
                    ? pricingBlocks.filter((b) => b.id !== block.id).map((b) => ({ id: b.id, label: pricingBlockLabel(b) }))
                    : []
                }
                onRemoveLine={setPendingLineRemove}
                onLineDraft={setLineDraft}
                revealRequest={revealRequest}
                hasDirtyLines={block.blockType === 'line_items' && linesForBlock(block.id).some((l) => l.id in lineDrafts)}
                onDropLine={(dragLineId, targetIdx) => dropLineInBlock(block.id, dragLineId, targetIdx)}
              />
                  </div>
                </Fragment>
              ))}
              {canWrite && sortedBlocks.length > 0 && dragBlockId !== null && (
                <InsertGap
                  index={sortedBlocks.length}
                  active={false}
                  onToggle={() => {}}
                  label={t('quotes.editor.addSection.insertHere')}
                  dropActive={dropIndex === sortedBlocks.length}
                  onDragOver={(e) => { e.preventDefault(); setDropIndex(sortedBlocks.length); }}
                  onDrop={(e) => { e.preventDefault(); commitBlockDrop(sortedBlocks.length); }}
                />
              )}
              {/* Orphan bucket — lines with no pricing section. Rendered LAST,
                  where the customer's document puts them ("Additional items" in
                  the Preview / portal / PDF), and self-suppressing when empty. */}
              <UnassignedLines
                lines={orphanLines}
                moveTargets={pricingBlocks.map((b) => ({ id: b.id, label: pricingBlockLabel(b) }))}
                currency={currency}
                canWrite={canWrite}
                onMoveLineToBlock={moveLineTo}
              />
            </div>
          </div>

          {/* Add section — canvas foot (default position when no gap is chosen) */}
          {canWrite && insertAt === null && addSectionForm}
        </div>

        {/* ── live totals + terms ────────────────────────────────────── */}
        {/* Sticky on xl so the totals you're building against stay visible while
            scrolling the blocks; below xl this column stacks under the blocks. */}
        <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-live-totals">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.editor.liveTotals.title')}</h2>
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
                <dt className="text-muted-foreground">{t('quotes.editor.liveTotals.oneTime')}</dt>
                <dd data-testid="quote-total-onetime">{formatMoney(railOneTime, currency)}</dd>
              </div>
              {/* Zero-value cadences stay silent — a permanent "$0.00/yr" row is
                  noise a daily user reads hundreds of times for nothing. */}
              {Number(railMonthly) > 0 && (
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">{t('quotes.editor.liveTotals.monthlyRecurring')}</dt>
                  <dd data-testid="quote-total-monthly">{formatMoney(railMonthly, currency)}<span className="text-xs text-muted-foreground">{t('quotes.editor.units.perMonth')}</span></dd>
                </div>
              )}
              {Number(railAnnual) > 0 && (
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">{t('quotes.editor.liveTotals.annualRecurring')}</dt>
                  <dd data-testid="quote-total-annual">{formatMoney(railAnnual, currency)}<span className="text-xs text-muted-foreground">{t('quotes.editor.units.perYear')}</span></dd>
                </div>
              )}
              {Number(railTax) > 0 && (
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">{t('quotes.editor.liveTotals.tax')}</dt>
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
                    <span>{t(/* i18n-dynamic */ `quotes.editor.categories.${b.category}`, { defaultValue: b.category })}</span>
                    <span className="tabular-nums">
                      {[
                        Number(b.oneTimeTotal) > 0 ? formatMoney(b.oneTimeTotal, currency) : null,
                        Number(b.monthlyTotal) > 0 ? `${formatMoney(b.monthlyTotal, currency)}${t('quotes.editor.units.perMonth')}` : null,
                        Number(b.annualTotal) > 0 ? `${formatMoney(b.annualTotal, currency)}${t('quotes.editor.units.perYear')}` : null,
                      ].filter(Boolean).join(t('quotes.editor.symbols.plusSeparator'))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {canSeeMargin && showInternal && (
              <MarginPanel
                profit={profit}
                currency={currency}
                onMissingCostClick={missingCostLineIds.length > 0 ? revealFirstMissingCost : undefined}
              />
            )}
            {/* Read-only: the rate is resolved at quote creation (org tax settings,
                falling back to the partner default) and isn't editable per-quote. */}
            <div className="mt-2 border-t pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">{t('quotes.editor.liveTotals.taxRate')}</span>
                <span className="text-sm tabular-nums" data-testid="quote-tax-rate">
                  {quote.taxRate ? `${pctFromFraction(quote.taxRate)}%` : t('quotes.editor.symbols.notAvailable')}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('quotes.editor.liveTotals.taxRateHelp')}
              </p>
            </div>
            {/* Deposit controls — writer-only. Selecting a type saves it (the server
                surfaces DEPOSIT_* validation as a toast); the percent input blur-saves.
                The live "Deposit due" figure recomputes from the same shared math. */}
            {canWrite && (
              <div className="mt-2 space-y-2 border-t pt-2" data-testid="quote-deposit-controls">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="quote-deposit-type" className="text-sm text-muted-foreground">{t('quotes.editor.deposit.label')}</label>
                  <select
                    id="quote-deposit-type"
                    value={depositType}
                    onChange={(e) => onDepositTypeChange(e.target.value as QuoteDepositType)}
                    disabled={isPending('deposit')}
                    data-testid="quote-deposit-type"
                    className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                  >
                    <option value="none">{t('quotes.editor.deposit.none')}</option>
                    <option value="percent">{t('quotes.editor.deposit.percentOfDue')}</option>
                    <option value="selected_lines">{t('quotes.editor.deposit.selectedLines')}</option>
                  </select>
                </div>
                {depositType === 'percent' && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor="quote-deposit-percent" className="text-sm text-muted-foreground">{t('quotes.editor.deposit.percent')}</label>
                      <div className="flex items-center gap-1">
                        <input
                          id="quote-deposit-percent"
                          type="number" min={0.01} max={99.99} step={0.01}
                          value={depositPercentDraft}
                          onChange={(e) => { setDepositPercentDraft(e.target.value); setDepositPctError(null); }}
                          onBlur={onDepositPercentBlur}
                          disabled={isPending('deposit')}
                          aria-invalid={depositPctError ? true : undefined}
                          aria-describedby={depositPctError ? 'quote-deposit-percent-error' : undefined}
                          data-testid="deposit-percent-input"
                          className={`h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${depositPctError ? 'border-destructive ring-1 ring-destructive' : ''}`}
                        />
                        <span className="text-sm text-muted-foreground">{t('quotes.editor.symbols.percent')}</span>
                      </div>
                    </div>
                    {depositPctError && (
                      <p id="quote-deposit-percent-error" className="text-xs text-destructive" data-testid="deposit-percent-error">
                        {depositPctError}
                      </p>
                    )}
                  </>
                )}
                {depositType === 'selected_lines' && (
                  <p
                    className={quote.depositType !== 'selected_lines' ? 'text-xs font-medium text-warning-foreground dark:text-warning' : 'text-xs text-muted-foreground'}
                    data-testid="quote-deposit-selected-hint"
                  >
                    {quote.depositType !== 'selected_lines'
                      ? t('quotes.editor.deposit.selectedLinesStagedHint')
                      : t('quotes.editor.deposit.selectedLinesHelp')}
                  </p>
                )}
              </div>
            )}
            <div className="mt-3 border-t pt-3">
              <div className="flex items-end justify-between gap-2">
                <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('quotes.editor.liveTotals.dueOnAcceptance')}</span>
                {/* Visual figure only; the SR-only summary node above announces the
                    full set of totals on any change. */}
                <span
                  className="min-w-0 break-words text-right text-2xl font-semibold tabular-nums"
                  data-testid="quote-total-due-on-acceptance"
                >
                  {formatMoney(railDue, currency)}
                </span>
              </div>
              {/* Deposit renders as a child of Due on acceptance (not a free-floating
                  figure) so the relationship between the two amounts is stated, and
                  the same shape repeats on the Detail totals card. */}
              {railDeposit != null && Number(railDeposit) > 0 && (
                <div className="mt-1 flex items-baseline justify-between gap-2 pl-3 text-sm" data-testid="deposit-due-figure">
                  <span className="text-muted-foreground">{t('quotes.editor.deposit.dueUpFront')}</span>
                  <span className="font-medium tabular-nums">{formatMoney(railDeposit, currency)}</span>
                </div>
              )}
            </div>
            {hasRecurring && (
              <>
                <div className="mt-2 flex items-baseline justify-between text-sm tabular-nums">
                  <span className="text-muted-foreground">{t('quotes.editor.liveTotals.firstPeriodTotal')}</span>
                  <span className="font-medium" data-testid="quote-total-first-period">{formatMoney(railTotal, currency)}</span>
                </div>
                <RecurringBillingNote className="mt-2" testId="quote-totals-recurring-hint" />
              </>
            )}
          </div>

          {/* Contents outline — a quiet nav under the totals (the rail's primary
              content). Only renders once there are 2+ blocks to navigate. */}
          {sortedBlocks.length >= 2 && (
            <nav
              aria-label={t('quotes.editor.outline.aria')}
              data-testid="quote-outline"
              className="rounded-lg border bg-card p-3 shadow-xs"
            >
              <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.editor.outline.title')}</h2>
              <ul className="space-y-0.5">
                {sortedBlocks.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => jumpToBlock(b.id)}
                      aria-current={activeOutlineId === b.id ? 'true' : undefined}
                      data-testid={`quote-outline-item-${b.id}`}
                      className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-xs transition-colors duration-150 ease-out focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                        activeOutlineId === b.id
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      {outlineLabel(b)}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.editor.terms.title')}</h2>
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
              placeholder={t('quotes.editor.terms.placeholder')}
            />
            <SrSaved show={termsSaved} testId="quote-terms-saved" />
          </div>
        </div>
      </div>

      {/* Below xl the full totals rail stacks under all blocks, which would break
          the edit→see-total loop mid-task — so a slim summary stays pinned to the
          viewport bottom while the rail's natural position is below the fold
          (sticky bottom releases once you scroll down to the real rail).
          aria-hidden: purely a visual affordance; the rail's live region is the
          canonical announcement and double-announcing the same figures is noise. */}
      <div
        aria-hidden="true"
        data-testid="quote-totals-sticky"
        className="sticky bottom-2 z-10 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border bg-card px-4 py-2 text-sm shadow-md xl:hidden"
      >
        <span className="flex items-baseline gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('quotes.editor.liveTotals.dueOnAcceptance')}</span>
          <span className="text-base font-semibold tabular-nums">{formatMoney(railDue, currency)}</span>
        </span>
        {Number(railMonthly) > 0 && (
          <span className="text-muted-foreground">
            {formatMoney(railMonthly, currency)}<span className="text-xs">{t('quotes.editor.units.perMonth')}</span>
          </span>
        )}
        {Number(railAnnual) > 0 && (
          <span className="text-muted-foreground">
            {formatMoney(railAnnual, currency)}<span className="text-xs">{t('quotes.editor.units.perYear')}</span>
          </span>
        )}
        {railDeposit != null && Number(railDeposit) > 0 && (
          <span className="text-muted-foreground">
            {t('quotes.editor.deposit.short')} <span className="font-medium tabular-nums text-foreground">{formatMoney(railDeposit, currency)}</span>
          </span>
        )}
      </div>

      {/* The "Tidy all descriptions" queue driver: an unattended PolishButton
          instance (no visible trigger of its own) that fires its preview dialog
          for the head of `tidyQueue`. Reusing PolishButton means the SAME
          fact-guard + approve/cancel preview a tech gets from the per-line
          button — nothing here applies AI output without that manual review.
          Keyed by line id so each queue advance is a fresh mount (resets
          PolishButton's internal state) and its mount-effect (`autoRun`) kicks
          off the next request automatically. */}
      {tidyQueue.length > 0 && (() => {
        const tidyLine = lines.find((l) => l.id === tidyQueue[0]);
        if (!tidyLine) return null;
        return (
          <PolishButton
            key={tidyLine.id}
            idSuffix={`quote-tidy-all-${tidyLine.id}`}
            hideTrigger
            autoRun
            getText={() => ({ description: tidyLine.description })}
            onApply={(r) => {
              if (r.description !== null) void editLine(tidyLine.id, { description: r.description || null }, pendingKey.line(tidyLine.id));
            }}
            onSettled={() => setTidyQueue((q) => q.slice(1))}
          />
        );
      })()}

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
        isLoading={pendingRemove ? isPending(pendingKey.block(pendingRemove.id)) : false}
        title={t('quotes.editor.confirm.removeSectionTitle')}
        message={
          pendingRemove?.blockType === 'line_items' && linesForBlock(pendingRemove.id).length > 0
            ? t('quotes.editor.confirm.removeSectionWithLines', { count: linesForBlock(pendingRemove.id).length })
            : t('quotes.editor.confirm.removeSectionMessage')
        }
        confirmLabel={t('quotes.editor.actions.removeSection')}
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
        isLoading={pendingLineRemove ? isPending(pendingKey.line(pendingLineRemove.id)) : false}
        title={t('quotes.editor.confirm.removeLineTitle')}
        message={
          pendingLineRemove
            ? t('quotes.editor.confirm.removeLineMessage', { name: lineTitle(pendingLineRemove) || t('quotes.editor.confirm.thisLine') })
            : ''
        }
        confirmLabel={t('quotes.editor.actions.removeLine')}
        confirmTestId="quote-line-remove-confirm"
      />
    </div>
  );
}

// A hover/focus-revealed "+ Add section" affordance in the gap above each
// block (and, mid-drag, a drop target) — inserting into the middle of a long
// quote no longer means adding at the bottom and walking the section up.
function InsertGap({ index, active, onToggle, label, dropActive, onDragOver, onDrop }: {
  index: number; active: boolean; onToggle: () => void; label: string;
  dropActive?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`group/gap relative -my-2 flex h-5 items-center justify-center rounded ${dropActive ? 'bg-primary/15' : ''}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={active}
        data-testid={`quote-insert-section-${index}`}
        className={`inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-0.5 text-[11px] font-medium transition-opacity focus:opacity-100 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
          active ? 'border-primary/40 text-primary opacity-100' : 'text-muted-foreground opacity-0 hover:text-foreground group-hover/gap:opacity-100'
        }`}
      >
        <span aria-hidden="true">+</span> {label}
      </button>
    </div>
  );
}
