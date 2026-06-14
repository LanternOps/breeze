import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { invalidateTicketConfig } from '../../lib/ticketConfigApi';
import { statusConfig, type TicketStatus } from '../tickets/ticketConfig';

export interface StatusRow {
  id: string;
  partnerId: string;
  name: string;
  coreStatus: TicketStatus;
  color: string | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
}

interface EditDraft {
  name: string;
  coreStatus: TicketStatus;
  color: string;
}

// Canonical core-status order: new → closed (derived from statusConfig key order).
const CORE_STATUS_ORDER = Object.keys(statusConfig) as TicketStatus[];

// Flat list sorted by sortOrder asc (name tiebreak mirrors server ordering).
const byRank = (a: StatusRow, b: StatusRow) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

// Compute the new id order after a one-step move in the FLAT list (all statuses
// regardless of coreStatus, sorted by current sortOrder). Returns null when the
// move would fall off either edge. Exported for testing.
export function moveFlatList(statuses: StatusRow[], id: string, dir: -1 | 1): string[] | null {
  const sorted = [...statuses].sort(byRank);
  const idx = sorted.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const swap = idx + dir;
  if (swap < 0 || swap >= sorted.length) return null;
  const order = sorted.map((s) => s.id);
  [order[idx], order[swap]] = [order[swap], order[idx]];
  return order;
}

const FRIENDLY_CODES: Record<string, string> = {
  STATUS_NAME_TAKEN: 'A status with that name already exists.',
  SYSTEM_STATUS_IMMUTABLE: "Built-in statuses can't change their core state.",
  SYSTEM_STATUS_REQUIRED: "Built-in statuses can't be deactivated.",
  STATUS_INACTIVE: 'That status is deactivated.',
};

const friendlyCode = (code: string): string | undefined => FRIENDLY_CODES[code];

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const DEFAULT_COLOR = '#1c8a9e';

