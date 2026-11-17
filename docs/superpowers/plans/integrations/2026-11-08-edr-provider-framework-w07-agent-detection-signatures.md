---
tracking_issue: LanternOps/breeze#8164
wave_issue: LanternOps/breeze#8171
---
# EDR W07 — Agent detection signatures (residual after #7634) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows device protected by Trend Micro reports provider `trend_micro` ("Trend Micro") in its security status, posture and compliance reports instead of `other`, and the agent's management-tool detection lists Trend Micro under endpoint security; Huntress stays out of the AV-provider list on purpose.

**Architecture:** Two agent tables and five API lists, exactly the shape #9389 (Cylance) used. Agent: one `providerFromName` case (Windows Security Center display name → provider key) and one `mgmtdetect` signature (service / process / install path). API: one `ALTER TYPE security_provider ADD VALUE` migration, the Drizzle enum, the ingest value list, `normalizeProvider`, the dashboard `providerCatalog`, the report `PROVIDER_NAMES`. An existing contract test (`helpers.provider.test.ts:73-93`) already fails if any of the five API lists disagree, so the API half is test-guarded by construction.

**Tech Stack:** Go (agent, `go test -race`), Hono/TypeScript (API), one hand-written SQL migration, Vitest.

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md` §4.14. **Read the index first** (`2026-10-01-edr-provider-framework-index.md`: correction 10, the W07 section, "Needs Todd's decision" 1). Template PR: #9389 (Cylance, #9178) — same file set. Written against `origin/main` at `3444fa405d` (2026-11-08).

Epic: #8164 · Wave sub-issue: #8171 · Absorbed: #7551 (closed by #7634). One PR. Branch `feature/8164-edr-provider-framework/wave-8171` from `main`. PR body: `Closes #8171`, `Part of #8164`. Never write a closing keyword for #8164, #7551 or #9178. W07 is independent of every API wave (W05 can run in parallel; the two are file-disjoint except that both add a migration — see Global Constraints).

## What #7634 and later PRs already delivered (verified at `3444fa405d`)

| Item | Where | State |
|---|---|---|
| `providerFromName` | `agent/internal/security/status.go:117-163` | elastic → bitdefender → emsisoft → webroot → cylance → withsecure/f-secure → threatdown → **defender** → sophos → sentinel → crowdstrike → malwarebytes → `containsWord("eset")` → kaspersky → `other`. No Trend Micro, no Huntress. |
| `providerFromName` table test | `agent/internal/security/status_provider_test.go` (`TestProviderFromName`) | Locks elastic/bitdefender/vendor/cylance-before-defender. |
| `mgmtdetect` endpoint-security block | `agent/internal/mgmtdetect/signatures.go:414-591` ("13 tools") | CrowdStrike, SentinelOne, Sophos, Bitdefender, Malwarebytes, ThreatDown, ESET, Emsisoft, Webroot, WithSecure, Carbon Black, Huntress (`:567`), Defender. **No Trend Micro. No Cylance.** |
| `mgmtdetect` probe-lock test | `agent/internal/mgmtdetect/signatures_test.go:66` (`TestEndpointSecuritySignatures_AVProviders`) | Exact probe list per #7551 product; also `TestSignaturesAvoidGenericProcessNames`. |
| `security_provider` enum | `apps/api/src/db/schema/security.ts:20`; migrations `2026-11-12-120000-…emsisoft-webroot-withsecure.sql`, `2027-01-02-120300-security-provider-cylance.sql` | Values end `… withsecure, cylance, other, unknown, breeze`. |
| API lists | `routes/agents/schemas.ts:850-866` (`securityProviderValues`), `routes/agents/helpers.ts:245-297` (`normalizeProvider`, unknown → `other`), `routes/security/schemas.ts:5-25` (`providerCatalog`), `services/securityComplianceReportProducts.ts:13-27` (`PROVIDER_NAMES`) | Guarded by `helpers.provider.test.ts:73-93`: `securityProviderValues` **equals the DB enum in order** (minus `breeze`), every value is in the catalog, normalizes to itself and has a report label. |
| Ingest | `routes/agents/schemas.ts:~870` `provider: z.string().optional()`; `helpers.ts:557` `normalizeProvider(...)` | Free string; an unknown value is stored as `other`, never rejected. |
| Docs table | `apps/docs/src/content/docs/features/security.mdx:79-101` | Lists every provider id. |

