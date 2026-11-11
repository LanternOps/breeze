---
spec: docs/superpowers/specs/vuln-patch/2026-10-31-oem-vendor-updates-design.md
parent_plan: docs/superpowers/plans/vuln-patch/2026-11-05-oem-vendor-updates.md
issues: [11242, 11259]
related: [11065, 11074, 11241, 8139]
baseline_commit: 95a3e48db5
status: draft-for-approval
---

# OEM W09 follow-ups: fleet state query and export trigger cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Vendor updates fleet view answers a page or filter click with two indexed statements instead of reading and classifying the whole scope in Node (#11242), and multi-row writes to `device_hardware` under `breeze_app` cost time linear in the rows written, not in the table size or the square of the batch (#11259).

**Architecture:** Two independent waves, each shippable alone, no shared files.
- **W01** materialises the expensive, time-stable half of a device's display state (offered lane, winning policy link, reboot mode, the current occurrence's boundaries, managed-since) into a worker-maintained table, and expresses only `deriveOemDisplayState` — the cheap, time-dependent half — as a SQL `CASE` evaluated against a `now` parameter. A TS↔SQL parity test pins the two to the same answer.
- **W02** measures where the trigger time goes first, then rewrites the trigger step the measurement convicts. The leading suspect (verified by reading the SQL, not yet by measurement) is the legacy `breeze_partner_export_hardware_insert/_update` triggers' nested `UPDATE device_hardware … FROM new_rows` join.

**Tech Stack:** Hono + Drizzle (`apps/api`), PostgreSQL 16 plpgsql statement triggers, hand-written SQL migrations, BullMQ (`jobs/oemUpdatesWorker.ts`), Vitest unit + integration configs.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-10-31-oem-vendor-updates-design.md` (§4.2, §4.5, §4.8 for the states and the fleet view). Parent plan: `docs/superpowers/plans/vuln-patch/2026-11-05-oem-vendor-updates.md`, W09 T1, which already asked for "one indexed query per page, no per-device resolver walk".

## Global Constraints

- **Migration names** sort after the newest committed migration **and** after `2027-01-22-210100` (reserved by an in-flight PR; not on `main` at `95a3e48db5`, whose newest is `2027-01-22-210000-backup-provider-devices-verified-bootable.sql`). Proposed slots: W01 `2027-01-22-210200-device-oem-policy-side.sql`, W02 `2027-01-22-210300-partner-export-hardware-stamp-by-key.sql`. **Re-run `ls apps/api/migrations | grep -v -e optional -e preflight -e README | sort | tail -3` immediately before committing and again before enqueueing**; rename (never after merge) if something newer landed. The waves can merge in either order.
- Migrations: idempotent (`CREATE … IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP … IF EXISTS` before `CREATE TRIGGER/POLICY`), no inner `BEGIN;`/`COMMIT;`, never edit a shipped file, then `pnpm db:check-drift`. A migration that writes rows starts with `SELECT set_config('breeze.scope', 'system', true);` (`migrationRlsScope.test.ts`). Neither wave's migration writes rows as planned; if one gains a backfill, add the line.
- No function-attribute `SET "breeze.scope"` (superuser-only; `migrationGucAttributes.test.ts`, v0.97.0 EU incident). In-body save/elevate/restore only, per `2026-07-27-a-feature-policy-reference-ownership.sql`.
- Every composite FK to `devices(id, org_id)` is `DEFERRABLE INITIALLY IMMEDIATE`.
- Request code uses `db` inside the request's `withDbAccessContext`; worker code uses `withSystemDbAccessContext`, one short context per page (#1105).
- `pnpm test` runs neither the integration suites nor the RLS/cascade/export contracts. They fail only in CI's **Integration Tests** job (16 shards). Run them locally against `pnpm test-stack up` before opening the PR, and `pnpm test-stack down` afterwards.
- Never `pnpm --filter @breeze/api test -- --run <path>`; run `cd apps/api && npx vitest run <path>` (unit) or `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` (integration). Vitest path filters are substring matches: pass the full path.
- API typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo "exit=$?"` — read the exit code, never pipe to `tail` (a heap OOM reads as green).

## Review Focus

1. **SQL NULL three-valued logic in the state `CASE`.** `NOT (last_outcome IN (…))` is NULL, not true, when `last_outcome` is NULL, so a device out of attempts with no outcome would skip `overdue`. Expected: identical to the TS rule for every NULL combination. Pinned by W01 T2's parity matrix, which includes NULL for every nullable input.
2. **The 72-hour reboot hold across a DST change.** `now - reboot_pending_since >= interval '3 days'` is calendar arithmetic under the session `TimeZone` and differs from the TS `3 * DAY_MS` by an hour across a DST boundary. Expected: exactly 72 h. Pinned by W01 T2 (`interval '72 hours'`, plus a parity row straddling 2026-11-01 US DST end).
3. **A policy edit followed straight away by the fleet view.** Expected: the new state within seconds, not after the 10-minute tick. Pinned by W01 T4's targeted refresh test.
4. **A device past its occurrence rollover, newly enrolled, or under a just-flipped kill switch, before the worker ran.** Expected: treated as pending and refreshed in-request (≤ 500) rather than silently counted under the previous occurrence or as "not managed". Pinned by W01 T2 (a policy row past `refresh_after` still yields a valid state), T3 (`dueOnly`, fingerprint) and T5 (pending cases).
5. **Org merge and device org moves under the W02 trigger change.** `UPDATE device_hardware SET org_id = …` (merge repoint) and the `ON UPDATE CASCADE` per-device statements must still lock both orgs and advance the watermark. Pinned by W02 T3's merge and move cases.

---

## Wave W01 — Fleet view state in SQL over a materialised policy side (#11242)

**Migration:** yes, one. **Tier:** Opus for T1–T3 design-bearing work; Sonnet for T4 hook wiring and T5 test scaffolding (see split).

### Design decision (W01)

Three shapes were considered for "the state rule in SQL, or a materialised state column":

