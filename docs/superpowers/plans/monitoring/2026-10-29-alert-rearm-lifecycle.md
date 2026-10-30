---
spec: docs/superpowers/specs/monitoring/2026-10-29-alert-rearm-lifecycle-design.md
issue: LanternOps/breeze#10538 (Refs only — the plan does not close it)
tracking_issue: (assigned at Gate B by feature-lifecycle; not registered yet)
waves: 3 (W1 engine, W2 settings, W3 Clears when + docs) — one PR each, merged in order
tasks: 19
---

# Alert Re-arm Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Event-based alerts re-open only on evidence the previous episode did not observe and clear only on recovery evidence newer than their own trigger evidence. Auto-resolve, re-arm and cooldown resolve partner default → org override → monitor override. The `event_log` "Clears when" condition is authorable in the monitor editor.

**Architecture:** Condition handlers gain an `evidence` flag and an optional cursor context. The `event_log` handler keeps its rolling count and additionally requires one matching row ordered after the episode's cursor. The cursor lives in `alerts.context.lifecycle.cursor`: the sweep sets and advances it while the alert is open, and it is frozen at close. W2 adds typed partner/org columns plus nullable monitor overrides, read by one resolver (`resolveAlertLifecycle`) and snapshotted at alert creation. W3 compiles the recovery condition through the kind spec and exposes it in the editor.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only) + hand-written SQL migrations, PostgreSQL, Redis (cooldown only), Vitest, React islands (Astro), Zod 4 in `@breeze/shared`, Playwright (`data-testid`).

**Spec:** `docs/superpowers/specs/monitoring/2026-10-29-alert-rearm-lifecycle-design.md` (approved 2026-10-29; decisions OD1–OD12 in §13). Read it first. Section numbers below (§x) refer to it.

## Global Constraints

- Each wave is one PR, independently mergeable, merged in order W1 → W2 → W3. Do **not** stack PRs: branch each wave from fresh `origin/main` after the previous wave merges.
- PR bodies say `Refs #10538`. W3 may use `Closes #10538` only if the owner says so at Gate B. Never write a closing keyword you don't mean; negation does not stop it.
- **Migration names must sort after the newest committed file on `origin/main`** (compare against files, not the calendar; `apps/api/migrations/README.md` Rule 3). At planning time the newest is `2027-01-16-200000-event-log-application-providers.sql`. Assigned: W1 `2027-01-16-210000-alerts-rule-device-subject-closed-idx.sql`, W2 `2027-01-16-220000-alert-lifecycle-defaults.sql`. **Re-check `origin/main` before the final push of each wave and rename the unshipped file if anything newer landed.** Never rename or edit a shipped migration.
- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`. A `CREATE INDEX CONCURRENTLY` file starts with `-- @no-transaction` (`apps/api/src/db/autoMigrate.ts:796`). A file that writes rows first runs `SELECT set_config('breeze.scope', 'system', true);`. Then run `pnpm db:check-drift`.
- Built-in defaults (spec §6.1): auto-resolve `false`; re-arm `new_evidence`; `after_delay` minutes 1–1440; cooldown 5 minutes (0–1440).
- One cooldown fallback everywhere: `DEFAULT_ALERT_COOLDOWN_MINUTES = 5`. The 15-minute fallbacks are removed.
- `requiresHuman` alerts are never auto-resolved. `unknown` data never resolves.
- Ordering of evidence (spec §5.3): if both rows have `details.logName` equal and numeric `details.recordId` → order by `recordId`. Otherwise by `(timestamp, created_at, id)`. On a full tie: trigger side = consumed (no re-open); resolve side = recovery wins.
- New web copy → keys in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); `localeParity` and `humanizedKeyBaseline.json` must stay green.
- Scoped test runs: `cd apps/api && npx vitest run <file>` (never `pnpm --filter … test -- --run`). Integration suites need `pnpm test-stack up` and must be torn down with `pnpm test-stack down`.
- No customer names, infra details or security-gap tables in code, comments, docs or PR text.
- Settings rule 9 statement goes in the W2 PR body verbatim from the W2 section below.

## Review Focus

1. **A trigger ingested late but logged before the recovery** (agent offline, uploads backlog after the close) must not re-open the alert. A reasonable person expects the backlog not to page them again. Pinned in Task 6 (`does not re-open on a delayed trigger event that predates the recovery event but was ingested after the close`).
2. **Trigger and recovery uploaded in one batch with unparseable/future timestamps** (clamped to one receipt time, `routes/agents/eventLogs.ts:50-56`) must still resolve. Pinned in Task 3 (record-id order) and Task 7 (`a recovery event with the same clamped timestamp as the trigger resolves it`).
3. **Deploy day:** closed alerts without a cursor must not re-open in a burst from events still in the window. Pinned in Task 5 (`legacy closed alert without cursor treats events ingested at or before the close as consumed`).
4. **Partner-wide monitor, two orgs with different overrides**: each org's alerts get that org's lifecycle values, never the partner monitor's org-agnostic compile. Pinned in Task 12 (`resolves against the device's org, not the monitor owner`).
5. **Editing a monitor that has a raw (pre-W3) `autoResolveConditions` blob** must neither lose it on save nor crash the editor. Pinned in Task 18 (`round-trips an existing raw recovery condition without dropping it`).

---

## W1 — Anchored episodes (engine)

Branch `feature/10538-alert-rearm/w1-anchored-episodes` from fresh `origin/main`. Behaviour change for every customer (OD1): release note required (Task 9).

### Task 1: Evidence cursor type and ordering