So the residual is **Trend Micro** (both agent tables + the API enum chain) and the **Huntress decision**. §4.14's ESET / Emsisoft / Webroot / ThreatDown / WithSecure items are done.

## Spec corrections (found while planning)

1. **§4.14 lists `huntress` for `providerFromName`; the index's Decision 1 recommends against it** (Huntress Managed AV manages Microsoft Defender rather than registering its own product in Windows Security Center, so a `huntress` provider would relabel Defender-protected devices). This plan implements the recommendation and pins it with a test (Task 2). If Todd overrides, Task 2's pin flips and the enum chain gains `huntress` exactly like `trend_micro`.
2. **A Cylance `mgmtdetect` signature is missing** (#9389 added only the provider). Not in §4.14; see Open Decision 2 — out of scope by default.
3. **Carbon Black has an `mgmtdetect` signature but no provider value** — devices with Carbon Black Cloud report `other`. Not in §4.14; Open Decision 3.
4. **Migration naming.** The index's `2026-11-12-…` naming is long behind HEAD; the newest committed migration is `2027-01-22-210300-device-watchdog-edition.sql`.

## Global Constraints

- **Order is a contract.** Postgres keeps enum order, and `helpers.provider.test.ts` asserts `securityProviderValues` equals the Drizzle enum **in order**. `trend_micro` goes **after `cylance`, before `other`** in the migration (`BEFORE 'other'`), the Drizzle `pgEnum` array and `securityProviderValues`.
- **One migration, its own file** (a value added by `ALTER TYPE … ADD VALUE` cannot be used in the same transaction): `apps/api/migrations/2027-01-22-231000-security-provider-trend-micro.sql`, body `ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'trend_micro' BEFORE 'other';` plus the Cylance-style header comment. No inner `BEGIN/COMMIT`; it writes no rows, so no `set_config('breeze.scope', …)`. Task 0 re-checks the slot: it must sort after the newest committed migration **and** after any open PR's (at plan time #10918 holds `2027-01-22-220000…220300`, #11295 `2027-01-22-210100`; W05 plans `2027-01-23-110000`). If a newer migration merges while this PR is queued, **rename this file before merge** (a merged newer migration poisons the merge queue's Check Migrations).
- **Detection signals are vendor facts marked [U] until the lab sees them.** Nothing generic: no `svchost`-class process names (`TestSignaturesAvoidGenericProcessNames`). No macOS probe for Trend Micro until a lab Mac proves one (WithSecure precedent, `signatures.go:539-543`).
- **No fixture or PR text carries a real hostname, user name, serial or console tenant.** WSC display names are vendor product strings and are fine.
- **Agent-shipped code.** Merging does not reach devices; an agent release does. The API half is safe in any order (free-string ingest; unknown → `other`), but **deploy the API first** so the first agent reports land on a known value.
- **Tests:** Go `cd agent && go test -race ./internal/security/... ./internal/mgmtdetect/...` and `go vet ./internal/security/... ./internal/mgmtdetect/...` (CI also runs golangci-lint — run `make lint` if the target exists). API `cd apps/api && npx vitest run <files>` (no `--` before flags; never `pnpm --filter … test -- --run`). API typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?` — read the exit code, never pipe to `tail`.

## Migration & tenancy statement

One migration (above). No table, column or RLS change; `security_provider` is a type used by `security_status.provider`, which keeps its policies. Registration lists (`docs/agents/tenancy-rls.md`): `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`, device/ticket lists — **no change** (no new table or column). Then `pnpm db:check-drift`. Enum additions are one-way (Postgres cannot drop a value): the PR body says so, and the release pass records `security_provider + trend_micro` under "One-way enum additions" in `apps/docs/src/content/docs/deploy/upgrades.mdx` — **do not** edit `docs/release-notes/next-release-draft.md` in this PR (merge-queue hot spot).

## AI tool exposure & settings

No AI tool, registry entry or schema change (AI tools read the provider as a string). No setting (settings rule 9: none; places configured n/a).

## Review Focus

1. **A device with Trend Micro *and* Microsoft Defender registered in WSC** (Defender passive). Expected: the primary provider follows the existing WSC primary-resolution rule (`status_attribution_test.go` `TestResolveWSCPrimary` / `TestDefenderOwnsProvider`), and Trend Micro is never misread as Defender. Pinned in Task 2 (a "Trend Micro … Defender"-style name row) and the lab leg L4.
2. **An old agent reporting before the API knows `trend_micro`, or the reverse.** Expected: an unknown ingest string is stored as `other` (no 400); a known value renders "Trend Micro" in the dashboard, posture and compliance reports. Pinned by the existing sync test plus Task 1's `normalizeProvider` rows.
3. **Product names that contain "trend" but are not Trend Micro** ("Trendy…", "Market Trends Agent"). Expected: `other`. Pinned in Task 2 (match requires `trend micro` or `trendmicro`).
4. **Trend Micro installed but its services stopped** (tamper, uninstall in progress). Expected: `mgmtdetect` follows its existing first-active-check semantics (`TestSignatureChecksHaveFirstActiveCheck`); the provider still comes from WSC. No new semantics.
5. **A Huntress-managed device.** Expected: provider is whatever WSC reports (Defender → `windows_defender`); `mgmtdetect` still lists Huntress. Pinned in Task 2.

---

## File Structure

| File | Change |
|---|---|
| `apps/api/migrations/2027-01-22-231000-security-provider-trend-micro.sql` | Create |
| `apps/api/src/db/schema/security.ts` | `'trend_micro'` after `'cylance'` |
| `apps/api/src/routes/agents/schemas.ts` | `securityProviderValues` += `'trend_micro'` (same position) |
| `apps/api/src/routes/agents/helpers.ts` | `normalizeProvider` cases `trend_micro`, `trendmicro`, `trend-micro` → `trend_micro` |
| `apps/api/src/routes/security/schemas.ts` | `providerCatalog.trend_micro = { id: 'trend_micro', name: 'Trend Micro', vendor: 'Trend Micro' }` |
| `apps/api/src/services/securityComplianceReportProducts.ts` | `PROVIDER_NAMES.trend_micro = 'Trend Micro'` (not in `EDR_PROVIDERS`) |
| `apps/api/src/routes/agents/helpers.provider.test.ts` | New rows |
| `agent/internal/security/status.go` (+ `status_provider_test.go`) | `providerFromName` Trend Micro case; Huntress pin |
| `agent/internal/mgmtdetect/signatures.go` (+ `signatures_test.go`) | Trend Micro signature; header count 13 → 14 |
| `apps/docs/src/content/docs/features/security.mdx` | Provider table row + sentence |

## Execution split and parallelism

- **PARALLEL GROUP A** (file-disjoint): **Task 1** (API, `apps/**`) ∥ **Task 2** (`agent/internal/security/**`) ∥ **Task 3** (`agent/internal/mgmtdetect/**`). Seam: the string `trend_micro` (agent emits, API accepts) — fixed here, nothing else shared.
- Then **Task 4** (verification), **Task 5** (owner lab gate — narrows Task 3's probes), **Task 6** (PR).
- **Sonnet-eligible:** Tasks 1, 2, 3 (mechanical, contract fully specified; Opus reviews the migration order and the signature probes). Task 5 is an operator session.

### Task 0: Preflight

- [ ] `git fetch origin && git rebase origin/main`; `gh issue view 8171` open; `gh pr list --state open --json number,files` shows no PR touching `status.go`, `signatures.go`, `security.ts` (schema) or a `security-provider` migration.
- [ ] Re-check the migration slot (Global Constraints); rename the planned file if needed.
- [ ] `get_feature_status` (#8164) → `start_wave` for #8171; branch `feature/8164-edr-provider-framework/wave-8171`.
- [ ] Confirm a Trend Micro business trial is available for the lab (Credentials below); if not, Tasks 1–4 can still land as a PR but it is **held** until Task 5.

### Task 1: API — `trend_micro` through the enum chain (Sonnet-eligible)

**Files:** the five API files + migration + `helpers.provider.test.ts` + docs table.

**Interfaces — Produces:** `SecurityProviderValue` gains `'trend_micro'`; `prettySecurityProvider('trend_micro') === 'Trend Micro'`.

- [ ] **Step 1: failing tests** in `helpers.provider.test.ts`: add `['trend_micro', 'trend_micro'], ['trendmicro', 'trend_micro'], ['Trend-Micro', 'trend_micro'], ['TREND_MICRO', 'trend_micro']` to the `normalizeProvider` table; extend the `arrayContaining` at `:92` with `'trend_micro'`; new case `expect(providerCatalog.trend_micro).toEqual({ id: 'trend_micro', name: 'Trend Micro', vendor: 'Trend Micro' })` and `expect(prettySecurityProvider('trend_micro')).toBe('Trend Micro')`.
- [ ] **Step 2:** run `cd apps/api && npx vitest run src/routes/agents/helpers.provider.test.ts` → FAIL (`normalizeProvider('trend_micro')` is `other`).
- [ ] **Step 3:** migration (Global Constraints text) + the five list edits in enum order + docs table row `| \`trend_micro\` | Trend Micro | Trend Micro |` and the sentence "Trend Micro Apex One, Worry-Free and Vision One endpoint agents report as `trend_micro`." (adjust product names to what the lab observes in Task 5).
- [ ] **Step 4:** the test → PASS; also `src/routes/agents/helpers.securityStatus.test.ts` and `src/services/securityComplianceReport*.test.ts` → PASS; typecheck exit 0; `pnpm db:check-drift` clean on a test stack (`pnpm test-stack up` → migrate → check → `pnpm test-stack down`); `npx vitest run src/__tests__/migrationRlsScope.test.ts` (or its current path — `rg -l migrationRlsScope apps/api/src`) → PASS.
- [ ] **Step 5:** commit `fix(api): recognise trend_micro as a security provider (#8171)`.

### Task 2: Agent — `providerFromName` Trend Micro + Huntress pin (Sonnet-eligible)

**Files:** `agent/internal/security/status.go`, `status_provider_test.go`.

- [ ] **Step 1: failing table rows** in `TestProviderFromName` (`{name, display, expected}`):
  `{"trend apex one", "Trend Micro Apex One Security Agent", "trend_micro"}`, `{"trend security agent", "Trend Micro Security Agent", "trend_micro"}`, `{"trend officescan", "Trend Micro OfficeScan Client", "trend_micro"}`, `{"trend worry-free", "Trend Micro Worry-Free Business Security Agent", "trend_micro"}`, `{"trend no space", "TrendMicro Endpoint Sensor", "trend_micro"}`, `{"trend vs defender", "Trend Micro Defender Suite", "trend_micro"}` (locks trend-before-defender), `{"not trend", "Market Trends Agent", "other"}`, and the Huntress pin `{"huntress is not a WSC provider", "Huntress Managed AV", "other"}` with a comment citing index Decision 1 / this plan's correction 1. The WSC strings are **[U]**; Task 5 adds the exact observed string as a row.
- [ ] **Step 2:** `cd agent && go test -race ./internal/security/ -run TestProviderFromName` → FAIL on the Trend rows.
- [ ] **Step 3:** add `case strings.Contains(lower, "trend micro"), strings.Contains(lower, "trendmicro"): return "trend_micro"` inside the "vendor-name matches with no overlap" block (after `webroot`, before `cylance`), with a one-line comment (`#8171`). No Huntress case.
- [ ] **Step 4:** PASS; full `go test -race ./internal/security/...` and `go vet` clean. Commit `fix(agent): map Trend Micro WSC names to trend_micro; pin Huntress out (#8171)`.

### Task 3: Agent — Trend Micro `mgmtdetect` signature (Sonnet-eligible; probes [U])

**Files:** `agent/internal/mgmtdetect/signatures.go`, `signatures_test.go`.

**Vendor facts [U] — settled by Task 5:** Apex One / OfficeScan agent: service `ntrtscan`, process `PccNTMon.exe`, install dir `C:\Program Files (x86)\Trend Micro\Security Agent`; Worry-Free Business Security agent: `C:\Program Files (x86)\Trend Micro\Client Server Security Agent`; Vision One Endpoint Security (Basecamp): `C:\Program Files\Trend Micro\Endpoint Basecamp`. Exact service and process names vary by product generation; the lab keeps only probes it observed.

- [ ] **Step 1: failing test row** in `TestEndpointSecuritySignatures_AVProviders`:

```go
{
	name: "Trend Micro",
	os:   []string{"windows"},
	probes: []Check{
		{Type: CheckServiceRunning, Value: "ntrtscan", OS: "windows"},
		{Type: CheckProcessRunning, Value: "PccNTMon.exe", OS: "windows"},
		{Type: CheckFileExists, Value: `C:\Program Files (x86)\Trend Micro\Security Agent`, OS: "windows"},
		{Type: CheckFileExists, Value: `C:\Program Files (x86)\Trend Micro\Client Server Security Agent`, OS: "windows"},
		{Type: CheckFileExists, Value: `C:\Program Files\Trend Micro\Endpoint Basecamp`, OS: "windows"},
	},
},
```
- [ ] **Step 2:** `go test -race ./internal/mgmtdetect/ -run TestEndpointSecuritySignatures_AVProviders` → FAIL (signature missing).
- [ ] **Step 3:** add the signature after "WithSecure Elements" (`Category: CategoryEndpointSecurity`, Windows only, comment "Trend Micro Apex One / Worry-Free / Vision One endpoint agents (#8171); macOS omitted until verified on a lab host"); update the block header count `(13 tools)` → `(14 tools)`.
- [ ] **Step 4:** PASS, plus `TestSignaturesAvoidGenericProcessNames`, `TestSignatureChecksHaveFirstActiveCheck`, the duplicate-name guard; `go vet` clean. Commit `fix(agent): detect Trend Micro endpoint agents in mgmtdetect (#8171)`.

### Task 4: Verification gate

- [ ] `cd agent && go test -race ./internal/security/... ./internal/mgmtdetect/...` → PASS; `go vet` clean; golangci-lint (`make lint` or the CI command in `.github/workflows/ci.yml`'s Go lint job) clean.
- [ ] `cd apps/api && npx vitest run src/routes/agents/helpers.provider.test.ts src/routes/agents/helpers.securityStatus.test.ts` and the compliance-report suites → PASS; API typecheck exit 0; `pnpm db:check-drift` clean.
- [ ] Review (cap: one round, Sonnet): enum order identical in migration / Drizzle / `securityProviderValues`; no generic probe; Huntress pin present; no macOS Trend probe.

### Task 5: Owner lab gate (blocks merge) — Todd + an Opus session

Windows lab VM on the lab Hyper-V host (never a host with an installed Breeze agent), enrolled in a lab stack running this branch (`worktree-stack` skill; `make dev-push` for the agent build; tear the stack down after).

- [ ] **L1 WSC name.** Install the Trend Micro trial agent. Run `Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select displayName, productState` and record the exact `displayName`(s). Add each as a `TestProviderFromName` row.
- [ ] **L2 Provider.** After the next security-status report the device shows provider `trend_micro`, label "Trend Micro" in device security, the security dashboard provider breakdown and the compliance report.
- [ ] **L3 mgmtdetect.** The device's management-tool inventory lists "Trend Micro" under endpoint security. Record which probes matched (`Get-Service`, `Get-Process`, `Test-Path` for each); **drop probes that matched nothing** from Task 3's signature and its test row, and fix any name that differs.
- [ ] **L4 Coexistence.** With Defender passive, the primary provider is `trend_micro`; on a Defender-only VM (or after uninstalling Trend) it is `windows_defender` again.
- [ ] **Stop rule:** if Trend registers in WSC under a name the match misses, or the provider needs a new attribution rule (e.g. WSC primary logic), stop, record the finding on #8171 and amend this plan before merging.

### Task 6: PR

- [ ] Title `fix(agent,api): recognise Trend Micro as an AV provider (#8171)`. Body: `Closes #8171`, `Part of #8164`; migration name + "one-way enum addition"; "agent-shipped: reaches devices with the next agent release; deploy API first"; Huntress decision as implemented; lab leg table (L1–L4, PASS/FAIL, observed WSC names); tests run with output counts; settings rule 9: none. `complete_wave` after merge.

---

## Credentials and lab needs

- **A Trend Micro business trial** whose Windows agent can be installed on the lab VM: Vision One Endpoint Security (Standard Endpoint Protection), Apex One SaaS, or Worry-Free Business Security Services — whichever Todd can obtain. Trial console credentials stay in the private lab notes; nothing from the console (tenant name, agent ids, hostnames) goes into code, fixtures or the PR.
- The Windows lab VM (or a fresh nested VM) — never the host with an installed agent.

## CI traps

- `helpers.provider.test.ts` compares the enum **in order** — an `ADD VALUE` without `BEFORE 'other'`, or a Drizzle array in a different order, fails Test API.
- **Check Migrations** fails if a newer migration lands first — rename before merge (memory: parallel migration PRs).
- Go lint runs on `agent/**`; `signatures_test.go` locks exact probe lists, so Task 5's narrowing must update the test in the same commit.
- An agent-only change in a PR still runs `test-agent`; the API half runs `test-api`. No Integration-shard suite is affected (no table/column).

## Open Decisions (Gate — Todd)

1. **Huntress in `providerFromName`.** (a) Leave it out and pin it out (Task 2) — Huntress Managed AV manages Defender, which already reports as `windows_defender`; `mgmtdetect` keeps the Huntress signature for posture/coverage. (b) Add `huntress` to the enum chain and `providerFromName`. **Recommend (a)** (index Decision 1); revisit only if a lab box shows Huntress registering its own WSC product.
2. **Cylance `mgmtdetect` signature** (provider exists since #9389, signature does not). (a) Out of W07 — no lab host has Cylance, and an unverified signature is the failure mode #7634's review flagged; file a follow-up issue. (b) Add it [U] in W07. **Recommend (a).**
3. **Carbon Black provider value** (signature exists, provider does not; devices report `other`). (a) Out of W07, follow-up issue. (b) Add `carbon_black` here. **Recommend (a)** — §4.14 does not list it and there is no lab host.
4. **Trend Micro macOS.** (a) Windows only now (agent macOS AV attribution covers only Cylance and Defender, `status_mac_cylance.go`). (b) Add macOS detection. **Recommend (a).**

## Self-review notes (for executors)

- **Spec coverage (§4.14):** ESET/Emsisoft/Webroot/ThreatDown/WithSecure — done by #7634 (table above); Trend Micro signature (Task 3), `providerFromName` `trend_micro` (Task 2), enum migration in its own file (Task 1); `huntress` — decided out (correction 1, Task 2 pin); order-sensitive table tests (Task 2).
- **Names used once and consistently:** `trend_micro`, label `Trend Micro`, vendor `Trend Micro`, migration `2027-01-22-231000-security-provider-trend-micro.sql` (subject to Task 0).
- **Not in scope:** Cylance/Carbon Black (Decisions 2–3), macOS (Decision 4), any EDR-framework adapter for Trend Micro (roadmap only), agent release mechanics.

## Execution handoff

Plan saved to `docs/superpowers/plans/integrations/2026-11-08-edr-provider-framework-w07-agent-detection-signatures.md`. Recommended execution: **Native** (one session implements Tasks 1–4; three small file-disjoint tasks with fully specified strings, low blast radius), then the Task 5 lab session with Todd.
