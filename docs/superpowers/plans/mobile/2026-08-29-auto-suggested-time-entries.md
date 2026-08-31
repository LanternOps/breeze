---
tracking_issue: LanternOps/breeze#3206
wave: W06
wave_issue: LanternOps/breeze#3900
spec: docs/superpowers/specs/mobile/2026-08-29-auto-suggested-time-entries-design.md
---

# Auto-Suggested Time Entries (W06) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the end of the day a technician sees "You ran a 38-minute desktop session on ACME-DC01 and closed TKT-1041 — log it?" and one tap creates an ordinary `time_entries` row with server-stamped provenance; nothing is written without the tap.

**Architecture:** Suggestions are computed at read time from `remote_sessions` rows the caller can already see under RLS (no suggestions table). The only new table is a partner-axis decisions ledger (`time_suggestion_decisions`) that records confirmed/dismissed per signal and is the offline-replay idempotency key. `time_entries.source` is a server-stamped provenance column shared with the location wave. Four routes on the existing `/api/v1/time-entries` router; W07 gets a count function and a push payload builder but no dispatch.

**Tech Stack:** Hono + Drizzle + hand-written SQL migration (API); Zod in `@breeze/shared`; Vitest unit + real-Postgres integration suites; React (web badge + settings toggle); React Native / Redux Toolkit (mobile, Vitest on pure `.ts` modules only).

**Spec:** `docs/superpowers/specs/mobile/2026-08-29-auto-suggested-time-entries-design.md` (D1–D9, API table, backend flow, mobile flow, failure modes F1–F18). The plan argues from the spec; read both.

Evidence labels: **[verified]** = read on origin/main in this worktree while writing the plan; **[inferred]**; **[not-checked]**.

## Global Constraints

- **Migration filename is `apps/api/migrations/2026-09-23-time-entry-source-and-suggestion-decisions.sql`** (spec D8). The shipped ledger ends at `2026-09-22-ai-alert-verdicts-live-unique.sql` and `2026-08-29-a-`/`-b-` already exist [verified `ls apps/api/migrations`]. If a later-dated migration lands on main before this PR merges, bump the date past it — never insert a same-day infix into a date you did not create.
- **Migration rules** (CLAUDE.md "Schema Migration Workflow"): idempotent (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + re-add, `pg_policies` existence check), no inner `BEGIN;`/`COMMIT;`, RLS `ENABLE` + `FORCE` + policy in the same file, never edited after shipping. `CREATE INDEX` is plain (no `CONCURRENTLY` inside autoMigrate's transaction).
- **`time_suggestion_decisions` is RLS Shape 3 partner-axis** (spec D3): one `FOR ALL` policy `system OR breeze_has_partner_access(partner_id)`, byte-for-byte the shape of `time_entries_partner_access` [verified `2026-06-12-a-ticketing-time-parts.sql:60-63`]. It has **no `org_id` and no `device_id`**, so it goes in `PARTNER_TENANT_TABLES` only — not `CORE_ORG_CASCADE_DELETE_ORDER`, not the device lists, not `CORE_TENANT_EXPORT_POLICY`, not `USER_ID_SCOPED_TABLES`.
- **`time_entries.source` is a new column on an org-cascade table → must be classified in `CORE_TENANT_EXPORT_POLICY`** (`included`, plain varchar). Until it is, `tenant-export-policy` and `tenantExportErasureRoundtrip` are red under Integration Tests only — `pnpm test` will not tell you.
- **`source` vocabulary is exactly** `('manual','timer','location','remote_session','support_session')`, `varchar(24) NOT NULL DEFAULT 'manual'`, enforced by CHECK `time_entries_source_chk` (spec D5). **No public zod schema accepts `source`** in this wave; `POST /` stamps `manual`, `POST /start` stamps `timer`, confirm stamps `remote_session` / `support_session`.
- **Suggest, never write** (owner principle 2026-08-28): no code path in this wave inserts a `time_entries` row without a `POST /suggestions/confirm` request. **No technician position data anywhere.**
- **Never suggest work the technician already logged (spec F19).** The decisions ledger only knows about suggestions the technician acted on; an entry typed by hand or produced by `/start`+`/stop` writes **no** ledger row, so without a second exclusion the same work is offered again with a duplicate billable row one tap away. Every list/count path therefore computes the overlap between a suggestion's merged window and the actor's **existing `time_entries` for that day** and drops the suggestion at `overlap ≥ ALREADY_LOGGED_DROP_RATIO` (0.8) of its duration; a residual overlap below the threshold is surfaced as `alreadyLoggedOverlapMinutes` on the row instead of being silently doubled. A running timer (`ended_at IS NULL`) counts as `[started_at, now)` clamped to the day window — never zero-length, never open-ended [design confirmed by Codex read-only review, gpt-5.6-sol high, 2026-08-30]. The threshold is a named constant with a table-driven test at 0 / 50 / 79 / 80 / 100 %.
- **`db:check-drift` does NOT diff Drizzle models against a live database** [verified `apps/api/scripts/check-drift.ts:16-27` — "Schema-vs-live-DB drift … is intentionally NOT checked here"; and the in-repo note at `apps/api/src/db/schema/notifications.ts:57-64`]. It replays the migration set onto a fresh database and asserts one `breeze_migrations` ledger row per file, so it catches ordering bugs, syntax errors and missing `IF NOT EXISTS` guards — **not** a Drizzle declaration you forgot. A Drizzle index/column declaration in this plan *documents* the object the SQL creates; the red-first proof that the object exists is a direct `information_schema` / `pg_policies` assertion (Task 1) and the RLS integration suite (Task 10).
- **Operator-visible surface must reach a self-hoster.** This wave adds a partner-visible setting, four public routes, a mobile screen and a plain `CREATE INDEX` that briefly locks `remote_sessions` (spec F17). A SQL comment is not a release note: Task 1 adds the migration bullet to `docs/release-notes/next-release-draft.md` in the migration commit, and Task 13 writes the feature documentation in `apps/docs/` and appends the feature bullet. Neither is optional — `/release` Step 1 reads that draft file and nothing else.
- **Partner flag defaults off:** `partners.settings.timeTracking.sessionSuggestions = { enabled:false, minSessionSeconds:120, mergeGapMinutes:10 }`. Flag off → `GET /suggestions` returns `200 { enabled:false, suggestions:[] }`; the three mutations return `403 SUGGESTIONS_DISABLED`.
- **All four routes** use the router's existing gates `requireScope('partner','system')` + `TIME_ENTRIES_READ`/`TIME_ENTRIES_WRITE` [verified `routes/timeEntries/timeEntries.ts:24-26`] and are registered **before** `/:id`.
- **Signal reads happen in the request DB context** (RLS-backed) with the app-layer backstop `rs.user_id = :actor AND o.partner_id = :partner` plus the `accessibleOrgIds` narrowing `listTimeEntries` uses. Never `withSystemDbAccessContext` on a request path for this feature; the only system-context caller is W07's `countUnloggedSuggestions`.
- **Confirm concurrency:** the request already runs inside the `withDbAccessContext` transaction, so a raised 23505 aborts the whole request (issue #2189, [verified comment `timeEntryService.ts:486-497`]). Confirm therefore takes `pg_advisory_xact_lock` per signal before reading decisions, and the ledger insert uses `onConflictDoNothing()` as a backstop. Never catch-and-retry a unique violation inside the request transaction.
- **Timestamps:** `remote_sessions.started_at/ended_at` are `timestamp` without tz written from JS `Date` [verified `schema/remote.ts:19-20`, `routes/remote/sessions.ts:1215`] — treat as UTC wall-clock. Every SQL comparison casts explicitly (`AT TIME ZONE 'UTC'`) so no session-`TimeZone` setting can shift the day window.
- **Web mutation handlers go through `runAction`** (`apps/web/src/lib/runAction.ts`) — the `no-silent-mutations` test guards it.
- **Web i18n:** every new key is added to `en/` **and all seven other locales** (`de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR` [verified `ls apps/web/src/locales`]) — `apps/web/src/lib/i18n/localeParity.test.ts` fails otherwise.
- **Mobile tests are `.ts` only** — `apps/mobile/vitest.config.ts` includes `src/**/*.test.ts` and deliberately excludes `.tsx` [verified]. Every piece of screen logic that needs a test lives in a pure `.ts` module next to the screen (the `screens/tickets/ticketCopy.ts` pattern).
- **Mobile prerequisites are NOT on main** [verified: `apps/mobile/src/services/` has no `timeEntries.ts`/`timeEntryQueue.ts`, no `store/timeSlice.ts`, no `screens/time/`]. Tasks 14–18 (PR B) require #3206 W03–W05 merged first; their `Consumes` blocks name the W03 plan's exported signatures. If a name differs on the merged branch, adapt to the merged code — never re-implement a W03 module here.
- **Rigor labels:** each task carries `Rigor: high` (migration / RLS / auth gates / money stamping / push payload) or `Rigor: low` (pure helpers, validators, copy, UI). High-rigor tasks get red-first TDD *and* the contract suites *and* one review round; low-rigor tasks are red-first + typecheck + affected tests, no ceremony.
- **Authoring:** "Codex-eligible" tasks are pure services, validators, tests, or a single endpoint that follows a named reference file — hand Codex the task text verbatim plus the CLAUDE.md contracts it cites. "Claude" tasks are RN screens, cross-module wiring, and the migration/registration set.

---

## PR split

| PR | Tasks | Base | Why |
|---|---|---|---|
| **PR A — backend + web parity + docs** | 1–13 | `main` | Migration, ledger, rules, service, four routes, the RLS/tenancy integration suite, push builder, web badge + settings tab, docs + release notes. No mobile dependency; ships value to web/API users alone and unblocks W07. |
| **PR B — mobile** | 14–18 | `main` **after** PR A *and* W03–W05 are merged | Needs `services/timeEntries.ts`, `timeEntryQueue.ts`, `store/timeSlice.ts`, the Timesheet stack. Do not stack it on PR A's branch: `ci.yml` triggers only on `pull_request: branches: [main]`, so a stacked PR runs no CI (CLAUDE.md tenancy section). |

Eighteen tasks, not sixteen: the first draft of this plan was truncated after Task 8 and its remaining-work list omitted both the new-table RLS proof (now Task 10) and the docs/release-notes pass (now Task 13). Tasks 1–8 keep their original numbers so no cross-reference in them goes stale.

Branch names (feature-lifecycle skill): `feature/3206-ticketing-on-mobile/wave-3900` for PR A; `feature/3206-ticketing-on-mobile/wave-3900-mobile` for PR B. Both PR bodies: `Part of #3900` (PR B closes it: `Closes #3900`).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-09-23-time-entry-source-and-suggestion-decisions.sql` (create) | `time_entries.source` + CHECK, `remote_sessions` partial index, `time_suggestion_decisions` table + RLS. |
| `apps/api/src/db/schema/timeTracking.ts` (modify) | `source` column on `timeEntries`; new `timeSuggestionDecisions` table. |
| `apps/api/src/db/schema/remote.ts` (modify) | Declares the partial index `remote_sessions_user_ended_idx` that the migration creates, so the model documents the database object. (This is **not** what keeps `db:check-drift` green — that script never diffs the model against a DB; see Global Constraints.) |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` (modify) | Classify `time_entries.source` as `included`. |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (modify) | `['time_suggestion_decisions','partner_id']` in `PARTNER_TENANT_TABLES`. |
| `apps/api/src/__tests__/integration/timeSuggestionDecisionsRls.integration.test.ts` (create — **Task 10**) | Cross-partner forge 42501, partner-B blindness, selected-access narrowing, hidden QS org readable, tombstone SET NULL, user/partner cascade, CHECK rejection, day-window round-trip, concurrent confirm. |
| `packages/shared/src/validators/timeEntries.ts` (modify) | `TIME_ENTRY_SOURCES`, `timeEntrySourceSchema`, `suggestionsQuerySchema`, `confirmSuggestionSchema`, `suggestionSignalsSchema`. |
| `apps/api/src/services/timeSuggestionSettings.ts` (create) | Read + default the partner `timeTracking.sessionSuggestions` block and partner timezone. |
| `apps/api/src/routes/orgs.ts` (modify) | Accept `settings.timeTracking` on `PATCH /partners/me`; deep-merge one level like `ticketing`. |
| `apps/api/src/services/timeSuggestionRules.ts` (create) | Pure, DB-free: day window in tz, precision/duration, merge, ticket ranking, confirm-range validation, suggestion key. |
| `apps/api/src/services/timeSuggestionService.ts` (create) | Signal query, list, count (W07), confirm, dismiss, undismiss. |
| `apps/api/src/services/timeEntryService.ts` (modify) | `source` stamps, internal `provenance` argument, `resolveAndLockOrgLink`, new error codes, `source` in `entrySelection()`. |
| `apps/api/src/services/timeEntryEvents.ts` (modify) | `time_entry.created` payload gains `source`. |
| `apps/api/src/routes/timeEntries/suggestions.ts` (create) | The four routes; mounted from `timeEntries.ts` before `/:id`. |
| `apps/api/src/services/expoPush.ts` (modify) | `buildTimeSuggestionPush` + reserved event/dedupe constants (W07 hook). |
| `apps/web/src/components/time/TimesheetPage.tsx`, `apps/web/src/components/tickets/TicketTimeBilling.tsx` (modify) | Read-only `source` badge. |
| `apps/web/src/components/settings/TimeTrackingSettingsCard.tsx` (create), `TicketingSettingsTabs.tsx` (modify) | Partner toggle + thresholds under **Settings → Ticketing → Time Tracking** (a new partner-only tab beside `statuses / priorities / categories / export` [verified `TicketingSettingsTabs.tsx:27-40`]). This is the single canonical location; the spec's shorter "Settings → Time Tracking" phrasing means the same tab. |
| `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`, `.../tickets.json` (modify) | Every new key in all 8 locale dirs [verified `ls apps/web/src/locales`] — `localeParity.test.ts` fails on any gap. |
| `apps/docs/src/content/docs/features/ticketing.mdx` (modify — **Task 13**) | Document the suggestions flow under "Time Tracking & Parts" (§ starts :262) and the new settings tab. |
| `docs/release-notes/next-release-draft.md` (modify — Tasks 1 and 13) | Migration index-lock note (spec F17) + the partner setting / routes / mobile screen bullet. `/release` Step 1 reads only this file. |
| `apps/mobile/src/navigation/MainNavigator.tsx` (modify — **Task 17**) | Mount `TimeSuggestions` on the W05 Timesheet stack; fall back to `TicketsStackParamList` [verified :22-25] if W05 shipped no separate stack. |
| `apps/mobile/src/services/timeSuggestions.ts` (create) | Typed client for the four routes. |
| `apps/mobile/src/services/timeEntryQueue.ts` (modify, W03 file) | Two new queued kinds. |
| `apps/mobile/src/store/timeSuggestionsSlice.ts` (create) | List state, optimistic dismiss/undo, confirm, pending keys. |
| `apps/mobile/src/screens/time/timeSuggestionCopy.ts` (create) | Pure row/chip/toast copy + replay outcome classifier (testable). |
| `apps/mobile/src/screens/time/TimeSuggestionsScreen.tsx`, `SuggestionConfirmSheet.tsx` (create) | The list and the confirm sheet. |
| `apps/mobile/src/services/notifications.ts` (modify) | `parseTimeSuggestionsNotification`. |

---

## PR A — backend + web parity + docs (Tasks 1–13)

### Task 1: Migration + Drizzle schema (`source`, index, decisions ledger)

**Rigor: high** (migration + RLS). **Author: Claude** (Codex may execute the SQL block verbatim once handed this task, but the Drizzle + drift + doc steps are cross-module).

**Files:**
- Create: `apps/api/migrations/2026-09-23-time-entry-source-and-suggestion-decisions.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts` (add `source` to `timeEntries`, add `timeSuggestionDecisions`)
- Modify: `apps/api/src/db/schema/remote.ts:9-26` (add table config with the partial index)
- Modify: `docs/superpowers/specs/mobile/2026-08-28-location-time-suggestions-design.md` §2.2 (one-line reconciliation, spec D5)
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing — naming/order guard), `pnpm db:check-drift`

**Interfaces:**
- Produces: Drizzle exports `timeEntries.source` (varchar 24, notNull, default `'manual'`) and `timeSuggestionDecisions` with columns `id, partnerId, userId, signalKind, signalId, decision, timeEntryId, createdAt`. Every later task imports these from `../db/schema`.

- [ ] **Step 1: Write the failing schema assertion and watch it fail**

`db:check-drift` will **not** go red for a missing column — it replays migrations onto a fresh DB and checks the `breeze_migrations` ledger, and explicitly does not diff models against a live database [verified `apps/api/scripts/check-drift.ts:16-27`]. The red-first proof here is a direct catalogue query. Save it as `/tmp/w06-schema-assert.sql` and run it against the already-migrated dev DB:

```sql
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='time_entries' AND column_name='source')                       AS have_source,
  (SELECT count(*) FROM pg_constraint  WHERE conname='time_entries_source_chk')      AS have_source_chk,
  (SELECT count(*) FROM pg_class       WHERE relname='remote_sessions_user_ended_idx') AS have_signal_idx,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_name='time_suggestion_decisions')                                   AS have_ledger,
  (SELECT count(*) FROM pg_policies
     WHERE tablename='time_suggestion_decisions'
       AND policyname='time_suggestion_decisions_partner_access')                    AS have_policy,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relname='time_suggestion_decisions' AND c.relrowsecurity AND c.relforcerowsecurity) AS rls_forced;
```

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
docker exec -i breeze-postgres psql -U breeze -d breeze -f - < /tmp/w06-schema-assert.sql
```

Expected: every column returns `0`. Keep the file — Step 4 re-runs it and every column must return `1`.

- [ ] **Step 2: Declare the objects in Drizzle**

These declarations *document* what the migration creates (`drizzle-kit generate/push` are not used in this repo) and are what every later task imports. They do not create anything and do not make any check go green on their own.

In `apps/api/src/db/schema/timeTracking.ts`, inside the `timeEntries` column list after `billingStatus`:

```ts
  // W06 (#3900) provenance. Server-stamped only — no public zod schema accepts it.
  // Values enforced by CHECK time_entries_source_chk in SQL:
  // 'manual' | 'timer' | 'location' | 'remote_session' | 'support_session'.
  source: varchar('source', { length: 24 }).notNull().default('manual'),
```

Append to the same file:

```ts
// W06 (#3900) decisions ledger — RLS Shape 3 partner-axis, same policy shape
// as time_entries. Deliberately NO org_id / device_id: signal rows may be
// purged (Quick Support devices routinely are), so signal_id has no FK and
// the row is an inert orphan until the user or partner is erased.
// time_entry_id is ON DELETE SET NULL so a confirmed decision survives the
// hard delete of its entry as a tombstone (replay -> 410, never re-suggested).
export const timeSuggestionDecisions = pgTable('time_suggestion_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  signalKind: varchar('signal_kind', { length: 24 }).notNull(),
  signalId: uuid('signal_id').notNull(),
  decision: varchar('decision', { length: 16 }).notNull(),
  timeEntryId: uuid('time_entry_id').references(() => timeEntries.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('time_suggestion_decisions_user_signal_uq').on(t.userId, t.signalKind, t.signalId),
  index('time_suggestion_decisions_partner_idx').on(t.partnerId),
  index('time_suggestion_decisions_entry_idx').on(t.timeEntryId).where(sql`${t.timeEntryId} IS NOT NULL`)
]);
```

In `apps/api/src/db/schema/remote.ts` add `index` to the `drizzle-orm/pg-core` import and `sql` from `drizzle-orm`, then replace the closing `});` of `remoteSessions` with:

```ts
}, (t) => [
  // W06 (#3900): one user's ended sessions for a day window; partial so the
  // long tail of never-ended rows costs nothing. DOCUMENTS the index created by
  // migration 2026-09-23-time-entry-source-and-suggestion-decisions.sql — this
  // declaration does not create it (same situation as the note on
  // notifications.ts:57-64).
  index('remote_sessions_user_ended_idx').on(t.userId, t.endedAt).where(sql`${t.endedAt} IS NOT NULL`)
]);
```

Typecheck only at this point:

```bash
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
```

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-09-23-time-entry-source-and-suggestion-decisions.sql`:

```sql
-- W06 (#3900): time-entry provenance + auto-suggestion decisions ledger.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1) time_entries provenance. Column is shared with the location-suggestions
--    spec (2026-08-28 §2.2); W06 owns its creation. Server-stamped only.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS source varchar(24) NOT NULL DEFAULT 'manual';
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_source_chk;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_chk
  CHECK (source IN ('manual','timer','location','remote_session','support_session'));

-- 2) Signal read index: one user's ended sessions inside a day window.
--    Plain CREATE INDEX (CONCURRENTLY is impossible inside the migration
--    transaction) — brief lock on very large self-hosted remote_sessions.
CREATE INDEX IF NOT EXISTS remote_sessions_user_ended_idx
  ON remote_sessions (user_id, ended_at) WHERE ended_at IS NOT NULL;

-- 3) Decisions ledger — RLS Shape 3 (partner-axis). Deliberately NO org_id and
--    NO device_id, so it is registered in PARTNER_TENANT_TABLES only.
--    signal_id has no FK: signal/device rows may be purged; orphan decisions are
--    inert and leave with the user (CASCADE) or the partner (sweep + CASCADE).
CREATE TABLE IF NOT EXISTS time_suggestion_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_kind    varchar(24) NOT NULL,
  signal_id      uuid NOT NULL,
  decision       varchar(16) NOT NULL,
  time_entry_id  uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_suggestion_decisions_kind_chk     CHECK (signal_kind IN ('remote_session')),
  CONSTRAINT time_suggestion_decisions_decision_chk CHECK (decision IN ('confirmed','dismissed')),
  CONSTRAINT time_suggestion_decisions_entry_chk    CHECK (decision = 'confirmed' OR time_entry_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS time_suggestion_decisions_user_signal_uq
  ON time_suggestion_decisions (user_id, signal_kind, signal_id);
CREATE INDEX IF NOT EXISTS time_suggestion_decisions_partner_idx
  ON time_suggestion_decisions (partner_id);
CREATE INDEX IF NOT EXISTS time_suggestion_decisions_entry_idx
  ON time_suggestion_decisions (time_entry_id) WHERE time_entry_id IS NOT NULL;

ALTER TABLE time_suggestion_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_suggestion_decisions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'time_suggestion_decisions'
      AND policyname = 'time_suggestion_decisions_partner_access'
  ) THEN
    CREATE POLICY time_suggestion_decisions_partner_access ON time_suggestion_decisions
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
```

- [ ] **Step 4: Apply twice, turn the Step-1 assertion green, then verify replay and naming**

```bash
pnpm --filter @breeze/api db:migrate
pnpm --filter @breeze/api db:migrate      # second run must be a no-op (idempotency)
docker exec -i breeze-postgres psql -U breeze -d breeze -f - < /tmp/w06-schema-assert.sql
pnpm --filter @breeze/api test -- --run src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
pnpm db:check-drift    # fresh-DB replay + one ledger row per file — ordering/idempotency, not model diff
```

Expected: both migrate runs succeed (the second logs nothing new); **every column of the Step-1 assertion now returns `1`**; `autoMigrate.test.ts` passes; naming check passes; `db:check-drift` replays the whole set onto a fresh database with a complete ledger.

