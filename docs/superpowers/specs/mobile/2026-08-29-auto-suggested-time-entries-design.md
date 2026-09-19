---
tracking_issue: LanternOps/breeze#3206
wave: W06
wave_issue: LanternOps/breeze#3900
status: Drafted — synthesised from three attempts + judge tie-break, awaiting plan
depends_on:
  - "#3206 W03 (mobile time-entry client + offline queue), W05 (timesheet stack)"
  - "location-time-suggestions spec (2026-08-28) shares time_entries.source — W06 owns the column"
---

# W06 — Auto-suggested time entries from recorded remote-session durations

Evidence labels used throughout: **[verified]** = read on origin/main in this worktree during synthesis; **[verified (codex)]** = cited by the Codex tie-break pass with file:line, not independently re-read; **[inferred]**; **[not-checked]**.

## Goal

At the end of the day a technician opens the Timesheet on the phone and sees:

> You ran a 38-minute desktop session on **ACME-DC01** and closed **TKT-1041** — log it?

One tap creates an ordinary `time_entries` row (ticket link, org/currency resolved by the existing ticket path) with server-stamped provenance. The suggestion is backed by a recorded `remote_sessions` duration, never by a guess. Nothing is written without the tap (owner principle, 2026-08-28: *suggest, never write*). The partner flag is off by default.

## Non-goals

- No stored suggestions table. Suggestions are derived at read time from signal rows that already exist (D1).
- No new signals beyond `remote_sessions` in this wave. `support_sessions` is an attribution *enrichment*, not a signal (D4). `script_executions`, `device_commands` (system-scoped, no RLS) and bare ticket status transitions are not signals; ticket transitions are used only to *pair* a session with a ticket.
- No push dispatch. W06 ships the count function and the payload builder; W07 owns the scheduler, quiet hours, dedupe and the mobile tap handler.
- No web suggestions panel. Web gets a read-only `source` badge and the settings toggle (D8).
- No client-settable `source` on any route (D5). The location wave adds `'location'` on `/start` later, under its own spec.
- No technician position data, anywhere — this wave touches none.
- No attribution of Quick Support work to `attributed_org_id` on the entry (D6).

## Decisions

**D1 — Compute suggestions on read; persist only decisions.**
Signal rows (`remote_sessions`) are durable, RLS-scoped (Shape 1, `org_id`) and already carry `user_id`, `started_at`, `ended_at`, `duration_seconds` [verified `apps/api/src/db/schema/remote.ts:9-26`]. A stored suggestions table would be a copy that goes stale when sessions or devices are purged and would need org-cascade, export-policy and device-list registration for zero product value. What must persist is the technician's *decision* (confirmed / dismissed), so that is the only new table.
*Rejected:* generator job + `time_suggestions` table.

**D2 — One `time_suggestion_decisions` ledger (confirmed + dismissed), not `time_entries.source_ref` + a dismissals-only table.**
Time-entry deletion is a hard delete [verified (codex) `timeEntryService.ts:707`]. With `source_ref` on the entry, deleting a confirmed entry silently re-suggests the session; with a ledger row whose `time_entry_id` is `ON DELETE SET NULL`, the decision survives as a tombstone and replay returns an explicit 410. The ledger also handles merged adjacent sessions naturally (one row per member signal, all pointing at the same entry) and keeps the `time_entries` export-policy delta to a single column. The `UNIQUE (user_id, signal_kind, signal_id)` index is the offline-replay idempotency key from day one.
*Rejected:* `time_entries.source_ref` partial-unique (mvp-first); ledger **plus** `time_entries.source_ref_id` with a pairing CHECK (codex-design) — the second link is redundant with `decisions.time_entry_id`.

**D3 — Ledger RLS is Shape 3 partner-axis; own-rows enforced in the app layer.**
Policy: `system OR breeze_has_partner_access(partner_id)`, identical to `time_entries` [verified `2026-06-12-a-ticketing-time-parts.sql:60-63` (the `:46-55` citation in an earlier draft pointed at the index block, not the policy), pair-list entry at `rls-coverage.integration.test.ts:193`]. The tie-break analysis (below) explains why this beats the AND-ed `partner AND user_id = breeze_current_user_id()` policy: a decision is not private data (it is "not now" on a session the admin can already see under org-axis RLS), and partner-only keeps the `manageAll` timesheet-review pattern [verified `routes/timeEntries/timeEntries.ts:46,174-181`] working without a system-context bypass.
*Rejected:* AND-ed partner+user policy (codex-design, Codex tie-break); Shape 6 user-only (no partner validation of the stamped `partner_id`, no partner-sweep erasure).

**D4 — `remote_sessions` is the only signal kind; Quick Support is attribution enrichment.**
Quick Support reuses the remote-session stack unchanged: the connect path creates a `remote_sessions` row under the hidden `quick_support` org with the technician's `user_id` [verified (codex) `routes/remote/sessions.ts:251`, `2026-08-13-a-quick-support-sessions.sql:5`], and the QS status panel itself derives activity from linked-device `remote_sessions` [verified (codex) `routes/remote/supportSessions.ts:161`]. A second `support_session` signal kind would double-suggest the same work and need a dedupe heuristic that can be silently wrong. Instead the list query LEFT JOINs `support_sessions` on `device_id` to replace the hidden org with `attributed_org_id` / `attribution_label` [verified `schema/supportSessions.ts:32-38`].
*Rejected:* two signal kinds with device-based dedupe (codex-design).

