import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { formatMinutes } from '../../lib/timeFormat';
import { onTimerChanged } from '../../lib/timerActions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TsEntry {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number;
  description: string | null;
  isBillable: boolean;
  hourlyRate: string | null;
  isApproved: boolean;
  ticketId: string;
  ticketNumber: string;
  ticketSubject: string;
  userName: string;
}

interface TsDay {
  date: string;
  totalMinutes: number;
  billableMinutes: number;
  entries: TsEntry[];
}

interface TsSheet {
  weekStart: string;
  days: TsDay[];
  totals: { totalMinutes: number; billableMinutes: number };
}

interface User {
  id: string;
  name: string;
  email: string;
}

interface EditForm {
  description: string;
  isBillable: boolean;
  hourlyRate: string;
}

// ---------------------------------------------------------------------------
// Hash-state helpers
// ---------------------------------------------------------------------------

function mondayUtc(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (utc.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  utc.setUTCDate(utc.getUTCDate() - dow);
  return utc.toISOString().slice(0, 10);
}

function shiftWeek(weekStart: string, delta: number): string {
  const [y, mo, d] = weekStart.split('-').map(Number);
  const base = new Date(Date.UTC(y, mo - 1, d));
  base.setUTCDate(base.getUTCDate() + delta * 7);
  return base.toISOString().slice(0, 10);
}

function parseHash(): { week: string; tech: string | null } {
  if (typeof window === 'undefined') return { week: mondayUtc(new Date()), tech: null };
  let week: string | null = null;
  let tech: string | null = null;
  for (const part of window.location.hash.replace('#', '').split('&')) {
    if (!part) continue;
    if (part.startsWith('week=')) {
      const v = part.slice('week='.length);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) week = v;
    } else if (part.startsWith('tech=')) {
      tech = part.slice('tech='.length) || null;
    }
  }
  return { week: week ?? mondayUtc(new Date()), tech };
}