- [ ] **Step 5: Forge a cross-tenant insert as `breeze_app` (CLAUDE.md step 6)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "
SELECT set_config('app.scope','partner',false), set_config('app.partner_ids','00000000-0000-0000-0000-000000000001',false);
INSERT INTO time_suggestion_decisions (partner_id,user_id,signal_kind,signal_id,decision)
SELECT p.id, u.id, 'remote_session', gen_random_uuid(), 'dismissed'
FROM partners p JOIN users u ON u.partner_id = p.id
WHERE p.id <> '00000000-0000-0000-0000-000000000001' LIMIT 1;"
```

Expected: `ERROR:  new row violates row-level security policy for table "time_suggestion_decisions"`. (If the GUC names differ on your checkout, read `apps/api/src/db/index.ts` `withDbAccessContext` for the exact `set_config` keys — the assertion is the RLS error, not the GUC names.)

- [ ] **Step 6: Reconcile the location spec (spec D5)**

In `docs/superpowers/specs/mobile/2026-08-28-location-time-suggestions-design.md` §2.2, directly under the `source` code block, add:

```markdown
- **Reconciliation (2026-08-29):** #3206 W06 (#3900) creates this column in migration `2026-09-23-time-entry-source-and-suggestion-decisions.sql` and adds a fifth value `support_session` (a confirmed Quick Support entry with `org_id NULL`). Values are otherwise unchanged; this wave reuses the column.
```

- [ ] **Step 7: Release note for the index lock (spec F17)**

The SQL comment in the migration reaches nobody. `/release` Step 1 reads `docs/release-notes/next-release-draft.md` and folds each entry into the GitHub Release body [verified that file's header]. Replace the `_No entries yet._` placeholder (or append beneath existing entries) with:

```markdown
## Ticketing — auto-suggested time entries (#3900)

- **Migration `2026-09-23-time-entry-source-and-suggestion-decisions.sql` takes a brief
  `ACCESS EXCLUSIVE`-free but blocking lock on `remote_sessions`.** It builds
  `remote_sessions_user_ended_idx` with a plain `CREATE INDEX` — `CONCURRENTLY` is
  impossible because the migration runner wraps every file in one transaction. On a
  self-hosted instance with millions of `remote_sessions` rows, expect writes to that
  table (session start/end) to block for the duration of the index build. Run the upgrade
  in a maintenance window if your `remote_sessions` table is large; check first with
  `SELECT count(*) FROM remote_sessions;`.
- Adds `time_entries.source` (`varchar(24) NOT NULL DEFAULT 'manual'`, CHECK-constrained to
  `manual | timer | location | remote_session | support_session`). Existing rows backfill to
  `'manual'` via the column default; no data migration is required.
- Adds `time_suggestion_decisions` (partner-axis RLS). No configuration needed.
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-09-23-time-entry-source-and-suggestion-decisions.sql \
        apps/api/src/db/schema/timeTracking.ts apps/api/src/db/schema/remote.ts \
        docs/release-notes/next-release-draft.md \
        docs/superpowers/specs/mobile/2026-08-28-location-time-suggestions-design.md
git commit -m "feat(api): time_entries.source + time_suggestion_decisions ledger (#3900)"
```

---

### Task 2: Registration lists + contract suites

**Rigor: high** (tenancy contracts). **Author: Claude.**

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:354` (the `time_entries` entry)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:193` (`PARTNER_TENANT_TABLES`)
- Test: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `rls-coverage.integration.test.ts`, `tenantCascade.integration.test.ts` (all existing)

**Interfaces:** none produced; this task makes Task 1 admissible.

- [ ] **Step 1: Run the contract suites and watch the two expected reds**

```bash
cd apps/api
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm test:integration -- --run \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```

> `test:integration -- <paths>` runs the whole integration suite on some vitest versions (memory note); if it does, filter with `-t` or accept the full run. Confirm in the log that the three files actually executed.

Expected: `tenant-export-policy` FAILS naming `time_entries.source` as unclassified; `tenantExportErasureRoundtrip` FAILS for the same column. `rls-coverage` PASSES vacuously (the new table is in no list yet) — that is the blind spot the next step closes.

- [ ] **Step 2: Classify `time_entries.source`**

In `apps/api/src/services/tenantExportPolicyRegistry.ts` line 354, add `"source"` to the `included` array of the `time_entries` entry, between `"billing_status"` and `"is_approved"` (order is cosmetic; the suite checks membership):

```ts
  "time_entries": tablePolicy("org_id", {"included":["id","partner_id","org_id","ticket_id","user_id","started_at","ended_at","duration_minutes","description","is_billable","hourly_rate","currency_code","billing_status","source","is_approved","approved_by","approved_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 3: Register the ledger in the partner pair list**

In `rls-coverage.integration.test.ts` immediately after `['time_entries', 'partner_id'],` (line 193):

```ts
  // W06 (#3900): decisions ledger for auto-suggested time entries. Shape 3,
  // same policy shape as time_entries. No org_id / device_id by design, so it
  // appears in no other list.
  ['time_suggestion_decisions', 'partner_id'],
```

Grep-verify the negatives the spec calls out (each must return nothing) — **all five registries, not three**. CLAUDE.md's cascade table plus `orgMergeRegistry.ts` (the sixth registration list added by #4074) are the lists that have shipped bugs; recording the negative explicitly is the point of the step:

```bash
grep -n 'time_suggestion_decisions' \
  apps/api/src/services/tenantCascade.ts \
  apps/api/src/routes/devices/core.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/services/orgMergeRegistry.ts
```

Expected: no output from any of the four. Why each is a true negative:

| List | Why the ledger is absent |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) | No `org_id` column. Org erasure leaves inert orphan rows with no FK to a deleted row. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`) | No `device_id` column. `signal_id` is deliberately FK-free (spec D2). |
| `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`) | Only tables in the org-cascade order need a per-column policy. The `time_entries.source` **column** does (Step 2). |
| `AUDIT_ADMIN_REQUIRED_TABLES` | Not append-only: no DELETE revoke, no immutability trigger. `DELETE /suggestions/dismiss` must be able to delete rows. |
| `orgMergeRegistry.ts` (#4074) | `orgMergeRegistry.integration.test.ts:233` builds its `required` set from `getOrgCascadeDeleteOrder()` ∪ a static `EXTRA_REQUIRED`; the ledger is in neither, so no entry is required and no CI job fails [verified]. Recorded here so a future reader does not re-derive it. |

- [ ] **Step 4: Re-run the suites**

Same command as Step 1, plus:

```bash
pnpm test:integration -- --run src/__tests__/integration/tenantCascade.integration.test.ts
pnpm test:rls
```

Expected: all green. `rls-coverage` now asserts `time_suggestion_decisions` has RLS on, FORCE on, and all four DML commands covered by `breeze_has_partner_access` (the `FOR ALL` policy satisfies the per-command check [verified `rls-coverage.integration.test.ts:1103-1130`]).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(api): register time_entries.source export policy + time_suggestion_decisions RLS pair (#3900)"
```

---

### Task 3: Shared validators + source vocabulary

**Rigor: low.** **Author: Codex-eligible** (reference file: `packages/shared/src/validators/timeEntries.ts` + its `.test.ts`).

**Files:**
- Modify: `packages/shared/src/validators/timeEntries.ts`
- Test: `packages/shared/src/validators/timeEntries.test.ts`

**Interfaces:**
- Produces:
  - `TIME_ENTRY_SOURCES = ['manual','timer','location','remote_session','support_session'] as const`, `timeEntrySourceSchema`, `type TimeEntrySource`
  - `timeSuggestionSignalSchema` → `{ kind: 'remote_session'; id: string }`
  - `suggestionsQuerySchema` → `{ date: string; tz?: string; userId?: string }`
  - `confirmSuggestionSchema` → `{ signals; ticketId?: string | null; startedAt: Date; endedAt?: Date; description?; isBillable?; hourlyRate?: number | null }` (`.strict()`)
  - `suggestionSignalsSchema` → `{ signals }` (`.strict()`)
  - `type ConfirmSuggestionInput`, `type SuggestionSignal`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/validators/timeEntries.test.ts`:

```ts
import {
  TIME_ENTRY_SOURCES, timeEntrySourceSchema, suggestionsQuerySchema,
  confirmSuggestionSchema, suggestionSignalsSchema
} from './timeEntries';

const SIG = { kind: 'remote_session', id: UUID };

describe('time entry sources (W06)', () => {
  it('is exactly the five-value vocabulary of migration 2026-09-23', () => {
    expect([...TIME_ENTRY_SOURCES]).toEqual(['manual', 'timer', 'location', 'remote_session', 'support_session']);
    expect(timeEntrySourceSchema.safeParse('support_session').success).toBe(true);
    expect(timeEntrySourceSchema.safeParse('suggestion').success).toBe(false);
  });

  it('createTimeEntrySchema / startTimerSchema never accept source (D5)', () => {
    const created = createTimeEntrySchema.safeParse({ startedAt: '2026-06-11T09:00:00Z', endedAt: '2026-06-11T09:30:00Z', source: 'timer' });
    expect(created.success && 'source' in created.data).toBe(false);
    const started = startTimerSchema.safeParse({ source: 'location' });
    expect(started.success && 'source' in started.data).toBe(false);
  });
});

describe('suggestionsQuerySchema', () => {
  it('requires a YYYY-MM-DD date and passes tz/userId through', () => {
    expect(suggestionsQuerySchema.safeParse({ date: '2026-08-29' }).success).toBe(true);
    expect(suggestionsQuerySchema.safeParse({ date: '2026-08-29', tz: 'Europe/Berlin', userId: UUID }).success).toBe(true);
    expect(suggestionsQuerySchema.safeParse({ date: '29/08/2026' }).success).toBe(false);
    expect(suggestionsQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('confirmSuggestionSchema', () => {
  const base = { signals: [SIG], startedAt: '2026-08-29T14:02:00Z', endedAt: '2026-08-29T14:40:00Z' };
  it('accepts a minimal confirm', () => {
    expect(confirmSuggestionSchema.safeParse(base).success).toBe(true);
  });
  it('is strict: rejects source, orgId and currency', () => {
    for (const extra of [{ source: 'remote_session' }, { orgId: UUID }, { currency: 'USD' }, { currencyCode: 'USD' }]) {
      expect(confirmSuggestionSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
  it('bounds signals to 1..20 unique remote_session refs', () => {
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: [] }).success).toBe(false);
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: [SIG, SIG] }).success).toBe(false);
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: [{ kind: 'support_session', id: UUID }] }).success).toBe(false);
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: Array.from({ length: 21 }, (_, i) => ({ kind: 'remote_session', id: `3f2f1d8e-1111-4222-8333-4444555566${String(i).padStart(2, '0')}` })) }).success).toBe(false);
  });
  it('allows endedAt to be omitted (server fills from the signal envelope) but rejects endedAt <= startedAt', () => {
    expect(confirmSuggestionSchema.safeParse({ signals: [SIG], startedAt: base.startedAt }).success).toBe(true);
    expect(confirmSuggestionSchema.safeParse({ ...base, endedAt: base.startedAt }).success).toBe(false);
  });
  it('ticketId may be null (explicit "no ticket")', () => {
    expect(confirmSuggestionSchema.safeParse({ ...base, ticketId: null }).success).toBe(true);
  });
});

describe('suggestionSignalsSchema', () => {
  it('accepts signals only', () => {
    expect(suggestionSignalsSchema.safeParse({ signals: [SIG] }).success).toBe(true);
    expect(suggestionSignalsSchema.safeParse({ signals: [SIG], reason: 'x' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/shared test -- --run src/validators/timeEntries.test.ts
```

Expected: FAIL — `TIME_ENTRY_SOURCES` etc. are not exported.

- [ ] **Step 3: Implement**

Append to `packages/shared/src/validators/timeEntries.ts`:

```ts
// ── W06 (#3900): provenance vocabulary + suggestion routes ──────────────────
// `source` is READ-side only in this wave. It is never accepted on any
// create/update schema: provenance is stamped by the server (D5).
export const TIME_ENTRY_SOURCES = ['manual', 'timer', 'location', 'remote_session', 'support_session'] as const;
export const timeEntrySourceSchema = z.enum(TIME_ENTRY_SOURCES);
export type TimeEntrySource = z.infer<typeof timeEntrySourceSchema>;

export const timeSuggestionSignalSchema = z.object({
  kind: z.literal('remote_session'),
  id: z.string().guid()
}).strict();
export type SuggestionSignal = z.infer<typeof timeSuggestionSignalSchema>;

const signalsField = z.array(timeSuggestionSignalSchema).min(1).max(20)
  .refine((s) => new Set(s.map((x) => `${x.kind}:${x.id}`)).size === s.length, { message: 'signals must be unique' });

export const suggestionsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  // IANA zone; validated with Intl in the route (400 INVALID_TZ) so the shared
  // package stays runtime-agnostic.
  tz: z.string().min(1).max(64).optional(),
  userId: z.string().guid().optional()
}).strict();

export const confirmSuggestionSchema = z.object({
  signals: signalsField,
  ticketId: z.string().guid().nullable().optional(),
  startedAt: z.coerce.date(),
  // Optional: the server fills the signal envelope end. Mandatory when any
  // member signal is 'unreliable' (400 ENDED_AT_REQUIRED).
  endedAt: z.coerce.date().optional(),
  description: z.string().max(10_000).optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional()
}).strict().refine((v) => v.endedAt === undefined || v.endedAt.getTime() > v.startedAt.getTime(), {
  message: 'endedAt must be after startedAt',
  path: ['endedAt']
});
export type ConfirmSuggestionInput = z.infer<typeof confirmSuggestionSchema>;

export const suggestionSignalsSchema = z.object({ signals: signalsField }).strict();
```

- [ ] **Step 4: Run to verify pass, then typecheck**

```bash
pnpm --filter @breeze/shared test -- --run src/validators/timeEntries.test.ts
pnpm --filter @breeze/shared build
```

Expected: PASS; build clean (`validators/index.ts` already re-exports `./timeEntries` [verified line 1072]).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/timeEntries.ts packages/shared/src/validators/timeEntries.test.ts
git commit -m "feat(shared): time-entry source vocabulary + suggestion validators (#3900)"
```

---

### Task 4: Partner setting reader + `PATCH /partners/me` acceptance

**Rigor: low** (jsonb setting; partner-wide only, no config table). **Author: Codex-eligible** (reference: `apps/api/src/services/effectiveSettings.ts` `asRecord`, `apps/api/src/routes/orgs.ts:560-575` + `:856-885`).

**Files:**
- Create: `apps/api/src/services/timeSuggestionSettings.ts`
- Test: `apps/api/src/services/timeSuggestionSettings.test.ts`
- Modify: `apps/api/src/routes/orgs.ts` (`partnerSettingsSchema` + the merge block in `PATCH /partners/me`)
- Test: `apps/api/src/routes/orgs.test.ts` (add one case)

**Interfaces:**
- Produces:
  - `interface SessionSuggestionSettings { enabled: boolean; minSessionSeconds: number; mergeGapMinutes: number }`
  - `SESSION_SUGGESTION_DEFAULTS: SessionSuggestionSettings` = `{ enabled:false, minSessionSeconds:120, mergeGapMinutes:10 }`
  - `parseSessionSuggestionSettings(partnerSettings: unknown): SessionSuggestionSettings` (pure)
  - `getSessionSuggestionSettings(partnerId: string): Promise<{ settings: SessionSuggestionSettings; timezone: string }>` (reads `partners.settings` + `partners.timezone` in the caller's DB context)

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/timeSuggestionSettings.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const selectRows: unknown[][] = [];
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(selectRows.shift() ?? [])) }))
      }))
    }))
  }
}));

import { parseSessionSuggestionSettings, getSessionSuggestionSettings, SESSION_SUGGESTION_DEFAULTS } from './timeSuggestionSettings';

describe('parseSessionSuggestionSettings', () => {
  it('defaults OFF with 120s / 10min when the block is absent', () => {
    expect(parseSessionSuggestionSettings({})).toEqual(SESSION_SUGGESTION_DEFAULTS);
    expect(parseSessionSuggestionSettings(null)).toEqual(SESSION_SUGGESTION_DEFAULTS);
    expect(SESSION_SUGGESTION_DEFAULTS.enabled).toBe(false);
  });
  it('reads timeTracking.sessionSuggestions and ignores junk types', () => {
    expect(parseSessionSuggestionSettings({ timeTracking: { sessionSuggestions: { enabled: true, minSessionSeconds: 300, mergeGapMinutes: 'x' } } }))
      .toEqual({ enabled: true, minSessionSeconds: 300, mergeGapMinutes: 10 });
  });
  it('a stored false is honoured as false (not treated as absent)', () => {
    expect(parseSessionSuggestionSettings({ timeTracking: { sessionSuggestions: { enabled: false } } }).enabled).toBe(false);
  });
});