**D5 — `time_entries.source` is server-stamped only; W06 owns the column; vocabulary is the location spec's four values plus `support_session`.**
`CHECK (source IN ('manual','timer','location','remote_session','support_session'))`, `varchar(24) NOT NULL DEFAULT 'manual'`. `POST /` stamps `manual`, `POST /start` stamps `timer`, the confirm route stamps `remote_session` or `support_session`; `location` is reserved for the location wave, which may later allow it on `/start` under its §2.4. No public zod schema accepts `source` in W06 — provenance is not presentation metadata, and the current validator exposes no such field [verified (codex) `packages/shared/src/validators/timeEntries.ts:15`]. `support_session` is a distinct value because such an entry deliberately carries `org_id NULL` (D6) and a reader must be able to tell "sourced from a session but has no org" from "manual standalone". CHECK rather than `pgEnum`: `ALTER TYPE ... ADD VALUE` cannot run inside autoMigrate's per-file transaction; a later idempotent `DROP CONSTRAINT IF EXISTS` + re-add extends the list.
*Rejected:* the brief's `suggestion_*` prefixes (provenance of "suggested" is derivable from the ledger); client-settable `manual|location` on `POST /` now (codex-design).
*Doc reconciliation:* amend `2026-08-28-location-time-suggestions-design.md` §2.2 with one line — "W06 (#3900) creates this column (migration `2026-09-23-…`) and adds `support_session`; values otherwise unchanged."

**D6 — A confirmed Quick Support entry lands with `org_id NULL`, never the hidden org and never `attributed_org_id`.**
`attributed_org_id` is a nullable reporting hint [verified `schema/supportSessions.ts:34-35`]; stamping it would turn a hint into a billing fact (currency, default rate). The sheet shows the attribution label; the technician can attach a ticket, which sets the org through the existing locked ticket path exactly as today.

**D7 — Dedicated confirm route that takes signal ids, re-validated under the caller's RLS.**
`POST /time-entries/suggestions/confirm` re-reads the signals with `user_id = actor` inside the request DB context (the hidden `quick_support` org is always in `accessibleOrgIds`, even for `orgAccess='selected'` users [verified `middleware/auth.ts:347-369`]), then calls `createTimeEntry` with an internal-only `provenance` argument. Provenance cannot be forged and the offline queue needs no client idempotency token.
*Rejected:* reusing `POST /time-entries` with an allow-listed `source`.

**D8 — Migration filename `2026-09-23-time-entry-source-and-suggestion-decisions.sql`.**
The shipped set already runs to `2026-09-22-ai-alert-verdicts-live-unique.sql` and `2026-08-29` already holds `-a-`/`-b-` files [verified `ls apps/api/migrations`]. A `2026-08-29-…` prefix would replay in a different order on a fresh DB than on a migrated one. If a later migration lands before this ships, bump the date again.

**D9 — Bucket sessions by `ended_at` in the partner timezone; duration = `COALESCE(duration_seconds, ended_at − started_at)`.**
Work belongs to the day it ended (a session crossing midnight into the queried day is otherwise lost). `duration_seconds` is written by the user-initiated end path [verified `routes/remote/sessions.ts:1215-1233`] and the terminal WS close [verified `routes/terminalWs.ts:384-391`]; the agent-side and reaper paths do not [inferred from grep]. COALESCE covers both, and a `precision: 'recorded' | 'derived' | 'unreliable'` chip tells the technician which. Partner tz from `partners.timezone` [verified `schema/orgs.ts:33`]; the client may pass an IANA `tz` override.

## Tie-break analysis (judge disagreement)

The Claude judge scored risk-first 7.8, mvp-first 7.5, codex-design 6.8 and listed seven disagreements. A Codex read-only pass (gpt-5.6-sol, high effort) was run on the four still-open points. Outcomes:

| # | Disagreement | Attempts | Codex tie-break | Decision | Why |
|---|---|---|---|---|---|
| 1 | Migration date | 08-29 (risk-first, codex) vs 09-23 (mvp) | — | **09-23** (D8) | Verified ledger; filenames are immutable once shipped. |
| 2 | `source` vocabulary | 4 values (mvp) vs +`support_session` | — | **5 values** (D5) | `org_id NULL` entries need a distinguishable provenance; one-line spec amendment either way. |
| 3 | Confirmation state | `source_ref` on entry (mvp) vs ledger (risk-first, codex) | ledger | **ledger** (D2) | Hard delete of entries; merged sessions; single idempotency key; one export-policy column. |
| 4 | Ledger RLS | partner-only (mvp, risk-first) vs partner AND user (codex-design) | partner AND user | **partner-only** (D3) | See below — the one point where I overrule Codex. |
| 5 | Client-settable `source` | no (mvp, risk-first) vs `manual\|location` (codex-design) | server-only | **server-only** (D5) | Provenance, not presentation; nothing in W06 needs it. |
| 6 | Offline confirm | disabled (mvp) vs queued (risk-first, codex-design) | — | **queued** | The ledger unique index makes replay safe from day one; W03's queue `kind` union is extensible [verified plan Task 3]. Outcomes table in Mobile flow. |
| 7 | Signals | remote only (mvp, risk-first) vs +support_sessions (codex-design) | remote only | **remote only** (D4) | QS creates `remote_sessions` rows; two kinds double-count. |