export default function TicketStatusesTab() {
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Add form state
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addCore, setAddCore] = useState<TicketStatus>('new');
  const [addColor, setAddColor] = useState(DEFAULT_COLOR);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft>({ name: '', coreStatus: 'new', color: DEFAULT_COLOR });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth('/ticket-config');
      if (res.ok) {
        const body = (await res.json()) as { data: { statuses: StatusRow[] } };
        setStatuses(body.data?.statuses ?? []);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    if (!addName.trim()) return;
    const body: Record<string, unknown> = {
      name: addName.trim(),
      coreStatus: addCore,
      color: addColor,
    };
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/ticket-config/statuses', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: 'Status creation failed. Retry.',
        successMessage: `Status "${addName.trim()}" created`,
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      setAddName('');
      setAddCore('new');
      setAddColor(DEFAULT_COLOR);
      setAddOpen(false);
      invalidateTicketConfig();
      void load();
    } catch (err) {
      handleActionError(err, 'Status creation failed. Retry.');
    }
  }, [addName, addCore, addColor, load]);

  const startEdit = useCallback((s: StatusRow) => {
    setEditingId(s.id);
    setDraft({ name: s.name, coreStatus: s.coreStatus, color: s.color ?? DEFAULT_COLOR });
  }, []);

  const saveEdit = useCallback(async (id: string, isSystem: boolean) => {
    if (!draft.name.trim()) return;
    const payload: Record<string, unknown> = { name: draft.name.trim(), color: draft.color };
    if (!isSystem) payload.coreStatus = draft.coreStatus;
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/ticket-config/statuses/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
        errorFallback: 'Update failed. Retry.',
        successMessage: 'Status updated',
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      setEditingId(null);
      invalidateTicketConfig();
      void load();
    } catch (err) {
      handleActionError(err, 'Update failed. Retry.');
    }
  }, [draft, load]);

  const toggleActive = useCallback(async (s: StatusRow) => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/ticket-config/statuses/${s.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive: !s.isActive }),
          }),
        errorFallback: 'Update failed. Retry.',
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      invalidateTicketConfig();
      void load();
    } catch (err) {
      handleActionError(err, 'Update failed. Retry.');
    }
  }, [load]);

  const move = useCallback(async (s: StatusRow, dir: -1 | 1) => {
    const order = moveFlatList(statuses, s.id, dir);
    if (!order) return;
    // Optimistic: apply the new ranks locally, restore on failure.
    const rank = new Map(order.map((id, i) => [id, i]));
    setStatuses((prev) => prev.map((row) => (rank.has(row.id) ? { ...row, sortOrder: rank.get(row.id)! } : row)));
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/ticket-config/statuses/reorder', {
            method: 'POST',
            body: JSON.stringify({ ids: order }),
          }),
        errorFallback: 'Reorder failed. Retry.',
        onUnauthorized: UNAUTHORIZED,
      });
      invalidateTicketConfig();
    } catch (err) {
      void load();
      handleActionError(err, 'Reorder failed. Retry.');
    }
  }, [statuses, load]);

  // Group statuses by coreStatus in canonical order; within each group sort by rank.
  const groups = useMemo(() => {
    return CORE_STATUS_ORDER.map((coreStatus) => ({
      coreStatus,
      statuses: statuses.filter((s) => s.coreStatus === coreStatus).sort(byRank),
    }));
  }, [statuses]);

  const flatSorted = useMemo(() => [...statuses].sort(byRank), [statuses]);

  return (
    <div className="max-w-3xl" data-testid="ticket-statuses-tab">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Ticket Statuses</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the statuses available in your ticketing queue. Built-in statuses are required and cannot be removed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white"
          data-testid="status-add-toggle"
        >
          {addOpen ? 'Cancel' : 'Add status'}
        </button>
      </div>

      {addOpen && (
        <div className="mt-4 rounded-md border bg-muted/30 p-4" data-testid="status-add-form">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium" htmlFor="status-form-name-input">Name</label>
              <input
                id="status-form-name-input"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                placeholder="Status name"
                data-testid="status-form-name"
              />
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="status-form-core-select">Core state</label>
              <select
                id="status-form-core-select"
                value={addCore}
                onChange={(e) => setAddCore(e.target.value as TicketStatus)}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                data-testid="status-form-core"
              >
                {CORE_STATUS_ORDER.map((cs) => (
                  <option key={cs} value={cs}>{statusConfig[cs].label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="status-form-color-input">Color</label>
              <input
                id="status-form-color-input"
                type="color"
                value={addColor}
                onChange={(e) => setAddColor(e.target.value)}
                className="h-9 w-full rounded-md border"
                data-testid="status-form-color"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void create()}
              disabled={!addName.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              data-testid="status-form-submit"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-6">
        {loading ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="ticket-statuses-loading">
            Loading.
          </p>
        ) : error ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="ticket-statuses-error">
            Statuses failed to load.{' '}
            <button
              type="button"
              onClick={() => void load()}
              className="underline hover:text-foreground"
              data-testid="ticket-statuses-retry"
            >
              Retry
            </button>
          </p>
        ) : statuses.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="ticket-statuses-empty">
            No statuses found.
          </p>
        ) : (
          groups.map(({ coreStatus, statuses: groupStatuses }) => {
            if (groupStatuses.length === 0) return null;
            return (
              <div key={coreStatus} data-testid={`status-group-${coreStatus}`}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {statusConfig[coreStatus].label}
                </h3>
                <table className="min-w-full divide-y">
                  <tbody className="divide-y">
                    {groupStatuses.map((s) => (
                      <Fragment key={s.id}>
                        <tr data-testid={`status-row-${s.id}`}>
                          <td className="px-4 py-2 text-sm">
                            <span
                              className="mr-1.5 inline-block h-3 w-3 rounded-full align-middle"
                              style={{ backgroundColor: s.color ?? undefined }}
                              aria-hidden="true"
                            />
                            {s.name}
                            {s.isSystem && (
                              <span
                                className="ml-2 rounded border px-1 py-0.5 text-xs text-muted-foreground"
                                data-testid={`status-system-badge-${s.id}`}
                              >
                                Built-in
                              </span>
                            )}
                            {!s.isActive && (
                              <span className="ml-2 rounded border px-1 py-0.5 text-xs text-muted-foreground">
                                Inactive
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right space-x-2">
                            <button
                              type="button"
                              onClick={() => void move(s, -1)}
                              disabled={moveFlatList(flatSorted, s.id, -1) === null}
                              className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-30"
                              aria-label={`Move ${s.name} up`}
                              data-testid={`status-up-${s.id}`}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              onClick={() => void move(s, 1)}
                              disabled={moveFlatList(flatSorted, s.id, 1) === null}
                              className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-30"
                              aria-label={`Move ${s.name} down`}
                              data-testid={`status-down-${s.id}`}
                            >
                              ▼
                            </button>
                            <button
                              type="button"
                              onClick={() => startEdit(s)}
                              className="text-sm text-muted-foreground hover:text-foreground"
                              data-testid={`status-edit-${s.id}`}
                            >
                              Edit
                            </button>
                            {!s.isSystem && (
                              <button
                                type="button"
                                onClick={() => void toggleActive(s)}
                                className="text-sm text-muted-foreground hover:text-foreground"
                                data-testid={`status-toggle-${s.id}`}
                              >
                                {s.isActive ? 'Deactivate' : 'Activate'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {editingId === s.id && (
                          <tr key={`edit-${s.id}`}>
                            <td colSpan={2} className="bg-muted/30 px-4 py-3">
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="text-xs font-medium" htmlFor={`edit-name-${s.id}`}>Name</label>
                                  <input
                                    id={`edit-name-${s.id}`}
                                    value={draft.name}
                                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                                    className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                                    data-testid={`status-edit-name-${s.id}`}
                                  />
                                </div>
                                <div>
                                  <label className="text-xs font-medium" htmlFor={`edit-core-${s.id}`}>Core state</label>
                                  <select
                                    id={`edit-core-${s.id}`}
                                    value={draft.coreStatus}
                                    onChange={(e) => setDraft((d) => ({ ...d, coreStatus: e.target.value as TicketStatus }))}
                                    disabled={s.isSystem}
                                    className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50"
                                    data-testid={`status-edit-core-${s.id}`}
                                  >
                                    {CORE_STATUS_ORDER.map((cs) => (
                                      <option key={cs} value={cs}>{statusConfig[cs].label}</option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className="text-xs font-medium" htmlFor={`edit-color-${s.id}`}>Color</label>
                                  <input
                                    id={`edit-color-${s.id}`}
                                    type="color"
                                    value={draft.color}
                                    onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                                    className="h-9 w-full rounded-md border"
                                    data-testid={`status-edit-color-${s.id}`}
                                  />
                                </div>
                              </div>
                              <div className="mt-3 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => void saveEdit(s.id, s.isSystem)}
                                  disabled={!draft.name.trim()}
                                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                                  data-testid={`status-save-${s.id}`}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingId(null)}
                                  className="rounded-md border px-3 py-1.5 text-sm font-medium"
                                  data-testid={`status-cancel-${s.id}`}
                                >
                                  Cancel
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
