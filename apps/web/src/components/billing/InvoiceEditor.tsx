import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { formatTime } from '../../lib/dateTimeFormat';
import { showToast } from '../shared/Toast';
import { UnsavedBadge, MarginPanel, useShowMargin } from './billingUi';
import { useSavedFlash, SrSaved, fieldRing, unsavedHintId, UnsavedFieldHint } from './shared/saveCues';
import {
  type InvoiceDetail,
  type InvoiceLine,
  formatMoney,
  lineTitle,
  computeInvoiceProfit,
} from './invoiceTypes';
import CatalogItemPicker from '../catalog/CatalogItemPicker';
import PolishButton from '../catalog/PolishButton';
import { listCatalog, type CatalogItem } from '../../lib/api/catalog';
import { formatPercent } from '@/lib/i18n/format';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: InvoiceDetail;
  onChanged: () => void;
  /** Reports "is anything still saving / sitting dirty?" to the workspace so
   *  the header's Issue buttons can wait for quiescence instead of issuing an
   *  invoice that's missing a just-typed edit (mirrors the quote editor). */
  onPendingEditsChange?: (hasPendingEdits: boolean) => void;
  /** Reports every save FAILURE. Quiescence alone is not a safe Issue signal:
   *  a failed delete-flush restores its rows and a failed line blur-save
   *  clears its in-flight key, both of which read as "quiet" — the workspace
   *  forwards this to InvoiceActions so a queued Issue is canceled instead. */
  onSaveFailure?: () => void;
  /** Registers a "flush deferred deletions NOW" hook with the workspace, so a
   *  held Issue fires as soon as the deferred DELETE lands instead of waiting
   *  out the undo grace window (mirrors the quote editor's Send bridge). */
  onRegisterPendingDeleteFlush?: (flush: (() => void) | null) => void;
  /** Controlled cost/margin visibility from the workspace's header toggle;
   *  standalone mounts (tests) fall back to the shared persisted hook. */
  showMargin?: boolean;
}

type AddMode = 'catalog' | 'manual';

// Grace window for undo-able line deletion: the line leaves the UI instantly,
// but the DELETE fires only after this window (or on Issue/unmount/page-hide),
// so a fat-fingered Remove on a money document is recoverable.
const UNDO_GRACE_MS = 6000;

/** One deferred line deletion awaiting its grace window. `memberIds` includes
 *  bundle children — the server FK-cascades them, so they hide and restore as
 *  one unit with their parent. */
type PendingDelete = { id: string; memberIds: string[]; timer: ReturnType<typeof setTimeout> };

