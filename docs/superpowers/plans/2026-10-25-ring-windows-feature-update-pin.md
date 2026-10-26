# Update Ring Windows Feature-Update Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an update ring decide whether its devices receive Windows feature releases (block / allow newest / pin to one release), and make the agent honour that decision both in its own scan filter and in Windows Update's own target-release policy.

**Architecture:** A new `feature_updates` jsonb on `patch_policies` (rings) carries `{mode:'block'|'allow'|'pin', product?, targetVersion?}`. The approval evaluator gates Windows feature-update candidates on it (server side), and the heartbeat pushes the resolved ring value to the agent as a `feature_update_settings` config block. The agent replaces its local-only `patch_exclude_feature_updates` default with that server-driven policy, types WUA "Upgrades" as feature updates, and in pin mode writes the Windows Update for Business `TargetReleaseVersion` registry policy so Windows itself offers and holds at that release.

**Tech Stack:** Go agent (WUA COM, `golang.org/x/sys/windows/registry`), Hono/TypeScript API, Drizzle schema + hand-written SQL migration, Zod (`@breeze/shared/validators`), React + react-hook-form (web), Vitest, Go `testing`.

**Spec:** This document (design section below). Conversation decision 2026-10-25: the control lives on the **update ring**, not the policy Patch tab.

## Design

- **Setting home (settings rule 9):** Update ring → *Install enforcement* → "Windows feature updates". Level: partner (rings are partner-owned). Resolver: device → winning patch feature link → linked ring → `feature_updates`; agent receives it per heartbeat. Count of places configured: before 1 (agent-local `patch_exclude_feature_updates`, undocumented), after 1 (the ring). The agent key stays only as an operator kill switch (`true` = always exclude), default `false`.
- **Shape:** `ringFeatureUpdatesSchema` =
  `{ mode: 'block' } | { mode: 'allow' } | { mode: 'pin', product: 'windows-11' | 'windows-10', targetVersion: /^\d{2}H[12]$/ (stored upper-case) }`.
  Column default `{"mode":"block"}` so every existing ring and every device without a ring keeps today's behaviour (feature updates never offered).
- **What counts as a Windows feature update (both sides, same rule):** agent `UpdateType == "feature"` = WUA `BrowseOnly` **or** a category named `Upgrades`; category classifier maps `upgrade` → `feature`. Server: candidate with `source === 'microsoft'`, `category === 'feature'` and a title matching `parseWindowsFeatureUpdateTitle` → `/\bWindows (10|11)\b[^,]*,\s*version (\d{2}H[12])\b/i`. Cumulative-update titles ("… for Windows 11 Version 24H2 for x64 …") have no comma and never match; .NET feature packs have no version token and never match.
- **Semantics:** `block` → the agent never reports it and the server denies it (`blocked_by_feature_update_policy`). `allow` → reported; approval follows the ring's normal rules (a `feature` category override with auto-approve installs it automatically; feature updates are unrated, so the default rule needs the unrated opt-in). `pin` → only the release whose parsed `{product, version}` equals the pin passes; everything else is denied/filtered. Pin also writes WUfB `TargetReleaseVersion=1`, `TargetReleaseVersionInfo=<ver>`, `ProductVersion=Windows 11|Windows 10` under `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate` with Breeze ownership sentinels; block/allow revert only Breeze-owned values (a pre-existing admin value is left as-found, same contract as `winupdate.Apply`).
- **Fail-closed defaults:** no ring, invalid ring, malformed stored value, legacy job snapshot without the key, parse failure on the agent → `block`.

## Global Constraints