describe('getSessionSuggestionSettings', () => {
  it('returns the parsed block and the partner timezone', async () => {
    selectRows.push([{ settings: { timeTracking: { sessionSuggestions: { enabled: true } } }, timezone: 'Europe/Berlin' }]);
    await expect(getSessionSuggestionSettings('p-1')).resolves.toEqual({
      settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 },
      timezone: 'Europe/Berlin'
    });
  });
  it('falls back to UTC + defaults when the partner row is not visible', async () => {
    selectRows.push([]);
    await expect(getSessionSuggestionSettings('p-1')).resolves.toEqual({ settings: SESSION_SUGGESTION_DEFAULTS, timezone: 'UTC' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeSuggestionSettings.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reader**

`apps/api/src/services/timeSuggestionSettings.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';

/**
 * W06 (#3900) partner-wide flag for auto-suggested time entries. Lives in
 * partners.settings JSONB (sibling of the location spec's
 * timeTracking.locationSuggestions) — not a config table, so Partner-Wide
 * First adds nothing beyond "partner-only, default off".
 */
export interface SessionSuggestionSettings {
  enabled: boolean;
  minSessionSeconds: number;
  mergeGapMinutes: number;
}

export const SESSION_SUGGESTION_DEFAULTS: SessionSuggestionSettings = Object.freeze({
  enabled: false,
  minSessionSeconds: 120,
  mergeGapMinutes: 10,
});

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

export function parseSessionSuggestionSettings(partnerSettings: unknown): SessionSuggestionSettings {
  const block = asRecord(asRecord(asRecord(partnerSettings).timeTracking).sessionSuggestions);
  const int = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
  return {
    enabled: block.enabled === true,
    minSessionSeconds: int(block.minSessionSeconds, SESSION_SUGGESTION_DEFAULTS.minSessionSeconds),
    mergeGapMinutes: int(block.mergeGapMinutes, SESSION_SUGGESTION_DEFAULTS.mergeGapMinutes),
  };
}

/** Runs in the caller's DB context: a partner request can read its own partners row. */
export async function getSessionSuggestionSettings(
  partnerId: string,
): Promise<{ settings: SessionSuggestionSettings; timezone: string }> {
  const [row] = await db
    .select({ settings: partners.settings, timezone: partners.timezone })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  if (!row) return { settings: { ...SESSION_SUGGESTION_DEFAULTS }, timezone: 'UTC' };
  return { settings: parseSessionSuggestionSettings(row.settings), timezone: row.timezone || 'UTC' };
}
```

- [ ] **Step 4: Run to verify pass**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Write the failing route test for `PATCH /partners/me`**

In `apps/api/src/routes/orgs.test.ts`, next to the existing `PATCH /partners/me` cases (grep `partners/me` in that file for the harness in use), add:

```ts
it('PATCH /partners/me accepts settings.timeTracking.sessionSuggestions and deep-merges one level', async () => {
  // Arrange: existing partner settings carry a sibling block that must survive.
  currentPartnerSettings.current = { timeTracking: { locationSuggestions: { enabled: true } } };
  const res = await request('PATCH', '/partners/me', {
    settings: { timeTracking: { sessionSuggestions: { enabled: true, minSessionSeconds: 300, mergeGapMinutes: 5 } } }
  });
  expect(res.status).toBe(200);
  expect(lastPartnerUpdate().settings.timeTracking).toEqual({
    locationSuggestions: { enabled: true },
    sessionSuggestions: { enabled: true, minSessionSeconds: 300, mergeGapMinutes: 5 }
  });
});

it('PATCH /partners/me rejects out-of-range suggestion thresholds', async () => {
  const res = await request('PATCH', '/partners/me', {
    settings: { timeTracking: { sessionSuggestions: { enabled: true, minSessionSeconds: 5 } } }
  });
  expect(res.status).toBe(400);
});
```

Use the file's own helpers for `request`, `currentPartnerSettings` and `lastPartnerUpdate` (they exist under other names — match them; do not add a second harness).

- [ ] **Step 6: Run to verify failure**

```bash
pnpm --filter @breeze/api test -- --run src/routes/orgs.test.ts -t "sessionSuggestions"
```

Expected: FAIL — the zod object strips the unknown `timeTracking` key, so the merged settings lack it (first test), and the second returns 200 instead of 400.

- [ ] **Step 7: Implement the schema key + one-level deep merge**

In `apps/api/src/routes/orgs.ts`, inside `partnerSettingsSchema` (line 560+) add after `businessHours`:

```ts
  // W06 (#3900): partner-wide time-tracking suggestion flags. Deep-merged one
  // level in the PATCH handler so the location spec's sibling
  // `timeTracking.locationSuggestions` survives a save that only carries this key.
  timeTracking: z.object({
    sessionSuggestions: z.object({
      enabled: z.boolean().optional(),
      minSessionSeconds: z.number().int().min(30).max(3600).optional(),
      mergeGapMinutes: z.number().int().min(0).max(120).optional()
    }).strict().optional()
  }).passthrough().optional(),
```

In the handler, after the `ticketing` deep-merge block (line ~880):

```ts
  if (body.settings?.timeTracking) {
    newSettings.timeTracking = {
      ...((currentSettings.timeTracking as Record<string, unknown> | undefined) ?? {}),
      ...body.settings.timeTracking,
    };
  }
```

- [ ] **Step 8: Run to verify pass**

Same command as Step 6, then the whole file: `pnpm --filter @breeze/api test -- --run src/routes/orgs.test.ts`. Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/timeSuggestionSettings.ts apps/api/src/services/timeSuggestionSettings.test.ts apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(api): partner sessionSuggestions setting (default off) (#3900)"
```

---

### Task 5: Pure suggestion rules (day window, precision, merge, ticket ranking, confirm range)

**Rigor: low** (pure, DB-free). **Author: Codex-eligible** (no reference file — the module is self-contained; hand Codex spec D9 and backend-flow steps 2, 4, 5, 6 and confirm step 3).

**Files:**
- Create: `apps/api/src/services/timeSuggestionRules.ts`
- Test: `apps/api/src/services/timeSuggestionRules.test.ts`

**Interfaces:**
- Produces (all exported, all pure):
  - `type SignalPrecision = 'recorded' | 'derived' | 'unreliable'`
  - `dayWindowUtc(date: string, tz: string): { start: Date; end: Date }` — local midnight→next local midnight of `date` in `tz`, as UTC instants.
  - `classifySignal(row: { startedAt: Date; endedAt: Date; durationSeconds: number | null; errorMessage: string | null }): { precision: SignalPrecision; durationSeconds: number | null }`
  - `interface SignalRow { id: string; type: 'terminal'|'desktop'|'file_transfer'; deviceId: string; startedAt: Date; endedAt: Date; durationSeconds: number | null; errorMessage: string | null }`
  - `mergeSignals(rows: SignalRow[], mergeGapMinutes: number): SignalRow[][]` — groups consecutive same-device rows.
  - `suggestionKey(ids: string[]): string` — sorted ids joined by `'+'`.
  - `envelopeOf(group: Array<SignalRow & { precision: SignalPrecision }>): { startedAt: Date; endedAt: Date | null; durationMinutes: number | null }`
  - `interface TicketCandidateRow { id: string; ticketNumber: string; subject: string; status: string; orgId: string; assignedTo: string | null; closedBy: string | null; closedAt: Date | null; actorStatusChangeAt: Date | null; actorStatusChangeTo: string | null }`
  - `rankTicketCandidates(rows: TicketCandidateRow[], actorId: string, envelope: { startedAt: Date; endedAt: Date | null }): { candidate: (TicketCandidateRow & { reason: 'closed_by_you' | 'assigned_to_you' }) | null; otherTickets: TicketCandidateRow[] }`
  - `validateConfirmRange(envelope: { startedAt: Date; endedAt: Date | null }, input: { startedAt: Date; endedAt?: Date }): 'ENDED_AT_REQUIRED' | 'RANGE_OUTSIDE_SIGNAL' | null`
  - **(F19)** `interface LoggedRange { startedAt: Date; endedAt: Date }`
  - **(F19)** `mergeRanges(ranges: LoggedRange[]): LoggedRange[]` — sort + union, so entries that overlap *each other* are never double-counted.
  - **(F19)** `overlapMs(window: { startedAt: Date; endedAt: Date | null }, ranges: LoggedRange[]): number` — total intersection of the (unioned) ranges with the window; `0` when the window has no end (`unreliable`).
  - **(F19)** `alreadyLoggedVerdict(window, ranges): { overlapMinutes: number; drop: boolean }`
  - constants `UNRELIABLE_AFTER_MS = 8h`, `RANGE_TOLERANCE_MS = 15min`, `TICKET_WINDOW_BEFORE_MS = 2h`, `TICKET_WINDOW_AFTER_MS = 4h`, `MAX_OTHER_TICKETS = 3`, `REAPER_MESSAGE_PREFIX = 'Session timed out'`, **`ALREADY_LOGGED_DROP_RATIO = 0.8`**

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/timeSuggestionRules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  dayWindowUtc, classifySignal, mergeSignals, suggestionKey, envelopeOf,
  rankTicketCandidates, validateConfirmRange, type SignalRow, type TicketCandidateRow
} from './timeSuggestionRules';

const d = (s: string) => new Date(s);
const sig = (over: Partial<SignalRow>): SignalRow => ({
  id: 's1', type: 'desktop', deviceId: 'dev-1',
  startedAt: d('2026-08-29T14:02:00Z'), endedAt: d('2026-08-29T14:40:00Z'),
  durationSeconds: 2280, errorMessage: null, ...over
});

describe('dayWindowUtc (D9)', () => {
  it('UTC is the identity', () => {
    expect(dayWindowUtc('2026-08-29', 'UTC')).toEqual({ start: d('2026-08-29T00:00:00Z'), end: d('2026-08-30T00:00:00Z') });
  });
  it('uses the zone offset in force on that date', () => {
    expect(dayWindowUtc('2026-08-29', 'Europe/Berlin')).toEqual({ start: d('2026-08-28T22:00:00Z'), end: d('2026-08-29T22:00:00Z') });
  });
  it('spring-forward day is 23h long (America/New_York 2026-03-08)', () => {
    const w = dayWindowUtc('2026-03-08', 'America/New_York');
    expect(w.start).toEqual(d('2026-03-08T05:00:00Z'));
    expect(w.end).toEqual(d('2026-03-09T04:00:00Z'));
  });
  it('fall-back day is 25h long (America/New_York 2026-11-01)', () => {
    const w = dayWindowUtc('2026-11-01', 'America/New_York');
    expect(w.start).toEqual(d('2026-11-01T04:00:00Z'));
    expect(w.end).toEqual(d('2026-11-02T05:00:00Z'));
  });
});

describe('classifySignal (F7/F8)', () => {
  it('recorded when duration_seconds is present', () => {
    expect(classifySignal(sig({}))).toEqual({ precision: 'recorded', durationSeconds: 2280 });
  });
  it('derived from ended_at − started_at when duration_seconds is NULL', () => {
    expect(classifySignal(sig({ durationSeconds: null }))).toEqual({ precision: 'derived', durationSeconds: 2280 });
  });
  it('unreliable for reaper-ended rows, no duration', () => {
    expect(classifySignal(sig({ durationSeconds: null, errorMessage: 'Session timed out: exceeded maximum session duration' })))
      .toEqual({ precision: 'unreliable', durationSeconds: null });
  });
  it('unreliable when derived length exceeds 8h', () => {
    expect(classifySignal(sig({ durationSeconds: null, endedAt: d('2026-08-30T00:00:00Z') })).precision).toBe('unreliable');
  });
  it('a recorded duration on a reaper row is still unreliable (the reaper never writes one, so this is defensive)', () => {
    expect(classifySignal(sig({ errorMessage: 'Session timed out: connection was never established' })).precision).toBe('unreliable');
  });
});

describe('mergeSignals', () => {
  it('merges consecutive same-device sessions within the gap', () => {
    const a = sig({ id: 'a' });
    const b = sig({ id: 'b', startedAt: d('2026-08-29T14:45:00Z'), endedAt: d('2026-08-29T15:00:00Z') });
    const c = sig({ id: 'c', startedAt: d('2026-08-29T16:00:00Z'), endedAt: d('2026-08-29T16:10:00Z') });
    expect(mergeSignals([c, b, a], 10).map((g) => g.map((s) => s.id))).toEqual([['a', 'b'], ['c']]);
  });
  it('never merges across devices', () => {
    const a = sig({ id: 'a' });
    const b = sig({ id: 'b', deviceId: 'dev-2', startedAt: d('2026-08-29T14:41:00Z'), endedAt: d('2026-08-29T15:00:00Z') });
    expect(mergeSignals([a, b], 10)).toHaveLength(2);
  });
  it('gap 0 merges only overlapping/adjacent sessions', () => {
    const a = sig({ id: 'a' });
    const b = sig({ id: 'b', startedAt: d('2026-08-29T14:40:00Z'), endedAt: d('2026-08-29T15:00:00Z') });
    const c = sig({ id: 'c', startedAt: d('2026-08-29T15:00:01Z'), endedAt: d('2026-08-29T15:10:00Z') });
    expect(mergeSignals([a, b, c], 0)).toHaveLength(2);
  });
});

describe('suggestionKey / envelopeOf', () => {
  it('key is sorted ids joined by +', () => {
    expect(suggestionKey(['b', 'a'])).toBe('a+b');
  });
  it('envelope spans the group; endedAt/duration null when any member is unreliable', () => {
    const a = { ...sig({ id: 'a' }), precision: 'recorded' as const };
    const b = { ...sig({ id: 'b', startedAt: d('2026-08-29T14:45:00Z'), endedAt: d('2026-08-29T15:00:00Z') }), precision: 'derived' as const };
    expect(envelopeOf([a, b])).toEqual({ startedAt: a.startedAt, endedAt: b.endedAt, durationMinutes: 58 });
    expect(envelopeOf([a, { ...b, precision: 'unreliable' as const }])).toEqual({ startedAt: a.startedAt, endedAt: null, durationMinutes: null });
  });
});

describe('rankTicketCandidates (flow step 6, F14)', () => {
  const env = { startedAt: d('2026-08-29T14:02:00Z'), endedAt: d('2026-08-29T14:40:00Z') };
  const t = (over: Partial<TicketCandidateRow>): TicketCandidateRow => ({
    id: 't1', ticketNumber: 'TKT-1041', subject: 'Printer', status: 'closed', orgId: 'o1',
    assignedTo: null, closedBy: null, closedAt: null, actorStatusChangeAt: null, actorStatusChangeTo: null, ...over
  });
  it('preselects the one ticket the actor closed inside [start−2h, end+4h]', () => {
    const r = rankTicketCandidates([t({ closedBy: 'me', closedAt: d('2026-08-29T15:00:00Z') })], 'me', env);
    expect(r.candidate?.reason).toBe('closed_by_you');
    expect(r.otherTickets).toEqual([]);
  });
  it('a status_change comment by the actor to resolved counts as closed_by_you', () => {
    const r = rankTicketCandidates([t({ status: 'resolved', actorStatusChangeAt: d('2026-08-29T14:50:00Z'), actorStatusChangeTo: 'resolved' })], 'me', env);
    expect(r.candidate?.reason).toBe('closed_by_you');
  });
  it('a close outside the window does not qualify', () => {
    const r = rankTicketCandidates([t({ closedBy: 'me', closedAt: d('2026-08-29T20:00:00Z') })], 'me', env);
    expect(r.candidate).toBeNull();
    expect(r.otherTickets).toHaveLength(1);
  });
  it('two rank-a ties → no preselection, both listed (ambiguity is never guessed)', () => {
    const r = rankTicketCandidates([
      t({ id: 'a', closedBy: 'me', closedAt: d('2026-08-29T15:00:00Z') }),
      t({ id: 'b', closedBy: 'me', closedAt: d('2026-08-29T15:10:00Z') })
    ], 'me', env);
    expect(r.candidate).toBeNull();
    expect(r.otherTickets.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
  it('falls back to the single open ticket assigned to the actor', () => {
    const r = rankTicketCandidates([t({ status: 'open', assignedTo: 'me' })], 'me', env);
    expect(r.candidate?.reason).toBe('assigned_to_you');
  });
  it('someone else closing it is not a signal about me', () => {
    const r = rankTicketCandidates([t({ closedBy: 'other', closedAt: d('2026-08-29T15:00:00Z') })], 'me', env);
    expect(r.candidate).toBeNull();
  });
  it('caps otherTickets at 3', () => {
    const r = rankTicketCandidates(['a', 'b', 'c', 'd', 'e'].map((id) => t({ id, status: 'open' })), 'me', env);
    expect(r.otherTickets).toHaveLength(3);
  });
  it('unreliable envelope (endedAt null) uses start + 8h as the end for the window', () => {
    const r = rankTicketCandidates([t({ closedBy: 'me', closedAt: d('2026-08-29T23:00:00Z') })], 'me', { startedAt: env.startedAt, endedAt: null });
    expect(r.candidate?.reason).toBe('closed_by_you'); // 14:02 + 8h + 4h = 02:02 next day
  });
});

describe('validateConfirmRange (confirm step 3)', () => {
  const env = { startedAt: d('2026-08-29T14:02:00Z'), endedAt: d('2026-08-29T14:40:00Z') };
  it('accepts edits within ±15 min of both ends', () => {
    expect(validateConfirmRange(env, { startedAt: d('2026-08-29T13:50:00Z'), endedAt: d('2026-08-29T14:50:00Z') })).toBeNull();
  });
  it('rejects a start more than 15 min early', () => {
    expect(validateConfirmRange(env, { startedAt: d('2026-08-29T13:40:00Z'), endedAt: env.endedAt })).toBe('RANGE_OUTSIDE_SIGNAL');
  });
  it('rejects an end more than 15 min late', () => {
    expect(validateConfirmRange(env, { startedAt: env.startedAt, endedAt: d('2026-08-29T15:00:00Z') })).toBe('RANGE_OUTSIDE_SIGNAL');
  });
  it('unreliable envelope: endedAt is mandatory and capped at start + 8h', () => {
    const un = { startedAt: env.startedAt, endedAt: null };
    expect(validateConfirmRange(un, { startedAt: env.startedAt })).toBe('ENDED_AT_REQUIRED');
    expect(validateConfirmRange(un, { startedAt: env.startedAt, endedAt: d('2026-08-29T16:00:00Z') })).toBeNull();
    expect(validateConfirmRange(un, { startedAt: env.startedAt, endedAt: d('2026-08-29T22:03:00Z') })).toBe('RANGE_OUTSIDE_SIGNAL');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeSuggestionRules.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/api/src/services/timeSuggestionRules.ts`:

```ts
/**
 * W06 (#3900) — pure rules for auto-suggested time entries. No DB, no I/O:
 * everything here is unit-tested against fixed instants. The service
 * (timeSuggestionService.ts) feeds it rows and applies its verdicts.
 */
export type SignalPrecision = 'recorded' | 'derived' | 'unreliable';

export const UNRELIABLE_AFTER_MS = 8 * 60 * 60_000;
export const RANGE_TOLERANCE_MS = 15 * 60_000;
export const TICKET_WINDOW_BEFORE_MS = 2 * 60 * 60_000;
export const TICKET_WINDOW_AFTER_MS = 4 * 60 * 60_000;
export const MAX_OTHER_TICKETS = 3;
/** staleCommandReaper writes 'Session timed out: …' on both zombie paths [verified jobs/staleCommandReaper.ts:837,853]. */
export const REAPER_MESSAGE_PREFIX = 'Session timed out';

const OPEN_TICKET_STATUSES = new Set(['new', 'open', 'pending', 'on_hold']);
const CLOSED_LIKE = new Set(['resolved', 'closed']);

// ── day window ───────────────────────────────────────────────────────────────
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - at.getTime()) / 60_000);
}

function localMidnightUtc(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Two passes: the offset at the naive guess, then the offset in force at the
  // candidate instant — that is what makes DST transition days come out right.
  const first = guess - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess - tzOffsetMinutes(new Date(first), tz) * 60_000);
}

/** Local midnight → next local midnight of `date` (YYYY-MM-DD) in `tz`, as UTC instants. */
export function dayWindowUtc(date: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: localMidnightUtc(date, tz), end: localMidnightUtc(next, tz) };
}

// ── precision ────────────────────────────────────────────────────────────────
export function classifySignal(row: {
  startedAt: Date; endedAt: Date; durationSeconds: number | null; errorMessage: string | null;
}): { precision: SignalPrecision; durationSeconds: number | null } {
  if (row.errorMessage?.startsWith(REAPER_MESSAGE_PREFIX)) return { precision: 'unreliable', durationSeconds: null };
  if (row.durationSeconds != null) return { precision: 'recorded', durationSeconds: row.durationSeconds };
  const derivedMs = row.endedAt.getTime() - row.startedAt.getTime();
  if (derivedMs > UNRELIABLE_AFTER_MS || derivedMs < 0) return { precision: 'unreliable', durationSeconds: null };
  return { precision: 'derived', durationSeconds: Math.round(derivedMs / 1000) };
}

// ── merge ────────────────────────────────────────────────────────────────────
export interface SignalRow {
  id: string;
  type: 'terminal' | 'desktop' | 'file_transfer';
  deviceId: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number | null;
  errorMessage: string | null;
}

/** Consecutive same-device sessions whose gap is <= mergeGapMinutes become one group. Input order is irrelevant. */
export function mergeSignals(rows: SignalRow[], mergeGapMinutes: number): SignalRow[][] {
  const sorted = [...rows].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const gapMs = mergeGapMinutes * 60_000;
  const groups: SignalRow[][] = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    const tail = last?.[last.length - 1];
    if (tail && tail.deviceId === row.deviceId && row.startedAt.getTime() - tail.endedAt.getTime() <= gapMs) {
      last.push(row);
    } else {
      groups.push([row]);
    }
  }
  return groups;
}

export function suggestionKey(ids: string[]): string {
  return [...ids].sort().join('+');
}

export function envelopeOf(
  group: Array<SignalRow & { precision: SignalPrecision }>,
): { startedAt: Date; endedAt: Date | null; durationMinutes: number | null } {
  const startedAt = new Date(Math.min(...group.map((s) => s.startedAt.getTime())));
  if (group.some((s) => s.precision === 'unreliable')) return { startedAt, endedAt: null, durationMinutes: null };
  const endedAt = new Date(Math.max(...group.map((s) => s.endedAt.getTime())));
  return { startedAt, endedAt, durationMinutes: Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000) };
}

// ── ticket pairing ───────────────────────────────────────────────────────────
export interface TicketCandidateRow {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  orgId: string;
  assignedTo: string | null;
  closedBy: string | null;
  closedAt: Date | null;
  actorStatusChangeAt: Date | null;
  actorStatusChangeTo: string | null;
}

export type TicketCandidateReason = 'closed_by_you' | 'assigned_to_you';

export function rankTicketCandidates(
  rows: TicketCandidateRow[],
  actorId: string,
  envelope: { startedAt: Date; endedAt: Date | null },
): { candidate: (TicketCandidateRow & { reason: TicketCandidateReason }) | null; otherTickets: TicketCandidateRow[] } {
  const endMs = (envelope.endedAt ?? new Date(envelope.startedAt.getTime() + UNRELIABLE_AFTER_MS)).getTime();
  const lo = envelope.startedAt.getTime() - TICKET_WINDOW_BEFORE_MS;
  const hi = endMs + TICKET_WINDOW_AFTER_MS;
  const inWindow = (at: Date | null) => at != null && at.getTime() >= lo && at.getTime() <= hi;

  const closedByYou = rows.filter((t) =>
    (t.closedBy === actorId && inWindow(t.closedAt))
    || (t.actorStatusChangeTo != null && CLOSED_LIKE.has(t.actorStatusChangeTo) && inWindow(t.actorStatusChangeAt)));
  const assignedToYou = rows.filter((t) => t.assignedTo === actorId && OPEN_TICKET_STATUSES.has(t.status));

  let candidate: (TicketCandidateRow & { reason: TicketCandidateReason }) | null = null;
  if (closedByYou.length === 1) candidate = { ...closedByYou[0]!, reason: 'closed_by_you' };
  else if (closedByYou.length === 0 && assignedToYou.length === 1) candidate = { ...assignedToYou[0]!, reason: 'assigned_to_you' };

  const byRecency = (a: TicketCandidateRow, b: TicketCandidateRow) =>
    (b.closedAt?.getTime() ?? b.actorStatusChangeAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? a.actorStatusChangeAt?.getTime() ?? 0);
  const otherTickets = rows
    .filter((t) => t.id !== candidate?.id)
    .sort(byRecency)
    .slice(0, MAX_OTHER_TICKETS);
  return { candidate, otherTickets };
}

// ── confirm range ────────────────────────────────────────────────────────────
export function validateConfirmRange(
  envelope: { startedAt: Date; endedAt: Date | null },
  input: { startedAt: Date; endedAt?: Date },
): 'ENDED_AT_REQUIRED' | 'RANGE_OUTSIDE_SIGNAL' | null {
  const s0 = envelope.startedAt.getTime();
  if (Math.abs(input.startedAt.getTime() - s0) > RANGE_TOLERANCE_MS) return 'RANGE_OUTSIDE_SIGNAL';
  if (envelope.endedAt == null) {
    if (!input.endedAt) return 'ENDED_AT_REQUIRED';
    if (input.endedAt.getTime() > s0 + UNRELIABLE_AFTER_MS) return 'RANGE_OUTSIDE_SIGNAL';
    return null;
  }
  if (input.endedAt && Math.abs(input.endedAt.getTime() - envelope.endedAt.getTime()) > RANGE_TOLERANCE_MS) return 'RANGE_OUTSIDE_SIGNAL';
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Same command as Step 2. Expected: PASS (the describe blocks written in Step 1). Steps 5–6 add the F19 rules on top.

- [ ] **Step 5: F19 already-logged overlap — write the failing tests**

Spec F19 is binding and nothing above it covers it: a session the technician already logged by hand — or with `/start`+`/stop`, which writes **no** ledger row — is still offered, putting a duplicate billable entry one tap away. Append to `timeSuggestionRules.test.ts`:

```ts
import { mergeRanges, overlapMs, alreadyLoggedVerdict, ALREADY_LOGGED_DROP_RATIO } from './timeSuggestionRules';

// A 100-minute window: 10:00 -> 11:40.
const W = { startedAt: d('2026-08-29T10:00:00Z'), endedAt: d('2026-08-29T11:40:00Z') };
const range = (from: string, to: string) => ({ startedAt: d(from), endedAt: d(to) });

describe('mergeRanges (F19 — never double-count overlapping entries)', () => {
  it('unions overlapping and touching ranges, leaves disjoint ones alone', () => {
    expect(mergeRanges([
      range('2026-08-29T10:00:00Z', '2026-08-29T10:30:00Z'),
      range('2026-08-29T10:20:00Z', '2026-08-29T10:50:00Z'),   // overlaps the first
      range('2026-08-29T10:50:00Z', '2026-08-29T11:00:00Z'),   // touches the second
      range('2026-08-29T11:30:00Z', '2026-08-29T11:40:00Z'),   // disjoint
    ])).toEqual([
      range('2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'),
      range('2026-08-29T11:30:00Z', '2026-08-29T11:40:00Z'),
    ]);
  });
  it('is order-independent', () => {
    const a = range('2026-08-29T11:00:00Z', '2026-08-29T11:10:00Z');
    const b = range('2026-08-29T10:00:00Z', '2026-08-29T10:10:00Z');
    expect(mergeRanges([a, b])).toEqual(mergeRanges([b, a]));
  });
  it('two entries covering the SAME half hour count as half an hour, not an hour', () => {
    const dup = [range('2026-08-29T10:00:00Z', '2026-08-29T10:30:00Z'), range('2026-08-29T10:00:00Z', '2026-08-29T10:30:00Z')];
    expect(overlapMs(W, dup)).toBe(30 * 60_000);
  });
});

describe('overlapMs (F19)', () => {
  it('clips ranges to the window on both sides', () => {
    expect(overlapMs(W, [range('2026-08-29T09:00:00Z', '2026-08-29T10:20:00Z')])).toBe(20 * 60_000);
    expect(overlapMs(W, [range('2026-08-29T11:30:00Z', '2026-08-29T13:00:00Z')])).toBe(10 * 60_000);
  });
  it('is 0 for a window with no end (unreliable member) — never drop what we cannot measure (F7)', () => {
    expect(overlapMs({ startedAt: W.startedAt, endedAt: null }, [range('2026-08-29T10:00:00Z', '2026-08-29T11:40:00Z')])).toBe(0);
  });
  it('is 0 with no logged entries', () => {
    expect(overlapMs(W, [])).toBe(0);
  });
});

describe('alreadyLoggedVerdict — threshold table (F19)', () => {
  // 100-minute window; each case logs N minutes from 10:00.
  const cases: Array<[pct: number, minutes: number, drop: boolean]> = [
    [0, 0, false],
    [50, 50, false],
    [79, 79, false],
    [80, 80, true],     // exactly at the threshold DROPS (>= not >)
    [100, 100, true],
  ];
  it.each(cases)('%i%% overlap -> drop=%s', (_pct, minutes, drop) => {
    const ranges = minutes === 0 ? [] : [{ startedAt: W.startedAt, endedAt: new Date(W.startedAt.getTime() + minutes * 60_000) }];
    expect(alreadyLoggedVerdict(W, ranges)).toEqual({ overlapMinutes: minutes, drop });
  });
  it('the threshold is a named constant at 0.8, not a literal', () => {
    expect(ALREADY_LOGGED_DROP_RATIO).toBe(0.8);
  });
  it('rounds the reported minutes but thresholds on milliseconds', () => {
    // 79 min 40 s = 79.67% -> still below 0.8, reported as 80 min.
    const ranges = [{ startedAt: W.startedAt, endedAt: new Date(W.startedAt.getTime() + (79 * 60 + 40) * 1000) }];
    expect(alreadyLoggedVerdict(W, ranges)).toEqual({ overlapMinutes: 80, drop: false });
  });
});
```

Run `pnpm --filter @breeze/api test -- --run src/services/timeSuggestionRules.test.ts`. Expected: FAIL — the four symbols are not exported.

- [ ] **Step 6: Implement the F19 rules**

Append to `apps/api/src/services/timeSuggestionRules.ts`:

```ts
// ── F19: the technician may have logged this work already ────────────────────
// The decisions ledger only records suggestions someone acted on. A hand-typed
// entry, or one produced by /start + /stop, writes NO ledger row — so without
// this second exclusion the same work is offered again and a duplicate billable
// row is one tap away. Drop at >= 80% covered; below that, report the residual
// so a partial overlap is visible in the confirm sheet instead of doubled.
export const ALREADY_LOGGED_DROP_RATIO = 0.8;

export interface LoggedRange { startedAt: Date; endedAt: Date }

/** Sort + union. Entries that overlap EACH OTHER must not be counted twice. */
export function mergeRanges(ranges: LoggedRange[]): LoggedRange[] {
  const sorted = [...ranges]
    .filter((r) => r.endedAt.getTime() > r.startedAt.getTime())
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const out: LoggedRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startedAt.getTime() <= last.endedAt.getTime()) {
      if (r.endedAt.getTime() > last.endedAt.getTime()) last.endedAt = r.endedAt;
    } else {
      out.push({ startedAt: r.startedAt, endedAt: r.endedAt });
    }
  }
  return out;
}

export function overlapMs(window: { startedAt: Date; endedAt: Date | null }, ranges: LoggedRange[]): number {
  // An unreliable window has no measurable duration; never drop on a guess (F7).
  if (!window.endedAt) return 0;
  const s = window.startedAt.getTime();
  const e = window.endedAt.getTime();
  return mergeRanges(ranges).reduce(
    (sum, r) => sum + Math.max(0, Math.min(e, r.endedAt.getTime()) - Math.max(s, r.startedAt.getTime())),
    0,
  );
}

export function alreadyLoggedVerdict(
  window: { startedAt: Date; endedAt: Date | null },
  ranges: LoggedRange[],
): { overlapMinutes: number; drop: boolean } {
  const ms = overlapMs(window, ranges);
  const windowMs = window.endedAt ? window.endedAt.getTime() - window.startedAt.getTime() : 0;
  return {
    overlapMinutes: Math.round(ms / 60_000),
    // Threshold on milliseconds, round only what is displayed.
    drop: windowMs > 0 && ms / windowMs >= ALREADY_LOGGED_DROP_RATIO,
  };
}
```

Re-run the file. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/timeSuggestionRules.ts apps/api/src/services/timeSuggestionRules.test.ts
git commit -m "feat(api): pure suggestion rules — day window, precision, merge, ticket ranking (#3900)"
```

---

### Task 6: `timeEntryService` provenance (`source` stamps, internal `provenance`, `resolveAndLockOrgLink`)

**Rigor: high** (money/currency stamping seam, org-axis access). **Author: Claude.**

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts` (`TimeEntryServiceErrorCode` :10-29, `TimeEntryAuditMutation` :42-53, `createTimeEntry` :350-424, `startTimer` :446-541, `entrySelection` :916-939)
- Modify: `apps/api/src/services/timeEntryEvents.ts:15`
- Test: `apps/api/src/services/timeEntryService.test.ts`

**Interfaces:**
- Consumes: `TimeEntrySource` from `@breeze/shared` (Task 3); `readOrgStampingDefaults(db, orgId)` from `./orgCurrencyCore` [verified :60-71]; `entryOrgAllowed` [verified :585].
- Produces:
  - `TimeEntryServiceErrorCode` gains `'SUGGESTIONS_DISABLED' | 'SIGNAL_NOT_FOUND' | 'SIGNAL_NOT_ENDED' | 'SUGGESTION_DISMISSED' | 'SUGGESTION_ENTRY_DELETED' | 'ORG_MISMATCH' | 'ENDED_AT_REQUIRED' | 'RANGE_OUTSIDE_SIGNAL' | 'INVALID_TZ' | 'ORG_DENIED'`
  - `interface TimeEntryProvenance { source: TimeEntrySource; orgLink?: { orgId: string; currencyCode: string } | null }`
  - `createTimeEntry(input: CreateTimeEntryInput, actor: TimeEntryActor, provenance?: TimeEntryProvenance)` — third argument is internal; routes never pass it.
  - `resolveAndLockOrgLink(orgId: string, actor: TimeEntryActor): Promise<{ orgId: string; currencyCode: string }>` (exported; reused by the location wave's `/start {orgId}`)
  - `TimeEntryAuditMutation.source?: TimeEntrySource`
  - `TimeEntryAuditMutation['action']` gains `'time_suggestion.dismissed' | 'time_suggestion.undismissed'` (Task 8 consumes them; declaring the union here keeps it in one place).
  - `entrySelection()` includes `source: timeEntries.source` (so `GET /`, `GET /timesheet`, `GET /tickets/:id/time-entries` expose it read-only).
  - **`export type TimeEntryRow = Awaited<ReturnType<typeof createTimeEntry>>`** — the single name for "an entry as this service returns it". There is no such exported type on main today (the only `TimeEntryRow` in the repo is a private local in `services/invoiceAssembly.ts:73` [verified]); Task 8's signature referenced it, so it must exist here.
  - **`export async function readTimeEntryById(id: string): Promise<TimeEntryRow | null>`** — `db.select(entrySelection()).from(timeEntries).where(eq(timeEntries.id, id)).limit(1)`, run in the caller's DB context so the partner-axis `time_entries` RLS policy still applies. Task 8's replay branch uses it so the `200 { entry, replay:true }` body is **shape-identical** to the `201 { entry }` body; a raw `SELECT *` there would return snake_case columns and quietly break every client that reads `entry.durationMinutes`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/timeEntryService.test.ts` (use the file's existing `dbMocks` harness — `insertedValues` records `.values()` payloads, `selectResults` queues select results, `emitMock` captures events):

```ts
describe('provenance (W06 #3900)', () => {
  const actor = { userId: 'u1', partnerId: 'p1', manageAll: false, accessibleOrgIds: null, recordAuditMutation: vi.fn() };

  it('POST-path createTimeEntry stamps source=manual by default', async () => {
    dbMocks.insertResult = [{ id: 'e1', ticketId: null, durationMinutes: 30, isBillable: false, orgId: null }];
    await createTimeEntry({ startedAt: new Date('2026-08-29T09:00:00Z'), endedAt: new Date('2026-08-29T09:30:00Z') }, actor);
    expect(dbMocks.insertedValues[0]).toMatchObject({ source: 'manual' });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.created', payload: expect.objectContaining({ source: 'manual' }) }));
    expect(actor.recordAuditMutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'time_entry.created', source: 'manual' }));
  });

  it('startTimer stamps source=timer', async () => {
    dbMocks.selectResults.push([]);            // getPartnerCurrency not reached (no rate)
    dbMocks.updateResult = [];                 // no running entry to auto-stop
    dbMocks.insertResult = [{ id: 'e2', ticketId: null, isBillable: false, orgId: null }];
    await startTimer({}, actor);
    expect(dbMocks.insertedValues.at(-1)).toMatchObject({ source: 'timer' });
  });

  it('internal provenance stamps remote_session and uses the org link for org/currency', async () => {
    dbMocks.insertResult = [{ id: 'e3', ticketId: null, durationMinutes: 38, isBillable: false, orgId: 'o1' }];
    await createTimeEntry(
      { startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:40:00Z') },
      actor,
      { source: 'remote_session', orgLink: { orgId: 'o1', currencyCode: 'EUR' } }
    );
    expect(dbMocks.insertedValues.at(-1)).toMatchObject({ source: 'remote_session', orgId: 'o1', currencyCode: 'EUR' });
  });

  it('support_session provenance with no org link lands org_id NULL and currency NULL (D6)', async () => {
    dbMocks.insertResult = [{ id: 'e4', ticketId: null, durationMinutes: 10, isBillable: false, orgId: null }];
    await createTimeEntry(
      { startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:12:00Z') },
      actor,
      { source: 'support_session', orgLink: null }
    );
    expect(dbMocks.insertedValues.at(-1)).toMatchObject({ source: 'support_session', orgId: null, currencyCode: null });
  });

  it('a ticket link wins over an org link (the ticket path is the locked, authoritative one)', async () => {
    // Queue the reads resolveAndLockTicketLink performs: ticket, org defaults, lock row, (category none)
    dbMocks.selectResults.push(
      [{ id: 't1', partnerId: 'p1', orgId: 'o-ticket', categoryId: null }],
      [{ currencyCode: 'USD' }],
      [{ id: 't1', orgId: 'o-ticket' }],
    );
    dbMocks.insertResult = [{ id: 'e5', ticketId: 't1', durationMinutes: 38, isBillable: false, orgId: 'o-ticket' }];
    await createTimeEntry(
      { ticketId: '3f2f1d8e-1111-4222-8333-444455556666', startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:40:00Z') },
      actor,
      { source: 'remote_session', orgLink: { orgId: 'o-session', currencyCode: 'EUR' } }
    );
    expect(dbMocks.insertedValues.at(-1)).toMatchObject({ orgId: 'o-ticket', currencyCode: 'USD', source: 'remote_session' });
  });
});

describe('resolveAndLockOrgLink', () => {
  it('denies an org outside accessibleOrgIds with ORG_DENIED (403)', async () => {
    await expect(resolveAndLockOrgLink('o9', { userId: 'u1', partnerId: 'p1', manageAll: false, accessibleOrgIds: ['o1'] }))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
  it('denies an org of another partner with ORG_DENIED', async () => {
    dbMocks.selectResults.push([{ id: 'o2', partnerId: 'p-other' }]);
    await expect(resolveAndLockOrgLink('o2', { userId: 'u1', partnerId: 'p1', manageAll: false, accessibleOrgIds: null }))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
  });
  it('locks the org FOR SHARE and returns its currency', async () => {
    dbMocks.selectResults.push([{ id: 'o1', partnerId: 'p1' }], [{ currencyCode: 'EUR' }]);
    const before = dbMocks.forUpdateCalls;
    await expect(resolveAndLockOrgLink('o1', { userId: 'u1', partnerId: 'p1', manageAll: false, accessibleOrgIds: null }))
      .resolves.toEqual({ orgId: 'o1', currencyCode: 'EUR' });
    expect(dbMocks.forUpdateCalls).toBe(before + 1); // the harness counts .for('share') and .for('update') alike
  });
});
```

Add `resolveAndLockOrgLink` to the file's import from `./timeEntryService`. If the harness's queued-select order for the ticket path differs from the three rows above, mirror whatever the existing "createTimeEntry with ticket" test queues — the assertion that matters is the `toMatchObject` on the insert.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeEntryService.test.ts -t "provenance|resolveAndLockOrgLink"
```

Expected: FAIL — `source` missing from the insert payloads; `resolveAndLockOrgLink` not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/services/timeEntryService.ts`:

1. Extend the error union (after `'PRICE_NOT_REPRESENTABLE'`):

```ts
  // W06 (#3900) auto-suggested entries
  | 'SUGGESTIONS_DISABLED'
  | 'SIGNAL_NOT_FOUND'
  | 'SIGNAL_NOT_ENDED'
  | 'SUGGESTION_DISMISSED'
  | 'SUGGESTION_ENTRY_DELETED'
  | 'ORG_MISMATCH'
  | 'ENDED_AT_REQUIRED'
  | 'RANGE_OUTSIDE_SIGNAL'
  | 'INVALID_TZ'
  | 'ORG_DENIED';
```

2. Import `type TimeEntrySource` from `@breeze/shared` and `organizations` from `../db/schema`. Add to `TimeEntryAuditMutation`: `source?: TimeEntrySource;` and make `recordAuditMutation` forward `entry.source`:

```ts
function recordAuditMutation(
  actor: TimeEntryActor,
  action: TimeEntryAuditMutation['action'],
  entry: { id: string; orgId?: string | null; source?: string | null },
): void {
  actor.recordAuditMutation?.({
    action,
    entryId: entry.id,
    orgId: entry.orgId ?? null,
    ...(entry.source ? { source: entry.source as TimeEntrySource } : {}),
  });
}
```

3. Add the provenance type and the org-link resolver directly above `createTimeEntry`:

```ts
/**
 * Internal-only provenance for createTimeEntry. Never part of a public zod
 * schema (spec D5): routes call createTimeEntry(input, actor) and get
 * 'manual'; only timeSuggestionService passes a source. `orgLink` is used
 * when there is no ticket — a ticket always wins because its path holds the
 * ticket + org locks (creation barrier #3778).
 */
export interface TimeEntryProvenance {
  source: TimeEntrySource;
  orgLink?: { orgId: string; currencyCode: string } | null;
}

/**
 * Org-only link for standalone entries that still know their org (a remote
 * session's org, later the location wave's `/start {orgId}`). Mirrors the
 * access half of resolveTicketLink, then takes the same `organizations FOR
 * SHARE` the ticket path takes so time_entries_currency_required_when_org_chk
 * holds against a concurrent currency change.
 */
export async function resolveAndLockOrgLink(orgId: string, actor: TimeEntryActor): Promise<{ orgId: string; currencyCode: string }> {
  if (!entryOrgAllowed({ orgId }, actor.accessibleOrgIds)) {
    throw new TimeEntryServiceError('Access to this organization denied', 403, 'ORG_DENIED');
  }
  const [org] = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org || (actor.partnerId && org.partnerId !== actor.partnerId)) {
    throw new TimeEntryServiceError('Access to this organization denied', 403, 'ORG_DENIED');
  }
  const stamped = await readOrgStampingDefaults(db, orgId);
  return { orgId, currencyCode: stamped.currencyCode };
}
```

4. In `createTimeEntry`, change the signature to `(input: CreateTimeEntryInput, actor: TimeEntryActor, provenance: TimeEntryProvenance = { source: 'manual' })`. After the `if (input.ticketId) {...}` block add:

```ts
  else if (provenance.orgLink) {
    orgId = provenance.orgLink.orgId;
    currencyCode = provenance.orgLink.currencyCode;
  }
```

Add `source: provenance.source,` to the `.values({...})` insert; add `source: entry.source` to the `emitTimeEntryEvent` payload.

5. In `startTimer`'s insert `.values({...})` add `source: 'timer',`. In the `emitTimeEntryEvent` payload of `startTimer` add `source: 'timer'`.

6. In `entrySelection()` add `source: timeEntries.source,` after `billingStatus`.

7. In `apps/api/src/services/timeEntryEvents.ts:15` extend the created payload: `payload: { userId: string; durationMinutes: number | null; isBillable: boolean; source?: string }`.

8. Export the row type and a by-id reader — Task 8's confirm signature names `TimeEntryRow`, and its replay branch must return the same shape as its create branch. Directly under `createTimeEntry`:

```ts
/** An entry exactly as this service returns it. Exported so callers (the
 *  suggestions confirm path) can name it without re-deriving the selection. */
export type TimeEntryRow = Awaited<ReturnType<typeof createTimeEntry>>;

/**
 * Re-read one entry with the SAME selection createTimeEntry returns. Runs in
 * the caller's DB context, so the partner-axis time_entries policy is the
 * tenant wall; no extra app-layer check is needed to make it safe, and callers
 * that need org-axis narrowing still apply `entryOrgAllowed`.
 * Used by the confirm replay branch so `200 {entry, replay:true}` and
 * `201 {entry}` are shape-identical — a raw `SELECT *` would return snake_case
 * columns and silently break `entry.durationMinutes` on every client.
 */
export async function readTimeEntryById(id: string): Promise<TimeEntryRow | null> {
  const [row] = await db.select(entrySelection()).from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  return (row as TimeEntryRow | undefined) ?? null;
}
```

Add one test to the `provenance` describe:

```ts
it('readTimeEntryById returns the same camelCase shape as createTimeEntry', async () => {
  dbMocks.selectResults.push([{ id: 'e9', durationMinutes: 38, isBillable: true, orgId: 'o1', source: 'remote_session' }]);
  await expect(readTimeEntryById('e9')).resolves.toMatchObject({ id: 'e9', durationMinutes: 38, source: 'remote_session' });
});
```

9. Extend `TimeEntryAuditMutation['action']` (`timeEntryService.ts:42-53`) with `| 'time_suggestion.dismissed' | 'time_suggestion.undismissed'`. Task 8 emits them; the union lives here so there is one declaration.

- [ ] **Step 4: Run the whole service test file + typecheck**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeEntryService.test.ts src/services/timeEntryEvents*.test.ts
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
```

Expected: PASS; tsc clean (note the memory: API tsc can OOM — if it does, run `NODE_OPTIONS=--max-old-space-size=8192`).

- [ ] **Step 5: Thread `source` into the route audit details**

In `apps/api/src/routes/timeEntries/timeEntries.ts` `writeSimpleTimeEntryAudits` [verified :74-88], change `details` to `{ entryIds: [mutation.entryId], count: 1, ...(mutation.source ? { source: mutation.source } : {}) }`, and make the hard-coded `resourceType: 'time_entry'` [verified :81 and :119] conditional so a dismissal is not filed as a time entry:

```ts
      resourceType: mutation.action.startsWith('time_suggestion') ? 'time_suggestion' : 'time_entry',
```

Apply the same expression in `writeBulkTimeEntryAudits` (`:119`) — the dismiss route batches. Add to `timeEntries.test.ts` under the existing `POST /` audit test:

```ts
it('audit details carry the stamped source', async () => {
  serviceMocks.createTimeEntry.mockImplementation(async (_i: unknown, actor: any) => {
    actor.recordAuditMutation({ action: 'time_entry.created', entryId: 'e1', orgId: null, source: 'manual' });
    return { id: 'e1' };
  });
  const res = await timeEntriesRoutes.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startedAt: '2026-08-29T09:00:00Z', endedAt: '2026-08-29T09:30:00Z' }) });
  expect(res.status).toBe(201);
  expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ source: 'manual' }) }));
});
```

Run `pnpm --filter @breeze/api test -- --run src/routes/timeEntries/timeEntries.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts apps/api/src/services/timeEntryEvents.ts apps/api/src/routes/timeEntries/timeEntries.ts apps/api/src/routes/timeEntries/timeEntries.test.ts
git commit -m "feat(api): server-stamped time_entries.source + internal provenance argument (#3900)"
```

---

### Task 7: `timeSuggestionService` — signal query, list, count (W07 hook)

**Rigor: high** (tenant-scoped read path; the SQL predicates are the isolation). **Author: Claude.**

**Files:**
- Create: `apps/api/src/services/timeSuggestionService.ts`
- Test: `apps/api/src/services/timeSuggestionService.test.ts`

**Interfaces:**
- Consumes: Task 5 rules; Task 4 `getSessionSuggestionSettings`; `TimeEntryActor` [verified `timeEntryService.ts:55-72`]; `orgAxisSql`-style narrowing (re-implemented inline as `rs.org_id = ANY(:ids)`).
- Produces:
  ```ts
  export type SuggestionSignalRef = { kind: 'remote_session'; id: string };
  export interface TimeSuggestionSignal {
    kind: 'remote_session'; id: string; type: 'terminal' | 'desktop' | 'file_transfer';
    startedAt: string; endedAt: string; precision: SignalPrecision;
  }
  export interface TimeSuggestion {
    key: string;
    signals: TimeSuggestionSignal[];
    startedAt: string; endedAt: string | null; durationMinutes: number | null;
    device: { id: string; hostname: string } | null;
    org: { id: string; name: string } | null;
    quickSupport: { attributionLabel: string | null; attributedOrgName: string | null } | null;
    candidateTicket: { id: string; ticketNumber: string; subject: string; status: string; reason: 'closed_by_you' | 'assigned_to_you' } | null;
    otherTickets: Array<{ id: string; ticketNumber: string; subject: string }>;
    suggestedSource: 'remote_session' | 'support_session';
    /** F19: minutes of this window already covered by the actor's existing
     *  time_entries. 0 normally; > 0 means a partial overlap the sheet must
     *  show. A window >= 80% covered is dropped and never reaches the client. */
    alreadyLoggedOverlapMinutes: number;
  }
  export interface ListSuggestionsResult { enabled: boolean; date: string; timezone: string; suggestions: TimeSuggestion[]; unloggedCount: number }
  export interface SuggestionActor extends TimeEntryActor { scope: 'partner' | 'system' }
  export async function listTimeSuggestions(actor: SuggestionActor, opts: { date: string; tz?: string; userId?: string }): Promise<ListSuggestionsResult>
  export async function countUnloggedSuggestions(args: { userId: string; partnerId: string; date: string; tz?: string }): Promise<number>
  // internal but exported for Task 8 + tests:
  export interface LoadedSignal extends SignalRow { precision: SignalPrecision; orgId: string; orgName: string; orgType: string; deviceHostname: string | null; attributedOrgId: string | null; attributedOrgName: string | null; attributionLabel: string | null }
  export async function loadSignals(q: { userId: string; partnerId: string; accessibleOrgIds: string[] | null; window?: { start: Date; end: Date }; ids?: string[]; includeDecided?: boolean }): Promise<LoadedSignal[]>
  // F19 — the actor's already-logged ranges for the day, fetched once per list
  // call (never per suggestion). A running timer counts as [started_at, now).
  export async function loadLoggedRanges(q: { userId: string; window: { start: Date; end: Date } }): Promise<LoggedRange[]>
  ```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/timeSuggestionService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { execCalls, execResults, settingsMock } = vi.hoisted(() => ({
  execCalls: [] as unknown[],
  execResults: [] as unknown[][],
  settingsMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { execute: vi.fn((q: unknown) => { execCalls.push(q); return Promise.resolve(execResults.shift() ?? []); }) },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./timeSuggestionSettings', () => ({
  getSessionSuggestionSettings: (...a: unknown[]) => settingsMock(...a),
}));

import { listTimeSuggestions, countUnloggedSuggestions, loadSignals } from './timeSuggestionService';

const compiled = (i: number) => new PgDialect().sqlToQuery(execCalls[i] as any);
const actor = { userId: 'u1', partnerId: 'p1', manageAll: false, accessibleOrgIds: ['o1'], scope: 'partner' as const };
const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: 's1', type: 'desktop', device_id: 'd1', started_at: new Date('2026-08-29T14:02:00Z'), ended_at: new Date('2026-08-29T14:40:00Z'),
  duration_seconds: 2280, error_message: null, org_id: 'o1', org_name: 'ACME', org_type: 'customer', device_hostname: 'ACME-DC01',
  attributed_org_id: null, attributed_org_name: null, attribution_label: null, ...over,
});

beforeEach(() => { execCalls.length = 0; execResults.length = 0; settingsMock.mockReset(); });

describe('loadSignals — compiled SQL carries the isolation predicates (F1)', () => {
  it('binds user_id, partner_id, the NOT EXISTS decision filter and the org allowlist', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['o1', 'o2'], window: { start: new Date('2026-08-29T00:00:00Z'), end: new Date('2026-08-30T00:00:00Z') } });
    const { sql, params } = compiled(0);
    expect(sql).toMatch(/rs\.user_id = \$\d/);
    expect(sql).toMatch(/o\.partner_id = \$\d/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM time_suggestion_decisions/);
    expect(sql).toMatch(/rs\.org_id = ANY\(/);
    expect(sql).toMatch(/rs\.status IN \('disconnected', ?'failed'\)/);
    expect(sql).toMatch(/AT TIME ZONE 'UTC'/);
    expect(params).toEqual(expect.arrayContaining(['u1', 'p1']));
  });
  it('omits the org allowlist for system scope (null) but never the user/partner predicates', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null, ids: ['s1'] });
    const { sql } = compiled(0);
    expect(sql).not.toMatch(/rs\.org_id = ANY/);
    expect(sql).toMatch(/rs\.user_id = \$\d/);
    expect(sql).toMatch(/rs\.id = ANY\(/);
  });
});

// QUERY ORDER TRAP: listTimeSuggestions issues THREE queries, in this order —
//   0 signals (loadSignals)  1 already-logged ranges (loadLoggedRanges, F19)  2 ticket candidates
// so every test below queues an `execResults.push([])` for the ranges query
// between the signals push and the tickets push. Miss it and the ticket rows
// are consumed as logged ranges and the assertion fails in a confusing place.
describe('listTimeSuggestions', () => {
  it('returns enabled:false and no query when the partner flag is off (F10)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r).toEqual({ enabled: false, date: '2026-08-29', timezone: 'UTC', suggestions: [], unloggedCount: 0 });
    expect(execCalls).toHaveLength(0);
  });
  it('builds a suggestion with device, org, recorded precision and a preselected closed ticket', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'Europe/Berlin' });
    execResults.push([sessionRow()]);                       // 0 signals
    execResults.push([]);                                   // 1 F19 already-logged ranges
    execResults.push([{ id: 't1', ticket_number: 'TKT-1041', subject: 'Printer', status: 'closed', org_id: 'o1', device_id: 'd1', assigned_to: null, closed_by: 'u1', closed_at: new Date('2026-08-29T15:00:00Z'), actor_status_change_at: null, actor_status_change_to: null }]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.enabled).toBe(true);
    expect(r.timezone).toBe('Europe/Berlin');
    expect(r.unloggedCount).toBe(1);
    expect(r.suggestions[0]).toMatchObject({
      key: 's1', durationMinutes: 38, device: { id: 'd1', hostname: 'ACME-DC01' }, org: { id: 'o1', name: 'ACME' },
      quickSupport: null, suggestedSource: 'remote_session',
      candidateTicket: { id: 't1', ticketNumber: 'TKT-1041', reason: 'closed_by_you' },
      signals: [expect.objectContaining({ kind: 'remote_session', id: 's1', precision: 'recorded' })],
    });
  });
  it('drops sessions shorter than minSessionSeconds', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ duration_seconds: 45, ended_at: new Date('2026-08-29T14:02:45Z') })]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toEqual([]);
    expect(r.unloggedCount).toBe(0);
  });
  it('merges two adjacent same-device sessions into one keyed suggestion', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ id: 'b', started_at: new Date('2026-08-29T14:45:00Z'), ended_at: new Date('2026-08-29T15:00:00Z'), duration_seconds: 900 }), sessionRow({ id: 'a' })]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.key).toBe('a+b');
    expect(r.suggestions[0]!.durationMinutes).toBe(58);
  });
  it('Quick Support: hidden org → org:null, attribution shown, support_session, ticket candidates restricted to the attributed org (D4/D6/F12)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ org_type: 'quick_support', org_name: 'Quick Support', device_hostname: null, attributed_org_id: 'o-acme', attributed_org_name: 'ACME', attribution_label: 'Bob @ ACME' })]);
    execResults.push([]);   // F19 ranges
    execResults.push([]);   // tickets
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions[0]).toMatchObject({ org: null, device: null, suggestedSource: 'support_session', quickSupport: { attributionLabel: 'Bob @ ACME', attributedOrgName: 'ACME' } });
    expect(compiled(2).sql).toMatch(/t\.org_id = \$\d/);   // 0 signals, 1 ranges, 2 tickets
  });
  it('reaper-ended session is unreliable: no duration, endedAt null (F7)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ duration_seconds: null, error_message: 'Session timed out: exceeded maximum session duration', ended_at: new Date('2026-08-30T14:02:00Z') })]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-30' });
    expect(r.suggestions[0]).toMatchObject({ endedAt: null, durationMinutes: null, signals: [expect.objectContaining({ precision: 'unreliable' })] });
  });
  it('rejects a bad tz with INVALID_TZ and a date older than 31 days with INVALID_RANGE', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(listTimeSuggestions(actor, { date: '2026-08-29', tz: 'Mars/Olympus' })).rejects.toMatchObject({ code: 'INVALID_TZ', status: 400 });
    await expect(listTimeSuggestions(actor, { date: '2020-01-01' })).rejects.toMatchObject({ code: 'INVALID_RANGE', status: 400 });
  });

  // ── F19: already logged by hand or by /start + /stop ──────────────────────
  it('drops a session the technician already logged (>= 80% covered) — no duplicate one tap away', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);                                   // 14:02–14:40, 38 min
    execResults.push([{ range_start: new Date('2026-08-29T14:00:00Z'), range_end: new Date('2026-08-29T14:45:00Z') }]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toEqual([]);
    expect(r.unloggedCount).toBe(0);
  });
  it('keeps a partially covered session and reports the residual overlap', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);                                   // 38 min
    execResults.push([{ range_start: new Date('2026-08-29T14:02:00Z'), range_end: new Date('2026-08-29T14:12:00Z') }]); // 10 min = 26%
    execResults.push([]);                                              // tickets
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(10);
  });
  it('reports 0 overlap when nothing is logged', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);
    execResults.push([]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(0);
  });
  it('the ranges query binds the actor and treats a running timer as [started_at, now)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);
    execResults.push([]);
    execResults.push([]);
    await listTimeSuggestions(actor, { date: '2026-08-29' });
    const { sql, params } = compiled(1);
    expect(sql).toMatch(/te\.user_id = \$\d/);
    expect(sql).toMatch(/COALESCE\(te\.ended_at, b\.now_utc\)/);
    expect(sql).toMatch(/GREATEST\(te\.started_at, b\.day_start\)/);
    expect(sql).toMatch(/LEAST\(COALESCE\(te\.ended_at, b\.now_utc\), b\.day_end\)/);
    expect(params).toEqual(expect.arrayContaining(['u1']));
  });
  it('an unreliable window is never dropped by F19 — we cannot measure it (F7)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ duration_seconds: null, error_message: 'Session timed out: exceeded maximum session duration', ended_at: new Date('2026-08-30T14:02:00Z') })]);
    execResults.push([{ range_start: new Date('2026-08-30T00:00:00Z'), range_end: new Date('2026-08-30T23:59:00Z') }]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-30' });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(0);
  });
});

describe('countUnloggedSuggestions (W07 hook)', () => {
  it('returns the post-filter count under system context with the explicit partner predicate', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ id: 'a' }), sessionRow({ id: 'b', device_id: 'd2', started_at: new Date('2026-08-29T16:00:00Z'), ended_at: new Date('2026-08-29T16:30:00Z'), duration_seconds: 1800 })]);
    execResults.push([]);   // F19 ranges
    await expect(countUnloggedSuggestions({ userId: 'u1', partnerId: 'p1', date: '2026-08-29' })).resolves.toBe(2);
    expect(compiled(0).sql).toMatch(/o\.partner_id = \$\d/);
  });
  it('applies the same F19 filter as list — the push count can never exceed what the screen shows', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ id: 'a' }), sessionRow({ id: 'b', device_id: 'd2', started_at: new Date('2026-08-29T16:00:00Z'), ended_at: new Date('2026-08-29T16:30:00Z'), duration_seconds: 1800 })]);
    execResults.push([{ range_start: new Date('2026-08-29T16:00:00Z'), range_end: new Date('2026-08-29T16:30:00Z') }]);
    await expect(countUnloggedSuggestions({ userId: 'u1', partnerId: 'p1', date: '2026-08-29' })).resolves.toBe(1);
  });
  it('is 0 when the flag is off', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(countUnloggedSuggestions({ userId: 'u1', partnerId: 'p1', date: '2026-08-29' })).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeSuggestionService.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/api/src/services/timeSuggestionService.ts` (list/count half; Task 8 appends confirm/dismiss):