**On #4 (overruling Codex).** Codex argues decisions are "private per-user workflow state" and cites `user_notifications` as precedent for an AND-ed policy. The analogy does not hold: a notification is addressed to one person; a dismissal is a "not now" on a `remote_sessions` row that every partner admin can already read under org-axis RLS. Under the AND-ed policy, an admin reviewing a technician's timesheet (`GET /timesheet?userId=` with `manageAll` [verified `timeEntries.ts:174-181`]) would see dismissed sessions as *unlogged* — the opposite of the truth — unless the route drops into a system DB context, which the repo treats as a smell in request paths (`CLAUDE.md` "bare pool is forbidden in request code"; `withSystemDbAccessContext` is for background/seeds). Shape 3 keeps admin review truthful with the same app-layer own-rows filter `time_entries` already relies on [verified (codex) `timeEntryService.ts:606`], keeps the axis consistent with the sibling table, and gets partner erasure from the dynamic `partner_id` sweep [verified `tenantCascade.ts:888-932`]. Defence-in-depth for a technician's own rows is preserved by the `UNIQUE (user_id, …)` index plus the confirm/dismiss routes always writing `user_id = actor`. If a per-user privacy requirement ever appears, tightening the policy is a one-migration change; loosening an AND-ed policy later would need every reader audited.

## Data model

### Migration `apps/api/migrations/2026-09-23-time-entry-source-and-suggestion-decisions.sql`

Idempotent, no inner `BEGIN`/`COMMIT`, never edited after shipping.

```sql
-- 1) time_entries provenance (column shared with the location spec; W06 owns it)
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS source varchar(24) NOT NULL DEFAULT 'manual';
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_source_chk;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_chk
  CHECK (source IN ('manual','timer','location','remote_session','support_session'));

-- 2) signal read index (remote_sessions only carries idx_remote_sessions_pending_created today [inferred from schema file; confirm with \d in plan])
CREATE INDEX IF NOT EXISTS remote_sessions_user_ended_idx
  ON remote_sessions (user_id, ended_at) WHERE ended_at IS NOT NULL;

-- 3) decisions ledger — Shape 3 partner-axis; deliberately NO org_id / device_id
CREATE TABLE IF NOT EXISTS time_suggestion_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_kind    varchar(24) NOT NULL,
  signal_id      uuid NOT NULL,                       -- no FK: signal/device rows may be purged
  decision       varchar(16) NOT NULL,
  time_entry_id  uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_suggestion_decisions_kind_chk     CHECK (signal_kind IN ('remote_session')),
  CONSTRAINT time_suggestion_decisions_decision_chk CHECK (decision IN ('confirmed','dismissed')),
  CONSTRAINT time_suggestion_decisions_entry_chk    CHECK (decision = 'confirmed' OR time_entry_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS time_suggestion_decisions_user_signal_uq
  ON time_suggestion_decisions (user_id, signal_kind, signal_id);
CREATE INDEX IF NOT EXISTS time_suggestion_decisions_partner_idx ON time_suggestion_decisions (partner_id);
CREATE INDEX IF NOT EXISTS time_suggestion_decisions_entry_idx   ON time_suggestion_decisions (time_entry_id) WHERE time_entry_id IS NOT NULL;

ALTER TABLE time_suggestion_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_suggestion_decisions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                 AND tablename='time_suggestion_decisions'
                 AND policyname='time_suggestion_decisions_partner_access') THEN
    CREATE POLICY time_suggestion_decisions_partner_access ON time_suggestion_decisions
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
```