- Migration name must sort after `2027-01-05-110000-agreements-send-permission.sql`; idempotent; DDL only (no `set_config`). `patch_policies` is partner-axis: no cascade/merge/export registration.
- Never `drizzle-kit`; update `apps/api/src/db/schema/patches.ts` by hand; `pnpm db:check-drift` if a DB is available (else rely on CI `Check Migrations`).
- New en locale keys go to all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`.
- Agent code is untagged where it is pure logic (testable on macOS/Linux CI); registry I/O stays in `_windows.go` files with a stub for other platforms.
- Heartbeat config keys accept both `snake_case` and `camelCase`, like every other block.
- Scoped test runs: `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`).

## Review Focus

1. A pin on `windows-11 / 25H2` must not let a "2026-10 Cumulative Update for Windows 11 Version 25H2 …" be gated or denied as a feature update (Task 1 + Task 4 tests pin this).
2. A device whose policy links no ring, or a disabled/invalid ring, must receive `{mode:'block'}` — never `allow` (Task 6 test).
3. A legacy job snapshot without `ringFeatureUpdates` must deny feature updates (block), not allow them (Task 5 test).
4. Agent restart before the first heartbeat config must scan with `block` (Task 2: default policy test).
5. Revert in the agent must never delete an admin-set `TargetReleaseVersion` that Breeze did not write (Task 3 test).

---

### Task 1: Agent — feature-update policy type, title parser, classifier

**Files:**
- Create: `agent/internal/patching/feature_update_policy.go`, `agent/internal/patching/feature_update_policy_test.go`
- Modify: `agent/internal/patching/category.go` (feature rank also matches `upgrade`), `agent/internal/patching/category_test.go`

**Interfaces (produces):**
```go
type FeatureUpdateMode string
const (FeatureUpdateBlock FeatureUpdateMode = "block"; FeatureUpdateAllow = "allow"; FeatureUpdatePin = "pin")
type FeatureUpdatePolicy struct { Mode FeatureUpdateMode; Product string; TargetVersion string } // Product "windows-11"|"windows-10"; TargetVersion "25H2"
func DefaultFeatureUpdatePolicy() FeatureUpdatePolicy                 // {Mode: block}
func ParseFeatureUpdatePolicy(raw any) (FeatureUpdatePolicy, error)   // map[string]any with mode/product/targetVersion (camel or snake); unknown mode → error
func (p FeatureUpdatePolicy) Allows(patch AvailablePatch) bool        // UpdateType != "feature" → true; block → false; allow → true; pin → title parses and product+version match
func ParseWindowsFeatureUpdateTitle(title string) (product, version string, ok bool) // product "windows-11"/"windows-10", version upper-cased
func isWindowsUpgradeClassification(names []string) bool             // any name contains "upgrade" (case-insensitive)
```

- [ ] Write failing tests: title vectors — `"Windows 11, version 24H2"`→(windows-11,24H2); `"Feature update to Windows 10, version 22H2 via Enablement Package (KB5015684)"`→(windows-10,22H2); `"Windows 11, version 25h2"`→25H2; `"2026-10 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5066835)"`→!ok; `"Microsoft .NET Framework 4.8.1 Feature Pack"`→!ok. Allows: non-feature patch always true; block false; allow true; pin matches only same product+version (also: pin 25H2 vs title 24H2 false; pin windows-10 vs "Windows 11, version 24H2" false; pin with unparseable title false). Parse: snake/camel keys, missing mode → error, pin without version → error, version normalised upper. Classifier: `[]string{"Windows 11","Upgrades"}`→feature; `isWindowsUpgradeClassification([]string{"Upgrades"})`→true, `{"Drivers"}`→false.
- [ ] Run `cd agent && go test ./internal/patching/ -run 'FeatureUpdate|ClassifyWindowsUpdateCategory|UpgradeClassification'` → FAIL (undefined).
- [ ] Implement per the Interfaces block; add `strings.Contains(n, "upgrade")` to the `feature` rank in `category.go`.
- [ ] Run the same command → PASS. Commit `feat(agent): feature-update policy type and Windows release title parser`.

### Task 2: Agent — provider filter driven by the policy; manager setter; config default

**Files:**
- Modify: `agent/internal/patching/windows.go` (struct field, `SetFeatureUpdatePolicy`, `shouldExcludePatch`, `updateToPatch` upgrade typing), `agent/internal/patching/manager.go` (`SetFeatureUpdatePolicy` fan-out), `agent/internal/config/config.go:404` (`PatchExcludeFeatureUpdates: false`)
- Create: `agent/internal/patching/feature_update_filter.go` (untagged) holding `type FeatureUpdatePolicySetter interface { SetFeatureUpdatePolicy(FeatureUpdatePolicy) }` and `func excludeFeatureUpdate(killSwitch bool, policy FeatureUpdatePolicy, patch AvailablePatch) bool`, plus `feature_update_filter_test.go`
- Test: `agent/internal/patching/manager_test.go` (setter fan-out with a fake provider)

**Interfaces (produces):** `func (m *PatchManager) SetFeatureUpdatePolicy(p FeatureUpdatePolicy)` — forwards to every provider implementing `FeatureUpdatePolicySetter`.

- [ ] Failing tests: `excludeFeatureUpdate(true, allowPolicy, featurePatch)`→true (kill switch wins); `(false, block, feature)`→true; `(false, allow, feature)`→false; `(false, pin25H2, title24H2)`→true; `(false, block, driverPatch)`→false. Manager: fake provider records the policy after `SetFeatureUpdatePolicy`; a provider without the method is skipped.
- [ ] Run `go test ./internal/patching/ -run 'ExcludeFeatureUpdate|SetFeatureUpdatePolicy'` → FAIL.
- [ ] Implement. In `windows.go`: `featurePolicy atomic.Pointer[FeatureUpdatePolicy]` initialised to `DefaultFeatureUpdatePolicy()` in `NewWindowsUpdateProvider`; `shouldExcludePatch` keeps the driver rule and replaces the feature branch with `excludeFeatureUpdate(w.cfg != nil && w.cfg.PatchExcludeFeatureUpdates, *w.featurePolicy.Load(), patch)`; in `updateToPatch` set `updateType = "feature"` when `browseOnly || isWindowsUpgradeClassification(categoryNames)`. Flip the config default to `false` and comment that the ring now decides.
- [ ] Run tests → PASS; `cd agent && go vet ./... && GOOS=windows go build ./...` → clean. Commit `feat(agent): ring-driven Windows feature-update filter`.

### Task 3: Agent — WUfB target-release registry policy + heartbeat config block

**Files:**
- Create: `agent/internal/winupdate/target_release.go` (pure plan logic + types), `agent/internal/winupdate/target_release_windows.go` (registry I/O), `agent/internal/winupdate/target_release_stub.go` (`//go:build !windows`), `agent/internal/winupdate/target_release_test.go`
- Create: `agent/internal/heartbeat/feature_update.go`, `agent/internal/heartbeat/feature_update_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go:3537-3545` (dispatch `feature_update_settings` / `featureUpdateSettings` next to `patch_source_settings`)

