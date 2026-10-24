---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
orchestrator: docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md
wave: W06
tracking_issue: LanternOps/breeze#9906
---

# Wisp W06 — Nudges and Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wisp reaches one named person on their phone with a short, specific nudge that deep-links into a mobile Wisp thread screen, honouring quiet hours, per-user preferences and the W05 backoff, with every nudge mirrored in the in-app bell.

**Architecture:** One delivery primitive, `services/wisp/notifyUser.ts`, takes the grant in its payload (w00 A20) and cross-checks it against the thread, consults W05 `recipientState` for backoff, `wisp_nudge_preferences` for channels/quiet override, `mobile_devices.quiet_hours` per device, writes the in-app row through W05's `deliverInApp` (`services/wisp/deliver.ts` — the single `createNotification` site under `services/wisp/`, w00 A18) under `runOutsideDbContext(withSystemDbAccessContext)`, then pushes after the context closes (the two-phase shape `ticketPush.ts` uses). W05's assessment finalizer nudge step and a new 15-minute digest sweep are its only callers. Mobile learns the `wisp_nudge` push category, gains a `HomeStack` with `WispThreadScreen` (concerns from W05 routes, reply box on the existing chat transport with `wispGrantId`) and `WispConcernSheet`, and approval-card taps open the existing `ApprovalScreen` takeover over the thread. Web gets the thread page the in-app link points at.

**Tech Stack:** Hono + Drizzle + hand-written SQL (API), BullMQ (digest), APNs/FCM/Expo via `expoPush.ts`, React Native + Expo + Redux Toolkit (mobile, Vitest `.ts`-only), Astro + React + react-i18next (web), Zod in `@breeze/shared`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md` §5 (mobile row), §7.4, §7.6, §13 "Reach one person's phone", §14. Names come from the orchestrator doc (`2026-10-19-wisp-w00-wave-map-and-contracts.md`, "Nudges (W06)"); where this plan and w00 disagree on a name, w00 wins.

## Execution split and parallelism (orchestrator, 2026-10-23)

W06 is split into three sub-issues that run **in parallel**:
- **W06a — Nudges API** (sub-issue #9912, branch `feature/9906-wisp/wave-9912`): Tasks 1 (+ edits), 2 (+ edits), 3 (+ edits), 4, 5, 6, 12, 13, 14 (service + route), 16 (route). Owns `packages/shared`, `apps/api/**`.
- **W06b — Nudges web** (sub-issue #9918, branch `feature/9906-wisp/wave-9918`): Task 7, Task 14 web panel + live line, Task 15 web, Task 16 web. Owns `apps/web/**`.
- **W06c — Nudges mobile** (sub-issue #9919, branch `feature/9906-wisp/wave-9919`): Tasks 8, 9, 10, 11, Task 13 mobile preference rows, Task 14 mobile live line, Task 15 mobile, Task 16 mobile. Owns `apps/mobile/**`.

PARALLEL GROUPS (W06a): G1 = Task 1 ∥ Task 2. G2 = Task 3 ∥ Task 13 ∥ Task 14-service (notifyUser, brief.ts, activity.ts). G3 = Task 4 ∥ Task 5 ∥ Task 6 ∥ Task 14-route ∥ Task 16-route. Task 12 last.
PARALLEL GROUPS (W06b): G1 = Task 7-helpers (`wispThreadHash.ts`) ∥ Task 7-bell (`NotificationCenter.buildHref`). G2 = Task 7-page ∥ Task 14-web ∥ Task 15-web ∥ Task 16-web (page shell vs three panels/controls — the page composes them last).
PARALLEL GROUPS (W06c): G1 = Task 8. G2 = Task 9 ∥ Task 10 ∥ Task 11. G3 = Task 13/14/15/16 mobile additions ∥ each other.
**Sonnet:** W06b locale fan-out and `WispActivityPanel` list rendering; W06c Tasks 8 (service/store plumbing), 11 (preference rows), the pure `.ts` helpers; W06a Task 2 push-spec builder, Task 5 digest sweep scaffolding.
**Rules for every sub-issue and parallel group**
- Every part bases on `origin/main` and targets `main` (never a stacked PR). The w00 contracts are the oracle, so parts can be built against each other's interfaces before they merge; web/mobile tests mock the API.
- **Shared-package ownership:** the API part owns `packages/shared` additions. A web/mobile part that needs a type not yet on main copies the file **verbatim** from the API part's branch (`git show origin/feature/9906-wisp/wave-<api#>:<path>`) into the same path; whichever PR lands second rebases, and byte-identical files resolve cleanly. Never re-type a contract.
- **In-wave fan-out:** tasks inside one PARALLEL GROUP are file-disjoint and may run as concurrent subagents in the same worktree. Concurrent subagents never run `git commit`; the fixer commits once per group after all members pass. Groups run in the listed order.
- **Model routing:** the session and every tenancy/auth/permission/migration task are Opus. Tasks marked **Sonnet** are mechanical (locale fan-out, page scaffolds, pure helpers, docs, DTO plumbing) and run on Sonnet subagents with an Opus reviewer.
- The part that lands last owns the whole-wave verification task and the PR-body statement that covers both parts.

## Global Constraints

- **Dark by default.** Every new route returns 404 and the digest worker's `initialize*` returns before constructing a Worker when `wispEnabled()` (`apps/api/src/config/env.ts`, W02) is false. `notifyUser` is never reached when the flag is off because its only callers are W05's tool and the digest. No `.env.example` change: W06 adds no flag.
- **Entitlement is commercial, not a kill switch** (spec §10): new routes sit under W02's `wispRoutes`, which already carries `requireEntitlement('wisp')` from W04.
- **Tenancy ceremony** (`docs/agents/tenancy-rls.md`): both new tables ship RLS enable + force + policies in the creating migration. Neither has `org_id`, so neither enters `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` or `CORE_TENANT_EXPORT_POLICY` (precedent: `2026-09-25-ticket-push-preferences.sql` header comment). Registration lists: `USER_ID_SCOPED_TABLES` and `PARTNER_TENANT_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`.
- **Migration slot** `2027-01-04-100500-wisp-nudge-preferences.sql`. Re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing (newest on main at plan time: `2027-01-03-140000-report-type-client-profitability.sql`; W01–W05 occupy `100000`–`100400`). Idempotent; no inner `BEGIN;`; it writes no rows so no `set_config` line is needed.
- **Status/kind columns are `text` + CHECK, never `pgEnum`.**
- **Push payloads are lock-screen safe**: title ≤ 60 chars, body ≤ 120 chars, no org or device names beyond what Wisp itself wrote into `title`/`body`; `collapseId` ≤ 64 bytes (APNs 400 BadCollapseId otherwise — `expoPush.ts:292-297`).
- **`createNotification` contract** (`apps/api/src/services/userNotifications.ts:50-60`): cross-user insert needs a system context, and a caller that may already be inside a request context wraps in `runOutsideDbContext` first. No network call inside an open DB context (#1105).
- **`user_notifications.link`** must be a relative path starting with `/` and not `//` (`2026-05-31-user-notifications-link-relative-check.sql`); `#` fragments are allowed.
- **Mobile tests are Vitest, `.ts` only** (`apps/mobile/vitest.config.ts` `include: ['src/**/*.test.ts']`, `environment: 'node'`). Screens are not render-tested; every decision a screen makes lives in a sibling `.ts` module with its own test (pattern: `approvalCopy.ts`, `pushRouting.ts`).
- **Mobile has no i18n layer** (no `locales/`, no `useTranslation` in `apps/mobile/src`); copy is inline strings, as in `SettingsSheet.tsx`. **Web** new `en` keys go into all 8 `apps/web/src/locales/*/pages.json` (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`); `localeParity.test.ts` enforces it.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts:91`); every new web file with a mutating `fetchWithAuth` is added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35` (a literal file list, not directory-wide). Web Wisp copy lives in `ai.json` under `wisp.*` (W04's convention); page titles in `pages.json` `titles.*`.
- **Sibling-wave file names (verified against the W04 plan in this tree):** W02's route file is `apps/api/src/routes/wisp.ts` exporting `wispRoutes` with `wispRoutes.use('*', requireEntitlement('wisp'))`; W04's thread routes are `apps/api/src/routes/wispThreads.ts` mounted at `/thread` (`GET /api/v1/wisp/thread?orgId=` → `{ data: { thread, grant: { id, status, orgId, expiresAt, currentRevisionId, budgetCentsPerDay, floorTickMinutes }, wideningAvailable } }`, `GET /thread/:id/sessions`), guarded by `requireScope('partner')` + `requirePermission(ai_sessions:use)` (w00 A1; `requireAiUse` is module-private to `routes/ai.ts`, not importable). W05's concern routes take `grantId` (`GET /concerns?grantId=&status=`, `POST /concerns/:id/snooze { grantId, until }`, `POST /concerns/:id/dismiss { grantId }`) and the `Concern` DTO carries `approvalIntentId` and `recipient.snoozedUntil`. W04's `createSession` refuses `wispGrantId` with `grant_scope_mismatch` when the grant is org-scoped and the session org differs, so a client creating a Wisp session passes `orgId: grant.orgId ?? undefined` (web `enterWispMode` does; mobile must too).
- **Tests**: `cd apps/api && npx vitest run <path>`; `cd apps/mobile && npx vitest run <path>`; `cd apps/web && npx vitest run <path>`; `cd packages/shared && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run`.
- **Copy**: product name "Wisp"; identifiers `wisp_*` / `wisp*`.

## Review Focus

1. **A user with two phones, one in quiet hours and one not** — the push must reach the phone that is awake and skip the other; `suppressed` is `null` because something was delivered. Pinned in Task 3 (`decideNudgeDelivery` per-device test).
2. **`notifyUser` called twice for the same concern inside one backoff window** (BullMQ retry, run re-execution) — one in-app row, one push, second call returns `{ inApp: false, pushed: 0, suppressed: 'backoff' }`. Pinned in Task 3 (dedupe-key test) and Task 12 (real-DB partial-unique index).
3. **Push tap on a nudge whose concern was resolved or dismissed meanwhile** — the thread opens, the concern row shows its terminal status, nothing crashes on a 404 from snooze/dismiss. Pinned in Task 10 (`concernSections` with resolved rows; sheet actions treat 404/409 as "already handled").
4. **Approval-card tap after the intent was decided elsewhere** — `fetchOne` rejects; the thread stays, the approvals error banner shows, no takeover flashes. Pinned in Task 10 (`approvalOpenTarget` returns `null` for a non-pending intent) and relies on `ApprovalGate`'s existing `fetchOne(...).unwrap().catch` path.
5. **Partner admin marks `high` urgent-capable, user leaves `quiet_override = 'never'`** — quiet hours still win; only the pair (`urgent_only` + urgent-capable) breaks through. Pinned in Task 3 (truth-table test).

---

## File structure

**API (`apps/api/`)**
- `migrations/2027-01-04-100500-wisp-nudge-preferences.sql` — create `wisp_nudge_preferences`, `wisp_partner_nudge_settings`, RLS.
- `src/db/schema/wispNudgePreferences.ts` — Drizzle for both tables; exported from `src/db/schema/index.ts`.
- `src/services/wisp/nudgeLinks.ts` — the two deep-link formats and their parser.
- `src/services/wisp/nudgePreferences.ts` — read/upsert prefs, read partner urgent-capable set.
- `src/services/wisp/notifyUser.ts` — the w00 export plus the pure decision function.
- `src/services/wisp/nudgeDigest.ts` + `src/jobs/wispNudgeDigest.ts` — digest selection and BullMQ wiring.
- `src/services/expoPush.ts` — `buildWispNudgePush`.
- `src/routes/wispNudgePreferences.ts` (new, mounted in W02's `src/routes/wisp.ts`) and W04's `src/routes/wispThreads.ts` (gains `GET /thread/:id`).
- W05's `src/services/aiAgents/runFinalizers.ts` — `finalizeAssessment` step (3), the `nudge` delivery, swaps `deliverInApp` for `notifyUser`.

**Shared (`packages/shared/src/validators/wispNudgePreferences.ts`)** — Zod + defaults + resolver.

**Mobile (`apps/mobile/src/`)**
- `services/notifications.ts` (`parseWispNudgeData`, channel `wisp`, badge rule), `navigation/pushRouting.ts`, `navigation/navigationRef.ts` (`navigateToWispThread`), `navigation/PushTapRouter.tsx`, `navigation/MainNavigator.tsx` (`HomeStack`).
- `services/wisp.ts` (thread, concerns, snooze, dismiss), `services/wispNudgePrefs.ts`, `services/aiChat.ts` (`wispGrantId`), `store/wispPrefsSlice.ts`.
- `screens/wisp/WispThreadScreen.tsx`, `screens/wisp/WispConcernSheet.tsx`, `screens/wisp/wispThreadState.ts`, `screens/wisp/wispConcernCopy.ts`, `screens/chat/components/SettingsSheet.tsx` (+ `screens/chat/components/WispNudgePreferenceRows.tsx`).
- `app.json` — `"scheme": "breeze"`.

**Web (`apps/web/src/`)** — `pages/ai/wisp/thread/[threadId].astro`, `components/wisp/WispThreadPage.tsx`, `components/layout/NotificationCenter.tsx` (`buildHref` fallback), `locales/*/pages.json`.

---

### Task 1: Migration, Drizzle schema and RLS registration

**Files:**
- Create: `apps/api/migrations/2027-01-04-100500-wisp-nudge-preferences.sql`
- Create: `apps/api/src/db/schema/wispNudgePreferences.ts`
- Modify: `apps/api/src/db/schema/index.ts` (after line 62 `export * from './ticketPushPreferences';`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES` map at :235, `USER_ID_SCOPED_TABLES` set at :1163)
- Test: `apps/api/src/__tests__/integration/wispNudgePreferencesRls.integration.test.ts`

**Interfaces:**
- Consumes: `users(id, partner_id)` composite unique (precedent `office-addin-user-bindings.sql`, spec §8.1); `partners(id)`.
- Produces: tables `wisp_nudge_preferences`, `wisp_partner_nudge_settings`; Drizzle exports `wispNudgePreferences`, `wispPartnerNudgeSettings`.

Columns (text + CHECK, never enum):

`wisp_nudge_preferences`
| column | type |
|---|---|
| `user_id` | `uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE` |
| `partner_id` | `uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE`; `FOREIGN KEY (user_id, partner_id) REFERENCES users(id, partner_id) ON DELETE CASCADE` (not deferrable — no `org_id`) |
| `channels` | `jsonb NOT NULL DEFAULT '{"inApp":true,"push":true}'` |
| `quiet_override` | `text NOT NULL DEFAULT 'never' CHECK (quiet_override IN ('never','urgent_only'))` — constraint name `wisp_nudge_preferences_quiet_override_chk` |
| `digest_cadence_minutes` | `integer NOT NULL DEFAULT 240 CHECK (digest_cadence_minutes BETWEEN 15 AND 1440)` |
| `last_digest_at` | `timestamptz NULL` |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

`wisp_partner_nudge_settings`
| column | type |
|---|---|
| `partner_id` | `uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE` |
| `urgent_capable_severities` | `text[] NOT NULL DEFAULT '{}' CHECK (urgent_capable_severities <@ ARRAY['info','low','medium','high']::text[])` |
| `updated_by_user_id` | `uuid NULL REFERENCES users(id) ON DELETE SET NULL` |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

Policies (spelling mirrors `2026-09-25-ticket-push-preferences.sql:33-37`):
- `wisp_nudge_preferences_user_isolation` `FOR ALL USING/WITH CHECK (breeze_current_scope() = 'system' OR user_id = breeze_current_user_id())`.
- `wisp_nudge_preferences_partner_select` `FOR SELECT USING (public.breeze_has_partner_access(partner_id))` — separate, SELECT-only, additive (the rule in `tenancy-rls.md` step 3).
- `wisp_partner_nudge_settings_isolation` `FOR ALL USING/WITH CHECK (breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))`.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON <both> TO breeze_app;`

- [ ] **Step 1: Write the failing RLS integration test** (`wispNudgePreferencesRls.integration.test.ts`, copy the fixture/`expectSqlState` shape from `ticketPushPreferencesRls.integration.test.ts:1-45`):

```ts
runDb('a user upserts and reads their own row; a same-partner peer cannot read it via the user branch', …)
  // ctxA upsert → 1 row; ctxB (scope 'partner', accessiblePartnerIds: [partner.id]) select → 1 row via partner_select; ctxB update → 0 rows
runDb('cross-partner forge is 42501', …)        // ctxB from partner P2 inserting user_id = userA → expectSqlState(…, '42501')
runDb('quiet_override outside the CHECK is 23514', …)
runDb('digest_cadence_minutes 10 is 23514; 15 and 1440 are accepted', …)
runDb('composite FK rejects a user_id whose partner differs from partner_id (23503)', …)
runDb('partner settings: partner admin context upserts; another partner reads 0 rows', …)
runDb('deleting the user cascades the preference row', …)
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispNudgePreferencesRls.integration.test.ts` (test stack up: `pnpm test-stack up`). Expected: FAIL, `relation "wisp_nudge_preferences" does not exist`.

- [ ] **Step 3: Write the migration** with the columns, constraints and policies above, every statement idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `DROP POLICY IF EXISTS` then `CREATE POLICY`). Header comment states: user-axis inside partner; no `org_id` → no cascade/merge/export registration; `channels` is `excludedOpen` by rule but the table is outside the export policy.

- [ ] **Step 4: Write the Drizzle schema** `wispNudgePreferences` / `wispPartnerNudgeSettings` matching the SQL (`jsonb('channels').$type<{ inApp: boolean; push: boolean }>()`, `text('quiet_override').$type<'never' | 'urgent_only'>()`, `text('urgent_capable_severities').array()`), export from `schema/index.ts`.

- [ ] **Step 5: Register** `['wisp_nudge_preferences', 'partner_id']` and `['wisp_partner_nudge_settings', 'partner_id']` in `PARTNER_TENANT_TABLES`, `'wisp_nudge_preferences'` in `USER_ID_SCOPED_TABLES`, each with a one-line comment naming this plan.

- [ ] **Step 6: Run** `pnpm db:migrate && pnpm db:check-drift`, the file-level guards `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`, the new integration test, and `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Expected: all PASS.

- [ ] **Step 7: Commit** — `feat(wisp): wisp_nudge_preferences + partner urgent-capable settings (W06 T1)`.

---

### Task 2: Shared validators and the push spec builder

**Files:**
- Create: `packages/shared/src/validators/wispNudgePreferences.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/validators/index.ts:1089` (add `export * from './wispNudgePreferences';`)
- Modify: `apps/api/src/services/expoPush.ts` (after `buildTicketPush`, :273-306)
- Test: `apps/api/src/services/expoPush.test.ts` (new `describe('buildWispNudgePush')`)

**Interfaces:**
- Produces (shared):
```ts
export const wispNudgeChannelsSchema = z.object({ inApp: z.boolean(), push: z.boolean() });
export const wispQuietOverrideSchema = z.enum(['never', 'urgent_only']);
export const wispNudgePreferencesSchema = z.object({ channels: wispNudgeChannelsSchema, quietOverride: wispQuietOverrideSchema, digestCadenceMinutes: z.number().int().min(15).max(1440) });
export type WispNudgePreferences = z.infer<typeof wispNudgePreferencesSchema>;
export const updateWispNudgePreferencesSchema = wispNudgePreferencesSchema.partial().strict().refine(/* at least one key */);
export const WISP_NUDGE_PREFERENCE_DEFAULTS: WispNudgePreferences = Object.freeze({ channels: { inApp: true, push: true }, quietOverride: 'never', digestCadenceMinutes: 240 });
export function resolveWispNudgePrefs(row: Partial<WispNudgePreferences> | null | undefined): WispNudgePreferences; // total, like resolveTicketPushPrefs
export const wispUrgentCapableSeveritiesSchema = z.array(z.enum(['info', 'low', 'medium', 'high'])).max(4);
```
- Produces (API):
```ts
export const WISP_NUDGE_PUSH_TTL_SECONDS = 14_400;
export function buildWispNudgePush(args: { threadId: string; concernId: string | null; grantId: string; title: string; body: string; deepLink: string; approvalIntentId?: string | null }): PushSpec;
```
  Fixed values: `data = { type: 'wisp_nudge', threadId, concernId, grantId, deepLink, approvalIntentId? }` (key present only when non-null); `channelId: 'wisp'`; `collapseId: concernId ? \`wisp:${concernId}\` : \`wisp:digest:${threadId}\`` (41 / 48 bytes); `threadId: \`wisp:${threadId}\``; `category: 'BREEZE_WISP_NUDGE'`; `priority: 'normal'` (a nudge, like `buildTimeSuggestionPush`); `sound: 'default'`; title sliced to 60, body to 120.