Notes:
- `signal_id` has no FK on purpose: an FK to `remote_sessions` would block device/org cascades (or force yet another cascade registration) and QS devices are purged routinely. Orphan decision rows are inert and are removed with the user or partner.
- `partner_id ON DELETE CASCADE` is belt-and-braces; the partner erasure path deletes via the dynamic sweep first.
- Plain `CREATE INDEX` (not `CONCURRENTLY` — impossible inside autoMigrate's transaction). Brief lock on very large self-hosted `remote_sessions`; note in release notes.

### Drizzle

- `apps/api/src/db/schema/timeTracking.ts`: `source: varchar('source', { length: 24 }).notNull().default('manual')`; new `timeSuggestionDecisions` table in the same file; export from `schema/index.ts`.
- `apps/api/src/db/schema/remote.ts`: add the partial index to the table config so `pnpm db:check-drift` stays clean.
- `packages/shared/src/validators/timeEntries.ts`: `TIME_ENTRY_SOURCES` const + `timeEntrySourceSchema` (read-side type only; not accepted on any create/update schema in W06).

### Registration lists (CLAUDE.md contract)

| Item | List | Bucket / entry | CI job |
|---|---|---|---|
| `time_entries.source` | `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:354` [verified]) | `included` (plain text, no open container) | Integration Tests (`tenant-export-policy`, `tenantExportErasureRoundtrip`) |
| `time_suggestion_decisions` | `rls-coverage.integration.test.ts` partner pair list (next to `['time_entries','partner_id']` at :193 [verified]) | `['time_suggestion_decisions','partner_id']` | Integration Tests |
| `time_suggestion_decisions` | any org-axis exclusion list the RLS suite keeps for partner-only tables [not-checked — mvp-first cites `ORG_AXIS_POLICY_EXCLUDED_TABLES` at :126; confirm during plan] | table name | Integration Tests |
| `time_suggestion_decisions` | `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `AUDIT_ADMIN_REQUIRED_TABLES` | **none** — no `org_id`, no `device_id`, not append-only | — |
| `remote_sessions` index | — | none | `db:check-drift` |
| `USER_ID_SCOPED_TABLES` | — | **not** registered: policy is partner-only (D3) | — |

Erasure paths: partner → dynamic `partner_id` sweep [verified `tenantCascade.ts:888-932`]; user → `users` FK CASCADE; entry → `time_entry_id` SET NULL (row kept as tombstone); org → nothing (inert orphans, no FK).

Per-column export classification for the new table is **not required** (no `org_id`), but for the record every column is plain text/uuid/timestamp — nothing would be `excludedOpen`.

### Partner setting (jsonb, no migration)

`partners.settings.timeTracking.sessionSuggestions = { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }` — sibling of the location spec's `timeTracking.locationSuggestions`; read via `asRecord(partner.settings)` (`effectiveSettings.ts` pattern [verified by two attempts, not re-read here]). Partner-wide only; surfaced under web **Settings → Ticketing → Time Tracking** — a new partner-only tab in `TicketingSettingsTabs.tsx` beside `statuses / priorities / categories / export` [verified :27-40]. (Earlier drafts wrote this as "Settings → Time Tracking"; same tab.) Not a config *table*, so Partner-Wide-First adds nothing further.

## API

Mounted on the existing `/api/v1/time-entries` router; literal paths registered before `/:id`. Same gates as every time-entry route: `requireScope('partner','system')` + `TIME_ENTRIES_READ` / `TIME_ENTRIES_WRITE` [verified `timeEntries.ts:20-26`]. Org-scoped tokens get the same 403 the rest of the router gives.

| Route | Perm | Body / query (zod in `packages/shared/src/validators/timeEntries.ts`) | Response |
|---|---|---|---|
| `GET /suggestions` | read | `{ date: YYYY-MM-DD, tz?: IANA (Intl-validated → 400 INVALID_TZ), userId?: uuid }`; `userId ≠ actor` requires `manageAll` (as `/timesheet`); date older than 31 days → 400 | `{ enabled, date, timezone, suggestions: TimeSuggestion[], unloggedCount }`; flag off → 200 `{ enabled:false, suggestions:[] }` |
| `POST /suggestions/confirm` | write | `{ signals: [{kind:'remote_session', id}] (1..20), ticketId?: uuid\|null, startedAt: iso, endedAt: iso, description?, isBillable?, hourlyRate? }.strict()` — never `source`, `orgId`, `currency` | 201 `{ entry }`; 200 `{ entry, replay:true }` when every signal is already confirmed to the same entry |
| `POST /suggestions/dismiss` | write | `{ signals }` | 204, idempotent |
| `DELETE /suggestions/dismiss` | write | `{ signals }` | 204 — removes the actor's `dismissed` rows **and** `confirmed` rows whose `time_entry_id IS NULL` (explicit "re-suggest after I deleted the entry") |

```ts
type TimeSuggestion = {
  key: string;                              // sorted member signal ids joined by '+'
  signals: Array<{ kind:'remote_session'; id:string; type:'terminal'|'desktop'|'file_transfer';
                   startedAt:string; endedAt:string; precision:'recorded'|'derived'|'unreliable' }>;
  startedAt: string; endedAt: string | null;   // null when any member is 'unreliable'
  durationMinutes: number | null;
  device: { id:string; hostname:string } | null; // null when QS device purged
  org: { id:string; name:string } | null;        // null for hidden QS org
  quickSupport: { attributionLabel:string|null; attributedOrgName:string|null } | null;
  candidateTicket: { id; ticketNumber; subject; status; reason:'closed_by_you'|'assigned_to_you' } | null;
  otherTickets: Array<{ id; ticketNumber; subject }>;   // <= 3
  suggestedSource: 'remote_session' | 'support_session';
};
```

Error codes (extend `TimeEntryServiceErrorCode`): `SUGGESTIONS_DISABLED` 403, `SIGNAL_NOT_FOUND` 404, `SIGNAL_NOT_ENDED` 409, `SUGGESTION_DISMISSED` 409, `SUGGESTION_ENTRY_DELETED` 410, `ORG_MISMATCH` 422 (signals span orgs, or ticket org ≠ session org for non-QS), `ENDED_AT_REQUIRED` 400 (unreliable member without explicit `endedAt`), `RANGE_OUTSIDE_SIGNAL` 400 (edits beyond ±15 min of the signal envelope). Existing `TICKET_WRONG_PARTNER`, `TICKET_NOT_FOUND`, rate/currency errors unchanged.

`GET /` and `GET /timesheet` expose `source` read-only. No route returns currency or a computed rate; `hourlyRate` follows the existing match-or-skip rule.

## Backend flow — `apps/api/src/services/timeSuggestionService.ts`

**list(actor, date, tz?)**
1. Gate: `auth.scope === 'partner'` (system allowed for tests/W07) and partner flag on; else `{enabled:false}`.
2. Day window: local midnight→midnight of `date` in `tz ?? partners.timezone` → UTC `[start,end)`. `remote_sessions.*_at` are `timestamp` (no tz) written from JS `Date` [verified `remote.ts:19-20`, `sessions.ts:1215`] — treated as UTC wall-clock; the integration test asserts the round-trip.
3. Signal query in the **request DB context** (RLS-backed; hidden QS org visible per `auth.ts:347-369` [verified]) with the app-layer tenancy backstop `rs.user_id = :actor AND o.partner_id = :partner`:
   ```sql
   FROM remote_sessions rs
   JOIN organizations o  ON o.id = rs.org_id AND o.partner_id = :partnerId
   LEFT JOIN devices d   ON d.id = rs.device_id
   LEFT JOIN LATERAL (SELECT attributed_org_id, attribution_label FROM support_sessions ss
                      WHERE o.type='quick_support' AND ss.device_id = rs.device_id
                      ORDER BY ss.created_at DESC LIMIT 1) qs ON true
   LEFT JOIN organizations ao ON ao.id = qs.attributed_org_id
   WHERE rs.user_id = :userId
     AND rs.started_at IS NOT NULL AND rs.ended_at IS NOT NULL
     AND rs.ended_at >= :start AND rs.ended_at < :end
     AND rs.status IN ('disconnected','failed')
     AND NOT EXISTS (SELECT 1 FROM time_suggestion_decisions x
                     WHERE x.user_id = :userId AND x.signal_kind='remote_session' AND x.signal_id = rs.id)
   ORDER BY rs.started_at
   ```
   `accessibleOrgIds` narrowing is applied exactly as `listTimeEntries` does, so a `selected`-access user never sees sessions on orgs they lost access to (they vanish — correct).
4. Duration and precision: `duration_seconds` present → `recorded`; else `ended_at − started_at` → `derived`; `error_message LIKE 'Session timed out%'` [verified `jobs/staleCommandReaper.ts:837,853`] or derived > 8 h → `unreliable` (no duration shown; confirm requires explicit `endedAt`). Drop < `minSessionSeconds`.
5. Merge: consecutive sessions, same user + device, gap ≤ `mergeGapMinutes` → one suggestion; `signals[]` lists members; key = sorted ids.
6. Ticket pairing (editable, never auto-committed): candidates = `tickets` with `device_id = rs.device_id`, `partner_id = :partnerId`, `deleted_at IS NULL`, within the partner-tz day. Rank (a) `closed_by = actor` or a `ticket_comments` `status_change` by the actor to resolved/closed within `[started_at − 2h, ended_at + 4h]` → `closed_by_you`; (b) open ticket `assigned_to = actor` → `assigned_to_you`. Exactly one top candidate is preselected; if two tie at rank (a), none is preselected (ambiguity is never guessed) and all appear in `otherTickets`. QS sessions: candidates restricted to `attributed_org_id` when set, else none.
7. `unloggedCount` = number of suggestions after filtering.

**confirm(actor, body)** — one transaction:
1. Flag on, else 403. Re-read each signal with the same query restricted to the ids; any missing → 404 `SIGNAL_NOT_FOUND`; `ended_at NULL` → 409.
2. All signals must share one org → else 422. Existing decisions: all `confirmed` with one non-null `time_entry_id` → 200 replay; any `confirmed` with `time_entry_id NULL` → 410; any `dismissed` → 409 (UI offers un-dismiss).
3. Validate `startedAt`/`endedAt` within ±15 min of the merged envelope (unreliable member: `endedAt` mandatory, upper bound = `started_at + 8h`).
4. Resolve org/currency: `ticketId` → existing `resolveAndLockTicketLink` [verified `timeEntryService.ts:259-284`]; ticket org must equal session org for non-QS sessions → else 422. No ticket, non-QS → new `resolveAndLockOrgLink(orgId, actor)` (org `FOR SHARE` + `readOrgStampingDefaults`; reusable by the location wave's `/start {orgId}`). QS org, no ticket → `org_id NULL`, `source='support_session'`, description prefixed with the attribution label.
5. `createTimeEntry(input, actor, { provenance: { source, orgLink? } })` — internal argument, absent from public zod; insert is closed (`ended_at` set), so the one-running-timer index [verified `2026-06-12-a…sql:48-49`] is untouched.
6. Insert one `confirmed` decision per member signal with `time_entry_id`. Unique violation = concurrent replay → re-select the winner, return 200.
7. Audit `time_entry.created` gains `payload.source`; ticket feed comment appends "(from remote session)"; existing `emitTimeEntryEvent` fires unchanged.

**dismiss / undismiss** — ownership re-validated via the signal query; `INSERT … ON CONFLICT DO NOTHING`; audit `time_suggestion.dismissed`. `DELETE` removes `dismissed` rows and `confirmed`-with-NULL-entry rows for the actor only.

**`/start` stamps `source='timer'`; `POST /` stamps `'manual'`** (one-line changes in `startTimer` / `createTimeEntry`).

**W07 hook (build now, do not dispatch):**
- `countUnloggedSuggestions(userId, partnerId, date, tz)` — same query as list, `COUNT(*)`; callable under system context with the explicit `partner_id` predicate; returns a number only.
- `buildTimeSuggestionPush({ count, date })` beside `buildApprovalPush` [verified `services/expoPush.ts:159`] → title "3 unlogged sessions today", `data: { type:'time_suggestions', date }`, `channelId:'timesheet'`, TTL 12 h, lock-screen safe (no device or ticket strings).
- Reserve `push_notifications.event_type = 'time_suggestions_daily'` and `user_notifications.dedupe_key = 'time.unlogged:<userId>:<date>'` (partial unique on `(user_id, dedupe_key)` [verified `schema/notifications.ts:64-66`]).
- Mobile: pure `parseTimeSuggestionsNotification` next to `parseApprovalNotification`; listener wiring, quiet hours, the 17:30-partner-local repeat job and the preference category are W07.

## Mobile flow

Prerequisites from W03–W05 (none exist on origin/main [verified by all three attempts]): `services/timeEntries.ts`, `services/timeEntryQueue.ts` (`QueuedWrite.kind` union), `store/timeSlice.ts`, `screens/time/TimesheetScreen.tsx`, the Timesheet stack.

- `apps/mobile/src/services/timeSuggestions.ts` (+test, `vi.mock('./api')`): `getSuggestions(date, tz)`, `confirmSuggestion`, `dismissSuggestion`, `undismissSuggestion` over `coreRequest`; `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- `apps/mobile/src/store/timeSuggestionsSlice.ts` (+test): `{ enabled, date, items, status, pendingKeys, lastFetchedAt }`; thunks `fetchSuggestions`, `dismiss` (optimistic remove + undo snackbar), `confirm` (removes item, dispatches the timeSlice entry-added action). Registered in `store/index.ts` combineReducers, so `withLogoutReset` wipes it.
- `apps/mobile/src/screens/time/TimeSuggestionsScreen.tsx`: date header (Today / Yesterday / picker ≤ 31 days); rows grouped by device: "38 min · desktop · ACME-DC01 · 14:02–14:40" + precision chip; ticket chip "TKT-1041 · closed by you" with *change* (picker: `otherTickets` + `getTickets` search; org name shown beside each ticket because a wrong pick changes org and currency); swipe-to-dismiss; tap → `SuggestionConfirmSheet` (start/end within ±15 min, ticket, billable, description; unreliable end forces an end time). Success: haptic + toast "Logged 38 min to TKT-1041". "Show dismissed" toggle → undo.
- Entry points: Timesheet header banner "3 unlogged sessions today →" and a Home `ColdOpenChip` "Log today's sessions (3)", both fetched on focus and hidden when `enabled=false` or count is 0. Route `TimeSuggestions: { date? }` on the W05 Timesheet stack (fallback `TicketsStackParamList`).
- Offline: the list is read-online-only (last response shown greyed with "as of 14:02"). Confirm and dismiss are **queued** through the W03 queue as new kinds `'suggestion.confirm' | 'suggestion.dismiss'` keyed by the signal key; rows show a pending spinner. Drain outcomes: 201/200 → success; 409 → drop + refetch; 404 → drop + toast; 410 → drop + toast "entry was deleted"; 403 → drop + hide entry points; 5xx/network → keep and retry (existing queue semantics).
- Analytics via `lib/analytics.ts`: `time_suggestion_shown | confirmed | dismissed | entry_point`.
- Web parity (in scope, minimal): `source` badge on `TimesheetPage.tsx` / `TicketTimeBilling.tsx`; the Settings → Ticketing → Time Tracking toggle. No web suggestions panel (follow-up issue; the endpoints are web-ready).

