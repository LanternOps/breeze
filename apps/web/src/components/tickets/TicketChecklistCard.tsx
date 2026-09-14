import { useCallback, useEffect, useRef, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';
import {
  addChecklistItem,
  deleteChecklistItem,
  listChecklist,
  patchChecklistItem,
  reorderChecklist,
  type ChecklistItem,
} from '../../lib/api/ticketChecklist';

interface Props {
  ticketId: string;
  /** `compact` (e.g. the right rail) is tick-and-read-only: no add, reorder or
   *  delete — only the `full` main-column card manages the checklist. */
  mode?: 'full' | 'compact';
  /** Fired after the initial load and after every successful mutation, so a
   *  host (TicketWorkbench's resolve/close confirm gate) can react to the
   *  counts without re-fetching itself.
   *
   *  `known` is false when the checklist could not be loaded. It exists because
   *  a failed load leaves `done`/`total` at 0/0, which is byte-identical to a
   *  ticket that genuinely has no checklist — and a host gating a safety prompt
   *  on those counts would then silently skip it at exactly the moment it is
   *  least safe to. Hosts must fail CLOSED on `known: false`. */
  onCountsChange?: (counts: { done: number; total: number; known: boolean }) => void;
}

const FRIENDLY: Record<string, string> = {
  CHECKLIST_TICK_REQUIRES_USER: 'errors.tickRequiresUser',
};

export default function TicketChecklistCard({ ticketId, mode = 'full', onCountsChange }: Props) {
  const { t } = useTranslation('checklists');
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDetail, setNewDetail] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editDetail, setEditDetail] = useState('');

  const friendly = useCallback(
    (code: string) => (FRIENDLY[code] ? t(/* i18n-dynamic */ FRIENDLY[code]) : undefined),
    [t],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const summary = await listChecklist(fetchWithAuth, ticketId);
      setItems(summary.items);
      setLoadFailed(false);
    } catch {
      // A failed load is NOT silently equivalent to an empty checklist here,
      // unlike TicketPartsCard's best-effort refresh. `items` stays [] on
      // failure, so the counts reported below would read 0/0 — indistinguishable
      // from a ticket with no checklist — and TicketWorkbench's resolve/close
      // prompt gates on exactly those counts. Recording the failure is what lets
      // the card show an error instead of unmounting, and lets the host fail
      // CLOSED rather than skipping the prompt on a network blip.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reset add/edit form state when switching tickets, same as TicketPartsCard.
  useEffect(() => {
    setNewLabel('');
    setNewDetail('');
    setEditingId(null);
    setEditLabel('');
    setEditDetail('');
  }, [ticketId]);

  const done = items.filter((i) => i.done).length;
  const total = items.length;

  // Held in a ref so a caller passing an inline lambda cannot make this effect
  // re-fire on every render (the parent's own setState would then loop). The
  // effect depends on the COUNTS, never on the callback's identity.
  const onCountsChangeRef = useRef(onCountsChange);
  onCountsChangeRef.current = onCountsChange;

  useEffect(() => {
    if (!loading) onCountsChangeRef.current?.({ done, total, known: !loadFailed });
  }, [loading, done, total, loadFailed]);

  const submitAdd = async () => {
    const label = newLabel.trim();
    if (!label || busy) return;
    setBusy(true);
    try {
      const detail = newDetail.trim();
      const created = await runClientAction(
        () => addChecklistItem(fetchWithAuth, ticketId, { label, ...(detail ? { detail } : {}) }),
        { errorFallback: t('errors.saveFailed') },
      );
      setItems((prev) => [...prev, created]);
      setNewLabel('');
      setNewDetail('');
    } catch (err) {
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (item: ChecklistItem) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await runClientAction(
        () => patchChecklistItem(fetchWithAuth, item.id, { done: !item.done }),
        { errorFallback: t('errors.saveFailed'), friendly },
      );
      setItems((prev) => prev.map((i) => (i.id === next.id ? next : i)));
    } catch (err) {
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (item: ChecklistItem) => {
    setEditingId(item.id);
    setEditLabel(item.label);
    setEditDetail(item.detail ?? '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditLabel('');
    setEditDetail('');
  };

  const saveEdit = async () => {
    if (!editingId || busy) return;
    const label = editLabel.trim();
    if (!label) return;
    setBusy(true);
    try {
      const detail = editDetail.trim();
      const next = await runClientAction(
        () => patchChecklistItem(fetchWithAuth, editingId, { label, detail: detail ? detail : null }),
        { errorFallback: t('errors.saveFailed'), friendly },
      );
      setItems((prev) => prev.map((i) => (i.id === next.id ? next : i)));
      cancelEdit();
    } catch (err) {
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await runClientAction(() => deleteChecklistItem(fetchWithAuth, id), {
        errorFallback: t('errors.saveFailed'),
      });
      setItems((prev) => prev.filter((i) => i.id !== id));
      if (editingId === id) cancelEdit();
    } catch (err) {
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (busy || target < 0 || target >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    const previous = items;
    setItems(reordered); // optimistic — the whole-list POST below confirms it
    setBusy(true);
    try {
      const summary = await runClientAction(
        () => reorderChecklist(fetchWithAuth, ticketId, reordered.map((i) => i.id)),
        { errorFallback: t('errors.reorderFailed') },
      );
      setItems(summary.items);
    } catch (err) {
      setItems(previous);
      handleActionError(err, t('errors.reorderFailed'));
    } finally {
      setBusy(false);
    }
  };

  // A ticket with no checklist gains no clutter — but a ticket whose checklist
  // FAILED to load is not that ticket, and must not disappear silently.
  if (!loading && !loadFailed && total === 0 && mode === 'full') return null;

  const compact = mode === 'compact';

  if (loadFailed) {
    return (
      <div className="mt-3 border-t pt-3" data-testid="ticket-checklist-card">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('card.title')}</p>
        </div>
        <p className="mt-1 text-xs text-destructive" data-testid="ticket-checklist-error">
          {t('errors.loadFailed')}
        </p>
        <button
          type="button"
          className="mt-1 text-xs underline"
          data-testid="ticket-checklist-retry"
          onClick={() => { void refresh(); }}
        >
          {t('actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-checklist-card">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('card.title')}</p>
        <span className="text-xs text-muted-foreground" data-testid="ticket-checklist-progress">
          {t('card.progress', { done, total })}
        </span>
      </div>

      {!compact && (
        <p className="mt-0.5 text-[11px] italic text-muted-foreground">{t('card.internalOnly')}</p>
      )}

      {total === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="ticket-checklist-empty">{t('card.empty')}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item, index) => {
            const editing = editingId === item.id;
            return (
              <li key={item.id} className="text-xs" data-testid={`ticket-checklist-item-${item.id}`}>
                {editing ? (
                  <div className="space-y-1 rounded-md border bg-muted/30 p-1.5">
                    {item.done && (
                      <p className="text-[11px] text-warning" data-testid="ticket-checklist-edit-warning">
                        {t('editDoneWarning')}
                      </p>
                    )}
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      aria-label={t('card.addPlaceholder')}
                      className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                      data-testid={`ticket-checklist-edit-label-${item.id}`}
                    />
                    <input
                      type="text"
                      value={editDetail}
                      onChange={(e) => setEditDetail(e.target.value)}
                      placeholder={t('card.detailPlaceholder')}
                      aria-label={t('card.detailPlaceholder')}
                      className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                      data-testid={`ticket-checklist-edit-detail-${item.id}`}
                    />
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded px-1.5 py-0.5 text-xs hover:bg-muted"
                        data-testid={`ticket-checklist-edit-cancel-${item.id}`}
                      >
                        {t('actions.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveEdit()}
                        disabled={!editLabel.trim() || busy}
                        className="rounded bg-primary px-1.5 py-0.5 text-xs font-medium text-white disabled:opacity-50"
                        data-testid={`ticket-checklist-edit-save-${item.id}`}
                      >
                        {t('actions.save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-1.5">
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => void toggle(item)}
                      disabled={busy}
                      className="mt-0.5 shrink-0"
                      aria-label={item.label}
                      data-testid={`ticket-checklist-toggle-${item.id}`}
                    />
                    <div className="min-w-0 flex-1">
                      <span className={item.done ? 'text-muted-foreground line-through' : undefined}>
                        {item.label}
                      </span>
                      {item.detail && (
                        <p className="text-muted-foreground">{item.detail}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {!compact && (
                        <>
                          <button
                            type="button"
                            onClick={() => void move(index, -1)}
                            disabled={busy || index === 0}
                            aria-label={t('actions.moveUp')}
                            className="rounded px-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
                            data-testid={`ticket-checklist-up-${item.id}`}
                          >
                            &#9650;
                          </button>
                          <button
                            type="button"
                            onClick={() => void move(index, 1)}
                            disabled={busy || index === items.length - 1}
                            aria-label={t('actions.moveDown')}
                            className="rounded px-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
                            data-testid={`ticket-checklist-down-${item.id}`}
                          >
                            &#9660;
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className="rounded px-1 py-0.5 text-xs hover:bg-muted"
                        data-testid={`ticket-checklist-edit-${item.id}`}
                      >
                        {t('actions.edit')}
                      </button>
                      {!compact && (
                        <button
                          type="button"
                          onClick={() => void remove(item.id)}
                          disabled={busy}
                          className="rounded px-1 py-0.5 text-xs text-destructive hover:bg-muted"
                          data-testid={`ticket-checklist-delete-${item.id}`}
                        >
                          {t('actions.delete')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!compact && (
        <div className="mt-2 flex gap-1.5" data-testid="ticket-checklist-add-form">
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAdd(); }}
            placeholder={t('card.addPlaceholder')}
            aria-label={t('card.addPlaceholder')}
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-checklist-add-input"
          />
          <button
            type="button"
            onClick={() => void submitAdd()}
            disabled={!newLabel.trim() || busy}
            className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            data-testid="ticket-checklist-add"
          >
            {t('card.add')}
          </button>
        </div>
      )}
    </div>
  );
}
