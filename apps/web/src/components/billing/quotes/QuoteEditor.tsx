import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, Eye, EyeOff, Loader2, MoreHorizontal } from 'lucide-react';
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import { useOrgStore } from '../../../stores/orgStore';
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
import { computeQuoteTotals, computeQuoteProfit, computeLineTotal, markupPct, priceFromMarkup, toCents, fromCents, toQuoteDepositConfig, type QuoteLineForMath, type QuoteProfit, type QuoteTotals, type QuoteDepositType, type QuoteDepositConfig } from '@breeze/shared';
import { listCatalog, createCatalogItem, catalogItemImagePath, type CatalogItem } from '../../../lib/api/catalog';
import { ecExpressStatus, ecExpressImport, type EcProduct, type EcStatus, pax8Status, pax8Import, type Pax8Product, type Pax8PriceOption } from '../../../lib/api/distributors';
import RichTextEditor from '../../common/RichTextEditor';
import CatalogItemPicker from '../../catalog/CatalogItemPicker';
import CatalogEnrichButton from '../../catalog/CatalogEnrichButton';
import PolishButton from '../../catalog/PolishButton';
import DistributorLookup from './DistributorLookup';
import Pax8ProductLookup from './Pax8ProductLookup';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { useMenuKeyboard } from '../shared/menuKeyboard';
import { UnsavedBadge, RecurringBillingNote, MarginPanel } from '../billingUi';
import { useAuthedImage } from './useQuoteImage';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  type QuoteLineRecurrence,
  type ContractBlockContent,
  formatMoney,
  formatQuantity,
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
type AddableBlockType = 'heading' | 'rich_text' | 'image' | 'line_items' | 'contract';
const ADD_BLOCK_OPTIONS: { value: AddableBlockType; labelKey: string }[] = [
  { value: 'heading', labelKey: 'quotes.editor.blockTypes.heading' },
  { value: 'rich_text', labelKey: 'quotes.editor.blockTypes.richText' },
  { value: 'image', labelKey: 'quotes.editor.blockTypes.image' },
  { value: 'line_items', labelKey: 'quotes.editor.blockTypes.pricingTable' },
  { value: 'contract', labelKey: 'quotes.editor.blockTypes.contract' },
];

const BLOCK_TYPE_LABEL_KEYS: Record<string, string> = {
  heading: 'quotes.editor.blockTypes.heading',
  rich_text: 'quotes.editor.blockTypes.richText',
  image: 'quotes.editor.blockTypes.image',
  line_items: 'quotes.editor.blockTypes.pricingTable',
  contract: 'quotes.editor.blockTypes.contract',
};

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
function SrSaved({ show, label, testId }: { show: boolean; label?: string; testId?: string }) {
  const { t } = useTranslation('billing');
  // role="status" already implies aria-live="polite" — don't double it.
  return <span role="status" className="sr-only" data-testid={testId}>{show ? (label ?? t('quotes.editor.status.saved')) : ''}</span>;
}