**Files:**
- Create: `packages/shared/src/utils/evidenceCursor.ts` (export from the utils barrel)
- Test: `packages/shared/src/utils/evidenceCursor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EvidenceCursor { ts: string; createdAt: string; id: string; logName?: string; recordId?: number }
  export function compareEvidence(a: EvidenceCursor, b: EvidenceCursor): -1 | 0 | 1   // record-id rule, then (ts, createdAt, id); 0 only on full tie
  export function isAfterCursor(row: EvidenceCursor, cursor: EvidenceCursor | undefined, side: 'trigger' | 'resolve'): boolean
  // undefined cursor → true; tie (0) → side === 'resolve'
  export function maxEvidence(a?: EvidenceCursor, b?: EvidenceCursor): EvidenceCursor | undefined
  ```

- [ ] **Step 1: Write failing tests**: `orders same-log rows by recordId even when ts disagrees`; `falls back to ts then createdAt then id across logs`; `isAfterCursor treats a full tie as consumed on the trigger side`; `isAfterCursor treats a full tie as after on the resolve side`; `undefined cursor admits every row`; `maxEvidence ignores undefined`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/utils/evidenceCursor.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** in `evidenceCursor.ts`. Timestamps are ISO strings, so compare `Date.parse` values, never string order.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): evidence cursor ordering (#10538 W1)`.

### Task 2: Handler contract — evidence flag, cursor context, per-leaf watermarks

**Files:**
- Modify: `apps/api/src/services/alertConditions/registry.ts:10-43`, `apps/api/src/services/alertConditions/types.ts`, `apps/api/src/services/alertConditions/index.ts:156-361`
- Test: `apps/api/src/services/alertConditions/index.evidence.test.ts`

**Interfaces:**
- Consumes: `EvidenceCursor` (Task 1).
- Produces:
  ```ts
  export interface ConditionEvalContext { evidenceAfter?: EvidenceCursor; side?: 'trigger' | 'resolve' }
  interface ConditionHandler { type; aliases?; evidence?: boolean;
    evaluate(condition: unknown, deviceId: string, ctx?: ConditionEvalContext): Promise<ConditionResult>; validate(...) }
  // ConditionResult gains: evidenceWatermark?: EvidenceCursor
  export interface EvaluateOptions { cursors?: Record<string, EvidenceCursor>; side?: 'trigger' | 'resolve' }
  evaluateConditions(conditions, deviceId, opts?: EvaluateOptions)
    // EvaluationResult gains: evidenceWatermarks: Record<string, EvidenceCursor>
  evaluateAutoResolveConditions(conditions, deviceId, opts?: EvaluateOptions)  // same additions
  export function evidenceLeafPaths(conditions: unknown): string[]   // [] → rule needs no cursor work
  ```
  Leaf path = dot-joined child indexes from the root group, `'root'` for a single-leaf root (e.g. `'0'`, `'1.0'`).

- [ ] **Step 1: Write failing tests** using two registered fake handlers (one `evidence: true`, one not): `passes the cursor for its leaf path only to evidence handlers`; `collects evidenceWatermark per leaf path`; `evidenceLeafPaths returns [] for a state-only tree and ['0'] for and(evidence, state)`; `omitting opts behaves exactly as today` (existing `index.test.ts` stays green).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/alertConditions/index.evidence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by threading `opts` through `evaluateConditionRecursive` with the current path, and by giving `conditionRegistry.evaluate` an optional `ctx`. Mark `eventLogHandler.evidence = true` (its body changes in Task 3).
- [ ] **Step 4: Run** the new file plus `src/services/alertConditions/index.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): evidence-aware condition evaluation (#10538 W1)`.

### Task 3: `event_log` handler — "exists after cursor" on top of the rolling count

**Files:**
- Modify: `apps/api/src/services/alertConditions/handlers/eventLog.ts:14-58`
- Test: `apps/api/src/services/alertConditions/handlers/eventLog.test.ts`

**Interfaces:**
- Consumes: `ConditionEvalContext`, `isAfterCursor`, `compareEvidence`.
- Produces: `evidenceWatermark` = newest matching row in the window, as an `EvidenceCursor` (`logName`/`recordId` from `details` when present).

Approach (decided while planning, ND1 below): keep the existing `count(*)`. When a cursor is given, fetch matching rows with `timestamp >= cursor.ts − 1 s` (newest first, `LIMIT 50`, columns `id, timestamp, created_at, details->>'logName', details->>'recordId'`). Then apply `isAfterCursor` in TypeScript, so the record-id tie rule never needs a jsonb sort in SQL. Also fetch the newest matching row (`LIMIT 1`) for the watermark. `passed = count >= countThreshold && (no cursor || someRowAfter)`.

- [ ] **Step 1: Write failing tests**: `with a cursor, requires one matching row ordered after it`; `with a cursor, still counts old rows toward countThreshold` (5 old + 1 new, threshold 5 → passed); `orders same-log Windows events by recordId when timestamps tie`; `window still applies under a cursor`; `returns the newest matching row as evidenceWatermark`; `no cursor → behaviour identical to today`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/alertConditions/handlers/eventLog.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** as above. Keep `escapeLikePattern` and the level array unchanged.
- [ ] **Step 4: Run** the same file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): event_log requires unconsumed evidence after the episode cursor (#10538 W1)`.

### Task 4: Closed-alert lookup index (migration)

**Files:**
- Create: `apps/api/migrations/2027-01-16-210000-alerts-rule-device-subject-closed-idx.sql` (re-check name, Global Constraints)
- Modify: `apps/api/src/db/schema/alerts.ts:185-211` (declare the index so drift stays clean)

SQL (exact):
```sql
-- @no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_rule_device_subject_closed_idx
  ON alerts (rule_id, device_id, (COALESCE(subject_key, '')), (COALESCE(resolved_at, dismissed_at)) DESC)
  WHERE rule_id IS NOT NULL AND status IN ('resolved', 'dismissed');
```

- [ ] **Step 1:** Run the migration-naming check first: `scripts/check-migration-naming.sh --staged` after `git add`. Expected: OK.
- [ ] **Step 2:** `pnpm test-stack up`, `pnpm db:migrate`, then `pnpm db:check-drift`. Expected: no drift.
- [ ] **Step 3: Commit** `feat(alerts): index newest closed alert per rule/device/subject (#10538 W1)`.

### Task 5: Cursor store

**Files:**
- Create: `apps/api/src/services/alertLifecycle/cursor.ts`
- Test: `apps/api/src/services/alertLifecycle/cursor.test.ts`

**Interfaces:**
- Consumes: `EvidenceCursor`, `maxEvidence`.
- Produces:
  ```ts
  export type LeafCursors = Record<string, EvidenceCursor>;
  /** Newest closed alert per (ruleId, subjectKey) for one device, one query. */
  export function readClosedCursors(deviceId: string, ruleIds: string[]): Promise<Map<string /*ruleId*/, { cursors: LeafCursors | null; closedAt: Date; legacy: boolean }>>
  /** Legacy row (no context.lifecycle.cursor): caller treats rows with created_at <= closedAt as consumed. */
  export function readOpenCursors(alertId: string): Promise<LeafCursors>
  export function advanceOpenCursors(alertId: string, next: LeafCursors): Promise<void>  // advance-only, open statuses only
  export function freezeRecoveryCursor(next: LeafCursors): LeafCursors                    // used inside the resolve CAS (Task 7)
  ```
- The legacy rule lives in `event_log`'s caller (Task 6). For a legacy entry, pass the cursor `{ ts: <epoch>, createdAt: closedAt, … }` with a flag `ingestedAtOrBefore: closedAt`. Extend `ConditionEvalContext` with `legacyIngestedBefore?: Date`, and have the handler treat rows with `created_at <= legacyIngestedBefore` as consumed.

- [ ] **Step 1: Write failing tests**: `reads the newest closed alert per rule including dismissed`; `ignores open alerts`; `advance-only: never moves a cursor backwards`; `does not write when the watermark is unchanged`; `does not touch a resolved alert`; `legacy closed alert without cursor treats events ingested at or before the close as consumed` (handler-level, together with Task 3's file).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/alertLifecycle/cursor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `advanceOpenCursors` is one `UPDATE alerts SET context = jsonb_set(...) WHERE id = $1 AND status IN ('active','acknowledged','suppressed')`, merged in TS after reading. Per-leaf `maxEvidence`, and skip the write when nothing moved.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): episode evidence cursor store (#10538 W1)`.

### Task 6: Sweep — anchored trigger, cursor set/advance, nothing consumed on blocked admission

**Files:**
- Modify: `apps/api/src/services/alertService.ts:1187-1400` (`evaluateDeviceAlertsInMode`), `:202-378` (`createAlert` writes `context.lifecycle.cursor`)
- Test: `apps/api/src/services/alertService.rearm.test.ts`

**Interfaces:**
- Consumes: `evidenceLeafPaths`, `evaluateConditions(..., { cursors, side: 'trigger' })`, `readClosedCursors`, `advanceOpenCursors`.
- Produces: `CreateAlertParams.lifecycle?: { cursor: LeafCursors }`, persisted at `alerts.context.lifecycle.cursor` (W2 adds the other snapshot fields).

Flow per device: compute `evidenceRules = rules.filter(r => evidenceLeafPaths(effectiveConditions).length)`. One `readClosedCursors(deviceId, evidenceRules.map(id))`. Evaluate each evidence rule with the closed cursors (or the legacy flag). If `triggered` and an open alert exists (dedupe), call `advanceOpenCursors(open.id, result.evidenceWatermarks)`. If created, store the watermarks as the cursor. Cooldown, flapping or maintenance blocks write nothing.

- [ ] **Step 1: Write failing tests**:
  - `does not re-open after condition_cleared when every trigger event precedes the recovery event` (fails today).
  - `does not re-open on a delayed trigger event that predates the recovery event but was ingested after the close`.
  - `re-opens on a trigger event logged after the recovery event even if ingested before the resolve sweep`.
  - `re-opens after a manual resolve on a trigger event the sweep never observed`.
  - `does not re-open after a manual resolve on events the sweep observed while open`.
  - `a cooldown- or flap-blocked evaluation consumes nothing`.
  - `skips the cursor lookup for rules with no evidence leaf` (assert `readClosedCursors` not called).
  - `state condition re-opens after cooldown when still breaching after a manual resolve` (pins today).
  - `breach episode records ok once the anchored trigger is false`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/alertService.rearm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as described. Keep the existing order: cooldown → dedupe → flapping → insert.
- [ ] **Step 4: Run** the new file plus `alertService.test.ts`, `alertService.episodes.test.ts` and `alertService.monitorOverrides.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): event alerts re-arm only on unconsumed evidence (#10538 W1)`.

### Task 7: Resolve side — recovery after the cursor, frozen in the CAS, ack/suppressed auto-resolve

**Files:**
- Modify: `apps/api/src/services/alertService.ts:516-600` (`checkAutoResolve`), `:815-958` (`resolveAlert` gains `recoveryCursor?: LeafCursors`), `:1466-1494` (`checkAllAutoResolve`)
- Modify: `apps/api/src/services/monitors/episodeService.ts` (export a `recordRecoveryObservation(monitorId, deviceId, orgId)` thin wrapper over `recordMonitorEvaluation` with `'ok'`)
- Test: `apps/api/src/services/alertService.autoResolveAnchor.test.ts`

**Interfaces:**
- Consumes: `readOpenCursors`, `evaluateAutoResolveConditions(..., { cursors, side: 'resolve' })`, `freezeRecoveryCursor`.
- Produces: `resolveAlert(alertId, note?, resolvedBy?, deferSubjectEffects?, reason?, principalId?, recoveryCursor?)`. When given, the same UPDATE sets `context = jsonb_set(context, '{lifecycle,cursor}', …)`.

Status filter becomes `RESOLVABLE_ALERT_STATUSES` (active, acknowledged, suppressed) in both `checkAutoResolve` and `checkAllAutoResolve`. Keep `requiresHuman = false` and the subject/ruleless skips. Before evaluating recovery, refresh the cursor from a trigger evaluation (advance-only) so a repeat trigger between sweeps blocks an older recovery. A recovery resolve on a monitor-managed rule calls `recordRecoveryObservation` after the CAS succeeds.

- [ ] **Step 1: Write failing tests**:
  - `a recovery event older than the cursor does not resolve a new alert` (fails today).
  - `a recovery event logged after the trigger but ingested before triggered_at resolves it`.
  - `a repeat trigger event during the episode advances the cursor and blocks an earlier recovery`.
  - `a recovery event with the same clamped timestamp as the trigger resolves it`.
  - `recovery close freezes the cursor in the same update as the status change`.
  - `recovery close records an ok observation and closes the breach episode`.
  - `acknowledged alert auto-resolves`, `suppressed alert auto-resolves` (both fail today).
  - `requiresHuman alert never auto-resolves`.
  - `unknown data state never resolves`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/alertService.autoResolveAnchor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file plus `alertService.resolveCas.test.ts`, `alertService.resolveCasSql.test.ts`, `alertService.requiresHuman.test.ts` and `alertService.autoResolveOutcome.test.ts`. Expected: PASS (update `resolveCasSql` snapshots only where the compiled SQL gained the `context` set).
- [ ] **Step 5: Commit** `feat(alerts): recovery must be newer than the episode's evidence; ack/suppressed alerts auto-resolve (#10538 W1)`.

### Task 8: One cooldown fallback

**Files:**
- Modify: `apps/api/src/services/alertService.ts:243-245, 876, 921-923`, `apps/api/src/routes/alerts/alerts.ts:1040-1043`, `apps/api/src/routes/alerts/helpers.ts:518`, `apps/api/src/routes/mobile.ts:~1265-1271`
- Create: `packages/shared/src/constants/alertLifecycle.ts` exporting `DEFAULT_ALERT_COOLDOWN_MINUTES = 5` (re-export from `constants/index.ts`)
- Test: `apps/api/src/services/alertCooldownFallback.contract.test.ts`

- [ ] **Step 1: Write failing test** `no alert path hard-codes a cooldown fallback other than DEFAULT_ALERT_COOLDOWN_MINUTES`. It reads the listed files and fails on `/cooldownMinutes\s*\?\?\s*\d+/` or a `?? 15` adjacent to a cooldown read. Also add `resolveAlert and createAlert use the same cooldown fallback` (unit).
- [ ] **Step 2: Run.** Expected: FAIL (three 15s).
- [ ] **Step 3: Replace** the literals with the constant.
- [ ] **Step 4: Run** the new test plus `routes/alerts/alerts.resolveCas.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(alerts): one cooldown fallback (5 min) across create and resolve paths (#10538 W1)`.

### Task 9: End-to-end integration test + release note

**Files:**
- Create: `apps/api/src/__tests__/integration/alertRearm.integration.test.ts`
- Modify: `docs/release-notes/next-release-draft.md` (append under a new `### Alert re-arm (event-log monitors)` heading; it is a merge-queue hot spot — append only)

- [ ] **Step 1: Write the failing integration test** for the spec §5.9 timeline against real Postgres. Seed one `event_log` monitor with a recovery condition. Insert events with explicit `timestamp`/`created_at`/`details.recordId`, then drive `evaluateDeviceAlerts` + `checkAllAutoResolve` with a fake clock. Assert:
  - exactly two alerts are created and two `alert.resolved` events published;
  - no re-open between 10:04 and 13:00;
  - the breach episode ends `recovered` when A resolves;
  - `EXPLAIN` of the closed-cursor query contains `alerts_rule_device_subject_closed_idx`.
  Then add `exists-after-cursor probe stays under 20 ms on a device with 50k event rows` (seeded; log the plan if slower).
- [ ] **Step 2: Run** `pnpm test-stack up`, then the integration command from `docs/agents/testing.md` for this file. Expected: PASS after Tasks 1–8 (FAIL on `main`).
- [ ] **Step 3: Write the release note** (self-hoster section). It says:
  - event-log alerts no longer re-open on events they already alerted on;
  - recovery conditions only clear on newer events;
  - acknowledged and muted alerts now auto-resolve when their monitor has auto-resolve on;
  - an `after_delay` option arrives in the next release (W2) for anyone who wants reminders.
- [ ] **Step 4:** `pnpm test-stack down`. Before the final push run `git fetch origin main` and re-check the migration name (Task 4). Open PR "feat(alerts): anchored alert episodes — re-arm on new evidence (W1, #10538)" with `Refs #10538`.
- [ ] **Step 5: Commit** `test(alerts): re-arm lifecycle integration timeline + release note (#10538 W1)`.

---

## W2 — Lifecycle settings (partner → org → monitor)

Branch from fresh `origin/main` after W1 merges. This wave touches a migration on `organizations` (an org-cascade/export table), so it runs full rigor: the Integration Tests job must be green, including the export-policy suite.

**Settings rule-9 statement (paste verbatim into the W2 PR body):**
- **Home:** Alerts → Monitors → "Lifecycle defaults" card, `/alerts/monitors#lifecycle` (partner default at partner scope, org override with an org selected); monitor editor "Alert lifecycle" section (per-monitor override).
- **Level:** partner default → org override → monitor override → snapshot on the alert (`alerts.context.lifecycle`). The monitor override beats the org (stated exception, disclosed in the editor).
- **Resolver:** `resolveAlertLifecycle` (`@breeze/shared`) via `apps/api/src/services/alertLifecycle/resolve.ts`, the only reader (contract test).
- **Places configured, before → after (UI):**

  | Setting | Before | After |
  |---|---|---|
  | Cooldown | 1 | 2 |
  | Auto-resolve | 1 | 2 |
  | Re-arm | 0 | 2 |
  | Recovery condition | 0 | 1 (W3) |

  One home per level. The removal plan for the leftover API-only storage (templates, rule overrides, config-policy rules) is the alerting-consolidation retirement wave. This PR adds no UI for them.

**Export-policy classification** (`apps/api/src/services/tenantExportPolicyRegistry.ts`):

| Column | Table | Classification | Why |
|---|---|---|---|
| `alert_auto_resolve` | organizations | `included` | boolean scalar, no secret |
| `alert_rearm_mode` | organizations | `included` | enum text |
| `alert_rearm_delay_minutes` | organizations | `included` | integer |
| `alert_cooldown_minutes` | organizations | `included` | integer |
| `rearm_mode` | monitor_definitions | `included` | enum text |
| `rearm_delay_minutes` | monitor_definitions | `included` | integer |
| `alert_*` (four columns) | partners | n/a | `partners` is not in the tenant export registry; confirm with `grep '"partners"' tenantExportPolicyRegistry.ts` → empty |

No cascade/orgMerge change (OD7: the surviving org keeps its own columns). No new table, so no RLS or `DUAL_AXIS_TENANT_TABLES` work.

### Task 10: Shared resolver and validators

**Files:**
- Create: `packages/shared/src/utils/alertLifecycle.ts`, `packages/shared/src/validators/alertLifecycle.ts` (export both from barrels)
- Test: `packages/shared/src/utils/alertLifecycle.test.ts`, `packages/shared/src/validators/alertLifecycle.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RearmMode = 'new_evidence' | 'after_delay';
  export interface AlertLifecycleValues { autoResolve: boolean; rearmMode: RearmMode; rearmDelayMinutes: number | null; cooldownMinutes: number }
  export type LifecycleSource = 'monitor' | 'org' | 'partner' | 'builtin' | 'legacy';
  export interface PartialLifecycle { autoResolve?: boolean | null; rearmMode?: RearmMode | null; rearmDelayMinutes?: number | null; cooldownMinutes?: number | null }
  export const BUILTIN_ALERT_LIFECYCLE: AlertLifecycleValues  // {false,'new_evidence',null,5}
  export function resolveAlertLifecycle(input: { monitor?: PartialLifecycle | null; org?: PartialLifecycle | null; partner?: PartialLifecycle | null; legacy?: { autoResolve: boolean; cooldownMinutes: number } | null })
    : AlertLifecycleValues & { sources: Record<keyof AlertLifecycleValues, LifecycleSource> }
  // legacy non-null → autoResolve/cooldown from legacy (source 'legacy'), rearm from builtin; partner/org ignored (OD8)
  // rearmMode and rearmDelayMinutes resolve as a PAIR from the first level that sets rearmMode
  export const alertLifecycleDefaultsSchema   // PUT body: all four fields nullable (null = inherit) for org; non-null for partner
  export const rearmFieldsSchema               // shared refine: after_delay ⇔ delay 1–1440
  ```

- [ ] **Step 1: Write failing tests**: `monitor override wins`; `org override beats partner`; `blank (null) inherits`; `rearm pair resolves from one level`; `after_delay requires minutes`; `legacy rule ignores partner/org`; `returns sources`; `0 is a real cooldown, not inherit`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/utils/alertLifecycle.test.ts src/validators/alertLifecycle.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `??`, never `||`. Zod 4.6 note: a `superRefine` is skipped after an earlier failed check, so express the pair rule as a top-level `.refine`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): alert lifecycle resolver + validators (#10538 W2)`.

### Task 11: Migration + schema + export classification

**Files:**
- Create: `apps/api/migrations/2027-01-16-220000-alert-lifecycle-defaults.sql` (re-check name)
- Modify: `apps/api/src/db/schema/orgs.ts` (partners ~`:128`, organizations ~`:278`), `apps/api/src/db/schema/monitorDefinitions.ts:79-81`, `apps/api/src/services/tenantExportPolicyRegistry.ts:684, 1152`

SQL content, in order:
1. `SELECT set_config('breeze.scope', 'system', true);` (the backfill writes rows).
2. `partners`: `ADD COLUMN IF NOT EXISTS`:
   - `alert_auto_resolve boolean NOT NULL DEFAULT false`
   - `alert_rearm_mode text NOT NULL DEFAULT 'new_evidence'`
   - `alert_rearm_delay_minutes integer`
   - `alert_cooldown_minutes integer NOT NULL DEFAULT 5`
   - CHECKs (each guarded with `DO $$ … IF NOT EXISTS (pg_constraint) …`):
     - `partners_alert_rearm_mode_chk` (`IN ('new_evidence','after_delay')`)
     - `partners_alert_rearm_delay_chk` (`(alert_rearm_mode = 'after_delay') = (alert_rearm_delay_minutes IS NOT NULL) AND (alert_rearm_delay_minutes IS NULL OR alert_rearm_delay_minutes BETWEEN 1 AND 1440)`)
     - `partners_alert_cooldown_chk` (`BETWEEN 0 AND 1440`)
3. `organizations`: the same four columns, all nullable, no defaults. Same CHECKs, but with the pair rule written as `alert_rearm_mode IS NULL OR …` so NULL = inherit.
4. `monitor_definitions`:
   - `ALTER COLUMN cooldown_minutes DROP NOT NULL, ALTER COLUMN cooldown_minutes DROP DEFAULT`
   - the same for `auto_resolve`
   - `ADD COLUMN IF NOT EXISTS rearm_mode text`, `rearm_delay_minutes integer`, with the nullable CHECKs.
5. Backfill (OD9): `UPDATE monitor_definitions SET cooldown_minutes = NULL WHERE cooldown_minutes = 5;` and `UPDATE monitor_definitions SET auto_resolve = NULL WHERE auto_resolve = false;`. Both are idempotent.

Before writing: per `docs/agents/tenancy-rls.md`, a column added to an org-cascade table needs an export classification. Apply the table above.

- [ ] **Step 1: Write failing tests**:
  - `apps/api/src/__tests__/integration/alertLifecycleMigration.integration.test.ts` checks three things: `backfill nulls cooldown 5 and auto_resolve false only` (seed 5/10/false/true rows before running the migration body); `rejects after_delay without minutes on partners and organizations` (23514); `organizations columns default to NULL`.
  - Run `migrationRlsScope.test.ts` and the export-policy suite. They must fail until the registry is classified.
- [ ] **Step 2: Run** the scoped unit tests, plus the integration file on `pnpm test-stack up`. Expected: FAIL.
- [ ] **Step 3: Write** the SQL and Drizzle columns (monitor `cooldownMinutes`/`autoResolve` become nullable with no `.default`). Classify the registry entries.
- [ ] **Step 4:** Run `pnpm db:migrate && pnpm db:check-drift`, the integration file, `migrationRlsScope.test.ts` and `tenantExportPolicy.test.ts`. Expected: PASS, no drift. TypeScript fallout from nullable monitor columns is fixed in Task 12, not here; run `tsc --build tsconfig.tests.json` in `apps/api` (12 GB heap; check the exit code, never pipe to `tail`).
- [ ] **Step 5: Commit** `feat(alerts): partner/org alert lifecycle columns + monitor inherit backfill (#10538 W2)`.

### Task 12: Service loader + single reader

**Files:**
- Create: `apps/api/src/services/alertLifecycle/resolve.ts`
- Modify (switch to the loader): `alertService.ts:243-245, 566-576, 871-925, 1135`, `routes/alerts/alerts.ts:1025-1043`, `routes/alerts/helpers.ts:518-519`, `routes/mobile.ts:~1265`, `alertSubjects.ts:~60`, `offlineAlertEffects.ts:66-70`, `services/monitors/monitorCompiler.ts:162-164` (compile copies `?? BUILTIN` only so `alert_templates` NOT NULL holds; runtime reads come from the loader)
- Test: `apps/api/src/services/alertLifecycle/resolve.test.ts`, `apps/api/src/services/alertLifecycle/singleReader.contract.test.ts`

**Interfaces:**
- Consumes: `resolveAlertLifecycle` (Task 10).
- Produces:
  ```ts
  export function loadAlertLifecycle(args: { rule: AlertRuleRow; template: AlertTemplateRow | null; monitor: MonitorDefinitionRow | null; deviceOrgId: string }): Promise<ResolvedLifecycle>
  export function createLifecycleLoader(): typeof loadAlertLifecycle   // per-sweep memo of org + partner rows
  ```
  For a monitor-managed rule: monitor → device org → device org's partner. Otherwise it is `legacy` from rule overrides ?? template.

- [ ] **Step 1: Write failing tests**:
  - `resolves against the device's org, not the monitor owner` (partner-wide monitor, two orgs);
  - `org and partner rows are read once per sweep`;
  - `legacy rule uses template/override values`;
  - singleReader: `no file outside alertLifecycle reads cooldownMinutes or autoResolve off a rule, template or monitor row` (regex over `apps/api/src/**/*.ts`, excluding tests, schema, the compiler copy, conversion mapping and the resolver).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/alertLifecycle`. Expected: FAIL.
- [ ] **Step 3: Implement** and switch every listed reader.
- [ ] **Step 4: Run** the folder plus the `alertService*.test.ts` files and `routes/alerts/*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(alerts): one lifecycle resolver for every cooldown/auto-resolve read (#10538 W2)`.

### Task 13: Snapshot + `after_delay`

**Files:**
- Modify: `apps/api/src/services/alertService.ts` (sweep + `createAlert`)
- Test: `apps/api/src/services/alertService.rearmDelay.test.ts`

**Interfaces:**
- `alerts.context.lifecycle = { cursor, autoResolve, rearmMode, rearmDelayMinutes, cooldownMinutes, sources, monitorCompiledHash }`.

- [ ] **Step 1: Write failing tests**:
  - `createAlert snapshots the effective lifecycle and its sources on context.lifecycle`;
  - `after_delay re-opens on old evidence once N minutes have passed since close`;
  - `after_delay still fires immediately on new evidence`;
  - `new_evidence never re-opens on consumed evidence however long ago the close was`;
  - `open alert keeps its snapshotted cooldown after the partner default changes`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** For `after_delay`, drop the cursor from the evaluation once `now − closedAt ≥ rearmDelayMinutes`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): lifecycle snapshot + after_delay re-arm (#10538 W2)`.

### Task 14: API — lifecycle defaults route + monitor inherit fields

**Files:**
- Create: `apps/api/src/routes/alerts/lifecycleDefaults.ts`, mounted in `apps/api/src/routes/alerts/index.ts` at `/alerts/lifecycle-defaults`
- Modify: `packages/shared/src/validators/monitors.ts:313-332` (`cooldownMinutes` and `autoResolve` become `.nullable().optional()` with **no default**; add `rearmMode`, `rearmDelayMinutes` nullable; apply `rearmFieldsSchema`), `apps/api/src/services/monitors/monitorService.ts:385-394, 477-482`
- Test: `apps/api/src/routes/alerts/lifecycleDefaults.test.ts`, `packages/shared/src/validators/monitors.test.ts`

**Interfaces:**
- `GET /alerts/lifecycle-defaults?orgId=` → `{ partner: AlertLifecycleValues, org: PartialLifecycle | null, effective, sources, monitorOverrideCounts: Record<field, number> }`.
- `PUT /alerts/lifecycle-defaults` body `{ scope: 'partner' } & values` or `{ scope: 'organization', orgId } & PartialLifecycle`.
- Gates (decided while planning, ND2):
  - partner write: `requireScope('partner','system')` + `ALERTS_WRITE` + `canManagePartnerWidePolicies(auth)`;
  - org write: `ALERTS_WRITE` + org access via the existing org-access helper;
  - read: `ALERTS_READ`.
  - Audit-log both writes.

- [ ] **Step 1: Write failing tests**:
  - `partner-scope write requires canManagePartnerWidePolicies`;
  - `org write rejected for another partner's org` (403/404 per existing helper semantics);
  - `org user reads the inherited value and source`;
  - `null saves inherit`;
  - `after_delay without minutes is 400`;
  - monitor schema: `create without cooldownMinutes stores null (inherit)` and `update omitting cooldownMinutes leaves it unchanged`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/alerts/lifecycleDefaults.test.ts` and the shared validator test. Expected: FAIL.
- [ ] **Step 3: Implement.** Then check the AI monitor tools (`services/aiToolsMonitors.ts:535, 572`). They derive from the shared schema, so check `aiToolsMonitors.test.ts` and the tool-index budget test still pass (+128 B per wave ceiling).
- [ ] **Step 4: Run** the above plus `routes/monitorDefinitions.test.ts`, `services/aiToolsMonitors.test.ts` and `routes/monitorDefinitions.authGate.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(alerts): lifecycle defaults API + monitor inherit fields (#10538 W2)`.

### Task 15: Web — "Lifecycle defaults" card

**Files:**
- Create: `apps/web/src/components/monitoring/LifecycleDefaultsCard.tsx`
- Modify: `apps/web/src/components/monitoring/MonitorsListPage.tsx:44+` (render at top, `id="lifecycle"`), `apps/web/src/locales/*/monitoring.json` (8 locales)
- Test: `apps/web/src/components/monitoring/LifecycleDefaultsCard.test.tsx`

Use `apps/web/src/components/shared/InheritedField.tsx` for each field. Form card with page Save (rule 7), and the save goes through `runAction`. Each field shows the count of monitors overriding it ("3 monitors override this"). `data-testid`: `lifecycle-defaults-card`, `lifecycle-auto-resolve`, `lifecycle-rearm-mode`, `lifecycle-rearm-delay`, `lifecycle-cooldown`, `lifecycle-save`.

- [ ] **Step 1: Write failing tests**: `shows inherited value and source at org scope`; `blank saves null`; `partner scope has no inherit option`; `after_delay reveals minutes`; `save failure toasts via runAction`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/monitoring/LifecycleDefaultsCard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the locale keys to all 8 locales.
- [ ] **Step 4: Run** the card test, `src/lib/i18n` localeParity, `humanizedKeyRegression.test.ts`, `no-silent-mutations.test.ts` and `settingsPageRegistry.test.ts` (unchanged: no new URL). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): alert lifecycle defaults card on Monitors (#10538 W2)`.

### Task 16: Web — monitor editor "Alert lifecycle" section

**Files:**
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx:78-79, 118-119, 168-169, 403-404, 516-517, 900-916`, locales
- Test: `apps/web/src/components/monitoring/MonitorEditor.lifecycle.test.tsx`

The noise block becomes "Alert lifecycle":
- auto-resolve select: Inherit / On / Off;
- re-arm select: Inherit / New evidence / After N minutes;
- cooldown number: blank = inherit, placeholder = inherited value.

Overrides are disclosed with "This monitor overrides the org default (X)". OD5: a non-blocking warning when `condition.windowMinutes < effective cooldown` for `event_log`. The payload sends `null` for Inherit.

- [ ] **Step 1: Write failing tests**: `Inherit sends null`; `after_delay shows minutes and sends both`; `shows the override disclosure when set`; `warns when window is shorter than cooldown`; `existing monitor with null cooldown shows the inherited placeholder`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/monitoring/MonitorEditor.lifecycle.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new test, all existing `MonitorEditor*.test.tsx` and locale parity. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): monitor editor alert lifecycle section (#10538 W2)`. Before the final push: `git fetch origin main`, re-check the migration name, and run the full API + web suites plus Integration Tests. The PR body carries the rule-9 statement above and `Refs #10538`.

---

## W3 — "Clears when" for event_log + docs

Branch from fresh `origin/main` after W2 merges.

### Task 17: Kind-aware recovery condition, compiled through the kind spec

**Files:**
- Modify: `apps/api/src/services/monitors/kinds/types.ts:30-44` (add `recoverySupported?: boolean`), `apps/api/src/services/monitors/kinds/eventLog.ts` (`recoverySupported: true`), `packages/shared/src/validators/monitors.ts:355-370` (`refineDefinition`), `apps/api/src/services/monitors/monitorCompiler.ts:162-163`
- Create: `export const RECOVERY_CONDITION_KINDS = ['event_log'] as const` in `packages/shared/src/validators/monitors.ts`
- Test: `packages/shared/src/validators/monitors.test.ts`, `apps/api/src/services/monitors/monitorCompiler.test.ts`

Rules:
- When `autoResolveConditions` is non-null, the kind must be in `RECOVERY_CONDITION_KINDS` and the value must parse with `monitorConditionSchemas[kind]`. Otherwise reject with path `['autoResolveConditions']`.
- **Exception**: a value that already carries `type` (a pre-W3 raw alert-condition blob) is accepted unchanged on update, so existing rows are not broken (ND3).
- The compiler emits `spec.toAlertCondition(parsed, ctx)` for kind-shaped values and passes `type`-bearing legacy values through.

- [ ] **Step 1: Write failing tests**: `event_log autoResolveConditions must parse as the event_log schema`; `rejects autoResolveConditions on kinds without a recovery schema`; `accepts an existing raw type-bearing blob on update`; compiler: `compiles the recovery condition through toAlertCondition` (fails today: copied raw, no `type`).
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/validators/monitors.test.ts` and `cd apps/api && npx vitest run src/services/monitors/monitorCompiler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the above plus `services/monitors/kinds/index.test.ts` and `routes/monitorDefinitions.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(monitors): event_log recovery condition validated and compiled by kind (#10538 W3)`.

### Task 18: Editor "Clears when" + alert-detail lifecycle line + E2E

**Files:**
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx` (section from Task 16), reuse `MonitorConditionFields.tsx` for the event_log fields, `apps/web/src/components/alerts/AlertDetailPage.tsx`, locales
- Test: `apps/web/src/components/monitoring/MonitorEditor.clearsWhen.test.tsx`, `apps/web/src/components/alerts/AlertDetailPage.lifecycle.test.tsx`, `e2e-tests/tests/monitor-clears-when.spec.ts`

Behaviour:
- "Clears when" shows only for kind `event_log` with effective auto-resolve on.
- New recovery conditions are prefilled with the trigger's `category`/`sourcePattern`, level `info`, window 60.
- Hint copy (en): "Clears only on an event logged after the alert's trigger event."
- The alert detail shows a line from the `context.lifecycle` snapshot, e.g. "Re-arms on new evidence · cooldown 5 min (partner default)".
- `data-testid`: `monitor-editor-clears-when`, `clears-when-message`, `clears-when-source`, `alert-lifecycle-line`.

- [ ] **Step 1: Write failing tests**:
  - `shows Clears when only for event_log with auto-resolve on`;
  - `prefills category and source from the trigger`;
  - `round-trips an existing recovery condition`;
  - `round-trips an existing raw recovery condition without dropping it` (renders read-only "Custom recovery condition (API)" with a Replace button);
  - `alert detail renders the lifecycle line from the snapshot`;
  - `alert without a snapshot renders no line`.
  E2E: create an event_log monitor with Clears when, inject On Battery → alert, inject Power Restored → resolved, advance past cooldown → no re-open.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/monitoring/MonitorEditor.clearsWhen.test.tsx src/components/alerts/AlertDetailPage.lifecycle.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, with all 8 locales.
- [ ] **Step 4: Run** the unit tests, locale parity, and the E2E on a `worktree-stack` (tear it down afterwards). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): event_log "Clears when" + alert lifecycle line (#10538 W3)`.

### Task 19: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/features/monitors.mdx`, `apps/docs/src/content/docs/features/alerts.mdx`

Content:
- **Lifecycle model:** an episode, new evidence, re-arm modes, cooldown, ack/mute auto-resolve.
- **Where to set it:** the defaults card, org override, monitor override, and how the source is shown.
- **UPS recipe:**
  - trigger: Application, Warning+, source `APCPBEAgent`, message "On Battery";
  - Clears when: same source, Information, message "Power Restored";
  - Information-level events from `APCPBEAgent` are collected by default (`eventLogProviders.ts:37`).
- **Behaviour change note** (W1) for upgraders.

- [ ] **Step 1:** Write the docs. Run the docs build (`pnpm --filter @breeze/docs build`). Expected: build passes, no broken links.
- [ ] **Step 2: Commit** `docs(monitors): alert lifecycle + UPS recovery recipe (#10538 W3)`. Before the final push: `git fetch origin main`. The PR body says `Refs #10538` unless the owner chooses `Closes` at Gate B.

---

## Decisions surfaced while planning (defaults taken; flag at Gate B)

- **ND1 — Tie-break in TypeScript, not SQL (Task 3).** The `exists after cursor` probe fetches up to 50 candidate rows from `timestamp >= cursor.ts − 1 s` and applies `isAfterCursor` in code. This avoids a jsonb `recordId` sort and a new `device_event_logs` index. Revisit only if Task 9's benchmark fails.
- **ND2 — Write gates (Task 14).** Partner default: partner scope + `ALERTS_WRITE` + `canManagePartnerWidePolicies`. Org override: `ALERTS_WRITE` + org access. This mirrors the partner-wide policy write gate rather than adding a new permission.
- **ND3 — Legacy raw recovery blobs (Tasks 17–18).** Existing `type`-bearing `autoResolveConditions` stay valid and compile unchanged. The editor shows them read-only with Replace instead of converting them silently.
- **ND4 — `monitor_definitions.cooldown_minutes`/`auto_resolve` lose their DB defaults (Task 11).** Inherit must be the default for new monitors, so any API caller omitting them now inherits. Monitors created through the API without these fields change meaning only when a partner/org default differs from 5/false.