```ts
import { sql } from 'drizzle-orm';
import { isValidIanaTimezone } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../db';
import { TimeEntryServiceError, type TimeEntryActor } from './timeEntryService';
import { getSessionSuggestionSettings, type SessionSuggestionSettings } from './timeSuggestionSettings';
import {
  classifySignal, dayWindowUtc, envelopeOf, mergeSignals, rankTicketCandidates, suggestionKey,
  alreadyLoggedVerdict,
  UNRELIABLE_AFTER_MS, TICKET_WINDOW_BEFORE_MS, TICKET_WINDOW_AFTER_MS,
  type SignalPrecision, type SignalRow, type TicketCandidateRow, type LoggedRange,
} from './timeSuggestionRules';

export type SuggestionSignalRef = { kind: 'remote_session'; id: string };

export interface TimeSuggestionSignal {
  kind: 'remote_session';
  id: string;
  type: 'terminal' | 'desktop' | 'file_transfer';
  startedAt: string;
  endedAt: string;
  precision: SignalPrecision;
}

export interface TimeSuggestion {
  key: string;
  signals: TimeSuggestionSignal[];
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  device: { id: string; hostname: string } | null;
  org: { id: string; name: string } | null;
  quickSupport: { attributionLabel: string | null; attributedOrgName: string | null } | null;
  candidateTicket: { id: string; ticketNumber: string; subject: string; status: string; reason: 'closed_by_you' | 'assigned_to_you' } | null;
  otherTickets: Array<{ id: string; ticketNumber: string; subject: string }>;
  suggestedSource: 'remote_session' | 'support_session';
  /** F19 — see the interface note in Task 7's Interfaces block. */
  alreadyLoggedOverlapMinutes: number;
}

export interface ListSuggestionsResult {
  enabled: boolean;
  date: string;
  timezone: string;
  suggestions: TimeSuggestion[];
  unloggedCount: number;
}

export interface SuggestionActor extends TimeEntryActor {
  scope: 'partner' | 'system';
}

export interface LoadedSignal extends SignalRow {
  precision: SignalPrecision;
  orgId: string;
  orgName: string;
  orgType: string;
  deviceHostname: string | null;
  attributedOrgId: string | null;
  attributedOrgName: string | null;
  attributionLabel: string | null;
}

const MAX_LOOKBACK_DAYS = 31;

/** ISO string for a naive-UTC `timestamp` comparison: `'…Z'::timestamptz AT TIME ZONE 'UTC'`. */
const utcTs = (d: Date) => sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * The one signal query (spec backend-flow step 3). Runs in the CALLER's DB
 * context — RLS on remote_sessions / organizations / devices / support_sessions
 * is the first wall; `rs.user_id = :user AND o.partner_id = :partner` and the
 * accessibleOrgIds allowlist are the app-layer backstop. A bug here can only
 * over-restrict (F1).
 */
export async function loadSignals(q: {
  userId: string;
  partnerId: string;
  accessibleOrgIds: string[] | null;
  window?: { start: Date; end: Date };
  ids?: string[];
  includeDecided?: boolean;
}): Promise<LoadedSignal[]> {
  const conds = [
    sql`rs.user_id = ${q.userId}`,
    sql`rs.started_at IS NOT NULL AND rs.ended_at IS NOT NULL`,
    sql`rs.status IN ('disconnected','failed')`,
  ];
  if (q.window) conds.push(sql`rs.ended_at >= ${utcTs(q.window.start)} AND rs.ended_at < ${utcTs(q.window.end)}`);
  if (q.ids) conds.push(sql`rs.id = ANY(${q.ids}::uuid[])`);
  if (q.accessibleOrgIds) conds.push(sql`rs.org_id = ANY(${q.accessibleOrgIds}::uuid[])`);
  if (!q.includeDecided) {
    conds.push(sql`NOT EXISTS (SELECT 1 FROM time_suggestion_decisions x
      WHERE x.user_id = ${q.userId} AND x.signal_kind = 'remote_session' AND x.signal_id = rs.id)`);
  }

  const rows = (await db.execute(sql`
    SELECT rs.id, rs.type, rs.device_id,
           (rs.started_at AT TIME ZONE 'UTC') AS started_at,
           (rs.ended_at   AT TIME ZONE 'UTC') AS ended_at,
           rs.duration_seconds, rs.error_message,
           rs.org_id, o.name AS org_name, o.type AS org_type,
           d.hostname AS device_hostname,
           qs.attributed_org_id, ao.name AS attributed_org_name, qs.attribution_label
    FROM remote_sessions rs
    JOIN organizations o ON o.id = rs.org_id AND o.partner_id = ${q.partnerId}
    LEFT JOIN devices d ON d.id = rs.device_id
    LEFT JOIN LATERAL (
      SELECT ss.attributed_org_id, ss.attribution_label
      FROM support_sessions ss
      WHERE o.type = 'quick_support' AND ss.device_id = rs.device_id
      ORDER BY ss.created_at DESC LIMIT 1
    ) qs ON true
    LEFT JOIN organizations ao ON ao.id = qs.attributed_org_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY rs.started_at
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const base = {
      id: String(r.id),
      type: r.type as SignalRow['type'],
      deviceId: String(r.device_id),
      startedAt: new Date(r.started_at as string | Date),
      endedAt: new Date(r.ended_at as string | Date),
      durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      errorMessage: (r.error_message as string | null) ?? null,
    };
    return {
      ...base,
      precision: classifySignal(base).precision,
      orgId: String(r.org_id),
      orgName: String(r.org_name),
      orgType: String(r.org_type),
      deviceHostname: (r.device_hostname as string | null) ?? null,
      attributedOrgId: (r.attributed_org_id as string | null) ?? null,
      attributedOrgName: (r.attributed_org_name as string | null) ?? null,
      attributionLabel: (r.attribution_label as string | null) ?? null,
    };
  });
}

