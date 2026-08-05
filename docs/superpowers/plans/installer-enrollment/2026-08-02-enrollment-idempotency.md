# Enrollment Idempotency (#2764) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent enrollment idempotent — a valid enrollment key always enrolls (fresh device row), hostname collisions become detection + one-click cleanup instead of a 409/MSI-rollback, uninstall stamps a reaper-driven intent, and a failed enroll refunds its bootstrap slot safely.

**Architecture:** Server-first behavior change in `routes/agents/enrollment.ts` (guard → detection), plus two new agent-path endpoints in `routes/installer.ts` / `routes/agents/` (bootstrap cancel, uninstall intent), a reaper extension in `jobs/offlineDetector.ts`, and agent-side (Go + WiX) classification/cancel/intent calls. Spec: `docs/superpowers/specs/installer-enrollment/2026-08-02-enrollment-idempotency-design.md` — read it first; its threat-model section explains every "MUST NOT" below.

**Tech Stack:** Hono + Drizzle + Postgres (API), Vitest with Drizzle mocks (unit) and live-DB (integration), Go table-driven tests (agent), WiX (MSI).

## Global Constraints

- **Never write to any existing device row at enrollment time** (spec invariant). The only existing-row writes are: the pre-existing decom-bypass rename, heartbeat clearing `uninstall_intent_at`, the reaper, and human-approved decommission.
- Staleness is NOT authorization: no auto-decommission of colliding rows (spec threat model).
- Hardware identifiers are self-attested — MUST NOT gate any branch.
- Migration: idempotent (`IF NOT EXISTS` / `DO $$`), no inner `BEGIN;`/`COMMIT;`, filename `2026-08-XX-<slug>.sql` chosen to sort AFTER every existing migration (`ls apps/api/migrations | sort | tail -3` first).
- New columns on org-cascade tables MUST be classified in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) — the export-policy suites are live-DB (Integration Tests job), local `pnpm test` will NOT catch omissions.
- Loud-fail contract: agent enroll/bootstrap failures exit non-zero (MSI `Return="check"` rolls back). No soft-exit-0 for rejected credentials.
- Go lint runs `golangci-lint --new-from-rev=origin/main` — only touched files are linted; do not "fix" pre-existing formatting in untouched files.
- Commit after every task. Tests alongside sources (`foo.ts` → `foo.test.ts`).

---

### Task 1: Migration + Drizzle schema + export-policy registration