## Failure modes

| # | Case | Behaviour |
|---|---|---|
| F1 | Cross-tenant leak in the signal query | Impossible by construction: request RLS context + `user_id = actor` + `o.partner_id = :partner` + `accessibleOrgIds`; a filter bug can only over-restrict. |
| F2 | Forged provenance / foreign session id | `source` accepted from no client; confirm re-reads signals under RLS → 404. |
| F3 | Wrong org or currency | Ticket chip editable and shows org; non-QS ticket org must equal session org (422); org link resolved under `FOR SHARE` so `time_entries_currency_required_when_org_chk` holds. |
| F4 | Offline replay / double tap | Ledger unique index; replay → 200 same entry. |
| F5 | Re-suggestion after deleting the confirmed entry | Tombstone row keeps it hidden; explicit `DELETE /suggestions/dismiss` re-surfaces it; replaying the old confirm → 410. |
| F6 | Erasure | Partner sweep, users CASCADE, entry SET NULL; no org registrations needed (no `org_id`). |
| F7 | Reaper-ended zombies (`ended_at` written up to 24 h late) | `unreliable`, no duration, end time mandatory; never suggested as a 24 h entry. |
| F8 | `duration_seconds` NULL on some writers | COALESCE to `ended_at − started_at`, chip says `derived`. |
| F9 | Day boundary / DST / invalid tz | Partner tz default; IANA override validated; bucket by `ended_at`. |
| F10 | Flag off | `{enabled:false}`; mutations 403; entry points hidden. |
| F11 | Active / pending / denied session | Excluded (`ended_at NULL` or status not in `disconnected,failed`). |
| F12 | QS device purged | `device:null`, attribution label shown, no ticket pairing. |
| F13 | Ticket deleted before confirm | Existing `TICKET_NOT_FOUND`; sheet clears the ticket. |
| F14 | Two tickets closed on one device | No preselection; both listed. |
| F15 | Running timer exists | Unaffected — confirm writes a closed entry. |
| F16 | Push spam | W06 dispatches nothing; W07 dedupes on `dedupe_key`. |
| F17 | Large fleet / self-host index build | Partial index bounded to one user/day; plain `CREATE INDEX` lock noted in release notes. |
| F18 | Org-scoped mobile token (W02 outcome [not-checked]) | Same 403 as the whole `/time-entries` router. |

