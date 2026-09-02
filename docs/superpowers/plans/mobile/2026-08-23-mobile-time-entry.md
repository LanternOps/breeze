---
tracking_issue: LanternOps/breeze#3206
---

# Mobile Time Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a field technician start, stop, review and correct time entries from the Breeze mobile app, including while offline.

**Architecture:** Client-side only. The time-entry backend is complete and mounted at `/api/v1/time-entries`; the phone calls those core endpoints with the token it already holds, exactly as `services/tickets.ts` does for `/api/v1/tickets`. A local queue in AsyncStorage absorbs writes made without signal and replays them in order on reconnect. No API, schema, or migration changes.

**Tech Stack:** React Native (Expo), TypeScript, Zustand-style slices under `src/store/`, Vitest for unit tests, `@react-native-async-storage/async-storage` for the queue.

## Global Constraints

- **No backend changes.** If a task appears to need a new endpoint, stop and raise it — `/api/v1/mobile/*` deliberately has no time routes and this plan does not add any.
- **Time-entry endpoints require `partner` or `system` scope** (`requireScope('partner', 'system')`, `apps/api/src/routes/timeEntries/timeEntries.ts:24`) plus the `time_entries:read` / `time_entries:write` permissions. `time_entries` has **no org-axis RLS policy**, so an organization-scoped token cannot read it at all. Task 1 establishes what mobile tokens actually carry; every later task depends on that answer.
- **One running timer per user, enforced in the database** by a partial unique index. A second start returns **409 `ENTRY_RUNNING`**. The client must treat this as an expected outcome, never as a crash.
- **Never send `currency`** on any time-entry write. The server stamps `currency_code` once and never restamps it (multi-currency spec §7). Clients that send it will be rejected.
- **Server error codes are the contract.** `TimeEntryServiceErrorCode` (`apps/api/src/services/timeEntryService.ts:12-30`) is the authoritative union. Codes this plan handles: `ENTRY_RUNNING` (409), `NO_RUNNING_TIMER` (404), `ENTRY_BILLED` (409), `APPROVED_IMMUTABLE`, `NOT_OWN_ENTRY`, `ADMIN_REQUIRED`.
- **`hourlyRate` is `multipleOf(0.01)` and non-negative.** Never compute a rate client-side.
- Mobile unit tests mock the transport, not the network: `vi.mock('./api', () => ({ coreRequest: ... }))`. Follow `src/services/tickets.test.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/mobile/src/services/timeEntries.ts` (create) | Typed client for `/api/v1/time-entries`. Pure request-building + response-narrowing, no React. |
| `apps/mobile/src/services/timeEntries.test.ts` (create) | Unit tests for the above. |
| `apps/mobile/src/services/timeEntryQueue.ts` (create) | Offline queue: durable append, ordered drain, replay outcome classification. No React, no direct network. |
| `apps/mobile/src/services/timeEntryQueue.test.ts` (create) | Unit tests for queue semantics, including the poison-entry case. |
| `apps/mobile/src/store/timeSlice.ts` (create) | Running-timer state, elapsed derivation, queue depth. |
| `apps/mobile/src/store/timeSlice.test.ts` (create) | Unit tests for reducer transitions. |
| `apps/mobile/src/components/TimerBar.tsx` (create) | Persistent running-timer affordance. |
| `apps/mobile/src/screens/time/TimesheetScreen.tsx` (create) | Week view, per-entry edit, billable toggle. |
| `apps/mobile/src/screens/tickets/TicketDetailScreen.tsx` (modify) | Add start/stop timer for the open ticket. |
| `apps/mobile/src/navigation/MainNavigator.tsx` (modify) | Mount the timesheet route and the timer bar. |

---

### Task 1: Establish the mobile token's scope and permissions

This task writes no product code. It answers a question the rest of the plan is conditioned on, and it is a plan failure to skip it: if mobile logins mint organization-scoped tokens, **every** subsequent task is blocked and the feature needs a backend decision instead.

**Files:**
- Read: `apps/api/src/routes/auth.ts`, `apps/api/src/middleware/auth.ts`, `apps/mobile/src/services/auth.ts`
- Create: `docs/superpowers/specs/mobile/2026-08-23-mobile-time-entry-scope-findings.md`

- [ ] **Step 1: Determine the scope a mobile login mints**

