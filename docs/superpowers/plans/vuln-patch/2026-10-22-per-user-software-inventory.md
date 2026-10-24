# Per-user Windows Software Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows programs installed "for this user only" reach device inventory and vulnerability matching, attributed to their owner, without ever being erased or resolved on incomplete evidence.

**Architecture:** The server ships first (Phase 1): an optional, capability-gated extension of the strict v2 observation schema; `scope`/`owner_*` columns on `software_inventory`; scoped replacement with per-scope evidence and baselines; a WS-handshake capability with an env kill switch; scope-aware, generation-consistent correlation with a deterministic finding link; and a sweep of every `software_inventory` reader. The agent ships second (Phase 2): a platform-neutral profile-collection engine fed by a thin Windows registry adapter that reads only already-loaded `HKEY_USERS\<SID>` hives, under budgets, and sends per-user data only to servers that advertise support. Phase 3 is the Windows lab gate before promotion.

**Tech Stack:** Hono + Zod + Drizzle (queries only) + hand-written SQL migrations, Vitest (unit + `vitest.integration.config.ts`), React islands, Go agent (`golang.org/x/sys/windows/registry`).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-10-22-per-user-software-inventory-design.md` (parent: `docs/superpowers/specs/vuln-patch/2026-10-21-vuln-catalog-coverage-design.md`).

**Rigor:** high. Agent code ships to customer machines, a migration touches a hot org-cascade table, and correlation concurrency is involved. One independent review round per phase PR.

**Dependency on the parent plan (catalog coverage).** Task 7 consumes the parent plan's per-org summary event (parent spec §6.4: "one summary event per organization instead of per-finding `vulnerability.critical_detected`"). This plan does **not** implement that mechanism. If the parent's summary-event task has not merged when Phase 1 is ready, ship Tasks 1–6 and 8–10 as the Phase 1 PR and Task 7 as a follow-up PR; **the Phase 2 agent PR must not merge before Task 7 does.** Nothing here needs the parent's `withdrawn` status: a deleted profile's findings resolve as `patched` because the software really is gone.

## Global Constraints

- No `RegLoadKey` / `NTUSER.DAT` loading anywhere. Only hives already present under `HKEY_USERS` are read. `_Classes` hives and `.DEFAULT` are skipped; service SIDs `S-1-5-18`, `S-1-5-19`, `S-1-5-20` are skipped.
- No network or directory lookup on the collection path. The owner display name is the last path element of `ProfileImagePath` in `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`.
- Scope vocabulary is exactly `'machine' | 'user'` (matches `device_patches.scope`). Machine rows carry no owner.
- **A report without profile data means "user coverage unknown", never "zero profiles".** Every existing per-user row and finding is kept unchanged in that case.
- Incomplete evidence never erases last-known-good inventory or resolves a finding, judged per scope (fleet-integrity rule, RMM-QA-297).
- A user scope never resolves, hides or relinks a finding on a machine-wide copy.
- Capability name: `software_inventory_per_user_v1`. Kill switch: `BREEZE_SOFTWARE_PER_USER_INVENTORY_DISABLED=true` stops advertising it **and** makes ingest ignore per-user fields.
- Without the capability the agent sends today's payload byte-for-byte in shape: no `scope`, `ownerSid`, `ownerName`, `profiles`, `profileListComplete` keys.
- Report body stays under the route's 5 MB `bodyLimit`; total items stay ≤ 5,000 (`collectorResultLimit`). Machine items are collected first and never dropped for user items; user-budget exhaustion never sets `truncated`.
- The agent's change tracker, uninstall verifier and `collect_software` command stay machine-only. Uninstall stays HKLM-only (`software_uninstall_registry.go` boundary unchanged).
- Owner names, program names, vendors, versions from user hives are untrusted strings: escaped for UI, CSV, PSA payloads and AI tool output.
- Migrations (`apps/api/migrations/README.md`): name sorts after the newest committed migration (newest at writing: `2027-01-02-160000-device-patch-reported-severity-source.sql` — re-check with `ls apps/api/migrations | sort | tail -5`); idempotent; no `BEGIN`/`COMMIT`; any row write elects `SELECT set_config('breeze.scope', 'system', true);` first; then `pnpm db:check-drift`.
- `software_inventory`, `device_software_inventory_state`, `software_inventory_observations` are org-cascade tables: every new column gets a `CORE_TENANT_EXPORT_POLICY` classification; every `jsonb` column is `excludedOpen`. Owner columns are `included` (same as `install_location`).
- `software_inventory_observations` is append-only (UPDATE revoked from `breeze_app`): everything stored on it is computed before the INSERT.
- Lock order is unchanged: ingest takes `device_software_inventory_state FOR UPDATE` → `device_vulnerabilities FOR UPDATE ORDER BY id` → inventory writes; correlation takes findings (ordered pre-lock) before any inventory FK lock and never locks the state row inside its findings transaction.
- New `apps/api/src/services/*` file → run `apps/api/src/__tests__/parkedFanout.contract.test.ts` and classify it if discovered. New en locale keys → all 8 locale dirs (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`; `localeParity.test.ts`). Web mutations go through `runAction`. Playwright/test selectors use `data-testid`.
- New env var → `INTERNAL_ENV_VARS` in `apps/api/src/system/connections/internalEnvVars.ts` (not operator-documented, so no compose mapping).
- Scoped test runs: `cd apps/api && npx vitest run <file>` (never `pnpm --filter … test -- --run`). Integration: `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>` against `pnpm test-stack up` (tear down after). Go: `cd agent && go test -race ./internal/<pkg>/ -run <Name>`.

## Review Focus

1. **Machine inventory already at the 5,000-item cap.** Expect zero user items, every loaded profile `skipped_budget`, report still `complete`, machine delivery unchanged. Test: Task 12 `TestCollectUserProfilesNoHeadroomSkipsAll`.
2. **Kill switch flipped while agents stay connected** (they keep the latched capability until reconnect). Expect ingest to ignore per-user fields and retain stored user rows. Test: Task 4 `kill switch strips per-user fields and retains user rows`.
3. **Rolling API deploy**: the agent latched the capability from a new instance, the PUT lands on an old instance that 400s the new fields. Expect one legacy resend with a fresh observation id, not a lost cycle. Test: Task 14 `TestSendSoftwareInventoryFallsBackToLegacyOn400`.
4. **Hostile strings in owner/program names** (bidi override, HTML, CSV formula prefix, control chars). Expect inert text in the device tab, neutralised CSV cells, sanitised AI tool values. Tests: Task 10 web + CSV assertions.
5. **One program installed machine-wide and for two users.** Expect three rows on the device tab, one in the partner API count, per-copy policy evaluation, a machine-preferred finding link, and uninstall that only ever targets the machine copy. Tests: Tasks 6, 9, 10.

---

## File Structure

**Phase 1 (server)**
- `packages/shared/src/types/softwareInventoryObservation.ts` — wire schema: item scope/owner, `profiles`, `profileListComplete`, cross-field rules.
- `apps/api/migrations/2027-01-02-170000-software-inventory-per-user-scope.sql`, `…-170100-software-inventory-per-user-scope-validate.sql` — columns + NOT VALID checks, then VALIDATE.
- `apps/api/src/db/schema/software.ts` — Drizzle mirror.
- `apps/api/src/services/tenantExportPolicyRegistry.ts` — column classifications.
- `apps/api/src/services/softwareInventoryScopes.ts` (new) — pure: machine guard inputs, per-profile decisions, replacement plan.
- `apps/api/src/services/softwareInventoryObservations.ts` — ingest wiring, scoped delete/insert, same-scope relink, state + observation columns.
- `apps/api/src/services/softwarePerUserCapability.ts` (new) — capability name + kill-switch reader.
- `apps/api/src/routes/agentWs.ts` — conditional advertisement.
- `apps/api/src/services/vulnerabilityCorrelation.ts` — preferred copy, generation token, validated retry, first-sighting split.
- `apps/api/src/services/vulnerabilityAffectedCopies.ts` (new) — read-time copies for findings.
- Consumers: `softwarePolicyService.ts`, `jobs/softwareComplianceWorker.ts`, `jobs/softwareRemediationWorker.ts`, `db/schema/softwarePolicies.ts`, `softwareCurrency.ts`, `vulnerabilityRemediation.ts`, `routes/partnerApi/inventory.ts`, `routes/devices/software.ts`, `routes/devices/softwareActions.ts`, `routes/vulnerabilities.ts`, `packages/shared/src/types/vulnerability.ts`, web `DeviceSoftwareInventory.tsx`, `DeviceVulnerabilitiesTab.tsx`, locales.

**Phase 2 (agent)**
- `agent/internal/collectors/software.go` — item/observation fields, dedupe key, options API, machine-only `Collect()`.
- `agent/internal/collectors/software_profiles.go` (new, all platforms) — profile engine: states, budgets, owner names.
- `agent/internal/collectors/software_profiles_windows.go` (new) — registry adapter.
- `agent/internal/collectors/software_windows.go` — retire `hkcu`, wire profiles.
- `software_darwin.go`, `software_linux.go` — signature rename only.
- `agent/internal/heartbeat/heartbeat.go` — capability-gated send, 400 fallback.

---

# Phase 1 — Server (one PR)

### Task 1: Shared observation schema accepts optional per-user fields, strictly

**Files:**
- Modify: `packages/shared/src/types/softwareInventoryObservation.ts`
- Test: `packages/shared/src/types/softwareInventoryObservation.test.ts`

**Interfaces:**
- Produces:
  - `export type SoftwareInventoryScope = 'machine' | 'user'`
  - `export type SoftwareProfileState = 'read' | 'not_loaded' | 'failed' | 'skipped_budget'`
  - `SoftwareInventoryItem` gains `scope?: SoftwareInventoryScope; ownerSid?: string; ownerName?: string`
  - `export interface SoftwareProfileObservation { sid: string; ownerName: string; state: SoftwareProfileState; itemCount: number }`
  - `SoftwareInventoryObservationV2` gains `profileListComplete?: boolean; profiles?: SoftwareProfileObservation[]`
  - `export const softwareProfileObservationSchema` (strict); `export const WINDOWS_SID_PATTERN = /^S-1-\d+(-\d+){1,14}$/`
  - `export function isUserScopeItem(item: SoftwareInventoryItem): boolean` (`item.scope === 'user'`)

- [ ] **Step 1: Write the failing tests** in a new `describe('per-user fields')`:

```ts
it('accepts a legacy-shaped v2 report with no per-user keys', () => {
  expect(softwareInventoryObservationV2Schema.safeParse(baseReport()).success).toBe(true);
});
it('still rejects unknown top-level and item keys (strictness preserved)', () => {
  expect(softwareInventoryObservationV2Schema.safeParse({ ...baseReport(), profilesX: [] }).success).toBe(false);
  expect(softwareInventoryObservationV2Schema.safeParse(withItems([{ name: 'a', owner: 'x' }])).success).toBe(false);
});
it('accepts user items that belong to a read profile with matching count and owner name', () => {
  const r = perUserReport({ profiles: [{ sid: SID_A, ownerName: 'alice', state: 'read', itemCount: 1 }],
    items: [{ name: 'Code', scope: 'user', ownerSid: SID_A, ownerName: 'alice' }] });
  expect(softwareInventoryObservationV2Schema.safeParse(r).success).toBe(true);
});
it.each([
  ['user item without profiles', { profiles: undefined }, 'user items require profiles'],
  ['user item for a not_loaded profile', { state: 'not_loaded' }, 'user items must belong to a read profile'],
  ['read profile itemCount mismatch', { itemCount: 2 }, 'profile itemCount must equal its user items'],
  ['non-read profile with itemCount > 0', { state: 'failed', itemCount: 1, items: [] }, 'only read profiles may carry items'],
  ['duplicate SIDs', { duplicateSid: true }, 'profile SIDs must be unique'],
  ['machine item with ownerSid', { machineOwner: true }, 'machine items carry no owner'],
  ['profiles without profileListComplete', { profileListComplete: undefined }, 'profiles require profileListComplete'],
  ['item ownerName differs from profile', { itemOwnerName: 'mallory' }, 'item ownerName must match its profile'],
  ['malformed SID', { sid: 'S-1-5-21-x' }, 'invalid SID'],
])('rejects %s', (_label, mutation, message) => {
  const result = softwareInventoryObservationV2Schema.safeParse(mutate(mutation));
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).toContain(message);
});
it('caps profiles at 1000 and ownerName at 256', () => { /* 1001 profiles → false; 257-char ownerName → false */ });
it('keeps the 5,000 item and itemCount bound across machine + user items', () => { /* 5001 → false */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/shared test --run src/types/softwareInventoryObservation.test.ts`
Expected: FAIL (unknown keys `scope`/`profiles` rejected; rule messages absent).

- [ ] **Step 3: Implement** in `softwareInventoryObservation.ts`: add the optional keys to the strict item and observation objects (`ownerSid: z.string().max(184).regex(WINDOWS_SID_PATTERN, 'invalid SID')`, `ownerName: z.string().max(256)`, `profiles: z.array(softwareProfileObservationSchema).max(1000)`), and extend the existing `superRefine` with the nine rules above using exactly those issue messages. Leave `completeness`/source rules untouched: profile states never affect `completeness`.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/softwareInventoryObservation.ts packages/shared/src/types/softwareInventoryObservation.test.ts
git commit -m "feat(shared): optional per-user scope fields on software observation v2"
```

### Task 2: Migration, Drizzle schema, export-policy classification

Read `docs/agents/tenancy-rls.md` (export-policy row) and `apps/api/migrations/README.md` before starting.

**Files:**
- Create: `apps/api/migrations/2027-01-02-170000-software-inventory-per-user-scope.sql`
- Create: `apps/api/migrations/2027-01-02-170100-software-inventory-per-user-scope-validate.sql`
- Modify: `apps/api/src/db/schema/software.ts` (`softwareInventory`, `deviceSoftwareInventoryState`, `softwareInventoryObservations`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:422,882,883`
- Test: `apps/api/src/db/migration-software-inventory-per-user-scope.test.ts` (new, static SQL test in the style of `src/db/migration-asset-link-suppression.test.ts`)

**Interfaces:**
- Produces (Drizzle): `softwareInventory.scope` (`varchar(16)`, not null, default `'machine'`), `.ownerSid` (`varchar(184)`), `.ownerName` (`varchar(256)`); `deviceSoftwareInventoryState.machineItemCount` (`integer`, nullable), `.profileBaselines` (`jsonb`, not null, default `{}`); `softwareInventoryObservations.profileListComplete` (`boolean`, nullable), `.profileStates` (`jsonb`, nullable).
- Constraints: `software_inventory_scope_chk` `CHECK (scope IN ('machine','user'))`; `software_inventory_scope_owner_chk` `CHECK ((scope = 'machine' AND owner_sid IS NULL AND owner_name IS NULL) OR (scope = 'user' AND owner_sid IS NOT NULL))`.

- [ ] **Step 1: Write the failing static test**

```ts
it('adds scope/owner columns idempotently with NOT VALID checks and no row writes', () => {
  const sql = read('2027-01-02-170000-software-inventory-per-user-scope.sql');
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS scope varchar\(16\) NOT NULL DEFAULT 'machine'/);
  expect(sql).toMatch(/software_inventory_scope_owner_chk[\s\S]*NOT VALID/);
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS profile_baselines jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
});
it('validates both checks in a separate file', () => {
  const sql = read('2027-01-02-170100-software-inventory-per-user-scope-validate.sql');
  expect(sql).toMatch(/VALIDATE CONSTRAINT software_inventory_scope_chk/);
  expect(sql).toMatch(/VALIDATE CONSTRAINT software_inventory_scope_owner_chk/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/db/migration-software-inventory-per-user-scope.test.ts`
Expected: FAIL (files missing).

- [ ] **Step 3: Write the migrations and Drizzle columns.** Constraints are added `NOT VALID` (guarded by `DROP CONSTRAINT IF EXISTS` then re-add) so the hot table is not scanned under `ACCESS EXCLUSIVE`; the second file validates under `SHARE UPDATE EXCLUSIVE` in its own transaction. `ADD COLUMN … DEFAULT 'machine'` is metadata-only and fires no partner-export trigger; existing rows read as machine scope. No index: every query on the new columns is already narrowed by `software_inventory_device_id_idx`.

- [ ] **Step 4: Classify the new columns** in `CORE_TENANT_EXPORT_POLICY`:
  - `software_inventory`: `scope`, `owner_sid`, `owner_name` → `included`.
  - `device_software_inventory_state`: `machine_item_count` → `included`; `profile_baselines` → `excludedOpen`.
  - `software_inventory_observations`: `profile_list_complete` → `included`; `profile_states` → `excludedOpen`.
  Confirm no other list needs a change (these are column additions to registered tables): `grep -n "software_inventory\|device_software_inventory_state" apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/routes/devices/core.ts` shows all three already present.

- [ ] **Step 5: Verify**

Run: `cd apps/api && npx vitest run src/db/migration-software-inventory-per-user-scope.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` → PASS.
Run (test stack up): `pnpm db:migrate && pnpm db:check-drift` → no drift.
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2027-01-02-17*.sql apps/api/src/db/schema/software.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/db/migration-software-inventory-per-user-scope.test.ts
git commit -m "feat(api): scope and owner columns for per-user software inventory"
```

### Task 3: Per-scope acceptance and replacement planning (pure)

**Files:**
- Create: `apps/api/src/services/softwareInventoryScopes.ts`
- Modify: `apps/api/src/services/softwareInventoryObservations.ts` (`decideSoftwareInventoryAcceptance`, `DecisionState`)
- Test: `apps/api/src/services/softwareInventoryScopes.test.ts`; update `apps/api/src/services/softwareInventoryObservations.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces (`softwareInventoryScopes.ts`):
  - `export const RETIRED_MACHINE_SOURCES = ['windows:registry:hkcu'] as const`
  - `export function machineSourceSet(sources: readonly string[]): string[]` — sorted, retired sources removed.
  - `export function machineItemCount(items: readonly SoftwareInventoryItem[]): number` — items where `!isUserScopeItem`.
  - `export type ProfileBaseline = { itemCount: number; firstReadAt: string; lastReadObservationId: string; firstCorrelatedAt: string | null }`
  - `export type ProfileDecision = 'replaced' | 'retained_not_loaded' | 'retained_failed' | 'retained_skipped_budget' | 'retained_collapse' | 'retained_unknown_coverage' | 'removed_profile_deleted'`
  - `export type ScopedReplacementPlan = { replaceMachine: true; replaceProfileSids: string[]; deleteProfileSids: string[]; profileDecisions: Array<{ sid: string; ownerName: string | null; state: SoftwareProfileState | 'absent' | 'unknown'; itemCount: number; decision: ProfileDecision }>; nextProfileBaselines: Record<string, ProfileBaseline>; nextMachineItemCount: number }`
  - `export function planScopedReplacement(input: { report: SoftwareInventoryObservationV2 | LegacySoftwareInventoryReport; storedProfileSids: readonly string[]; baselines: Readonly<Record<string, ProfileBaseline>>; observationId: string; receivedAt: Date; perUserEnabled: boolean }): ScopedReplacementPlan` — called only after the machine scope was accepted.
- Changes: `DecisionState` gains `machineItemCount: number | null`. The collapse guard compares `machineItemCount(report.items)` against `state.machineItemCount ?? state.visibleItemCount`, and source equality uses `machineSourceSet` on both sides.

- [ ] **Step 1: Write the failing tests**

```ts
describe('decideSoftwareInventoryAcceptance machine guard', () => {
  it('keeps the collapse guard on when the only source change is hkcu retirement', () => {
    const d = decide({ state: { hasAcceptedV2: true, visibleItemCount: 200, machineItemCount: null,
      latestAcceptedExpectedSources: ['windows:registry:hkcu', 'windows:registry:hklm32', 'windows:registry:hklm64'] },
      report: v2({ expectedSources: ['windows:registry:hklm32', 'windows:registry:hklm64'], machineItems: 5 }) });
    expect(d.reasonCode).toBe('rejected_count_collapse');
  });
  it('keeps the guard on for an agent rollback that re-adds hkcu', () => { /* reverse direction → rejected_count_collapse */ });
  it('judges collapse on machine items only, so user items cannot prop up a collapsed machine scope', () => {
    // baseline machine 200; report has 5 machine + 400 user items → rejected_count_collapse
  });
  it('profile churn never resets machine protection', () => {
    // machineItemCount 200 stored; visibleItemCount 900 (user rows) → baseline used is 200
  });
});
describe('planScopedReplacement', () => {
  it('replaces read profiles and retains not_loaded / failed / skipped_budget ones', () => {
    expect(plan.replaceProfileSids).toEqual([SID_A]);
    expect(decisionFor(SID_B)).toBe('retained_not_loaded');
    expect(decisionFor(SID_C)).toBe('retained_failed');
    expect(decisionFor(SID_D)).toBe('retained_skipped_budget');
    expect(plan.nextProfileBaselines[SID_C]).toEqual(baselines[SID_C]); // untouched
  });
  it('treats a report without profiles as unknown coverage: nothing replaced or deleted', () => {
    expect(plan.replaceProfileSids).toEqual([]); expect(plan.deleteProfileSids).toEqual([]);
    expect(plan.profileDecisions.every((p) => p.decision === 'retained_unknown_coverage')).toBe(true);
  });
  it('deletes a stored SID only when profileListComplete is true and the SID is absent', () => {
    expect(planFor({ profileListComplete: true, profiles: [] }).deleteProfileSids).toEqual([SID_A]);
    expect(planFor({ profileListComplete: false, profiles: [] }).deleteProfileSids).toEqual([]);
  });
  it('retains a read profile whose count collapses below 10% of a >=50 baseline', () => {
    // baseline 80, read itemCount 7 → retained_collapse, baseline unchanged; itemCount 8 → replaced
  });
  it('preserves firstReadAt and firstCorrelatedAt across replacements and seeds them on first read', () => {
    expect(plan.nextProfileBaselines[SID_NEW]).toEqual({ itemCount: 3, firstReadAt: RECEIVED.toISOString(), lastReadObservationId: OBS, firstCorrelatedAt: null });
  });
  it('ignores all per-user fields when perUserEnabled is false (kill switch)', () => { /* same as unknown coverage; nextMachineItemCount counts machine items only */ });
  it('treats a legacy report as machine-only with unknown user coverage', () => { /* decisions all retained_unknown_coverage */ });
});
```

Update the existing `'bypasses only collapse when the normalized source set changes'` case so its changed source is a machine source (e.g. adding `windows:registry:hklm32`), not `hkcu`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/softwareInventoryScopes.test.ts src/services/softwareInventoryObservations.test.ts`
Expected: FAIL (module missing; hkcu case returns `accepted_complete`).

- [ ] **Step 3: Implement** `softwareInventoryScopes.ts` and the `decideSoftwareInventoryAcceptance` change. Profile collapse uses the machine rule's constants (baseline ≥ 50, new × 10 < baseline). Stored SIDs are the union of `storedProfileSids` and baseline keys.

- [ ] **Step 4: Run to verify it passes** — same command → PASS. Then `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts` → PASS (classify `services/softwareInventoryScopes.ts` if listed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/softwareInventoryScopes.ts apps/api/src/services/softwareInventoryScopes.test.ts apps/api/src/services/softwareInventoryObservations.ts apps/api/src/services/softwareInventoryObservations.test.ts apps/api/src/__tests__/parkedFanout.contract.test.ts
git commit -m "feat(api): per-scope evidence decisions for software inventory"
```

### Task 4: Scoped replacement in ingest

**Files:**
- Modify: `apps/api/src/services/softwareInventoryObservations.ts` (`replaceSoftwareInventoryProjection`, `ingestSoftwareInventoryReportInner`)
- Test: `apps/api/src/__tests__/integration/softwareInventoryPerUserScope.integration.test.ts` (new; picked up by the existing `src/__tests__/integration/**/*.test.ts` include), plus unit updates in `softwareInventoryObservations.test.ts`

**Interfaces:**
- Consumes: `planScopedReplacement`, `machineItemCount` (Task 3); `isPerUserInventoryEnabled()` (Task 5 — implement Task 5's service file first or stub it in this task and let Task 5 own the tests).
- Produces: `replaceSoftwareInventoryProjection(tx, input: { device; items: SoftwareInventoryItem[]; observationId: string; receivedAt: Date; plan: ScopedReplacementPlan }): Promise<void>`. Ingest return shape unchanged. `visible_item_count` becomes the stored row count after replacement (a `count(*)` in the same transaction), not `items.length`.

Behaviour:
1. Read stored SIDs (`SELECT DISTINCT owner_sid … WHERE scope='user'`) and `profile_baselines`, `machine_item_count` inside the existing state `FOR UPDATE` section, before the observation INSERT.
2. When the kill switch is on, call `planScopedReplacement` with `perUserEnabled: false` and insert only machine items.
3. Store `profile_list_complete` and `profile_states` (= `plan.profileDecisions`) on the observation INSERT.
4. `DELETE FROM software_inventory WHERE device_id = $1 AND (scope = 'machine' OR owner_sid = ANY($replace ∪ $delete))`; insert machine items plus user items of `replaceProfileSids` only.
5. Relink stays ordered `FOR UPDATE OF device_vulnerabilities` over all linked findings, but only findings whose old row was deleted are relinked, and only to a new row with the **same scope and owner_sid** and the same normalized (name, vendor). Otherwise severed (`NULL`), left for correlation.
6. Accepted reports write `machine_item_count = plan.nextMachineItemCount` and `profile_baselines = plan.nextProfileBaselines`, and bump `visible_observation_id` (the generation token Task 6 reads).

- [ ] **Step 1: Write the failing integration tests** (seed with `seedFixture()`/`report()` helpers copied from `softwareInventoryObservations.integration.test.ts`):

```ts
runDb('new server + old agent: v2 report with hkcu and no profiles replaces machine rows and keeps user rows', ...)
  // seed user row for SID_A + baseline; ingest old-agent report (sources hklm64+hkcu) → user row id unchanged, lastSeen unchanged
runDb('agent rollback keeps per-user rows and their findings open', ...)
  // per-user report, then old-agent report → user rows + linked open finding unchanged
runDb('logged-off user: not_loaded keeps rows with last_seen unchanged', ...)
runDb('failed profile is retained and does not reject the report', ...)
  // decision.acceptedForInventory === true; SID_B rows unchanged
runDb('deleted profile is removed only with a complete profile list', ...)
  // profileListComplete:false → kept; next report true without SID → rows gone, baseline key gone
runDb('machine collapse still rejects the whole report even when profiles were read', ...)
runDb('first report after hkcu retirement still enforces the machine collapse guard', ...)
runDb('visible_item_count counts retained rows, not report items', ...)
  // 3 machine + 2 retained user → visible_item_count 5 while report itemCount 3
runDb('relink stays within scope: a machine finding is never relinked to a user row', ...)
  // finding linked to machine "Code"; machine report drops it, SID_A has "Code" → finding.softwareInventoryId === null
runDb('kill switch strips per-user fields and retains user rows', ...)
  // BREEZE_SOFTWARE_PER_USER_INVENTORY_DISABLED=true; per-user report → no new user rows, stored SID_A rows intact
runDb('same program machine-wide and for two users stores three rows', ...)
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/softwareInventoryPerUserScope.integration.test.ts`
Expected: FAIL (user rows deleted by the whole-device delete; columns unused).

- [ ] **Step 3: Implement** the six behaviours above in `softwareInventoryObservations.ts`. Keep `tightenLockTimeout` and the retry wrapper as they are.

- [ ] **Step 4: Run to verify it passes**

Run the integration file above plus `src/__tests__/integration/softwareInventoryObservations.integration.test.ts`, `src/routes/agents/inventorySoftwareRelink.integration.test.ts` (listed in both vitest configs) and `cd apps/api && npx vitest run src/services/softwareInventoryObservations.test.ts`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/softwareInventoryObservations.ts apps/api/src/services/softwareInventoryObservations.test.ts apps/api/src/__tests__/integration/softwareInventoryPerUserScope.integration.test.ts
git commit -m "feat(api): scoped software inventory replacement with per-profile retention"
```

### Task 5: Capability advertisement and kill switch

**Files:**
- Create: `apps/api/src/services/softwarePerUserCapability.ts`
- Modify: `apps/api/src/routes/agentWs.ts:149-162,3186`
- Modify: `apps/api/src/system/connections/internalEnvVars.ts`
- Test: `apps/api/src/services/softwarePerUserCapability.test.ts`; `apps/api/src/routes/agentWs.test.ts` (case near line 1523)

**Interfaces:**
- Produces:
  - `export const SOFTWARE_PER_USER_CAPABILITY = 'software_inventory_per_user_v1'`
  - `export function isPerUserInventoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean` — false only when `BREEZE_SOFTWARE_PER_USER_INVENTORY_DISABLED` is `'true'` or `'1'`.
  - `export function agentWsCapabilities(env?: NodeJS.ProcessEnv): string[]` in `agentWs.ts` = `[...AGENT_WS_CAPABILITIES, ...(isPerUserInventoryEnabled(env) ? [SOFTWARE_PER_USER_CAPABILITY] : [])]`; the `connected` message sends this.

Mechanism choice (spec §9 leaves it to the builder): the existing WS `connected` handshake. The agent already resets advertised capabilities on every reconnect (`websocket.Client.resetConnectionCapabilities`), which covers "clear on server URL change or missing advertisement". An HTTP-only agent never latches it and keeps sending the legacy payload, which is safe.

- [ ] **Step 1: Write the failing tests**

```ts
it('advertises the per-user capability by default', () => {
  expect(agentWsCapabilities({})).toContain('software_inventory_per_user_v1');
});
it.each(['true', '1'])('withdraws it when the kill switch is %s', (v) => {
  expect(agentWsCapabilities({ BREEZE_SOFTWARE_PER_USER_INVENTORY_DISABLED: v })).not.toContain('software_inventory_per_user_v1');
});
// agentWs.test.ts: connected payload capabilities toEqual(agentWsCapabilities(process.env))
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/softwarePerUserCapability.test.ts src/routes/agentWs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, and register `BREEZE_SOFTWARE_PER_USER_INVENTORY_DISABLED: 'operator kill switch: stop advertising per-user software inventory and ignore per-user fields at ingest'` in `INTERNAL_ENV_VARS`.

- [ ] **Step 4: Run to verify it passes** — the command above plus `npx vitest run src/system/connections/envInventory.test.ts src/config/envReadComposeCoverage.test.ts src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/softwarePerUserCapability.ts apps/api/src/services/softwarePerUserCapability.test.ts apps/api/src/routes/agentWs.ts apps/api/src/routes/agentWs.test.ts apps/api/src/system/connections/internalEnvVars.ts
git commit -m "feat(api): advertise per-user software inventory capability with kill switch"
```

### Task 6: Scope-aware, generation-consistent correlation with a deterministic link

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts` (`correlateOrg`)
- Test: `apps/api/src/services/vulnerabilityCorrelation.test.ts` (new unit file for the pure helper), `apps/api/src/__tests__/integration/vulnerabilityCorrelationPerUser.integration.test.ts` (new)

**Interfaces:**
- Produces:
  - `export type CandidateCopy = { inventoryId: string; scope: 'machine' | 'user'; ownerSid: string | null }`
  - `export function pickPreferredCopy(copies: readonly CandidateCopy[]): CandidateCopy` — machine first, then `ownerSid` ascending (string compare), then `inventoryId` ascending.
  - `correlateOrg` return gains `deferredDevices: number` (`{ created; resolved; deferredDevices }`); callers in `jobs/vulnerabilityJobs.ts` ignore or log it.

Algorithm changes inside `correlateOrg` (pre-lock and lock order untouched):
1. **Generation capture first:** before the candidate reads, read `device_id, visible_observation_id, profile_baselines` from `device_software_inventory_state` for the scoped devices (plain SELECT, no lock) into `generations: Map<deviceId, string | null>`.
2. Candidate queries also select `softwareInventory.scope` and `ownerSid`.
3. **One upsert per (device, vulnerability):** group vulnerable candidates, link `pickPreferredCopy(group)`. The existing finding keeps one link; an existing link is moved to the preferred copy when they differ.
4. **Generation-checked resolve:** the resolve `UPDATE` adds, in the same statement, `state.visible_observation_id IS NOT DISTINCT FROM (${capturedJson}::jsonb ->> device_id::text)::uuid`. Findings on devices whose generation moved are left open; those device ids are collected (compare captured vs a post-UPDATE read).
5. **Validated retry:** if any devices moved, run the same pass once more for exactly those devices (new capture, new candidates). Devices still moving are counted in `deferredDevices` and left for the next pass. Never take the state row lock inside the findings transaction.
6. Retained rows from unobserved profiles are ordinary candidates, so a copy in an unread profile keeps the finding open. No code path removes a finding because a user scope changed while a machine copy is vulnerable.

- [ ] **Step 1: Write the failing tests**

```ts
// unit
it('pickPreferredCopy prefers machine, then lowest SID, then lowest id', () => {
  expect(pickPreferredCopy([u('S-1-5-21-9', 'b'), m('z'), u('S-1-5-21-1', 'a')]).inventoryId).toBe('z');
  expect(pickPreferredCopy([u('S-1-5-21-9', 'b'), u('S-1-5-21-1', 'c')]).inventoryId).toBe('c');
});
// integration
runDb('machine and per-user copies at different versions: one finding, linked to the machine copy', ...)
runDb('finding stays open while only a retained copy in a not-read profile is vulnerable', ...)
runDb('planted non-vulnerable user entry with the machine name cannot resolve or relink the machine finding', ...)
  // machine Code 1.80 vulnerable; SID_A "Code" 99.0 → status open, link = machine row
runDb('planted vulnerable user entry does not steal the link from a vulnerable machine copy', ...)
runDb('severed link is re-pointed to the surviving per-user copy on the next pass', ...)
runDb('concurrent ingest between capture and resolve defers resolution, then the validated retry resolves', ...)
  // test seam: an exported hook `__setCorrelationTestHooks({ afterCandidates })` runs an ingest that removes the vulnerable machine copy
  // assert: no 'patched' decided on stale candidates; after retry the finding is patched with resolvedObservationId = new observation
runDb('deleted profile: its only vulnerable copy goes away and the finding resolves', ...)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/vulnerabilityCorrelation.test.ts && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/vulnerabilityCorrelationPerUser.integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** steps 1–6. The test hook is a module-level optional callback, `undefined` in production, set only by the integration test.

- [ ] **Step 4: Run to verify it passes** — the above plus the existing `src/__tests__/integration/vulnerabilityCorrelationDeadlock.integration.test.ts`, `vulnerabilityCorrelationGating.integration.test.ts`, `src/services/vulnerabilityCorrelation.integration.test.ts`, `vulnerabilityCorrelationPhase2.integration.test.ts` and the lock-ordering contract test for `buildFindingPreLockQuery`. Expected: PASS, no 40P01.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityCorrelation.ts apps/api/src/services/vulnerabilityCorrelation.test.ts apps/api/src/__tests__/integration/vulnerabilityCorrelationPerUser.integration.test.ts apps/api/src/jobs/vulnerabilityJobs.ts
git commit -m "feat(api): scope-aware generation-consistent vulnerability correlation"
```

### Task 7: First-sighting findings send one summary per org (depends on the parent plan)

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts`
- Test: `apps/api/src/__tests__/integration/vulnerabilityCorrelationPerUser.integration.test.ts` (extend); unit in `vulnerabilityCorrelation.test.ts`

**Interfaces:**
- Consumes: the parent plan's per-org summary emitter. This plan calls it `emitVulnerabilitySummary(orgId, summary)`; bind to the name the parent exports and add the reason `'per_user_first_sighting'` to its reason union. Payload this plan supplies: `{ reason: 'per_user_first_sighting', findingCount, criticalCount, deviceCount }`.
- Produces:
  - `export function isFirstSighting(copies: readonly CandidateCopy[], baselines: ReadonlyMap<string, Readonly<Record<string, ProfileBaseline>>>, deviceId: string): boolean` — true when every vulnerable copy is user scope **and** each owning profile's baseline has `firstCorrelatedAt === null`.
  - `export async function markProfilesCorrelated(orgId: string, sidsByDevice: ReadonlyMap<string, readonly string[]>, at: Date): Promise<void>` — separate system transaction **after** the correlation transaction commits. One `UPDATE … SET profile_baselines = jsonb_set(…, '{<sid>,firstCorrelatedAt}', …)` per device in `device_id` order, only where the key is still null. It takes only state-row locks, so it cannot cycle with ingest.

- [ ] **Step 1: Write the failing tests**

```ts
it('isFirstSighting is false when any vulnerable copy is machine scope', ...)
it('isFirstSighting is false once the profile has been correlated', ...)
runDb('a profile\'s first correlated report emits one org summary and no per-finding critical_detected', ...)
  // spy publishEvent: zero 'vulnerability.critical_detected'; one summary with criticalCount 2, deviceCount 1
runDb('the next pass after first sighting emits per-finding events for new criticals in that profile', ...)
runDb('machine findings created in the same pass still emit per-finding events', ...)
runDb('markProfilesCorrelated does not overwrite a baseline an ingest replaced concurrently', ...)
```

- [ ] **Step 2: Run to verify it fails** — integration command from Task 6. Expected: FAIL.

- [ ] **Step 3: Implement.** Criticals are split before `emitCriticalDetected`; the first-sighting set goes to the parent's emitter after the closure (same post-closure discipline). Profiles marked are every user profile with `firstCorrelatedAt === null` among the generations captured in this pass, not only those with findings.

- [ ] **Step 4: Run to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityCorrelation.ts apps/api/src/services/vulnerabilityCorrelation.test.ts apps/api/src/__tests__/integration/vulnerabilityCorrelationPerUser.integration.test.ts
git commit -m "feat(api): summarize first-sighting per-user findings per org"
```

### Task 8: Read-time affected copies on finding detail

**Files:**
- Create: `apps/api/src/services/vulnerabilityAffectedCopies.ts`
- Modify: `apps/api/src/routes/vulnerabilities.ts` (`/devices/:deviceId/software` handler, `toDeviceFindingItem`), `packages/shared/src/types/vulnerability.ts:342` (`DeviceVulnFinding`)
- Modify: `apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx`
- Test: `apps/api/src/__tests__/integration/vulnerabilityAffectedCopies.integration.test.ts`, `apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx`

**Interfaces:**
- Produces:
  - `export type AffectedCopy = { inventoryId: string; scope: 'machine' | 'user'; ownerSid: string | null; ownerName: string | null; version: string | null; lastSeen: string | null }`
  - `export async function fetchAffectedCopies(findings: ReadonlyArray<{ id: string; deviceId: string; vulnerabilityId: string }>): Promise<Map<string, AffectedCopy[]>>` — joins `software_inventory` (same device) → `software_product_resolutions` (same lookup key as correlation) → `software_vulnerabilities` for that vulnerability, filters with the correlation's `isVulnerable`/`isVersionInRange`, orders with `pickPreferredCopy` semantics. Runs under the request's `withDbAccessContext` (RLS applies). No new table.
  - `DeviceVulnFinding.affectedCopies?: AffectedCopy[]`.

- [ ] **Step 1: Write the failing tests**

```ts
runDb('lists machine and both user copies that are currently vulnerable, machine first', ...)
runDb('omits a copy whose version is outside every range', ...)
runDb('includes a retained copy from a not-read profile', ...)
runDb('does not read another org\'s inventory under an org-scoped context', ...)
// web
it('renders one line per affected copy with "All users" or the owner name', () => {
  expect(screen.getByTestId('affected-copy-machine')).toHaveTextContent('All users');
  expect(screen.getByTestId('affected-copy-user-S-1-5-21-1')).toHaveTextContent('alice');
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/vulnerabilityAffectedCopies.integration.test.ts` and `cd apps/web && npx vitest run src/components/devices/DeviceVulnerabilitiesTab.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement**; add en keys `deviceVulnerabilities.affectedCopies.title`, `.allUsers`, `.user` (`"{{owner}}"`) to all 8 locale dirs.

- [ ] **Step 4: Run to verify it passes**, plus `src/__tests__/parkedFanout.contract.test.ts` (API) and `src/lib/i18n/localeParity.test.ts` (web). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityAffectedCopies.ts apps/api/src/routes/vulnerabilities.ts packages/shared/src/types/vulnerability.ts apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx apps/web/src/locales apps/api/src/__tests__
git commit -m "feat: show every vulnerable copy and owner on device findings"
```

### Task 9: Consumers that act on devices stay machine-only

**Files:**
- Modify: `apps/api/src/db/schema/softwarePolicies.ts` (`SoftwarePolicyViolation.software`), `apps/api/src/services/softwarePolicyService.ts` (`SoftwareInventoryRow`, `evaluateSoftwareInventory`, both inventory readers), `apps/api/src/jobs/softwareComplianceWorker.ts:~901`, `apps/api/src/jobs/softwareRemediationWorker.ts:~559-600`
- Modify: `apps/api/src/services/softwareCurrency.ts:77` (`isDeviceSoftwareCurrent`)
- Modify: `apps/api/src/services/vulnerabilityRemediation.ts` (`thirdPartyCandidatesByProduct`, skip reasons); `packages/shared` `SkippedItem['reason']`
- Test: `softwarePolicyService.test.ts`, `jobs/softwareComplianceWorker.test.ts`, `jobs/softwareRemediationWorker.test.ts`, `softwareCurrency.test.ts`, `vulnerabilityRemediation.test.ts`

**Interfaces:**
- `SoftwareInventoryRow` gains `scope: 'machine' | 'user'; ownerName: string | null`.
- `SoftwarePolicyViolation.software` gains `scope?: 'machine' | 'user'; ownerName?: string | null; manualRemovalRequired?: boolean` (true exactly when `scope === 'user'`).
- `SkippedItem['reason']` gains `'per_user_install'`.
- Builder call recorded here: allowlist/blocklist `unauthorized` checks see every copy, while `missing` (required-software) checks see machine rows only. A per-user copy must not suppress a machine-wide desired-state install, for the same reason the currency gate is machine-only.

- [ ] **Step 1: Write the failing tests**

```ts
it('flags an unauthorized per-user copy with manualRemovalRequired and owner', () => {
  expect(v.software).toMatchObject({ name: 'Cursor', scope: 'user', ownerName: 'alice', manualRemovalRequired: true });
});
it('a per-user copy does not satisfy a required-software rule', () => { /* missing violation still emitted */ });
it('compliance worker does not queue remediation when every unauthorized violation is per-user', () => {
  expect(remediationTargets).not.toContain(DEVICE); // decision recorded as 'manual_removal_required'
});
it('remediation worker never sends software_uninstall for a per-user violation and leaves status none', () => {
  expect(queueCommandForExecution).not.toHaveBeenCalled();
  expect(updatedStatus).toBe('none');
});
it('remediation worker dedupes by scope so a machine copy with the same name is still removed', ...)
it('isDeviceSoftwareCurrent ignores a stale per-user copy', () => {
  // machine 2.0 (current) + user 1.0 → true; only user 2.0 → false (no machine copy)
});
it('vulnerability remediation skips findings linked to a per-user copy with per_user_install', ...)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/softwarePolicyService.test.ts src/jobs/softwareComplianceWorker.test.ts src/jobs/softwareRemediationWorker.test.ts src/services/softwareCurrency.test.ts src/services/vulnerabilityRemediation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**: add `eq(softwareInventory.scope, 'machine')` to `isDeviceSoftwareCurrent`; select `scope`/`ownerName` in both policy readers; worker gates filter `!manualRemovalRequired`; remediation dedupe key becomes scope + name + version.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/softwarePolicies.ts apps/api/src/services/softwarePolicyService.ts apps/api/src/services/softwarePolicyService.test.ts apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareComplianceWorker.test.ts apps/api/src/jobs/softwareRemediationWorker.ts apps/api/src/jobs/softwareRemediationWorker.test.ts apps/api/src/services/softwareCurrency.ts apps/api/src/services/softwareCurrency.test.ts apps/api/src/services/vulnerabilityRemediation.ts apps/api/src/services/vulnerabilityRemediation.test.ts packages/shared/src
git commit -m "feat(api): keep remediation, currency and uninstall paths machine-scope"
```

### Task 10: Display and count consumers, device software tab, escaping, reader sweep

**Files:**
- Modify: `apps/api/src/routes/partnerApi/inventory.ts:439-455` (`selectSoftwareRows`)
- Modify: `apps/api/src/routes/devices/software.ts` (GET `scope` filter), `apps/api/src/routes/devices/softwareActions.ts` (`softwareActionPayloadSchema` + uninstall/update handlers)
- Modify: `apps/web/src/components/devices/DeviceSoftwareInventory.tsx`, locales (8 dirs)
- Test: `routes/partnerApi/inventory.test.ts`, `routes/devices/software.test.ts` (new), `routes/devices/softwareActions.test.ts`, `apps/web/src/components/devices/DeviceSoftwareInventory.test.tsx`, `packages/shared/src/utils/csvExport.test.ts`

**Interfaces:**
- Partner API: list and count both become distinct on `(lower(trim(name)), version, vendor)`, keeping the machine row when one exists (`DISTINCT ON … ORDER BY …, (scope <> 'machine'), owner_sid, id`). The response shape is unchanged (Partner API compatibility rule: no new fields), so `collection.total === included` still holds when nothing is truncated.
- `GET /devices/:id/software?scope=all|machine|user` (default `all`); rows already carry `scope`, `ownerSid`, `ownerName` via `.select()`.
- `softwareActionPayloadSchema` gains `scope?: 'machine' | 'user'`. `scope: 'user'` → `422 { error: 'Per-user installs cannot be removed or updated remotely; remove it from that user\'s session.', code: 'per_user_install' }`. A name-only request stays valid and the agent stays HKLM-only.
- Web: `data-testid="software-scope-filter"`, `data-testid="software-owner-<rowId>"`; per-user rows render the owner name and no uninstall/update buttons (`data-testid="software-manual-removal-<rowId>"` hint instead). New en keys: `deviceSoftwareInventory.columns.installedFor`, `.scope.allUsers`, `.filters.scopeAll`, `.filters.scopeMachine`, `.filters.scopeUser`, `.actions.manualRemovalRequired`.

- [ ] **Step 1: Write the failing tests**

```ts
it('partner API counts one program installed machine-wide and for two users once', () => {
  expect(body.data[0].collection).toEqual({ total: 1, included: 1, complete: true, reason: null });
});
it('partner API count is unchanged for a device with no per-user rows', ...)
it('GET /devices/:id/software?scope=user returns only user rows', ...)
it('uninstall with scope user is refused with 422 per_user_install and queues nothing', ...)
// web
it('shows owner name for per-user rows and hides uninstall/update', () => {
  expect(screen.getByTestId('software-owner-r2')).toHaveTextContent('alice');
  expect(screen.queryByTestId('software-uninstall-r2')).toBeNull();
});
it('filters by scope', ...)
it('renders hostile owner and program strings as inert text', () => {
  // ownerName '<img src=x onerror=alert(1)>\u202Eevil' → textContent contains the literal; container.querySelector('img') === null
});
// shared
it('escapeCsvCell neutralises a formula-prefixed owner name', () => {
  expect(escapeCsvCell('=HYPERLINK("http://x")')).toMatch(/^"?'=/);
});
```

- [ ] **Step 2: Run to verify it fails** — API: `cd apps/api && npx vitest run src/routes/partnerApi/inventory.test.ts src/routes/devices/software.test.ts src/routes/devices/softwareActions.test.ts`; web: `cd apps/web && npx vitest run src/components/devices/DeviceSoftwareInventory.test.tsx`; shared: `pnpm --filter @breeze/shared test --run src/utils/csvExport.test.ts`. Expected: FAIL (the CSV case may already pass. If so, keep it as a pin).

- [ ] **Step 3: Implement** the four changes. The web keeps `runAction` for the remaining mutations.

- [ ] **Step 4: Reader sweep.** Run `rg -l "softwareInventory\b|software_inventory\b" apps/api/src apps/web/src apps/portal/src ee packages -g '!*.test.*'` and record, in the PR body, one disposition per file: *machine-only (acts on device)*, *all copies (display/evaluation)*, *distinct (counts programs)*, or *unaffected (EXISTS/aggregate)*. Known dispositions:

| Reader | Disposition |
|---|---|
| `vulnerabilityCorrelation.ts`, `vulnerabilityAffectedCopies.ts` | all copies (Tasks 6, 8) |
| `softwarePolicyService.ts`, compliance/remediation workers | all copies for `unauthorized`, machine for `missing` and actions (Task 9) |
| `softwareCurrency.ts` → `automationRuntime.ts` gate | machine-only (Task 9) |
| `vulnerabilityRemediation.ts` | machine-only, skip `per_user_install` (Task 9) |
| `routes/devices/softwareUpdateMatch.ts` | per-row; per-user rows get no update action (UI, Task 10) |
| `alertConditions/handlers/softwarePresence.ts`, `filterEngine.ts` | unaffected: `EXISTS`/first-match semantics |
| `portal/softwareInventoryReadModel.ts` | already `count(distinct (name, version, vendor))` |
| `routes/partnerApi/inventory.ts` | distinct (this task) |
| `deviceInstallBoundary/classification.ts`, `aiToolsExport*.ts`, `aiAgentSdkTools.ts`, `reportGenerationService.ts`, `vulnerabilityFleet*.ts`, `routes/software*.ts`, `routes/agents/patches.ts`, `abuseSignals/recidivistEndpoint.ts`, `aiAgents/designEvidence.ts` | builder classifies; any one that triggers a device action becomes machine-only with a test; any AI tool returning owner/program strings passes them through `sanitizeUntrustedToolValue` (`services/aiInputSanitizer.ts`) with a test |

Note: `reportGenerationService`'s software report (and the AI `software_inventory` export dataset built on it) reads `device_software`, which has no production writer, not `software_inventory`. That is out of scope; record it in the PR body as a pre-existing gap.

- [ ] **Step 5: Run to verify it passes** — all Step 2 commands plus `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes apps/web/src/components/devices apps/web/src/locales packages/shared/src/utils
git commit -m "feat: per-user software in device tab, partner API distinct count, scoped actions"
```

### Task 11: Phase 1 verification and PR

- [ ] **Step 1:** `pnpm test` → PASS. `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/softwareInventory src/__tests__/integration/vulnerabilityCorrelation src/__tests__/integration/tenant src/services/vulnerabilityCorrelation` → PASS. `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS. Then `pnpm test-stack down`.
- [ ] **Step 2:** The typecheck is clean for api, web and shared (via turbo/CI). Check the exit code, not a tail of the output.
- [ ] **Step 3:** Open the PR with the reader-sweep table, the `device_software` note and the parent-plan dependency status for Task 7. Run one independent review round.

---

# Phase 2 — Agent (one PR, merges only after Phase 1 is deployed and Task 7 merged)

### Task 12: Collector types, dedupe key, options API, machine-only `Collect()`

**Files:**
- Modify: `agent/internal/collectors/software.go`, `software_darwin.go`, `software_linux.go`, `software_windows.go` (signature only in this task)
- Test: `agent/internal/collectors/software_observation_test.go`

**Interfaces:**
- Produces:
  - `const SoftwareScopeMachine = "machine"; SoftwareScopeUser = "user"`
  - `type SoftwareProfileState string` with `SoftwareProfileRead = "read"`, `SoftwareProfileNotLoaded = "not_loaded"`, `SoftwareProfileFailed = "failed"`, `SoftwareProfileSkippedBudget = "skipped_budget"`
  - `SoftwareItem` gains `Scope string \`json:"scope,omitempty"\``, `OwnerSID string \`json:"ownerSid,omitempty"\``, `OwnerName string \`json:"ownerName,omitempty"\``
  - `type SoftwareProfileObservation struct { SID string \`json:"sid"\`; OwnerName string \`json:"ownerName"\`; State SoftwareProfileState \`json:"state"\`; ItemCount int \`json:"itemCount"\` }`
  - `SoftwareInventoryObservationV2` gains `ProfileListComplete *bool \`json:"profileListComplete,omitempty"\``, `Profiles []SoftwareProfileObservation \`json:"profiles,omitempty"\``
  - `type SoftwareCollectOptions struct { IncludeUserProfiles bool }`
  - `func (c *SoftwareCollector) CollectObservationWithOptions(opts SoftwareCollectOptions) (SoftwareInventoryObservationV2, error)` (per-platform); `CollectObservation()` = `CollectObservationWithOptions(SoftwareCollectOptions{})`
  - `func (o SoftwareInventoryObservationV2) MachineOnly(newID string) SoftwareInventoryObservationV2` — drops user items, clears `Scope/Owner*`, nils `Profiles`/`ProfileListComplete`, recomputes `ItemCount`, sets `ObservationID = newID`.
  - `buildSoftwareObservation` gains a `userItems []SoftwareItem, profiles []SoftwareProfileObservation, profileListComplete *bool` tail (nil/empty on non-Windows).
  - `Collect()` returns machine-scope items only (explicit filter), even if the seam returns user items.

- [ ] **Step 1: Write the failing tests**

```go
func TestBuildSoftwareObservationDedupeKeyIncludesScopeAndOwner(t *testing.T) // machine "Code 1.9" + user A "Code 1.9" + user B "Code 1.9" → 3 items
func TestCollectReturnsMachineScopeOnly(t *testing.T)                          // seam returns 1 machine + 1 user → Collect() len 1, no error
func TestLegacyPayloadHasNoPerUserKeys(t *testing.T) {
	// json.Marshal(obs with machine items, no profiles) → decode to map; assert top-level keys == the pre-change set exactly,
	// and item keys ⊆ {name,version,vendor,installDate,installLocation,uninstallString}
}
func TestMachineOnlyStripsUserDataAndRenumbers(t *testing.T)
func TestUserItemsNeverSetTruncated(t *testing.T) // 5000 machine + user items supplied → Truncated false, user items dropped by caller budget (see Task 13)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test -race ./internal/collectors/ -run 'TestBuildSoftwareObservation|TestCollectReturns|TestLegacyPayload|TestMachineOnly|TestUserItems'`
Expected: FAIL (compile errors on new fields).

- [ ] **Step 3: Implement.** Dedupe key: `scope + "\x00" + ownerSID + "\x00" + name + "\x00" + version`. Machine items are appended first; user items follow and never count toward `Truncated`.

- [ ] **Step 4: Run to verify it passes.** Run the same command, then `cd agent && go test -race ./internal/collectors/ ./internal/heartbeat/ ./internal/remote/tools/`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/collectors/software*.go
git commit -m "feat(agent): scope-aware software items and machine-only Collect"
```

### Task 13: Platform-neutral profile engine (states, budgets, owner names)

**Files:**
- Create: `agent/internal/collectors/software_profiles.go` (no build tag)
- Test: `agent/internal/collectors/software_profiles_test.go` (no build tag, runs on Linux CI)

**Interfaces:**
- Produces:
  - `type profileListEntry struct { SID, ProfileImagePath string }`
  - `type userHiveReader interface { ProfileList() (entries []profileListEntry, complete bool, err error); LoadedHiveNames() ([]string, error); ReadUninstall(ctx context.Context, sid string, maxEntries int) ([]SoftwareItem, error) }` — `ReadUninstall` is strict: any subkey-open or value-read error (other than a missing optional value or a missing Uninstall key, which is an empty read) returns an error.
  - `type SoftwareUserBudgets struct { MaxEntriesPerProfile, MaxProfilesRead int; PerProfileTimeout, OverallTimeout time.Duration; MaxUserItemBytes int }`
  - `var DefaultSoftwareUserBudgets = SoftwareUserBudgets{MaxEntriesPerProfile: 1000, MaxProfilesRead: 50, PerProfileTimeout: 5 * time.Second, OverallTimeout: 30 * time.Second, MaxUserItemBytes: 2 << 20}` (initial values; tune from lab data in Task 16)
  - `const maxSoftwareReportBytes = 4_500_000; const maxReportedProfiles = 1000`
  - `func collectUserProfiles(ctx context.Context, r userHiveReader, b SoftwareUserBudgets, remainingItems, remainingBytes int) (items []SoftwareItem, profiles []SoftwareProfileObservation, listComplete bool)`
  - `func loadedProfileSIDs(hiveNames []string) map[string]bool` — drops names ending `_Classes` and `.DEFAULT`.
  - `func isServiceSID(sid string) bool` — `S-1-5-18|19|20`.
  - `func ownerNameFromProfilePath(p string) string` — last element after `\` or `/`, trimmed, truncated to 256 via `truncateSoftwareWireString`.

Rules:
- Profiles are sorted by SID. Service SIDs are dropped. The list is capped at `maxReportedProfiles` (loaded first); a capped list or a `ProfileList` error sets `listComplete=false`.
- A profile not in `loadedProfileSIDs` → `not_loaded`. A `ReadUninstall` error, a per-profile timeout, or exceeding `MaxEntriesPerProfile` → `failed` with zero items, and enumeration continues.
- Global budgets (`MaxProfilesRead`, `OverallTimeout`, `remainingItems`, `min(MaxUserItemBytes, remainingBytes)` measured as JSON-encoded item size) exhausted mid-profile → that profile `failed`, every later loaded profile `skipped_budget`.
- Each read item is stamped `Scope=user`, `OwnerSID`, `OwnerName`, sanitized with `sanitizeSoftwareInventoryItem`. `ItemCount` equals that profile's deduped items.

- [ ] **Step 1: Write the failing table-driven tests** with a `fakeHiveReader`:

```go
func TestCollectUserProfilesStates(t *testing.T)                  // read / not_loaded / failed (mid-enumeration error) / service SID skipped
func TestCollectUserProfilesMissingUninstallKeyIsEmptyRead(t *testing.T)
func TestCollectUserProfilesEntryBudgetFailsOnlyThatProfile(t *testing.T)
func TestCollectUserProfilesGlobalBudgetPartwayThroughProfile(t *testing.T) // 3rd profile exceeds bytes → failed; 4th,5th skipped_budget; 1st,2nd read
func TestCollectUserProfilesNoHeadroomSkipsAll(t *testing.T)      // remainingItems 0 → every loaded profile skipped_budget, no items
func TestCollectUserProfilesProfileListErrorMarksIncomplete(t *testing.T)
func TestCollectUserProfilesCapsAt1000AndMarksIncomplete(t *testing.T)
func TestCollectUserProfilesOverallTimeout(t *testing.T)          // reader blocks on ctx → failed then skipped_budget; returns within budget+slack
func TestLoadedProfileSIDsSkipsClassesAndDefault(t *testing.T)
func TestOwnerNameFromProfilePath(t *testing.T)                   // `C:\Users\alice`→alice, `%SystemDrive%\Users\bob.CONTOSO`→bob.CONTOSO, ``→``, 300-char name→256 bytes max, invalid UTF-8 cleaned
func TestCollectUserProfilesUniqueSIDs(t *testing.T)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test -race ./internal/collectors/ -run 'TestCollectUserProfiles|TestLoadedProfileSIDs|TestOwnerName'`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement** `software_profiles.go`. Per-profile work runs under `context.WithTimeout(ctx, PerProfileTimeout)` derived from an overall `context.WithTimeout(ctx, OverallTimeout)`.

- [ ] **Step 4: Run to verify it passes** — same command, then `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/collectors/`. Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/collectors/software_profiles.go agent/internal/collectors/software_profiles_test.go
git commit -m "feat(agent): budgeted per-user profile inventory engine"
```

### Task 14: Windows registry adapter, `hkcu` retirement, capability-gated send

**Files:**
- Create: `agent/internal/collectors/software_profiles_windows.go`, `software_profiles_windows_test.go` (`//go:build windows`)
- Modify: `agent/internal/collectors/software_windows.go`, `software_windows_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (`softwareObservationFn`, `sendSoftwareInventory`, `sendInventoryData` error type), `agent/internal/heartbeat/software_inventory_test.go`
- Test (consumers): `agent/internal/heartbeat/handlers_test.go`, `agent/internal/remote/tools/software_uninstall_verify_test.go`, `agent/internal/collectors/change_tracker_test.go`

**Interfaces:**
- Consumes: Tasks 12–13.
- Produces:
  - `type registryHiveReader struct{}` implementing `userHiveReader`: `ProfileList` enumerates `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList` (`complete=false` on any subkey/value error); `LoadedHiveNames` = `registry.USERS` `ENUMERATE_SUB_KEYS` (precedent `backup/systemstate/regflush_windows.go:loadedUserHives`); `ReadUninstall` opens `HKU\<SID>\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` with `registry.READ` (never `RegLoadKey`), reuses `readSoftwareFromKey`/`isSystemComponent`, and fails on any subkey open error or non-`ErrNotExist` value error.
  - `softwareRegistryPaths` loses the `hkcu` entry. `SoftwareSourceWindowsHKCU` stays declared (server normalisation references it) but is never emitted.
  - `var softwareUserHiveReader userHiveReader = registryHiveReader{}` (test seam).
  - heartbeat: `softwareObservationFn func(collectors.SoftwareCollectOptions) (collectors.SoftwareInventoryObservationV2, error)`; `const softwareInventoryPerUserCapability = "software_inventory_per_user_v1"`; `type softwareSubmissionError struct{ status int }`; `func (h *Heartbeat) perUserInventoryCapable() bool` = `h.wsClient != nil && h.wsClient.HasServerCapability(softwareInventoryPerUserCapability)`.
  - Send rule: collect with `IncludeUserProfiles: capable`. On `softwareSubmissionError{400}` with a per-user payload, log once and resend `observation.MachineOnly(uuid.NewString())` in the same cycle.

- [ ] **Step 1: Write the failing tests**

```go
// collectors (windows)
func TestWindowsCollectObservationNoLongerExpectsHKCU(t *testing.T)            // expected sources == [hklm64, hklm32] when both exist; failed-all case len 2
func TestWindowsCollectObservationIncludesUserProfilesOnlyWhenAsked(t *testing.T) // fake softwareUserHiveReader; opts false → no profiles key
func TestRegistryHiveReaderReadsCurrentUserHiveWithoutLoading(t *testing.T)     // lab/Windows: current test user's SID → read or empty, never error on missing key
// heartbeat
func TestSendSoftwareInventoryLegacyPayloadWithoutCapability(t *testing.T)      // no ws capability → body has no "profiles"/"scope" substrings
func TestSendSoftwareInventoryPerUserPayloadWithCapability(t *testing.T)        // fake ws capability → body carries profiles
func TestSendSoftwareInventoryFallsBackToLegacyOn400(t *testing.T)              // server 400s bodies containing "profiles" → second PUT has new observationId and no per-user keys
// consumers stay machine-only
func TestHandleCollectSoftwareReturnsMachineScopeOnly(t *testing.T)
func TestSoftwareStillInstalledIgnoresUserScopeCopies(t *testing.T)             // seam returns machine-less list + user "Foo" → false
func TestChangeTrackerSoftwareSnapshotIsMachineOnly(t *testing.T)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestSendSoftwareInventory|TestHandleCollectSoftware' && go test -race ./internal/remote/tools/ -run TestSoftwareStillInstalled && go test -race ./internal/collectors/ -run TestChangeTracker` and `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet ./internal/collectors/ ./internal/heartbeat/`
Expected: FAIL / compile errors.

- [ ] **Step 3: Implement.** Machine sources are read first; `collectUserProfiles` gets `remainingItems = collectorResultLimit - len(machineItems)` and `remainingBytes = maxSoftwareReportBytes - len(json(machine observation))`.

- [ ] **Step 4: Run to verify it passes** — same commands, then `cd agent && go test -race ./...` and the cross-compile vet. Windows-tagged tests: `internal/collectors` is **not** in the `test-agent-windows` CI package list (`.github/workflows/ci.yml` ~line 2150). Run `go test ./internal/collectors/` on the Windows lab VM. Add `./internal/collectors` to that list only if a `gh workflow run CI --ref <branch>` shows the whole package green on `windows-latest`. Otherwise note in the PR that it stays excluded (#2523 debt).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/collectors agent/internal/heartbeat agent/internal/remote/tools .github/workflows/ci.yml
git commit -m "feat(agent): read loaded user hives for per-user software, capability-gated"
```

### Task 15: Phase 2 verification and PR

- [ ] **Step 1:** `cd agent && go test -race ./...` → PASS; `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/breeze-agent` → builds.
- [ ] **Step 2:** Open the PR (agent ships to customer machines, so request one independent review). The PR body states: Phase 1 is deployed in both regions, Task 7 is merged, and the Phase 3 lab legs are owed before promotion.

---

# Phase 3 — Lab gate before promotion (non-code)

### Task 16: Windows lab legs (spec §6.4)

Run on a lab Windows VM with the Phase 2 build, against a stack running Phase 1. Record each result (pass/fail, observation ids, timings) in the Phase 2 PR before promoting.

- [ ] **Two local users, one logged on, one not.** The logged-on user's per-user installs (e.g. VS Code user installer) appear with that owner name. The other profile is `not_loaded`. After the first user logs off and the next report lands, nothing disappears and `last_seen` on that user's rows is unchanged. No `vulnerability.critical_detected` fires for the first sighting; one org summary does.
- [ ] **Azure AD user.** Collection time with an AAD profile is in line with local profiles (no directory stall). The owner name equals the profile folder name.
- [ ] **Terminal server with many sessions.** Machine inventory stays complete (`accepted_complete`, same machine count as before) when user budgets run out. Profiles beyond the budget are `skipped_budget`. Measure per-profile and total enumeration time and report bytes, and set `DefaultSoftwareUserBudgets` from them.
- [ ] **Deleted profile.** Delete a profile through System Properties. On the next report its programs leave inventory and its findings resolve.
- [ ] **Agent rollback** to the previous version. Per-user rows and findings stay unchanged. The machine collapse guard does not trip on the re-added `hkcu` source.
- [ ] **Kill switch.** Set `BREEZE_SOFTWARE_PER_USER_INVENTORY_DISABLED=true` and restart the API. After the agent reconnects it sends the legacy payload, and stored per-user rows are retained.

---

## Self-review notes

- Spec coverage: §5.1 → Tasks 12–14; §5.2 → Tasks 12, 14 (uninstall scope refusal in Task 10); §5.3 → Tasks 1, 5, 14; §5.4 → Tasks 2–4; §5.5 → Tasks 6–8; §5.6 → Tasks 6, 10 (escaping), 13 (sanitizing); §5.7 → Tasks 9–10; §6 → Tasks 7, 16; §7 required tests → both upgrade orders (Tasks 4, 12), rollback (4, 16), incomplete enumeration (4, 13), budget partway (13), different versions (6, 8), severed links (4, 6), concurrent ingest (6), planted entries (6).
- Spec claims the code contradicted or refined:
  - The software-inventory report and AI export dataset read `device_software` (no production writer), not `software_inventory`.
  - Windows collector tests never run in CI (`internal/collectors` is excluded from `test-agent-windows`). That is why the profile engine is platform-neutral.
  - Per-user uninstall is already impossible on the agent (HKLM-only enumeration), so Task 10's server refusal is defence in depth.
  - Correlation is a scheduled per-org pass, not per-ingest, so "first `read` report" is implemented as "first correlated pass after the profile's first read".