### Salvaged from alternate designs

Two items that survived the per-attempt drafts and are **not** covered by D1–D9 above. Both are binding on the plan.

- **F19 — the technician already logged the session by hand or with the timer.** Nothing in the list query above looks at existing `time_entries`, so a session logged manually (or via `/start`+`/stop`, which produces no decision row) is still offered as a suggestion — a duplicate billable entry one tap away. Add a third exclusion beside the `NOT EXISTS (decision)` clause: compute the overlap between the merged suggestion window and the actor's existing `time_entries` for that day (`user_id = :actor`, ranges intersect) and **drop the suggestion when the overlap is ≥ 80 % of its duration**. Report the residual overlap on the row (`alreadyLoggedOverlapMinutes`) so a partial overlap is visible in the confirm sheet rather than silently doubled. Table-drive the threshold in `timeSuggestionRules.test.ts` (0 %, 50 %, 79 %, 80 %, 100 %). *(from the traced-design attempt; the risk-first and mvp-first attempts and this synthesis all missed it.)* **Resolved in the plan (2026-08-30):** rules `mergeRanges` / `overlapMs` / `alreadyLoggedVerdict` + `ALREADY_LOGGED_DROP_RATIO` in Task 5 Steps 3b–3c; the `loadLoggedRanges` query and the shared `dropAlreadyLogged` filter (applied to **both** `listTimeSuggestions` and `countUnloggedSuggestions`, so a push count can never exceed what the screen shows) in Task 7; `alreadyLoggedOverlapMinutes` on `TimeSuggestion`; a real-Postgres case in Task 10. A running timer counts as `[started_at, now)` clamped to the day window. Confirm deliberately does **not** re-check the overlap — the technician saw the residual and chose to log.
- **Evidence upgrade for D9.** D9 says the agent-side and reaper end paths do not write `duration_seconds` "[inferred from grep]". The traced attempt cites the agent path at `apps/api/src/routes/agentWs.ts:2248-2250` writing `ended_at` only [verified (alternate draft) — re-read at implementation time]. Keep the COALESCE either way; the citation is what the plan's `precision` matrix test should be anchored on.

