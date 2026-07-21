# Ticketing Phase 3 PR 2 — Time Tracking + Parts Frontend Implementation Plan

> **✅ STATUS: COMPLETE — shipped in #1285 (merged 2026-06-12).** All 10 tasks implemented and merged to `main`. `time_entry` feed comments, `timeFormat`/`timerActions` libs, header `TimerWidget` (mounted `Header.tsx:327`), ticket-detail `TicketTimeBilling` + `TicketPartsCard` rail cards (mounted `TicketWorkbench.tsx:432-433`), `time_entry` feed rendering (`TicketFeed.tsx:16`), `/timesheet` week view with approvals, `BillablesExportCard` on settings/ticketing, and `no-silent-mutations` enrollment all landed. Follow-up fix #1296 (feed live-refresh after Log time) merged 2026-06-12. Checkboxes below are retained as a historical record of the build sequence.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the technician-facing UI for time tracking + parts (timer widget, /timesheet page, ticket-detail time & parts cards, feed renderer, billables CSV export UI) against the merged #1276 backend, plus the one small backend gap: writing `commentType='time_entry'` feed comments.

**Architecture:** Astro MPA + React islands. All new mutation UI goes through `runAction` (enrolled in `no-silent-mutations`). Timer state is server-truth (`GET /time-entries/running`) with local ticking and a `breeze:timer-changed` window event for same-page sync. No client-side permission store — admin controls render for everyone and degrade gracefully on 403 (established pattern).

**Tech Stack:** React 18, Astro, Tailwind, zustand stores (`stores/auth` `fetchWithAuth`), Vitest + Testing Library, Hono/Drizzle for the one backend task.

**Spec:** `docs/superpowers/specs/ticketing/2026-06-11-ticketing-phase3-time-tracking-parts-design.md` §5 (decisions D1–D6 apply). Todd's 2026-06-12 decision: the feed gap closes via a **small backend add in this PR** (service writes the comment rows), not client-side merge.

---

## Merged API surface (verified 2026-06-12 — trust this over spec §4)

Mounted at `api.route('/time-entries', ...)` (`apps/api/src/index.ts:728`) and the tickets hub. All internal-only (`requireScope('partner','system')`) per D4.