/**
 * F19 — everything this technician has ALREADY logged inside the day window.
 * One query per list call, not one per suggestion. Ranges are clipped to the
 * window in SQL so the TS side only unions and intersects.
 *
 * A running timer (`ended_at IS NULL`) counts as `[started_at, now)` clipped to
 * the window — not zero-length (which would re-suggest work in progress) and
 * not open-ended to end-of-day (which would hide everything after it). Runs in
 * the caller's DB context; the partner-axis time_entries policy plus the
 * explicit `user_id` predicate are the walls.
 */
export async function loadLoggedRanges(q: { userId: string; window: { start: Date; end: Date } }): Promise<LoggedRange[]> {
  const rows = (await db.execute(sql`
    WITH bounds AS (
      SELECT ${utcTs(q.window.start)} AS day_start,
             ${utcTs(q.window.end)}   AS day_end,
             (statement_timestamp() AT TIME ZONE 'UTC') AS now_utc
    )
    SELECT GREATEST(te.started_at, b.day_start)                        AS range_start,
           LEAST(COALESCE(te.ended_at, b.now_utc), b.day_end)          AS range_end
    FROM time_entries te CROSS JOIN bounds b
    WHERE te.user_id = ${q.userId}
      AND te.started_at < b.day_end
      AND COALESCE(te.ended_at, b.now_utc) > b.day_start
  `)) as unknown as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({ startedAt: new Date(r.range_start as string | Date), endedAt: new Date(r.range_end as string | Date) }))
    .filter((r) => r.endedAt.getTime() > r.startedAt.getTime());
}

function resolveWindow(date: string, tz: string | undefined, partnerTz: string): { window: { start: Date; end: Date }; timezone: string } {
  const timezone = tz ?? partnerTz ?? 'UTC';
  if (!isValidIanaTimezone(timezone)) throw new TimeEntryServiceError(`Unknown timezone ${timezone}`, 400, 'INVALID_TZ');
  const window = dayWindowUtc(date, timezone);
  if (Number.isNaN(window.start.getTime())) throw new TimeEntryServiceError('Invalid date', 400, 'INVALID_RANGE');
  if (Date.now() - window.end.getTime() > MAX_LOOKBACK_DAYS * 24 * 60 * 60_000) {
    throw new TimeEntryServiceError(`date must be within the last ${MAX_LOOKBACK_DAYS} days`, 400, 'INVALID_RANGE');
  }
  return { window, timezone };
}

/** Groups (merge) + threshold filter shared by list and count so the two never disagree. */
function groupSignals(signals: LoadedSignal[], settings: SessionSuggestionSettings): LoadedSignal[][] {
  const kept = signals.filter((s) => {
    const { durationSeconds } = classifySignal(s);
    // Unreliable rows (durationSeconds null) are never hidden (F7).
    return durationSeconds == null || durationSeconds >= settings.minSessionSeconds;
  });
  return mergeSignals(kept, settings.mergeGapMinutes) as LoadedSignal[][];
}