- [ ] **Step 1: Write failing shared tests** (`wispNudgePreferences.test.ts`): `resolveWispNudgePrefs(null)` equals defaults; garbage `quietOverride` resolves to `'never'`; `digestCadenceMinutes: 10` fails schema; `updateWispNudgePreferencesSchema.safeParse({})` fails; `{ userId: 'x' }` fails (strict).
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/validators/wispNudgePreferences.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement the shared module** and the index export.
- [ ] **Step 4: Write failing API tests** in `expoPush.test.ts` mirroring `describe('buildTicketPush')` (:503-550): data shape and `type: 'wisp_nudge'`; `approvalIntentId` key absent when null; `collapseId` ≤ 64 bytes for uuid inputs; title/body truncation; `priority === 'normal'`; `channelId === 'wisp'`.
- [ ] **Step 5: Run** `cd apps/api && npx vitest run src/services/expoPush.test.ts` — FAIL (`buildWispNudgePush is not a function`).
- [ ] **Step 6: Implement `buildWispNudgePush`** in `expoPush.ts`.
- [ ] **Step 7: Run both suites** — PASS.
- [ ] **Step 8: Commit** — `feat(wisp): nudge preference validators + wisp_nudge push spec (W06 T2)`.

---

### Task 3: `notifyUser` — links, preferences and the delivery decision

**Files:**
- Create: `apps/api/src/services/wisp/nudgeLinks.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/wisp/nudgePreferences.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/wisp/notifyUser.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: W04 `wisp_threads` (`id`, `grant_id`, `partner_id`); W05 `recipientState(concernId, grantId)`, `wisp_concerns` (`id`, `org_id`, `severity`), **`deliverInApp(d: InAppDelivery)`** (`services/wisp/deliver.ts`, the single `createNotification` site, w00 A18; `InAppDelivery` carries `threadId`, `grantId`, `deepLink`, `concernId`, `approvalIntentId`, `dedupeKey`, `priority` and returns `{ created }`); `userPushTargetsQuery` + `isInQuietHours` pattern (`services/ticketPush.ts:201-307`); `dispatchPushToTokens` (`services/expoPush.ts:353`); `checkNotificationThrottle` (`services/notificationThrottle.ts:40`); `runOutsideDbContext` (`db/index.ts:1226`), `withSystemDbAccessContext` (`db/index.ts:1005`).
- Produces:
```ts
// nudgeLinks.ts
export function mobileDeepLink(threadId: string, concernId: string | null): string;   // breeze://wisp/thread/:threadId[?concern=:concernId]
export function webDeepLink(threadId: string, concernId: string | null): string;      // /ai/wisp/thread/:threadId[#concern=:id]
export function parseWispDeepLink(url: string): { threadId: string; concernId: string | null } | null; // accepts both forms

// nudgePreferences.ts  (system or request context — pure reads/upserts)
export async function loadNudgePrefs(userId: string): Promise<WispNudgePreferences>;              // missing row = defaults
export async function upsertNudgePrefs(userId: string, partnerId: string, patch: UpdateWispNudgePreferences): Promise<WispNudgePreferences>;
export async function loadUrgentCapableSeverities(partnerId: string): Promise<ConcernSeverity[]>; // missing row = []
export async function upsertUrgentCapableSeverities(partnerId: string, severities: ConcernSeverity[], byUserId: string): Promise<ConcernSeverity[]>;