export default function InvoiceEditor({ detail, onChanged, onPendingEditsChange, onSaveFailure, onRegisterPendingDeleteFlush, showMargin }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const canWrite = can('invoices', 'write');
  // Cost/margin is a read affordance (mirrors InvoiceDetail + the quote rails'
  // `quotes:read` gate) — anyone who can read the invoice sees it, but ONLY
  // while the persisted "show cost & margin" preference is on: the margin panel
  // must honor "no margin on screen" here exactly as it does on every quote
  // surface (a screen-sharing tech who hid margin on a quote must not have it
  // reappear the moment a draft invoice opens).
  const canSeeMargin = can('invoices', 'read');
  const [fallbackShowMargin] = useShowMargin();
  const effectiveShowMargin = showMargin ?? fallbackShowMargin;
  const { invoice, lines: serverLines } = detail;
  const currency = invoice.currencyCode;

  // ---- undo-able deletion (deferred DELETE + grace window) -----------------
  // Confirming a line removal hides it here and starts a grace timer; the real
  // DELETE fires when the timer lapses, on Issue (via the workspace flush
  // bridge), on unmount, or on page-hide — never lost, always undoable inside
  // the window. Mirrors the quote editor's model.
  const pendingDeleteEntries = useRef<Map<string, PendingDelete>>(new Map());
  // Two hidden-row sets with different contracts: `pending` rows await their
  // DELETE (they block Issue via hasPendingEdits and can still be undone);
  // `flushed` rows' DELETE already SUCCEEDED, so they stay hidden but must NOT
  // hold Issue — coupling their clearance to the refetch would let one failed
  // quiet reload brick the Issue buttons over a deletion that actually landed.
  const [pendingDeletedLineIds, setPendingDeletedLineIds] = useState<ReadonlySet<string>>(() => new Set());
  const [flushedDeletedLineIds, setFlushedDeletedLineIds] = useState<ReadonlySet<string>>(() => new Set());
  const lines = useMemo(
    () => serverLines.filter((l) => !pendingDeletedLineIds.has(l.id) && !flushedDeletedLineIds.has(l.id)),
    [serverLines, pendingDeletedLineIds, flushedDeletedLineIds],
  );
  // Retire hidden ids once the refetch actually drops the rows, so the sets
  // can't grow stale entries across reloads.
  useEffect(() => {
    const present = new Set(serverLines.map((l) => l.id));
    const trim = (s: ReadonlySet<string>): ReadonlySet<string> => {
      if (s.size === 0) return s;
      const n = new Set([...s].filter((id) => present.has(id)));
      return n.size === s.size ? s : n;
    };
    setPendingDeletedLineIds(trim);
    setFlushedDeletedLineIds(trim);
  }, [serverLines]);

  const profit = useMemo(() => computeInvoiceProfit(lines), [lines]);

  // Per-item "saving" state, keyed so one in-flight mutation never freezes the
  // rest of the editor. Keys: 'notes', 'terms', 'addLine', `qty-<lineId>`,
  // `price-<lineId>`, `name-<lineId>`, `desc-<lineId>`, `taxable-<lineId>`,
  // `visible-<lineId>`, `remove-<lineId>`. `pending` drives disabled styling;
  // `inFlight` is the synchronous double-submit guard (state updates are async).
  const inFlight = useRef<Set<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const isPending = useCallback((key: string) => pending.has(key), [pending]);
  // Timestamp of the last successful mutation, for the quiet "Saved 2:41 PM"
  // indicator near the autosave hint — null until this session's first save
  // (nothing to report before that; the indicator itself stays unrendered).
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

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
        setLastSavedAt(Date.now());
        return true;
      } catch (err) {
        handleActionError(err, errMsg);
        onSaveFailure?.();
        return false;
      } finally {
        inFlight.current.delete(key);
        setPending((s) => { const n = new Set(s); n.delete(key); return n; });
      }
    },
    [onSaveFailure],
  );

  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesSaved, flashNotesSaved] = useSavedFlash();
  const [terms, setTerms] = useState(invoice.termsAndConditions ?? '');
  const [termsDirty, setTermsDirty] = useState(false);
  const [termsSaved, flashTermsSaved] = useSavedFlash();

  // Surface "is anything still saving / sitting dirty?" to the workspace so the
  // header Issue buttons can wait for quiescence. Pending covers every in-flight
  // mutation (line/add/remove/notes/terms); the dirty flags cover the rail's
  // blur-to-save fields. Per-line dirty state isn't lifted — clicking Issue
  // blurs the focused field, whose commit lands in `pending` before the action
  // fires (mirrors the quote editor's contract). Deferred deletions count too:
  // their DELETE hasn't fired yet, so Issue must not snapshot an invoice the
  // user has visibly already trimmed (clicking Issue also flushes them — see
  // onRegisterPendingDeleteFlush).
  const hasPendingEdits = pending.size > 0 || notesDirty || termsDirty || pendingDeletedLineIds.size > 0;
  useEffect(() => { onPendingEditsChange?.(hasPendingEdits); }, [hasPendingEdits, onPendingEditsChange]);
  // Clear on unmount so a stale `true` can't lock Issue after the editor is gone
  // (e.g. the invoice was just issued and the tab switched).
  useEffect(() => () => onPendingEditsChange?.(false), [onPendingEditsChange]);

  // Add-line form
  const [addMode, setAddMode] = useState<AddMode>('catalog');
  const [manualName, setManualName] = useState('');
  const [manualDesc, setManualDesc] = useState('');
  const [manualQty, setManualQty] = useState('1');
  const [manualPrice, setManualPrice] = useState('0.00');
  const [manualTaxable, setManualTaxable] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  const [pickQty, setPickQty] = useState('1');

  useEffect(() => { setNotes(invoice.notes ?? ''); setNotesDirty(false); }, [invoice.notes]);
  useEffect(() => { setTerms(invoice.termsAndConditions ?? ''); setTermsDirty(false); }, [invoice.termsAndConditions]);

  const loadCatalog = useCallback(async () => {
    const res = await listCatalog({ isActive: true, limit: 200 });
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), t('invoiceEditor.errors.loadCatalog')); return; }
    const body = (await res.json()) as { data: CatalogItem[] };
    setCatalog(body.data ?? []);
  }, [t]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const unapprovedCount = useMemo(
    () => lines.filter((l) => l.isUnapprovedTime).length,
    [lines],
  );

  // Only top-level (non-child) lines render as editable rows; bundle children are
  // shown read-only nested under their parent.
  const parentLines = useMemo(() => lines.filter((l) => l.parentLineId === null), [lines]);
  const childrenOf = useCallback(
    (parentId: string) => lines.filter((l) => l.parentLineId === parentId),
    [lines],
  );

  const refresh = useCallback(() => onChanged(), [onChanged]);

  const addLine = useCallback(() =>
    runScoped('addLine', async () => {
      if (addMode === 'manual') {
        // A line needs at least a title (name) or a description (mirrors the API refine).
        if (!manualName.trim() && !manualDesc.trim()) return;
        // Guard qty/price with the same rules as the inline commit path so a bad
        // manual entry is explained, not silently coerced (Number('abc') → NaN).
        const q = Number(manualQty);
        const p = Number(manualPrice);
        if (!Number.isFinite(q) || q <= 0) {
          handleActionError(new Error('invalid quantity'), t('invoiceEditor.errors.quantityGreaterThanZero'));
          return;
        }
        if (!Number.isFinite(p) || p < 0) {
          handleActionError(new Error('invalid price'), t('invoiceEditor.errors.nonNegativeUnitPrice'));
          return;
        }
        await runAction({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/lines`, {
            method: 'POST',
            body: JSON.stringify({
              name: manualName.trim() || null,
              description: manualDesc.trim() || null,
              quantity: q,
              unitPrice: p,
              taxable: manualTaxable,
            }),
          }),
          errorFallback: t('invoiceEditor.errors.addLine'),
          successMessage: t('invoiceEditor.success.lineAdded'),
          onUnauthorized: UNAUTHORIZED,
        });
        setManualName(''); setManualDesc(''); setManualQty('1'); setManualPrice('0.00'); setManualTaxable(false);
      } else {
        if (!picked) return;
        const pq = Number(pickQty);
        if (!Number.isFinite(pq) || pq <= 0) {
          handleActionError(new Error('invalid quantity'), t('invoiceEditor.errors.quantityGreaterThanZero'));
          return;
        }
        const path = picked.isBundle
          ? `/invoices/${invoice.id}/lines/bundle`
          : `/invoices/${invoice.id}/lines/catalog`;
        const body = picked.isBundle
          ? { bundleId: picked.id, quantity: pq }
          : { catalogItemId: picked.id, quantity: pq };
        await runAction({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify(body) }),
          errorFallback: t('invoiceEditor.errors.addLine'),
          successMessage: t('invoiceEditor.success.lineAdded'),
          onUnauthorized: UNAUTHORIZED,
        });
        setPicked(null); setPickQty('1');
      }
      refresh();
    }, t('invoiceEditor.errors.addLine')),
  [runScoped, addMode, manualName, manualDesc, manualQty, manualPrice, manualTaxable, picked, pickQty, invoice.id, refresh, t]);

  // Inline edit of an existing line. `scopeKey` is per-field so one in-flight
  // save (e.g. qty) never disables the sibling controls. Returns whether it
  // succeeded so the row can flash a quiet "Saved" cue.
  const patchLine = useCallback((lineId: string, patch: Record<string, unknown>, scopeKey: string) =>
    runScoped(scopeKey, async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/lines/${lineId}`, {
          method: 'PATCH', body: JSON.stringify(patch),
        }),
        errorFallback: t('invoiceEditor.errors.updateLine'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('invoiceEditor.errors.updateLine')),
  [runScoped, invoice.id, refresh, t]);

  // The real DELETE — only ever reached through the deferred-deletion lifecycle
  // below. No success toast: the undo toast at removal time already told the
  // user. keepalive so a flush fired from pagehide survives the page teardown.
  const deleteLine = useCallback((lineId: string) =>
    runScoped(`remove-${lineId}`, async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/lines/${lineId}`, { method: 'DELETE', keepalive: true }),
        errorFallback: t('invoiceEditor.errors.removeLine'),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    }, t('invoiceEditor.errors.removeLine')),
  [runScoped, invoice.id, refresh, t]);

  // undo → cancel the timer, unhide (nothing was ever sent).
  const undoLineDelete = useCallback((lineId: string) => {
    const entry = pendingDeleteEntries.current.get(lineId);
    if (!entry) {
      // Already flushed (e.g. an Issue click landed the DELETE before the undo
      // toast expired) — the deletion is real now. Say so: a silently dead
      // Undo click reads as "the app ate my line back... or did it?"
      showToast({ type: 'warning', message: t('invoiceEditor.undo.tooLate') });
      return;
    }
    clearTimeout(entry.timer);
    pendingDeleteEntries.current.delete(lineId);
    setPendingDeletedLineIds((s) => {
      const n = new Set(s);
      for (const id of entry.memberIds) n.delete(id);
      return n;
    });
  }, [t]);

  // flush → fire the real DELETE; on failure the line is honestly restored (it
  // IS still there) on top of the delete path's own error toast.
  const flushLineDelete = useCallback(async (lineId: string) => {
    const entry = pendingDeleteEntries.current.get(lineId);
    if (!entry) return; // undone, or another flush already owns it
    clearTimeout(entry.timer);
    pendingDeleteEntries.current.delete(lineId);
    const ok = await deleteLine(lineId);
    // Success or failure, the ids leave the PENDING set (they no longer hold
    // Issue): success promotes them to the flushed set so they stay hidden
    // until the refetch drops the rows; failure just unhides them.
    setPendingDeletedLineIds((s) => {
      const n = new Set(s);
      for (const id of entry.memberIds) n.delete(id);
      return n;
    });
    if (ok) {
      setFlushedDeletedLineIds((s) => {
        const n = new Set(s);
        for (const id of entry.memberIds) n.add(id);
        return n;
      });
    }
  }, [deleteLine]);

  const startLineDelete = useCallback((lineId: string) => {
    if (pendingDeleteEntries.current.has(lineId)) return;
    // Bundle children ride with their parent (the server cascade deletes them),
    // so they hide — and restore — as one unit.
    const memberIds = [lineId, ...serverLines.filter((l) => l.parentLineId === lineId).map((l) => l.id)];
    const timer = setTimeout(() => { void flushLineDelete(lineId); }, UNDO_GRACE_MS);
    pendingDeleteEntries.current.set(lineId, { id: lineId, memberIds, timer });
    setPendingDeletedLineIds((s) => {
      const n = new Set(s);
      for (const id of memberIds) n.add(id);
      return n;
    });
    showToast({
      type: 'undo',
      message: t('invoiceEditor.undo.lineDeleted'),
      duration: UNDO_GRACE_MS,
      onUndo: () => undoLineDelete(lineId),
    });
  }, [serverLines, flushLineDelete, undoLineDelete, t]);

  // Flush every deferred deletion immediately. Issue (via the workspace),
  // unmount and page-hide all route through here — the grace window is a UI
  // nicety, never a way for a confirmed deletion to be lost or to outlive the
  // editor.
  const flushAllPendingDeletes = useCallback(() => {
    for (const e of [...pendingDeleteEntries.current.values()]) void flushLineDelete(e.id);
  }, [flushLineDelete]);
  const flushAllRef = useRef(flushAllPendingDeletes);
  useEffect(() => { flushAllRef.current = flushAllPendingDeletes; }, [flushAllPendingDeletes]);
  useEffect(() => {
    // Two teardown signals, deliberately layered:
    // - visibilitychange→hidden fires while the page is still alive, so the
    //   full request path (including a token refresh, which is NOT keepalive)
    //   can complete and failures restore + toast normally. This is the
    //   primary flush for tab switches and most navigations.
    // - pagehide (not beforeunload: pagehide also fires on bfcache
    //   navigations) is the last resort for hard teardowns; the DELETE goes
    //   out with keepalive so it survives the page being torn down.
    const onVisibilityHidden = () => { if (document.visibilityState === 'hidden') flushAllRef.current(); };
    const onPageHide = () => flushAllRef.current();
    document.addEventListener('visibilitychange', onVisibilityHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityHidden);
      window.removeEventListener('pagehide', onPageHide);
      flushAllRef.current();
    };
  }, []);
  useEffect(() => {
    onRegisterPendingDeleteFlush?.(flushAllPendingDeletes);
    return () => onRegisterPendingDeleteFlush?.(null);
  }, [onRegisterPendingDeleteFlush, flushAllPendingDeletes]);

  const saveNotes = useCallback(async () => {
    if (!notesDirty) return;
    const ok = await runScoped('notes', async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, {
          method: 'PATCH', body: JSON.stringify({ notes }),
        }),
        errorFallback: t('invoiceEditor.errors.saveNotes'),
        successMessage: t('invoiceEditor.success.notesSaved'),
        onUnauthorized: UNAUTHORIZED,
      });
      setNotesDirty(false);
      refresh();
    }, t('invoiceEditor.errors.saveNotes'));
    if (ok) flashNotesSaved();
  }, [notesDirty, notes, invoice.id, refresh, runScoped, flashNotesSaved, t]);

  const saveTerms = useCallback(async () => {
    if (!termsDirty) return;
    const ok = await runScoped('terms', async () => {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, {
          method: 'PATCH', body: JSON.stringify({ termsAndConditions: terms }),
        }),
        errorFallback: t('invoiceEditor.errors.saveTerms'),
        successMessage: t('invoiceEditor.success.termsSaved'),
        onUnauthorized: UNAUTHORIZED,
      });
      setTermsDirty(false);
      refresh();
    }, t('invoiceEditor.errors.saveTerms'));
    if (ok) flashTermsSaved();
  }, [termsDirty, terms, invoice.id, refresh, runScoped, flashTermsSaved, t]);

  // Tax rate is inherited from partner Billing settings, not set per invoice. When
  // a line is marked taxable but no rate is configured, the Tax row reads $0.00
  // with no obvious cause — point the operator at where the rate actually lives.
  const hasTaxableLine = lines.some((l) => l.taxable);
  const noTaxRate = !invoice.taxRate || Number(invoice.taxRate) <= 0;

  return (
    <div className="space-y-6" data-testid="invoice-editor">
      {/* Autosave hint + quiet sync indicator — same save-language strip as the
          quote editor, so "how do I save?" has one answer across billing. */}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground" data-testid="invoice-editor-autosave-hint">
            {t('invoiceEditor.autosaveHint')}
          </p>
          {/* "Saving…" while any mutation is in flight, else "Saved 2:41 PM" once
              this session has saved at least once. Purely informational — never
              disables Issue or any other control. */}
          {(pending.size > 0 || lastSavedAt !== null) && (
            <p className="text-xs text-muted-foreground" data-testid="invoice-editor-last-saved">
              {pending.size > 0
                ? t('invoiceEditor.lastSaved.saving')
                : t('invoiceEditor.lastSaved.saved', { time: formatTime(lastSavedAt as number, { hour: '2-digit', minute: '2-digit' }) })}
            </p>
          )}
        </div>
      )}
      {unapprovedCount > 0 && (
        <div
          className="rounded-md border border-warning/40 bg-warning/15 px-4 py-3 text-sm text-[hsl(36_92%_28%)] dark:text-warning"
          data-testid="invoice-unapproved-warning"
        >
          {t('invoiceEditor.unapprovedTime', { count: unapprovedCount })}
        </div>
      )}

      {/* xl (not lg): matches the quote editor — below xl the rail stacks under
          the content so the lines table isn't starved into sideways scrolling.
          min-w-0 lets the 1fr track shrink below the table's content width. */}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        {/* Lines */}
        <div className="min-w-0 space-y-4">
          <div className="rounded-lg border bg-card shadow-xs">
            {/* Labeled, keyboard-reachable scroll region: the row's fixed-width
                inputs set a min-content width beyond phone viewports, so the
                table scrolls inside the card instead of bleeding past its
                rounded edge (same pattern as QuoteDetail's LineTable). */}
            <div className="overflow-x-auto" role="region" aria-label={t('invoiceEditor.linesScrollAria')} tabIndex={0}>
            <table className="w-full min-w-[40rem] text-sm" data-testid="invoice-editor-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t('invoiceEditor.table.item')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceEditor.table.qty')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceEditor.table.price')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('invoiceEditor.table.tax')}</th>
                  <th className="px-3 py-2 text-center font-medium" title={t('invoiceEditor.table.customerVisibleTitle')}>{t('invoiceEditor.table.customerVisible')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('invoiceEditor.table.total')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {parentLines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      {t('invoiceEditor.table.empty')}
                    </td>
                  </tr>
                ) : (
                  parentLines.map((l) => (
                    <LineRow
                      key={l.id}
                      line={l}
                      children={childrenOf(l.id)}
                      currency={currency}
                      isPending={isPending}
                      onPatch={patchLine}
                      onRemove={startLineDelete}
                    />
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>

          {/* Add line */}
          {canWrite && (
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-add-line">
            {/* Segmented control — same vocabulary as the New-invoice source toggle
                so "pick one mode" looks identical everywhere in the invoice flow. */}
            <div className="mb-3 inline-flex gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label={t('invoiceEditor.addLine.sourceAria')}>
              {(['catalog', 'manual'] as AddMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAddMode(m)}
                  aria-pressed={addMode === m}
                  data-testid={`invoice-add-mode-${m}`}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                    addMode === m ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'catalog' ? t('invoiceEditor.addLine.catalogItem') : t('invoiceEditor.addLine.manualLine')}
                </button>
              ))}
            </div>
            {addMode === 'manual' ? (
              <div className="space-y-2">
              {(manualName.trim() || manualDesc.trim()) && (
                <PolishButton
                  idSuffix="invoice-manual"
                  getText={() => ({ name: manualName, description: manualDesc })}
                  onApply={(r) => {
                    if (r.name !== null) setManualName(r.name);
                    if (r.description !== null) setManualDesc(r.description);
                  }}
                />
              )}
              <input
                type="text" placeholder={t('invoiceEditor.fields.name')} aria-label={t('invoiceEditor.fields.lineName')} value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                data-testid="invoice-manual-name"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_100px_auto_auto]">
                <input
                  type="text" placeholder={t('invoiceEditor.fields.descriptionOptional')} aria-label={t('invoiceEditor.fields.lineDescription')} value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  data-testid="invoice-manual-desc"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder={t('invoiceEditor.table.qty')} aria-label={t('invoiceEditor.fields.quantity')} value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                  data-testid="invoice-manual-qty"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <input
                  type="number" min="0" step="0.01" placeholder={t('invoiceEditor.table.price')} aria-label={t('invoiceEditor.fields.unitPrice')} value={manualPrice}
                  onChange={(e) => setManualPrice(e.target.value)}
                  data-testid="invoice-manual-price"
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={manualTaxable} onChange={(e) => setManualTaxable(e.target.checked)} data-testid="invoice-manual-taxable" />
                  {t('invoiceEditor.fields.taxable')}
                </label>
                <button
                  type="button" onClick={() => void addLine()} disabled={isPending('addLine') || (!manualName.trim() && !manualDesc.trim())}
                  data-testid="invoice-add-line-submit"
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('invoiceEditor.addLine.add')}
                </button>
              </div>
              </div>
            ) : picked ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="invoice-catalog-picked">
                <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm">
                  <span className="font-medium">{picked.name}</span>
                  {picked.isBundle && (
                    <span className="rounded border border-border bg-background px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.addLine.bundle')}</span>
                  )}
                  <button type="button" onClick={() => setPicked(null)} aria-label={t('invoiceEditor.addLine.clearSelection')} className="ml-1 text-muted-foreground hover:text-foreground">×</button>
                </span>
                <input
                  type="number" min="0" step="0.01" value={pickQty}
                  onChange={(e) => setPickQty(e.target.value)} aria-label={t('invoiceEditor.fields.quantity')}
                  data-testid="invoice-pick-qty"
                  className="h-9 w-20 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button" onClick={() => void addLine()} disabled={isPending('addLine')}
                  data-testid="invoice-catalog-add"
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('invoiceEditor.addLine.add')}
                </button>
              </div>
            ) : catalog.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="invoice-catalog-empty">
                {t('invoiceEditor.addLine.noCatalogItems')}{' '}
                <a href="/settings/catalog" className="underline hover:text-foreground">{t('invoiceEditor.addLine.addInCatalog')}</a>.
              </p>
            ) : (
              <CatalogItemPicker
                items={catalog}
                onSelect={(it) => { setPicked(it); setPickQty('1'); }}
                testId="invoice-catalog-picker"
                placeholder={t('invoiceEditor.addLine.searchCatalog')}
              />
            )}
          </div>
          )}
        </div>

        {/* Summary + bill-to + notes + actions. Sticky on xl so the totals you're
            building against stay visible while scrolling the lines; below xl this
            column stacks under the table. */}
        <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-summary">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.summary.title')}</h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('invoiceEditor.summary.subtotal')}</dt><dd data-testid="invoice-subtotal">{formatMoney(invoice.subtotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{t('invoiceEditor.summary.tax')}{!noTaxRate ? ` (${formatPercent(Number(invoice.taxRate), { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : ''}</dt><dd data-testid="invoice-tax">{formatMoney(invoice.taxTotal, currency)}</dd></div>
              <div className="flex justify-between border-t pt-1 font-semibold"><dt>{t('invoiceEditor.summary.total')}</dt><dd data-testid="invoice-total">{formatMoney(invoice.total, currency)}</dd></div>
            </dl>
            {hasTaxableLine && noTaxRate && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="invoice-tax-rate-hint">
                {t('invoiceEditor.summary.noTaxRate')}{' '}
                <a href="/settings/billing" className="underline hover:text-foreground">{t('invoiceEditor.summary.setTaxRate')}</a>.
              </p>
            )}
            {/* Internal margin summary — at-a-glance profitability while building
                the invoice. Gated on the SAME persisted "show cost & margin"
                preference as every quote surface, so "no margin on screen" holds
                across the whole billing area. Never customer-facing. */}
            {canSeeMargin && effectiveShowMargin && <MarginPanel profit={profit} currency={currency} idPrefix="invoice" />}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="invoice-bill-to">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.billTo.title')}</h3>
            {invoice.billToName ? (
              <p className="text-sm">{invoice.billToName}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('invoiceEditor.billTo.noContact')}{' '}
                <a href="/settings/organizations" className="underline hover:text-foreground">{t('invoiceEditor.billTo.addInSettings')}</a>.
              </p>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.notes.title')}</h3>
              <UnsavedBadge show={notesDirty} />
            </div>
            <textarea
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }}
              // Gate ENTRY, not save (disabled, like the qty/price inputs) — a
              // readOnly field is still focusable, so if canWrite flipped false
              // mid-edit the onBlur guard would silently drop the typed note.
              onBlur={() => { if (canWrite) void saveNotes(); }}
              // Also disable while the field's own save is in flight (matches the
              // quote editor's terms field) — a visual busy-cue; the inFlight guard
              // in runScoped already prevents a double-PATCH.
              disabled={!canWrite || isPending('notes')}
              data-testid="invoice-notes"
              rows={3}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(notesDirty, notesSaved)}`}
              placeholder={t('invoiceEditor.notes.placeholder')}
            />
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.terms.title')}</h3>
              <UnsavedBadge show={termsDirty} />
            </div>
            <textarea
              value={terms}
              onChange={(e) => { setTerms(e.target.value); setTermsDirty(true); }}
              onBlur={() => { if (canWrite) void saveTerms(); }}
              disabled={!canWrite || isPending('terms')}
              data-testid="invoice-terms"
              rows={3}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(termsDirty, termsSaved)}`}
              placeholder={t('invoiceEditor.terms.placeholder')}
            />
          </div>

          {/* Issue / Issue & Send / Download PDF / Delete draft live in the
              workspace header (InvoiceActions) so they're reachable from any tab
              — mirrors the quote editor, which carries no Send button of its own. */}
        </div>
      </div>

      {/* Below xl the summary rail stacks under the lines table, which would
          break the edit→see-total loop mid-task — so a slim summary stays pinned
          to the viewport bottom (sticky bottom releases once you scroll down to
          the real rail). aria-hidden: purely a visual affordance; the rail's
          figures are the canonical ones (mirrors the quote editor's sticky bar). */}
      <div
        aria-hidden="true"
        data-testid="invoice-totals-sticky"
        className="sticky bottom-2 z-10 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border bg-card px-4 py-2 text-sm shadow-md xl:hidden"
      >
        <span className="flex items-baseline gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('invoiceEditor.summary.total')}</span>
          <span className="text-base font-semibold tabular-nums" data-testid="invoice-totals-sticky-total">{formatMoney(invoice.total, currency)}</span>
        </span>
        {Number(invoice.taxTotal) > 0 && (
          <span className="flex items-baseline gap-1 text-muted-foreground">
            <span className="text-xs">{t('invoiceEditor.summary.tax')}</span>
            <span className="font-medium tabular-nums">{formatMoney(invoice.taxTotal, currency)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function LineRow({
  line, children, currency, isPending, onPatch, onRemove,
}: {
  line: InvoiceLine;
  children: InvoiceLine[];
  currency: string;
  isPending: (key: string) => boolean;
  onPatch: (lineId: string, patch: Record<string, unknown>, scopeKey: string) => Promise<boolean>;
  onRemove: (lineId: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const canWrite = can('invoices', 'write');
  // Per-field pending: only the in-flight control disables, so a slow qty save
  // never freezes price/name/desc or a sibling line (scoped-pending backport).
  const nameKey = `name-${line.id}`;
  const descKey = `desc-${line.id}`;
  const qtyKey = `qty-${line.id}`;
  const priceKey = `price-${line.id}`;
  const taxableKey = `taxable-${line.id}`;
  const visibleKey = `visible-${line.id}`;
  const removeKey = `remove-${line.id}`;
  const [name, setName] = useState(line.name ?? '');
  const [desc, setDesc] = useState(line.description ?? '');
  const [qty, setQty] = useState(line.quantity);
  const [price, setPrice] = useState(line.unitPrice);
  // Guard an in-progress edit from being clobbered by a server resync mid-type:
  // the flag is set on keystroke and cleared when a commit is initiated (on
  // blur), so a background refresh landing mid-edit keeps the user's keystrokes
  // while a settled field re-adopts the server's canonical value (mirrors the
  // quote editor's EditableLineRow pattern).
  const nameEdited = useRef(false);
  const descEdited = useRef(false);
  const qtyEdited = useRef(false);
  const priceEdited = useRef(false);
  // Auto-grow the (full-width) description textarea to fit its content, while
  // still letting the user drag the resize handle for a bigger/smaller box.
  const descRef = useRef<HTMLTextAreaElement>(null);
  const autoGrowDesc = () => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => { if (!nameEdited.current) setName(line.name ?? ''); }, [line.name]);
  useEffect(() => { if (!descEdited.current) setDesc(line.description ?? ''); }, [line.description]);
  useEffect(() => { autoGrowDesc(); }, [desc]);
  useEffect(() => { if (!qtyEdited.current) setQty(line.quantity); }, [line.quantity]);
  useEffect(() => { if (!priceEdited.current) setPrice(line.unitPrice); }, [line.unitPrice]);

  // Quiet row-level "Saved" flash in place of a per-field success toast:
  // committing any one field briefly pulses the green ring across the row.
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }, []);
  const edit = useCallback(async (patch: Record<string, unknown>, key: string): Promise<boolean> => {
    const ok = await onPatch(line.id, patch, key);
    if (ok) flashSaved();
    return ok;
  }, [onPatch, line.id, flashSaved]);

  // Per-field dirty cue (numeric compare for qty/price so re-typing "3.00" over
  // "3" reads as clean, not dirty).
  const nameDirty = name.trim() !== (line.name ?? '');
  const descDirty = desc.trim() !== (line.description ?? '');
  const qtyDirty = Number(qty) !== Number(line.quantity);
  const priceDirty = Number(price) !== Number(line.unitPrice);

  const commitName = () => {
    if (!canWrite) return;
    const next = name.trim();
    nameEdited.current = false; // committing — let the server value re-adopt next
    if (next === (line.name ?? '')) { setName(line.name ?? ''); return; }
    // A line can't have both name and description blank (mirrors the manual-add rule).
    if (!next && !(line.description ?? '').trim()) {
      handleActionError(new Error('empty line'), t('invoiceEditor.errors.nameOrDescription'));
      setName(line.name ?? '');
      return;
    }
    void edit({ name: next || null }, nameKey);
  };
  const commitDesc = () => {
    if (!canWrite) return;
    const next = desc.trim();
    descEdited.current = false;
    if (next === (line.description ?? '')) { setDesc(line.description ?? ''); return; }
    if (!next && !(line.name ?? '').trim()) {
      handleActionError(new Error('empty line'), t('invoiceEditor.errors.nameOrDescription'));
      setDesc(line.description ?? '');
      return;
    }
    void edit({ description: next || null }, descKey);
  };
  const commitQty = () => {
    if (!canWrite) return;
    const n = Number(qty);
    qtyEdited.current = false;
    if (n === Number(line.quantity)) { setQty(line.quantity); return; } // unchanged — silent (numeric compare)
    // A rejected entry no longer snaps back silently: tell the user why before reverting.
    if (!Number.isFinite(n) || n <= 0) {
      handleActionError(new Error('invalid quantity'), t('invoiceEditor.errors.quantityGreaterThanZero'));
      setQty(line.quantity);
      return;
    }
    void edit({ quantity: n }, qtyKey);
  };
  const commitPrice = () => {
    if (!canWrite) return;
    const n = Number(price);
    priceEdited.current = false;
    if (n === Number(line.unitPrice)) { setPrice(line.unitPrice); return; } // unchanged — silent (numeric compare)
    if (!Number.isFinite(n) || n < 0) {
      handleActionError(new Error('invalid price'), t('invoiceEditor.errors.nonNegativeUnitPrice'));
      setPrice(line.unitPrice);
      return;
    }
    void edit({ unitPrice: n }, priceKey);
  };

  return (
    <>
      <tr className="border-t" data-testid={`invoice-line-${line.id}`}>
        <td className="px-3 py-2">
          <input
            type="text" value={name} disabled={!canWrite || isPending(nameKey)}
            aria-label={t('invoiceEditor.fields.lineName')} placeholder={t('invoiceEditor.fields.name')}
            aria-describedby={nameDirty ? unsavedHintId('invoice-line', line.id, 'name') : undefined}
            onChange={(e) => { setName(e.target.value); nameEdited.current = true; }}
            onBlur={commitName}
            data-testid={`invoice-line-name-${line.id}`}
            className={`h-8 w-full rounded-md border bg-background px-2 text-sm font-medium transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(nameDirty, saved)}`}
          />
          <UnsavedFieldHint id={unsavedHintId('invoice-line', line.id, 'name')} show={nameDirty} />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={qty} disabled={!canWrite || isPending(qtyKey)}
            aria-label={t('invoiceEditor.fields.quantity')}
            aria-describedby={qtyDirty ? unsavedHintId('invoice-line', line.id, 'qty') : undefined}
            onChange={(e) => { setQty(e.target.value); qtyEdited.current = true; }}
            onBlur={commitQty}
            data-testid={`invoice-line-qty-${line.id}`}
            className={`h-8 w-20 rounded-md border bg-background px-2 text-right text-sm transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(qtyDirty, saved)}`}
          />
          <UnsavedFieldHint id={unsavedHintId('invoice-line', line.id, 'qty')} show={qtyDirty} />
        </td>
        <td className="px-3 py-2 text-right">
          <input
            type="number" min="0" step="0.01" value={price} disabled={!canWrite || isPending(priceKey)}
            aria-label={t('invoiceEditor.fields.unitPrice')}
            aria-describedby={priceDirty ? unsavedHintId('invoice-line', line.id, 'price') : undefined}
            onChange={(e) => { setPrice(e.target.value); priceEdited.current = true; }}
            onBlur={commitPrice}
            data-testid={`invoice-line-price-${line.id}`}
            className={`h-8 w-24 rounded-md border bg-background px-2 text-right text-sm transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(priceDirty, saved)}`}
          />
          <UnsavedFieldHint id={unsavedHintId('invoice-line', line.id, 'price')} show={priceDirty} />
        </td>
        <td className="px-3 py-2 text-center">
          <input
            type="checkbox" checked={line.taxable} disabled={!canWrite || isPending(taxableKey)}
            // Explicit name: header-cell inference doesn't survive the
            // two-<tr>-per-line table structure for screen readers.
            aria-label={t('invoiceEditor.fields.taxable')}
            onChange={(e) => void edit({ taxable: e.target.checked }, taxableKey)}
            data-testid={`invoice-line-taxable-${line.id}`}
          />
        </td>
        <td className="px-3 py-2 text-center">
          <input
            type="checkbox" checked={line.customerVisible} disabled={!canWrite || isPending(visibleKey)}
            // The abbreviated "Cust" column header only explains itself via a
            // title tooltip — give AT users the full meaning directly.
            aria-label={t('invoiceEditor.table.customerVisibleTitle')}
            onChange={(e) => void edit({ customerVisible: e.target.checked }, visibleKey)}
            data-testid={`invoice-line-visible-${line.id}`}
          />
        </td>
        <td className="px-3 py-2 text-right">
          {formatMoney(line.lineTotal, currency)}
          <SrSaved show={saved} label={t('invoiceEditor.saved')} testId={`invoice-line-saved-${line.id}`} />
        </td>
        <td className="px-3 py-2 text-right">
          {canWrite && (
            <button
              type="button" onClick={() => onRemove(line.id)} disabled={isPending(removeKey)}
              data-testid={`invoice-line-remove-${line.id}`}
              className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {t('invoiceEditor.remove')}
            </button>
          )}
        </td>
      </tr>
      {/* Full-width description row, so writers get a roomy, expandable box
          instead of a cramped cell — matches the quote editor. */}
      <tr className="border-0" data-testid={`invoice-line-desc-row-${line.id}`}>
        <td colSpan={7} className="px-3 pb-2 pt-0">
          <textarea
            ref={descRef}
            value={desc}
            disabled={!canWrite || isPending(descKey)}
            aria-label={t('invoiceEditor.fields.lineDescription')}
            placeholder={t('invoiceEditor.fields.descriptionOptional')}
            aria-describedby={descDirty ? unsavedHintId('invoice-line', line.id, 'desc') : undefined}
            onChange={(e) => { setDesc(e.target.value); descEdited.current = true; autoGrowDesc(); }}
            onBlur={commitDesc}
            rows={2}
            data-testid={`invoice-line-desc-${line.id}`}
            className={`min-h-8 w-full resize-y overflow-hidden rounded-md border bg-background px-2 py-1 text-sm text-muted-foreground transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(descDirty, saved)}`}
          />
          <UnsavedFieldHint id={unsavedHintId('invoice-line', line.id, 'desc')} show={descDirty} />
        </td>
      </tr>
      {children.map((ch) => (
        <tr key={ch.id} className="border-t bg-muted/20 text-xs text-muted-foreground" data-testid={`invoice-line-child-${ch.id}`}>
          <td className="px-3 py-1.5 pl-8"><span aria-hidden="true">↳ </span>{lineTitle(ch)}{!ch.customerVisible ? t('invoiceEditor.hiddenSuffix') : ''}</td>
          <td className="px-3 py-1.5 text-right">{ch.quantity}</td>
          <td className="px-3 py-1.5 text-right">{formatMoney(ch.unitPrice, currency)}</td>
          <td colSpan={4} />
        </tr>
      ))}
    </>
  );
}