async function loadTicketCandidates(q: {
  partnerId: string; actorId: string; deviceIds: string[]; window: { start: Date; end: Date }; orgId?: string;
}): Promise<Array<TicketCandidateRow & { deviceId: string }>> {
  if (q.deviceIds.length === 0) return [];
  const lo = new Date(q.window.start.getTime() - TICKET_WINDOW_BEFORE_MS);
  const hi = new Date(q.window.end.getTime() + UNRELIABLE_AFTER_MS + TICKET_WINDOW_AFTER_MS);
  const orgCond = q.orgId ? sql`AND t.org_id = ${q.orgId}` : sql``;
  const rows = (await db.execute(sql`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.org_id, t.device_id, t.assigned_to, t.closed_by,
           (t.closed_at AT TIME ZONE 'UTC') AS closed_at,
           (sc.created_at AT TIME ZONE 'UTC') AS actor_status_change_at, sc.new_value AS actor_status_change_to
    FROM tickets t
    LEFT JOIN LATERAL (
      SELECT c.created_at, c.new_value FROM ticket_comments c
      WHERE c.ticket_id = t.id AND c.user_id = ${q.actorId} AND c.comment_type = 'status_change'
        AND c.new_value IN ('resolved','closed')
        AND c.created_at >= ${utcTs(lo)} AND c.created_at < ${utcTs(hi)}
      ORDER BY c.created_at DESC LIMIT 1
    ) sc ON true
    WHERE t.partner_id = ${q.partnerId}
      AND t.deleted_at IS NULL
      AND t.device_id = ANY(${q.deviceIds}::uuid[])
      ${orgCond}
      AND (t.assigned_to = ${q.actorId} OR t.closed_by = ${q.actorId} OR sc.created_at IS NOT NULL)
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    ticketNumber: String(r.ticket_number),
    subject: String(r.subject),
    status: String(r.status),
    orgId: String(r.org_id),
    deviceId: String(r.device_id),
    assignedTo: (r.assigned_to as string | null) ?? null,
    closedBy: (r.closed_by as string | null) ?? null,
    closedAt: r.closed_at ? new Date(r.closed_at as string | Date) : null,
    actorStatusChangeAt: r.actor_status_change_at ? new Date(r.actor_status_change_at as string | Date) : null,
    actorStatusChangeTo: (r.actor_status_change_to as string | null) ?? null,
  }));
}

function toSuggestion(
  group: LoadedSignal[],
  actorId: string,
  tickets: Array<TicketCandidateRow & { deviceId: string }>,
  loggedRanges: LoggedRange[],
): TimeSuggestion {
  const head = group[0]!;
  const isQuickSupport = head.orgType === 'quick_support';
  const env = envelopeOf(group);
  const mine = tickets.filter((t) => t.deviceId === head.deviceId && (!isQuickSupport || (head.attributedOrgId != null && t.orgId === head.attributedOrgId)));
  const ranked = rankTicketCandidates(mine, actorId, env);
  return {
    key: suggestionKey(group.map((s) => s.id)),
    signals: group.map((s) => ({ kind: 'remote_session', id: s.id, type: s.type, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt.toISOString(), precision: s.precision })),
    startedAt: env.startedAt.toISOString(),
    endedAt: env.endedAt ? env.endedAt.toISOString() : null,
    durationMinutes: env.durationMinutes,
    device: head.deviceHostname ? { id: head.deviceId, hostname: head.deviceHostname } : null,
    org: isQuickSupport ? null : { id: head.orgId, name: head.orgName },
    quickSupport: isQuickSupport ? { attributionLabel: head.attributionLabel, attributedOrgName: head.attributedOrgName } : null,
    candidateTicket: ranked.candidate
      ? { id: ranked.candidate.id, ticketNumber: ranked.candidate.ticketNumber, subject: ranked.candidate.subject, status: ranked.candidate.status, reason: ranked.candidate.reason }
      : null,
    otherTickets: ranked.otherTickets.map((t) => ({ id: t.id, ticketNumber: t.ticketNumber, subject: t.subject })),
    suggestedSource: isQuickSupport ? 'support_session' : 'remote_session',
    // F19: residual overlap only — anything >= the drop ratio is filtered out
    // by the caller and never reaches the client.
    alreadyLoggedOverlapMinutes: alreadyLoggedVerdict(env, loggedRanges).overlapMinutes,
  };
}

/** F19 filter, shared by list and count so the two can never disagree. */
function dropAlreadyLogged(groups: LoadedSignal[][], loggedRanges: LoggedRange[]): LoadedSignal[][] {
  if (loggedRanges.length === 0) return groups;
  return groups.filter((g) => !alreadyLoggedVerdict(envelopeOf(g), loggedRanges).drop);
}

export async function listTimeSuggestions(
  actor: SuggestionActor,
  opts: { date: string; tz?: string; userId?: string },
): Promise<ListSuggestionsResult> {
  if (!actor.partnerId) throw new TimeEntryServiceError('Partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  const { settings, timezone: partnerTz } = await getSessionSuggestionSettings(actor.partnerId);
  if (!settings.enabled) return { enabled: false, date: opts.date, timezone: opts.tz ?? partnerTz, suggestions: [], unloggedCount: 0 };
  const { window, timezone } = resolveWindow(opts.date, opts.tz, partnerTz);
  const userId = opts.userId ?? actor.userId;

  const signals = await loadSignals({ userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds, window });
  // F19: fetch once, then drop windows the technician has already logged.
  const loggedRanges = await loadLoggedRanges({ userId, window });
  const groups = dropAlreadyLogged(groupSignals(signals, settings), loggedRanges);
  if (groups.length === 0) return { enabled: true, date: opts.date, timezone, suggestions: [], unloggedCount: 0 };

  const nonQs = groups.filter((g) => g[0]!.orgType !== 'quick_support');
  const qsWithOrg = groups.filter((g) => g[0]!.orgType === 'quick_support' && g[0]!.attributedOrgId);
  const tickets = [
    ...(await loadTicketCandidates({ partnerId: actor.partnerId, actorId: userId, deviceIds: [...new Set(nonQs.map((g) => g[0]!.deviceId))], window })),
    ...(await Promise.all(qsWithOrg.map((g) => loadTicketCandidates({ partnerId: actor.partnerId!, actorId: userId, deviceIds: [g[0]!.deviceId], window, orgId: g[0]!.attributedOrgId! })))).flat(),
  ];

  const suggestions = groups.map((g) => toSuggestion(g, userId, tickets, loggedRanges));
  return { enabled: true, date: opts.date, timezone, suggestions, unloggedCount: suggestions.length };
}

/**
 * W07 hook — same grouping as list, number only. Safe under system context
 * because `o.partner_id = :partner` and `rs.user_id = :user` are explicit
 * predicates, not RLS side-effects. Dispatch, quiet hours and dedupe are W07.
 */
export async function countUnloggedSuggestions(args: { userId: string; partnerId: string; date: string; tz?: string }): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const { settings, timezone: partnerTz } = await getSessionSuggestionSettings(args.partnerId);
    if (!settings.enabled) return 0;
    const { window } = resolveWindow(args.date, args.tz, partnerTz);
    const signals = await loadSignals({ userId: args.userId, partnerId: args.partnerId, accessibleOrgIds: null, window });
    const loggedRanges = await loadLoggedRanges({ userId: args.userId, window });
    // Same F19 filter as list — a push that says "3 unlogged sessions" while
    // the screen shows 1 is worse than no push at all.
    return dropAlreadyLogged(groupSignals(signals, settings), loggedRanges).length;
  });
}
```

> `isValidIanaTimezone` is exported from `@breeze/shared` [verified import in `routes/orgs.ts:40`]. If the mocked `../db` in the test needs `withSystemDbAccessContext` to be a passthrough, it is (see the mock).

- [ ] **Step 4: Run to verify pass + typecheck**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeSuggestionService.test.ts
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
```

Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/timeSuggestionService.ts apps/api/src/services/timeSuggestionService.test.ts
git commit -m "feat(api): time-suggestion list + count from remote_sessions under caller RLS (#3900)"
```

---

### Task 8: Confirm / dismiss / undismiss

**Rigor: high** (writes money-bearing rows; idempotency; RLS-backed re-validation). **Author: Claude.**

**Files:**
- Modify: `apps/api/src/services/timeSuggestionService.ts` (append)
- Test: `apps/api/src/services/timeSuggestionService.test.ts` (append)
- Modify: `apps/api/src/services/timeEntryService.ts` — Step 3 extends `TimeEntryAuditMutation['action']` (:42-53) if Task 6 Step 9 has not already
- Modify: `apps/api/src/routes/timeEntries/timeEntries.ts` — the `resourceType` switch in `writeSimpleTimeEntryAudits` / `writeBulkTimeEntryAudits` (Task 6 Step 5 lands it; verify it is present, do not duplicate it)
- Test: `apps/api/src/services/timeEntryService.test.ts` (audit-union typecheck only)

**Interfaces:**
- Consumes: Task 6 `createTimeEntry(input, actor, provenance)`, `resolveAndLockOrgLink`, **`readTimeEntryById`**, **`type TimeEntryRow`**; Task 5 `validateConfirmRange`, `envelopeOf`; Task 7 `loadSignals`; `ConfirmSuggestionInput` (Task 3); `timeSuggestionDecisions` (Task 1).
- Produces:
  - `confirmTimeSuggestion(input: ConfirmSuggestionInput, actor: SuggestionActor): Promise<{ entry: TimeEntryRow; replay: boolean }>` — `TimeEntryRow` is the type Task 6 exports; it is **not** the private local of the same name in `services/invoiceAssembly.ts:73` [verified], which is unrelated and unexported.
  - `dismissTimeSuggestions(signals: SuggestionSignalRef[], actor: SuggestionActor): Promise<void>`
  - `undismissTimeSuggestions(signals: SuggestionSignalRef[], actor: SuggestionActor): Promise<void>`
  - `TimeEntryAuditMutation.action` gains `'time_suggestion.dismissed' | 'time_suggestion.undismissed'` (declared in Task 6 Step 9).

**F19 and confirm — deliberate non-check.** Confirm does **not** re-run the already-logged overlap test. The technician saw the residual `alreadyLoggedOverlapMinutes` in the sheet and chose to log anyway; a server-side refusal would make a legitimate "I worked on two things in that hour" impossible and has no tenant-safety value. F19 is a *list*-side filter only.

- [ ] **Step 1: Write the failing tests**

Append to `timeSuggestionService.test.ts`. Extend the `../db` mock so it also provides the Drizzle chain the confirm path uses (`db.insert(...).values(...).onConflictDoNothing().returning()`, `db.delete(...).where(...)`) and mock `./timeEntryService`:

```ts
const { inserted, deletedWhere, createEntryMock, orgLinkMock } = vi.hoisted(() => ({
  inserted: [] as unknown[], deletedWhere: [] as unknown[], createEntryMock: vi.fn(), orgLinkMock: vi.fn(),
}));
vi.mock('./timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('./timeEntryService')>('./timeEntryService');
  return { ...actual, createTimeEntry: (...a: unknown[]) => createEntryMock(...a), resolveAndLockOrgLink: (...a: unknown[]) => orgLinkMock(...a) };
});
// extend the existing `../db` mock factory with:
//   insert: vi.fn(() => ({ values: (v: unknown) => { inserted.push(v); return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(Array.isArray(v) ? v : [v]) }) }; } })),
//   delete: vi.fn(() => ({ where: (w: unknown) => { deletedWhere.push(w); return Promise.resolve(); } })),

import { confirmTimeSuggestion, dismissTimeSuggestions, undismissTimeSuggestions } from './timeSuggestionService';

const enabled = () => settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
const confirmBody = { signals: [{ kind: 'remote_session' as const, id: 's1' }], startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:40:00Z') };

describe('confirmTimeSuggestion', () => {
  beforeEach(() => { inserted.length = 0; deletedWhere.length = 0; createEntryMock.mockReset(); orgLinkMock.mockReset(); });

  it('403 SUGGESTIONS_DISABLED when the flag is off', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SUGGESTIONS_DISABLED', status: 403 });
  });

  it('takes an advisory xact lock per signal, then 404s a signal the caller cannot see (F2)', async () => {
    enabled();
    execResults.push([]);   // advisory lock
    execResults.push([]);   // loadSignals (ids) -> nothing visible
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND', status: 404 });
    expect(compiled(0).sql).toMatch(/pg_advisory_xact_lock/);
  });

  it('happy path: creates a closed entry with remote_session provenance + org link and writes one confirmed decision per signal', async () => {
    enabled();
    execResults.push([]);                                   // lock
    execResults.push([sessionRow()]);                       // signals (includeDecided)
    execResults.push([]);                                   // existing decisions
    orgLinkMock.mockResolvedValue({ orgId: 'o1', currencyCode: 'EUR' });
    createEntryMock.mockResolvedValue({ id: 'e1', orgId: 'o1', ticketId: null, source: 'remote_session' });
    const r = await confirmTimeSuggestion(confirmBody, actor);
    expect(r).toEqual({ entry: expect.objectContaining({ id: 'e1' }), replay: false });
    expect(createEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ startedAt: confirmBody.startedAt, endedAt: confirmBody.endedAt }),
      expect.objectContaining({ userId: 'u1' }),
      { source: 'remote_session', orgLink: { orgId: 'o1', currencyCode: 'EUR' } }
    );
    expect(inserted[0]).toEqual([expect.objectContaining({ partnerId: 'p1', userId: 'u1', signalKind: 'remote_session', signalId: 's1', decision: 'confirmed', timeEntryId: 'e1' })]);
  });

  it('with a ticket: no org link is resolved (the ticket path stamps org/currency) and a ticket in another org is 422 ORG_MISMATCH (F3)', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    execResults.push([{ org_id: 'o-other' }]);              // ticket org probe
    await expect(confirmTimeSuggestion({ ...confirmBody, ticketId: '3f2f1d8e-1111-4222-8333-444455556666' }, actor)).rejects.toMatchObject({ code: 'ORG_MISMATCH', status: 422 });
    expect(orgLinkMock).not.toHaveBeenCalled();
  });

  it('Quick Support with no ticket: org NULL, support_session, description prefixed with the attribution label (D6)', async () => {
    enabled();
    execResults.push([], [sessionRow({ org_type: 'quick_support', attribution_label: 'Bob @ ACME' })], []);
    createEntryMock.mockResolvedValue({ id: 'e2', orgId: null });
    await confirmTimeSuggestion({ ...confirmBody, description: 'reset password' }, actor);
    expect(orgLinkMock).not.toHaveBeenCalled();
    expect(createEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Bob @ ACME — reset password' }),
      expect.anything(),
      { source: 'support_session', orgLink: null }
    );
  });

  it('replay: every signal already confirmed to one entry → 200 same entry, no new writes (F4)', async () => {
    enabled();
    execResults.push([], [sessionRow()]);
    execResults.push([{ signal_id: 's1', decision: 'confirmed', time_entry_id: 'e1' }]);
    execResults.push([{ id: 'e1', org_id: 'o1' }]);        // entry re-select
    const r = await confirmTimeSuggestion(confirmBody, actor);
    expect(r.replay).toBe(true);
    expect(createEntryMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('tombstone: confirmed decision whose entry was deleted → 410 (F5)', async () => {
    enabled();
    execResults.push([], [sessionRow()], [{ signal_id: 's1', decision: 'confirmed', time_entry_id: null }]);
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SUGGESTION_ENTRY_DELETED', status: 410 });
  });

  it('dismissed → 409', async () => {
    enabled();
    execResults.push([], [sessionRow()], [{ signal_id: 's1', decision: 'dismissed', time_entry_id: null }]);
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SUGGESTION_DISMISSED', status: 409 });
  });

  it('signals spanning two orgs → 422 ORG_MISMATCH', async () => {
    enabled();
    execResults.push([], [sessionRow({ id: 's1' }), sessionRow({ id: 's2', org_id: 'o2' })], []);
    await expect(confirmTimeSuggestion({ ...confirmBody, signals: [{ kind: 'remote_session', id: 's1' }, { kind: 'remote_session', id: 's2' }] }, actor))
      .rejects.toMatchObject({ code: 'ORG_MISMATCH' });
  });

  it('edits outside ±15 min → 400 RANGE_OUTSIDE_SIGNAL; unreliable member without endedAt → 400 ENDED_AT_REQUIRED', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    await expect(confirmTimeSuggestion({ ...confirmBody, startedAt: new Date('2026-08-29T13:00:00Z') }, actor)).rejects.toMatchObject({ code: 'RANGE_OUTSIDE_SIGNAL', status: 400 });
    execResults.push([], [sessionRow({ duration_seconds: null, error_message: 'Session timed out: exceeded maximum session duration' })], []);
    await expect(confirmTimeSuggestion({ signals: confirmBody.signals, startedAt: confirmBody.startedAt }, actor)).rejects.toMatchObject({ code: 'ENDED_AT_REQUIRED', status: 400 });
  });

  it('endedAt omitted on a reliable signal → envelope end is used', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    orgLinkMock.mockResolvedValue({ orgId: 'o1', currencyCode: 'EUR' });
    createEntryMock.mockResolvedValue({ id: 'e1', orgId: 'o1' });
    await confirmTimeSuggestion({ signals: confirmBody.signals, startedAt: confirmBody.startedAt }, actor);
    expect(createEntryMock.mock.calls[0]![0]).toMatchObject({ endedAt: new Date('2026-08-29T14:40:00Z') });
  });
});

describe('dismiss / undismiss', () => {
  it('dismiss re-validates ownership via the signal query then inserts ON CONFLICT DO NOTHING', async () => {
    enabled();
    execResults.push([sessionRow()]);
    await dismissTimeSuggestions([{ kind: 'remote_session', id: 's1' }], actor);
    expect(compiled(0).sql).toMatch(/rs\.user_id = \$\d/);
    expect(inserted[0]).toEqual([expect.objectContaining({ decision: 'dismissed', timeEntryId: null, userId: 'u1' })]);
  });
  it('dismiss 404s a signal the caller cannot see', async () => {
    enabled();
    execResults.push([]);
    await expect(dismissTimeSuggestions([{ kind: 'remote_session', id: 's1' }], actor)).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND' });
  });
  it('undismiss deletes the actor\'s dismissed rows and confirmed rows with a NULL entry only', async () => {
    enabled();
    await undismissTimeSuggestions([{ kind: 'remote_session', id: 's1' }], actor);
    const where = new PgDialect().sqlToQuery(deletedWhere[0] as any);
    expect(where.sql).toMatch(/"user_id" = \$\d/);
    expect(where.sql).toMatch(/"decision" = \$\d/);
    expect(where.sql).toMatch(/"time_entry_id" is null/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeSuggestionService.test.ts -t "confirmTimeSuggestion|dismiss"
```

Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Append to `apps/api/src/services/timeSuggestionService.ts` (add `and, eq, inArray, isNull, or` to the `drizzle-orm` import, `timeSuggestionDecisions` from `../db/schema`, `createTimeEntry, resolveAndLockOrgLink, readTimeEntryById, type TimeEntryRow` from `./timeEntryService`, `validateConfirmRange` from the rules, `type ConfirmSuggestionInput` from `@breeze/shared`):

```ts
// ── decisions ────────────────────────────────────────────────────────────────

async function requireEnabled(actor: SuggestionActor): Promise<SessionSuggestionSettings> {
  if (!actor.partnerId) throw new TimeEntryServiceError('Partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  const { settings } = await getSessionSuggestionSettings(actor.partnerId);
  if (!settings.enabled) throw new TimeEntryServiceError('Session suggestions are disabled for this partner', 403, 'SUGGESTIONS_DISABLED');
  return settings;
}

/**
 * Re-reads the named signals under the caller's RLS + user/partner predicates.
 * Anything missing is 404 — a foreign or forged id is indistinguishable from a
 * purged one on purpose (F2).
 */
async function loadOwnedSignals(actor: SuggestionActor, signals: SuggestionSignalRef[]): Promise<LoadedSignal[]> {
  const ids = signals.map((s) => s.id);
  const rows = await loadSignals({ userId: actor.userId, partnerId: actor.partnerId!, accessibleOrgIds: actor.accessibleOrgIds, ids, includeDecided: true });
  if (rows.length !== ids.length) throw new TimeEntryServiceError('Session not found', 404, 'SIGNAL_NOT_FOUND');
  return rows;
}

/**
 * Serialises concurrent confirms of the same (user, signal) INSIDE the request
 * transaction. A raised 23505 would abort the whole request (#2189), so the
 * lock — not a unique-violation retry — is what makes a double tap yield one
 * entry; the ON CONFLICT DO NOTHING on the ledger insert is only a backstop.
 */
async function lockSignals(userId: string, ids: string[]): Promise<void> {
  for (const id of [...ids].sort()) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:remote_session:${id}`}))`);
  }
}

async function readDecisions(userId: string, ids: string[]): Promise<Array<{ signalId: string; decision: string; timeEntryId: string | null }>> {
  const rows = (await db.execute(sql`
    SELECT signal_id, decision, time_entry_id FROM time_suggestion_decisions
    WHERE user_id = ${userId} AND signal_kind = 'remote_session' AND signal_id = ANY(${ids}::uuid[])
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ signalId: String(r.signal_id), decision: String(r.decision), timeEntryId: (r.time_entry_id as string | null) ?? null }));
}

export async function confirmTimeSuggestion(
  input: ConfirmSuggestionInput,
  actor: SuggestionActor,
): Promise<{ entry: TimeEntryRow; replay: boolean }> {
  await requireEnabled(actor);
  const ids = input.signals.map((s) => s.id);
  await lockSignals(actor.userId, ids);

  const signals = await loadOwnedSignals(actor, input.signals);
  if (signals.some((s) => s.endedAt == null)) throw new TimeEntryServiceError('Session has not ended', 409, 'SIGNAL_NOT_ENDED');

  // Existing decisions: full replay -> 200; tombstone -> 410; dismissed -> 409.
  const decisions = await readDecisions(actor.userId, ids);
  if (decisions.some((d) => d.decision === 'dismissed')) throw new TimeEntryServiceError('Suggestion was dismissed — restore it first', 409, 'SUGGESTION_DISMISSED');
  if (decisions.some((d) => d.decision === 'confirmed' && d.timeEntryId == null)) throw new TimeEntryServiceError('The time entry created from this session was deleted', 410, 'SUGGESTION_ENTRY_DELETED');
  const entryIds = new Set(decisions.map((d) => d.timeEntryId));
  if (decisions.length === ids.length && entryIds.size === 1) {
    // Re-read with the SAME selection createTimeEntry returns, so the replay
    // body is shape-identical to the 201 body. A raw `SELECT *` here would hand
    // the client snake_case columns and break `entry.durationMinutes`.
    const entry = await readTimeEntryById([...entryIds][0]!);
    if (entry) return { entry, replay: true };
    throw new TimeEntryServiceError('The time entry created from this session was deleted', 410, 'SUGGESTION_ENTRY_DELETED');
  }
  if (decisions.length > 0) throw new TimeEntryServiceError('Some sessions are already logged to a different entry', 409, 'SUGGESTION_DISMISSED');

  const orgIds = new Set(signals.map((s) => s.orgId));
  if (orgIds.size !== 1) throw new TimeEntryServiceError('Sessions span more than one organization', 422, 'ORG_MISMATCH');
  const head = signals[0]!;
  const isQuickSupport = head.orgType === 'quick_support';

  const env = envelopeOf(signals);
  const rangeError = validateConfirmRange(env, { startedAt: input.startedAt, endedAt: input.endedAt });
  if (rangeError === 'ENDED_AT_REQUIRED') throw new TimeEntryServiceError('endedAt is required for a session with an unreliable end', 400, 'ENDED_AT_REQUIRED');
  if (rangeError === 'RANGE_OUTSIDE_SIGNAL') throw new TimeEntryServiceError('Start/end must stay within 15 minutes of the recorded session', 400, 'RANGE_OUTSIDE_SIGNAL');
  const endedAt = input.endedAt ?? env.endedAt!;

  // Org / currency resolution (confirm step 4).
  let provenance: { source: 'remote_session' | 'support_session'; orgLink: { orgId: string; currencyCode: string } | null };
  let description = input.description;
  if (input.ticketId) {
    // Ticket path stamps org/currency under its own locks; here we only assert
    // the ticket belongs to the session's org for non-QS sessions (F3).
    const [ticket] = (await db.execute(sql`SELECT org_id FROM tickets WHERE id = ${input.ticketId} AND deleted_at IS NULL`)) as unknown as Array<{ org_id: string }>;
    if (!ticket) throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_NOT_FOUND');
    if (!isQuickSupport && ticket.org_id !== head.orgId) throw new TimeEntryServiceError('Ticket belongs to a different organization than the session', 422, 'ORG_MISMATCH');
    provenance = { source: isQuickSupport ? 'support_session' : 'remote_session', orgLink: null };
  } else if (isQuickSupport) {
    // D6: never the hidden org, never attributed_org_id.
    provenance = { source: 'support_session', orgLink: null };
    if (head.attributionLabel) description = description ? `${head.attributionLabel} — ${description}` : head.attributionLabel;
  } else {
    provenance = { source: 'remote_session', orgLink: await resolveAndLockOrgLink(head.orgId, actor) };
  }

  const entry = await createTimeEntry(
    {
      ticketId: input.ticketId ?? undefined,
      startedAt: input.startedAt,
      endedAt,
      description,
      isBillable: input.isBillable,
      hourlyRate: input.hourlyRate,
    },
    actor,
    provenance,
  );

  await db
    .insert(timeSuggestionDecisions)
    .values(ids.map((signalId) => ({ partnerId: actor.partnerId!, userId: actor.userId, signalKind: 'remote_session', signalId, decision: 'confirmed', timeEntryId: entry.id })))
    .onConflictDoNothing()
    .returning();

  return { entry, replay: false };
}

export async function dismissTimeSuggestions(signals: SuggestionSignalRef[], actor: SuggestionActor): Promise<void> {
  await requireEnabled(actor);
  await loadOwnedSignals(actor, signals);
  await db
    .insert(timeSuggestionDecisions)
    .values(signals.map((s) => ({ partnerId: actor.partnerId!, userId: actor.userId, signalKind: s.kind, signalId: s.id, decision: 'dismissed', timeEntryId: null })))
    .onConflictDoNothing()
    .returning();
  actor.recordAuditMutation?.({ action: 'time_suggestion.dismissed', entryId: signals.map((s) => s.id).join('+'), orgId: null });
}

/** "Re-suggest": removes the actor's dismissed rows AND confirmed tombstones (entry deleted). Idempotent. */
export async function undismissTimeSuggestions(signals: SuggestionSignalRef[], actor: SuggestionActor): Promise<void> {
  await requireEnabled(actor);
  await db.delete(timeSuggestionDecisions).where(and(
    eq(timeSuggestionDecisions.userId, actor.userId),
    eq(timeSuggestionDecisions.signalKind, 'remote_session'),
    inArray(timeSuggestionDecisions.signalId, signals.map((s) => s.id)),
    or(
      eq(timeSuggestionDecisions.decision, 'dismissed'),
      and(eq(timeSuggestionDecisions.decision, 'confirmed'), isNull(timeSuggestionDecisions.timeEntryId)),
    ),
  ));
  actor.recordAuditMutation?.({ action: 'time_suggestion.undismissed', entryId: signals.map((s) => s.id).join('+'), orgId: null });
}
```

Both cross-file edits belong to Task 6 (Step 9 for the `TimeEntryAuditMutation['action']` union, Step 5 for the `resourceType` switch in `writeSimpleTimeEntryAudits` / `writeBulkTimeEntryAudits`). Verify they are present before running the suite; if Task 6 was executed by a different agent and skipped them, land them here — they are listed in this task's Files block for exactly that reason.

- [ ] **Step 4: Run the whole file + typecheck**

```bash
pnpm --filter @breeze/api test -- --run src/services/timeSuggestionService.test.ts src/services/timeEntryService.test.ts
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
```

Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/timeSuggestionService.ts apps/api/src/services/timeSuggestionService.test.ts apps/api/src/services/timeEntryService.ts apps/api/src/routes/timeEntries/timeEntries.ts
git commit -m "feat(api): confirm/dismiss/undismiss time suggestions with a decisions ledger (#3900)"
```

---

### Task 9: The four routes (`routes/timeEntries/suggestions.ts`)

**Rigor: high** (this is the auth surface: scope, permission, `manageAll`, and the `.strict()` wall that keeps provenance server-side). **Author: Claude** — Codex may draft the handler bodies once handed `timeEntries.ts:174-245` verbatim, but the gate wiring and mount order are reviewed by Claude.

**Files:**
- Create: `apps/api/src/routes/timeEntries/suggestions.ts`
- Test: `apps/api/src/routes/timeEntries/suggestions.test.ts`
- Modify: `apps/api/src/routes/timeEntries/timeEntries.ts` (mount, **before** `/:id`)
- Test: `apps/api/src/routes/timeEntries/timeEntries.test.ts` (one ordering assertion)

**Interfaces:**
- Consumes: `listTimeSuggestions`, `confirmTimeSuggestion`, `dismissTimeSuggestions`, `undismissTimeSuggestions` (Tasks 7–8); `suggestionsQuerySchema`, `confirmSuggestionSchema`, `suggestionSignalsSchema` (Task 3); `timeActorFrom` / `timeEntryAuditCollector` / `writeSimpleTimeEntryAudits` / `handleServiceError` — all already in `timeEntries.ts` [verified :30-127]; export the four that are currently module-private.
- Produces: `export const timeSuggestionRoutes` (Hono sub-router, no auth middleware of its own — the hub in `routes/timeEntries/index.ts` already applies `authMiddleware` [verified]).

| Method + path (as mounted) | Sub-router path | Gate | Success |
|---|---|---|---|
| `GET /api/v1/time-entries/suggestions` | `GET /` | `scopes` + `readPerm` | 200 `ListSuggestionsResult` |
| `POST /api/v1/time-entries/suggestions/confirm` | `POST /confirm` | `scopes` + `writePerm` | 201 `{ data: entry }`, or 200 `{ data: entry, replay: true }` |
| `POST /api/v1/time-entries/suggestions/dismiss` | `POST /dismiss` | `scopes` + `writePerm` | 204 |
| `DELETE /api/v1/time-entries/suggestions/dismiss` | `DELETE /dismiss` | `scopes` + `writePerm` | 204 |

- [ ] **Step 1: Write the failing route tests**

`apps/api/src/routes/timeEntries/suggestions.test.ts` — mock the service module and drive the mounted router, exactly as `timeEntries.test.ts` does:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { svc, authState } = vi.hoisted(() => ({
  svc: {
    listTimeSuggestions: vi.fn(),
    confirmTimeSuggestion: vi.fn(),
    dismissTimeSuggestions: vi.fn(),
    undismissTimeSuggestions: vi.fn(),
  },
  authState: { scope: 'partner' as string, manageAll: false, perms: ['time_entries:read', 'time_entries:write'] },
}));

vi.mock('../../services/timeSuggestionService', () => svc);
// Reuse whatever auth/permission mock timeEntries.test.ts installs — copy that
// block verbatim rather than inventing a second one, so the two files cannot
// drift on what "partner scope" means.