// notifyUser.ts — EXACT w00 export (+ grantId per w00 A20)
export type NudgePayload = { userId: string; category: 'wisp_nudge'; title: string; body: string; deepLink: string; concernId: string | null; threadId: string; grantId: string; approvalIntentId?: string | null };
export async function notifyUser(p: NudgePayload): Promise<{ inApp: boolean; pushed: number; suppressed: 'quiet_hours' | 'prefs' | 'backoff' | null }>;
// exported for tests / the digest
export type NudgeSuppressedReason = 'quiet_hours' | 'prefs' | 'backoff' | null;
export function nudgeDedupeKey(k: { concernId: string | null; grantId: string; threadId: string; nextEligibleNudgeAt: Date | null; now: Date; digestCadenceMinutes: number }): string;
export function decideNudgeDelivery(input: { prefs: WispNudgePreferences; urgentCapable: boolean; devices: Array<{ tokens: TaggedPushToken[]; quietHours: QuietHoursConfig | null }>; now: Date }): { inApp: boolean; pushTokens: TaggedPushToken[]; suppressed: NudgeSuppressedReason };
```

Decisions the implementer cannot make alone:
- **Dedupe key**: concern nudge → `wisp.nudge:${concernId}:${grantId}:${nextEligibleNudgeAt?.toISOString() ?? 'first'}`; digest (`concernId === null`) → `wisp.digest:${threadId}:${bucketIso}` where `bucketIso` is `now` floored to `digestCadenceMinutes` (UTC). This is what makes the call idempotent per (concernId, grantId, nextEligibleNudgeAt) through `user_notifications_user_dedupe_key_uq`.
- **Grant/thread consistency**: `wisp_threads.grant_id` must equal `p.grantId`; a mismatch throws (caller bug — one thread per grant, spec §6). The grantor is `p.userId`.
- **Backoff**: when `concernId` is set and `recipientState(...).nextEligibleNudgeAt > now`, or `dismissedAt` is set, or `snoozedUntil > now` → return `{ inApp: false, pushed: 0, suppressed: 'backoff' }` before any write. Same when `deliverInApp` returns `{ created: false }` (dedupe key already existed) — nothing is pushed either.
- **Throttle**: `checkNotificationThrottle('wisp-nudge', \`user:${userId}\`, 12, 3600)` not allowed → `'backoff'` (the in-app row is still written; only push is throttled).
- **Prefs**: `channels.inApp === false && channels.push === false` → `'prefs'`, no write, no push. `push === false` → in-app only, `suppressed: 'prefs'`. `inApp === false` → push only (`inApp: false`).
- **Quiet hours**: per device (`isInQuietHours(row.quietHours, now)`); a device breaks through only when `urgentCapable && prefs.quietOverride === 'urgent_only'`. `urgentCapable = concern.severity ∈ loadUrgentCapableSeverities(thread.partnerId)`; `false` for digests. If every token-bearing device is quiet → `'quiet_hours'` (in-app still written). No devices at all → `pushed: 0`, `suppressed: null`.
- **In-app row**: `deliverInApp({ userId, orgId: concern?.orgId ?? null, title, body, link: webDeepLink(threadId, concernId), priority: severity === 'high' ? 'high' : 'normal', concernId, approvalIntentId, threadId, grantId, deepLink, dedupeKey })` — W05's `deliver.ts` writes `type: 'ai'` and `metadata: { wispThreadId, concernId, grantId, intentId, deepLink }` (an existing `NOTIFICATION_TYPES` member, `packages/shared/src/constants/notificationTypes.ts:12`; no enum migration). `notifyUser.ts` never imports `createNotification` (w00 A18).
- **Context shape**: `runOutsideDbContext(() => withSystemDbAccessContext(async () => { thread, concern, recipientState, prefs, urgent set, device rows }))` then `deliverInApp` (it opens its own system context) returns the push tokens; `dispatchPushToTokens(tokens, buildWispNudgePush(...), 'wisp-nudge')` runs **after** that promise resolves. `getUserPushTokens` (`expoPush.ts:137`) is not used because it drops `quiet_hours`; reuse `userPushTargetsQuery([userId])` from `ticketPush.ts:201`.

- [ ] **Step 1: Write failing tests for `nudgeLinks`** (`nudgeLinks.test.ts`):

```ts
it('builds the mobile link with and without a concern', () => {
  expect(mobileDeepLink('t1', 'c1')).toBe('breeze://wisp/thread/t1?concern=c1');
  expect(mobileDeepLink('t1', null)).toBe('breeze://wisp/thread/t1');
});
it('builds the web link with the concern in the hash', () => {
  expect(webDeepLink('t1', null)).toBe('/ai/wisp/thread/t1');
  expect(webDeepLink('t1', 'c1')).toBe('/ai/wisp/thread/t1#concern=c1');
});
it('parses both forms and rejects anything else', () => {
  expect(parseWispDeepLink('breeze://wisp/thread/t1?concern=c1')).toEqual({ threadId: 't1', concernId: 'c1' });
  expect(parseWispDeepLink('/ai/wisp/thread/t1#concern=c1')).toEqual({ threadId: 't1', concernId: 'c1' });
  expect(parseWispDeepLink('/ai/wisp/thread/t1')).toEqual({ threadId: 't1', concernId: null });
  expect(parseWispDeepLink('/tickets/1')).toBeNull();
  expect(parseWispDeepLink('breeze://wisp/thread/')).toBeNull();
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/wisp/nudgeLinks.test.ts` — FAIL. Implement. PASS.
- [ ] **Step 3: Write failing tests for `decideNudgeDelivery`** (pure, no mocks; `quiet = { start: '00:00', end: '23:59', enabled: true }`, `awake = null`, `tok = (t) => ({ token: t, platform: 'ios', provider: 'apns' })`):

```ts
const prefs = WISP_NUDGE_PREFERENCE_DEFAULTS;
it('Review Focus 1: pushes to the awake phone and skips the quiet one', () => {
  const r = decideNudgeDelivery({ prefs, urgentCapable: false, now, devices: [{ tokens: [tok('a')], quietHours: quiet }, { tokens: [tok('b')], quietHours: awake }] });
  expect(r).toEqual({ inApp: true, pushTokens: [tok('b')], suppressed: null });
});
it('all phones quiet + quietOverride never → quiet_hours, in-app still true', () => {
  expect(decideNudgeDelivery({ prefs, urgentCapable: true, now, devices: [{ tokens: [tok('a')], quietHours: quiet }] }))
    .toEqual({ inApp: true, pushTokens: [], suppressed: 'quiet_hours' });
});
it('urgent-capable + urgent_only breaks through quiet hours', () => {
  const r = decideNudgeDelivery({ prefs: { ...prefs, quietOverride: 'urgent_only' }, urgentCapable: true, now, devices: [{ tokens: [tok('a')], quietHours: quiet }] });
  expect(r.pushTokens).toEqual([tok('a')]);
});
it('Review Focus 5: urgent-capable alone (quietOverride never) does not break through', () => {
  expect(decideNudgeDelivery({ prefs, urgentCapable: true, now, devices: [{ tokens: [tok('a')], quietHours: quiet }] }).suppressed).toBe('quiet_hours');
});
it('urgent_only without an urgent-capable concern does not break through', () => {
  expect(decideNudgeDelivery({ prefs: { ...prefs, quietOverride: 'urgent_only' }, urgentCapable: false, now, devices: [{ tokens: [tok('a')], quietHours: quiet }] }).suppressed).toBe('quiet_hours');
});
it('both channels off → prefs, nothing delivered', () => {
  expect(decideNudgeDelivery({ prefs: { ...prefs, channels: { inApp: false, push: false } }, urgentCapable: false, now, devices: [] }))
    .toEqual({ inApp: false, pushTokens: [], suppressed: 'prefs' });
});
it('push off → in-app only, reported as prefs', () => {
  expect(decideNudgeDelivery({ prefs: { ...prefs, channels: { inApp: true, push: false } }, urgentCapable: false, now, devices: [{ tokens: [tok('a')], quietHours: awake }] }))
    .toEqual({ inApp: true, pushTokens: [], suppressed: 'prefs' });
});
it('no devices → nothing to push, not a suppression', () => {
  expect(decideNudgeDelivery({ prefs, urgentCapable: false, now, devices: [] })).toEqual({ inApp: true, pushTokens: [], suppressed: null });
});
```

- [ ] **Step 4: Write failing tests for `nudgeDedupeKey`**:

```ts
it('is a pure function of its inputs', () => { expect(nudgeDedupeKey(k)).toBe(nudgeDedupeKey({ ...k })); });
it('concern key carries concernId, grantId and the backoff instant', () => {
  expect(nudgeDedupeKey({ concernId: 'c1', grantId: 'g1', threadId: 't1', nextEligibleNudgeAt: new Date('2026-10-19T10:00:00Z'), now, digestCadenceMinutes: 240 }))
    .toBe('wisp.nudge:c1:g1:2026-10-19T10:00:00.000Z');
  expect(nudgeDedupeKey({ ...k, nextEligibleNudgeAt: null })).toBe('wisp.nudge:c1:g1:first');
});
it('digest key floors now to the cadence', () => {
  const at = (s: string) => nudgeDedupeKey({ concernId: null, grantId: 'g1', threadId: 't1', nextEligibleNudgeAt: null, now: new Date(s), digestCadenceMinutes: 15 });
  expect(at('2026-10-19T10:07:00Z')).toBe(at('2026-10-19T10:14:59Z'));
  expect(at('2026-10-19T10:16:00Z')).not.toBe(at('2026-10-19T10:14:59Z'));
  expect(at('2026-10-19T10:07:00Z')).toBe('wisp.digest:t1:2026-10-19T10:00:00.000Z');
});
```

- [ ] **Step 5: Write failing tests for `notifyUser`** with `vi.mock` on `../../db` (`runOutsideDbContext: (fn) => fn()`, `withSystemDbAccessContext: (fn) => fn()`), `./deliver` (`deliverInApp`), `../expoPush` (`dispatchPushToTokens`), `./concerns` (`recipientState`), `./nudgePreferences`, `../notificationThrottle`, and a `db.select` chain yielding the thread (`grantId: 'g1', partnerId: 'p1'`), concern (`orgId: 'o1', severity: 'high'`) and device rows:

```ts
const payload: NudgePayload = { userId: 'u1', category: 'wisp_nudge', title: 'Ticket 4021 stale', body: '3 days, printer driver', deepLink: 'breeze://wisp/thread/t1?concern=c1', concernId: 'c1', threadId: 't1', grantId: 'g1', approvalIntentId: 'i1' };
it('Review Focus 2: a future nextEligibleNudgeAt short-circuits as backoff with no writes', async () => {
  recipientState.mockResolvedValue({ nudgeCount: 1, nextEligibleNudgeAt: new Date(Date.now() + 60_000), snoozedUntil: null, dismissedAt: null });
  await expect(notifyUser(payload)).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'backoff' });
  expect(deliverInApp).not.toHaveBeenCalled(); expect(dispatchPushToTokens).not.toHaveBeenCalled();
});
it('an existing dedupe key (deliverInApp → { created: false }) pushes nothing', async () => {
  deliverInApp.mockResolvedValue({ created: false });
  await expect(notifyUser(payload)).resolves.toEqual({ inApp: false, pushed: 0, suppressed: 'backoff' });
  expect(dispatchPushToTokens).not.toHaveBeenCalled();
});
it('a thread whose grant_id differs from payload.grantId throws (caller bug) and writes nothing', …);
it('happy path writes the in-app row, then pushes after the context closes', async () => {
  const order: string[] = [];
  deliverInApp.mockImplementation(async () => { order.push('inApp'); return { created: true }; });
  dispatchPushToTokens.mockImplementation(async () => { order.push('push'); return { tokensFound: 2, dispatched: 2, errors: 0 }; });
  await expect(notifyUser(payload)).resolves.toEqual({ inApp: true, pushed: 2, suppressed: null });
  expect(deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', orgId: 'o1', priority: 'high', link: '/ai/wisp/thread/t1#concern=c1', dedupeKey: expect.stringMatching(/^wisp\.nudge:c1:g1:/), threadId: 't1', concernId: 'c1', grantId: 'g1', approvalIntentId: 'i1', deepLink: 'breeze://wisp/thread/t1?concern=c1' }));
  expect(dispatchPushToTokens).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ data: expect.objectContaining({ type: 'wisp_nudge', threadId: 't1', grantId: 'g1', approvalIntentId: 'i1' }) }), 'wisp-nudge');
  expect(order).toEqual(['inApp', 'push']);
});
it('throttle denied → in-app written, push withheld, reported as backoff', async () => {
  checkNotificationThrottle.mockResolvedValue({ allowed: false, currentCount: 13 });
  await expect(notifyUser(payload)).resolves.toEqual({ inApp: true, pushed: 0, suppressed: 'backoff' });
});
it('digest payload (concernId null) skips recipientState and uses the digest key', async () => {
  await notifyUser({ ...payload, concernId: null, approvalIntentId: null, deepLink: 'breeze://wisp/thread/t1' });
  expect(recipientState).not.toHaveBeenCalled();
  expect(deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, link: '/ai/wisp/thread/t1', dedupeKey: expect.stringMatching(/^wisp\.digest:t1:/) }));
});
```
- [ ] **Step 6: Run** `npx vitest run src/services/wisp/notifyUser.test.ts src/services/wisp/nudgePreferences.test.ts` — FAIL (modules missing).
- [ ] **Step 7: Implement** `nudgePreferences.ts` (Drizzle upsert `onConflictDoUpdate({ target: wispNudgePreferences.userId, set })`, like `routes/users.ts:711-714`) and `notifyUser.ts` per the decisions above.
- [ ] **Step 8: Run the three suites** — PASS.
- [ ] **Step 9: Commit** — `feat(wisp): notifyUser delivery primitive with quiet hours, prefs and backoff (W06 T3)`.

---

### Task 4: Swap the W05 `nudge` delivery onto `notifyUser`

**Files:**
- Modify: W05's `apps/api/src/services/aiAgents/runFinalizers.ts` — `finalizeAssessment` step (3) only (the `nudge` outcome tool's schema and the capture in `outcomeTools.ts` are untouched)
- Test: `apps/api/src/services/aiAgents/runFinalizers.assessment.test.ts` (W05 file; extend the nudge cases) and `apps/api/src/services/wisp/notifyUser.callers.contract.test.ts` (new)