## Testing

**Unit (Test API job)**
- `services/timeSuggestionService.test.ts`: day window incl. DST edge, COALESCE/precision matrix, merge grouping, ticket ranking (table-driven, ambiguity → none), confirm branches (201 / 200 replay / 409 dismissed / 410 deleted / 422 org mismatch / 400 range), QS → `org NULL` + `support_session`; assert **compiled SQL** contains the `user_id`, `partner_id` and `NOT EXISTS` predicates (vacuous-Drizzle-assertion trap).
- `routes/timeEntries/suggestions.test.ts`: scope/perm gates, `manageAll` for `userId`, 31-day bound, `.strict()` rejects `source`/`orgId`/`currency`, literal-before-`/:id` ordering.
- `timeEntryService.test.ts`: `/start` stamps `timer`, `POST /` stamps `manual`, provenance argument stamps `remote_session`.
- `packages/shared` validator tests; `expoPush.test.ts` (`buildTimeSuggestionPush` payload has no device/ticket strings, `buildApprovalPush` byte-identical); `autoMigrate.test.ts` naming/order; `pnpm db:check-drift`.
- Mobile (Vitest, `vi.mock('./api')`): service client, slice reducers/thunks (optimistic dismiss + undo), queue drain outcomes for the two new kinds, `parseTimeSuggestionsNotification`, screen states (enabled / disabled / offline / unreliable).