| Route | Perm | Notes |
|---|---|---|
| `GET /time-entries` | `time_entries:read` | query: `userId ticketId orgId from to running billingStatus approved limit(≤200) offset`. Non-admins are forced to own entries. Returns `{data, total, limit, offset}` |
| `POST /time-entries` | `time_entries:write` | body per `createTimeEntrySchema` (camelCase: `ticketId? startedAt endedAt description? isBillable? hourlyRate? billingStatus?`) → 201 `{data: rawRow}` |
| `GET /time-entries/running` | read | `{data: entry \| null}` |
| `POST /time-entries/start` | write | `{ticketId?, description?}` → 201. **Deviation from spec:** auto-stop semantics, raw row returned (no decorations) |
| `POST /time-entries/stop` | write | **Deviation from spec §4: NOT `/:id/stop`** — stops the caller's running entry. body `{description?, isBillable?}`. 404 code `NO_RUNNING_TIMER` if none |
| `PATCH/DELETE /time-entries/:id` | write (+admin for others') | `APPROVED_IMMUTABLE` 409 unless admin; any edit clears approval |
| `POST /time-entries/bulk-approve` | write + admin (service `ADMIN_REQUIRED` 403) | `{ids: uuid[] ≤200, approve: boolean}` → `{data: {updated, skipped, skippedReasons, total}}` |
| `GET /time-entries/timesheet?userId&weekStart` | read (other users: admin else 403) | `{data: {weekStart: 'YYYY-MM-DD', days: [{date, totalMinutes, billableMinutes, entries[]}×7], totals: {totalMinutes, billableMinutes}}}` — days are UTC-keyed, week = `weekStart`+7d |
| `GET /tickets/:id/time-entries` | `tickets:read` (site-gated) | `{data: entries, total}` |
| `GET /tickets/:id/billing-summary` | `tickets:read` | `{data: {time: {totalMinutes, billableMinutes, billableAmount: '0.00'}, parts: {partsCount, billableTotal: '0.00'}}}` — **money values are numeric STRINGS** |
| `GET/POST /tickets/:id/parts` | `tickets:read`/`tickets:write` | part body per `ticketPartSchema` (`description quantity unitPrice costBasis? partNumber? vendor? isBillable? billingStatus? notes?`) |
| `PATCH/DELETE /tickets/parts/:id` | `tickets:write` | scope via parent ticket |
| `GET /tickets/export/billables.csv?from&to&orgId?` | `tickets:read`+`time_entries:read` | window ≤366 days, `Content-Disposition: attachment` |

List/running/timesheet entries are decorated: `ticketNumber` (internal number e.g. `T-2026-0001`), `ticketSubject`, `userName`. **Mutation responses are raw rows without decorations** — after start/stop the widget must refetch `/running` (or the list) for display fields.

Other ground truth:
- Admin proxy = `auth.user.isPlatformAdmin || hasPermission(perms,'*','*')` server-side (`timeActorFrom`, `apps/api/src/routes/timeEntries/timeEntries.ts:29`). The web cannot read this — render admin UI for all, handle 403.
- `fetchWithAuth` (`apps/web/src/stores/auth.ts:406`) auto-appends `orgId=` from the org-switcher store when absent. Harmless for these endpoints (list accepts `orgId` as a filter; others ignore unknown query keys).
- Error bodies: `{error, code}`; `runAction`'s `friendly(code)` hook maps codes (e.g. `NO_RUNNING_TIMER`, `ADMIN_REQUIRED`, `APPROVED_IMMUTABLE`, `ENTRY_RUNNING`) to human text.
- `TicketFeed` (`apps/web/src/components/tickets/TicketFeed.tsx:5`) already includes `'time_entry'` in `SYSTEM_TYPES`; `systemLine()` falls through to `c.content` — so once the backend writes content-bearing comments, rendering works with only a small explicit branch + tests.

## Working-tree collisions (uncommitted local WIP on main — do NOT absorb)

`apps/web/src/components/layout/Header.tsx` (density/theme menu), `TicketsPage.tsx` (select height), `DeviceList.tsx`, `HuntressIntegration.tsx`, `apps/api/src/routes/devices/core*` are locally modified. Execute this plan in a **fresh worktree from origin/main** (superpowers:using-git-worktrees). Keep the Header edit to two lines (one import + one JSX mount) so Todd's WIP merges cleanly later. Fresh worktrees need `pnpm install` and lack gitignored `.env`/`.env.test`; prefix node: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

**Branch:** `feat/ticketing-time-parts-frontend`

---

### Task 1: Backend — write `time_entry` feed comments on ticket-linked mutations

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts`
- Test: `apps/api/src/services/timeEntryService.test.ts` (exists — extend)

Comments are written when (and only when) the affected entry has a `ticketId`:
- `createTimeEntry` → `"<name> logged 45m (billable)"`
- `stopRunningEntry` (covers both `stopTimer` and `startTimer`'s auto-stop) → same "logged" wording
- `deleteTimeEntry` → `"<name> removed a 45m time entry"`
- `updateTimeEntry`: **no comment** (noise; `time_entry.updated` event already exists)

`isPublic: false` always — D4: time data never reaches the portal. Mirror the `status_change` insert shape at `apps/api/src/services/ticketService.ts:354`.

- [x] **Step 1: Write the failing tests**

Add to `apps/api/src/services/timeEntryService.test.ts` (mirror the file's existing mock setup; the db/schema mock there must export `ticketComments` — add it to the mock if missing, otherwise the whole file fails collection — module-scope-deref lesson from #1251/#1276):

```ts
describe('time_entry feed comments', () => {
  it('createTimeEntry writes a ticket feed comment for ticket-linked entries', async () => {
    // arrange mocks: resolveTicketLink select feeds a ticket; insert returning feeds an entry
    // with ticketId set, durationMinutes 45, isBillable true
    await createTimeEntry({ ticketId: TICKET_ID, startedAt, endedAt, isBillable: true }, actor);
    const commentInsert = insertCalls.find((c) => c.table === 'ticketComments');
    expect(commentInsert?.values).toMatchObject({
      ticketId: TICKET_ID,
      commentType: 'time_entry',
      isPublic: false,
      authorType: 'internal',
      content: expect.stringContaining('logged 45m'),
    });
    expect(commentInsert?.values.content).toContain('(billable)');
  });

  it('createTimeEntry writes NO comment for non-ticket entries', async () => {
    await createTimeEntry({ startedAt, endedAt }, actor);
    expect(insertCalls.filter((c) => c.table === 'ticketComments')).toHaveLength(0);
  });

  it('stopTimer writes a feed comment when the stopped entry was ticket-linked', async () => {
    // update().returning() feeds a stopped row with ticketId + durationMinutes 90
    await stopTimer({}, actor);
    const commentInsert = insertCalls.find((c) => c.table === 'ticketComments');
    expect(commentInsert?.values.content).toContain('logged 1h 30m');
  });

  it('deleteTimeEntry writes a removal comment for ticket-linked entries', async () => {
    await deleteTimeEntry(ENTRY_ID, actor);
    const commentInsert = insertCalls.find((c) => c.table === 'ticketComments');
    expect(commentInsert?.values.content).toContain('removed a');
  });
});
```

Adapt the arrange/capture mechanics to the file's existing Drizzle mock helpers (it already captures insert values for `timeEntries` — extend the same capture to `ticketComments`).

- [x] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryService.test.ts`
Expected: the 4 new tests FAIL (no comment insert happens); pre-existing tests PASS.

- [x] **Step 3: Implement**

In `apps/api/src/services/timeEntryService.ts`:

```ts
import { ticketComments } from '../db/schema'; // add to existing schema import line

/** "45m", "1h 30m", "2h" — shared wording for feed comments. */
function fmtMinutes(minutes: number | null): string {
  const m = Math.max(0, minutes ?? 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** D4: internal-only system feed line; never isPublic. No-op without a ticket. */
async function insertTimeEntryFeedComment(
  ticketId: string | null,
  actor: TimeEntryActor,
  content: string
): Promise<void> {
  if (!ticketId) return;
  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'time_entry',
    content,
    isPublic: false,
    oldValue: null,
    newValue: null
  });
}
```

Call sites (each after the row mutation succeeds, before the event emit):

```ts
// createTimeEntry — after `const entry = rows[0]!;`
await insertTimeEntryFeedComment(
  entry.ticketId, actor,
  `${actor.name ?? 'Technician'} logged ${fmtMinutes(entry.durationMinutes)}${entry.isBillable ? ' (billable)' : ''}`
);

// stopRunningEntry — after `const stopped = rows[0] ?? null;` (covers stopTimer AND startTimer auto-stop)
if (stopped?.ticketId) {
  await insertTimeEntryFeedComment(
    stopped.ticketId, actor,
    `${actor.name ?? 'Technician'} logged ${fmtMinutes(stopped.durationMinutes)}${stopped.isBillable ? ' (billable)' : ''}`
  );
}

// deleteTimeEntry — after the delete succeeds, using the pre-fetched row
await insertTimeEntryFeedComment(
  existing.ticketId, actor,
  `${actor.name ?? 'Technician'} removed a ${fmtMinutes(existing.durationMinutes)} time entry`
);
```

(`stopRunningEntry` already receives `actor`. `deleteTimeEntry` already loads the row for ownership checks — reuse it; adjust local variable names to what's actually there.)

- [x] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryService.test.ts src/routes/timeEntries/timeEntries.test.ts src/routes/tickets/parts.test.ts`
Expected: PASS (route tests guard against the new `ticketComments` deref breaking their mocks).

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts
git commit -m "feat(ticketing): write time_entry feed comments for ticket-linked entries"
```

---

### Task 2: Web lib — minute formatting + shared timer actions

**Files:**
- Create: `apps/web/src/lib/timeFormat.ts`
- Create: `apps/web/src/lib/timerActions.ts`
- Test: `apps/web/src/lib/__tests__/timeFormat.test.ts`

`timerActions` is the single mutation path for start/stop (used by the widget, ticket rail, and timesheet) so `runAction` enrollment and the `breeze:timer-changed` broadcast live in one place.

- [x] **Step 1: Write the failing test**

`apps/web/src/lib/__tests__/timeFormat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMinutes, formatElapsedSeconds, formatMoney } from '../timeFormat';

describe('formatMinutes', () => {
  it('renders sub-hour as minutes', () => expect(formatMinutes(45)).toBe('45m'));
  it('renders exact hours without minutes', () => expect(formatMinutes(120)).toBe('2h'));
  it('renders mixed', () => expect(formatMinutes(90)).toBe('1h 30m'));
  it('treats null/negative as zero', () => {
    expect(formatMinutes(null)).toBe('0m');
    expect(formatMinutes(-5)).toBe('0m');
  });
});

describe('formatElapsedSeconds', () => {
  it('renders mm:ss under an hour', () => expect(formatElapsedSeconds(125)).toBe('02:05'));
  it('renders h:mm:ss over an hour', () => expect(formatElapsedSeconds(3725)).toBe('1:02:05'));
});

describe('formatMoney', () => {
  it('formats numeric strings from the API', () => expect(formatMoney('1234.5')).toBe('$1,234.50'));
  it('falls back to $0.00 on garbage', () => expect(formatMoney('not-a-number')).toBe('$0.00'));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/lib/__tests__/timeFormat.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`apps/web/src/lib/timeFormat.ts`:

```ts
export function formatMinutes(minutes: number | null | undefined): string {
  const m = Math.max(0, minutes ?? 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

export function formatElapsedSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** API money fields arrive as numeric strings (numeric(12,2) → '123.40'). */
export function formatMoney(value: string | number | null | undefined): string {
  const n = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return safe.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
```

`apps/web/src/lib/timerActions.ts`:

```ts
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';

export const TIMER_CHANGED_EVENT = 'breeze:timer-changed';

export interface RunningTimer {
  id: string;
  ticketId: string | null;
  startedAt: string;
  description: string | null;
  isBillable: boolean;
  ticketNumber: string | null;
  ticketSubject: string | null;
}

function broadcastTimerChanged(): void {
  window.dispatchEvent(new CustomEvent(TIMER_CHANGED_EVENT));
}

export async function fetchRunningTimer(): Promise<RunningTimer | null> {
  const res = await fetchWithAuth('/time-entries/running');
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: RunningTimer | null } | null;
  return body?.data ?? null;
}

const friendly = (code: string) =>
  ({
    NO_RUNNING_TIMER: 'No timer is currently running.',
    TICKET_NOT_FOUND: 'That ticket no longer exists.',
    APPROVED_IMMUTABLE: 'Approved entries can only be changed by an admin.'
  })[code];

export async function startTimerAction(input: { ticketId?: string; description?: string } = {}): Promise<void> {
  await runAction({
    request: () => fetchWithAuth('/time-entries/start', { method: 'POST', body: JSON.stringify(input) }),
    errorFallback: 'Failed to start timer',
    successMessage: 'Timer started',
    friendly
  });
  broadcastTimerChanged();
}

export async function stopTimerAction(input: { description?: string; isBillable?: boolean } = {}): Promise<void> {
  await runAction({
    request: () => fetchWithAuth('/time-entries/stop', { method: 'POST', body: JSON.stringify(input) }),
    errorFallback: 'Failed to stop timer',
    successMessage: 'Time entry saved',
    friendly
  });
  broadcastTimerChanged();
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/lib/__tests__/timeFormat.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/lib/timeFormat.ts apps/web/src/lib/timerActions.ts apps/web/src/lib/__tests__/timeFormat.test.ts
git commit -m "feat(ticketing): time formatting + shared timer action helpers"
```

---

### Task 3: TimerWidget in the header

**Files:**
- Create: `apps/web/src/components/time/TimerWidget.tsx`
- Modify: `apps/web/src/components/layout/Header.tsx` (TWO LINES ONLY — import + mount; see collision note)
- Test: `apps/web/src/components/time/TimerWidget.test.tsx`

Behavior: on mount fetch `/time-entries/running`; if running, show elapsed (1s local tick from `startedAt`) + ticket number linked to `/tickets/<ticketId>`; refetch on `TIMER_CHANGED_EVENT` and on a 60s poll (cross-tab/MPA sync). Stop opens a small popover: description textarea + billable checkbox → `stopTimerAction`. Renders nothing when no timer is running (header stays clean).

- [x] **Step 1: Write the failing tests**

`apps/web/src/components/time/TimerWidget.test.tsx` (mirror mock style of `apps/web/src/components/tickets/TicketsPage.test.tsx` — vi.mock `../../stores/auth` for `fetchWithAuth`, fake timers for ticking):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TimerWidget from './TimerWidget';
import { TIMER_CHANGED_EVENT } from '../../lib/timerActions';

const running = {
  id: 'te-1', ticketId: 'tk-1', startedAt: new Date(Date.now() - 90_000).toISOString(),
  description: null, isBillable: false, ticketNumber: 'T-2026-0042', ticketSubject: 'Printer on fire'
};
const jsonRes = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

beforeEach(() => fetchWithAuth.mockReset());

describe('TimerWidget', () => {
  it('renders nothing when no timer is running', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(null));
    const { container } = render(<TimerWidget />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/running'));
    expect(container.querySelector('[data-testid="timer-widget"]')).toBeNull();
  });

  it('shows elapsed time and the ticket number when running', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(running));
    render(<TimerWidget />);
    expect(await screen.findByTestId('timer-widget')).toBeTruthy();
    expect(screen.getByTestId('timer-widget-ticket').textContent).toContain('T-2026-0042');
    expect(screen.getByTestId('timer-widget-elapsed').textContent).toMatch(/01:3\d/);
  });

  it('stop popover posts /time-entries/stop with description + billable', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(running));
    render(<TimerWidget />);
    fireEvent.click(await screen.findByTestId('timer-widget-stop'));
    fireEvent.change(screen.getByTestId('timer-stop-description'), { target: { value: 'fixed it' } });
    fireEvent.click(screen.getByTestId('timer-stop-billable'));
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: 'te-1' }));
    fireEvent.click(screen.getByTestId('timer-stop-submit'));
    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/stop', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ description: 'fixed it', isBillable: true })
      }));
    });
  });

  it('refetches when breeze:timer-changed fires', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(null));
    render(<TimerWidget />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    fetchWithAuth.mockResolvedValue(jsonRes(running));
    act(() => { window.dispatchEvent(new CustomEvent(TIMER_CHANGED_EVENT)); });
    expect(await screen.findByTestId('timer-widget')).toBeTruthy();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/time/TimerWidget.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `TimerWidget.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Square } from 'lucide-react';
import { fetchRunningTimer, stopTimerAction, TIMER_CHANGED_EVENT, type RunningTimer } from '../../lib/timerActions';
import { ActionError } from '../../lib/runAction';
import { formatElapsedSeconds } from '../../lib/timeFormat';

const POLL_MS = 60_000;

export default function TimerWidget() {
  const [timer, setTimer] = useState<RunningTimer | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(false);
  const [stopping, setStopping] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    void fetchRunningTimer().then(setTimer).catch(() => setTimer(null));
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, POLL_MS);
    window.addEventListener(TIMER_CHANGED_EVENT, refresh);
    return () => { clearInterval(poll); window.removeEventListener(TIMER_CHANGED_EVENT, refresh); };
  }, [refresh]);

  useEffect(() => {
    if (!timer) return;
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timer]);

  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popoverOpen]);

  if (!timer) return null;

  const openStop = () => {
    setDescription(timer.description ?? '');
    setBillable(timer.isBillable);
    setPopoverOpen(true);
  };

  const submitStop = async () => {
    setStopping(true);
    try {
      await stopTimerAction({ description: description || undefined, isBillable: billable });
      setPopoverOpen(false);
      setTimer(null);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      // non-401 ActionError already toasted by runAction
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="relative flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1" data-testid="timer-widget">
      <Clock className="h-3.5 w-3.5 text-primary" aria-hidden />
      <span className="font-mono text-xs tabular-nums" data-testid="timer-widget-elapsed">{formatElapsedSeconds(elapsed)}</span>
      {timer.ticketId && (
        <a href={`/tickets/${timer.ticketId}`} className="max-w-32 truncate text-xs text-primary hover:underline" data-testid="timer-widget-ticket" title={timer.ticketSubject ?? undefined}>
          {timer.ticketNumber ?? 'ticket'}
        </a>
      )}
      <button type="button" onClick={openStop} className="rounded p-0.5 text-muted-foreground hover:text-destructive" title="Stop timer" data-testid="timer-widget-stop">
        <Square className="h-3.5 w-3.5" aria-hidden />
      </button>
      {popoverOpen && (
        <div ref={popoverRef} className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-popover p-3 shadow-lg" data-testid="timer-stop-popover">
          <p className="mb-2 text-sm font-medium">Stop timer</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What did you work on?"
            rows={2}
            className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="timer-stop-description"
          />
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} data-testid="timer-stop-billable" />
            Billable
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPopoverOpen(false)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Cancel</button>
            <button type="button" onClick={() => void submitStop()} disabled={stopping} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="timer-stop-submit">
              {stopping ? 'Saving…' : 'Stop & save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Then in `Header.tsx`, exactly two additions (place the mount immediately before the `<NotificationCenter …/>` element in the right-side control cluster — keep the diff minimal, Todd has uncommitted WIP in this file on main):

```tsx
import TimerWidget from '../time/TimerWidget';
// …in the JSX, right-side controls:
<TimerWidget />
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/time/TimerWidget.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/components/time/ apps/web/src/components/layout/Header.tsx
git commit -m "feat(ticketing): running-timer widget in the app header"
```

---

### Task 4: Ticket detail — Time & Billing rail card

**Files:**
- Create: `apps/web/src/components/tickets/TicketTimeBilling.tsx`
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx` (mount in rail `<aside>` under `<SlaTimers …/>`, `apps/web/src/components/tickets/TicketWorkbench.tsx:348`)
- Test: `apps/web/src/components/tickets/TicketTimeBilling.test.tsx`

Card contents: billing summary (`GET /tickets/:id/billing-summary`), recent entries (`GET /tickets/:id/time-entries?limit=5`), "Start timer" button (`startTimerAction({ticketId})`), and a collapsible quick-add form (minutes + description + billable → `POST /time-entries` with `startedAt = now - minutes`, `endedAt = now`). Refreshes on `TIMER_CHANGED_EVENT` and when its own mutations complete. Money via `formatMoney`, durations via `formatMinutes`.

- [x] **Step 1: Write the failing tests**

`apps/web/src/components/tickets/TicketTimeBilling.test.tsx` (same mock style as Task 3):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketTimeBilling from './TicketTimeBilling';

const summary = { time: { totalMinutes: 90, billableMinutes: 60, billableAmount: '150.00' }, parts: { partsCount: 2, billableTotal: '49.98' } };
const entries = [{ id: 'te-1', startedAt: '2026-06-12T09:00:00Z', endedAt: '2026-06-12T09:45:00Z', durationMinutes: 45, description: 'diag', isBillable: true, userName: 'Todd', ticketNumber: null, ticketSubject: null, ticketId: 'tk-1', isApproved: false }];
const route = (url: string) => {
  if (url.startsWith('/tickets/tk-1/billing-summary')) return { ok: true, status: 200, json: async () => ({ data: summary }) } as Response;
  if (url.startsWith('/tickets/tk-1/time-entries')) return { ok: true, status: 200, json: async () => ({ data: entries, total: 1 }) } as Response;
  return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
};

beforeEach(() => { fetchWithAuth.mockReset(); fetchWithAuth.mockImplementation(async (url: string) => route(url)); });

describe('TicketTimeBilling', () => {
  it('renders totals from the billing summary', async () => {
    render(<TicketTimeBilling ticketId="tk-1" />);
    expect((await screen.findByTestId('ticket-billing-time-total')).textContent).toContain('1h 30m');
    expect(screen.getByTestId('ticket-billing-amount').textContent).toContain('$150.00');
    expect(screen.getByTestId('ticket-billing-parts-total').textContent).toContain('$49.98');
  });

  it('starts a timer scoped to the ticket', async () => {
    render(<TicketTimeBilling ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-billing-start-timer'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/start', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ ticketId: 'tk-1' })
    })));
  });

  it('quick-add posts a manual entry with computed start/end', async () => {
    render(<TicketTimeBilling ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
    fireEvent.change(screen.getByTestId('ticket-billing-quick-add-minutes'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('ticket-billing-quick-add-description'), { target: { value: 'patched' } });
    fireEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(([u]) => u === '/time-entries');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.ticketId).toBe('tk-1');
      expect(body.description).toBe('patched');
      expect(new Date(body.endedAt).getTime() - new Date(body.startedAt).getTime()).toBe(30 * 60_000);
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/TicketTimeBilling.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `TicketTimeBilling.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { startTimerAction, TIMER_CHANGED_EVENT } from '../../lib/timerActions';
import { formatMinutes, formatMoney } from '../../lib/timeFormat';

interface BillingSummary {
  time: { totalMinutes: number; billableMinutes: number; billableAmount: string };
  parts: { partsCount: number; billableTotal: string };
}
interface EntryRow {
  id: string; durationMinutes: number | null; description: string | null;
  isBillable: boolean; userName: string | null; startedAt: string; endedAt: string | null; isApproved: boolean;
}

export default function TicketTimeBilling({ ticketId }: { ticketId: string }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [sumRes, listRes] = await Promise.all([
      fetchWithAuth(`/tickets/${ticketId}/billing-summary`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetchWithAuth(`/tickets/${ticketId}/time-entries?limit=5`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ]);
    if (sumRes?.data) setSummary(sumRes.data as BillingSummary);
    if (listRes?.data) setEntries(listRes.data as EntryRow[]);
  }, [ticketId]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(TIMER_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(TIMER_CHANGED_EVENT, onChange);
  }, [refresh]);

  const swallow = (err: unknown) => {
    if (err instanceof ActionError) return; // runAction toasted (401 → redirect)
    throw err;
  };

  const startTimer = () => { void startTimerAction({ ticketId }).then(refresh).catch(swallow); };

  const submitQuickAdd = async () => {
    const mins = parseInt(minutes, 10);
    if (!Number.isFinite(mins) || mins <= 0) return;
    setBusy(true);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - mins * 60_000);
      await runAction({
        request: () => fetchWithAuth('/time-entries', {
          method: 'POST',
          body: JSON.stringify({
            ticketId,
            startedAt: start.toISOString(),
            endedAt: end.toISOString(),
            description: description || undefined,
            isBillable: billable
          })
        }),
        errorFallback: 'Failed to log time',
        successMessage: 'Time logged'
      });
      setQuickAddOpen(false); setMinutes(''); setDescription('');
      await refresh();
    } catch (err) { swallow(err); } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-time-billing">
      <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Time &amp; Billing</p>
      <div className="space-y-0.5 text-xs">
        <div className="flex justify-between"><span>Total time</span><span data-testid="ticket-billing-time-total">{formatMinutes(summary?.time.totalMinutes)}</span></div>
        <div className="flex justify-between"><span>Billable</span><span data-testid="ticket-billing-time-billable">{formatMinutes(summary?.time.billableMinutes)}</span></div>
        <div className="flex justify-between"><span>Time amount</span><span data-testid="ticket-billing-amount">{formatMoney(summary?.time.billableAmount)}</span></div>
        <div className="flex justify-between"><span>Parts ({summary?.parts.partsCount ?? 0})</span><span data-testid="ticket-billing-parts-total">{formatMoney(summary?.parts.billableTotal)}</span></div>
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={startTimer} className="rounded-md border px-2 py-1 text-xs hover:bg-muted" data-testid="ticket-billing-start-timer">Start timer</button>
        <button type="button" onClick={() => setQuickAddOpen((v) => !v)} className="rounded-md border px-2 py-1 text-xs hover:bg-muted" data-testid="ticket-billing-quick-add-toggle">Log time</button>
      </div>
      {quickAddOpen && (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-billing-quick-add">
          <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes" className="w-full rounded-md border bg-background px-2 py-1 text-xs" data-testid="ticket-billing-quick-add-minutes" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="w-full rounded-md border bg-background px-2 py-1 text-xs" data-testid="ticket-billing-quick-add-description" />
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} data-testid="ticket-billing-quick-add-billable" /> Billable
          </label>
          <button type="button" onClick={() => void submitQuickAdd()} disabled={busy} className="w-full rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50" data-testid="ticket-billing-quick-add-submit">
            {busy ? 'Saving…' : 'Save entry'}
          </button>
        </div>
      )}
      {entries.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="ticket-billing-entries">
          {entries.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate" title={e.description ?? undefined}>{e.userName ?? 'Tech'}{e.description ? ` — ${e.description}` : ''}</span>
              <span className="shrink-0 tabular-nums">{e.endedAt ? formatMinutes(e.durationMinutes) : 'running'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Mount in `TicketWorkbench.tsx` rail (directly after `<SlaTimers ticket={ticket} />`):

```tsx
import TicketTimeBilling from './TicketTimeBilling';
// …inside the <aside data-testid="ticket-workbench-rail">:
<TicketTimeBilling ticketId={ticket.id} />
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/TicketTimeBilling.test.tsx src/components/tickets/TicketWorkbench.test.tsx`
Expected: PASS (existing workbench tests must keep passing — the new card fetches are extra network mocks; if the workbench test uses a strict fetch mock, add benign handlers for `/billing-summary` and `/time-entries`).

- [x] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketTimeBilling.tsx apps/web/src/components/tickets/TicketTimeBilling.test.tsx apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx
git commit -m "feat(ticketing): Time & Billing rail card on ticket detail"
```

---

### Task 5: Ticket detail — Parts card

**Files:**
- Create: `apps/web/src/components/tickets/TicketPartsCard.tsx`
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx` (mount under `TicketTimeBilling`)
- Test: `apps/web/src/components/tickets/TicketPartsCard.test.tsx`

Compact rail card: list parts (`description`, `qty × unitPrice`, margin line when `costBasis` present — internal-only UI per D4, fine to show), add via inline form, edit/delete per row. `quantity`/`unitPrice`/`costBasis` are numbers in the request schema; API returns them as numeric strings — parse with `Number()` for display math.

- [x] **Step 1: Write the failing tests**

`apps/web/src/components/tickets/TicketPartsCard.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketPartsCard from './TicketPartsCard';

const parts = [{ id: 'p-1', ticketId: 'tk-1', description: 'SSD 1TB', partNumber: null, vendor: null, quantity: '2.00', unitPrice: '99.00', costBasis: '60.00', isBillable: true, billingStatus: 'not_billed', notes: null }];
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) =>
    url === '/tickets/tk-1/parts' ? jsonRes(parts) : jsonRes({}));
});

describe('TicketPartsCard', () => {
  it('lists parts with line totals and margin', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    const row = await screen.findByTestId('ticket-part-p-1');
    expect(row.textContent).toContain('SSD 1TB');
    expect(row.textContent).toContain('2 × $99.00');   // qty × unit
    expect(row.textContent).toContain('$198.00');       // line total
    expect(row.textContent).toContain('$78.00');        // margin (2×99 − 2×60)
  });

  it('adds a part', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-parts-add-toggle'));
    fireEvent.change(screen.getByTestId('ticket-parts-form-description'), { target: { value: 'RAM 16GB' } });
    fireEvent.change(screen.getByTestId('ticket-parts-form-quantity'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('ticket-parts-form-unit-price'), { target: { value: '45.50' } });
    fireEvent.click(screen.getByTestId('ticket-parts-form-submit'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(([u, o]) => u === '/tickets/tk-1/parts' && (o as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ description: 'RAM 16GB', quantity: 1, unitPrice: 45.5 });
    });
  });

  it('deletes a part via /tickets/parts/:id', async () => {
    render(<TicketPartsCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-part-delete-p-1'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/tickets/parts/p-1', expect.objectContaining({ method: 'DELETE' })));
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/TicketPartsCard.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `TicketPartsCard.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { formatMoney } from '../../lib/timeFormat';

interface PartRow {
  id: string; description: string; partNumber: string | null; vendor: string | null;
  quantity: string; unitPrice: string; costBasis: string | null;
  isBillable: boolean; billingStatus: string; notes: string | null;
}
interface FormState { description: string; quantity: string; unitPrice: string; costBasis: string; isBillable: boolean }
const emptyForm: FormState = { description: '', quantity: '1', unitPrice: '0', costBasis: '', isBillable: true };

export default function TicketPartsCard({ ticketId }: { ticketId: string }) {
  const [parts, setParts] = useState<PartRow[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetchWithAuth(`/tickets/${ticketId}/parts`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (res?.data) setParts(res.data as PartRow[]);
  }, [ticketId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const swallow = (err: unknown) => { if (!(err instanceof ActionError)) throw err; };

  const openAdd = () => { setEditingId(null); setForm(emptyForm); setFormOpen(true); };
  const openEdit = (p: PartRow) => {
    setEditingId(p.id);
    setForm({ description: p.description, quantity: p.quantity, unitPrice: p.unitPrice, costBasis: p.costBasis ?? '', isBillable: p.isBillable });
    setFormOpen(true);
  };

  const submit = async () => {
    const quantity = Number(form.quantity);
    const unitPrice = Number(form.unitPrice);
    if (!form.description.trim() || !(quantity > 0) || !(unitPrice >= 0)) return;
    const body = {
      description: form.description.trim(),
      quantity,
      unitPrice,
      costBasis: form.costBasis === '' ? null : Number(form.costBasis),
      isBillable: form.isBillable
    };
    setBusy(true);
    try {
      await runAction({
        request: () => (editingId
          ? fetchWithAuth(`/tickets/parts/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) })
          : fetchWithAuth(`/tickets/${ticketId}/parts`, { method: 'POST', body: JSON.stringify(body) })),
        errorFallback: editingId ? 'Failed to update part' : 'Failed to add part',
        successMessage: editingId ? 'Part updated' : 'Part added'
      });
      setFormOpen(false); setEditingId(null); setForm(emptyForm);
      await refresh();
    } catch (err) { swallow(err); } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/parts/${id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete part',
        successMessage: 'Part deleted'
      });
      await refresh();
    } catch (err) { swallow(err); }
  };

  const margin = (p: PartRow): number | null => {
    if (p.costBasis == null) return null;
    const q = Number(p.quantity);
    return q * Number(p.unitPrice) - q * Number(p.costBasis);
  };

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-parts-card">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium uppercase text-muted-foreground">Parts</p>
        <button type="button" onClick={openAdd} className="rounded-md border px-2 py-0.5 text-xs hover:bg-muted" data-testid="ticket-parts-add-toggle">Add</button>
      </div>
      {parts.length === 0 && !formOpen && <p className="text-xs text-muted-foreground" data-testid="ticket-parts-empty">No parts.</p>}
      <ul className="space-y-1.5">
        {parts.map((p) => (
          <li key={p.id} className="rounded-md border p-1.5 text-xs" data-testid={`ticket-part-${p.id}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium">{p.description}</span>
              <span className="shrink-0 tabular-nums">{formatMoney(Number(p.quantity) * Number(p.unitPrice))}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
              <span>{Number(p.quantity)} × {formatMoney(p.unitPrice)}{!p.isBillable && ' · non-billable'}</span>
              {margin(p) !== null && <span className="tabular-nums" title="Margin">{formatMoney(margin(p))}</span>}
            </div>
            <div className="mt-1 flex gap-2">
              <button type="button" onClick={() => openEdit(p)} className="text-muted-foreground hover:text-foreground" data-testid={`ticket-part-edit-${p.id}`}>Edit</button>
              <button type="button" onClick={() => void remove(p.id)} className="text-muted-foreground hover:text-destructive" data-testid={`ticket-part-delete-${p.id}`}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      {formOpen && (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-parts-form">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description" className="w-full rounded-md border bg-background px-2 py-1 text-xs" data-testid="ticket-parts-form-description" />
          <div className="flex gap-2">
            <input type="number" min="0.01" step="0.01" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="Qty" className="w-1/3 rounded-md border bg-background px-2 py-1 text-xs" data-testid="ticket-parts-form-quantity" />
            <input type="number" min="0" step="0.01" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} placeholder="Unit price" className="w-1/3 rounded-md border bg-background px-2 py-1 text-xs" data-testid="ticket-parts-form-unit-price" />
            <input type="number" min="0" step="0.01" value={form.costBasis} onChange={(e) => setForm({ ...form, costBasis: e.target.value })} placeholder="Cost" className="w-1/3 rounded-md border bg-background px-2 py-1 text-xs" data-testid="ticket-parts-form-cost-basis" />
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={form.isBillable} onChange={(e) => setForm({ ...form, isBillable: e.target.checked })} data-testid="ticket-parts-form-billable" /> Billable
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setFormOpen(false); setEditingId(null); }} className="w-1/2 rounded-md border px-2 py-1 text-xs hover:bg-muted">Cancel</button>
            <button type="button" onClick={() => void submit()} disabled={busy} className="w-1/2 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50" data-testid="ticket-parts-form-submit">
              {busy ? 'Saving…' : editingId ? 'Update' : 'Add part'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Mount in `TicketWorkbench.tsx` rail directly after `<TicketTimeBilling …/>`:

```tsx
import TicketPartsCard from './TicketPartsCard';
// …
<TicketPartsCard ticketId={ticket.id} />
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/TicketPartsCard.test.tsx src/components/tickets/TicketWorkbench.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketPartsCard.tsx apps/web/src/components/tickets/TicketPartsCard.test.tsx apps/web/src/components/tickets/TicketWorkbench.tsx
git commit -m "feat(ticketing): parts card on ticket detail"
```

---

### Task 6: TicketFeed — explicit `time_entry` rendering

**Files:**
- Modify: `apps/web/src/components/tickets/TicketFeed.tsx:7-17` (`systemLine`)
- Test: `apps/web/src/components/tickets/TicketFeed.test.tsx` (create if absent; otherwise extend)

The backend (Task 1) writes human-readable `content`. `systemLine`'s fallback already returns `c.content`, but make the branch explicit so future content-format changes have a seam, and lock behavior with tests.

- [x] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TicketFeed from './TicketFeed';
import type { TicketComment } from './ticketConfig';

const base: Omit<TicketComment, 'id' | 'commentType' | 'content'> = {
  // fill required TicketComment fields per ticketConfig.ts (authorName, createdAt, isPublic, oldValue, newValue, …)
} as never;

it('renders time_entry comments as system lines with their content', () => {
  const comments = [
    { ...base, id: 'c1', commentType: 'time_entry', content: 'Todd logged 45m (billable)', createdAt: '2026-06-12T10:00:00Z', isPublic: false, oldValue: null, newValue: null, authorName: 'Todd' }
  ] as TicketComment[];
  render(<TicketFeed comments={comments} />);
  expect(screen.getByText(/Todd logged 45m \(billable\)/)).toBeTruthy();
});
```

(Adjust `base` to satisfy the actual `TicketComment` interface at `apps/web/src/components/tickets/ticketConfig.ts:31`.)

- [x] **Step 2: Run test to verify it fails or passes-by-fallback**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/TicketFeed.test.tsx`
This may already PASS via the fallback branch — that's fine; the test is the lock. Still add the explicit branch:

- [x] **Step 3: Make the branch explicit in `systemLine`**

```ts
if (c.commentType === 'time_entry') {
  return c.content || `${c.authorName ?? 'Technician'} logged time`;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/TicketFeed.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketFeed.tsx apps/web/src/components/tickets/TicketFeed.test.tsx
git commit -m "feat(ticketing): render time_entry feed lines"
```

---

### Task 7: /timesheet page

**Files:**
- Create: `apps/web/src/components/time/TimesheetPage.tsx`
- Create: `apps/web/src/pages/timesheet.astro`
- Test: `apps/web/src/components/time/TimesheetPage.test.tsx`

Week view of `GET /time-entries/timesheet?weekStart=YYYY-MM-DD&userId=…`. Week starts **Monday UTC** (service buckets days by UTC date; keep client week math in UTC to match). Hash state per project convention: `#week=YYYY-MM-DD&tech=<uuid>` (no query params). Tech selector loads `/users` (same source as `TicketsPage.tsx:144`) and renders for everyone; a 403 from the timesheet fetch for another user shows a toast-free inline notice and falls back to own timesheet (no client permission store). Approval checkboxes per completed entry + "Approve selected" → `POST /time-entries/bulk-approve`; surface `skippedReasons` in a warning toast (bulk-tickets pattern). Inline edit per entry: description, billable, hourlyRate via `PATCH /time-entries/:id` (runAction; `APPROVED_IMMUTABLE` arrives as a friendly error).

- [x] **Step 1: Write the failing tests**

`apps/web/src/components/time/TimesheetPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TimesheetPage from './TimesheetPage';

const entry = { id: 'te-1', startedAt: '2026-06-08T09:00:00Z', endedAt: '2026-06-08T10:30:00Z', durationMinutes: 90, description: 'patching', isBillable: true, hourlyRate: '100.00', isApproved: false, ticketId: 'tk-1', ticketNumber: 'T-2026-0042', ticketSubject: 'x', userName: 'Todd', billingStatus: 'not_billed' };
const week = {
  weekStart: '2026-06-08',
  days: [
    { date: '2026-06-08', totalMinutes: 90, billableMinutes: 90, entries: [entry] },
    ...['09', '10', '11', '12', '13', '14'].map((d) => ({ date: `2026-06-${d}`, totalMinutes: 0, billableMinutes: 0, entries: [] }))
  ],
  totals: { totalMinutes: 90, billableMinutes: 90 }
};
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

beforeEach(() => {
  window.location.hash = '#week=2026-06-08';
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/time-entries/timesheet')) return jsonRes(week);
    if (url.startsWith('/users')) return jsonRes([{ id: 'u-1', name: 'Todd', email: 't@x' }]);
    return jsonRes({});
  });
});

describe('TimesheetPage', () => {
  it('fetches the week from the hash and renders day totals + entries', async () => {
    render(<TimesheetPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('/time-entries/timesheet?weekStart=2026-06-08')));
    expect((await screen.findByTestId('timesheet-day-2026-06-08')).textContent).toContain('1h 30m');
    expect(screen.getByTestId('timesheet-entry-te-1').textContent).toContain('T-2026-0042');
    expect(screen.getByTestId('timesheet-total').textContent).toContain('1h 30m');
  });

  it('week navigation updates the hash and refetches', async () => {
    render(<TimesheetPage />);
    await screen.findByTestId('timesheet-day-2026-06-08');
    fireEvent.click(screen.getByTestId('timesheet-prev-week'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('weekStart=2026-06-01')));
    expect(window.location.hash).toContain('week=2026-06-01');
  });

  it('bulk-approves selected entries and surfaces skippedReasons', async () => {
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-select-te-1'));
    fetchWithAuth.mockImplementationOnce(async () => jsonRes({ updated: 0, skipped: 1, skippedReasons: { ENTRY_RUNNING: 1 }, total: 1 }));
    fireEvent.click(screen.getByTestId('timesheet-approve-selected'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(([u]) => u === '/time-entries/bulk-approve');
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ ids: ['te-1'], approve: true });
    });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
  });

  it('falls back to own timesheet with a notice when another tech 403s', async () => {
    window.location.hash = '#week=2026-06-08&tech=u-2';
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('userId=u-2')) return { ok: false, status: 403, json: async () => ({ error: 'admin required' }) } as Response;
      if (url.startsWith('/time-entries/timesheet')) return jsonRes(week);
      if (url.startsWith('/users')) return jsonRes([{ id: 'u-2', name: 'Bo', email: 'b@x' }]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    expect(await screen.findByTestId('timesheet-admin-notice')).toBeTruthy();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.not.stringContaining('userId=u-2')));
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/time/TimesheetPage.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `TimesheetPage.tsx`**

Key pieces (full component; trim/adjust styling to the page conventions in `TicketsPage.tsx`):

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { formatMinutes } from '../../lib/timeFormat';
import { TIMER_CHANGED_EVENT } from '../../lib/timerActions';

interface TsEntry {
  id: string; startedAt: string; endedAt: string | null; durationMinutes: number | null;
  description: string | null; isBillable: boolean; hourlyRate: string | null; isApproved: boolean;
  ticketId: string | null; ticketNumber: string | null; ticketSubject: string | null;
  userName: string | null; billingStatus: string;
}
interface TsDay { date: string; totalMinutes: number; billableMinutes: number; entries: TsEntry[] }
interface Timesheet { weekStart: string; days: TsDay[]; totals: { totalMinutes: number; billableMinutes: number } }
interface UserOpt { id: string; name: string | null; email: string }

/** Monday 00:00 UTC of the week containing `d` (service buckets by UTC date). */
function mondayUtc(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (utc.getUTCDay() + 6) % 7; // Mon=0
  utc.setUTCDate(utc.getUTCDate() - dow);
  return utc.toISOString().slice(0, 10);
}
function shiftWeek(weekStart: string, weeks: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// Hash layout (project convention, mirrors TicketsPage): `#week=YYYY-MM-DD&tech=<uuid>`
function parseHash(): { week: string; tech: string | null } {
  let week = mondayUtc(new Date());
  let tech: string | null = null;
  if (typeof window !== 'undefined') {
    for (const part of window.location.hash.replace('#', '').split('&')) {
      if (part.startsWith('week=') && /^\d{4}-\d{2}-\d{2}$/.test(part.slice(5))) week = part.slice(5);
      if (part.startsWith('tech=')) tech = part.slice(5) || null;
    }
  }
  return { week, tech };
}
function writeHash(week: string, tech: string | null): void {
  const parts = [`week=${week}`];
  if (tech) parts.push(`tech=${tech}`);
  window.history.replaceState(null, '', `#${parts.join('&')}`);
}

export default function TimesheetPage() {
  const initial = useMemo(parseHash, []);
  const [week, setWeek] = useState(initial.week);
  const [tech, setTech] = useState<string | null>(initial.tech);
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [adminDenied, setAdminDenied] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ description: '', isBillable: false, hourlyRate: '' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetchWithAuth('/users').then((r) => (r.ok ? r.json() : null)).then((b) => { if (b?.data) setUsers(b.data); }).catch(() => {});
  }, []);

  const load = useCallback(async (w: string, t: string | null) => {
    setLoading(true);
    setSelected(new Set());
    const qs = new URLSearchParams({ weekStart: w });
    if (t) qs.set('userId', t);
    const res = await fetchWithAuth(`/time-entries/timesheet?${qs.toString()}`).catch(() => null);
    if (res?.status === 403 && t) {
      setAdminDenied(true);
      setTech(null);
      writeHash(w, null);
      const own = await fetchWithAuth(`/time-entries/timesheet?${new URLSearchParams({ weekStart: w }).toString()}`).catch(() => null);
      const body = own?.ok ? await own.json().catch(() => null) : null;
      setSheet(body?.data ?? null);
    } else {
      setAdminDenied(false);
      const body = res?.ok ? await res.json().catch(() => null) : null;
      setSheet(body?.data ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(week, tech);
    const onTimer = () => void load(week, tech);
    window.addEventListener(TIMER_CHANGED_EVENT, onTimer);
    return () => window.removeEventListener(TIMER_CHANGED_EVENT, onTimer);
  }, [week, tech, load]);

  const go = (w: string, t: string | null) => { setWeek(w); setTech(t); writeHash(w, t); };

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const bulkApprove = async (approve: boolean) => {
    if (selected.size === 0) return;
    try {
      const result = await runAction<{ updated: number; skipped: number; skippedReasons: Record<string, number>; total: number }>({
        request: () => fetchWithAuth('/time-entries/bulk-approve', { method: 'POST', body: JSON.stringify({ ids: [...selected], approve }) }),
        errorFallback: 'Approval failed',
        parseSuccess: (d) => (d as { data: never }).data,
        friendly: (code) => (code === 'ADMIN_REQUIRED' ? 'Approving timesheets requires an admin role.' : undefined)
      });
      if (result.skipped > 0) {
        const reasons = Object.entries(result.skippedReasons).map(([k, v]) => `${v}× ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
        showToast({ type: 'warning', message: `${result.updated} updated, ${result.skipped} skipped (${reasons})` });
      } else {
        showToast({ type: 'success', message: `${result.updated} ${approve ? 'approved' : 'unapproved'}` });
      }
      await load(week, tech);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  };

  const startEdit = (e: TsEntry) => {
    setEditing(e.id);
    setEditForm({ description: e.description ?? '', isBillable: e.isBillable, hourlyRate: e.hourlyRate ?? '' });
  };
  const saveEdit = async (id: string) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/time-entries/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            description: editForm.description || null,
            isBillable: editForm.isBillable,
            hourlyRate: editForm.hourlyRate === '' ? null : Number(editForm.hourlyRate)
          })
        }),
        errorFallback: 'Failed to update entry',
        successMessage: 'Entry updated',
        friendly: (code) => ({
          APPROVED_IMMUTABLE: 'Approved entries can only be changed by an admin.',
          NOT_OWN_ENTRY: 'Editing other technicians’ entries requires an admin role.'
        })[code]
      });
      setEditing(null);
      await load(week, tech);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  };

  return (
    <div className="space-y-4" data-testid="timesheet-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Timesheet</h1>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={tech ?? ''}
            onChange={(e) => go(week, e.target.value || null)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="timesheet-tech-select"
          >
            <option value="">My timesheet</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email}</option>)}
          </select>
          <button type="button" onClick={() => go(shiftWeek(week, -1), tech)} className="rounded-md border px-2 py-1.5 text-sm hover:bg-muted" data-testid="timesheet-prev-week">←</button>
          <span className="text-sm tabular-nums" data-testid="timesheet-week-label">Week of {week}</span>
          <button type="button" onClick={() => go(shiftWeek(week, 1), tech)} className="rounded-md border px-2 py-1.5 text-sm hover:bg-muted" data-testid="timesheet-next-week">→</button>
          <button type="button" onClick={() => go(mondayUtc(new Date()), tech)} className="rounded-md border px-2 py-1.5 text-sm hover:bg-muted" data-testid="timesheet-this-week">This week</button>
        </div>
      </div>

      {adminDenied && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-testid="timesheet-admin-notice">
          Viewing other technicians&rsquo; timesheets requires an admin role — showing yours.
        </p>
      )}

      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="timesheet-bulk-bar">
          <span>{selected.size} selected</span>
          <button type="button" onClick={() => void bulkApprove(true)} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground" data-testid="timesheet-approve-selected">Approve selected</button>
          <button type="button" onClick={() => void bulkApprove(false)} className="rounded-md border px-2 py-1 text-xs hover:bg-muted" data-testid="timesheet-unapprove-selected">Unapprove</button>
        </div>
      )}

      {loading && !sheet ? (
        <div className="animate-pulse space-y-2" data-testid="timesheet-loading">
          {[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-md bg-muted" />)}
        </div>
      ) : !sheet ? (
        <p className="text-sm text-muted-foreground" data-testid="timesheet-error">Failed to load timesheet.</p>
      ) : (
        <>
          {sheet.days.map((day) => (
            <section key={day.date} className="rounded-lg border" data-testid={`timesheet-day-${day.date}`}>
              <header className="flex items-baseline justify-between border-b bg-muted/30 px-3 py-1.5 text-sm">
                <span className="font-medium">{new Date(`${day.date}T00:00:00Z`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
                <span className="text-muted-foreground tabular-nums">{formatMinutes(day.totalMinutes)}{day.billableMinutes > 0 && ` · ${formatMinutes(day.billableMinutes)} billable`}</span>
              </header>
              {day.entries.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">—</p>
              ) : day.entries.map((e) => (
                <div key={e.id} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0" data-testid={`timesheet-entry-${e.id}`}>
                  <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} disabled={!e.endedAt} data-testid={`timesheet-select-${e.id}`} />
                  {editing === e.id ? (
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      <input value={editForm.description} onChange={(ev) => setEditForm({ ...editForm, description: ev.target.value })} className="min-w-40 flex-1 rounded-md border bg-background px-2 py-1 text-xs" data-testid={`timesheet-edit-description-${e.id}`} />
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={editForm.isBillable} onChange={(ev) => setEditForm({ ...editForm, isBillable: ev.target.checked })} /> Billable</label>
                      <input type="number" min="0" step="0.01" value={editForm.hourlyRate} onChange={(ev) => setEditForm({ ...editForm, hourlyRate: ev.target.value })} placeholder="Rate" className="w-20 rounded-md border bg-background px-2 py-1 text-xs" />
                      <button type="button" onClick={() => void saveEdit(e.id)} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground" data-testid={`timesheet-edit-save-${e.id}`}>Save</button>
                      <button type="button" onClick={() => setEditing(null)} className="rounded-md border px-2 py-1 text-xs">Cancel</button>
                    </div>
                  ) : (
                    <>
                      <span className="flex-1 truncate">
                        {e.ticketNumber && <a href={e.ticketId ? `/tickets/${e.ticketId}` : '#'} className="mr-1 font-mono text-xs text-primary hover:underline">{e.ticketNumber}</a>}
                        {e.description ?? <span className="text-muted-foreground">No description</span>}
                      </span>
                      {e.isApproved && <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs text-success" data-testid={`timesheet-approved-${e.id}`}>Approved</span>}
                      {!e.isBillable && <span className="text-xs text-muted-foreground">non-billable</span>}
                      <span className="tabular-nums text-xs">{e.endedAt ? formatMinutes(e.durationMinutes) : 'running'}</span>
                      <button type="button" onClick={() => startEdit(e)} className="text-xs text-muted-foreground hover:text-foreground" data-testid={`timesheet-edit-${e.id}`}>Edit</button>
                    </>
                  )}
                </div>
              ))}
            </section>
          ))}
          <footer className="flex justify-end gap-4 text-sm" data-testid="timesheet-total">
            <span>Total: <strong>{formatMinutes(sheet.totals.totalMinutes)}</strong></span>
            <span>Billable: <strong>{formatMinutes(sheet.totals.billableMinutes)}</strong></span>
          </footer>
        </>
      )}
    </div>
  );
}
```

`apps/web/src/pages/timesheet.astro`:

```astro
---
import DashboardLayout from '../layouts/DashboardLayout.astro';
import TimesheetPage from '../components/time/TimesheetPage';
---

<DashboardLayout title="Timesheet">
  <TimesheetPage client:load />
</DashboardLayout>
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/time/TimesheetPage.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/components/time/TimesheetPage.tsx apps/web/src/components/time/TimesheetPage.test.tsx apps/web/src/pages/timesheet.astro
git commit -m "feat(ticketing): /timesheet week view with approvals"
```

---

### Task 8: Settings → Ticketing — billables CSV export

**Files:**
- Create: `apps/web/src/components/settings/BillablesExportCard.tsx`
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.tsx` (render the card below the category manager)
- Test: `apps/web/src/components/settings/BillablesExportCard.test.tsx`

Date-range (default: first of current month → today) + optional org select (`/orgs/organizations?limit=100`, same source as `TicketsPage.tsx:161`) + Download. CSV must be fetched with auth headers (`fetchWithAuth`) then saved via a blob anchor — a plain `<a href>` has no Authorization header. GET-only → no `runAction`/no-silent-mutations enrollment needed for this file; errors show a toast manually.

- [x] **Step 1: Write the failing tests**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import BillablesExportCard from './BillablesExportCard';

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) =>
    url.startsWith('/orgs/organizations')
      ? ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'o-1', name: 'Acme' }] }) } as Response)
      : ({ ok: true, status: 200, blob: async () => new Blob(['date,type'], { type: 'text/csv' }) } as unknown as Response));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('BillablesExportCard', () => {
  it('downloads the CSV with from/to/orgId params', async () => {
    render(<BillablesExportCard />);
    await screen.findByTestId('billables-export-org');
    fireEvent.change(screen.getByTestId('billables-export-from'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByTestId('billables-export-to'), { target: { value: '2026-06-12' } });
    fireEvent.change(screen.getByTestId('billables-export-org'), { target: { value: 'o-1' } });
    fireEvent.click(screen.getByTestId('billables-export-download'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringMatching(/^\/tickets\/export\/billables\.csv\?from=2026-06-01&to=2026-06-12&orgId=o-1$/)));
  });

  it('shows an error toast when the export fails', async () => {
    render(<BillablesExportCard />);
    await screen.findByTestId('billables-export-org');
    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'window too large' }) } as Response);
    fireEvent.click(screen.getByTestId('billables-export-download'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/BillablesExportCard.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `BillablesExportCard.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function BillablesExportCard() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [orgId, setOrgId] = useState('');
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    void fetchWithAuth('/orgs/organizations?limit=100')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (b?.data) setOrgs(b.data); })
      .catch(() => {});
  }, []);

  const download = async () => {
    setDownloading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      if (orgId) qs.set('orgId', orgId);
      const res = await fetchWithAuth(`/tickets/export/billables.csv?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast({ type: 'error', message: (body as { error?: string } | null)?.error ?? 'Export failed' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `billables-${from}-to-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast({ type: 'error', message: 'Export failed' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border p-4" data-testid="billables-export-card">
      <h2 className="mb-1 text-sm font-semibold">Billables export</h2>
      <p className="mb-3 text-xs text-muted-foreground">Billable time entries and parts as CSV (up to 366 days). Includes approval status.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm" data-testid="billables-export-from" />
        </label>
        <label className="text-xs">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm" data-testid="billables-export-to" />
        </label>
        <label className="text-xs">
          Organization
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm" data-testid="billables-export-org">
            <option value="">All organizations</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void download()} disabled={downloading} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="billables-export-download">
          {downloading ? 'Exporting…' : 'Download CSV'}
        </button>
      </div>
    </section>
  );
}
```

In `TicketCategoriesPage.tsx`, render `<BillablesExportCard />` after the category manager's root section (one import + one JSX line).

- [x] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/BillablesExportCard.test.tsx src/components/settings/TicketCategoriesPage.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/BillablesExportCard.tsx apps/web/src/components/settings/BillablesExportCard.test.tsx apps/web/src/components/settings/TicketCategoriesPage.tsx
git commit -m "feat(ticketing): billables CSV export on settings/ticketing"
```

---

### Task 9: Guard-rail enrollment, sweep, docs

**Files:**
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:30` (`TARGET_GLOBS`)
- Modify: `apps/docs/src/content/docs/features/ticketing.mdx` (or wherever `features/ticketing.mdx` lives — locate with `ls apps/docs`; use the update-breeze-docs skill conventions)

- [x] **Step 1: Enroll new mutation files in no-silent-mutations**

Append to `TARGET_GLOBS`:

```ts
  'src/lib/timerActions.ts',
  'src/components/time/TimerWidget.tsx',
  'src/components/time/TimesheetPage.tsx',
  'src/components/tickets/TicketTimeBilling.tsx',
  'src/components/tickets/TicketPartsCard.tsx',
```

If the test asserts a hardcoded file count (lesson from #1251), bump it to match.

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (all mutations in those files go through `runAction`).

- [x] **Step 2: Docs**

Add a "Time tracking & parts" section to the ticketing feature doc: timer widget, /timesheet + approvals (admin-only), parts on ticket detail, billables CSV export, internal-only visibility (D4). Match the doc's existing voice; keep it to ~20 lines.

- [x] **Step 3: Full verification sweep**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run
cd ../api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryService.test.ts src/routes/timeEntries/timeEntries.test.ts src/routes/tickets/ src/services/ticketEventsContract.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
cd ../web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit && pnpm lint
```

Expected: web suite green; api targeted files green (full api suite has known parallel flakiness — verify affected files single-fork, trust CI for the rest); tsc has only the two pre-existing test errors (`agents.test.ts`, `apiKeyAuth.test.ts`) on the api side; lint clean. Reminder: `react-hooks/exhaustive-deps` disable directives FAIL web lint (rule not registered) — don't add any.

- [x] **Step 4: Commit**

```bash
git add apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/docs
git commit -m "chore(ticketing): enroll time/parts UI in no-silent-mutations + docs"
```

---

### Task 10: PR

- [x] **Step 1:** Push branch, open PR titled `feat(ticketing): Phase 3 frontend — time tracking + parts UI`, body: summary table of surfaces (widget / rail cards / timesheet / export / feed), note the Task 1 backend addition (feed comments — closes the spec §3 gap found during planning), test counts, and the Known-deferred list (Playwright e2e per spec §6; queue-side timer affordances). End body with the standard generated-with footer.
- [x] **Step 2:** Run the two-stage review per superpowers:requesting-code-review before merge (project habit: pr-review-toolkit agents).
- [x] **Step 3:** Merge with `gh pr merge --squash --admin` once CI is green.

---

## Self-review notes (spec §5 coverage)

- Timer widget (header, poll, ticket start) → Tasks 2+3
- Ticket detail Time & Billing card + quick-add + parts table + feed renderer → Tasks 4, 5, 6 (+1 backend)
- /timesheet (week nav, tech selector, inline edit, approvals, totals) → Task 7
- Settings export UI → Task 8
- runAction + no-silent-mutations + hash state conventions → Tasks 2–8, enrollment in Task 9
- Component tests (widget, timesheet, parts) per spec §6 → Tasks 3, 4, 5, 7, 8
- Playwright e2e → explicitly deferred to the ticketing-e2e backlog item (spec §6)