Run:

```bash
rg -n "scope" apps/api/src/routes/auth.ts | head -40
rg -n "accessibleOrgIds|scope" apps/api/src/middleware/auth.ts | head -40
```

Answer, in writing: when a technician logs in through the mobile app, is `auth.scope` `'partner'`, `'organization'`, or does it vary by user role?

- [ ] **Step 2: Determine whether a technician role carries `time_entries:*`**

Run:

```bash
rg -n "TIME_ENTRIES" packages/shared/src/constants/permissions.ts
rg -n "time_entries" apps/api/src/db/seed.ts packages/shared/src/constants/ | head -20
```

Answer: do the default technician-shaped roles include `time_entries:read` and `time_entries:write`, or is it admin-only today?

- [ ] **Step 3: Verify the AI path end-to-end on a real build**

The issue notes `manage_tickets` already exposes `start_timer` / `stop_timer` / `log_time_entry` and has been Tier-2 since 2026-07-20, with no client-side tool gating on mobile Home. On the current TestFlight build, in the Home chat, send:

> log 15 minutes to ticket &lt;a real ticket ref&gt;, billable

Record: did it succeed, fail on permission, or fail on scope? A success materially shrinks Task 6, and a scope failure predicts the same failure for every REST call in this plan.

- [ ] **Step 4: Write the findings file**