**Contract suites (real DB; Integration Tests job — run explicitly, `pnpm test` does not)**
- `rls-coverage` red before the pair-list entry; `tenant-export-policy` + `tenantExportErasureRoundtrip` red until `source` is classified; `tenantCascade` / `cascadeDelete` / `moveOrg.coverage` must stay green unchanged.
- New `__tests__/integration/timeSuggestionDecisionsRls.integration.test.ts`: cross-partner forge → 42501; partner B cannot list A's sessions even with A's user id; `selected`-access narrowing; hidden QS org readable under partner request context; concurrent confirm → one ledger row; partner sweep and user cascade delete decisions; entry delete → SET NULL; `time_entries_source_chk` rejects bad values.

**Manual device checks**
- `psql -U breeze_app` forge a cross-partner insert into `time_suggestion_decisions` → must fail with the RLS policy error.
- On a TestFlight build with the flag on: run a terminal and a desktop session, close a ticket on that device, open Timesheet → banner count; confirm one, dismiss one, kill the app offline, confirm another, reconnect → exactly one entry per confirm; delete an entry on web → session stays hidden until "Show dismissed → restore".

## Open product questions

Each carries the default the implementation will assume unless overridden.

1. **Merge adjacent same-device sessions?** Default: yes, gap ≤ 10 min (`mergeGapMinutes` partner setting); one decision row per member.
2. **Minimum session length?** Default: 120 s (`minSessionSeconds`); `file_transfer` sessions included.
3. **Partner-wide flag only, or per-technician opt-out?** Default: partner-wide only (`partners.settings.timeTracking.sessionSuggestions.enabled`, off); the sheet is pull-based, so "not opening it" is the opt-out; push opt-out is W07's preference category.
4. **Quick Support attribution on the entry?** Default: `org_id NULL` + `source='support_session'` + label in description; ticket pick sets the org normally. Revisit once `attributed_org_id` is populated reliably.
5. **Ticket-pairing window and candidate count?** Default: same partner-tz day, closed/resolved-by-you within `[start − 2h, end + 4h]` first, then assigned-to-you open; top-1 preselected only when unambiguous; ≤ 3 alternates + search.
6. **Reaper-ended sessions?** Default: shown as `unreliable`, end time mandatory, never hidden.
7. **Undo dismiss?** Default: ship ("Show dismissed" toggle backed by `DELETE /suggestions/dismiss`).
8. **Web parity in W06?** Default: `source` badge + settings toggle only; web suggestions panel is a follow-up issue.
9. **Offline confirm/dismiss?** Default: queued through the W03 queue with the drain-outcome table above.
10. **Nudge timing (W07)?** Default: once per user per day at 17:30 partner-local when count > 0, `dedupe_key time.unlogged:<userId>:<date>`, gated by the partner flag, quiet hours and a new preference category.
11. **Already-logged drop threshold (F19)?** Default: **80 %** of the suggestion window covered by the actor's existing `time_entries` (named constant `ALREADY_LOGGED_DROP_RATIO`), residual overlap reported on the row below that. A Codex read-only review (gpt-5.6-sol, high, 2026-08-30) recommended 90 % instead, so a manual entry covering only four-fifths of a session cannot hide a meaningful remainder; the counter-argument is that a suggestion whose window is 85 % already logged is almost always a duplicate, and the residual is visible either way. Shipping at 0.8 as one constant makes the reversal a one-line change.
12. **More signals later (`script_executions`, `device_commands`, ticket transitions)?** Default: no; `signal_kind` CHECK extended by a later migration if one proves useful; `device_commands` deferred indefinitely (system-scoped table).

## Quorum note

- **Attempts:** risk-first (Claude), mvp-first (Claude), codex-design (Codex-authored).
- **Claude judge:** risk-first 7.8 > mvp-first 7.5 > codex-design 6.8, with six grafts and seven listed disagreements — i.e. no single attempt was accepted as-is.
- **Codex tie-break (this synthesis, gpt-5.6-sol, high, read-only):** agreed with the chosen position on ledger-vs-`source_ref` (ledger), server-stamped `source`, and `remote_sessions` as the only signal (it located the QS connect path writing `remote_sessions` under the hidden org). Disagreed on one point: it recommended the AND-ed partner+user RLS policy for the ledger. That disagreement is resolved in **Tie-break analysis #4** in favour of partner-only Shape 3, on the grounds that admin timesheet review must see dismissals as dismissed without a system-context bypass, and that the sibling `time_entries` table already uses the same policy + app-layer ownership pattern.
- **Net:** the design below is risk-first's structure with mvp-first's migration date, `ended_at` bucketing and COALESCE duration, codex-design's explicit 410 replay branch and QS-org visibility citation, and a written tie-break where the advisors split.