| Option | What it needs | Verdict |
|---|---|---|
| **A. Whole rule in SQL** | Re-implement in SQL: env flag + partner allowlist + kill switches + per-device category gates (`flags.ts`, `toolManifest.ts`), hardware applicability rules (`applicability.ts`), link resolution across partner/org/site/group/device assignments (`resolver.ts` `pickOemLink`), and the monthly schedule occurrence in the device's IANA zone with catch-up nights and DST (`occurrence.ts`). | **Rejected.** Two implementations of four rule sets, three of which read process env that SQL cannot see. The spec's "one rule for the device section, the fleet view and the alerts" would rest on hand-kept parity across hundreds of lines. |
| **B. Stored final `display_state` column** | Worker writes the classified state per device. | **Rejected.** The state moves with time alone: `reboot_overdue` at +72 h, `overdue` when the last night closes, occurrence rollover. A stored state is wrong between ticks at every such boundary, and the result writer (`results.ts`) would also have to re-classify on every agent report. |
| **C. Materialised policy side + `deriveOemDisplayState` in SQL** (chosen) | Worker materialises the inputs that are expensive and stable between known instants (lane, link, reboot mode, occurrence key, last night's start and end, rollover instant, managed-since). The ~30-line pure `deriveOemDisplayState` becomes a SQL `CASE` over the live status row + the policy-side row + a `now` parameter. | **Chosen.** Time boundaries inside an occurrence are exact (compared against `now` in SQL). Agent results need no hook (the CASE reads the live status row). Only the policy side can go stale, with a stated bound. The duplicated surface is one small pure function, pinned by an exhaustive parity test that imports the TS constants. |

**Staleness contract (C).** Every in-scope device gets a row (`offered_lane` NULL when no lane), so "no row" means "never computed", not "no lane". Rows are refreshed (a) for every device in OEM-enabled partners on each 10-minute worker tick, (b) for one partner within ~5 s after a write to that partner's OEM links or policy assignments in `services/configurationPolicy.ts` (deduplicated BullMQ job), and (c) rows whose `refresh_after` (occurrence rollover) has passed are refreshed first on every tick.
- **Pending rows are explicit, never silently "not managed".** A row is *pending* when it is missing, its `refresh_after <= now`, or its `gates_fingerprint` differs from the API process's current gate fingerprint (env flag, partner allowlist, kill switches, manifest gate state — so a kill switch flipped at deploy is authoritative before the first tick). The counts statement also returns the pending count for the scope. If `0 < pending <= 500`, the route refreshes exactly those devices in-request (one `refreshOemPolicySide({ deviceIds })` call over ids the RLS-scoped statement returned, run in a short system context so zones resolve as the worker's do) and re-runs the two statements; if `> 500`, it enqueues a scope refresh and answers with the rows it has, classifying pending ones through the same SQL as "no link" and returning `pendingRefresh: n` (an additive field; the W09 web view ignores unknown fields).
- Changes not routed through (b) and not visible in the fingerprint — hardware model, device role, site/group membership, timezone settings, assignment writes from other services (`deviceGroupDelete.ts`, `fleetDesign/rollback.ts`, MCP defaults, software-inventory policy) — show within one tick. That residual lag is the disagreement recorded in Open question 4.
- **Deliberate semantic change:** `fleet.ts` today documents that an org-scoped caller, unable to read the partner row, resolves a partner-only timezone as UTC. The worker resolves zones in system scope, so every caller now sees the partner's zone — the same zone the overdue sweep already uses. The doc comment in `fleet.ts` is updated to say so.