**Interfaces:**
- Consumes: `notifyUser(p: NudgePayload)` (Task 3); `mobileDeepLink` (Task 3); W05's `recordNudge(concernId, grantId, at)` (`services/wisp/concerns.ts`).
- Produces: no new names. Contract: step (3) builds `NudgePayload` with `category: 'wisp_nudge'`, `userId: ceiling.grantorUserId`, `grantId: run.grantId`, `threadId`, `deepLink: mobileDeepLink(threadId, concernId)`, `approvalIntentId` passed through from the tool input when present; it calls `recordNudge` **only when** `suppressed !== 'backoff'`; W05's eligibility pre-checks (snooze/dismiss/backoff/digest-only) stay in front of the call.

- [ ] **Step 1: Write the failing finalizer cases**: with `notifyUser` mocked to `{ inApp: true, pushed: 1, suppressed: null }`, `recordNudge` is called once and `deliverInApp` is no longer called from step (3); with `suppressed: 'backoff'`, `recordNudge` is not called and `outcome.assessmentSkipped` gains `'nudge_backoff'`.
- [ ] **Step 2: Write the failing callers contract test**: read `apps/api/src/services` recursively; assert `createNotification(` appears in exactly one file under `services/wisp/` — `services/wisp/deliver.ts` (w00 A18) — and nowhere under `services/aiAgents/`; assert `notifyUser(` is called only from `services/aiAgents/runFinalizers.ts` and `services/wisp/nudgeDigest.ts` (allowlist in the test); assert `deliverInApp(` is called only from `services/wisp/{notifyUser,budget,watches,assessment}.ts` (W05's non-nudge notices keep using it directly).
- [ ] **Step 3: Run** `npx vitest run src/services/aiAgents/runFinalizers.assessment.test.ts src/services/wisp/notifyUser.callers.contract.test.ts` — FAIL.
- [ ] **Step 4: Replace the delivery** in step (3); leave `toolInputSchemas` / `OUTCOME_TOOL_NAMES` / `TOOL_TIERS` untouched (w00 reconciliation 4).
- [ ] **Step 5: Run** the two suites plus W05's `assessmentProfile.test.ts` and `deliver.test.ts` — PASS.
- [ ] **Step 6: Commit** — `refactor(wisp): nudge outcome tool delivers through notifyUser (W06 T4)`.

---

### Task 5: Digest sweep for concerns past two unanswered nudges

**Files:**
- Create: `apps/api/src/services/wisp/nudgeDigest.ts` (+ `.test.ts`)
- Create: `apps/api/src/jobs/wispNudgeDigest.ts` (+ `.test.ts`)
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (add `'wisp-nudge-digest': '13,28,43,58 * * * *'` beside `:267`; minutes 13/28/43/58 are unused by any existing entry)
- Modify: `apps/api/src/services/workerRegistry.ts` (entry after `connectionHealthDigestWorker` at :225-232, `placement: 'global'`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (`consumers('wispNudgeDigestWorker', ['wisp-nudge-digest'])` beside `:289`)

**Interfaces:**
- Consumes: W02 `wisp_grants` (`id`, `grantor_user_id`, `status`), W04 `wisp_threads` (`grant_id`), W05 `wisp_concern_recipients` (`concern_id`, `grant_id`, `nudge_count`, `snoozed_until`, `dismissed_at`) + `wisp_concerns` (`summary`, `severity`, `status`); `loadNudgePrefs`; `notifyUser`; `wispEnabled()`.
- Produces:
```ts
// nudgeDigest.ts
export type DigestCandidate = { grantId: string; threadId: string; userId: string; concerns: Array<{ id: string; summary: string; severity: ConcernSeverity }> };
export function digestDue(prefs: WispNudgePreferences, lastDigestAt: Date | null, now: Date): boolean;      // lastDigestAt null or now - last ≥ cadence
export function buildDigestText(concerns: DigestCandidate['concerns']): { title: string; body: string };   // title `Wisp: ${n} concern${n===1?'':'s'} waiting`; body = up to 3 summaries joined by ' · ', each ≤ 40 chars
export async function selectDigestCandidates(now: Date): Promise<DigestCandidate[]>;                      // system ctx; active grants; recipients with nudge_count >= 2, status 'open', not snoozed/dismissed; ≥ 2 concerns per grant
export async function runNudgeDigest(now?: Date): Promise<{ candidates: number; sent: number; suppressed: number }>; // for each due candidate: notifyUser({ userId, category: 'wisp_nudge', concernId: null, threadId, grantId: candidate.grantId, deepLink: mobileDeepLink(threadId, null), …buildDigestText }); on inApp||pushed set last_digest_at = now
// jobs/wispNudgeDigest.ts
export const WISP_NUDGE_DIGEST_QUEUE = 'wisp-nudge-digest';
export async function initializeWispNudgeDigestWorker(): Promise<void>;  // returns immediately when !wispEnabled(); otherwise exactly the shape of connectionHealthDigest.ts:26-55 with REPEAT_JOB_ID 'wisp-nudge-digest'
export async function shutdownWispNudgeDigestWorker(): Promise<void>;
```

- [ ] **Step 1: Write failing pure tests**: `digestDue` — `lastDigestAt: null` → true; 239 min ago with cadence 240 → false; 240 → true. `buildDigestText` — 1 concern singular title; 5 concerns → body has 3 entries; a 90-char summary truncated to 40 with `…`.
- [ ] **Step 2: Write failing `runNudgeDigest` test** with `selectDigestCandidates` and `notifyUser` mocked: two candidates, one not due → `notifyUser` called once with `concernId: null`, `threadId` and `grantId` of the due candidate, `deepLink: mobileDeepLink(threadId, null)`; `last_digest_at` update issued only for the delivered one; a `suppressed: 'prefs'` result counts in `suppressed` and does not update `last_digest_at`.
- [ ] **Step 3: Write failing job test**: with `wispEnabled` mocked false, `initializeWispNudgeDigestWorker()` constructs no `Worker` and adds no repeatable job (mock `bullmq`); with it true, `queue.add` is called with `{ jobId: 'wisp-nudge-digest', repeat: { pattern: '13,28,43,58 * * * *' } }`.
- [ ] **Step 4: Run** `npx vitest run src/services/wisp/nudgeDigest.test.ts src/jobs/wispNudgeDigest.test.ts` — FAIL.
- [ ] **Step 5: Implement** both modules and the three registry edits.
- [ ] **Step 6: Run** the two suites plus `npx vitest run src/jobs/scheduleRegistry src/jobs/workerReadinessManifest src/services/workerRegistry` (registry self-tests pick up the new key) — PASS.
- [ ] **Step 7: Commit** — `feat(wisp): 15-minute nudge digest for concerns past two unanswered nudges (W06 T5)`.

---

### Task 6: Preference, partner-setting and thread-by-id routes

**Files:**
- Create: `apps/api/src/routes/wispNudgePreferences.ts` (+ `wispNudgePreferences.test.ts`)
- Modify: W04's `apps/api/src/routes/wispThreads.ts` (+ its `wispThreads.test.ts`) — add `GET /:id`
- Modify: W02's `apps/api/src/routes/wisp.ts` — `wispRoutes.route('/nudge-preferences', wispNudgePreferenceRoutes); wispRoutes.route('/nudge-settings', wispNudgeSettingsRoutes);` after W04's `wispRoutes.route('/thread', wispThreadRoutes)`

**Interfaces:**
- Consumes: `wispEnabled()` 404 gate, `requireScope('partner')`, `requirePermission(ai_sessions:use)` and `requireEntitlement('wisp')` (all already on `wispRoutes`, W02/W04 — inherited by these sub-routers; w00 A1); `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts`); `writeRouteAudit` (pattern `routes/users.ts:721-728`); `zValidator`; Task 3 `nudgePreferences.ts`; W04 `readOwnPartnerAxisRows` (`db/partnerAxisRead.ts:101`) for the thread read.
- Produces:
```ts
export const wispNudgePreferenceRoutes = new Hono();  // GET /, PUT /
export const wispNudgeSettingsRoutes = new Hono();    // GET /, PUT /
// GET /api/v1/wisp/nudge-preferences → 200 { data: { settings: WispNudgePreferences } }  (missing row = defaults, no insert on read)
// PUT /api/v1/wisp/nudge-preferences  body updateWispNudgePreferencesSchema → 200 { data: { settings } }
//   audit: action 'wisp.nudge_preferences.update', resourceType 'user', resourceId auth.user.id, orgId auth.orgId ?? null; user id from auth, never the body
// GET /api/v1/wisp/nudge-settings → 200 { data: { settings: { urgentCapableSeverities: ConcernSeverity[] } } }  (any partner member)
// PUT /api/v1/wisp/nudge-settings  body z.object({ urgentCapableSeverities: wispUrgentCapableSeveritiesSchema }).strict()
//   403 { code: 'partner_admin_required' } unless canManagePartnerWidePolicies(auth); audit 'wisp.nudge_settings.update', resourceType 'partner'
// GET /api/v1/wisp/thread/:id (added to W04's wispThreadRoutes) → 200 { data: { thread: WispThread; grant: { id, status, orgId, expiresAt, currentRevisionId } } }
//   same payload members as W04's GET /thread; 404 { code: 'thread_not_found' } unless the thread's grant.grantorUserId === auth.user.id
//   (partner-admin read of another tech's thread is NOT added — W04 call #9 defers the admin listing; existence-neutral 404)
```

- [ ] **Step 1: Write failing route tests** (pattern `routes/users.test.ts:4111-4150`: `authAsDefaultPartner()`, mock `db`, `config/env` `wispEnabled`, `services/partnerWideAccess`, `services/wisp/nudgePreferences`):

```ts
describe('GET /wisp/nudge-preferences', () => {
  it('returns defaults when no row exists and does not insert', async () => {
    const res = await app.request('/wisp/nudge-preferences');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { settings: { channels: { inApp: true, push: true }, quietOverride: 'never', digestCadenceMinutes: 240 } } });
    expect(upsertNudgePrefs).not.toHaveBeenCalled();
  });
  it('is 404 when wispEnabled() is false', …);
});
describe('PUT /wisp/nudge-preferences', () => {
  it('upserts for the authenticated user and echoes the stored row', async () => {
    upsertNudgePrefs.mockResolvedValue({ ...DEFAULTS, quietOverride: 'urgent_only' });
    const res = await put('/wisp/nudge-preferences', { quietOverride: 'urgent_only' });
    expect(upsertNudgePrefs).toHaveBeenCalledWith('user-123', 'partner-123', { quietOverride: 'urgent_only' });
    expect((await res.json()).data.settings.quietOverride).toBe('urgent_only');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'wisp.nudge_preferences.update', resourceId: 'user-123' }));
  });
  it('rejects a smuggled userId (strict) and an empty body', async () => {
    expect((await put('/wisp/nudge-preferences', { userId: 'other', quietOverride: 'never' })).status).toBe(400);
    expect((await put('/wisp/nudge-preferences', {})).status).toBe(400);
  });
  it('rejects digestCadenceMinutes 10', …);
});
describe('PUT /wisp/nudge-settings', () => {
  it('is 403 partner_admin_required for a non-admin', …);
  it('stores ["high"] for a partner admin and audits', …);
  it('rejects an unknown severity', async () => { expect((await put('/wisp/nudge-settings', { urgentCapableSeverities: ['critical'] })).status).toBe(400); });
});
describe('GET /wisp/thread/:id', () => {
  it('returns the thread + grant for the grantor', …);
  it('is 404 thread_not_found for another user’s thread', …);
  it('is 404 when wispEnabled() is false', …);
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/wispNudgePreferences.test.ts src/routes/wispThreads.test.ts` — FAIL.
- [ ] **Step 3: Implement** the route file, the `/:id` handler, and the mounts.
- [ ] **Step 4: Run** the two suites plus W02's `src/routes/wisp.test.ts` (its "every /wisp/* route carries requireEntitlement" contract must stay green with the new mounts) — PASS.
- [ ] **Step 5: Commit** — `feat(wisp): nudge preference, partner urgent-capable and thread read routes (W06 T6)`.

---

### Task 7: Web — thread page and in-app notification routing

**Files:**
- Create: `apps/web/src/pages/ai/wisp/thread/[threadId].astro` (shape of `pages/ai-agents/runs/[id].astro`)
- Create: `apps/web/src/components/wisp/WispThreadPage.tsx` (+ `WispThreadPage.test.tsx`), `apps/web/src/components/wisp/wispThreadHash.ts` (+ `.test.ts`)
- Modify: `apps/web/src/components/layout/NotificationCenter.tsx` (`buildHref`, `case 'ai'` at :187-193) + `NotificationCenter.test.tsx` if present, else a new `buildHref.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/pages.json` — add `titles.wispThread` (en: `"Wisp thread"`); same eight `ai.json` files — add `wisp.thread.*` keys below
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35` — `TARGET_GLOBS` += `'src/components/wisp/WispThreadPage.tsx'`

**Interfaces:**
- Consumes: `GET /api/v1/wisp/thread/:id` (Task 6, `{ data: { thread, grant } }`); W05 `GET /api/v1/wisp/concerns?grantId=<grant.id>&status=open,snoozed,resolved,dismissed` and `POST /api/v1/wisp/concerns/:id/snooze { grantId, until }` / `…/dismiss { grantId }`; W04 `WispThreadHeader` (default export, props `{ wisp: NonNullable<WispState>; orgName: string | null; wideningAvailable: boolean }`) and `useAiStore` `enterWispMode(w: NonNullable<WispState>)` + `open()` where `WispState = { grantId; threadId; scopeOrgId: string | null; status; expiresAt; summary } | null` (`apps/web/src/stores/aiStore.ts`); `fetchWithAuth` (`apps/web/src/stores/auth.ts:1335`); `runAction`; `useOrgStore` for `orgName`.
- Produces:
```ts
// wispThreadHash.ts
export function concernIdFromHash(hash: string): string | null;             // '#concern=abc' → 'abc'; '' → null
export function hashForConcern(concernId: string | null): string;            // inverse
export function wispStateFromThreadPayload(p: { thread: WispThread; grant: { id: string; status: WispGrantStatus; orgId: string | null; expiresAt: string; budgetCentsPerDay: number; floorTickMinutes: number } }): NonNullable<WispState>; // { grantId: grant.id, threadId: thread.id, scopeOrgId: grant.orgId, status: grant.status, expiresAt: grant.expiresAt, summary: thread.summary, budgetCentsPerDay, floorTickMinutes }
// WispThreadPage.tsx
export default function WispThreadPage(props: { threadId: string }): JSX.Element;
```
  Page behaviour: loads thread + concerns; renders `<WispThreadHeader wisp={wispStateFromThreadPayload(p)} orgName={…} wideningAvailable={false} />`; concern list with the hash-selected row expanded (`window.location.hash`, per the repo URL-state rule); "Open in chat" (`wisp.thread.openChat`) calls `enterWispMode(wispStateFromThreadPayload(p))` then `open()`; snooze/dismiss buttons call W05's `POST /api/v1/wisp/concerns/:id/snooze { grantId, until }` / `…/dismiss { grantId }` through `runAction` (`grantId` = the thread payload's `grant.id`); a concern with `approvalIntentId` (W05 DTO) links to `/approvals#intent-${id}` (`wisp.thread.reviewApproval`). Locale keys (en): `wisp.thread.concerns` "Concerns", `wisp.thread.empty` "Nothing needs you right now.", `wisp.thread.openChat` "Open in chat", `wisp.thread.snooze` "Snooze", `wisp.thread.dismiss` "Dismiss", `wisp.thread.reviewApproval` "Review approval", `wisp.thread.status.open` "Open", `wisp.thread.status.snoozed` "Snoozed", `wisp.thread.status.resolved` "Resolved", `wisp.thread.status.dismissed` "Dismissed".
  `buildHref` fallback: inside `case 'ai'`, before `runId`: `const wispThreadId = getString(metadata.wispThreadId); const concernId = getString(metadata.concernId); if (wispThreadId) return \`/ai/wisp/thread/${wispThreadId}${concernId ? \`#concern=${concernId}\` : ''}\`;` — reached only when the row carries no `link` (`normalizeNotification` prefers `raw.link`, :227-232).

- [ ] **Step 1: Write failing tests**:

```ts
// wispThreadHash.test.ts
it('round-trips the concern hash', () => { expect(concernIdFromHash('#concern=c1')).toBe('c1'); expect(concernIdFromHash('')).toBeNull(); expect(hashForConcern('c1')).toBe('#concern=c1'); expect(hashForConcern(null)).toBe(''); });
it('maps the thread payload onto WispState', () => { expect(wispStateFromThreadPayload(payload)).toEqual({ grantId: 'g1', threadId: 't1', scopeOrgId: null, status: 'active', expiresAt: '2027-01-17T00:00:00.000Z', summary: 'All quiet.', budgetCentsPerDay: 200, floorTickMinutes: 30 }); });
// NotificationCenter buildHref (new describe in NotificationCenter.test.tsx or buildHref.test.tsx)
it('routes an ai notification with wispThreadId metadata to the thread page', () => { expect(hrefFor({ type: 'ai', metadata: { wispThreadId: 't1', concernId: 'c1' } })).toBe('/ai/wisp/thread/t1#concern=c1'); });
it('prefers a stored link over the metadata fallback', () => { expect(hrefFor({ type: 'ai', link: '/ai/wisp/thread/t1', metadata: { wispThreadId: 'other' } })).toBe('/ai/wisp/thread/t1'); });
// WispThreadPage.test.tsx (mock @/stores/auth fetchWithAuth, @/stores/aiStore, ../ai/WispThreadHeader)
it('renders concern summaries and expands the row named by the hash', …);      // window.location.hash = '#concern=c1' before render
it('snooze posts { grantId: "g1", until } to /api/v1/wisp/concerns/c1/snooze through runAction', …);
it('Open in chat calls enterWispMode with the thread’s grant then open()', …);
```

- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/wisp src/components/layout/NotificationCenter` — FAIL.
- [ ] **Step 3: Implement** the page, component, hash helper, `buildHref` fallback, the `TARGET_GLOBS` entry and the locale entries in all eight `pages.json` + `ai.json`.
- [ ] **Step 4: Run** the suites above plus `npx vitest run src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(web): Wisp thread page + bell routing for wisp nudges (W06 T7)`.

---

### Task 8: Mobile services and preference store

**Files:**
- Create: `apps/mobile/src/services/wisp.ts` (+ `wisp.test.ts`), `apps/mobile/src/services/wispNudgePrefs.ts` (+ `.test.ts`), `apps/mobile/src/store/wispPrefsSlice.ts` (+ `.test.ts`)
- Modify: `apps/mobile/src/services/aiChat.ts:28-35` (`CreateSessionPayload`) and `:121-136` (`createAiSession`)
- Modify: `apps/mobile/src/store/index.ts:11,24,100-109` (register reducer `wispPrefs`, re-export thunks/selectors)
- Test: `apps/mobile/src/services/aiChat.test.ts` (one new case), `apps/mobile/src/store/logoutResetContract.test.ts` (new slice must reset on logout — read that test's contract and add `wispPrefs`)

**Interfaces:**
- Consumes: `coreRequest<T>(endpoint, options?)` (`services/api.ts:613`); routes from Task 6 and W05; `createAiSession` POST `/ai/sessions` now forwarding `wispGrantId` (W04 contract `routes/ai.ts` session create accepts `wispGrantId`).
- Produces:
```ts
// services/wisp.ts — types declared locally (no @breeze/shared dep in mobile, see ticketPushPrefs.ts:9-15)
export type WispConcernStatus = 'open' | 'snoozed' | 'resolved' | 'dismissed';
export type WispConcernSeverity = 'info' | 'low' | 'medium' | 'high';
export interface WispConcern { id: string; orgId: string; subject: { kind: string; id: string }; summary: string; severity: WispConcernSeverity; status: WispConcernStatus; snoozedUntil: string | null; approvalIntentId: string | null; updatedAt: string }
export interface WispThread { id: string; grantId: string; summary: string; summaryUpdatedAt: string | null; grant: { id: string; status: 'active' | 'paused' | 'revoked' | 'expired'; orgId: string | null; expiresAt: string } }
export async function getWispThread(threadId: string): Promise<WispThread>;                       // GET /wisp/thread/:id → unwraps { data: { thread, grant } }
export async function listWispConcerns(grantId: string): Promise<WispConcern[]>;                  // GET /wisp/concerns?grantId=<id>&status=open,snoozed,resolved,dismissed (W05 route shape)
export async function snoozeWispConcern(id: string, grantId: string, until: string): Promise<void>; // POST /wisp/concerns/:id/snooze { grantId, until }
export async function dismissWispConcern(id: string, grantId: string): Promise<void>;             // POST /wisp/concerns/:id/dismiss { grantId }
export function normalizeConcern(raw: unknown): WispConcern | null;                               // total: drops rows without id/summary; unknown status → 'open'; snoozedUntil from raw.recipient?.snoozedUntil (W05 nests per-person state under `recipient`); approvalIntentId from raw.approvalIntentId
// services/wispNudgePrefs.ts — mirrors ticketPushPrefs.ts
export interface WispNudgePreferences { channels: { inApp: boolean; push: boolean }; quietOverride: 'never' | 'urgent_only'; digestCadenceMinutes: number }
export const WISP_NUDGE_PREFERENCE_DEFAULTS: WispNudgePreferences;
export type UpdateWispNudgePreferences = Partial<WispNudgePreferences>; // caller sends ≥ 1 key
export async function getWispNudgePrefs(): Promise<WispNudgePreferences>;                          // GET  /wisp/nudge-preferences
export async function updateWispNudgePrefs(patch: UpdateWispNudgePreferences): Promise<WispNudgePreferences>; // PUT /wisp/nudge-preferences
// store/wispPrefsSlice.ts — same state/thunks/rollback shape as notificationPrefsSlice.ts, names loadWispNudgePrefs / saveWispNudgePrefs / selectWispNudgePrefs / selectWispNudgePrefsSaving / selectWispNudgePrefsError / selectWispNudgePrefsErrorKind / clearWispPrefsError
// services/aiChat.ts
interface CreateSessionPayload { title?: string; model?: ModelChoice; wispGrantId?: string; orgId?: string } // forwarded flat in the POST body; orgId = grant.orgId ?? undefined (W04 grant_scope_mismatch)
```

- [ ] **Step 1: Write failing tests** (mock `./api` `coreRequest`; `aiChat.test.ts` already mocks `fetchWithTimeout`):

```ts
// wisp.test.ts
it('normalizeConcern drops rows without id/summary and defaults an unknown status to open', () => {
  expect(normalizeConcern({ id: 'c1' })).toBeNull();
  expect(normalizeConcern({ id: 'c1', summary: 's', severity: 'weird', status: 'odd', orgId: 'o1', subject: { kind: 'ticket', id: 't' } })).toMatchObject({ status: 'open', severity: 'info', approvalIntentId: null });
});
it('listWispConcerns asks for every status under the grant and normalises', async () => { await listWispConcerns('g1'); expect(coreRequest).toHaveBeenCalledWith('/wisp/concerns?grantId=g1&status=open,snoozed,resolved,dismissed'); });
it('normalizeConcern lifts recipient.snoozedUntil to the top level', () => { expect(normalizeConcern({ id: 'c1', summary: 's', severity: 'low', status: 'snoozed', orgId: 'o1', subject: { kind: 'ticket', id: 't' }, recipient: { snoozedUntil: '2026-10-20T09:00:00.000Z' } })?.snoozedUntil).toBe('2026-10-20T09:00:00.000Z'); });
it('getWispThread unwraps { data: { thread, grant } }', async () => { coreRequest.mockResolvedValue({ data: { thread: { id: 't1', grantId: 'g1', summary: '', summaryUpdatedAt: null }, grant: { id: 'g1', status: 'active', orgId: null, expiresAt: 'x' } } }); expect((await getWispThread('t1')).grant.status).toBe('active'); });
it('snoozeWispConcern POSTs { grantId, until }', async () => { await snoozeWispConcern('c1', 'g1', '2026-10-20T09:00:00.000Z'); expect(coreRequest).toHaveBeenCalledWith('/wisp/concerns/c1/snooze', expect.objectContaining({ method: 'POST', body: JSON.stringify({ grantId: 'g1', until: '2026-10-20T09:00:00.000Z' }) })); });
// wispNudgePrefs.test.ts
it('normalises a truncated body to defaults', async () => { coreRequest.mockResolvedValue({ data: { settings: { channels: { push: false } } } }); expect(await getWispNudgePrefs()).toEqual({ channels: { inApp: true, push: false }, quietOverride: 'never', digestCadenceMinutes: 240 }); });
it('updateWispNudgePrefs uses PUT with only the patch', …);
// wispPrefsSlice.test.ts — same four cases as notificationPrefsSlice.test.ts: optimistic pending, fulfilled adopts echo, rejected restores rollback, condition refuses an overlapping save
// aiChat.test.ts addition
it('createAiSession forwards wispGrantId and orgId flat and nothing else', async () => { await createAiSession({ wispGrantId: 'g1', orgId: 'o1' }); expect(JSON.parse(lastFetchBody())).toEqual({ wispGrantId: 'g1', orgId: 'o1' }); });
```
- [ ] **Step 2: Run** `cd apps/mobile && npx vitest run src/services/wisp.test.ts src/services/wispNudgePrefs.test.ts src/store/wispPrefsSlice.test.ts src/services/aiChat.test.ts` — FAIL.
- [ ] **Step 3: Implement** the modules, register the reducer, add to the logout reset contract.
- [ ] **Step 4: Run** the suites plus `src/store/logoutResetContract.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(mobile): Wisp concern/thread/preference services + prefs slice (W06 T8)`.

---

### Task 9: Mobile push category `wisp_nudge` — parse, route, navigate

**Files:**
- Modify: `apps/mobile/src/services/notifications.ts` (channels block :76-108, `shouldSetBadgeFor` :334-336, parsers after :324)
- Modify: `apps/mobile/src/navigation/pushRouting.ts` (`PushRoute`, `resolvePushRoute`)
- Modify: `apps/mobile/src/navigation/navigationRef.ts` (pending slot + `navigateToWispThread`)
- Modify: `apps/mobile/src/navigation/PushTapRouter.tsx` (route both kinds)
- Modify: `apps/mobile/app.json` (`"scheme": "breeze"` at the `expo` root; no handler this wave)
- Test: `apps/mobile/src/services/notifications.test.ts`, `apps/mobile/src/navigation/pushRouting.test.ts`, `apps/mobile/src/navigation/navigationRef.test.ts`

**Interfaces:**
- Consumes: push `data` from `buildWispNudgePush` (Task 2): `{ type: 'wisp_nudge', threadId, concernId, grantId, deepLink, approvalIntentId? }`; `HomeStackParamList` (Task 10).
- Produces:
```ts
// services/notifications.ts
export interface WispNudgePushData { threadId: string; grantId: string; concernId: string | null; approvalIntentId: string | null }
export function parseWispNudgeData(data: Record<string, unknown> | null | undefined): WispNudgePushData | null; // type must be 'wisp_nudge'; threadId + grantId required non-empty strings; falls back to parsing `deepLink` for threadId/concernId when the keys are absent
export function parseWispNudgeNotification(n: Notifications.Notification | Notifications.NotificationResponse['notification']): WispNudgePushData | null;
// shouldSetBadgeFor: false for 'wisp_nudge' too (badge stays "approvals waiting")
// Android channel: setNotificationChannelAsync('wisp', { name: 'Wisp', importance: AndroidImportance.DEFAULT, vibrationPattern: [0, 150], lightColor: '#1c8a9e', sound: 'default' })
// navigation/pushRouting.ts
export type PushRoute = { kind: 'ticket'; ticketId: string } | { kind: 'wisp_thread'; threadId: string; grantId: string; concernId: string | null; approvalIntentId: string | null } | null;
// navigation/navigationRef.ts
export interface WispThreadParams { threadId: string; grantId: string; concernId?: string | null; approvalIntentId?: string | null }
export function navigateToWispThread(params: WispThreadParams): void;  // navigationRef.navigate('HomeTab', { screen: 'WispThread', initial: false, params }); buffers when not ready, same single pending slot
```
  The pending slot becomes `pending: { kind: 'ticket'; ticketId; options } | { kind: 'wisp'; params } | null`; `flushPendingNavigation` dispatches by kind; `__resetPendingForTests` unchanged. `PushTapRouter` stores one identifier key for both kinds (`LAST_HANDLED_RESPONSE_KEY`) and on `received` for a wisp push does nothing (no list to refresh).

- [ ] **Step 1: Write failing tests** (same `vi.mock` preamble as `pushRouting.test.ts:7-22`):

```ts
// notifications.test.ts
it('parseWispNudgeData accepts the server payload', () => {
  expect(parseWispNudgeData({ type: 'wisp_nudge', threadId: 't1', grantId: 'g1', concernId: 'c1', deepLink: 'breeze://wisp/thread/t1?concern=c1', approvalIntentId: 'i1' }))
    .toEqual({ threadId: 't1', grantId: 'g1', concernId: 'c1', approvalIntentId: 'i1' });
});
it('falls back to deepLink for threadId/concernId, never for grantId', () => {
  expect(parseWispNudgeData({ type: 'wisp_nudge', grantId: 'g1', deepLink: 'breeze://wisp/thread/t1?concern=c1' })).toEqual({ threadId: 't1', grantId: 'g1', concernId: 'c1', approvalIntentId: null });
  expect(parseWispNudgeData({ type: 'wisp_nudge', deepLink: 'breeze://wisp/thread/t1' })).toBeNull();
});
it('rejects other types, empty ids and garbage', () => {
  expect(parseWispNudgeData({ type: 'ticket', ticketId: 't', reason: 'assigned' })).toBeNull();
  expect(parseWispNudgeData({ type: 'wisp_nudge', threadId: '', grantId: 'g1' })).toBeNull();
  expect(parseWispNudgeData(null)).toBeNull();
});
it('wisp nudges never touch the badge', () => { expect(shouldSetBadgeFor({ type: 'wisp_nudge' })).toBe(false); });
// pushRouting.test.ts
it('routes wisp_nudge data to the thread', () => {
  expect(resolvePushRoute({ type: 'wisp_nudge', threadId: 't1', grantId: 'g1', concernId: 'c1' })).toEqual({ kind: 'wisp_thread', threadId: 't1', grantId: 'g1', concernId: 'c1', approvalIntentId: null });
});
// (existing 'ignores approvals, alerts, time suggestions and garbage' stays green)
// navigationRef.test.ts
it('navigateToWispThread navigates into the Home stack with initial:false', () => {
  navigateToWispThread({ threadId: 't1', grantId: 'g1', concernId: 'c1' });
  expect(navigate).toHaveBeenCalledWith('HomeTab', { screen: 'WispThread', initial: false, params: { threadId: 't1', grantId: 'g1', concernId: 'c1' } });
});
it('buffers before ready and flushes exactly once', …);                      // mirror of navigationRef.test.ts:33
it('a later ticket tap replaces a buffered wisp tap (single slot)', …);
```
- [ ] **Step 2: Run** `cd apps/mobile && npx vitest run src/services/notifications.test.ts src/navigation/pushRouting.test.ts src/navigation/navigationRef.test.ts` — FAIL.
- [ ] **Step 3: Implement** parsers, channel, badge rule, route type, navigation helper, `PushTapRouter` wiring (cold-start replay and live tap both call `resolvePushRoute` and switch on `kind`), `app.json` scheme.
- [ ] **Step 4: Run** the suites plus `npx vitest run src/config/appJson.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(mobile): route wisp_nudge pushes to the Wisp thread (W06 T9)`.

---

### Task 10: Mobile `HomeStack`, `WispThreadScreen`, `WispConcernSheet`

**Files:**
- Modify: `apps/mobile/src/navigation/MainNavigator.tsx` (`MainTabParamList.HomeTab` :101, new `HomeStackParamList`, `HomeStackNavigator`, Tab screen :297-306)
- Create: `apps/mobile/src/screens/wisp/WispThreadScreen.tsx`, `apps/mobile/src/screens/wisp/WispConcernSheet.tsx`
- Create: `apps/mobile/src/screens/wisp/wispThreadState.ts` (+ `.test.ts`), `apps/mobile/src/screens/wisp/wispConcernCopy.ts` (+ `.test.ts`)
- Modify: `apps/mobile/src/screens/time/arrivalTrigger.ts` only if `ARRIVAL_TABS` keys on `'HomeTab'` by route name — it does (`isArrivalTab(route.name)` with tab names), so **no change**; verify in Step 3.

**Interfaces:**
- Consumes: Task 8 services; Task 9 params; `ConversationList` (`screens/chat/components/ConversationList.tsx:32`, props `messages`, `inFlightTool`, `onRetry?`), `Composer` (`Composer.tsx:77`, props `onSend`, `disabled?`, `placeholder?`), `historyToMessages` (`screens/chat/historyAdapter.ts`), `ChatMessage` (`store/aiChatSlice.ts:39`), `streamChat` / `createAiSession` (`services/aiChat.ts`), `setFocus` + `fetchOne` (`store/approvalsSlice.ts:364,57`), `stackScreenOptions` (`MainNavigator.tsx:112`).
- Produces:
```ts
// MainNavigator.tsx
export type HomeStackParamList = { Home: undefined; WispThread: WispThreadParams };
export type MainTabParamList = { HomeTab: NavigatorScreenParams<HomeStackParamList> | undefined; SystemsTab: undefined; TicketsTab: …; TimeTab: undefined };
// wispThreadState.ts (pure)
export type ConcernSection = { key: 'needs_you' | 'open' | 'snoozed' | 'done'; title: string; concerns: WispConcern[] };
export function concernSections(concerns: WispConcern[], now: Date): ConcernSection[];           // needs_you = open with approvalIntentId; open; snoozed (snoozedUntil > now); done = resolved|dismissed; empty sections omitted; within a section high→info then updatedAt desc
export function approvalOpenTarget(c: Pick<WispConcern, 'status' | 'approvalIntentId'>): string | null; // intent id only when status === 'open' and id present (Review Focus 4)
export function initialExpandedConcern(params: WispThreadParams, concerns: WispConcern[]): string | null; // params.concernId when present in the list, else null (Review Focus 3)
export type WispSessionState = { sessionId: string | null; messages: ChatMessage[]; status: 'idle' | 'creating' | 'streaming' | 'error'; error: string | null };
export function wispSessionReducer(state: WispSessionState, event: WispSessionEvent): WispSessionState; // local reducer so the thread never clobbers the Home chat's aiChat slice; events: created, userSent, delta, toolEvent, done, failed, reset
// wispConcernCopy.ts (pure)
export function severityLabel(s: WispConcernSeverity): string;                                  // 'Info' | 'Low' | 'Medium' | 'High'
export function snoozeOptions(now: Date): Array<{ label: string; until: string }>;              // '1 hour', 'Tomorrow 9:00', 'Next Monday 9:00' (local time), ISO strings
export function concernActionFailureCopy(status: number): string;                               // 404/409 → 'Already handled elsewhere.'; else 'Could not update this concern.'
```
  Screen behaviour (`WispThreadScreen`): header title "Wisp"; on mount `getWispThread(params.threadId)` + `listWispConcerns(params.grantId)`; sheet actions call `snoozeWispConcern(id, params.grantId, until)` / `dismissWispConcern(id, params.grantId)`; summary card (plus a one-line "Wisp is paused/revoked/expired" banner when `thread.grant.status !== 'active'`, reply box disabled); `concernSections` list; tapping a row opens `WispConcernSheet` (RN `Modal`, like `SettingsSheet`) with snooze (options from `snoozeOptions`), dismiss, and — when `approvalOpenTarget` returns an id — "Review approval", which does `dispatch(setFocus(id)); dispatch(fetchOne(id)).unwrap().catch(() => undefined)` so `ApprovalGate`'s takeover Modal opens **over** the thread (the thread is the back target by construction; `ApprovalGate.tsx:40-48`). On mount with `params.approvalIntentId` set, the screen does the same once. Reply box: `Composer`; first send → `createAiSession({ wispGrantId: params.grantId, orgId: thread.grant.orgId ?? undefined })` then `streamChat({ sessionId, content, onEvent, onError, onDone })` feeding `wispSessionReducer`; messages render through `ConversationList` with `inFlightTool: null`. Sheet actions call Task 8 services and refetch concerns; failures toast `concernActionFailureCopy(status)`.

- [ ] **Step 1: Write failing tests**:

```ts
// wispThreadState.test.ts
const open = (id: string, sev: WispConcernSeverity, extra = {}) => ({ id, orgId: 'o', subject: { kind: 'ticket', id }, summary: id, severity: sev, status: 'open' as const, snoozedUntil: null, approvalIntentId: null, updatedAt: '2026-10-19T10:00:00Z', ...extra });
it('groups and orders: needs_you, open (high→info), snoozed, done; empty sections omitted', () => {
  const s = concernSections([open('a', 'low'), open('b', 'high', { approvalIntentId: 'i1' }), open('c', 'medium', { status: 'resolved' })], now);
  expect(s.map((x) => x.key)).toEqual(['needs_you', 'open', 'done']);
  expect(s[1].concerns.map((c) => c.id)).toEqual(['a']);
});
it('a snoozed concern whose snoozedUntil passed is listed as open', …);
it('approvalOpenTarget returns the id only for an open concern (Review Focus 4)', () => {
  expect(approvalOpenTarget({ status: 'open', approvalIntentId: 'i1' })).toBe('i1');
  expect(approvalOpenTarget({ status: 'resolved', approvalIntentId: 'i1' })).toBeNull();
  expect(approvalOpenTarget({ status: 'open', approvalIntentId: null })).toBeNull();
});
it('initialExpandedConcern is null when the pushed concern is gone (Review Focus 3)', () => {
  expect(initialExpandedConcern({ threadId: 't', grantId: 'g', concernId: 'zzz' }, [open('a', 'low')])).toBeNull();
  expect(initialExpandedConcern({ threadId: 't', grantId: 'g', concernId: 'a' }, [open('a', 'low')])).toBe('a');
});
it('wispSessionReducer streams into the assistant row and surfaces failure', () => {
  let s = wispSessionReducer(initial, { type: 'created', sessionId: 's1' });
  s = wispSessionReducer(s, { type: 'userSent', id: 'u1', content: 'hi', sentAt });
  s = wispSessionReducer(s, { type: 'delta', id: 'a1', delta: 'Hel' }); s = wispSessionReducer(s, { type: 'delta', id: 'a1', delta: 'lo' });
  expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hello', isStreaming: true });
  expect(wispSessionReducer(s, { type: 'failed', error: 'x' }).status).toBe('error');
  expect(wispSessionReducer(s, { type: 'reset' })).toEqual(initial);
});
// wispConcernCopy.test.ts
it('snoozeOptions are three ascending instants after now', () => { const o = snoozeOptions(now); expect(o).toHaveLength(3); expect(o.map((x) => Date.parse(x.until))).toEqual([...o.map((x) => Date.parse(x.until))].sort((a, b) => a - b)); expect(Date.parse(o[0].until)).toBeGreaterThan(now.getTime()); });
it('concernActionFailureCopy distinguishes already-handled from other failures', () => { expect(concernActionFailureCopy(409)).toBe('Already handled elsewhere.'); expect(concernActionFailureCopy(404)).toBe('Already handled elsewhere.'); expect(concernActionFailureCopy(500)).toBe('Could not update this concern.'); });
```
- [ ] **Step 2: Run** `cd apps/mobile && npx vitest run src/screens/wisp` — FAIL.
- [ ] **Step 3: Implement** the pure modules, the two screens, the `HomeStack` (Home `headerShown: false`; `WispThread` `options={{ title: 'Wisp' }}`), and update `navigationRef.ts` types if the param import moved. Confirm `isArrivalTab` still receives `'HomeTab'`.
- [ ] **Step 4: Run** `npx vitest run src/screens/wisp src/navigation` and `pnpm --filter breeze-mobile typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(mobile): Wisp thread screen, concern sheet and HomeStack (W06 T10)`.

---

### Task 11: Mobile nudge preferences under Settings

**Files:**
- Create: `apps/mobile/src/screens/chat/components/WispNudgePreferenceRows.tsx`
- Create: `apps/mobile/src/screens/chat/components/wispNudgePrefsCopy.ts` (+ `.test.ts`)
- Modify: `apps/mobile/src/screens/chat/components/SettingsSheet.tsx` (load on open beside :140; rows after `TicketPushPreferenceRows` at :479; toast effect at :147-157 extended to the new slice's error)

**Interfaces:**
- Consumes: Task 8 slice (`loadWispNudgePrefs`, `saveWispNudgePrefs`, selectors), `ToggleRow` / `SegmentedRow` (local to `SettingsSheet.tsx:777-950` — export them or move them to `settingsRows.tsx`; moving is preferred since the file is 1,008 lines), `useNetworkConnected`.
- Produces:
```ts
// wispNudgePrefsCopy.ts
export const DIGEST_CADENCE_OPTIONS: ReadonlyArray<{ value: 60 | 240 | 1440; label: string }>; // 'Hourly' | 'Every 4 hours' | 'Daily'
export function quietOverrideDescription(v: 'never' | 'urgent_only'): string;
export function cadenceValueFor(minutes: number): 60 | 240 | 1440;                              // nearest option; 240 default
```
  Rows (section header "Wisp"): "In-app nudges" toggle (`channels.inApp`), "Push nudges" toggle (`channels.push`, hidden unless `pushRegistered`, like `TicketPushPreferenceRows`), "Quiet hours" segmented (`Respect` = `never`, `Urgent only` = `urgent_only`), "Digest" segmented from `DIGEST_CADENCE_OPTIONS`. Offline → disabled with "Offline — reconnect to change".

- [ ] **Step 1: Write failing tests** for `wispNudgePrefsCopy.ts`: `cadenceValueFor(15) === 60`, `(240) === 240`, `(1000) === 1440`; descriptions non-empty and distinct.
- [ ] **Step 2: Run** `npx vitest run src/screens/chat/components/wispNudgePrefsCopy.test.ts` — FAIL. Implement. PASS.
- [ ] **Step 3: Implement** the rows component and the `SettingsSheet` edits; `pnpm --filter breeze-mobile typecheck`.
- [ ] **Step 4: Commit** — `feat(mobile): Wisp nudge preferences in Settings (W06 T11)`.

---

### Task 12: Integration proof — `notifyUser` from a worker context, no 42501

**Files:**
- Create: `apps/api/src/__tests__/integration/wispNotifyUser.integration.test.ts`

**Interfaces:**
- Consumes: `createPartner`, `createOrganization`, `createUser` (`__tests__/integration/db-utils.ts:129,176,218`); W02/W04/W05 seed helpers for a grant, thread and concern (insert rows directly under `withSystemDbAccessContext` if no helper exists); `mobileDevices` insert with `quietHours: { start: '00:00', end: '23:59', enabled: true }`; `notifyUser`; `vi.mock('../../services/expoPush', { dispatchPushToTokens })` so no network send happens.

- [ ] **Step 1: Write the failing tests**:
  - **from a request context**: `withDbAccessContext(ctxOtherUser, () => notifyUser({ userId: userA, … }))` resolves with `inApp: true` and a `user_notifications` row exists for `userA` with `type 'ai'`, `link '/ai/wisp/thread/<t>#concern=<c>'`, `metadata.wispThreadId` — proving the `runOutsideDbContext(withSystemDbAccessContext)` wrap (without it this is 42501, `userNotifications.ts:55-60`).
  - **idempotent** (Review Focus 2): second call with the same concern/grant/backoff window → `{ inApp: false, pushed: 0, suppressed: 'backoff' }`; row count still 1.
  - **quiet hours real rows**: device in quiet hours, `quiet_override 'never'` → `suppressed: 'quiet_hours'`, `dispatchPushToTokens` not called; with partner setting `['high']` + concern `high` + `quiet_override 'urgent_only'` → called once.
  - **prefs**: `channels {inApp:false, push:false}` → `'prefs'` and no row.
- [ ] **Step 2: Run** `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispNotifyUser.integration.test.ts` — FAIL until Tasks 1–3 are merged in the branch; then PASS.
- [ ] **Step 3: Run the contract suites once** before the PR: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts` (must still pass unchanged — no `org_id` tables were added). `pnpm test-stack down` afterwards.
- [ ] **Step 4: Commit** — `test(wisp): notifyUser integration proof — worker context, idempotency, quiet hours (W06 T12)`.

---

## Self-review notes

- **Spec coverage**: §7.4 bullets 1–4 → Tasks 3/5 (backoff, digest), 2/3 (one person, one subject, deep link, card id), 3 (quiet hours + urgent-capable), 10 (reply in thread; "records as memory" is W05's `resolveConcern`/`rememberForGrant`, untouched). §7.6 → Tasks 3, 9. §5 mobile row → Tasks 9–11. §13 row → Tasks 1–3. w00 "Nudges (W06)" block → every name appears verbatim: `NudgePayload`, `notifyUser`, `wisp_nudge_preferences` (`user_id`, `partner_id`, `channels jsonb`, `quiet_override`, `digest_cadence_minutes`), both link formats, `pushRouting.ts`, `WispThreadScreen.tsx`, `WispConcernSheet.tsx`.
- **Type consistency**: `WispThreadParams` is defined once (Task 9) and consumed by Tasks 10; `WispNudgePreferences` exists twice by design (shared Zod type on the API, a local mirror on mobile — the `ticketPushPrefs.ts:9-15` rule) with identical field names.
- **Proportion**: no function bodies; the only code blocks are signatures, test assertions and fixed values.

## Calls made by the planner

1. **Mobile tests are Vitest, not Jest**, and `.ts`-only (`apps/mobile/vitest.config.ts`). The prompt's "mobile Jest (screen renders concern list + opens approval)" cannot be met as a render test; the plan pins the same behaviour in pure modules (`wispThreadState.ts`, `wispConcernCopy.ts`) per the repo's own pattern. w00 line 24 ("Mobile: Jest") should be corrected to Vitest.
2. **Mobile has no i18n**; copy is inline, as everywhere else in `apps/mobile`.
3. **No `breeze://` scheme exists today** (`app.json` has only `webcredentials` associated domains; `navigationRef.ts:9-10` states no linking config is wired). The plan registers `"scheme": "breeze"` and routes taps from the push `data` payload (which also carries `deepLink`); a `Linking` URL listener is deferred — flagged for W07's docs as "deep links open from Breeze pushes and in-app only".
4. **Partner "urgent-capable" home**: no partner settings table exists for Wisp, so the plan adds `wisp_partner_nudge_settings` (partner-axis, one row per partner, `canManagePartnerWidePolicies` write gate, API only, no web UI this wave). Default `'{}'` = spec's "default: none".
5. **W05 route shapes (reconciled):** `GET /api/v1/wisp/concerns?grantId=&status=…`, `POST /api/v1/wisp/concerns/:id/snooze { grantId, until }`, `POST /api/v1/wisp/concerns/:id/dismiss { grantId }` — `grantId` names the caller's recipient row. w00 names no **`nudge` tool input schema**; Task 4 swaps only the finalizer's delivery call. W06 adds `GET /wisp/thread/:id` into W04's `routes/wispThreads.ts` with W04's payload shape (Task 6; w00 final route list). W02's route file is `routes/wisp.ts`.
6. **`NudgePayload` carries `grantId`** (w00 A20); `notifyUser` cross-checks it against `wisp_threads.grant_id` (one thread per grant, spec §6) and throws on mismatch. The push `data` and in-app `metadata` carry `grantId` so the mobile screen can create its session with `wispGrantId` without a second lookup.
7. **In-app `type` is the existing `'ai'`** value, not a new `notification_type` enum member; the Wisp identity travels in `metadata.wispThreadId` and `link`.
8. **Web nudge-preferences UI is not built** (Settings rule 9: one home — mobile Settings is the home for a phone-notification preference; the API is shared). The web gets only the thread page and bell routing.
9. **Home tab becomes a stack** (`HomeStack`) to push `WispThreadScreen`; `ApprovalGate`'s Modal takeover already renders over any screen, which is what makes "thread as back target" free.
10. **Digest cadence floor is 15 min** (sweep lane `13,28,43,58 * * * *`); a user's `digest_cadence_minutes` is honoured to the nearest sweep. Mobile offers 60/240/1440 only; the API accepts 15–1440.
11. **Throttle** of 12 pushes/user/hour on channel `wisp-nudge` reports as `'backoff'` (the only matching reason in w00's return type).

### Reconciliation edits (reviewer)

- `NudgePayload` gains `grantId: string` (w00 A20); the thread is a cross-check, not the source. Tests and the digest call updated.
- `notifyUser` writes its in-app row through W05's `deliverInApp` (`services/wisp/deliver.ts`), never `createNotification` directly (w00 A18); the callers-contract test now pins `deliver.ts` as the single `createNotification` site and lists W05's direct `deliverInApp` callers.
- Task 4 targets W05's real nudge site — `runFinalizers.ts` `finalizeAssessment` step (3) — and W05's `recordNudge`, not `assessmentProfile.ts`.
- `requireAiUse` is module-private to `routes/ai.ts`; routes use the hub-inherited `requirePermission(ai_sessions:use)` (w00 A1).
- W05 concern routes carry `grantId` (query on list, body on snooze/dismiss); web page, mobile service, screen and tests updated; `normalizeConcern` reads `recipient.snoozedUntil` and the DTO's `approvalIntentId`.
- `wispStateFromThreadPayload` carries `budgetCentsPerDay`/`floorTickMinutes` (W04's header now has the budget control; the grant payload grew in W04).
- `/wisp/nudge-settings` is an addition beyond w00's final route list (spec §7.4 needs a home for the partner "urgent-capable" mark) — flagged to the orchestrator; kept.

## 2026-10-23 amendments (w00 A28, A29, A31, A32, A34) — tasks added by the orchestrator

### Task 1 edits (schema)

`wisp_nudge_preferences` gains: `brief_time_local text NULL CHECK (brief_time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') DEFAULT '08:00'`, `brief_timezone text NULL`, `last_brief_at timestamptz NULL`, `proactivity text NOT NULL DEFAULT 'normal' CHECK (proactivity IN ('quiet','normal','chatty'))`. Zod (Task 2): `briefTimeLocal: z.string().regex(...).nullable()`, `briefTimezone: z.string().max(64).nullable()`, `proactivity: z.enum(['quiet','normal','chatty'])`; defaults in the "missing row" object. RLS test: a `brief_time_local` of `'25:00'` is 23514.

### Task 2 / Task 3 edits (`NudgePayload.kind`, proactivity floor)

- `NudgePayload` gains `kind: 'concern' | 'digest' | 'brief'` (w00 A28). Dedupe keys: concern as before; digest as before; brief `wisp.brief:${threadId}:${localDate}`.
- `decideNudgeDelivery` gains `severity: ConcernSeverity | null` and `kind`, and applies the proactivity push floor **before** quiet hours: `quiet` ⇒ push only `high`; `normal` ⇒ `medium`+; `chatty` ⇒ all. Exceptions that always push: `kind === 'brief'`, and a concern nudge carrying `approvalIntentId`. A nudge filtered by the floor returns `suppressed: 'prefs'` with the in-app row still written. Tests: a `low` concern under `normal` → in-app only, `suppressed: 'prefs'`; the same under `chatty` → pushed; a `low` concern with an approval id under `quiet` → pushed; the brief under `quiet` → pushed.
- The brief ignores quiet hours (the user picked the time); digests and concern nudges keep the existing quiet-hour logic.

### Task 13: Morning brief (w00 A28)

**Files:**
- Create: `apps/api/src/services/wisp/brief.ts` (+ `brief.test.ts`)
- Modify: Task 5's `nudgeDigest.ts` sweep (`runNudgeDigest` → also `runMorningBriefs(now)`; same 15-minute lane), Task 11's mobile preference rows (brief time picker Off / 07:00 / 08:00 / 09:00 and the proactivity dial Quiet / Normal / Chatty — two new rows beside the digest cadence)

**Interfaces:**
```ts
export type BriefSection = { heading: string; lines: string[] };
export function briefDue(prefs: { briefTimeLocal: string | null; briefTimezone: string | null }, lastBriefAt: Date | null, now: Date, fallbackTz: string): { due: boolean; localDate: string };  // due when local time ≥ brief_time_local and last_brief_at's local date < today's local date; tz = prefs.briefTimezone ?? fallbackTz ('UTC' when the user has no device timezone)
export async function buildBrief(grantId: string, now: Date): Promise<{ title: string; body: string; sections: BriefSection[] }>;
//   deterministic, no model: title `Good morning — ${needsYou} need you, ${open} open`; body = up to 3 highest-severity open concern summaries (≤ 40 chars each) joined by ' · '; sections: Needs you (concerns with approvalIntentId), Open concerns by severity, Overnight (assessments run, specialists launched, concerns resolved since last_brief_at — from listActivity, Task 14), Spend (spendSummary, W05 A32), Watching (active watch count; readiness gaps count from the latest readiness concerns)
export async function runMorningBriefs(now?: Date): Promise<{ due: number; sent: number; suppressed: number }>;  // active grants × prefs; for each due: notifyUser({ kind: 'brief', concernId: null, userId: grantor, threadId, grantId, deepLink: mobileDeepLink(threadId, null), ...buildBrief }); on inApp||pushed set last_brief_at = now. A user-paused grant (A29) gets no brief; a system-paused grant gets a one-line brief saying why.
```
- [ ] **Step 1: Failing tests** — `briefDue` across a DST boundary and the midnight edge (23:59 local vs 00:01); two sweeps in the same local day send one brief (dedupe key); `buildBrief` with 0 concerns says "Nothing needs you"; sections omit empty ones; the `sections` payload is stored in the in-app row's `metadata.brief` so the home (W08) can render it.
- [ ] **Step 2–4:** run → FAIL, implement, run with Task 5's tests — PASS. Commit `feat(wisp): deterministic morning brief in the digest lane, brief time + proactivity preferences (W06 T13, w00 A28/A29)`.

### Task 14: Activity timeline and the live line (w00 A31)

**Files:**
- Create: `apps/api/src/services/wisp/activity.ts` (+ `activity.test.ts`); modify W04's `routes/wispThreads.ts` (`GET /:id/activity`), Task 7's web thread page (activity panel + live line), Task 10's `WispThreadScreen` (live line only)

**Interfaces:** `listActivity`, `currentActivity`, `ActivityItem` exactly as w00 A31; cursor = `${at.toISOString()}|${kind}|${id}` base64; `limit` ≤ 100. Sources (all system ctx, each filtered by `assertWithinCeiling({ orgId })`): `ai_agent_runs WHERE grant_id`, `wisp_concerns` (created / status changes by `updated_at`), W07 lineage (`requested_by_run_id`) when present, `action_intents` via `requesting_agent_run_id`, `ai_memory_blocks WHERE authored_by_grant_id`, `user_notifications WHERE user_id = grantor AND metadata->>'grantId' = $g` (nudges + briefs). `currentActivity(grantId)` → `{ orgId, orgName, startedAt } | null` from queued/running assessment runs.
- Route: `GET /api/v1/wisp/thread/:id/activity?cursor=&limit=` → `{ data: { items, nextCursor } }`; grantor-only, existence-neutral 404.
- Web: `WispActivityPanel.tsx` (added to `TARGET_GLOBS` only if it mutates — it does not) below the concern list; the header shows `currentActivity` as "Checking Greenwood…" refreshed every 30 s while the page is visible. Mobile: the same line in the summary card.
- [ ] **Step 1: Failing tests** — items from two orgs where the ceiling covers one → one org's items only; cursor pagination is stable across inserts; `currentActivity` null when nothing is running; route 404 for another user's thread.
- [ ] **Step 2–4:** run → FAIL, implement, run — PASS. Commit `feat(wisp): activity timeline (derived, ceiling-filtered) and the live "checking…" line (W06 T14, w00 A31)`.

### Task 15: Spend meter and pause/resume controls (w00 A32, A29)

- Web thread page header and `WispThreadHeader`: "{spent}¢ of {budget}¢ today · resets in {h} h" from the grant block's `spentTodayCents` / `budgetResetsAt` (W05 adds them to `GET /wisp/thread` and `/thread/:id`); amber at ≥ 80 %, red + link to the exhausted-budget notice at 100 %. "Pause Wisp" / "Resume" buttons → `POST /wisp/grants/:id/pause|resume` (W02 Task 15) through `runAction`; a paused banner names the reason (`user_paused` ⇒ "You paused Wisp"; others ⇒ the existing copy). Mobile: the meter in the summary card; pause/resume in `WispConcernSheet`'s parent screen menu. Locale keys: `wisp.spend.meter`, `wisp.spend.resets`, `wisp.pause`, `wisp.resume`, `wisp.paused.byYou`, `wisp.toast.paused`, `wisp.toast.resumed`, `wisp.toast.pauseFailed` in all 8 locales.
- [ ] Tests: `spendMeterState(spent, budget)` pure (`ok` / `warn` / `exhausted`); resume disabled unless `pausedReason === 'user_paused'`; mutations go through `runAction` (`no-silent-mutations`).

### Task 16: Nudge feedback (w00 A34)

**Files:** `apps/api/src/routes/wispConcerns.ts` (W05's file; + test), Task 7's web page, Task 10's `WispConcernSheet` + `wispConcernCopy.ts`, Task 8's mobile service.
- Route: `POST /api/v1/wisp/concerns/:id/feedback { grantId, useful: boolean, note?: string ≤ 200 }` → 200 `{ data: { recipient } }`; calls W05 `recordFeedback` then W03 `recordHumanBlock(auth, { owner: { kind: 'user', userId: auth.user.id }, blockType: 'preference', subjectKey: \`nudge_feedback:${concern.subject.kind}:${concern.severity}\`, content: { useful, concernId, summary: concern.summary, note }, confidence: 'high', authoredByGrantId: grantId })`; audit `wisp.concern.feedback`. 404 when the grant is not the caller's; 409 when feedback already recorded (idempotent on the same value).
- UI: two buttons "Useful" / "Not useful" (👍/👎 glyphs are fine) on every concern that has `recipient.nudgeCount > 0`; after a tap the row shows the choice; `not_useful` opens an optional one-line note.
- [ ] Tests: route refuses a mismatched grant; writes the recipient columns and exactly one memory block; `concernFeedbackState(recipient)` pure on mobile; web mutation through `runAction`.
- Commit `feat(wisp): useful / not useful feedback on nudges → preference memory (W06 T16, w00 A34)`.