**Interfaces (produces):**
```go
// winupdate
type TargetRelease struct { ProductVersion string /* "Windows 11"|"Windows 10" */; TargetVersion string /* "25H2" */ }
func ApplyTargetRelease(pin *TargetRelease) (Result, error)   // nil = revert Breeze-owned values
func planTargetRelease(pin *TargetRelease, st targetReleaseState) targetReleasePlan // pure
// heartbeat
var applyTargetRelease = winupdate.ApplyTargetRelease   // test seam, like applyWinUpdate
func (h *Heartbeat) applyFeatureUpdateConfig(raw any)   // parse → h.patchMgr.SetFeatureUpdatePolicy → applyTargetRelease(pin or nil)
func productVersionFor(product string) string           // "windows-11"→"Windows 11", "windows-10"→"Windows 10"
```
Registry: key `SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`; values `TargetReleaseVersion` (DWORD 1), `TargetReleaseVersionInfo` (SZ), `ProductVersion` (SZ), sentinel `BreezeManagedTargetRelease` (DWORD 1).

- [ ] Failing tests (pure): pin with no existing values → write all three + sentinel; pin where `TargetReleaseVersion` exists without the sentinel → no write, `Managed:false`, reason names the pre-existing policy; pin re-asserted (sentinel present, same values) → write (idempotent) `Managed:true`; revert with sentinel → delete the three + sentinel; revert without sentinel → no-op `Reason` "left as-found". Heartbeat: `{"feature_update_settings":{"mode":"pin","product":"windows-11","targetVersion":"25H2"}}` → manager receives pin policy AND `applyTargetRelease` called with `{Windows 11, 25H2}`; `{"featureUpdateSettings":{"mode":"allow"}}` → policy allow, `applyTargetRelease(nil)`; malformed → neither called; block absent → neither called.
- [ ] Run `go test ./internal/winupdate/ ./internal/heartbeat/ -run 'TargetRelease|FeatureUpdateConfig'` → FAIL.
- [ ] Implement; mirror `winupdate.Apply`'s read-back verification and the "only delete what Breeze wrote" contract. In the heartbeat test, construct `Heartbeat{patchMgr: patching.NewPatchManager(fakeProvider)}` (check how `patch_source_test.go` builds the struct and reuse it).
- [ ] Run → PASS; `go vet ./... && GOOS=windows go build ./... && go test -race ./internal/patching/ ./internal/winupdate/ ./internal/heartbeat/`. Commit `feat(agent): apply ring feature-update policy from heartbeat; WUfB target release pin`.