**Why a new table and not columns on `device_oem_update_status`:** status rows exist only for devices the command has touched (the fleet query `LEFT JOIN`s it, and `applicability` is `NOT NULL` agent-reported state). Policy-side rows exist for every in-scope device and have a different single writer (the worker, plus the route's bounded pending refresh through the same function). Putting both in one row would make row existence ambiguous for `dispatch.ts`, `results.ts`, `releaseSweep.ts` and the device section. Open question 1 asks the owner to confirm. **`org_id NOT NULL` justification (Partner-Wide First):** this is per-device derived state, not a config/policy table; the device's org is its only owner.

**Not in scope:** moving `overdueSweep.ts` or the device section onto the table. They keep calling `classifyOemDevice`; the parity test is what keeps all three in agreement. A follow-up can switch the sweep once the table has run in production.

### File structure (W01)

- Create `apps/api/migrations/2027-01-22-210200-device-oem-policy-side.sql` — table, FKs, RLS shape 1, indexes.
- Modify `apps/api/src/db/schema/oemUpdates.ts` — `deviceOemPolicySide` table.
- Create `apps/api/src/services/oemUpdates/displayStateSql.ts` — `oemDisplayStateSql()` SQL fragment (the mirror of `deriveOemDisplayState`).
- Create `apps/api/src/services/oemUpdates/policySideStore.ts` — pure row computation + paged refresh.
- Modify `apps/api/src/services/oemUpdates/occurrence.ts` — `occurrenceBoundaries()`.
- Modify `apps/api/src/jobs/oemUpdatesWorker.ts` — tick stage + `policy-side-refresh` job.
- Modify `apps/api/src/services/configurationPolicy.ts` — enqueue targeted refresh after commit.
- Modify `apps/api/src/routes/oemUpdates/fleet.ts`, `fleet.test.ts` — two-statement route.
- Modify the registration lists (T1): `services/tenantCascade.ts`, `routes/devices/core.ts` (three lists), `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `services/deviceInstallBoundary/classification.ts`, plus any test allowlist the grep in T1 finds.
- Tests: `displayStateSql.integration.test.ts`, `policySideStore.test.ts`, `oemUpdatesFleet.integration.test.ts` (rewrite the scale case), `oemPolicySideRls.integration.test.ts`.

### W01 Task 1: `device_oem_policy_side` table, RLS and registration

**Files:**
- Create: `apps/api/migrations/2027-01-22-210200-device-oem-policy-side.sql`
- Modify: `apps/api/src/db/schema/oemUpdates.ts`, and every file `grep -rln "device_oem_update_status" apps/api/src | grep -v -e __tests__ -e db/schema` returns (at `95a3e48db5`: `services/tenantCascade.ts`, `routes/devices/core.ts` ×3 lists, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `services/deviceInstallBoundary/classification.ts`, `services/deviceInstallBoundary/handlers/installState.ts` if it enumerates tables, and `routes/devices/moveOrg.coverage.test.ts` allowlists if any)
- Test: `apps/api/src/__tests__/integration/oemPolicySideRls.integration.test.ts`

**Interfaces:**
- Produces: table `device_oem_policy_side` and Drizzle `deviceOemPolicySide` with columns

| column | type | notes |
|---|---|---|
| `device_id` | `uuid` PK | |
| `org_id` | `uuid NOT NULL` | FK `organizations(id) ON DELETE CASCADE` |
| `offered_lane` | `varchar(16) NULL` | NULL = no lane; check against `OEM_LANES`, same check text as `device_oem_update_status_lane_chk` |
| `gates_fingerprint` | `varchar(64) NOT NULL` | `oemGatesFingerprint()` at compute time (T3) |
| `link_id` | `uuid NULL` | bare uuid (derived pointer, no FK) |
| `link_enabled` | `boolean NOT NULL` | `OemPolicySide.linkEnabled` |
| `reboot_mode` | `varchar(16) NULL` | check `IN ('overnight','never')` |
| `occurrence_key` | `varchar(64) NULL` | |
| `last_night_start` | `timestamptz NULL` | window start of the occurrence's last night |
| `past_last_night_at` | `timestamptz NULL` | window end of the occurrence's last night |
| `refresh_after` | `timestamptz NULL` | next occurrence's first window start (rollover) |
| `managed_since` | `timestamptz NULL` | |
| `computed_at` | `timestamptz NOT NULL DEFAULT now()` | |

  Composite FK `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` named `device_oem_policy_side_device_org_fk`. Indexes: `device_oem_policy_side_org_idx (org_id)`, `device_oem_policy_side_refresh_idx (refresh_after) WHERE refresh_after IS NOT NULL`.
- RLS shape 1: `ENABLE` + `FORCE`, four `breeze_org_isolation_*` policies on `breeze_has_org_access(org_id)` — copy the block from `2027-01-22-140000-device-oem-update-status.sql` L97–L120 verbatim with the table name changed.
- Registration: add `device_oem_policy_side` beside `device_oem_update_status` in every list the grep returns, with the same comment shape (`#11242 — derived per-device policy side; restamped by its composite FK's ON UPDATE CASCADE`). Merge policy `repoint`. Export policy: `tablePolicy("org_id", { included: [all thirteen columns], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })` — typed columns only, no json/jsonb/bytea.

- [ ] **Step 1: Write the failing RLS test.** `oemPolicySideRls.integration.test.ts`: `it('an org caller reads only its org\'s policy-side rows')`, `it('a partner caller reads its orgs\' rows and not another partner\'s')`, `it('breeze_app cannot insert a row for an org outside its access')` (expect SQLSTATE `42501`), `it('deleting the device removes its row')`, `it('moving the device to another org restamps org_id through the FK')`. Mirror `oemUpdateStatusRls.integration.test.ts`.
- [ ] **Step 2: Run it to see it fail.** `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemPolicySideRls.integration.test.ts` → FAIL, `relation "device_oem_policy_side" does not exist`.
- [ ] **Step 3: Write the migration and the Drizzle table**, then `pnpm db:migrate && pnpm db:check-drift` (no drift).
- [ ] **Step 4: Register the table** in every list from the grep above.
- [ ] **Step 5: Run the RLS test and the contracts.**
  - `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemPolicySideRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` → PASS
  - `cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage` → PASS
  - `cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/cascadeDelete.test.ts src/services/orgMerge.test.ts src/db/migrationRlsScope.test.ts src/db/migrationGucAttributes.test.ts` → PASS
- [ ] **Step 6: Commit** `feat(api): device_oem_policy_side table for the fleet view (#11242)`

### W01 Task 2: The state rule in SQL, with a parity test

**Files:**
- Create: `apps/api/src/services/oemUpdates/displayStateSql.ts`
- Test: `apps/api/src/__tests__/integration/oemDisplayStateSql.integration.test.ts`

**Interfaces:**
- Consumes: `deriveOemDisplayState`, `OEM_REBOOT_OVERDUE_NIGHTS`, `FINISHED_OUTCOMES` (`displayState.ts`); `OEM_MAX_ATTEMPTS_PER_OCCURRENCE` (`occurrence.ts`). Export `FAILING_OUTCOMES` from `displayState.ts` (currently module-private) so the SQL can bind it.
- Produces: `oemDisplayStateSql(cols: OemStateSqlColumns, now: Date): SQL<OemDisplayState>` where `OemStateSqlColumns = { applicability, rebootPendingSince, lastOutcome, occurrenceKey, attempts, lastSuccessAt: AnyColumn | SQL; policy: { linkEnabled, rebootMode, occurrenceKey, lastNightStart, pastLastNightAt, managedSince: AnyColumn | SQL } }`. Every constant is bound from the TS value, never written as a literal. Branch order is exactly `deriveOemDisplayState`'s. NULL handling: every `IN (…)` test wrapped `COALESCE(…, false)`; a missing policy row ≡ `linkEnabled = false`, no reboot mode, no occurrence. Reboot hold: `${now} - reboot_pending_since >= make_interval(hours => ${OEM_REBOOT_OVERDUE_NIGHTS * 24})`. Past last night: `past_last_night_at IS NOT NULL AND ${now} >= past_last_night_at`. Had a chance: `NOT (managed_since IS NOT NULL AND last_night_start IS NOT NULL AND managed_since >= last_night_start)`.

- [ ] **Step 1: Write the failing parity test.** Build a matrix in TS: `applicability ∈ {null, 'applicable', 'not_applicable', 'not_supported'}` × `rebootPendingSince ∈ {null, now−71h59m, now−72h, now−72h straddling 2026-11-01T06:00Z}` × `rebootMode ∈ {undefined, 'overnight', 'never'}` × `linkEnabled ∈ {false, true}` × `lastOutcome ∈ {null, each of the 10 OemOutcome values}` × `occurrence match ∈ {null key, same key, other key}` × `attempts ∈ {null, 0, 2, 3, 4}` × `isPastLastNight ∈ {false, true}` × `managedSince ∈ {null, before last night, equal to last night start, after}` × `lastSuccessAt ∈ {null, set}`. Prune to ≤ 20k rows by fixing `applicability = 'applicable'` outside its own axis. For each row compute `expected = deriveOemDisplayState(...)`, then evaluate all rows in one statement: `SELECT idx, ${oemDisplayStateSql(...)} FROM jsonb_to_recordset(${rows}) AS r(...)`, with `SET LOCAL TimeZone = 'America/New_York'` to expose interval drift. `it('the SQL state equals deriveOemDisplayState for every input combination')` asserts zero mismatches and prints the first 20 diffs on failure. Plus `it('a policy row whose refresh_after has passed still yields a state')`.
- [ ] **Step 2: Run to see it fail.** `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemDisplayStateSql.integration.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `oemDisplayStateSql`** in `displayStateSql.ts`. Header comment: "mirror of `deriveOemDisplayState`; change both or neither; the parity test enforces it".
- [ ] **Step 4: Run the parity test** (same command) → PASS. Also `cd apps/api && npx vitest run src/services/oemUpdates/displayState.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(api): vendor update display state as SQL, pinned to the TS rule (#11242)`

### W01 Task 3: Policy-side computation, paged refresh, worker stage

**Files:**
- Modify: `apps/api/src/services/oemUpdates/occurrence.ts`, `apps/api/src/jobs/oemUpdatesWorker.ts`
- Create: `apps/api/src/services/oemUpdates/policySideStore.ts`
- Test: `apps/api/src/services/oemUpdates/occurrence.test.ts`, `apps/api/src/services/oemUpdates/policySideStore.test.ts`, `apps/api/src/jobs/oemUpdatesWorker.test.ts`

**Interfaces:**
- Produces in `occurrence.ts`: `occurrenceBoundaries(schedule: OemOccurrenceSchedule, timezone: string, now: Date): { occurrenceKey: string; lastNightStart: Date; pastLastNightAt: Date; refreshAfter: Date }` — `lastNightStart`/`pastLastNightAt` are the window of night `catchUpNights` after the anchor; `refreshAfter` is the next month's anchor window start (the instant `computeOccurrence` switches key). Invariant tested: for any `t` in `[now, refreshAfter)`, `computeOccurrence(schedule, tz, t).occurrenceKey === occurrenceKey` and `.isPastLastNight === (t >= pastLastNightAt)`.
- Produces in `policySideStore.ts`:
  - `type OemPolicySideRow` (camelCase of T1's columns minus `computedAt`).
  - `oemGatesFingerprint(): string` — sha256 (hex, 64 chars) of the canonical JSON of everything `flags.ts` and `toolManifest.ts` read from env or the manifest that can change a device's policy side: the master flag, the partner allowlist, each lane's kill switch, each lane×category gate state, `SHIPPED_OEM_LANES`. Computed once per process (env is fixed per process).
  - `computeOemPolicySideRow(facts: OemDeviceFacts & DeviceTimezoneFields & { orgId: string; siteId: string; groupIds: string[] | null }, candidates: readonly OemLinkCandidate[], now: Date, occurrenceOf: ReturnType<typeof oemOccurrenceMemo>): OemPolicySideRow` — always a row; `offeredLane = oemOfferedLane(facts)` (may be null, then `linkEnabled = false` and every occurrence field null). Reuses `pickOemLink`, `effectiveTimezoneFrom`, `oemPolicySide`; occurrence fields from `occurrenceBoundaries` (memoised per `linkId|timezone`), all null when `linkEnabled` is false; `refreshAfter` null when there is no occurrence.
  - `refreshOemPolicySide(opts: { now: Date; scope?: { partnerId: string } | { orgId: string } | { deviceIds: string[] }; dueOnly?: boolean }): Promise<{ upserted: number; pages: number }>` — keyset pages of 500 devices by `devices.id` (same scope predicate as `fleetScopeCondition` minus site restriction), each page in its own `withSystemDbAccessContext`. The `deviceIds` form is called in-request by T5 with ids the caller's RLS-scoped statement already returned; it runs via `runOutsideDbContext(() => withSystemDbAccessContext(…))` so the zone and partner-wide links resolve exactly as the worker resolves them (an org-scoped request context cannot read the partner row), and it never widens beyond the ids passed; loads candidates once per run with `loadOemLinkCandidates()`; upserts with `ON CONFLICT (device_id) DO UPDATE … WHERE (excluded.*) IS DISTINCT FROM (current row minus computed_at)` so unchanged rows are not rewritten. `dueOnly` restricts to rows with `refresh_after <= now` or a stale `gates_fingerprint`. Flag off (`!oemUpdatesFlagOn()`): rows are still written (all `offeredLane = null`), so the pending logic stays uniform.
  - Worker: new first stage `['policy side', (at) => refreshOemPolicySide({ now: at, dueOnly: true }).then(() => refreshOemPolicySide({ now: at }))]` in `runOemUpdatesTick`; new job name `policy-side-refresh` handled by the existing worker processor, data `{ partnerId } | { orgId }`.
  - `requestOemPolicySideRefresh(scope: { partnerId: string } | { orgId: string }): Promise<void>` exported from `jobs/oemUpdatesWorker.ts` — `queue.add('policy-side-refresh', scope, { jobId: \`policy-side:${id}\`, delay: 5_000, removeOnComplete: true, removeOnFail: 20 })`; swallow and `captureException` on Redis errors (a missed targeted refresh falls back to the tick).

- [ ] **Step 1: Write the failing unit tests.** `occurrence.test.ts`: `it('occurrenceBoundaries agrees with computeOccurrence at every minute of a sampled month, America/New_York across DST end')`, `it('refreshAfter is the instant the occurrence key changes')`. `policySideStore.test.ts` (mocked db, existing `fleet.test.ts` mocking style): `it('no offered lane → a row with offeredLane null and linkEnabled false')`, `it('kill switch → linkEnabled false, rebootMode kept')`, `it('device-group assignment wins over org assignment')`, `it('occurrence fields are null when the link is disabled')`, `it('a partner-only timezone resolves to the partner zone, not UTC')`, `it('refresh upserts changed rows and skips unchanged ones')`, `it('a device that lost its lane gets offeredLane null')`, `it('dueOnly selects rows past refresh_after or with a stale gates fingerprint')`, `it('the gates fingerprint changes when a kill switch env var changes')`. `oemUpdatesWorker.test.ts`: `it('the tick runs the policy side stage before overdue alerts')`, `it('requestOemPolicySideRefresh dedupes per scope')`.
- [ ] **Step 2: Run to see them fail.** `cd apps/api && npx vitest run src/services/oemUpdates/occurrence.test.ts src/services/oemUpdates/policySideStore.test.ts src/jobs/oemUpdatesWorker.test.ts` → FAIL.
- [ ] **Step 3: Implement** `occurrenceBoundaries`, `policySideStore.ts`, the worker stage and job.
- [ ] **Step 4: Run them** (same command) → PASS. Plus `cd apps/api && npx vitest run src/services/oemUpdates/ src/jobs/oemUpdatesWorker` → PASS.
- [ ] **Step 5: Commit** `feat(api): worker keeps the vendor update policy side per device (#11242)`

### W01 Task 4: Targeted refresh on policy writes

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts`
- Test: `apps/api/src/services/configurationPolicy.test.ts` (or the nearest existing test file for these functions)

**Interfaces:**
- Consumes: `requestOemPolicySideRefresh` (T3).
- Call sites: every function in `configurationPolicy.ts` that calls `assertOemUpdatesLinkWrite` (link create/update/delete), and every function there that inserts into or deletes from `configPolicyAssignments` **for a policy that has an `oem_updates` feature link** (one indexed existence read, inside the same transaction, before commit). Call after the transaction resolves, never inside it. Scope = the policy's `partnerId`, else its `orgId`. No call when `!oemUpdatesFlagOn()`.

- [ ] **Step 1: Failing tests:** `it('writing an oem_updates link enqueues a refresh for its partner')`, `it('assigning a policy with an oem_updates link enqueues a refresh')`, `it('assigning a policy without one enqueues nothing')`, `it('a rolled-back write enqueues nothing')`, `it('flag off enqueues nothing')`.
- [ ] **Step 2: Run to fail:** `cd apps/api && npx vitest run src/services/configurationPolicy.test.ts` → FAIL.
- [ ] **Step 3: Implement** the post-commit calls.
- [ ] **Step 4: Run to pass** (same command) → PASS.
- [ ] **Step 5: Commit** `feat(api): refresh the vendor update policy side when its policy changes (#11242)`

### W01 Task 5: Two-statement fleet route and the 10k scale test

**Files:**
- Modify: `apps/api/src/routes/oemUpdates/fleet.ts`, `apps/api/src/routes/oemUpdates/fleet.test.ts`, `apps/api/src/__tests__/integration/oemUpdatesFleet.integration.test.ts`

**Interfaces:**
- Consumes: `deviceOemPolicySide` (T1), `oemDisplayStateSql` (T2).
- Produces (response JSON **unchanged** from W09: `{ counts: Record<OemDisplayState, number>, total, devices: [...] }`, same row fields, same order `lower(hostname), id`; the web `VendorUpdatesView.tsx` is not touched):
  - `fleetStateBase(where: SQL | undefined, now: Date, flagOn: boolean)` — `devices` ⋈ `organizations` ⟕ `sites` ⟕ `device_oem_update_status` ⟕ `device_oem_policy_side ON p.device_id = d.id AND ${flagOn}`, exposing `state = oemDisplayStateSql(...)` and `lane = COALESCE(p.offered_lane, s.lane)`.
  - Statement 1 `fleetCountsQuery`: `SELECT state, count(*) … WHERE scope [AND lane = $lane] GROUP BY state`.
  - Statement 2 `fleetPageQuery`: the row columns `… WHERE scope [AND lane] [AND state = $state] ORDER BY lower(hostname), id LIMIT $limit OFFSET $offset`.
  - `total = state ? counts[state] : sum(counts)`. Both statements receive the same `now` (one `new Date()` per request). `loadOemLinkCandidates` and `classify` are removed from the steady-state path; `partners` is no longer joined (zones are materialised).
  - Pending: statement 1 also returns `count(*) FILTER (WHERE p.device_id IS NULL OR p.refresh_after <= $now OR p.gates_fingerprint <> $fp)` over the scope (no lane filter). `0 < pending <= 500` → `refreshOemPolicySide({ now, deviceIds })` for those ids (one extra id-select), then statements 1–2 again; `> 500` → `requestOemPolicySideRefresh` for the caller's org or partner, answer as is, add `pendingRefresh`. Pending rows are evaluated with the policy columns forced NULL (`CASE WHEN pending THEN NULL ELSE p.col END`).
- Index check: `devices_org_hostname_lower_idx (org_id, lower(hostname))` already exists; no new index on `devices`.

- [ ] **Step 1: Rewrite the unit tests first** in `fleet.test.ts`: keep every existing scope/filter/permission case; replace the classify-based assertions with `it('issues exactly two statements whatever the scope size when nothing is pending')` (count `db.select`/`db.execute` calls), `it('total is the selected state\'s count, or the sum without a state')`, `it('flag off leaves the policy side out of the join')`, `it('a few pending devices are refreshed in-request and then counted')`, `it('more than 500 pending enqueues a scope refresh and returns pendingRefresh')`, `it('a row with a stale gates fingerprint counts as pending')`.
- [ ] **Step 2: Rewrite the integration scale case first.** In `oemUpdatesFleet.integration.test.ts` replace `fleet at scale` with `runDb('fleet at 10,000 devices: two statements, under budget, counts agree with the rule')`:
  - Seed 10,000 devices + hardware + status + policy-side rows through `getTestDb()` in one transaction with `SET LOCAL session_replication_role = replica` (owner connection; skips the export triggers #11259 is about, so the seed takes seconds; the rows are consistent by construction). Mix states: 2,000 `up_to_date`, 2,000 `overdue` (past last night), 1,000 `failing`, 1,000 `waiting_for_reboot`, 1,000 `reboot_overdue`, 500 `not_supported`, rest `not_managed`. `ANALYZE` the five tables.
  - Count statements by wrapping the route's client: `vi.spyOn(db, 'select')` + `vi.spyOn(db, 'execute')`; expect `2` for `?orgId=…&limit=50`, for `&state=failing`, and for `&lane=dell&offset=9950`.
  - Latency: one warm-up request, then the median of 5 requests `< 300 ms` for each of the three URLs (W09 measured 400–900 ms on a local stack for the old route; CI hosts are slower than local, so the budget is for the route, not the host — record the measured median in the PR body).
  - Correctness: `counts` equal the seeded mix; additionally, for 200 sampled devices, `classifyOemDevice` over the same facts returns the same state the route listed (end-to-end parity with the worker's materialisation computed by `refreshOemPolicySide` on those 200).
  - Plan: `EXPLAIN` of `fleetPageQuery` for the small org does not contain `Seq Scan on devices` (keep the existing assertion's technique).
  - Timeout: `120_000`.
- [ ] **Step 3: Run both to fail:** `cd apps/api && npx vitest run src/routes/oemUpdates/fleet.test.ts` and `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemUpdatesFleet.integration.test.ts` → FAIL.
- [ ] **Step 4: Implement** the two-statement route.
- [ ] **Step 5: Run both to pass** (same commands), then the whole OEM integration set: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemUpdatesFleet.integration.test.ts src/__tests__/integration/oemDisplayStateSql.integration.test.ts src/__tests__/integration/oemPolicySideRls.integration.test.ts src/__tests__/integration/oemUpdateStatusRls.integration.test.ts` → PASS. Typecheck (Global Constraints command) → `exit=0`.
- [ ] **Step 6: Commit** `perf(api): fleet view in two indexed statements over the materialised policy side (#11242)`

### Execution split and parallelism (W01)

- **Seams:** T1 fixes the table and column names; T2 fixes `oemDisplayStateSql`'s signature; T3 fixes `requestOemPolicySideRefresh` and `refreshOemPolicySide`.
- **PARALLEL GROUPS:** {T1, T2} (T2's parity test needs no table: it evaluates over `jsonb_to_recordset`), then {T3}, then {T4, T5}.
- **Sonnet-eligible:** T1 Step 4 (registration lists, grep-driven), T4 (hook wiring, once T3's interface exists), T5 Step 1 (unit test rewrite). **Opus:** T2 (NULL/interval semantics), T3 (occurrence boundaries across DST, upsert guard), T5 Step 2/4 (the route and the scale test).
- **CI traps:** the RLS, cascade, merge and export contracts reds only in **Integration Tests**, never Test API; `orgMerge.test.ts` reds only in the full unit suite. Run T1 Step 5's list locally before the PR.

---

## Wave W02 — Partner-export trigger cost on bulk `device_hardware` writes (#11259)

**Migration:** yes, one (function DDL only, unless T1 convicts something else). **Tier:** Opus throughout (trigger + lock invariants), Sonnet for the measurement harness scaffolding.

### What the code says today (read, not yet measured)

- The issue asks to "make the trigger set-based (statement-level with a transition table)". **That is already the shape.** Every partner-export trigger on `device_hardware` is `FOR EACH STATEMENT … REFERENCING NEW/OLD TABLE`:
  - `breeze_partner_export_hardware_insert` / `_update` (`2026-07-18-partner-export-org-locks.sql` L357–L480) — `SECURITY INVOKER`; lock orgs, then a **nested** `UPDATE public.device_hardware target SET partner_export_updated_at = next_timestamp(…) FROM new_rows changed WHERE target.device_id = changed.device_id`. That nested statement is itself an UPDATE on `device_hardware`, so it fires `hardware_update` and `material_update` again with N-row transition tables.
  - `breeze_partner_export_hardware_delete` (`2026-07-19-…`), and the generic `breeze_partner_export_material_insert/update/delete` → `breeze_partner_export_device_child_*` (`SECURITY DEFINER`, `to_jsonb` per row; latest bodies `2026-10-14-100200-…`, `2026-10-28-100000-…`, `2026-11-01-110000-…`) → `breeze_partner_export_touch_devices` → `breeze_partner_export_lock_orgs_exclusive` (deliberately `SECURITY INVOKER` so every org must resolve through RLS).
  - Per-row `BEFORE UPDATE OF partner_export_updated_at` guard (`WHEN pg_trigger_depth() = 0`), so it skips the nested stamp.
- `device_hardware.partner_export_updated_at` is read by `routes/partnerApi/devices.ts` (`GREATEST(devices, hardware)` cursor), so the stamp stays; it must be drawn **after** the exclusive org lock (header of `2026-10-28-100000-…`).
- **Evidence on record** (`oemUpdatesFleet.integration.test.ts` ~L128 and ~L305, PR #11241): one 10,000-row INSERT ≈ 100 s on a fresh DB; 500-row batches in one transaction "linear"; under `breeze_app` ≈ 3 s per 500-row batch vs ≈ 50 ms on the owner connection; but also "~4.5 s at 2,500 rows, ~50 s at 10,000" through the owner, which is not linear. The numbers disagree with each other, which is why T1 measures before anything changes.
- **Production writers** of `device_hardware` (`services/inventoryChildSync.ts`, `routes/agents/enrollment.ts`) upsert **one row per statement**. Enrolment bursts are many one-row statements, not one big one. The multi-row paths are **org merge** (`orgMergeExecutors.ts` L41: `UPDATE device_hardware SET org_id = survivor WHERE org_id = loser` — an UPDATE, not an insert) and **device org moves**, where `devices → device_hardware` is `ON UPDATE CASCADE` and the RI trigger issues one child UPDATE statement per moved device. The task brief's "org merge bulk-inserts" is therefore a bulk UPDATE; T1 measures that path, not an INSERT.
- **Leading hypothesis:** the nested stamping `UPDATE … FROM new_rows` is planned as a hash/merge join that seq-scans `device_hardware`, evaluating the RLS predicate (`breeze_has_org_access(org_id)`) on every row of the table, per statement — cost ∝ statements × table size × predicate cost; with stale stats (fresh table, bulk load inside one transaction) a single big statement can nested-loop and go quadratic. Under the owner connection locally (superuser), RLS is bypassed, which explains the app-role gap.

### Codex opinion (independent, read-only, `gpt-6-astra` xhigh)

Asked: verify the hypothesis, choose set-based rewrite vs per-statement work bound, RLS semantics, org-merge risks. Ran 2026-11-08 against `95a3e48db5`; read the SQL and callers, ran nothing. Summary, with what this plan did with each point:

- **Agrees** the transition-table remedy is already in place and the choice is "measure, then a targeted SECURITY INVOKER rewrite"; rejects app-side chunking as anything more than an interim mitigation, BEFORE ROW stamping (loses statement-wide ascending org lock order, complicates upserts), and a scope-elevated definer stamp (widens authority, including for nested triggers) before profiling. → Same as this plan.
- **Disagrees in part with the hypothesis:** a per-statement table scan explains `statements × table size × predicate cost` but **does not alone explain quadratic growth inside one statement** — look for repeated scans, join choice and spills. It also names the nested stamp's second-order cost: the nested UPDATE fires `device_child_update`, whose excluded-column short-circuit skips the lock and touch but **not** the unconditional owner-validation `EXISTS`, the per-row `to_jsonb` and the old/new `FULL JOIN`. → Folded into T1 (both are measured separately) and Gate B. Not resolved: whether T2 should also skip the generic diff for the nested stamp is left to the T1 numbers.
- **`ANY(uuid[])` makes an index condition possible, not certain** (large arrays, generic cached plans can still seq-scan). Acceptance must rest on measured plans and scaling, not SQL shape. → T2's acceptance is T1's tuple-count guards plus the recorded nested plans, not the rewrite itself.
- **Measurement additions:** vary batch at fixed table size *and* grow unrelated tenants' data at fixed batch; singleton upserts, mixed conflicts, material vs non-material updates, deletes (the hardware delete trigger's nested `devices` update), merges; fresh vs analyzed and custom vs generic plans; record role attributes, function owner, scope and accessible-org-list size; nested `auto_explain` with `ANALYZE, BUFFERS`; `pg_stat_user_functions` misses inlined SQL functions. Count actual statement-trigger invocations for FK cascades rather than assuming one per parent row. → All added to T1's matrix.
- **RLS corrections (verified by this plan's author):** `doadmin` on hosted prod is **not** a superuser but **has BYPASSRLS** (`2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql` L149–L160 documents it; `apps/api/scripts/check-migrations-nonsuperuser.ts` reproduces it); CI/local `breeze_test` is superuser + BYPASSRLS; a self-hosted owner without BYPASSRLS is bound by `FORCE`. And `lock_orgs_exclusive`, though `SECURITY INVOKER`, runs as the **definer** identity when called from the `SECURITY DEFINER` `device_child_*`/`touch_devices` chain, not as `breeze_app` — so its "orgs must resolve through RLS" check depends on the call chain and the owner's attributes. → W02 T2's header comment and T1's recorded role attributes reflect this; the hosted-prod RLS cost sits only on the invoker legs (`hardware_insert/_update` and their nested stamp).
- **Org merge:** already runs in system scope and pre-locks both orgs in UUID order (`orgMerge.ts` ~L1344); keep OLD+NEW org locking and the unconditional owner validation. → T3 invariant cases.

### File structure (W02)

- Create `apps/api/src/__tests__/integration/partnerExportTriggerCost.integration.test.ts` — measurement harness (env-gated matrix) + always-on deterministic guards.
- Create `docs/perf/2026-11-partner-export-trigger-cost.md` — the measured numbers (T1 output) and the before/after table (T3).
- Create `apps/api/migrations/2027-01-22-210300-partner-export-hardware-stamp-by-key.sql` — the trigger change.
- Modify `apps/api/src/__tests__/integration/oemUpdatesFleet.integration.test.ts` comments only if W01 has not already replaced the seed (drop the "~100 s" note once fixed).

### W02 Task 1: Measure — where the time goes, per row, by batch size

**Files:**
- Create: `apps/api/src/__tests__/integration/partnerExportTriggerCost.integration.test.ts`, `docs/perf/2026-11-partner-export-trigger-cost.md`

**Interfaces:**
- Produces: `measureTriggerCost(opts: { table: 'device_hardware' | 'software_inventory'; op: 'insert' | 'upsert-one' | 'merge-repoint' | 'org-move'; batch: number; role: 'owner' | 'app-system' | 'app-partner'; stats: 'fresh' | 'analyzed'; preexisting: number }): Promise<{ ms: number; perRowUs: number; seqTupRead: number; idxTupFetch: number; fnMs: Record<string, number>; nestedPlans: string[] }>` (test-local helper).
- Mechanics (decided here so the numbers are comparable):
  - Role: `owner` = `getTestDb()` (superuser locally and in CI — RLS bypassed). `app-*` = same owner session, after `LOAD 'auto_explain'` and the `SET`s below, then `SET ROLE breeze_app` plus the request GUCs (`breeze.scope` = `system` or a partner scope with `breeze.accessible_org_ids` listing 20 orgs, matching how `withDbAccessContext` sets them — read `apps/api/src/db/index.ts` for the exact GUC names).
  - Function timing: `SET track_functions = 'all'`; read `pg_stat_xact_user_functions` (`self_time`, `total_time` per `breeze_partner_export_%` function) before/after inside the measured transaction. Inlined `LANGUAGE sql` functions (`breeze_has_org_access`, `next_timestamp`) do not appear there; their cost shows up in the nested plans only.
  - Trigger invocations: wrap the measured statement with a temporary `AFTER … FOR EACH STATEMENT` counter trigger on `device_hardware` (created and dropped inside the rolled-back transaction) so FK-cascade cases record how many statement-trigger firings actually happened, rather than assuming one per parent row.
  - Rows touched: `pg_stat_xact_user_tables` (`seq_tup_read`, `idx_tup_fetch`) for `device_hardware`, `devices`, `organizations`, `partner_export_device_material_state`.
  - Nested plans: `auto_explain.log_min_duration = 0`, `log_nested_statements = on`, `log_analyze = on`, `log_buffers = on`, `log_timing = off` (first pass; on for the second), `log_triggers = on`, `log_level = notice`; capture with the postgres.js `onnotice` hook. Run each case once with `plan_cache_mode = force_custom_plan` and once with `force_generic_plan` (plpgsql caches trigger-body plans per session).
  - Record per run: function owner's `rolsuper`/`rolbypassrls`, `breeze.scope`, accessible-org-list length, `pg_class.reltuples` of `device_hardware`.
  - Each measurement in its own transaction, rolled back.
  - Matrix (`OEM_TRIGGER_COST_MATRIX=1` only):
    - `device_hardware insert`: `batch ∈ {1, 10, 100, 500, 2000, 10000}` × `role` × `stats` at `preexisting = 10000`; and `batch = 500` × `preexisting ∈ {0, 10000, 50000}` rows belonging to **other** tenants (cost must not grow with unrelated data).
    - `upsert-one`: 1,000 sequential one-row `INSERT … ON CONFLICT DO UPDATE` (the production shape), half conflicting, half new; once with a material column changed (`serial_number`), once non-material (`updated_at` only).
    - `delete`: 500 rows (the hardware delete trigger's nested `devices` stamp).
    - `merge-repoint`: an org with 2,000 devices, via the real `orgMergeExecutors` repoint statement in system scope.
    - `org-move`: 500 devices via `UPDATE devices SET org_id` (ON UPDATE CASCADE into `device_hardware`).
    - Control: `software_inventory insert` 300 rows × 20 devices (only the generic material trigger).
- Always-on guards (no timing, deterministic; these are the regression tests T3 turns green):
  - `it('a 500-row device_hardware insert under breeze_app reads O(batch) heap tuples of device_hardware, not O(table)')`: preexisting 5,000 rows, analyzed; assert `seq_tup_read + idx_tup_fetch` on `device_hardware` `<= 4 × 500`.
  - `it('a merge repoint of 1,000 hardware rows reads O(rows) tuples')`: same bound shape.
  - `it('a 2,000-row statement costs per row within 3× of a 100-row statement')`: compares `seq_tup_read + idx_tup_fetch` per row, not time.

- [ ] **Step 1: Write the harness and the three guards.**
- [ ] **Step 2: Run the guards to record the red** (expected under the hypothesis): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerExportTriggerCost.integration.test.ts` → FAIL on the tuple bounds (if they PASS, the hypothesis is wrong: stop at Step 4's gate).
- [ ] **Step 3: Run the matrix locally:** `cd apps/api && OEM_TRIGGER_COST_MATRIX=1 npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerExportTriggerCost.integration.test.ts` (timeout 30 min). Write `docs/perf/2026-11-partner-export-trigger-cost.md`: one table per op with `perRowUs`, tuples read, and the top three functions by `self_time`; the nested-plan line for the stamping UPDATE at batch 500 and 10,000.
- [ ] **Step 4: Decision gate (record in the doc).**
  - **Gate A (expected):** the nested stamping UPDATE's plan scans `device_hardware` (Seq Scan / Hash Join on the full table) and dominates `self_time` → T2 as written.
  - **Gate B:** the dominant cost is the generic `device_child_*` (`to_jsonb` diff, owner-check `EXISTS`) → T2 changes those functions instead, same test bar; a material deviation from T2 as written goes back to the owner before code.
  - **Gate C:** cost is per-statement constant (lock helper, `current_setting` parsing) and linear → no trigger change; close #11259 with the doc and keep the guards. The owner decides.
- [ ] **Step 5: Commit** `test(api): measure partner-export trigger cost on device_hardware writes (#11259)`

### W02 Task 2: Stamp by key, not by join (Gate A)

**Files:**
- Create: `apps/api/migrations/2027-01-22-210300-partner-export-hardware-stamp-by-key.sql`

**Interfaces:**
- `CREATE OR REPLACE FUNCTION public.breeze_partner_export_hardware_insert()` and `…_hardware_update()`: bodies replayed verbatim from `2026-07-18-partner-export-org-locks.sql` except the nested stamp, which becomes key-driven over a de-duplicated array:
  ```sql
  SELECT array_agg(DISTINCT device_id ORDER BY device_id) INTO changed_ids FROM new_rows;   -- update: only changed rows, as today
  UPDATE public.device_hardware AS target
     SET partner_export_updated_at = public.breeze_partner_export_next_timestamp(<as today>)
   WHERE target.device_id = ANY(changed_ids);
  ```
  so the planner uses `device_hardware_pkey`/unique `(device_id)` index for any batch and the RLS predicate runs only on matched rows. Keep `SECURITY INVOKER`, keep `SET search_path = pg_catalog, public`, keep the lock before the stamp. No change to trigger definitions (functions only), so no `DROP/CREATE TRIGGER`.
  - In `_update`, the existing `IS DISTINCT FROM` filter on `(org_id, serial_number, manufacturer, model)` still selects which rows to stamp; carry the selected rows' previous `partner_export_updated_at` via `unnest(ids, prev_ts)` joined back by key if `next_timestamp(old_row.partner_export_updated_at)` is used today (read the current body — preserve monotonicity per row).
- Function DDL only, writes no rows → no `set_config('breeze.scope', …)` needed. Header comment: why (link #11259, the measured numbers), invariants kept (lock-then-stamp ordering, OLD+NEW orgs locked on moves, RLS still applies to the stamp as invoker).
- **RLS implications to state in the header:**
  - Reading a transition table (ENR) does not re-apply its source table's RLS: the rewriter adds policies only to ordinary relation entries. For an app-role statement the ENR holds what that statement wrote (which passed `WITH CHECK`); for a cascade- or definer-generated statement it can hold rows the original caller could not SELECT. Any real table joined to the ENR still gets its own policies.
  - The nested stamp runs as invoker (`breeze_app` on request paths), so `USING` (and UPDATE `WITH CHECK`) apply to every row the plan visits. The rewrite cuts the visited rows from the table to the batch; it does not remove the policy check, and must not.
  - The `SECURITY DEFINER` helpers run as the migration owner: superuser + BYPASSRLS locally/CI (`breeze_test`), non-superuser **with BYPASSRLS** on hosted prod (`doadmin`), and possibly a non-bypassing owner on self-hosted installs, where `FORCE` binds it. `lock_orgs_exclusive` called from inside that chain runs as the definer too.
  - Consequence for tests: the guards run the measured statements under `SET ROLE breeze_app` with request GUCs, never as the owner, and T1 records `rolsuper`/`rolbypassrls` of the function owner next to every number.

- [ ] **Step 1:** Guards from T1 are the failing tests (already red).
- [ ] **Step 2: Write the migration**, `pnpm db:migrate`, `pnpm db:check-drift`.
- [ ] **Step 3: Run the guards** → PASS. `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerExportTriggerCost.integration.test.ts`
- [ ] **Step 4: Commit** `perf(db): stamp device_hardware export watermark by key, not by join (#11259)`

### W02 Task 3: Prove the invariants still hold, and record before/after

**Files:**
- Modify: `apps/api/src/__tests__/integration/partnerExportTriggerCost.integration.test.ts`, `docs/perf/2026-11-partner-export-trigger-cost.md`

- [ ] **Step 1: Add the invariant cases** (red-first where they test new behaviour; the rest are regression pins): `it('a multi-org hardware insert still locks every org in ascending order')`, `it('the watermark of an inserted row is drawn after the org lock (later than a concurrent reader\'s snapshot)')` — two connections, reader holds `breeze_partner_export_lock_orgs_shared_snapshot`, writer blocks then stamps `>` reader's `snapshot_at`; `it('an update that changes only excluded columns stamps nothing and takes no exclusive lock')`; `it('org merge repoint advances the watermark of every moved hardware row and locks both orgs')`; `it('device org move via ON UPDATE CASCADE advances the hardware watermark')`; `it('an update touching serial_number advances the watermark exactly once per row')`.
- [ ] **Step 2: Run the existing export suites** that pin this machinery: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerApiExportWatermark.integration.test.ts src/__tests__/integration/partnerExportTriggerCost.integration.test.ts` plus every file `ls apps/api/src/__tests__/integration | grep -i -e partnerExport -e partnerApi -e orgMerge -e moveOrg` returns → PASS.
- [ ] **Step 3: Re-run the matrix** (`OEM_TRIGGER_COST_MATRIX=1`, as in T1 Step 3) and add the "after" columns to the perf doc.
- [ ] **Step 4: Commit** `test(api): partner-export trigger invariants after the stamp rewrite (#11259)`

### Execution split and parallelism (W02)

- **Seams:** T1's guards are T2's acceptance tests; T2's function names are unchanged (no caller changes anywhere).
- **PARALLEL GROUPS:** strictly sequential — {T1} → gate → {T2} → {T3}. T3 Step 1's invariant cases may be written in parallel with T2 by a second worker (they must pass both before and after T2).
- **Sonnet-eligible:** T1 harness plumbing (stat-view snapshots, notice capture, matrix loop) once the helper signature above is fixed; T3 Step 2–3 runs and the perf doc table. **Opus:** the T1 gate decision, T2's migration, T3's lock-ordering test.
- **CI traps:** these are integration tests → **Integration Tests** job only; `pnpm test` will not run them. The matrix is env-gated and never runs in CI; the three tuple-count guards do. If W02 branches off a non-`main` base, CI does not run: `gh workflow run CI --ref <branch>`.

---

## Open design questions (owner)

1. **W01 storage:** new `device_oem_policy_side` table (recommended, single writer, unambiguous row existence) vs columns on `device_oem_update_status` (no new table registrations, but worker-created status rows would change what "has a status row" means for dispatch/results/release sweep).
2. **W01 staleness bound:** is "≤ one 10-minute tick for device-side changes, ~5 s for policy writes through `configurationPolicy.ts`" acceptable for the fleet view, or should the response carry a `stateAsOf` field so the UI can say so? (Not planned; adding it changes the W09 JSON.)
3. **W02 gate:** if T1 lands on Gate C (linear, no fix warranted), close #11259 with the measurement, or keep it open for the generic `device_child_*` `to_jsonb` cost?
4. **W01 invalidation — recorded disagreement with Codex.** Codex agrees with the split (materialised policy side, `deriveOemDisplayState` in SQL) but calls invalidation its strongest objection: the policy side depends on hardware, memberships, assignments, timezones, enrolment, env gates and the deployed manifest, and `refresh_after` handles only the clock; it asks for dependency versions/invalidation and explicit missing-or-expired behaviour. This plan adopted the explicit pending behaviour (rows for every device, a gates fingerprint so kill switches are authoritative at once, in-request refresh of ≤ 500 pending devices, `pendingRefresh` above that) and the targeted refresh on `configurationPolicy.ts` writes. It **did not** adopt per-dependency versioning (hooks or version columns on device hardware, memberships, site/org/partner timezone and every assignment writer): that is many writers across modules for a view whose tolerance is minutes, and the 10-minute full refresh bounds the lag. Owner's call: accept the ≤ 10-minute residual for device-side changes, or require per-dependency invalidation (adds roughly one task: a `device_oem_policy_side_dirty` mark written by those paths).
5. **W02 one-statement quadratic — open.** Codex notes a per-statement table scan does not by itself explain quadratic growth inside a single 10,000-row statement. T1 must find the second mechanism (repeated scans, join choice, spills, or the nested `device_child_update` diff) before T2 is accepted; if it is not the stamping join, Gate B applies.

## Self-review notes

- Spec coverage: §4.8 fleet view (W01 T5), §4.2/§4.5 state semantics (W01 T2 parity), W09 T1's "one indexed query per page" (W01 T5: two statements, both indexed, counts without shipping the scope to Node).
- Both waves touch disjoint files; either can merge first. Migration slots are adjacent; re-check before enqueue.