**Files:**
- Create: `apps/api/migrations/2026-08-XX-enrollment-idempotency.sql` (XX = today's date; verify sort order first)
- Modify: `apps/api/src/db/schema/devices.ts` (devices table columns)
- Modify: `apps/api/src/db/schema/enrollmentKeys.ts` (or wherever `enrollmentKeys` pgTable lives — `grep -rn "export const enrollmentKeys = pgTable" apps/api/src/db/schema/`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:140` (devices entry) and `:153` (enrollment_keys entry)

**Interfaces:**
- Produces: `devices.uninstallIntentAt: timestamp | null`, `devices.possibleReplacementOfDeviceId: uuid | null`, `enrollmentKeys.bootstrapTokenId: uuid | null` — Drizzle column names used verbatim by Tasks 2–5, 7.

- [ ] **Step 1: Check for a uniqueness constraint on hostname**

Run: `grep -rniE "unique.*hostname|hostname.*unique" apps/api/migrations/ apps/api/src/db/schema/devices.ts`

Task 4 makes duplicate `(org_id, site_id, hostname)` ACTIVE rows a supported state. If (and only if) the grep finds a unique index/constraint covering hostname, add `DROP INDEX IF EXISTS <name>;` (or `ALTER TABLE devices DROP CONSTRAINT IF EXISTS <name>;`) to the migration in Step 2 and note it in the PR body. If the grep finds nothing (expected — the guard's `.limit(1)` select implies non-unique), skip this.

- [ ] **Step 2: Write the migration**

```sql
-- Enrollment idempotency (#2764): uninstall intent, replacement suggestion,
-- and bootstrap-slot refund linkage. Spec:
-- docs/superpowers/specs/installer-enrollment/2026-08-02-enrollment-idempotency-design.md
ALTER TABLE devices ADD COLUMN IF NOT EXISTS uninstall_intent_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS possible_replacement_of_device_id uuid;
DO $$ BEGIN
  ALTER TABLE devices
    ADD CONSTRAINT devices_possible_replacement_fk
    FOREIGN KEY (possible_replacement_of_device_id) REFERENCES devices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE enrollment_keys ADD COLUMN IF NOT EXISTS bootstrap_token_id uuid;
DO $$ BEGIN
  ALTER TABLE enrollment_keys
    ADD CONSTRAINT enrollment_keys_bootstrap_token_fk
    FOREIGN KEY (bootstrap_token_id) REFERENCES installer_bootstrap_tokens(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reaper scan path (Task 5): intent-stamped, not-yet-decommissioned rows.
CREATE INDEX IF NOT EXISTS idx_devices_uninstall_intent
  ON devices (uninstall_intent_at) WHERE uninstall_intent_at IS NOT NULL;
```

- [ ] **Step 3: Add the Drizzle columns**

In the `devices` pgTable: `uninstallIntentAt: timestamp('uninstall_intent_at', { withTimezone: true })`, `possibleReplacementOfDeviceId: uuid('possible_replacement_of_device_id')`. In `enrollmentKeys`: `bootstrapTokenId: uuid('bootstrap_token_id')`. Match the file's existing column style exactly.

- [ ] **Step 4: Register export policy**

Add to the `"devices"` entry's `included` array: `"uninstall_intent_at"`, `"possible_replacement_of_device_id"` (timestamp + tenant identifier). Add to `"enrollment_keys"` `included`: `"bootstrap_token_id"`.

- [ ] **Step 5: Verify**

Run: `cd apps/api && pnpm db:migrate && pnpm db:check-drift` (needs local Postgres; `DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze`). Expected: migration applies, no drift. Re-run `pnpm db:migrate` — must be a no-op.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(api): schema for enrollment idempotency — uninstall intent, replacement link, bootstrap refund FK (#2764)"`

---

### Task 2: Stamp `bootstrap_token_id` on redeemed child keys

**Files:**
- Modify: `apps/api/src/routes/installer.ts` (~:187-232, `redeemBootstrapToken` — the child-key INSERT)
- Test: `apps/api/src/routes/installer.test.ts`

**Interfaces:**
- Consumes: `enrollmentKeys.bootstrapTokenId` (Task 1).
- Produces: every child key minted by redeem carries the token id; Task 3's cancel endpoint relies on it.

- [ ] **Step 1: Write the failing test** — in the existing redeem describe block, assert the child-key insert values include `bootstrapTokenId: <token row id>` (the suite already captures `db.insert` values for the child mint; extend that assertion).
- [ ] **Step 2: Run it** — `cd apps/api && pnpm vitest run src/routes/installer.test.ts`. Expected: FAIL (property missing).
- [ ] **Step 3: Implement** — add `bootstrapTokenId: tokenRow.id` to the child-key `values({...})` in `redeemBootstrapToken` (the insert that currently sets `maxUsage: 1`).
- [ ] **Step 4: Re-run** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): link redeemed child keys to their bootstrap token (#2764)"`

---

### Task 3: `POST /installer/bootstrap/cancel` — safe slot refund

**Files:**
- Modify: `apps/api/src/routes/installer.ts` (new route alongside the redeem route; same `withSystemDbAccessContext` pattern)
- Test: `apps/api/src/routes/installer.test.ts`

**Interfaces:**
- Consumes: `enrollmentKeys.bootstrapTokenId` (Task 2).
- Produces: `POST /installer/bootstrap/cancel`, JSON body `{ enrollmentSecret: string }` (the child key's secret, capability auth — same trust level as redeem). Responses: `200 {refunded: true}`, `200 {refunded: false, reason: 'already_used' | 'not_linked'}`, `404` unknown secret. Task 6's agent calls this.

- [ ] **Step 1: Write the failing tests** — four cases in a new describe block:

```ts
// 1. unused linked child → child row deleted AND consumed_count decremented (refunded:true)
// 2. child with usage_count > 0 → NOTHING deleted, no decrement (refunded:false, already_used)
// 3. second cancel of the same child (child row gone) → 404, no decrement — the
//    farming regression: cancel can never yield a usable child + a freed slot
// 4. child with bootstrap_token_id NULL (pre-migration key) → refunded:false, not_linked, no delete
```

Follow the file's existing Drizzle-mock pattern (`vi.mocked(db.delete)` etc.); assert the decrement SQL uses `GREATEST(consumed_count - 1, 0)`.

- [ ] **Step 2: Run** — FAIL (404 route not found).
- [ ] **Step 3: Implement** — inside one transaction: look up the child key by secret hash (mirror how redeem/enroll hash lookups work in this file); verify `usageCount === 0` else `{refunded:false, reason:'already_used'}`; if `bootstrapTokenId` null → `not_linked`; else `DELETE FROM enrollment_keys WHERE id = child.id AND usage_count = 0 RETURNING id` — **the returning-row check is the exactly-once guard** — then `UPDATE installer_bootstrap_tokens SET consumed_count = GREATEST(consumed_count - 1, 0) WHERE id = child.bootstrapTokenId`. If the DELETE returned no row, roll back and return `already_used`. Rate-limit with the same helper the redeem route uses.
- [ ] **Step 4: Run** — PASS. Also re-run the whole file.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): bootstrap cancel endpoint refunds unused slots by revoking the child key (#2764)"`

---

### Task 4: Enrollment guard → collision detection

**Files:**
- Modify: `apps/api/src/routes/agents/enrollment.ts:497-535` (the `else` branch and the `!existingDeviceAuthenticated` 409 block quoted below)
- Modify: `apps/api/src/routes/agents/enrollment.test.ts` (the ~:485 "hardware match still 409s" test and siblings)

**Interfaces:**
- Consumes: `devices.possibleReplacementOfDeviceId` (Task 1); `createAlert` from `services/alertService.ts:61` (`{ruleId, deviceId, orgId, severity, title, message, context}`); `writeAuditEvent` from `services/auditEvents.ts:108`.
- Produces: collision enrollments return 201 with a fresh device id; the new row carries `possibleReplacementOfDeviceId`; audit action `agent.enroll` with `details.reason: 'hostname_collision_enrolled_fresh_row'`.

**Current code being changed** (verbatim, `enrollment.ts:497-535`): the `} else {` branch sets `existingDeviceAuthenticated` from the provided device token, and `if (!existingDeviceAuthenticated)` writes a denied audit and returns the 409 with reason `hostname_collision_requires_existing_device_token` or `existing_decommissioned_row_has_suspended_token`.

**Behavior matrix after this task (pin each row with a test):**

| Existing row state | Token provided & valid | Result |
|---|---|---|
| quarantined | any | 403 `device_quarantined` — **unchanged** (`:425-448`) |
| decommissioned, token suspended | — | 409 `existing_decommissioned_row_has_suspended_token` — **unchanged** (deliberate ops alarm) |
| decommissioned, not suspended | — | decom-bypass fresh row — **unchanged** (`:465-496`) |
| active/offline, valid token | yes | in-place re-enroll, same row — **unchanged** |
| active/offline, no/invalid token | no | **NEW: 201, fresh row**, `possibleReplacementOfDeviceId = existing.id`, audit linkage; alert if existing row online |
| active/offline + token suspended, no token | no | **NEW: same as above** — suspension keeps binding the OLD row's credential; it does not block new enrollment |

- [ ] **Step 1: Rewrite the failing tests first.** Change the ~:485 hardware-match test and every `hostname_collision_requires_existing_device_token`-expecting test (grep the string in the test file) to expect 201 + fresh id. Add: (a) old row is not written (assert no `db.update` targeting the existing id outside the known re-enroll path); (b) insert values carry `possibleReplacementOfDeviceId`; (c) audit `details.reason === 'hostname_collision_enrolled_fresh_row'` with `collidingDeviceIds`; (d) `createAlert` called only when `existingDevice.status === 'online'`; (e) the two **unchanged** 403/409 rows above still pass verbatim.
- [ ] **Step 2: Run** — the rewritten tests FAIL against current code.
- [ ] **Step 3: Implement.** In the `!existingDeviceAuthenticated` block: keep the `isSuspendedDecom` refusal exactly as-is; replace the general 409 with: set a local `collisionDeviceId = existingDevice.id`; do NOT return; let the normal fresh-INSERT path run (the same INSERT the no-existing-device path uses — verify the function's later flow inserts rather than updates when `decomBypassFreshRow` handling is bypassed; wire a new `collisionFreshRow = true` flag through the same INSERT branch `decomBypassFreshRow` uses, **without** the hostname-rename step — colliding rows now coexist). Change the collision lookup (`:387-404`) from `.limit(1)` to fetching all matches so `collidingDeviceIds` is complete; use the first ONLINE one (else the first) as `possibleReplacementOfDeviceId`. Write the success audit with the linkage details. For the alert, mirror the rule-resolution wiring at `jobs/offlineDetector.ts:429` (resolve the org's rule for a new built-in "device identity collision" template; if the org has no rule, skip — `createAlert` is best-effort here); seed the template wherever the offline template is seeded (`grep -rn "offline" apps/api/migrations/*alert*` to locate).
- [ ] **Step 4: Run the whole test file** — PASS, including the pinned unchanged rows.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): hostname collision enrolls a fresh device row with detection instead of 409 (#2764)"`

---

### Task 5: Uninstall intent — endpoint, heartbeat clear, reaper

**Files:**
- Modify: `apps/api/src/routes/agents/` — add `POST /agents/uninstall-intent` next to the other agent-authenticated routes (find the router that mounts heartbeat; use the same `agentAuth` middleware)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` — clear the intent in the existing heartbeat UPDATE
- Modify: `apps/api/src/jobs/offlineDetector.ts` — reaper pass
- Tests: co-located test files for each

**Interfaces:**
- Consumes: `devices.uninstallIntentAt` (Task 1).
- Produces: `POST /agents/uninstall-intent` (device-token auth, empty body, 200 `{acknowledged: true}`); env `UNINSTALL_INTENT_DECOMMISSION_HOURS` (default 24). Task 6's agent + WiX call the endpoint.

- [ ] **Step 1: Failing tests** — (a) endpoint sets `uninstallIntentAt` on the authenticated device only; (b) heartbeat UPDATE includes `uninstallIntentAt: null` when the row has an intent (cheapest correct form: clear unconditionally in the UPDATE's set clause); (c) reaper decommissions rows where `uninstall_intent_at < now() - interval && (last_seen_at IS NULL OR last_seen_at < uninstall_intent_at)` and never touches rows with a post-intent heartbeat; (d) reaper writes an audit event per decommission (`reason: 'uninstall_intent_reaped'`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — endpoint is a 5-line UPDATE on `c.get('device').id`; heartbeat adds the null to its existing `.set({...})`; reaper mirrors the offlineDetector's existing batch-scan style, using the Task 1 partial index, decommission = the same status/`decommissionedAt` writes the admin decommission route performs (grep `status: 'decommissioned'` in `routes/devices/` and copy the field set exactly).
- [ ] **Step 4: Run all three files** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): uninstall intent stamp, heartbeat clear, and reaper decommission (#2764)"`

---

### Task 6: Agent — 4xx classification, cancel-on-failure, uninstall notify

**Files:**
- Modify: `agent/internal/agentapp/enroll_error.go:115-148` (`classifyEnrollError`)
- Modify: `agent/internal/agentapp/bootstrap.go` (~:139-154, redeem→enroll flow)
- Modify: `agent/pkg/api/client.go` (cancel + uninstall-intent client calls)
- Modify: `agent/internal/agentapp/main.go` (new `uninstall-notify` subcommand)
- Modify: `agent/installer/breeze.wxs` (uninstall CA)
- Tests: `enroll_error_test.go`, `bootstrap_test.go` (table-driven)

**Interfaces:**
- Consumes: `POST /installer/bootstrap/cancel` `{enrollmentSecret}` (Task 3); `POST /agents/uninstall-intent` (Task 5).
- Produces: distinct exit codes for identity-conflict enroll failures; MSI uninstall best-effort intent call.

- [ ] **Step 1: Failing Go tests** — extend the existing `classifyEnrollError` table: server-body `reason` values `hostname_collision_requires_existing_device_token` (old servers still emit it), `existing_decommissioned_row_has_suspended_token`, `device_quarantined` map to a new `catIdentityConflict` with a dedicated exit code (`grep -n "exitCode\|cat[A-Z]" agent/internal/agentapp/enroll_error.go` first and take the next unused code; do not renumber existing ones) and a message naming the conflict + the decommission-first remedy. Bootstrap test: on enroll failure with a 4xx category, `cancelBootstrap` is called with the child secret; on network-error category it is NOT called.
- [ ] **Step 2: Run** — `cd agent && go test -race ./internal/agentapp/...` — FAIL.
- [ ] **Step 3: Implement** — classification cases; `cancelBootstrap` in client.go (POST, 5s timeout, errors logged not fatal); call it in bootstrap.go's enroll-failure path before `osExit`; `uninstall-notify` subcommand reads `secrets.yaml`, calls uninstall-intent with 5s timeout, **always exits 0**. WiX: add a deferred CA running `breeze-agent.exe uninstall-notify` sequenced on `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`, scheduled BEFORE `RemoveFiles` (secrets.yaml must still exist), `Return="ignore"` — never blocks uninstall. Mirror the property/quoting style of the existing CAs at `breeze.wxs:464-502`.
- [ ] **Step 4: Run** — `go test -race ./...` in `agent/` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): classify identity-conflict enroll errors, refund bootstrap slot, uninstall intent (#2764)"`

---

### Task 7: Web — replacement review surface

**Files:**
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (banner) and the devices list row component it links from
- Test: co-located `.test.tsx`
- Locales: add every new string key to ALL locale files under `apps/web/src/locales/*/` (key-parity gate reds main otherwise)

**Interfaces:**
- Consumes: `possibleReplacementOfDeviceId` on the device API response (verify the devices GET route serializer includes new columns; if it whitelists fields, add it) and the existing decommission action/endpoint already used by the device UI.

- [ ] **Step 1: Failing test** — banner renders when `possibleReplacementOfDeviceId` set: "This device may replace <old hostname> — review and decommission the old row." with a link to the old device and a "Decommission old device" action wired through `runAction` (repo rule: all mutations via `runAction`); nothing renders when null.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — follow the existing banner/badge patterns in `DeviceDetails.tsx`; the action calls the same decommission handler the device page already exposes, then re-fetches.
- [ ] **Step 4: Run** — component tests + `pnpm --filter @breeze/web test` for the parity gate — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): review-possible-replacement banner for collision enrollments (#2764)"`

---

### Task 8: Contract sweeps + integration + PR

- [ ] **Step 1:** Add an integration test `apps/api/src/routes/agents/enrollmentCollision.integration.test.ts` against real Postgres: enroll → uninstall-intent → reap → re-enroll lands fresh row; collision enroll leaves old row byte-identical (`SELECT *` before/after compare); cancel refunds exactly once under two concurrent cancels (`Promise.all`).
- [ ] **Step 2:** Run the live-DB suites locally (they do NOT run under `pnpm test`): `pnpm vitest run -c vitest.integration.config.ts` and the export-policy suites (`tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`). Expected: green; the export suites fail here if Task 1 Step 4 was skipped.
- [ ] **Step 3:** `pnpm db:check-drift`, `cd agent && go test -race ./...`, targeted API/web suites — all green.
- [ ] **Step 4:** Release-notes note (behavior change: collisions no longer block enrollment; alert + review banner instead; no config flag — spec records why) goes in the PR body for the release process to pick up.
- [ ] **Step 5:** Push branch, open PR with `Closes #2764`, run one review round. If the branch is ever stacked on a non-main base: `ci.yml` won't trigger — `gh workflow run CI --ref <branch>`.

## Self-review notes

- Spec §1–§5 → Tasks 4, 4(alert)/7, 5, 2+3, 6 respectively; data checklist → Task 1; testing section → per-task steps + Task 8. Rollout/release-notes → Task 8 Step 4. No spec section uncovered.
- Open item carried from spec (Todd's call, does not block Tasks 1–3/5–7): none — the no-config-flag decision is recorded in the spec; if it is reversed, the flag lands in Task 4 as an env gate around the new branch.
- Deliberate deviation from "no discovery steps": Tasks 1/4/6 contain verify-then-act steps (hostname unique index, alert-template seed location, exit-code allocation) because the answers could not be pinned at plan time without stale risk; each names the exact command and both outcomes.
