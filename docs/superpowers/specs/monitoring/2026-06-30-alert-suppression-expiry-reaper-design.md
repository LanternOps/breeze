# Alert Suppression Expiry Reaper — Design

**Date:** 2026-06-30
**Status:** Approved (pending spec review)
**Branch context:** follow-up to the mute-UX fix + "Forever" suppression option (same branch introduced `suppressedUntil = null` = indefinite).

## Problem

`alerts.suppressed_until` is written by every suppress path (route, bulk route, AI tool) but **read by nothing**. There is no job that reactivates an alert when its deadline passes, and `alertService` dedupe treats `status = 'suppressed'` as an open alert without consulting `suppressed_until`.

Two consequences:

1. **Timed suppressions never expire.** "Suppress for 1 hour" is functionally identical to "Forever" — the alert stays hidden until someone manually changes it.
2. **A stale suppression permanently silences its rule+device.** Because dedupe (`apps/api/src/services/alertService.ts`, the `inArray(alerts.status, ['active','acknowledged','suppressed'])` guard) counts a suppressed row as "already open", new occurrences of the same condition are dropped forever — even after the intended mute window elapsed.

The recently shipped "Forever" option made indefinite suppression an *explicit, honest* choice (`suppressed_until IS NULL`). This spec closes the remaining gap so the **timed** presets actually mean something.

## Goal

A background reaper that, on a fixed cadence, flips `suppressed` alerts whose `suppressed_until` has passed back to `active`, so they reappear for triage and stop blocking new alerts. Indefinite ("Forever", `suppressed_until IS NULL`) suppressions are never touched.

## Non-goals (kept separate by intent)

- **No re-notification / re-escalation.** Expiry is a silent "snooze wakes up", not a fresh alert. No event-bus publish, no notification channel fire.
- No per-org configurability of expiry behavior.
- No change to the mute UI or the suppress endpoints.
- No preservation of pre-suppression ack state (reactivate to `active` unconditionally).

## Approach

BullMQ repeatable "reaper" worker, a structural clone of the existing `apps/api/src/jobs/quoteExpiryReaper.ts` (and `approvalExpiryReaper.ts` / `staleCommandReaper.ts`). Rejected alternatives:

- **Lazy read-time un-suppress** (flip on `GET /alerts`): only fixes rows someone reads, and does **not** fix the dedupe-blocking problem for un-read alerts. Rejected.
- **DB-level pg_cron**: not part of this stack (all scheduling is BullMQ). Rejected.

## Design

### 1. New file: `apps/api/src/jobs/suppressionExpiryReaper.ts`

Mirrors `quoteExpiryReaper.ts`: queue/worker/schedule/shutdown lifecycle, runs inside `withSystemDbAccessContext` (alerts is org-scoped RLS, but the sweep is a system job — same as the quote reaper), Sentry `captureException` on worker/job error, `concurrency: 1`.

Exported `reapExpiredSuppressions(): Promise<number>` runs one bounded pass:

```sql
WITH due AS (
  SELECT id FROM alerts
  WHERE status = 'suppressed'
    AND suppressed_until IS NOT NULL     -- Forever (NULL) excluded by design
    AND suppressed_until < now()
  ORDER BY suppressed_until ASC
  LIMIT 500                              -- MAX_REAP_PER_RUN
  FOR UPDATE SKIP LOCKED
)
UPDATE alerts AS a
SET status = 'active',
    suppressed_until = NULL              -- clear the stale deadline
FROM due
WHERE a.id = due.id AND a.status = 'suppressed'
RETURNING a.id, a.org_id, a.title;
```

`now()` (DB clock, UTC) is compared directly against the stored `timestamp` — no timezone gymnastics needed (unlike the quote reaper's date-granular UTC-day comparison; suppression deadlines are absolute instants).

The `FOR UPDATE SKIP LOCKED` + `LIMIT 500` bound keeps a backlog spike from locking the table; on hitting the cap, `console.warn` that the backlog may be growing.

### 2. Audit trail (best-effort)

One system audit event per reactivated alert, in a loop over the `RETURNING` rows, mirroring the quote reaper:

- `action: 'alert.suppression_expired'`
- `actorType: 'system'`, `actorId: null`
- `resourceType: 'alert'`, `resourceId: <id>`, `resourceName: <title>`
- `details: { previousStatus: 'suppressed' }`

Wrapped in try/catch — an audit-write failure logs and never blocks the transition. No ML feedback (that tracks *user* outcomes; this is a system transition). No event-bus publish (no consumer, and publishing `alert.*` risks tripping the `notifications.ts` `alert.triggered` subscriber, which would violate the no-re-notify goal).

### 3. Cadence & registration

- `REAP_INTERVAL_MS = 5 * 60 * 1000` (every 5 minutes). Shortest mute preset is 1h, so worst-case overshoot is ~5 min (~8%) — precise enough for a snooze, light on the DB. Tunable. (Quote reaper is 15 min; alerts warrant tighter since durations are shorter.)
- `QUEUE_NAME = 'suppression-expiry-reaper'`, repeatable `jobId: 'suppression-expiry-reaper'`, `removeOnComplete: { count: 20 }`, `removeOnFail: { count: 200 }`.
- Wire `initializeSuppressionExpiryReaper` / `shutdownSuppressionExpiryReaper` into `apps/api/src/index.ts` alongside the other three reapers (import; init array near line 1193; shutdown array near line 1365).

### 4. Migration — supporting partial index

New idempotent migration `2026-06-30-alerts-suppression-expiry-idx.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_alerts_suppressed_expiry
  ON alerts (suppressed_until)
  WHERE status = 'suppressed' AND suppressed_until IS NOT NULL;
```

Matching partial index added to `apps/api/src/db/schema/alerts.ts` (`.where(sql\`status = 'suppressed' AND suppressed_until IS NOT NULL\`)`) so `pnpm db:check-drift` stays clean. No RLS/tenancy-allowlist change (reaper runs system-context; no new table).

### 5. Testing

`apps/api/src/jobs/suppressionExpiryReaper.test.ts`, mirroring `quoteExpiryReaper.test.ts`:

- Reactivates a `suppressed` alert whose `suppressed_until` is in the past → `active`, `suppressed_until` nulled.
- Leaves a **future** `suppressed_until` untouched.
- Leaves a **Forever** row (`suppressed_until IS NULL`) untouched.
- Ignores `active` / `acknowledged` / `resolved` rows.
- Best-effort audit: a throwing audit write still transitions the alert.
- Respects the 500-row cap (warns on backlog).

## Interfaces

- `reapExpiredSuppressions(): Promise<number>` — pure-ish single pass, returns count transitioned. Unit-testable without the worker.
- `initializeSuppressionExpiryReaper(): Promise<void>` / `shutdownSuppressionExpiryReaper(): Promise<void>` — lifecycle, called from `index.ts`.

## Risks & mitigations

- **Reactivating a resolved-by-condition alert:** alerts are not auto-resolved when the underlying condition clears (resolve is manual), so an expired suppression legitimately means "surface it again". Acceptable.
- **Backlog / table lock:** bounded 500-row `SKIP LOCKED` pass; `console.warn` on cap.
- **DB load on the US droplet (known conn ceiling):** single bounded UPDATE every 5 min at `concurrency: 1` — negligible.