function writeHash(week: string, tech: string | null): void {
  const parts: string[] = [`week=${week}`];
  if (tech) parts.push(`tech=${tech}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

// ---------------------------------------------------------------------------
// Friendly error codes
// ---------------------------------------------------------------------------

const FRIENDLY: Record<string, string> = {
  ADMIN_REQUIRED: 'Approving timesheets requires an admin role.',
  APPROVED_IMMUTABLE: 'Approved entries can only be changed by an admin.',
  NOT_OWN_ENTRY: 'You can only edit your own time entries.',
};

const friendly = (code: string): string | undefined => FRIENDLY[code];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TimesheetPage() {
  const initial = parseHash();
  const [week, setWeek] = useState<string>(initial.week);
  const [tech, setTech] = useState<string | null>(initial.tech);
  const [sheet, setSheet] = useState<TsSheet | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [adminDenied, setAdminDenied] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ description: '', isBillable: true, hourlyRate: '' });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Load users once on mount
  useEffect(() => {
    void (async () => {
      const res = await fetchWithAuth('/users');
      if (!res.ok) return;
      const body = await res.json().catch(() => null) as { data?: User[] } | User[] | null;
      const rows = Array.isArray(body) ? body : body?.data ?? [];
      setUsers(rows);
    })();
  }, []);

  // Load timesheet when week or tech changes
  const loadSheet = useCallback(async (loadWeek: string, loadTech: string | null) => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ weekStart: loadWeek });
      if (loadTech) params.set('userId', loadTech);
      const res = await fetchWithAuth(`/time-entries/timesheet?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 403 && loadTech) {
          // No admin access to another tech's sheet — fall back to own
          setAdminDenied(true);
          setTech(null);
          writeHash(loadWeek, null);
          // The effect will re-run with tech=null
          return;
        }
        setLoadError(true);
        return;
      }
      const body = await res.json().catch(() => null) as { data?: TsSheet } | null;
      if (body?.data?.weekStart && body.data.weekStart !== loadWeek) return; // stale response from rapid navigation
      setSheet(body?.data ?? null);
      setSelected(new Set()); // clear selection on new load
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSheet(week, tech);
  }, [week, tech, loadSheet]);

  // Subscribe to timer changes
  useEffect(() => {
    return onTimerChanged(() => void loadSheet(week, tech));
  }, [week, tech, loadSheet]);

  // Navigation helpers
  const goToPrevWeek = useCallback(() => {
    const newWeek = shiftWeek(week, -1);
    setWeek(newWeek);
    writeHash(newWeek, tech);
  }, [week, tech]);

  const goToNextWeek = useCallback(() => {
    const newWeek = shiftWeek(week, 1);
    setWeek(newWeek);
    writeHash(newWeek, tech);
  }, [week, tech]);

  const goToThisWeek = useCallback(() => {
    // mondayUtc(new Date()) buckets by UTC — late-Sunday users west of UTC may land on "next" week; matches the API's UTC day-bucketing.
    const newWeek = mondayUtc(new Date());
    setWeek(newWeek);
    writeHash(newWeek, tech);
  }, [tech]);

  const handleTechChange = useCallback((userId: string) => {
    const newTech = userId || null;
    setTech(newTech);
    setAdminDenied(false);
    writeHash(week, newTech);
  }, [week]);

  // Selection
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Bulk approve/unapprove
  const bulkApprove = useCallback(async (approve: boolean) => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      const result = await runAction<{ updated: number; skipped: number; skippedReasons: Record<string, number>; total: number }>({
        request: () => fetchWithAuth('/time-entries/bulk-approve', {
          method: 'POST',
          body: JSON.stringify({ ids, approve }),
        }),
        errorFallback: 'Bulk approval failed. Retry.',
        parseSuccess: (data) => {
          const d = data as { data: { updated: number; skipped: number; skippedReasons: Record<string, number>; total: number } };
          return d.data;
        },
        friendly,
      });
      if (result.skipped > 0) {
        const reasons = Object.entries(result.skippedReasons ?? {})
          .map(([code, count]) => `${count}× ${code.toLowerCase().replace(/_/g, ' ')}`)
          .join(', ');
        showToast({ type: 'warning', message: `${result.updated} updated, ${result.skipped} skipped (${reasons})` });
      } else {
        showToast({ type: 'success', message: `${result.updated} ${approve ? 'approved' : 'unapproved'}` });
      }
      setSelected(new Set());
      void loadSheet(week, tech);
    } catch (err) {
      handleActionError(err, 'Bulk approval failed. Retry.');
    }
  }, [selected, week, tech, loadSheet]);

  // Inline edit
  const startEdit = useCallback((entry: TsEntry) => {
    setEditingId(entry.id);
    setEditForm({
      description: entry.description ?? '',
      isBillable: entry.isBillable,
      hourlyRate: entry.hourlyRate ?? '',
    });
  }, []);

  const saveEdit = useCallback(async (id: string) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/time-entries/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            description: editForm.description || null,
            isBillable: editForm.isBillable,
            hourlyRate: editForm.hourlyRate === '' ? null : Number(editForm.hourlyRate),
          }),
        }),
        errorFallback: 'Failed to save entry. Retry.',
        successMessage: 'Entry updated',
        friendly,
      });
      setEditingId(null);
      void loadSheet(week, tech);
    } catch (err) {
      handleActionError(err, 'Failed to save entry. Retry.');
    }
  }, [editForm, week, tech, loadSheet]);

  // Formatted week label
  const weekLabel = (() => {
    const [y, mo, d] = week.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  })();

  return (
    <div className="flex flex-col gap-4" data-testid="timesheet-page">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Timesheet</h1>

        {users.length > 0 && (
          <select
            value={tech ?? ''}
            onChange={(e) => handleTechChange(e.target.value)}
            aria-label="Select technician"
            data-testid="timesheet-tech-select"
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">My timesheet</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name || u.email}</option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={goToPrevWeek}
            data-testid="timesheet-prev-week"
            aria-label="Previous week"
            className="rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
          >
            ←
          </button>
          <span className="px-2 text-sm" data-testid="timesheet-week-label">Week of {weekLabel}</span>
          <button
            type="button"
            onClick={goToNextWeek}
            data-testid="timesheet-next-week"
            aria-label="Next week"
            className="rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
          >
            →
          </button>
          <button
            type="button"
            onClick={goToThisWeek}
            data-testid="timesheet-this-week"
            className="rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
          >
            This week
          </button>
        </div>
      </div>

      {/* Admin notice */}
      {adminDenied && (
        <div
          data-testid="timesheet-admin-notice"
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800"
        >
          Viewing other technicians&apos; timesheets requires an admin role — showing yours.
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div
          data-testid="timesheet-bulk-bar"
          className="flex items-center gap-3 rounded-md border bg-background px-3 py-2 shadow-sm"
        >
          <span className="text-sm font-medium tabular-nums">{selected.size} selected</span>
          <button
            type="button"
            onClick={() => void bulkApprove(true)}
            data-testid="timesheet-approve-selected"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
          >
            Approve selected
          </button>
          <button
            type="button"
            onClick={() => void bulkApprove(false)}
            data-testid="timesheet-unapprove-selected"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Unapprove
          </button>
        </div>
      )}

      {/* Loading / error states */}
      {loading && !sheet && (
        <div data-testid="timesheet-loading" className="py-8 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
      {!loading && !sheet && loadError && (
        <div data-testid="timesheet-error" className="py-8 text-center text-sm text-destructive">
          Failed to load timesheet. Retry.
        </div>
      )}

      {/* Days */}
      {sheet && (
        <div className="flex flex-col gap-3">
          {sheet.days.map((day) => (
            <section
              key={day.date}
              data-testid={`timesheet-day-${day.date}`}
              className="rounded-lg border"
            >
              <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2">
                <span className="text-sm font-medium">
                  {new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
                    timeZone: 'UTC',
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                <span className="text-sm text-muted-foreground">
                  {day.totalMinutes > 0 ? (
                    <>
                      {formatMinutes(day.totalMinutes)}
                      {day.billableMinutes > 0 && ` · ${formatMinutes(day.billableMinutes)} billable`}
                    </>
                  ) : '—'}
                </span>
              </div>

              {day.entries.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">No entries</div>
              ) : (
                <div className="divide-y">
                  {day.entries.map((entry) => (
                    <div
                      key={entry.id}
                      data-testid={`timesheet-entry-${entry.id}`}
                      className="flex flex-wrap items-start gap-3 px-4 py-3"
                    >
                      {editingId === entry.id ? (
                        // Inline edit form
                        <div className="flex flex-1 flex-wrap items-center gap-2">
                          <input
                            type="text"
                            value={editForm.description}
                            onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                            data-testid={`timesheet-edit-description-${entry.id}`}
                            placeholder="Description"
                            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
                          />
                          <label className="flex items-center gap-1 text-sm">
                            <input
                              type="checkbox"
                              checked={editForm.isBillable}
                              onChange={(e) => setEditForm((f) => ({ ...f, isBillable: e.target.checked }))}
                              data-testid={`timesheet-edit-billable-${entry.id}`}
                            />
                            Billable
                          </label>
                          <input
                            type="number"
                            value={editForm.hourlyRate}
                            onChange={(e) => setEditForm((f) => ({ ...f, hourlyRate: e.target.value }))}
                            aria-label="Rate"
                            placeholder="Rate"
                            className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
                            data-testid={`timesheet-edit-rate-${entry.id}`}
                          />
                          <button
                            type="button"
                            onClick={() => void saveEdit(entry.id)}
                            data-testid={`timesheet-edit-save-${entry.id}`}
                            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            data-testid={`timesheet-edit-cancel-${entry.id}`}
                            className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        // Normal row
                        <>
                          <input
                            type="checkbox"
                            checked={selected.has(entry.id)}
                            onChange={() => toggleSelect(entry.id)}
                            disabled={!entry.endedAt}
                            data-testid={`timesheet-select-${entry.id}`}
                            aria-label={`Select entry ${entry.id}`}
                            className="mt-0.5"
                          />
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <a
                                href={`/tickets/${entry.ticketId}`}
                                className="text-sm font-medium text-primary hover:underline"
                              >
                                {entry.ticketNumber}
                              </a>
                              {entry.description ? (
                                <span className="text-sm">{entry.description}</span>
                              ) : (
                                <span className="text-sm text-muted-foreground">No description</span>
                              )}
                              {entry.isApproved && (
                                <span
                                  data-testid={`timesheet-approved-${entry.id}`}
                                  className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700"
                                >
                                  Approved
                                </span>
                              )}
                              {!entry.isBillable && (
                                <span className="text-xs text-muted-foreground">non-billable</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm tabular-nums text-muted-foreground">
                              {entry.endedAt ? formatMinutes(entry.durationMinutes) : 'running'}
                            </span>
                            <button
                              type="button"
                              onClick={() => startEdit(entry)}
                              data-testid={`timesheet-edit-${entry.id}`}
                              aria-label={`Edit entry ${entry.id}`}
                              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                            >
                              Edit
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {/* Footer totals */}
      {sheet && (
        <div
          data-testid="timesheet-total"
          className="flex items-center gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm font-medium"
        >
          <span>Total: {formatMinutes(sheet.totals.totalMinutes)}</span>
          {sheet.totals.billableMinutes > 0 && (
            <span className="text-muted-foreground">Billable: {formatMinutes(sheet.totals.billableMinutes)}</span>
          )}
        </div>
      )}
    </div>
  );
}