import { timeEntriesRoutes } from './index';
import { TimeEntryServiceError } from '../../services/timeEntryService';

const req = (path: string, init?: RequestInit) => timeEntriesRoutes.request(path, init);
const postJson = (path: string, body: unknown) =>
  req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const UUID = '3f2f1d8e-1111-4222-8333-444455556666';
const SIG = { kind: 'remote_session', id: UUID };
// The id the auth mock reports as the signed-in user; take it from whatever
// constant timeEntries.test.ts already uses rather than declaring a second one.
const ACTOR_ID = '00000000-1111-4222-8333-444455556666';

beforeEach(() => {
  vi.clearAllMocks();
  authState.scope = 'partner';
  authState.manageAll = false;
  svc.listTimeSuggestions.mockResolvedValue({ enabled: true, date: '2026-08-29', timezone: 'UTC', suggestions: [], unloggedCount: 0 });
});

describe('GET /suggestions', () => {
  it('matches the literal path, not /:id (registration order)', async () => {
    const res = await req('/suggestions?date=2026-08-29');
    expect(res.status).toBe(200);
    expect(svc.listTimeSuggestions).toHaveBeenCalled();
    // The proof it did not fall through: the :id handler would have been called
    // with the literal string 'suggestions'.
    expect(await res.json()).toMatchObject({ data: { enabled: true } });
  });
  it('requires date and rejects a non-ISO date with 400', async () => {
    expect((await req('/suggestions')).status).toBe(400);
    expect((await req('/suggestions?date=29-08-2026')).status).toBe(400);
  });
  it('403 for an org-scoped token (F18) and for a caller without time_entries:read', async () => {
    authState.scope = 'organization';
    expect((await req('/suggestions?date=2026-08-29')).status).toBe(403);
    authState.scope = 'partner';
    authState.perms = [];
    expect((await req('/suggestions?date=2026-08-29')).status).toBe(403);
  });
  it('userId other than the actor requires manageAll (same rule as /timesheet)', async () => {
    const other = '11111111-2222-4333-8444-555566667777';
    expect((await req(`/suggestions?date=2026-08-29&userId=${other}`)).status).toBe(403);
    authState.manageAll = true;
    expect((await req(`/suggestions?date=2026-08-29&userId=${other}`)).status).toBe(200);
    expect(svc.listTimeSuggestions).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ userId: other }));
  });
  it('passing your OWN userId never needs manageAll', async () => {
    expect((await req('/suggestions?date=2026-08-29&userId=' + ACTOR_ID)).status).toBe(200);
  });
  it('maps INVALID_TZ to 400 and the 31-day bound to 400 INVALID_RANGE', async () => {
    svc.listTimeSuggestions.mockRejectedValueOnce(new TimeEntryServiceError('Unknown timezone', 400, 'INVALID_TZ'));
    const bad = await req('/suggestions?date=2026-08-29&tz=Mars/Olympus');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_TZ' });

    svc.listTimeSuggestions.mockRejectedValueOnce(new TimeEntryServiceError('too old', 400, 'INVALID_RANGE'));
    expect((await req('/suggestions?date=2020-01-01')).status).toBe(400);
  });
  it('returns 200 {enabled:false} rather than 403 when the partner flag is off (F10)', async () => {
    svc.listTimeSuggestions.mockResolvedValueOnce({ enabled: false, date: '2026-08-29', timezone: 'UTC', suggestions: [], unloggedCount: 0 });
    const res = await req('/suggestions?date=2026-08-29');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { enabled: false, suggestions: [] } });
  });
});

describe('POST /suggestions/confirm', () => {
  const body = { signals: [SIG], startedAt: '2026-08-29T14:02:00Z', endedAt: '2026-08-29T14:40:00Z' };
  it('201 with the created entry', async () => {
    svc.confirmTimeSuggestion.mockResolvedValue({ entry: { id: 'e1', durationMinutes: 38 }, replay: false });
    const res = await postJson('/suggestions/confirm', body);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { id: 'e1' } });
  });
  it('200 + replay:true when the ledger already points at an entry (F4)', async () => {
    svc.confirmTimeSuggestion.mockResolvedValue({ entry: { id: 'e1', durationMinutes: 38 }, replay: true });
    const res = await postJson('/suggestions/confirm', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replay: true, data: { id: 'e1' } });
  });
  it('REJECTS a client-supplied source / orgId / currency with 400 (D5 — .strict())', async () => {
    for (const extra of [{ source: 'remote_session' }, { orgId: UUID }, { currencyCode: 'USD' }, { currency: 'USD' }]) {
      const res = await postJson('/suggestions/confirm', { ...body, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(svc.confirmTimeSuggestion).not.toHaveBeenCalled();
  });
  it('maps every service error code to its status', async () => {
    const cases: Array<[string, number]> = [
      ['SUGGESTIONS_DISABLED', 403], ['SIGNAL_NOT_FOUND', 404], ['SIGNAL_NOT_ENDED', 409],
      ['SUGGESTION_DISMISSED', 409], ['SUGGESTION_ENTRY_DELETED', 410], ['ORG_MISMATCH', 422],
      ['ENDED_AT_REQUIRED', 400], ['RANGE_OUTSIDE_SIGNAL', 400], ['TICKET_NOT_FOUND', 404],
    ];
    for (const [code, status] of cases) {
      svc.confirmTimeSuggestion.mockRejectedValueOnce(new TimeEntryServiceError(code, status, code as never));
      const res = await postJson('/suggestions/confirm', body);
      expect(res.status, code).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
  });
  it('writes an audit row for the created entry', async () => {
    svc.confirmTimeSuggestion.mockImplementation(async (_i: unknown, actor: any) => {
      actor.recordAuditMutation({ action: 'time_entry.created', entryId: 'e1', orgId: 'o1', source: 'remote_session' });
      return { entry: { id: 'e1' }, replay: false };
    });
    await postJson('/suggestions/confirm', body);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resourceType: 'time_entry', details: expect.objectContaining({ source: 'remote_session' }),
    }));
  });
});