// A field's save-state outline: amber while the edit is unsaved, a brief green
// pulse when it lands (driven by a ~1.5s saved-flash), nothing at rest. It's a
// box-shadow (ring), so it NEVER reflows neighbouring content — unlike the inline
// "Saved" text we tried before, which shifted layout as it appeared/disappeared.
// Pair with a constant `transition-shadow` on the field so both states fade.
// The dirty ring is the signal the autosave hint tells users to watch, so it
// uses the darker warning-strong indicator token at 2px — the bright --warning
// at 1px measured ~2.3:1 on a light card, below the 3:1 non-text minimum.
function fieldRing(dirty: boolean, saved: boolean): string {
  return dirty ? 'ring-2 ring-warning-strong' : saved ? 'ring-2 ring-success' : '';
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
  useEffect(() => { setTitle(quote.title ?? ''); setTitleDirty(false); }, [quote.title]);

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
        errorFallback: t('quotes.editor.errors.saveTerms'),
        onUnauthorized: UNAUTHORIZED,
      });
      setTermsDirty(false);
      refresh();
    }, t('quotes.editor.errors.saveTerms'));
    if (ok) flashTermsSaved();
  }, [termsDirty, terms, quote.id, refresh, runScoped, flashTermsSaved, t]);

  const saveTitle = useCallback(async () => {
    if (!titleDirty) return;
    const ok = await runScoped('title', async () => {
      await runAction({
        request: () => fetchWithAuth(`/quotes/${quote.id}`, {
          method: 'PATCH', body: JSON.stringify({ title: title.trim() || null }),
        }),
        errorFallback: t('quotes.editor.errors.saveTitle'),
        onUnauthorized: UNAUTHORIZED,
      });
      setTitleDirty(false);
      refresh();
    }, t('quotes.editor.errors.saveTitle'));
    if (ok) flashTitleSaved();
  }, [titleDirty, title, quote.id, refresh, runScoped, flashTitleSaved, t]);

  // ---- customer (organization) reassignment --------------------------------
  // Company choices for the customer select: the partner's org list, with the
  // quote's own org prepended if it isn't loaded (e.g. All-orgs scope) so the
  // select always shows a valid current value.
  const organizations = useOrgStore((s) => s.organizations);
  const orgOptions = useMemo(() => {
    const sorted = [...organizations].sort((a, b) => a.name.localeCompare(b.name));
    if (!sorted.some((o) => o.id === quote.orgId)) {
      sorted.unshift({
        id: quote.orgId,
        name: detail.billTo?.name?.trim() || quote.orgId.slice(0, 8),
      } as (typeof sorted)[number]);
    }
    return sorted;
  }, [organizations, quote.orgId, detail.billTo?.name]);

  // Local mirror so the select shows the chosen company instantly instead of
  // snapping back to the prop value while the PATCH is in flight (same pattern
  // as the deposit controls); resyncs from the server after each refresh().
  const [customerOrgId, setCustomerOrgId] = useState(quote.orgId);
  useEffect(() => { setCustomerOrgId(quote.orgId); }, [quote.orgId]);
  // Reassignment is destructive in effect (site + bill-to cleared, tax rate
  // re-resolved), so a select change stages here and a confirm step commits it —
  // a mis-click in the dropdown must not silently rewrite the quote's tax basis.
  const [pendingCustomer, setPendingCustomer] = useState<{ id: string; name: string } | null>(null);

  // Reassign the draft to another company. The server clears the site + bill-to
  // override and re-resolves the org's tax rate, so refresh() re-pulls the whole
  // detail to land the recomputed totals and the new bill-to in one hop.
  const saveCustomer = useCallback((orgId: string) => {
    if (orgId === quote.orgId) return;
    const name = orgOptions.find((o) => o.id === orgId)?.name ?? '';
    setCustomerOrgId(orgId);
    void runScoped('customer', async () => {
      try {
        await runAction({
          request: () => fetchWithAuth(`/quotes/${quote.id}`, {
            method: 'PATCH', body: JSON.stringify({ orgId }),
          }),
          errorFallback: t('quotes.editor.errors.saveCustomer'),
          successMessage: t('quotes.editor.customer.success', { name }),
          onUnauthorized: UNAUTHORIZED,
        });
      } catch (err) {
        // Snap back to the last-known server value, then re-pull: on an error
        // the client can't know whether the move landed, so re-converge on
        // server truth instead of asserting a rollback.
        setCustomerOrgId(quote.orgId);
        refresh();
        throw err;
      }
      refresh();
    }, t('quotes.editor.errors.saveCustomer'));
  }, [quote.id, quote.orgId, orgOptions, refresh, runScoped, t]);

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

  const onDepositTypeChange = useCallback((next: QuoteDepositType) => {
    setDepositType(next);
    if (next !== 'percent') setDepositPctError(null);
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
          errorFallback: t('quotes.editor.errors.imageAddedSectionFailed'),
          // No success toast — the image block visibly appears.
          onUnauthorized: UNAUTHORIZED,
        });
        setImageFile(null); setImageCaption(''); setImageUrl('');
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
        try {
          await runAction({
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
        resetContractForm();
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
      await runAction({
        request: () => addBlock(quote.id, body),
        errorFallback: t('quotes.editor.errors.addSection'),
        // No success toast — the new section visibly appears in the block list.
        onUnauthorized: UNAUTHORIZED,
      });
      setHeadingText(''); setRichText(''); setTableLabel('');
      refresh();
    }, t('quotes.editor.errors.addSection'));
  }, [addType, headingText, richText, tableLabel, imageFile, imageCaption, imageSource, imageUrl, contractTemplateId, contractVersion, contractVarValues, contractLabel, resetContractForm, quote.id, refresh, runScoped, t]);

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
    runScoped(`add-line:${blockId}`, () => doAddCatalog(blockId, item), t('quotes.editor.errors.addCatalogItem')),
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
          errorFallback: t('quotes.editor.errors.importDistributorItem'),
          // no success toast here — the "Item added" toast from doAddCatalog is the meaningful one
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
    runScoped(`line:${lineId}`, async () => {
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
    runScoped(scopeKey ?? `line:${lineId}`, async () => {
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
    runScoped(`block:${block.id}`, async () => {
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
  }, [linesForBlock, quote.id, refresh, t]);

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
        setLineOrder((m) => { const n = { ...m }; delete n[sourceBlockId]; delete n[targetBlockId]; return n; });
        delete lineReorderBase.current[sourceBlockId];
        delete lineReorderBase.current[targetBlockId];
        refresh();
      }
    })();
  }, [lines, linesForBlock, quote.id, refresh, t]);

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
            {t('quotes.editor.autosaveHint')}
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
          {showInternal ? t('quotes.editor.actions.hideCostMargin') : t('quotes.editor.actions.showCostMargin')}
        </button>
      </div>
      {canWrite && (
        <div className="flex max-w-3xl flex-wrap items-start gap-3">
          <div className="min-w-64 flex-1">
            <label htmlFor="quote-title" className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.title.label')}</label>
            <input
              id="quote-title"
              type="text"
              value={title}
              maxLength={200}
              placeholder={t('quotes.editor.title.placeholder')}
              onChange={(e) => { setTitle(e.target.value); setTitleDirty(true); }}
              onBlur={() => void saveTitle()}
              disabled={isPending('title')}
              data-testid="quote-title"
              className={`h-9 w-full rounded-md border bg-background px-3 text-sm font-medium transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(titleDirty, titleSaved)}`}
            />
            <SrSaved show={titleSaved} testId="quote-title-saved" />
          </div>
          {/* Customer reassignment (drafts only — this editor only mounts for
              drafts). Selecting a company saves immediately; the server clears
              the site + bill-to override and applies the new org's tax rate. */}
          <div className="w-64 max-w-full">
            <label htmlFor="quote-customer" className="mb-1 block text-xs text-muted-foreground">{t('quotes.editor.customer.label')}</label>
            <select
              id="quote-customer"
              value={customerOrgId}
              onChange={(e) => {
                const id = e.target.value;
                if (id === customerOrgId) return;
                setPendingCustomer({ id, name: orgOptions.find((o) => o.id === id)?.name ?? '' });
              }}
              disabled={isPending('customer')}
              title={t('quotes.editor.customer.help')}
              data-testid="quote-customer"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
            >
              {orgOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      {canWrite && (
        <div className="max-w-3xl rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-cover-page">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('quotes.editor.coverPage.title')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="quote-cover-page-summary">
                {cover.enabled ? t('quotes.editor.coverPage.summaryOn') : t('quotes.editor.coverPage.summaryOff')}
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={cover.enabled}
                onChange={(e) => saveCover({ ...cover, enabled: e.target.checked })}
                disabled={isPending('cover-page')}
                data-testid="quote-cover-page-enabled"
                className="h-4 w-4"
              />
              {t('quotes.editor.coverPage.enable')}
            </label>
          </div>

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
              {t('quotes.editor.emptyBlocks')}
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
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {addType === 'image'
                  ? (imageSource === 'url' ? t('quotes.editor.actions.fetchAddImage') : t('quotes.editor.actions.uploadAddImage'))
                  : t('quotes.editor.actions.addSection')}
              </button>
            </div>
          </div>
          )}
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
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">{t('quotes.editor.liveTotals.monthlyRecurring')}</dt>
                <dd data-testid="quote-total-monthly">{formatMoney(railMonthly, currency)}<span className="text-xs text-muted-foreground">{t('quotes.editor.units.perMonth')}</span></dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-muted-foreground">{t('quotes.editor.liveTotals.annualRecurring')}</dt>
                <dd data-testid="quote-total-annual">{formatMoney(railAnnual, currency)}<span className="text-xs text-muted-foreground">{t('quotes.editor.units.perYear')}</span></dd>
              </div>
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
            {canSeeMargin && showInternal && <MarginPanel profit={profit} currency={currency} />}
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
                  <p className="text-xs text-muted-foreground">
                    {t('quotes.editor.deposit.selectedLinesHelp')}
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

      {/* Customer reassignment confirm — warning (guarded, not destructive-red):
          the move is recoverable by moving back, but it clears site + bill-to and
          swaps the tax basis, so it must never ride on a single dropdown click. */}
      <ConfirmDialog
        open={pendingCustomer !== null}
        onClose={() => setPendingCustomer(null)}
        onConfirm={() => {
          const next = pendingCustomer;
          setPendingCustomer(null);
          if (next) saveCustomer(next.id);
        }}
        variant="warning"
        title={t('quotes.editor.customer.confirmTitle')}
        message={t('quotes.editor.customer.confirmMessage', { name: pendingCustomer?.name ?? '' })}
        confirmLabel={t('quotes.editor.customer.confirmLabel')}
        confirmTestId="quote-customer-confirm"
      />

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
        isLoading={pendingLineRemove ? isPending(`line:${pendingLineRemove.id}`) : false}
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
  const { t } = useTranslation('billing');
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
    <div className="rounded-lg border bg-card shadow-xs" data-testid={`quote-block-${block.id}`}>
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {BLOCK_TYPE_LABEL_KEYS[block.blockType] ? t(/* i18n-dynamic */ BLOCK_TYPE_LABEL_KEYS[block.blockType]) : block.blockType}
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
              labelUp={t('quotes.editor.actions.moveSectionUp')}
              labelDown={t('quotes.editor.actions.moveSectionDown')}
              testIdUp={`quote-block-move-up-${block.id}`}
              testIdDown={`quote-block-move-down-${block.id}`}
            />
            <button
              type="button"
              onClick={() => onRemoveBlock(block)}
              disabled={blockBusy}
              // Distinguishes this from the line rows' "Remove line" menu item —
              // two controls named bare "Remove" are indistinguishable to AT.
              aria-label={t('quotes.editor.actions.removeSection')}
              data-testid={`quote-block-remove-${block.id}`}
              className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {t('quotes.editor.actions.remove')}
            </button>
          </div>
        )}
      </div>

      <div className="p-4">
        {block.blockType === 'heading' && (
          canWrite ? (
            <input
              value={headingDraft}
              aria-label={t('quotes.editor.addSection.headingPlaceholder')}
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
                className={`h-9 w-full rounded-md border bg-background px-3 text-sm font-semibold transition-shadow disabled:opacity-60 ${fieldRing(labelDraft.trim() !== tableLabel.trim(), blockSaved)}`}
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
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={canWrite ? 5 : 4} className="px-2 py-6 text-center text-sm text-muted-foreground">
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
              </tbody>
            </table>
            </div>

            {/* Add line to this pricing table */}
            {canWrite && (
            <div className="mt-3 rounded-md border bg-background/40 p-4" data-testid={`quote-block-add-line-${block.id}`}>
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
    </div>
  );
}

// ── A single read-only pricing-table line (no write permission) ───────────
// Mirrors EditableLineRow's two-row shape — the customer-facing cells plus the
// internal cost/markup/net band — but renders everything as plain text.
function ReadonlyLineRow({ line: l, quoteId, currency, taxRate, isFirst, showInternal }: { line: QuoteLine; quoteId: string; currency: string; taxRate: string | null; isFirst: boolean; showInternal: boolean }) {
  const { t } = useTranslation('billing');
  const mk = markupPct(l.unitPrice, l.unitCost);
  const markupStr = mk === null ? t('quotes.editor.symbols.notAvailable') : formatPercent(mk / 100, { maximumFractionDigits: 2 });
  const netCents = l.unitCost === null
    ? null
    : toCents(computeLineTotal(l.quantity, l.unitPrice)) - toCents(computeLineTotal(l.quantity, l.unitCost));
  const tax = lineTaxAmount(l.lineTotal, l.taxable, taxRate);
  // Billing cadence rides in the money cells ('/mo', '/yr'); one-time is unmarked.
  const suffix = l.recurrence === 'monthly' ? t('quotes.editor.units.perMonth') : l.recurrence === 'annual' ? t('quotes.editor.units.perYear') : '';
  return (
    <>
      <tr className="border-t [&>td]:pt-4" data-testid={`quote-line-${l.id}`}>
        <td className="px-1.5 py-2">
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-2 py-1 text-xs text-[hsl(220_12%_40%)] dark:text-muted-foreground">
            {/* Full disclaimer on the first row, a subtle "Internal" tag on the rest. */}
            <span className="font-medium uppercase tracking-wide">{isFirst ? t('quotes.editor.internal.full') : t('quotes.editor.internal.short')}</span>
            <span data-testid={`quote-line-sku-${l.id}`}>{t('quotes.editor.line.sku')} {l.sku || t('quotes.editor.symbols.notAvailable')}</span>
            <span data-testid={`quote-line-partnumber-${l.id}`}>{t('quotes.editor.line.partNumberAbbr')} {l.partNumber || t('quotes.editor.symbols.notAvailable')}</span>
            <span data-testid={`quote-line-cost-${l.id}`}>{t('quotes.editor.line.cost')} {l.unitCost === null ? t('quotes.editor.symbols.notAvailable') : formatMoney(l.unitCost, currency)}</span>
            <span data-testid={`quote-line-markup-${l.id}`}>{t('quotes.editor.line.markup')} {markupStr}</span>
            <span className="ml-auto">{t('quotes.editor.line.profit')}{' '}
              <span className="font-medium tabular-nums text-foreground" data-testid={`quote-line-net-${l.id}`}>
                {netCents === null ? t('quotes.editor.symbols.notAvailable') : formatMoney(fromCents(netCents), currency)}
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
  const { t } = useTranslation('billing');
  // Per-field pending: only the in-flight control disables, so a slow qty save
  // never freezes price/name/desc (the scoped-pending backport — InvoiceEditor's
  // LineRow got this first). Remove keeps the whole-row key: the confirm-dialog
  // removal flow runs under `line:<id>` and should hold the row's actions.
  const fieldBusy = (field: string) => isPending(`line:${line.id}:${field}`);
  const removeBusy = isPending(`line:${line.id}`);
  const [name, setName] = useState(line.name ?? '');
  const [desc, setDesc] = useState(line.description ?? '');
  // Quantity edits/displays in its bare form ('3', not the stored '3.00') so the
  // input matches its own step="1" and the customer-facing rendering.
  const [qty, setQty] = useState(formatQuantity(line.quantity));
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
  // clip it; closes on outside click or Escape (which refocuses the trigger —
  // focus moved into the menu on open, so it would otherwise drop to <body>).
  const [movePos, setMovePos] = useState<{ top: number; left: number } | null>(null);
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
    <tr className="border-t align-top [&>td]:pt-4" data-testid={`quote-line-${line.id}`}>
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
              data-testid={`quote-line-name-${line.id}`}
              className={`h-9 w-full rounded-md border bg-background px-2 py-1 text-sm font-medium transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(nameDirty, saved)}`}
            />
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
          aria-describedby={fieldErrors.qty ? `quote-line-qty-error-${line.id}` : undefined}
          data-testid={`quote-line-qty-${line.id}`}
          className={`h-9 w-14 rounded-md border bg-background px-2 text-right text-sm tabular-nums transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldErrors.qty ? 'border-destructive ring-1 ring-destructive' : fieldRing(qtyDirty, saved)}`}
        />
      </td>
      <td className="px-1.5 py-2 text-right">
        <input
          type="number" min="0" step="0.01"
          value={price}
          aria-label={t('quotes.editor.table.unitPrice')}
          onChange={(e) => { setPrice(e.target.value); priceEdited.current = true; setFieldError('price', null); }}
          onBlur={commitPrice}
          disabled={fieldBusy('price')}
          aria-invalid={fieldErrors.price ? true : undefined}
          aria-describedby={fieldErrors.price ? `quote-line-price-error-${line.id}` : undefined}
          data-testid={`quote-line-price-${line.id}`}
          className={`h-9 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldErrors.price ? 'border-destructive ring-1 ring-destructive' : fieldRing(priceDirty, saved)}`}
        />
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
          className="ml-auto mt-1 block h-7 w-24 rounded-md border bg-background py-0 pl-2 pr-6 text-xs text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        >
          <option value="one_time">{t('quotes.editor.recurrence.one_time')}</option>
          <option value="monthly">{t('quotes.editor.recurrence.monthly')}</option>
          <option value="annual">{t('quotes.editor.recurrence.annual')}</option>
        </select>
      </td>
      <td className="whitespace-nowrap px-1.5 py-2 text-right tabular-nums">
        <span data-testid={`quote-line-total-${line.id}`}>{formatMoney(displayTotal, currency)}</span>
        {rec !== 'one_time' && (
          <span className="text-xs text-muted-foreground">{rec === 'monthly' ? t('quotes.editor.units.perMonth') : t('quotes.editor.units.perYear')}</span>
        )}
        <div className="text-xs font-normal text-muted-foreground" data-testid={`quote-line-tax-${line.id}`}>
          {displayTax !== null
            ? t('quotes.editor.table.taxSuffix', { amount: formatMoney(displayTax, currency) })
            : taxable ? t('quotes.editor.table.taxable') : null}
        </div>
        <SrSaved show={saved} testId={`quote-line-saved-${line.id}`} />
      </td>
      <td className="px-1.5 py-2 text-right">
        {/* ALL row-level actions live behind one overflow menu, so tabbing
            through a line is data-entry only — one stop instead of four, and
            no destructive button sitting mid-path between the price fields and
            the description. Same menu grammar as the header kebab
            (useMenuKeyboard: focus-on-open, arrow cycling, Esc → trigger). */}
        <div ref={moveMenuRef} className="inline-block">
          <button
            ref={moveTriggerRef}
            type="button"
            onClick={(e) => {
              if (movePos) { setMovePos(null); return; }
              const r = e.currentTarget.getBoundingClientRect();
              setMovePos({ top: r.bottom + 4, left: r.right });
            }}
            disabled={removeBusy}
            aria-label={t('quotes.editor.actions.lineActions')}
            aria-haspopup="menu"
            aria-expanded={movePos !== null}
            data-testid={`quote-line-actions-${line.id}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
          {movePos && (
            <div
              role="menu"
              ref={moveListRef}
              onKeyDown={onMoveListKeyDown}
              aria-label={t('quotes.editor.actions.lineActions')}
              style={{ position: 'fixed', top: movePos.top, left: movePos.left, transform: 'translateX(-100%)' }}
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
    <tr className="border-0" data-testid={`quote-line-desc-row-${line.id}`}>
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
        <textarea
          ref={descRef}
          value={desc}
          aria-label={t('quotes.editor.line.descriptionAria')}
          placeholder={t('quotes.editor.line.descriptionOptional')}
          onChange={(e) => { setDesc(e.target.value); descEdited.current = true; autoGrowDesc(); }}
          onBlur={commitDesc}
          rows={2}
          disabled={fieldBusy('desc')}
          data-testid={`quote-line-desc-${line.id}`}
          className={`min-h-9 w-full resize-y overflow-hidden rounded-md border bg-background px-2 py-1 text-sm text-muted-foreground transition-shadow focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(descDirty, saved)}`}
        />
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
            {imageBusy ? t('quotes.editor.actions.uploading') : line.imageId ? t('quotes.editor.actions.replaceImage') : t('quotes.editor.actions.addImage')}
          </button>
          <button
            type="button"
            onClick={() => setImageUrlOpen((v) => !v)}
            disabled={imageBusy || fieldBusy('image')}
            aria-expanded={imageUrlOpen}
            data-testid={`quote-line-image-url-toggle-${line.id}`}
            className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('quotes.editor.actions.fromUrl')}
          </button>
          {line.imageId && !imageBusy && (
            <button
              type="button"
              onClick={() => void edit({ imageId: null }, 'image')}
              disabled={fieldBusy('image')}
              data-testid={`quote-line-image-remove-${line.id}`}
              className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              {t('quotes.editor.actions.removeImage')}
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
        Collapsed by default via the editor's "Show cost & margin" toggle; kept in
        the DOM (hidden) rather than unmounted so totals/draft wiring stays live. */}
    <tr className={`border-0 ${showInternal ? '' : 'hidden'}`} data-testid={`quote-line-internal-${line.id}`}>
      <td colSpan={5} className="px-2 pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-2 py-1 text-xs text-[hsl(220_12%_40%)] dark:text-muted-foreground">
          {/* Full disclaimer on the first row; a subtle "Internal" tag persists on
              every following row so a writer scanning mid-table never mistakes the
              cost/markup band for customer-facing copy. */}
          <span className="font-medium uppercase tracking-wide">{isFirst ? t('quotes.editor.internal.full') : t('quotes.editor.internal.short')}</span>
          <label className="flex items-center gap-1">{t('quotes.editor.line.sku')}
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
          <label className="flex items-center gap-1">{t('quotes.editor.line.partNumberAbbr')}
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
          <label className="flex items-center gap-1">{t('quotes.editor.line.cost')}
            <input
              type="number" min="0" step="0.01"
              value={cost}
              onChange={(e) => { setCost(e.target.value); costEdited.current = true; setFieldError('cost', null); }}
              onBlur={commitCost}
              disabled={fieldBusy('cost')}
              aria-invalid={fieldErrors.cost ? true : undefined}
              aria-describedby={fieldErrors.cost ? `quote-line-cost-error-${line.id}` : undefined}
              data-testid={`quote-line-cost-${line.id}`}
              className={`h-6 w-20 rounded border bg-background px-1 text-right tabular-nums text-foreground transition-shadow ${fieldErrors.cost ? 'border-destructive ring-1 ring-destructive' : fieldRing(costDirty, saved)}`}
            />
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
              className="h-6 w-16 rounded border bg-background px-1 text-right tabular-nums text-foreground disabled:opacity-60"
            />{t('quotes.editor.symbols.percent')}
            {cost.trim() === '' && <span id={`quote-line-markup-hint-${line.id}`} className="sr-only">{t('quotes.editor.line.enterCostFirstMarkupSentence')}</span>}
          </label>
          <span className="ml-auto">{t('quotes.editor.line.profit')}{' '}
            <span className="font-medium tabular-nums text-foreground" data-testid={`quote-line-net-${line.id}`}>
              {netCents === null ? t('quotes.editor.symbols.notAvailable') : formatMoney(fromCents(netCents), currency)}
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

// A persisted `contract` block in the editor. The admin serialization attaches
// the raw authoring fields (content.authoring), so — unlike portal/public — the
// editor can render an editable manual-variable form (PATCH variableValues), an
// explicit "Update to vN" nudge when the pin is behind the latest published
// version, and an inline list of unresolved (empty) manual variables (the
// send-time CONTRACT_VARIABLES_UNRESOLVED equivalent surfaced on the block).
// Without authoring (legacy / uploaded / read-only user) it degrades to a
// read-only summary card.
function ContractBlockEditor({
  block, canWrite, onEditBlock,
}: {
  block: QuoteBlock;
  canWrite: boolean;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation('billing');
  const c = (block.content ?? {}) as Partial<ContractBlockContent>;
  const authoring = c.authoring;
  const templateName = c.templateName?.trim() || t('quotes.editor.contract.untitledTemplate');
  const versionNumber = c.versionNumber ?? 0;

  const manualVars = useMemo(() => authoring?.declaredVariables.filter((v) => v.kind === 'manual') ?? [], [authoring]);
  const autoVars = useMemo(() => authoring?.declaredVariables.filter((v) => v.kind === 'auto') ?? [], [authoring]);

  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...(authoring?.variableValues ?? {}) }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flash = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, []);

  // Resync the draft from the server's persisted values after a save's refetch,
  // but only when the user hasn't diverged (same guard as the heading/rich-text
  // drafts): if the local draft no longer matches what we last synced, keep it.
  const lastSynced = useRef(JSON.stringify(authoring?.variableValues ?? {}));
  useEffect(() => {
    const nextStr = JSON.stringify(authoring?.variableValues ?? {});
    setDraft((cur) => (JSON.stringify(cur) === lastSynced.current ? { ...(authoring?.variableValues ?? {}) } : cur));
    lastSynced.current = nextStr;
  }, [authoring]);

  const unfilled = useMemo(
    () => manualVars.filter((v) => !(draft[v.name] ?? '').trim()).map((v) => v.name),
    [manualVars, draft],
  );
  const latestNumber = authoring?.latestPublishedVersionNumber ?? null;
  const latestId = authoring?.latestPublishedVersionId ?? null;
  const canUpdate = latestId != null && latestNumber != null && latestNumber > versionNumber;

  const commit = useCallback(async (versionOverride?: string) => {
    if (!authoring) return;
    const names = manualVars.map((v) => v.name);
    const missing = names.filter((n) => !(draft[n] ?? '').trim());
    if (missing.length > 0) {
      setErrors(Object.fromEntries(missing.map((n) => [n, t('quotes.editor.contract.variableRequired')])));
      return;
    }
    setErrors({});
    const variableValues = Object.fromEntries(names.map((n) => [n, (draft[n] ?? '').trim()]));
    const content: Record<string, unknown> = {
      templateId: authoring.templateId,
      templateVersionId: versionOverride ?? authoring.templateVersionId,
      variableValues,
      ...(c.label?.trim() ? { label: c.label.trim() } : {}),
    };
    setBusy(true);
    try { if (await onEditBlock(block, content)) flash(); } finally { setBusy(false); }
  }, [authoring, manualVars, draft, c.label, block, onEditBlock, flash, t]);

  // No authoring (legacy/uploaded) or read-only user → read-only summary card.
  if (!authoring || !canWrite) {
    return (
      <div className="space-y-2 text-sm" data-testid={`quote-block-contract-content-${block.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.label?.trim() || templateName}</span>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {t('quotes.editor.contract.pinnedVersion', { version: versionNumber })}
          </span>
        </div>
        {c.label?.trim() && <p className="text-xs text-muted-foreground">{templateName}</p>}
        {!authoring && <p className="text-xs text-muted-foreground">{t('quotes.editor.contract.readOnlyHint')}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm" data-testid={`quote-block-contract-editor-${block.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.label?.trim() || templateName}</span>
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground" data-testid={`quote-block-contract-version-${block.id}`}>
          {t('quotes.editor.contract.pinnedVersion', { version: versionNumber })}
        </span>
        <SrSaved show={saved} testId={`quote-block-contract-saved-${block.id}`} />
        {canUpdate && (
          <button
            type="button"
            onClick={() => void commit(latestId!)}
            disabled={busy}
            data-testid={`quote-block-contract-update-${block.id}`}
            className="ml-auto rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            {t('quotes.editor.contract.updateToVersion', { version: latestNumber })}
          </button>
        )}
      </div>

      {autoVars.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('quotes.editor.contract.autoVariablesTitle')}</p>
          <ul className="space-y-1">
            {autoVars.map((v) => (
              <li
                key={v.name}
                data-testid={`quote-block-contract-auto-${block.id}-${v.name}`}
                className="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1 text-xs"
              >
                <span className="font-medium">{v.label ?? v.name}</span>
                <span className="font-mono text-muted-foreground">{`{{${v.name}}}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {manualVars.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('quotes.editor.contract.manualVariablesTitle')}</p>
          {manualVars.map((v) => (
            <div key={v.name}>
              <label htmlFor={`quote-block-contract-var-${block.id}-${v.name}`} className="mb-0.5 block text-xs text-muted-foreground">
                {v.label ?? v.name}
              </label>
              <input
                id={`quote-block-contract-var-${block.id}-${v.name}`}
                type="text"
                value={draft[v.name] ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setDraft((cur) => ({ ...cur, [v.name]: val }));
                  setErrors((cur) => { if (!cur[v.name]) return cur; const next = { ...cur }; delete next[v.name]; return next; });
                }}
                disabled={busy}
                data-testid={`quote-block-contract-var-${block.id}-${v.name}`}
                aria-invalid={errors[v.name] ? true : undefined}
                className={`h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${errors[v.name] ? 'border-destructive' : ''}`}
              />
              {errors[v.name] && (
                <p className="mt-0.5 text-xs text-destructive" data-testid={`quote-block-contract-var-error-${block.id}-${v.name}`}>
                  {errors[v.name]}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {unfilled.length > 0 && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground dark:text-warning" data-testid={`quote-block-contract-unresolved-${block.id}`}>
          {t('quotes.editor.contract.unresolvedWarning', { names: unfilled.join(', ') })}
        </p>
      )}

      {manualVars.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy}
            data-testid={`quote-block-contract-save-${block.id}`}
            className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t('quotes.editor.contract.saveVariables')}
          </button>
        </div>
      )}
    </div>
  );
}

// Editor image preview. GET /quotes/:id/images/:imageId requires the Bearer auth
// header, so a bare <img src> would 401 (web-1). Mirror QuoteWorkspace's PDF
// preview: fetchWithAuth → blob → object URL, revoked on unmount/change.
function QuoteImagePreview({ quoteId, imageId, caption }: { quoteId: string; imageId: string; caption?: string }) {
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