### Task 4: API — schema, migration, shared validator, ring routes, AI tools

**Files:**
- Create: `apps/api/migrations/2027-01-05-120200-patch-policies-feature-updates.sql`
- Modify: `apps/api/src/db/schema/patches.ts:175` (add `featureUpdates: jsonb('feature_updates').notNull().default({ mode: 'block' })`), `packages/shared/src/validators/index.ts` (after `ringAppRulesSchema`: `ringFeatureUpdatesSchema`, `RingFeatureUpdates`, `DEFAULT_RING_FEATURE_UPDATES`, `parseWindowsFeatureUpdateTitle`, `isWindowsFeatureUpdateCandidate`), `apps/api/src/routes/updateRings.ts` (create/update schemas, list projection, insert, update fields), `apps/api/src/services/aiToolsPolicyPrereqs.ts` (definition property + create/update handling via `ringFeatureUpdatesSchema.safeParse`), `apps/api/src/services/aiToolSchemas.ts:2417`, `apps/api/src/services/aiAgentSdkTools.ts:3386`
- Test: `packages/shared/src/validators/__tests__/ringFeatureUpdates.test.ts` (new; check the directory's existing naming), `apps/api/src/routes/updateRings_list_create.test.ts`

**Interfaces (produces):**
```ts
export const ringFeatureUpdatesSchema = z.discriminatedUnion('mode', [block, allow, pin]) // pin: product z.enum(['windows-11','windows-10']), targetVersion z.string().regex(/^\d{2}H[12]$/i).transform(upper)
export type RingFeatureUpdates = z.infer<typeof ringFeatureUpdatesSchema>;
export const DEFAULT_RING_FEATURE_UPDATES: RingFeatureUpdates = { mode: 'block' };
export function parseWindowsFeatureUpdateTitle(title: string): { product: 'windows-11' | 'windows-10'; version: string } | null;
export function isWindowsFeatureUpdateCandidate(p: { source: string; category: string | null; title: string }): boolean; // microsoft + 'feature' + title parses
export function featureUpdateAllowed(policy: RingFeatureUpdates, title: string): boolean; // block false; allow true; pin exact match
```
Migration body: `ALTER TABLE patch_policies ADD COLUMN IF NOT EXISTS feature_updates jsonb NOT NULL DEFAULT '{"mode":"block"}'::jsonb;` plus an idempotent `CHECK (jsonb_typeof(feature_updates) = 'object')` named `patch_policies_feature_updates_object_chk`, header comment modelled on `2026-12-17-110000-patch-policies-app-rules.sql`.

- [ ] Failing tests: validator accepts the three shapes, upper-cases `25h2`, rejects `{mode:'pin'}` without version, rejects `mode:'latest'`, rejects version `25H3`; title parser vectors identical to Task 1 (same five strings, same results); `featureUpdateAllowed`. Route test (mirror the `appRules` cases at lines 51/276-295): list returns `featureUpdates`; create without the field stores `{mode:'block'}`; create with `pin` stores it; PATCH with an invalid pin → 400.
- [ ] Run `cd packages/shared && npx vitest run src/validators` and `cd apps/api && npx vitest run src/routes/updateRings_list_create.test.ts` → FAIL.
- [ ] Implement. Create defaults to `data.featureUpdates ?? DEFAULT_RING_FEATURE_UPDATES`; update sets only when provided. AI tool: property `featureUpdates: { type:'object', description:'Windows feature releases: {mode:"block"|"allow"|"pin", product:"windows-11"|"windows-10" (pin), targetVersion:"25H2" (pin)}' }`; create/update validate with `ringFeatureUpdatesSchema.safeParse`, return `{error}` on failure (same style as `validateRingAppRules`).
- [ ] Run → PASS. Also `cd apps/api && npx vitest run src/services/aiToolSchemas src/services/mcpCoverage src/services/aiGuardrails.routeBinding.contract.test.ts` (schema parity contracts) → PASS. Commit `feat(api): update rings carry a Windows feature-update policy`.

### Task 5: API — eligibility gate, snapshot, executor, ineligible reason

**Files:**
- Modify: `packages/shared/src/types/aiPatchPlan.ts:223-247` (add `'blocked_by_feature_update_policy'` after `blocked_by_app_rule`), `apps/api/src/services/patchApprovalEvaluator.ts` (`ApprovalEvaluationConfig.featureUpdates?: RingFeatureUpdates`; add the reason to the `Exclude<…>` list at :433), `apps/api/src/services/configPolicyPatching.ts` (`PatchRingResolution.featureUpdates: RingFeatureUpdates`; select + coerce via `ringFeatureUpdatesSchema.safeParse`, malformed → block + `captureException`; `noRingResolution` → block), `apps/api/src/services/patchJobSnapshot.ts` (`ringFeatureUpdates`), `apps/api/src/jobs/patchJobExecutor.ts:1126-1137,1250-1260` (parse `ringFeatureUpdates`; absent or malformed → `{mode:'block'}`, malformed logs + Sentry), `apps/api/src/services/patchEligibility.ts:222-246` (gate after category filter), `:431-442` (`featureUpdates: ringId ? ring.featureUpdates : DEFAULT_RING_FEATURE_UPDATES`), `apps/api/src/services/devicePatchApprovalView.ts:49-60` (→ `'excluded'`)
- Test: `apps/api/src/services/patchEligibility.test.ts`, `apps/api/src/services/patchJobSnapshot.test.ts`, `apps/api/src/services/devicePatchApprovalView.test.ts`

Gate (in `evaluatePatchInstallEligibility`, between category filter and app rules):
```ts
const featurePolicy = ringConfig.featureUpdates ?? DEFAULT_RING_FEATURE_UPDATES;
const featureFiltered = categoryFiltered.filter((p) => {
  if (!isWindowsFeatureUpdateCandidate(p)) return true;
  if (featureUpdateAllowed(featurePolicy, p.title)) return true;
  console.warn(`[PatchApproval] device ${deviceId}: feature update ${p.patchId} "${p.title}" blocked by ring feature-update policy (${featurePolicy.mode}${featurePolicy.mode === 'pin' ? ` ${featurePolicy.product} ${featurePolicy.targetVersion}` : ''})`);
  deny(p.patchId, 'blocked_by_feature_update_policy');
  return false;
});
```
(`title` is already selected in the rows query at :152; add it to the candidate type used by the filter if the local type lacks it.)

- [ ] Failing tests (eligibility, modelled on the `ringAppRules` cases at :207-251): block denies `"Windows 11, version 25H2"` (category feature, source microsoft) with the new reason even when manually approved; allow lets it reach the manual-approval set; pin `windows-11/25H2` allows 25H2 and denies `"Windows 11, version 26H2"`; a category-`security` "2026-10 Cumulative Update for Windows 11 Version 25H2 …" is untouched under block; config without `featureUpdates` behaves as block. Snapshot: `ringFeatureUpdates` copied from `ring.featureUpdates`. View: new reason → `excluded`.
- [ ] Run `cd apps/api && npx vitest run src/services/patchEligibility.test.ts src/services/patchJobSnapshot.test.ts src/services/devicePatchApprovalView.test.ts` → FAIL.
- [ ] Implement.
- [ ] Run → PASS; also `npx vitest run src/jobs/patchJobExecutor src/services/configPolicyPatching src/services/patchApprovalEvaluator` → PASS. Commit `feat(api): gate Windows feature updates on the ring policy`.

### Task 6: API — heartbeat pushes `feature_update_settings`

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts:3736` (add `buildFeatureUpdateConfigUpdate`), `apps/api/src/routes/agents/heartbeat.ts:2620,2630,2787,2904,2932` (type, init, build, destructure, attach as `feature_update_settings`)
- Create: `apps/api/src/routes/agents/helpers.featureUpdate.test.ts` (copy the mock scaffold from `helpers.patchSource.test.ts`)

**Interfaces (produces):**
```ts
export async function buildFeatureUpdateConfigUpdate(deviceId: string, opts?: DevicePolicySetOpts): Promise<RingFeatureUpdates>
// resolvePatchConfigPolicyForDevice → null → block; loadPolicyLocalPatchConfig(configPolicyId) → ring.valid ? ring.featureUpdates : block
```
- [ ] Failing tests: no policy → `{mode:'block'}`; policy with invalid ring → block; valid ring with pin → the pin verbatim.
- [ ] Run `cd apps/api && npx vitest run src/routes/agents/helpers.featureUpdate.test.ts` → FAIL.
- [ ] Implement; heartbeat wraps in try/catch like `patchSourceSettings` (error → omit the block, never a revert).
- [ ] Run → PASS plus `npx vitest run src/routes/agents/heartbeat.test.ts`. Commit `feat(api): push ring feature-update policy to agents`.

### Task 7: Web — ring form control, list badge, pass-through, locales

**Files:**
- Modify: `apps/web/src/components/patches/UpdateRingForm.tsx` (schema field `featureUpdates: { mode, product, targetVersion }` flat with superRefine for pin; defaults block; control in the Install enforcement zone after the grace-period field; submit maps to the API union shape), `apps/web/src/components/patches/PatchesPage.tsx:778,1170`, `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx:460,1273`, `apps/web/src/components/patches/patchHelpers.ts:224` (normalize; non-object → block), `apps/web/src/components/patches/UpdateRingList.tsx:56,105-120` (type + badge "Feature updates: pinned to 25H2 / allowed"), locale `patches.json` ×8 (`updateRingForm.featureUpdates.*`, `updateRingList.badges.featureUpdatesPinned`/`Allowed`), `devices.json` ×8 (`devicePatchStatusTab.approval.excludedFeatureUpdateTitle`), `settings.json` ×8 (`…ineligible.blocked_by_feature_update_policy`), `apps/web/src/components/devices/DevicePatchStatusTab.tsx:394-402`
- Test: `apps/web/src/components/patches/UpdateRingForm.test.tsx`

Form copy (en): title "Windows feature updates"; help "Whether devices in this ring receive Windows feature releases (for example 25H2). Approval still follows the rules above; add a Feature Updates override to install them automatically."; options "Block" / "Allow the newest release" / "Pin to a release"; fields "Windows version" (Windows 11 / Windows 10), "Release" placeholder "25H2"; validation "Enter a release like 25H2.". `data-testid`: `ring-feature-updates-mode`, `ring-feature-updates-product`, `ring-feature-updates-version`.

- [ ] Failing tests: default submit sends `featureUpdates: { mode: 'block' }`; selecting pin with product Windows 11 and `25h2` submits `{ mode:'pin', product:'windows-11', targetVersion:'25H2' }`; pin without a release shows the validation message and does not submit; editing a ring with `allow` pre-selects it.
- [ ] Run `cd apps/web && npx vitest run src/components/patches/UpdateRingForm.test.tsx` → FAIL.
- [ ] Implement; add every key to all 8 locales.
- [ ] Run → PASS plus `npx vitest run src/lib/i18n src/components/patches/UpdateRingList.test.tsx src/components/devices/DevicePatchStatusTab`. Commit `feat(web): Windows feature-update control on update rings`.

### Task 8: Docs, release-notes draft, typecheck, full targeted suites

**Files:**
- Modify: `apps/docs/src/content/docs/features/update-rings.mdx` (field-table row after `appRules`; new section "Windows Feature Updates" before "Category Rules"), `apps/docs/src/content/docs/features/patch-management.mdx:26`, `docs/release-notes/next-release-draft.md` (Self-Hosting notes: new column, agent default change for `patch_exclude_feature_updates`, new heartbeat block, registry policy written in pin mode)

- [ ] Write the docs: what each mode does, that pin writes the WUfB target-release policy on the device, that block is the default, how to auto-approve (feature category override, unrated note).
- [ ] Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --build tsconfig.tests.json` (check exit code, never pipe to `tail`), `cd apps/web && npx tsc --noEmit`, `cd packages/shared && npx tsc --noEmit`.
- [ ] Suites: `cd agent && go test -race ./...`; `cd apps/api && npx vitest run src/routes/updateRings src/services/patch src/routes/agents/helpers src/services/aiTool src/services/mcpCoverage`; `cd apps/web && npx vitest run src/components/patches src/lib/i18n`; `cd packages/shared && npx vitest run`.
- [ ] Commit `docs: Windows feature-update control on update rings`; open the PR (template: settings rule 9 statement from the Design section; Merge Danger note: agent default change + registry writes in pin mode).