Record the three answers with the evidence (file:line, and the chat transcript for Step 3). State explicitly whether the plan is GO or BLOCKED. If BLOCKED, stop here and hand back — do not start Task 2.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/mobile/2026-08-23-mobile-time-entry-scope-findings.md
git commit -m "docs(mobile): record time-entry scope/permission findings for #3206"
```

---

### Task 2: Time-entry API client

**Files:**
- Create: `apps/mobile/src/services/timeEntries.ts`
- Test: `apps/mobile/src/services/timeEntries.test.ts`

**Interfaces:**
- Consumes: `coreRequest` from `./api` (Task 0 — already on main).
- Produces:
  - `type RunningTimer = { id: string; ticketId: string | null; startedAt: string; description: string | null }`
  - `type TimeEntry = { id: string; ticketId: string | null; startedAt: string; endedAt: string | null; durationMinutes: number | null; isBillable: boolean; billingStatus: BillingStatus; isApproved: boolean; description: string | null }`
  - `type BillingStatus = 'not_billed' | 'billed' | 'no_charge' | 'contract'`
  - `getRunningTimer(): Promise<RunningTimer | null>`
  - `startTimer(input: { ticketId?: string; description?: string }): Promise<TimeEntry>`
  - `stopTimer(input: { description?: string; isBillable?: boolean }): Promise<TimeEntry>`
  - `createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntry>`
  - `getTimesheet(weekStart: string): Promise<TimesheetWeek>`
  - `class TimeEntryError extends Error { code?: string; status?: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import { getRunningTimer, startTimer, TimeEntryError } from './timeEntries';

beforeEach(() => { coreRequest.mockReset(); });

describe('getRunningTimer', () => {
  it('returns null when no timer is running', async () => {
    coreRequest.mockResolvedValue({ data: null });
    await expect(getRunningTimer()).resolves.toBeNull();
    expect(coreRequest).toHaveBeenCalledWith('/time-entries/running');
  });

  it('narrows the running-timer payload', async () => {
    coreRequest.mockResolvedValue({
      data: { id: 't1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', description: 'onsite', extra: 'ignored' },
    });
    const timer = await getRunningTimer();
    expect(timer).toEqual({ id: 't1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', description: 'onsite' });
  });
});

describe('startTimer', () => {
  it('surfaces ENTRY_RUNNING as a typed error rather than throwing raw', async () => {
    coreRequest.mockRejectedValue(
      Object.assign(new Error('Timer start conflicted'), { status: 409, body: { code: 'ENTRY_RUNNING' } }),
    );
    await expect(startTimer({ ticketId: 'k1' })).rejects.toMatchObject({
      code: 'ENTRY_RUNNING',
      status: 409,
    });
    await expect(startTimer({ ticketId: 'k1' })).rejects.toBeInstanceOf(TimeEntryError);
  });

  it('omits absent optional fields instead of sending nulls', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'e1', ticketId: 'k1', startedAt: 'x', endedAt: null, durationMinutes: null, isBillable: true, billingStatus: 'not_billed', isApproved: false, description: null } });
    await startTimer({ ticketId: 'k1' });
    const [, options] = coreRequest.mock.calls[0];
    expect(JSON.parse((options as { body: string }).body)).toEqual({ ticketId: 'k1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/mobile test src/services/timeEntries.test.ts`
Expected: FAIL — cannot resolve `./timeEntries`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { coreRequest } from './api';

/**
 * Time-entry surface for mobile. `/api/v1/mobile/*` has no time routes, so the
 * phone calls the core endpoints (`apps/api/src/routes/timeEntries/timeEntries.ts`)
 * with the token it already holds — the same approach as `services/tickets.ts`.
 *
 * These interfaces describe the SUBSET of each response the app consumes. Extra
 * server fields are ignored at runtime; add one here when a screen needs it.
 */

export type BillingStatus = 'not_billed' | 'billed' | 'no_charge' | 'contract';

export interface RunningTimer {
  id: string;
  ticketId: string | null;
  startedAt: string;
  description: string | null;
}

export interface TimeEntry {
  id: string;
  ticketId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  isBillable: boolean;
  billingStatus: BillingStatus;
  isApproved: boolean;
  description: string | null;
}

/**
 * Carries the server's `TimeEntryServiceErrorCode` through to the UI. The codes
 * that reach a phone are ENTRY_RUNNING (409, a second start), NO_RUNNING_TIMER
 * (404, stop with nothing running — routine after a reinstall), ENTRY_BILLED and
 * APPROVED_IMMUTABLE (409/400, the row is locked), NOT_OWN_ENTRY and
 * ADMIN_REQUIRED (403).
 */
export class TimeEntryError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'TimeEntryError';
  }
}

function asTimeEntryError(err: unknown): TimeEntryError {
  const e = err as { message?: string; status?: number; body?: { code?: string; error?: string } };
  return new TimeEntryError(e?.body?.error ?? e?.message ?? 'Time entry request failed', e?.body?.code, e?.status);
}

function narrowRunning(raw: Record<string, unknown> | null): RunningTimer | null {
  if (!raw) return null;
  return {
    id: String(raw.id),
    ticketId: (raw.ticketId as string | null) ?? null,
    startedAt: String(raw.startedAt),
    description: (raw.description as string | null) ?? null,
  };
}

function narrowEntry(raw: Record<string, unknown>): TimeEntry {
  return {
    id: String(raw.id),
    ticketId: (raw.ticketId as string | null) ?? null,
    startedAt: String(raw.startedAt),
    endedAt: (raw.endedAt as string | null) ?? null,
    durationMinutes: (raw.durationMinutes as number | null) ?? null,
    isBillable: Boolean(raw.isBillable),
    billingStatus: (raw.billingStatus as BillingStatus) ?? 'not_billed',
    isApproved: Boolean(raw.isApproved),
    description: (raw.description as string | null) ?? null,
  };
}

/** Drops undefined keys so optional fields are absent, not null — the Zod
 *  schemas use `.optional()`, which rejects an explicit null. */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

export async function getRunningTimer(): Promise<RunningTimer | null> {
  const res = await coreRequest<{ data: Record<string, unknown> | null }>('/time-entries/running');
  return narrowRunning(res.data);
}

export async function startTimer(input: { ticketId?: string; description?: string }): Promise<TimeEntry> {
  try {
    const res = await coreRequest<{ data: Record<string, unknown> }>('/time-entries/start', {
      method: 'POST',
      body: JSON.stringify(compact(input)),
    });
    return narrowEntry(res.data);
  } catch (err) {
    throw asTimeEntryError(err);
  }
}

export async function stopTimer(input: { description?: string; isBillable?: boolean } = {}): Promise<TimeEntry> {
  try {
    const res = await coreRequest<{ data: Record<string, unknown> }>('/time-entries/stop', {
      method: 'POST',
      body: JSON.stringify(compact(input)),
    });
    return narrowEntry(res.data);
  } catch (err) {
    throw asTimeEntryError(err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/mobile test src/services/timeEntries.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/timeEntries.ts apps/mobile/src/services/timeEntries.test.ts
git commit -m "feat(mobile): typed time-entry client for the core API (#3206)"
```

---

### Task 3: Offline queue for time-entry writes

The one gap that materially breaks the field-tech use case. A tech in a basement starts a timer, stops it 40 minutes later, and must not lose the entry.

**Files:**
- Create: `apps/mobile/src/services/timeEntryQueue.ts`
- Test: `apps/mobile/src/services/timeEntryQueue.test.ts`

**Interfaces:**
- Consumes: `AsyncStorage` from `@react-native-async-storage/async-storage`; `startTimer` / `stopTimer` / `createTimeEntry` from Task 2.
- Produces:
  - `type QueuedWrite = { id: string; kind: 'start' | 'stop' | 'create'; payload: Record<string, unknown>; queuedAt: string; attempts: number }`
  - `enqueue(write: Omit<QueuedWrite, 'id' | 'queuedAt' | 'attempts'>): Promise<QueuedWrite>`
  - `readQueue(): Promise<QueuedWrite[]>`
  - `drain(send: (w: QueuedWrite) => Promise<void>): Promise<DrainResult>`
  - `type DrainResult = { sent: number; dropped: QueuedWrite[]; remaining: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

import { enqueue, readQueue, drain } from './timeEntryQueue';

beforeEach(() => { store.clear(); });

describe('timeEntryQueue', () => {
  it('replays writes in the order they were made', async () => {
    await enqueue({ kind: 'start', payload: { ticketId: 'k1' } });
    await enqueue({ kind: 'stop', payload: { isBillable: true } });
    const seen: string[] = [];
    const result = await drain(async (w) => { seen.push(w.kind); });
    expect(seen).toEqual(['start', 'stop']);
    expect(result).toMatchObject({ sent: 2, remaining: 0 });
    await expect(readQueue()).resolves.toEqual([]);
  });

  it('stops draining on a transport failure and keeps the rest queued', async () => {
    await enqueue({ kind: 'start', payload: {} });
    await enqueue({ kind: 'stop', payload: {} });
    const result = await drain(async (w) => {
      if (w.kind === 'start') throw Object.assign(new Error('offline'), { status: undefined });
    });
    // Order matters more than throughput: a stop must never land before its start.
    expect(result).toMatchObject({ sent: 0, remaining: 2 });
  });

  it('drops a permanently-rejected write instead of blocking the queue forever', async () => {
    await enqueue({ kind: 'stop', payload: {} });
    await enqueue({ kind: 'start', payload: { ticketId: 'k2' } });
    const result = await drain(async (w) => {
      if (w.kind === 'stop') throw Object.assign(new Error('no timer'), { status: 404, code: 'NO_RUNNING_TIMER' });
    });
    // A 4xx will never succeed on retry — dropping it lets the queue progress.
    expect(result.dropped.map((d) => d.kind)).toEqual(['stop']);
    expect(result).toMatchObject({ sent: 1, remaining: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/mobile test src/services/timeEntryQueue.test.ts`
Expected: FAIL — cannot resolve `./timeEntryQueue`.

- [ ] **Step 3: Write minimal implementation**

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

const QUEUE_KEY = 'breeze.timeEntryQueue.v1';

export interface QueuedWrite {
  id: string;
  kind: 'start' | 'stop' | 'create';
  payload: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
}

export interface DrainResult {
  sent: number;
  dropped: QueuedWrite[];
  remaining: number;
}

export async function readQueue(): Promise<QueuedWrite[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
  } catch {
    // A corrupted queue must not brick the app. Losing unsynced entries is bad;
    // an unopenable Time tab is worse, and the rows are recoverable by hand.
    return [];
  }
}

async function writeQueue(items: QueuedWrite[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

export async function enqueue(
  write: Omit<QueuedWrite, 'id' | 'queuedAt' | 'attempts'>,
): Promise<QueuedWrite> {
  const item: QueuedWrite = {
    ...write,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  const queue = await readQueue();
  queue.push(item);
  await writeQueue(queue);
  return item;
}

/**
 * Sends queued writes oldest-first, stopping at the first one that could still
 * succeed later.
 *
 * The ordering guarantee is the point: a `stop` replayed before its `start`
 * would 404, so this deliberately does NOT skip past a failure to keep going.
 * The exception is a 4xx, which is a verdict rather than a delay — retrying it
 * forever would wedge every later entry behind it, so it is dropped and
 * reported for the caller to surface.
 */
export async function drain(send: (w: QueuedWrite) => Promise<void>): Promise<DrainResult> {
  const queue = await readQueue();
  const dropped: QueuedWrite[] = [];
  let sent = 0;
  let index = 0;

  while (index < queue.length) {
    const item = queue[index];
    try {
      await send(item);
      sent += 1;
      index += 1;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        dropped.push(item);
        index += 1;
        continue;
      }
      break;
    }
  }

  const remaining = queue.slice(index);
  await writeQueue(remaining);
  return { sent, dropped, remaining: remaining.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/mobile test src/services/timeEntryQueue.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/timeEntryQueue.ts apps/mobile/src/services/timeEntryQueue.test.ts
git commit -m "feat(mobile): durable offline queue for time-entry writes (#3206)"
```

---

### Task 4: Running-timer state slice

**Files:**
- Create: `apps/mobile/src/store/timeSlice.ts`
- Test: `apps/mobile/src/store/timeSlice.test.ts`

**Interfaces:**
- Consumes: `RunningTimer`, `TimeEntry` from Task 2; `QueuedWrite` from Task 3.
- Produces:
  - `type TimeState = { running: RunningTimer | null; pendingCount: number; lastError: string | null }`
  - `elapsedSeconds(running: RunningTimer | null, now: Date): number`
  - `timerStarted(state, entry) / timerStopped(state) / queueDepthChanged(state, n)` reducers.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { elapsedSeconds, timerStarted, timerStopped, initialTimeState } from './timeSlice';

describe('elapsedSeconds', () => {
  it('is zero when nothing is running', () => {
    expect(elapsedSeconds(null, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });

  it('counts from startedAt', () => {
    const running = { id: 't1', ticketId: null, startedAt: '2026-08-23T10:00:00Z', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:02:30Z'))).toBe(150);
  });

  it('clamps a future startedAt to zero rather than showing a negative timer', () => {
    // Phone clocks drift; the server accepts up to 5 minutes of skew, so a
    // startedAt slightly ahead of local time is normal, not corrupt.
    const running = { id: 't1', ticketId: null, startedAt: '2026-08-23T10:05:00Z', description: null };
    expect(elapsedSeconds(running, new Date('2026-08-23T10:00:00Z'))).toBe(0);
  });
});

describe('reducers', () => {
  it('records the running timer on start', () => {
    const next = timerStarted(initialTimeState, {
      id: 'e1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', endedAt: null,
      durationMinutes: null, isBillable: true, billingStatus: 'not_billed', isApproved: false, description: null,
    });
    expect(next.running).toMatchObject({ id: 'e1', ticketId: 'k1' });
  });

  it('clears the running timer on stop', () => {
    const started = timerStarted(initialTimeState, {
      id: 'e1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', endedAt: null,
      durationMinutes: null, isBillable: true, billingStatus: 'not_billed', isApproved: false, description: null,
    });
    expect(timerStopped(started).running).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/mobile test src/store/timeSlice.test.ts`
Expected: FAIL — cannot resolve `./timeSlice`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { RunningTimer, TimeEntry } from '../services/timeEntries';

export interface TimeState {
  running: RunningTimer | null;
  pendingCount: number;
  lastError: string | null;
}

export const initialTimeState: TimeState = { running: null, pendingCount: 0, lastError: null };

/**
 * Seconds a timer has been running, clamped at zero.
 *
 * The clamp is not defensive noise: the server tolerates 5 minutes of clock
 * skew on `startedAt`, so a phone whose clock lags the server legitimately sees
 * a start time in its own future. Showing "-00:03:11" would read as a bug.
 */
export function elapsedSeconds(running: RunningTimer | null, now: Date): number {
  if (!running) return 0;
  const started = new Date(running.startedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now.getTime() - started) / 1000));
}

export function timerStarted(state: TimeState, entry: TimeEntry): TimeState {
  return {
    ...state,
    running: {
      id: entry.id,
      ticketId: entry.ticketId,
      startedAt: entry.startedAt,
      description: entry.description,
    },
    lastError: null,
  };
}

export function timerStopped(state: TimeState): TimeState {
  return { ...state, running: null, lastError: null };
}

export function queueDepthChanged(state: TimeState, pendingCount: number): TimeState {
  return { ...state, pendingCount };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/mobile test src/store/timeSlice.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/store/timeSlice.ts apps/mobile/src/store/timeSlice.test.ts
git commit -m "feat(mobile): running-timer state slice (#3206)"
```

---

### Task 5: Start/stop a timer from ticket detail

**Files:**
- Modify: `apps/mobile/src/screens/tickets/TicketDetailScreen.tsx`
- Create: `apps/mobile/src/screens/tickets/timerActions.ts`
- Test: `apps/mobile/src/screens/tickets/timerActions.test.ts`

**Interfaces:**
- Consumes: `startTimer`, `stopTimer`, `TimeEntryError` (Task 2); `enqueue` (Task 3); `timerStarted`, `timerStopped` (Task 4).
- Produces: `startForTicket(ticketId, deps): Promise<StartOutcome>` where
  `type StartOutcome = { ok: true; entry: TimeEntry } | { ok: 'queued' } | { ok: false; reason: 'already-running' | 'denied' | 'unknown'; message: string }`

Extracting the decision into `timerActions.ts` keeps it unit-testable without rendering the screen — the same split `approvalFlow.ts` uses next to `ApprovalScreen.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { startForTicket } from './timerActions';
import { TimeEntryError } from '../../services/timeEntries';

const entry = {
  id: 'e1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', endedAt: null,
  durationMinutes: null, isBillable: true, billingStatus: 'not_billed' as const,
  isApproved: false, description: null,
};

describe('startForTicket', () => {
  it('returns the entry on success', async () => {
    const deps = { startTimer: vi.fn().mockResolvedValue(entry), enqueue: vi.fn(), isConnected: () => true };
    await expect(startForTicket('k1', deps)).resolves.toEqual({ ok: true, entry });
  });

  it('queues the write when offline instead of calling the API', async () => {
    const deps = { startTimer: vi.fn(), enqueue: vi.fn().mockResolvedValue(undefined), isConnected: () => false };
    await expect(startForTicket('k1', deps)).resolves.toEqual({ ok: 'queued' });
    expect(deps.startTimer).not.toHaveBeenCalled();
    expect(deps.enqueue).toHaveBeenCalledWith({ kind: 'start', payload: { ticketId: 'k1' } });
  });

  it('reports an existing timer as a recoverable outcome, not a crash', async () => {
    const deps = {
      startTimer: vi.fn().mockRejectedValue(new TimeEntryError('conflict', 'ENTRY_RUNNING', 409)),
      enqueue: vi.fn(),
      isConnected: () => true,
    };
    const result = await startForTicket('k1', deps);
    expect(result).toMatchObject({ ok: false, reason: 'already-running' });
  });

  it('distinguishes a permission denial so the UI can hide the control', async () => {
    const deps = {
      startTimer: vi.fn().mockRejectedValue(new TimeEntryError('nope', undefined, 403)),
      enqueue: vi.fn(),
      isConnected: () => true,
    };
    expect(await startForTicket('k1', deps)).toMatchObject({ ok: false, reason: 'denied' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/mobile test src/screens/tickets/timerActions.test.ts`
Expected: FAIL — cannot resolve `./timerActions`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { TimeEntryError, type TimeEntry } from '../../services/timeEntries';

export type StartOutcome =
  | { ok: true; entry: TimeEntry }
  | { ok: 'queued' }
  | { ok: false; reason: 'already-running' | 'denied' | 'unknown'; message: string };

interface StartDeps {
  startTimer: (input: { ticketId?: string }) => Promise<TimeEntry>;
  enqueue: (w: { kind: 'start'; payload: Record<string, unknown> }) => Promise<unknown>;
  isConnected: () => boolean;
}

export async function startForTicket(ticketId: string, deps: StartDeps): Promise<StartOutcome> {
  if (!deps.isConnected()) {
    await deps.enqueue({ kind: 'start', payload: { ticketId } });
    return { ok: 'queued' };
  }
  try {
    return { ok: true, entry: await deps.startTimer({ ticketId }) };
  } catch (err) {
    const e = err as TimeEntryError;
    if (e.code === 'ENTRY_RUNNING') {
      return { ok: false, reason: 'already-running', message: 'A timer is already running. Stop it first.' };
    }
    if (e.status === 403) {
      return { ok: false, reason: 'denied', message: 'Your role cannot log time.' };
    }
    return { ok: false, reason: 'unknown', message: e.message || 'Could not start the timer.' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/mobile test src/screens/tickets/timerActions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the control into the screen**

In `TicketDetailScreen.tsx`, add a Start/Stop control that calls `startForTicket` and dispatches `timerStarted` / `timerStopped`. Render the `already-running` and `denied` messages inline. Hide the control entirely after a `denied` outcome for the session, so a technician without the permission is not offered a button that always fails.

- [ ] **Step 6: Run the full mobile suite**

Run: `pnpm --filter @breeze/mobile test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/screens/tickets/
git commit -m "feat(mobile): start and stop a ticket timer from ticket detail (#3206)"
```

---

### Task 6: Timer bar and queue replay on reconnect

**Files:**
- Create: `apps/mobile/src/components/TimerBar.tsx`
- Modify: `apps/mobile/src/navigation/MainNavigator.tsx`

**Interfaces:**
- Consumes: `elapsedSeconds`, `TimeState` (Task 4); `drain`, `readQueue` (Task 3); `useNetworkConnected` (`src/lib/useNetworkConnected.ts`, already on main).

- [ ] **Step 1: Mount the bar**

Render `TimerBar` above the tab bar in `MainNavigator`, visible only when `running !== null` or `pendingCount > 0`. Show `HH:MM:SS` from `elapsedSeconds` on a 1s interval, the ticket reference when `ticketId` is set, and a Stop action.

- [ ] **Step 2: Replay the queue when connectivity returns**

Subscribe to `useNetworkConnected`. On a false→true transition, call `drain`. Report the result: on `dropped.length > 0`, surface a Toast naming how many entries could not be saved — a silently discarded time entry is unbillable work, so it must never vanish quietly.

- [ ] **Step 3: Verify by hand on a device**

Airplane mode → start a timer → confirm the bar shows a pending badge → stop it → disable airplane mode → confirm both writes land and the badge clears.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/components/TimerBar.tsx apps/mobile/src/navigation/MainNavigator.tsx
git commit -m "feat(mobile): persistent timer bar with offline replay (#3206)"
```

---

### Task 7: Timesheet screen

**Files:**
- Create: `apps/mobile/src/screens/time/TimesheetScreen.tsx`
- Modify: `apps/mobile/src/navigation/MainNavigator.tsx`

**Interfaces:**
- Consumes: `getTimesheet` (Task 2).

- [ ] **Step 1: Render the week**

Call `GET /time-entries/timesheet?weekStart=<ISO date>` and group entries by day with a daily and weekly total. `weekStart` is a date-only value — send it as `YYYY-MM-DD`, not a full ISO timestamp, or the day boundary shifts by timezone.

- [ ] **Step 2: Allow correcting an unlocked entry**

Editing calls `PATCH /time-entries/:id`. An entry with `isApproved: true` or `billingStatus: 'billed'` is immutable except for its description — render those read-only rather than letting the write fail with `APPROVED_IMMUTABLE` / `ENTRY_BILLED`.

- [ ] **Step 3: Run the full mobile suite and commit**

```bash
pnpm --filter @breeze/mobile test
git add apps/mobile/src/screens/time/ apps/mobile/src/navigation/MainNavigator.tsx
git commit -m "feat(mobile): weekly timesheet with inline correction (#3206)"
```

---

## Self-Review

**Spec coverage.** This plan covers issue #3206 gaps 2 (timer UI, timesheet, billable toggle), 4 (offline queue), and 7 (permissions surfacing, via Task 1). Gap 1 (ticket screens) shipped in PR #3716. Gaps 3 (mobile-shaped wrappers), 5 (push categories for assignment/SLA breach) and 6 (attachment upload), plus the auto-suggestion work from `remote_sessions`, are **deliberately out of scope** — they are separate subsystems that each need their own plan, and none is required for a technician to log time. They remain tracked as waves on the feature.

**Known risk.** Task 1 can invalidate Tasks 2–7. If mobile tokens are organization-scoped, `/time-entries` returns 403 for every call and the feature needs a backend decision — either a partner-scope path for mobile or an org-axis RLS policy on `time_entries`. That is a tenancy change and must not be improvised inside a client-side plan.