describe('POST|DELETE /suggestions/dismiss', () => {
  it('POST returns 204 and is idempotent', async () => {
    svc.dismissTimeSuggestions.mockResolvedValue(undefined);
    expect((await postJson('/suggestions/dismiss', { signals: [SIG] })).status).toBe(204);
    expect((await postJson('/suggestions/dismiss', { signals: [SIG] })).status).toBe(204);
  });
  it('DELETE (un-dismiss) returns 204', async () => {
    svc.undismissTimeSuggestions.mockResolvedValue(undefined);
    const res = await req('/suggestions/dismiss', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signals: [SIG] }) });
    expect(res.status).toBe(204);
  });
  it('both reject an unknown body key (.strict())', async () => {
    expect((await postJson('/suggestions/dismiss', { signals: [SIG], reason: 'nope' })).status).toBe(400);
  });
  it('both 403 when the flag is off', async () => {
    svc.dismissTimeSuggestions.mockRejectedValueOnce(new TimeEntryServiceError('off', 403, 'SUGGESTIONS_DISABLED'));
    expect((await postJson('/suggestions/dismiss', { signals: [SIG] })).status).toBe(403);
  });
});
```

Add one assertion to `timeEntries.test.ts` proving the mount order — this is the regression that a future refactor breaks:

```ts
it('/suggestions is registered before /:id and never reaches the entry handler', async () => {
  const res = await timeEntriesRoutes.request('/suggestions?date=2026-08-29');
  expect(serviceMocks.updateTimeEntry).not.toHaveBeenCalled();
  expect(res.status).not.toBe(404);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/api test -- --run src/routes/timeEntries/suggestions.test.ts src/routes/timeEntries/timeEntries.test.ts
```

Expected: FAIL — `./suggestions` does not exist; the ordering test 404s.

> Memory trap: `--run src/routes/timeEntries/` alone would miss a sibling `timeEntries.test.ts`; name both paths.

- [ ] **Step 3: Export the shared route helpers**

In `apps/api/src/routes/timeEntries/timeEntries.ts` add `export` to `timeEntryAuditCollector`, `writeSimpleTimeEntryAudits` and `handleServiceError` (`timeActorFrom` is already exported [verified :30]). No behaviour change — these move from module-private to package-private so the sibling file cannot fork them.

- [ ] **Step 4: Implement the sub-router**

`apps/api/src/routes/timeEntries/suggestions.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '@breeze/shared';
import { suggestionsQuerySchema, confirmSuggestionSchema, suggestionSignalsSchema } from '@breeze/shared';
import {
  listTimeSuggestions, confirmTimeSuggestion, dismissTimeSuggestions, undismissTimeSuggestions,
} from '../../services/timeSuggestionService';
import {
  timeActorFrom, timeEntryAuditCollector, writeSimpleTimeEntryAudits, handleServiceError,
} from './timeEntries';

// W06 (#3900). Same gates as every other time-entry route: partner|system scope
// plus TIME_ENTRIES_READ/WRITE. An org-scoped token gets the router's usual 403
// (F18). No auth middleware here — routes/timeEntries/index.ts applies it at the
// hub.
export const timeSuggestionRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action);
const writePerm = requirePermission(PERMISSIONS.TIME_ENTRIES_WRITE.resource, PERMISSIONS.TIME_ENTRIES_WRITE.action);

/** The service wants the auth scope; the actor helper does not carry it. */
function suggestionActor(c: Parameters<typeof timeActorFrom>[0], record?: Parameters<typeof timeActorFrom>[1]) {
  const auth = c.get('auth') as { scope: 'partner' | 'system' };
  return { ...timeActorFrom(c, record), scope: auth.scope };
}

timeSuggestionRoutes.get('/', scopes, readPerm, zValidator('query', suggestionsQuerySchema), async (c) => {
  try {
    const q = c.req.valid('query');
    const actor = suggestionActor(c);
    // Identical rule to GET /timesheet [verified timeEntries.ts:174-181]:
    // reading someone else's day is an admin action.
    if (q.userId && q.userId !== actor.userId && !actor.manageAll) {
      return c.json({ error: 'Viewing other technicians’ suggestions requires an admin role' }, 403);
    }
    return c.json({ data: await listTimeSuggestions(actor, q) });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeSuggestionRoutes.post('/confirm', scopes, writePerm, zValidator('json', confirmSuggestionSchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const actor = { ...audit.actor, scope: (c.get('auth') as { scope: 'partner' | 'system' }).scope };
    const { entry, replay } = await confirmTimeSuggestion(c.req.valid('json'), actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    // 200 on replay so an offline queue drain can tell "already logged" from
    // "logged just now" without parsing the body (F4).
    return c.json(replay ? { data: entry, replay: true } : { data: entry }, replay ? 200 : 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeSuggestionRoutes.post('/dismiss', scopes, writePerm, zValidator('json', suggestionSignalsSchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const actor = { ...audit.actor, scope: (c.get('auth') as { scope: 'partner' | 'system' }).scope };
    await dismissTimeSuggestions(c.req.valid('json').signals, actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.body(null, 204);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeSuggestionRoutes.delete('/dismiss', scopes, writePerm, zValidator('json', suggestionSignalsSchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const actor = { ...audit.actor, scope: (c.get('auth') as { scope: 'partner' | 'system' }).scope };
    await undismissTimeSuggestions(c.req.valid('json').signals, actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.body(null, 204);
  } catch (err) {
    return handleServiceError(c, err);
  }
});
```

In `timeEntries.ts`, directly under the `// Literal paths BEFORE /:id` comment [verified :131] and before `GET /running`:

```ts
import { timeSuggestionRoutes } from './suggestions';
// ...
// W06 (#3900). MUST stay above the `/:id` registrations — Hono matches in
// registration order, so a later mount would let PATCH /:id swallow
// /suggestions/confirm.
timeEntriesApiRoutes.route('/suggestions', timeSuggestionRoutes);
```

> Circular-import note: `suggestions.ts` imports helpers from `timeEntries.ts`, which imports `timeSuggestionRoutes` back. ESM handles this because the mount runs at module evaluation *after* the helper function declarations are hoisted — but if the bundler complains, move the four helpers into a new `routes/timeEntries/shared.ts` that both files import, and adjust the imports in both. Do not duplicate the helpers.

- [ ] **Step 5: Run to verify pass + typecheck**

```bash
pnpm --filter @breeze/api test -- --run src/routes/timeEntries/suggestions.test.ts src/routes/timeEntries/timeEntries.test.ts
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
```

Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/timeEntries/suggestions.ts apps/api/src/routes/timeEntries/suggestions.test.ts \
        apps/api/src/routes/timeEntries/timeEntries.ts apps/api/src/routes/timeEntries/timeEntries.test.ts
git commit -m "feat(api): GET/POST/DELETE time-entry suggestion routes (#3900)"
```

---

### Task 10: `time_suggestion_decisions` RLS + tenancy integration suite

**Rigor: high** (this is the CLAUDE.md new-table forge proof; nothing else in the plan owns it). **Author: Claude.**

This task exists because the first draft of this plan named `timeSuggestionDecisionsRls.integration.test.ts` in the File Structure table and in the spec's Testing section but **no task created it**. Task 2 only edits pre-existing suites; the `rls-coverage` allowlist entry proves the policy exists, not that it *works*. Registration is structural; this is functional.

**Files:**
- Create: `apps/api/src/__tests__/integration/timeSuggestionDecisionsRls.integration.test.ts`

**Interfaces:** none produced.

**Placement is load-bearing.** The file must live in `apps/api/src/__tests__/integration/` and end in `.integration.test.ts`, or it runs in **zero** CI jobs (it is excluded from the unit config and not picked up by the integration config). After the first CI run, open the Integration Tests shard log and confirm the filename actually appears — a suite that silently never ran reads exactly like a suite that passed.

- [ ] **Step 1: Write the suite (it is red until Tasks 1, 2 and 8 are on the branch)**

Copy the harness header from `apps/api/src/__tests__/integration/aiAgentsPartnerRls.integration.test.ts` [verified :1-70] — `import './setup'`, `SYSTEM_CTX`, `partnerContext`, `orgContext`, `expectSqlState`, and the `afterEach` cleanup keyed on created ids. Then:

```ts
describe('time_suggestion_decisions — RLS Shape 3 (partner-axis)', () => {
  it('forging a decision for ANOTHER partner fails with 42501', async () => {
    const a = await createPartner(); const b = await createPartner();
    const userB = await createUser({ partnerId: b.id });
    await expectSqlState(
      () => withDbAccessContext(partnerContext(a.id, []), () =>
        db.insert(timeSuggestionDecisions).values({
          partnerId: b.id, userId: userB.id, signalKind: 'remote_session',
          signalId: randomUUID(), decision: 'dismissed',
        })),
      '42501',
    );
  });

  it('partner B cannot SELECT partner A’s decisions even knowing A’s user id', async () => {
    // insert under A, then read under B: zero rows, no error (RLS filters SELECT).
  });

  it('an org-scoped context sees nothing (the table has no org policy at all)', async () => {
    // orgContext(...) SELECT -> 0 rows; INSERT -> 42501.
  });

  it('the unique index makes a concurrent double confirm yield ONE ledger row', async () => {
    // Two parallel inserts of the same (user_id,'remote_session',signal_id) in
    // separate transactions: exactly one commits, the other raises 23505.
    // Then assert count(*) = 1. This is the offline-replay idempotency key (F4).
  });

  it('deleting the time entry leaves the decision as a tombstone with time_entry_id NULL (F5)', async () => {
    // insert a time_entries row + a confirmed decision pointing at it, hard
    // delete the entry, re-read: row still present, time_entry_id IS NULL,
    // decision still 'confirmed'.
  });

  it('deleting the user CASCADEs the decisions away', async () => {});
  it('the partner erasure sweep removes decisions by partner_id', async () => {
    // Call the same dynamic partner sweep tenantCascade uses; assert 0 rows left.
  });

  describe('CHECK constraints', () => {
    it('rejects an unknown signal_kind (23514)', async () => {});
    it('rejects an unknown decision value (23514)', async () => {});
    it('rejects decision=dismissed with a non-null time_entry_id (23514)', async () => {});
  });

  it('time_entries_source_chk rejects a value outside the five-word vocabulary (23514)', async () => {
    // Insert a valid entry, then try to UPDATE its source to 'suggestion'.
    await expectSqlState(
      () => withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
        db.update(timeEntries).set({ source: 'suggestion' as never }).where(eq(timeEntries.id, entryId))),
      '23514',
    );
  });
});

describe('the signal read path under real RLS', () => {
  it('a selected-access user does not see sessions on orgs they lost access to', async () => {
    // partnerContext(partner, [orgA]) with a remote_sessions row on orgB:
    // listTimeSuggestions returns []. Narrowing, not an error (F1).
  });

  it('the hidden quick_support org IS readable in a partner request context (D4)', async () => {
    // organizations.type = 'quick_support' under the partner; a session on it
    // must appear with org:null + suggestedSource:'support_session'.
  });

  it('the day window round-trips: a session ending 23:30 local lands on the local date', async () => {
    // remote_sessions.*_at are `timestamp` written from JS Date and read back as
    // UTC wall-clock. Insert 2026-08-29T21:30Z, query date=2026-08-29 tz=Europe/Berlin
    // (23:30 local) -> present; query date=2026-08-30 -> absent.
  });

  it('F19: a session fully covered by an existing time_entries row is not suggested', async () => {
    // Real rows, no mocks: the SQL clipping and the TS union must agree.
  });
});
```

Fill each stubbed body — a `describe` with empty `it` bodies passes vacuously, which is the exact failure mode this task exists to prevent. Before trusting any red, mutate the thing under test (e.g. widen the policy to `USING (true)` locally) and confirm the relevant test flips to green, then revert.

- [ ] **Step 2: Run it and read the log, not the exit code**

```bash
cd apps/api
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm test:integration -- --run src/__tests__/integration/timeSuggestionDecisionsRls.integration.test.ts
```

Expected: PASS, with a non-zero test count for **this filename** in the output. `0 tests` is a stall or a bad path, never a green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/timeSuggestionDecisionsRls.integration.test.ts
git commit -m "test(api): RLS + tenancy contract suite for time_suggestion_decisions (#3900)"
```

---

### Task 11: W07 push hook — `buildTimeSuggestionPush`, reserved event/dedupe keys

**Rigor: high** (a push payload is lock-screen content; a leaked device or ticket string is a disclosure). **Author: Codex-eligible** (reference file: `apps/api/src/services/expoPush.ts` `buildApprovalPush` [verified :159-175] and its test).

**Build only — dispatch nothing.** W06 ships the payload builder and the reserved keys; the scheduler, quiet hours, dedupe write and the mobile listener are W07's (spec, "W07 hook"). `countUnloggedSuggestions` already exists from Task 7.

**Files:**
- Modify: `apps/api/src/services/expoPush.ts`
- Test: `apps/api/src/services/expoPush.test.ts`

**Interfaces:**
- Produces:
  - `TIME_SUGGESTIONS_PUSH_EVENT_TYPE = 'time_suggestions_daily'` (reserved `push_notifications.event_type`; that column is `varchar(100)` with no enum [verified `schema/mobile.ts:52`])
  - `timeSuggestionsDedupeKey(userId: string, date: string): string` → `` `time.unlogged:${userId}:${date}` `` (feeds `user_notifications.dedupe_key`, partial-unique on `(user_id, dedupe_key)` [verified `schema/notifications.ts:60-66`])
  - `buildTimeSuggestionPush(args: { count: number; date: string }): Pick<ExpoPushMessage, 'title'|'body'|'data'|'sound'|'priority'|'channelId'|'ttl'>`
  - `TIME_SUGGESTION_PUSH_TTL_SECONDS = 12 * 60 * 60`

- [ ] **Step 1: Write the failing tests**

```ts
describe('buildTimeSuggestionPush (W06 #3900, dispatched by W07)', () => {
  it('pluralises the count and carries only the date in data', () => {
    expect(buildTimeSuggestionPush({ count: 3, date: '2026-08-29' })).toEqual({
      title: '3 unlogged sessions today',
      body: 'Tap to review and log your remote sessions.',
      data: { type: 'time_suggestions', date: '2026-08-29' },
      sound: 'default',
      priority: 'normal',
      channelId: 'timesheet',
      ttl: TIME_SUGGESTION_PUSH_TTL_SECONDS,
    });
    expect(buildTimeSuggestionPush({ count: 1, date: '2026-08-29' }).title).toBe('1 unlogged session today');
  });

  it('is lock-screen safe: no device hostname, org name, ticket number or customer string anywhere', () => {
    const p = buildTimeSuggestionPush({ count: 2, date: '2026-08-29' });
    const blob = JSON.stringify(p);
    for (const leak of ['ACME', 'DC01', 'TKT-', 'hostname', 'orgId', 'ticketId', 'deviceId']) {
      expect(blob).not.toContain(leak);
    }
    // The payload is a pure function of (count, date) — nothing else can enter it.
    expect(Object.keys(p.data!)).toEqual(['type', 'date']);
  });

  it('does not disturb buildApprovalPush', () => {
    expect(buildApprovalPush({ approvalId: 'a1', actionLabel: 'Restart', requestingClientLabel: 'Bob' }))
      .toEqual({ title: 'Approval requested', body: 'Bob: Restart', data: { type: 'approval', approvalId: 'a1' },
                 sound: 'default', priority: 'high', channelId: 'approvals', ttl: APPROVAL_PUSH_TTL_SECONDS });
  });

  it('reserves the event type and a per-user-per-day dedupe key', () => {
    expect(TIME_SUGGESTIONS_PUSH_EVENT_TYPE).toBe('time_suggestions_daily');
    expect(timeSuggestionsDedupeKey('u1', '2026-08-29')).toBe('time.unlogged:u1:2026-08-29');
    // Same user, same day -> same key: W07's dedupe is a DB unique index, so
    // the key must be stable across processes (F16).
    expect(timeSuggestionsDedupeKey('u1', '2026-08-29')).toBe(timeSuggestionsDedupeKey('u1', '2026-08-29'));
  });
});

it('W06 dispatches no time-suggestion push', () => {
  // Guard against a well-meaning follow-up wiring dispatch in early.
  const src = readFileSync(new URL('./expoPush.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/dispatchTimeSuggestionPush|sendExpoPush\([^)]*TimeSuggestion/);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- --run src/services/expoPush.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** — add the constants and the builder beside `buildApprovalPush`; `priority: 'normal'` (this is a nudge, not an interrupt) and a 12 h TTL so a phone that was off all evening does not get yesterday's nudge at breakfast.

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/expoPush.ts apps/api/src/services/expoPush.test.ts
git commit -m "feat(api): time-suggestion push payload builder + reserved event/dedupe keys (W07 hook) (#3900)"
```

---

### Task 12: Web parity — `source` badge + Time Tracking settings tab

**Rigor: low** (read-only badge + one partner toggle; no tenancy surface). **Author: Claude** (UI work; Codex misses existing canonical components).

**Canonical location:** **Settings → Ticketing → Time Tracking**, a new partner-only tab in `TicketingSettingsTabs.tsx` beside `statuses / priorities / categories / export` [verified :27-40]. The spec's shorter "Settings → Time Tracking" names the same tab.

**Files:**
- Modify: `apps/web/src/components/time/TimesheetPage.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/tickets/TicketTimeBilling.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/settings/TimeTrackingSettingsCard.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/settings/TicketingSettingsTabs.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` and `.../tickets.json`

**Interfaces:**
- Consumes: `GET /time-entries` and `GET /time-entries/timesheet` now return `source` (Task 6); `GET|PATCH /orgs/partners/me` for the setting (Task 4).
- Produces: no exported API.

- [ ] **Step 1: Write the failing component tests**

`TimesheetPage.test.tsx`:

```ts
it('shows a provenance badge for a non-manual entry and none for a manual one', async () => {
  // entries: [{ id:'e1', source:'remote_session', ... }, { id:'e2', source:'manual', ... }]
  expect(await screen.findByTestId('time-entry-source-e1')).toHaveTextContent('From remote session');
  expect(screen.queryByTestId('time-entry-source-e2')).toBeNull();  // manual is the default; no badge noise
});
it('renders no badge when the API omits source (older server)', async () => {
  expect(screen.queryByTestId('time-entry-source-e3')).toBeNull();
});
it('labels every value in the vocabulary', () => {
  // table-driven over TIME_ENTRY_SOURCES: timer -> 'Timer', location -> 'From location',
  // remote_session -> 'From remote session', support_session -> 'From Quick Support'
});
```

`TimeTrackingSettingsCard.test.tsx`:

```ts
it('renders the toggle OFF when the partner has no timeTracking block', async () => {});
it('a stored enabled:false is rendered as off, not as "unset" (#3608 trap)', async () => {});
it('saving sends the COMPLETE timeTracking.sessionSuggestions object (PATCH deep-merges one level)', async () => {
  // assert the PATCH body is { settings: { timeTracking: { sessionSuggestions:
  //   { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 } } } }
  // — sending only { enabled } would drop the thresholds. Same rule the
  // InboundEmailCard comment states [verified InboundEmailCard.tsx:141].
});
it('a failed save surfaces an error (runAction), never a silent no-op', async () => {
  // 500 from PATCH -> error toast; the no-silent-mutations test guards this.
});
it('rejects out-of-range thresholds client-side (minSessionSeconds 0, mergeGapMinutes 999)', async () => {});
```

`TicketingSettingsTabs.test.tsx`: `it('shows the Time Tracking tab for a partner user and hides it for an org user')`.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/web test -- --run src/components/time/TimesheetPage.test.tsx \
  src/components/tickets/TicketTimeBilling.test.tsx \
  src/components/settings/TimeTrackingSettingsCard.test.tsx \
  src/components/settings/TicketingSettingsTabs.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement**

1. A tiny shared renderer (co-located, not a new package): `sourceBadgeLabelKey(source)` returning `null` for `'manual'`/`undefined` and a `longTail.time.sourceBadge.*` key otherwise. Both components import it, so the two badges can never disagree.
2. `TimesheetPage.tsx`: render `<span data-testid={`time-entry-source-${entry.id}`}>` beside the description, muted styling, no click target — it is provenance, not an action.
3. `TicketTimeBilling.tsx`: the same badge in the Time & Billing rail row.
4. `TimeTrackingSettingsCard.tsx`: `GET /orgs/partners/me` on mount; a switch plus two numeric inputs (`minSessionSeconds` 30–3600, `mergeGapMinutes` 0–120); save via `runAction` wrapping `fetchWithAuth('/orgs/partners/me', { method:'PATCH', ... })` with the **complete** `sessionSuggestions` object. Copy the catch shape from CLAUDE.md ("Web Mutation Handlers"): `if (err instanceof ActionError && err.status === 401) return;`.
5. `TicketingSettingsTabs.tsx`: add `{ id: 'timeTracking', labelKey: 'ticketingSettingsTabs.timeTracking' }` to `PARTNER_ONLY_TABS` and the corresponding panel.

- [ ] **Step 4: Locale keys in all eight directories**

```bash
ls apps/web/src/locales      # en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR (+ 2 .md files)
```

Add every new key to `en` first, then to the other seven — `localeParity.test.ts` compares key sets *and* interpolation tokens, so a missing or differently-tokenised translation is a red build, not a fallback. Keys: `settings.ticketingSettingsTabs.timeTracking`, `settings.timeTrackingSettingsCard.*` (heading, subheading, enabledLabel, minSessionLabel, mergeGapLabel, saved, saveFailed), `tickets.longTail.time.sourceBadge.{timer,location,remote_session,support_session}`.

```bash
pnpm --filter @breeze/web test -- --run src/lib/i18n/localeParity.test.ts
```

- [ ] **Step 5: Run to verify pass + lint**

```bash
pnpm --filter @breeze/web test -- --run src/components/time src/components/tickets/TicketTimeBilling.test.tsx src/components/settings/TimeTrackingSettingsCard.test.tsx src/components/settings/TicketingSettingsTabs.test.tsx src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts
pnpm lint
```

Expected: PASS. If `no-silent-mutations` flags the new card, the fix is to route the save through `runAction` — do **not** add it to `runActionAllowlist.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/time apps/web/src/components/tickets/TicketTimeBilling.tsx apps/web/src/components/tickets/TicketTimeBilling.test.tsx apps/web/src/components/settings/TimeTrackingSettingsCard.tsx apps/web/src/components/settings/TimeTrackingSettingsCard.test.tsx apps/web/src/components/settings/TicketingSettingsTabs.tsx apps/web/src/components/settings/TicketingSettingsTabs.test.tsx apps/web/src/locales
git commit -m "feat(web): time-entry source badge + Time Tracking suggestion settings (#3900)"
```

---

### Task 13: Docs + release notes

**Rigor: low.** **Author: Claude** (uses the `update-breeze-docs` skill's conventions).

Nothing in the first draft owned this, and the wave adds a partner-visible setting, four public routes and a mobile screen. Task 1 has already added the migration/index-lock bullet to `docs/release-notes/next-release-draft.md`; this task appends the feature bullet and writes the user-facing documentation.

**Files:**
- Modify: `apps/docs/src/content/docs/features/ticketing.mdx` (the "Time Tracking & Parts" section starts at :262, with `### Timer widget`, `### Manual time entry`, `### Timesheet`, `### Billables export` [verified])
- Modify: `docs/release-notes/next-release-draft.md`

- [ ] **Step 1: Document the feature**

Add `### Suggested time entries` after `### Manual time entry` in `ticketing.mdx`, covering, in the docs' second-person voice:

- What it is: after a remote session ends, the Timesheet offers it as a one-tap time entry. Nothing is ever logged without the tap.
- Turning it on: **Settings → Ticketing → Time Tracking**, off by default, partner-wide (it applies to every technician in the partner). The two thresholds — minimum session length (default 120 s) and merge gap (default 10 minutes, which combines back-to-back sessions on the same device into one suggestion).
- What is suggested: ended remote sessions (terminal, desktop, file transfer) from the chosen day, attributed to the technician who ran them, with the session's recorded duration. Quick Support sessions appear with their attribution label and no organization until a ticket is attached.
- What is **not** suggested: work you already logged (a session already covered by one of your existing time entries is hidden), sessions you dismissed, sessions still running, and sessions shorter than the minimum.
- Accuracy: a session whose duration was recorded exactly shows the duration; one whose end time was reconstructed shows an estimate; one closed by the server's stale-session reaper is marked unreliable and asks you to enter the end time yourself.
- Ticket pairing: a ticket you closed on that device around the same time is pre-selected; if two are equally likely, none is, and you pick. Changing the ticket can change the organization and therefore the currency — the picker shows the organization beside each ticket.
- Dismiss and restore: "Show dismissed → Restore" puts a suggestion back. Deleting a time entry that came from a suggestion does **not** re-suggest the session; restore it explicitly if you want it back.
- Where the provenance shows: a small badge on the timesheet row and in a ticket's Time & Billing rail.

Cross-link from `### Timesheet` (:280) with one sentence.

- [ ] **Step 2: Append the feature release note**

Under the heading Task 1 created in `docs/release-notes/next-release-draft.md`:

```markdown
- **New (off by default): auto-suggested time entries.** Partner admins can enable
  Settings → Ticketing → Time Tracking → "Suggest time entries from remote sessions".
  Technicians then see ended remote sessions on their timesheet and can log one with a
  single tap. Nothing is written without that tap, and the feature is invisible while the
  setting is off.
- **New API:** `GET /api/v1/time-entries/suggestions`,
  `POST /api/v1/time-entries/suggestions/confirm`,
  `POST|DELETE /api/v1/time-entries/suggestions/dismiss` — partner scope,
  `time_entries:read` / `time_entries:write`.
- **New field:** time entries returned by the API now carry `source`
  (`manual | timer | location | remote_session | support_session`). It is server-stamped
  and read-only; sending it on a create or update request is rejected.
- No new environment variables. No action required for existing deployments beyond the
  migration note above.
```

- [ ] **Step 3: Verify the docs build**

```bash
pnpm --filter @breeze/docs build
```

Expected: clean build, no broken-link warnings for the new anchors.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/content/docs/features/ticketing.mdx docs/release-notes/next-release-draft.md
git commit -m "docs: auto-suggested time entries + release notes (#3900)"
```

**PR A is complete here.** Open it with `Part of #3900` (not `Closes`), run the pre-PR verification listed in Task 18 Step 1, and stop at the PR.

---
## PR B — mobile

> **Do not start until W03–W05 are merged into `main` and PR A is merged.** None of the prerequisites exist on `main` today [verified: `apps/mobile/src/services/` has no `timeEntries.ts` or `timeEntryQueue.ts`; `apps/mobile/src/store/` has no `timeSlice.ts`; there is no `apps/mobile/src/screens/time/`]. Base PR B on `main`, never on PR A's branch — `ci.yml` triggers on `pull_request: branches: [main]`, so a stacked PR runs no CI at all and `gh pr checks` reads green (CLAUDE.md tenancy section).
>
> Every `Consumes` block below names a W03–W05 export. If a name differs on the merged branch, **adapt to the merged code** — never re-implement a W03 module here.

### Task 14: Mobile suggestions client (`services/timeSuggestions.ts`)

**Rigor: low** (typed fetch wrapper). **Author: Codex-eligible** (reference file: `apps/mobile/src/services/tickets.ts` + `tickets.test.ts`).

**Files:**
- Create: `apps/mobile/src/services/timeSuggestions.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `coreRequest` from `./api` (W03 uses the same helper for `services/timeEntries.ts`).
- Produces: `getSuggestions(date, tz)`, `confirmSuggestion(body)`, `dismissSuggestion(signals)`, `undismissSuggestion(signals)`, and the mirrored `TimeSuggestion` / `ListSuggestionsResult` types (including `alreadyLoggedOverlapMinutes`).

- [ ] **Step 1: Write the failing tests** (`vi.mock('./api')`, per the mobile testing convention)

```ts
it('GET encodes date and the device tz', async () => {
  await getSuggestions('2026-08-29', 'Europe/Berlin');
  expect(coreRequest).toHaveBeenCalledWith('/time-entries/suggestions?date=2026-08-29&tz=Europe%2FBerlin', expect.anything());
});
it('defaults tz to the device zone from Intl', async () => {});
it('confirm POSTs to /suggestions/confirm and never sends source/orgId/currency', async () => {
  await confirmSuggestion({ signals: [SIG], startedAt: S, endedAt: E, ticketId: null });
  const body = JSON.parse((coreRequest as Mock).mock.calls[0][1].body);
  for (const k of ['source', 'orgId', 'currency', 'currencyCode']) expect(body).not.toHaveProperty(k);
});
it('dismiss POSTs and undismiss DELETEs the same path', async () => {});
it('surfaces the HTTP status on the thrown error so the queue can branch on 409/410/404/403', async () => {});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/mobile test -- --run src/services/timeSuggestions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep it a thin typed wrapper; no retry logic (that is the queue's job).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(mobile): time-suggestions API client (#3900)`.

---

### Task 15: Two new queued write kinds + the drain-outcome table

**Rigor: high** (an offline replay that mis-branches creates a duplicate billable entry — the exact failure F19 and the ledger exist to prevent). **Author: Claude.**

**Files:**
- Modify: `apps/mobile/src/services/timeEntryQueue.ts` (W03 file — extend, do not fork)
- Create: `apps/mobile/src/services/timeSuggestionDrain.ts` (+ `.test.ts`) — the pure outcome classifier, so the branching is testable without a queue runtime
- Test: `apps/mobile/src/services/timeEntryQueue.test.ts` (W03 file — add cases)

**Interfaces:**
- Consumes: W03's `QueuedWrite` discriminated union and its drain loop.
- Produces: `QueuedWrite.kind` gains `'suggestion.confirm' | 'suggestion.dismiss'`, both keyed by the suggestion key (sorted signal ids joined by `+`) so a double tap enqueues once; `classifyDrainOutcome(status: number): 'success' | 'drop' | 'dropAndToast' | 'dropAndDisable' | 'retry'`.

- [ ] **Step 1: Write the failing tests — the outcome table from the spec is the test**

```ts
it.each([
  [201, 'success'],        // logged
  [200, 'success'],        // replay: the ledger already had it (F4) — NOT an error
  [409, 'drop'],           // dismissed, or already logged to a different entry — refetch
  [404, 'dropAndToast'],   // the session is gone
  [410, 'dropAndToast'],   // the entry was deleted (F5)
  [403, 'dropAndDisable'], // the partner turned the flag off (F10) — hide the entry points
  [422, 'dropAndToast'],   // org mismatch
  [400, 'dropAndToast'],   // range/tz rejected — never retried, it will never succeed
  [500, 'retry'],
  [503, 'retry'],
  [0,   'retry'],          // network failure
])('status %i -> %s', (status, outcome) => {
  expect(classifyDrainOutcome(status)).toBe(outcome);
});

it('the same suggestion key enqueued twice collapses to one queued write', () => {});
it('a 200 replay does NOT double-apply the entry to the time slice', () => {});
it('a queued confirm survives a cold start and drains on reconnect', () => {});
it('the queue never retries a 4xx other than 408/429', () => {});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the two kinds in the existing union and the classifier. `200` is the branch most likely to be got wrong: it means *the server already had this decision*, which is a success for the user, not a conflict.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(mobile): queued suggestion confirm/dismiss with an explicit drain-outcome table (#3900)`.

---

### Task 16: `store/timeSuggestionsSlice.ts`

**Rigor: low.** **Author: Codex-eligible** (reference file: `apps/mobile/src/store/ticketsSlice.ts` + `ticketsSlice.test.ts`).

**Files:**
- Create: `apps/mobile/src/store/timeSuggestionsSlice.ts` (+ `.test.ts`)
- Modify: `apps/mobile/src/store/index.ts` (`combineReducers` [verified :12-19])
- Test: `apps/mobile/src/store/logoutResetContract.test.ts` (existing — it enumerates slices)

**Interfaces:**
- Produces: state `{ enabled, date, items, status, pendingKeys, lastFetchedAt, error }`; thunks `fetchSuggestions`, `dismiss` (optimistic remove + undo), `undismiss`, `confirm` (removes the item and dispatches the W05 time slice's entry-added action); selectors `selectSuggestions`, `selectUnloggedCount`, `selectSuggestionsEnabled`.

- [ ] **Step 1: Write the failing tests**

```ts
it('fetch stores items and enabled from the payload', () => {});
it('enabled:false empties items so the entry points hide themselves (F10)', () => {});
it('dismiss removes the row optimistically and restores it when the thunk rejects', () => {});
it('confirm removes the row and marks the key pending until the queue drains', () => {});
it('a replayed confirm (200) resolves the pending key without adding a second entry', () => {});
it('is registered in combineReducers, so withLogoutReset wipes it on sign-out', () => {
  // reducer(stateWithItems, { type: LOGOUT }) -> initialState. A slice missing
  // from combineReducers leaks a previous account's customer data.
});
```

- [ ] **Step 2–4: red → implement → green.**
- [ ] **Step 5: Commit** — `feat(mobile): time-suggestions redux slice (#3900)`.

---

### Task 17: Screens, copy, entry points, navigation and the notification parser

**Rigor: low** (UI; no tenancy surface). **Author: Claude** (RN screens are explicitly not delegated).

**Files:**
- Create: `apps/mobile/src/screens/time/timeSuggestionCopy.ts` (+ `.test.ts`) — **all testable logic lives here**; `apps/mobile/vitest.config.ts` includes `src/**/*.test.ts` and deliberately excludes `.tsx` [verified], so a `.tsx` test would never run.
- Create: `apps/mobile/src/screens/time/TimeSuggestionsScreen.tsx`, `apps/mobile/src/screens/time/SuggestionConfirmSheet.tsx`
- Modify: `apps/mobile/src/navigation/MainNavigator.tsx` — add `TimeSuggestions: { date?: string }` to the W05 Timesheet stack's ParamList and a matching `<Stack.Screen>`; if W05 shipped no separate stack, mount it on `TicketsStackParamList` [verified :22-25]
- Modify: the W05 Timesheet screen (header banner) and `apps/mobile/src/screens/chat/components/ColdOpenChips.tsx` [verified :16] (Home chip)
- Modify: `apps/mobile/src/services/notifications.ts` — `parseTimeSuggestionsNotification` beside `parseApprovalNotification` [verified :280-287] (+ `notifications.test.ts`)
- Modify: `apps/mobile/src/lib/analytics.ts` [verified exists]

**Interfaces:**
- Produces (pure, in `timeSuggestionCopy.ts`): `rowSummary(s)` → `"38 min · desktop · ACME-DC01 · 14:02–14:40"`; `precisionChip(p)`; `ticketChipLabel(s)`; `confirmToast(s)`; `bannerLabel(count)`; `alreadyLoggedNote(minutes)`; `entryPointVisible({ enabled, count })`.
- Produces: `parseTimeSuggestionsNotification(n) → { date: string } | null`.

- [ ] **Step 1: Write the failing copy + parser tests**

```ts
describe('timeSuggestionCopy', () => {
  it('formats a recorded desktop session row', () => {
    expect(rowSummary(SUG)).toBe('38 min · desktop · ACME-DC01 · 14:02–14:40');
  });
  it('an unreliable session shows no duration and no end time', () => {});
  it('a purged Quick Support device falls back to the attribution label, never a blank (F12)', () => {});
  it('the ticket chip states WHY it was picked', () => {
    expect(ticketChipLabel(SUG)).toBe('TKT-1041 · closed by you');
  });
  it('shows the already-logged note only for a non-zero residual (F19)', () => {
    expect(alreadyLoggedNote(0)).toBeNull();
    expect(alreadyLoggedNote(10)).toBe('10 min of this window is already on your timesheet');
  });
  it('hides the entry points when disabled or the count is 0', () => {
    expect(entryPointVisible({ enabled: false, count: 3 })).toBe(false);
    expect(entryPointVisible({ enabled: true, count: 0 })).toBe(false);
    expect(entryPointVisible({ enabled: true, count: 3 })).toBe(true);
  });
});

describe('parseTimeSuggestionsNotification', () => {
  it('accepts the W06 payload shape', () => {
    expect(parseTimeSuggestionsNotification(notif({ type: 'time_suggestions', date: '2026-08-29' }))).toEqual({ date: '2026-08-29' });
  });
  it('ignores approval and alert pushes', () => {
    expect(parseTimeSuggestionsNotification(notif({ type: 'approval', approvalId: 'a1' }))).toBeNull();
    expect(parseTimeSuggestionsNotification(notif({ alertId: 'x', eventType: 'alert.triggered' }))).toBeNull();
  });
  it('ignores a payload without a date', () => {});
  it('parseApprovalNotification still works on the approval payload (no regression)', () => {});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/mobile test -- --run src/screens/time/timeSuggestionCopy.test.ts src/services/notifications.test.ts`.

- [ ] **Step 3: Implement the screens**

- `TimeSuggestionsScreen.tsx`: date header (Today / Yesterday / picker bounded to 31 days), rows grouped by device with the summary + precision chip, ticket chip with **change** (picker over `otherTickets` plus a `getTickets` search, showing the organization beside each ticket because a wrong pick changes org *and* currency), swipe-to-dismiss with an undo snackbar, a "Show dismissed" toggle backed by `DELETE /suggestions/dismiss`, and the already-logged note when the residual is non-zero.
- `SuggestionConfirmSheet.tsx`: start/end (constrained to ±15 min of the signal envelope; an unreliable session forces an explicit end time), ticket, billable, description. Success → haptic + "Logged 38 min to TKT-1041".
- Offline: the list is read-online-only — show the last response greyed with "as of 14:02"; confirm and dismiss go through the Task 15 queue with a pending spinner on the row.
- Entry points: Timesheet header banner and a Home `ColdOpenChips` entry, both fetched on focus, both hidden by `entryPointVisible`.
- Analytics: `time_suggestion_shown | confirmed | dismissed | entry_point`.

W07 owns the notification *listener* wiring, quiet hours and the preference category; W06 ships only the parser.

- [ ] **Step 4: Run to verify pass + typecheck**

```bash
pnpm --filter @breeze/mobile test -- --run
pnpm --filter @breeze/mobile exec tsc --noEmit -p tsconfig.json
```

- [ ] **Step 5: Commit** — `feat(mobile): time-suggestions screen, confirm sheet and entry points (#3900)`.

---

### Task 18: Verification sweep, then open both PRs and stop

**Rigor: high** (this is the step that catches everything the per-task greens missed). **Author: Claude.**

- [ ] **Step 1: Full local sweep**

```bash
pnpm lint
pnpm build                       # turbo typecheck runs here; there is no root typecheck script
pnpm --filter @breeze/shared test -- --run
pnpm --filter @breeze/api test -- --run
pnpm --filter @breeze/web test -- --run
pnpm --filter @breeze/mobile test -- --run
```

> If a suite stalls under a running dev stack, use `--pool=threads --maxWorkers=2`. **`0 tests` is a stall, not a green.**

- [ ] **Step 2: The contract suites `pnpm test` does not run**

```bash
cd apps/api
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm test:rls
pnpm test:integration
```

Confirm in the log that these five actually executed: `rls-coverage`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `tenantCascade`, and the new `timeSuggestionDecisionsRls`. `test:integration -- <paths>` can run the whole suite regardless of the paths given — read the log, do not trust the argument.

- [ ] **Step 3: Migration hygiene against the real base**

```bash
git fetch origin main
ls apps/api/migrations | tail -5          # is 2026-09-23-... still the last file?
git diff origin/main --stat -- apps/api/migrations
bash scripts/check-migration-naming.sh
pnpm --filter @breeze/api test -- --run src/db/autoMigrate.test.ts
```

If a later-dated migration landed on `main` while this was in flight, bump this migration's date past it (the file has not shipped, so it is still editable) and re-run. Never insert an infix into a date block you did not create; `2026-08-06` is closed.

- [ ] **Step 4: Forge the cross-tenant insert by hand (CLAUDE.md step 6)**

Re-run Task 1 Step 5 and confirm `ERROR: new row violates row-level security policy for table "time_suggestion_decisions"`.

- [ ] **Step 5: TestFlight checklist (spec Manual device checks)**

With the partner flag ON: run a terminal and a desktop session, close a ticket on that device → open Timesheet → banner count is right; confirm one, dismiss one; log a session by hand and confirm it disappears from the list (F19); kill the app offline, confirm another, reconnect → **exactly one** entry per confirm; delete an entry on web → the session stays hidden until "Show dismissed → Restore". With the flag OFF: no banner, no chip, mutations 403.

- [ ] **Step 6: Open both PRs and stop**

- PR A (Tasks 1–13): `Part of #3900`. Body: the summary paragraph, the migration + index-lock note, the registration-list table from Task 2, and the explicit statement that no push is dispatched in this wave.
- PR B (Tasks 14–18): `Closes #3900`, based on `main`.
- Dispatch CI per branch if either PR does not target `main`: `gh workflow run CI --ref <branch>`.
- **Stop at the PR.** Do not merge, do not close the wave issue. `complete_wave` runs after a human merges.
