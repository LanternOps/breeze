---
spec: docs/superpowers/specs/vuln-patch/2026-10-31-oem-vendor-updates-design.md
spec_approved: 2026-11-04
baseline_commit: 36f9d9ca53
anchor_issue: 3855
related: [3855, 4226, 5511, 5512, 6960]
tracking_issue: LanternOps/breeze#11065 (W01 #11066, W02 #11067, W03 #11068, W04 #11069, W05 #11070, W06 #11071, W07 #11072, W08 #11073, W09 #11074, W10 #11075, W11 #11076, W12 #11077, W13 #11078, W14 #11079, W15 #11080, W16 #11081, W17 #11082)
---

# Vendor Updates (Dell, Surface, HP, Lenovo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A config policy keeps each hardware vendor's own update path running monthly with an overnight reboot, a tech can trigger it remotely with one click, and a machine that has stopped updating is visible.

**Architecture:** A new `oem_update_run` agent command runs one vendor "lane" per device: verify or fetch the vendor's tool, run it, report a normalized outcome. The API decides when and with what categories through one dispatch seam, stores one status row per device, and hands reboots to the existing `schedule_reboot` path. Everything ships dark: an env flag plus per-lane and per-category gates in a code manifest, all closed until that vendor's lab wave opens them.

**Tech Stack:** Go agent (`agent/internal/oemupdates`, `flashguard`, `authenticode`), Hono + Drizzle + BullMQ (`apps/api/src/services/oemUpdates`), hand-written SQL migrations, Zod (`packages/shared`), Astro + React (`apps/web`), Vitest, `go test -race`.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-10-31-oem-vendor-updates-design.md`. Its header still reads `status: draft-for-approval`; the owner approved it as written on 2026-11-04, with all recommendations as recommended. Spec sections are cited as §N.

**Queueing:** per the owner's standing rule (spec §6), this starts after registered features with waves already in flight.

## Waves

| Wave | Title | Migration | Tier | Merged first |
|---|---|---|---|---|
| W01 | Agent safety core: contract, publisher pin, flash guard, availability gate | no | Opus | none |
| W02 | Agent `oem_update_run`, runner, Dell lane on fakes | no | Opus | W01 |
| W03 | API core: status table, command registration, gated dispatch seam, result handling, not-returned monitor | **yes** (2) | Opus | W01 |
| W04 | Run Now: route, dialog, device section, history | no | Opus, locale fan-out Sonnet | W02, W03 |
| W05 | `oem_updates` config-policy feature: arming, resolver, tab | **yes** | Opus, locale fan-out Sonnet | W03 |
| W06 | Overnight reboot mode and schedule takeover/release primitives | no | Opus | W02, W03 |
| W07 | Scheduler worker: occurrences, catch-up, reboot holds, release sweep | no | Opus | W05, W06 |
| W08 | One owner per update class: Breeze patch-job exclusions | **yes** | Opus | W07 |
| W09 | Fleet view, overdue alerts, docs | no | Opus route, Sonnet docs and locales | W07 |
| W10 | **Dell lab wave** (owner): fixtures, verdicts, Dell gates open, canary | no | Owner + Opus | W04, W07, W08, W09 |
| W11 | Surface lane on fakes, shared BitLocker guard | no | Opus | W02, W03 |
| W12 | **Surface lab wave** (owner) | no | Owner + Opus | W11 |
| W13 | HP lane on fakes | no | Opus | W02, W03, W11 |
| W14 | **HP lab wave** (owner) | no | Owner + Opus | W13 |
| W15 | **Lenovo spike** (owner, hardware): choose the tool, no lane code. Needs Decision 3 | no | Owner + Opus | none |
| W16 | Lenovo lane on fakes | no | Opus | W15, W11 |
| W17 | **Lenovo lab wave** (owner) | no | Owner + Opus | W16 |

**Value checkpoints:** W04 plus W10 is the troubleshooting win. W07 plus W10 is the prevention win for Dell. W11–W17 can be sequenced independently after W03, W02 and W05.

## Execution split and parallelism

Every wave branches from fresh `origin/main` as `feature/<parent#>-oem-vendor-updates/wave-<subissue#>` and targets `main`. Never stack: a stacked PR runs no CI, and a green-looking `gh pr checks` there means only the smoke workflows ran. "Merged first" above means wait for the merge, then rebase on `main`.

Within a wave, PARALLEL GROUPS are file-disjoint and may run as concurrent subagents in one worktree. Concurrent subagents never run `git commit`; the fixer commits once per group after all members pass. Groups run in the listed order. Each wave lists its own groups, API/web seam and Sonnet-eligible tasks.

| Parallel at the wave level | Why it is safe |
|---|---|
| W02 ∥ W03 | Agent versus API. Contract is frozen in W01 |
| W04 ∥ W05 ∥ W06 | Disjoint except locale JSON, which merges by key. W06 needs W02 and W03 only |
| W08 ∥ W09 | Disjoint except locale JSON |
| Surface, HP, Lenovo tracks | Each owns one lane file. HP and Lenovo need W11's BitLocker guard |

## Trust boundary

- **Vendor binaries are never bundled, mirrored or hosted by Breeze.** The agent runs what is installed, or fetches the vendor's own installer from the vendor's own host. Redistribution rights are unconfirmed for every vendor (§2).
- **What the API can tell the agent:** lane, categories, blocked IDs, deadline, and for a tool: version, URL, SHA-256, prerequisites. The command payload is never trusted to widen anything.
- **What the agent decides alone:** a per-lane compiled allowlist of Authenticode publishers and download hosts (`agent/internal/oemupdates/allowlist.json`, embedded). A payload URL off that list, or a redirect hop off that list, is refused. A signature whose publisher is not on the list is refused. The API cannot make the agent fetch or run anything else, even with a compromised manifest.
- **When verification runs:** publisher and chain immediately before every execution of a vendor binary, never from a cache. SHA-256 and publisher on every download, then version and publisher again after install.
- **What runs as SYSTEM:** the vendor tool, and only the path just verified. It runs from `Program Files` (DCU) or an agent-owned `securefs` directory. Reports, logs and downloads live only in an agent-owned directory that standard users cannot write (`agent/internal/securefs`).
- **What Breeze does not trust:** vendor tool output. It is parsed as untrusted text, capped at 200 items with bounded strings, and raw logs are not uploaded.
- **What stays outside:** the vendor's update catalog and the content it installs. Breeze trusts the vendor's signed tool to choose and validate its own payloads; the stops in §4.8 are the mitigation.

## Config-policy decision: Pattern B, inline settings

`oem_updates` is **Pattern B (inline settings on the feature link)**. `featurePolicyId` stays NULL. Per the checklist in the `configuration-policy` skill: nobody asks "which devices violate this policy" as a compliance question (§2 rules out a compliance score); the settings are not shared independently across policies; there is no standalone management page; it is schedule and toggle settings. No normalized child table: the settings are read whole by one resolver.

**Partner-wide:** this adds no config table, so the `org_id XOR partner_id` shape does not apply. The link inherits the policy's ownership, and `oem_updates` must stay out of `ORG_SCOPED_ONLY_FEATURE_TYPES`. W07 proves fan-out by the device org's partner against real Postgres. `device_oem_update_status` is device state, not config, so `org_id NOT NULL` is correct (§4.7).

**Settings rule 9 (every W05 PR body states this):** Home: the config policy's Vendor updates tab. Levels: partner-wide, overridden by org. Resolver: `resolveOemUpdatesLinkForDevice`. Places configured: 0 before, 1 after.

## Availability gate per tool

Pattern: `agent/internal/collectors/probe_availability.go` (#10997). A 24 h cached answer, one check under a lock, quiet when absent, never WARN per tick. One gate per tool:

| Tool | Gate reads (no process spawn) | Absent means |
|---|---|---|
| DCU | `dcu-cli.exe` under both Program Files paths, PE file version | `tool_unavailable` only if no manifest tool can be fetched |
| Surface (no tool) | SMBIOS manufacturer, Windows Update service state | `not_supported` |
| HPIA | `HPImageAssistant.exe` in the agent-owned tool directory, PE version | fetch, else `tool_unavailable` |
| HP CMSL | `HPCMSL` module directory under `Program Files\WindowsPowerShell\Modules` | HP BIOS category skipped (#5511 W04 owns install) |
| Lenovo | decided by W15 | decided by W15 |

Rules: the gate answers "present, where, which version". It is **not** the security check, which always runs fresh (Trust boundary). A negative answer is cached too. Installing a tool, or a failed fresh verification, invalidates the gate. A state change logs once at DEBUG. There is no periodic collector in v1: `oem_update_run` is the only caller, and any later collector must go through the gate.

## Activation model

Four independent locks, all closed by default. All must be open to reach a device:

1. **`BREEZE_OEM_UPDATES_ENABLED`** (default off), plus optional `BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST`. Route and scheduler check it. Mapped in the compose templates.
2. **Manifest gates** (`services/oemUpdates/toolManifest.ts`): one `laneGate` and one per-category gate per lane, in code. Only a lab wave opens them. A contract test refuses an open gate without a real SHA-256 and an allowlisted URL.
3. **Kill switches:** `BREEZE_OEM_UPDATES_DISABLED_LANES` (env, no deploy) and a code-level block in the manifest. Both stop new dispatch and cancel unclaimed commands. Neither ever interrupts a run in flight (§4.5).
4. **Minimum agent version:** `agentSupportsOemUpdates`, fail closed.

**Lab override:** `BREEZE_OEM_UPDATES_LAB_DEVICE_IDS` opens closed gates only for the listed device IDs, and `config/validate.ts` refuses to boot if it is set under `NODE_ENV=production`.

**What merging dark does not cover:** W01 changes shared reboot and upgrade code paths that run on every agent as soon as it ships. Those paths must behave identically when no flash section exists. See Decision 1.

## Global Constraints

- Windows only in v1. No servers, VMs, macOS or Linux. No BIOS passwords. No per-update approval. No scan-only mode (§2).
- Schedule defaults: third Wednesday, 01:00, 4-hour window, 7 catch-up nights, overnight reboot, 3 attempts per occurrence, about 10-minute tick (§4.1, §4.2).
- Schedule field ranges: `weekOfMonth` first|second|third|fourth|last; `dayOfWeek` sun..sat; `windowHours` 1-8; `catchUpNights` 0-14; `reboot` overnight|never.
- A scheduled run never starts outside its window. No wake timers. No daytime installs (§8).
- BIOS and firmware require: a reboot Breeze controls, AC power, battery at or above 25%, a current escrowed recovery key when BitLocker is on, and the flash guard (§4.5).
- Overnight reboot: starts inside the window, grace default 15 minutes, held and retried nightly, **Reboot overdue** after 3 nights, never forced (§4.5). "No reboot is ever silent" stays true.
- Outcomes are exactly: `success`, `success_reboot_required`, `no_updates`, `partial`, `failed`, `not_supported`, `tool_unavailable`, `blocked_on_battery`, `blocked_reboot_pending`, `blocked_no_recovery_key`, `retry_later`, `interrupted`.
- Item list capped at 200 with bounded strings. Raw logs not uploaded (§4.4).
- Dell: floor 5.7.1, pinned 5.7.2 at research time. Never from winget (5.7.0). .NET Desktop Runtime at or above 10.0.8. HP: HPIA floor 5.3.3. Re-check versions at the lab wave.
- Every background dispatch passes `expectedOrgId`. Ephemeral and parked devices are excluded everywhere, not only in the worker.
- Fixtures committed to this public repo carry no hostnames, serials, usernames, service tags or customer data. Scrub them before commit.
- **Migrations:** the newest file on `origin/main` at write time is `2027-01-20-120000-m365-mailbox-connect-baseline.sql`, and open PRs hold 130000, 140000 and 160000. The slots proposed here are `2027-01-21-1X0000-…`. **Re-check at branch time and rename to sort after the newest committed file**; the pre-push hook enforces it. Idempotent, no inner `BEGIN`/`COMMIT`, then `pnpm db:check-drift`.
- **Registration lists for any `org_id` table:** `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`, plus the device lists it qualifies for. No ticket lists apply here. Grep, do not judge.
- **CI:** `pnpm test` does not run the RLS or integration contract suites. Org-cascade and export-policy failures appear only under Integration Tests. Run them before the PR for W03 and W08 (`pnpm test-stack up`, then down). Scoped runs: `cd apps/api && npx vitest run <path>`, never `pnpm --filter … test -- --run`.
- **New API service files** must be classified in `parkedFanout.contract.test.ts` (`__tests__/parkedFanoutModules.ts`). New workers register in `workerRegistry.ts`, `workerReadinessManifest.ts` and `workerEntrypointClosure.contract.test.ts`.
- **New `en` keys** land in all 8 locales. Web mutations use `runAction`. `data-testid` on every new interactive element.
- **AI:** v1 adds no AI tool. W05 only extends `manage_policy_feature_link`'s description and refuses arming. W05 measures the tool index with `cd apps/api && npx vitest run src/services/aiToolIndex.test.ts src/services/aiToolIndex.w15-budget.test.ts`. If a ceiling in force is exceeded, raise it by exactly **+128 B** in its own commit, state the bytes in the PR body, and stop and ask if that does not fit or would pass 7680 B.
- Agent changes: `cd agent && go test -race ./...`, and `GOOS=windows go vet` on touched packages, because lane logic is cross-platform but adapters are Windows-only.
- No customer names, hosts, IPs, production numbers or security-gap tables in any plan, PR or fixture: this repo is public.

## Review Focus

Failure modes the spec implies but does not spell out, each with a test in its owning task:

1. **Manufacturer near-misses authorize a flash.** `HPE`, `Hewlett Packard Enterprise`, `Dell EMC`-style strings, `Microsoft Corporation` on a Hyper-V guest or a non-Surface Microsoft model, `LENOVO` casing, empty or null. Expect exact or anchored matching and `not_applicable` on anything else (W03 T4).
2. **Desktop with no battery fails the battery floor.** `BatteryFlag=128` and `BatteryLifePercent=255` must pass; on AC at 10% must block; unknown AC line must block (W02 T3).
3. **Calendar edges.** A window start inside the spring-forward gap, `last` weekday in a short month, and a catch-up night that crosses into the next month must keep the previous occurrence key and never double-run (W07 T1).
4. **Device clock is wrong.** A fast clock refuses with `retry_later`, the safe direction. A slow clock must not let a run start during the working day, so `deliver_by` on the row stops delivery server-side (W02 T4, W03 T5).
5. **A hung vendor tool.** At the agent's deadline, a driver-only run is killed and reports `failed`. While the flash guard is held the agent must **not** kill the process; it reports `interrupted` once it can (W02 T4).

## Decisions surfaced while planning

Quorum: my position plus an independent `gpt-6-astra` opinion at `xhigh`, read-only, 2026-11-04. Conservative defaults apply until the owner answers. None of these was resolved silently.

1. **Merge dark instead of "W1 lab gate blocks merge" (§4.5, §6).** The spec makes the Dell lab gate block W1's merge. The plan constraints require the hardware leg to be its own last wave, so code merges before the lab.
   - **A. Merge dark, lab wave opens gates.** Pro: small reviewable PRs, fixtures replace doc-derived tests in one place. Con: W01's reboot and upgrade changes reach customers before any lab. Mitigated by a no-section behaviour test.
   - **B. Long-lived branch until the lab passes.** Pro: honours the spec's wording. Con: violates "never stacked", and rots.
   - **Recommend A.** Advisor agrees only with enforced boundaries, so W03 owns enforcement at the seam and at claim, not just registration. W10 amends the spec's wording.
2. **When does Run Now reach customers?** W10 is one last wave, so the troubleshooting win waits for scheduling to be done.
   - **A. One Dell lab wave at the end.** Pro: matches the constraint; gates open once on full evidence. Con: slower first value.
   - **B. Split W10 so leg D1 opens Run Now after W04.** Pro: value weeks earlier. Con: breaks "last wave per vendor"; BIOS decision made on half the evidence.
   - **Recommend A.** Advisor agrees. The owner may still run D1 early to surface a Dell surprise sooner; no gate opens from it.
3. **The Lenovo spike contradicts "hardware is last."** Spec §5 requires a hardware spike before any lane code; the plan rule makes hardware the last wave per vendor. The advisor says record this as unresolved rather than assume an exception. **W15–W17 do not start until answered.**
   - **A. Allow W15 as a named exception:** spike only, no lane code, no gate opened. Pro: honours both intents. Con: an exception.
   - **B. Build the lane on a guessed tool, validate last.** Pro: keeps the rule. Con: likely rewrite; the spec forbids it.
   - **C. Defer Lenovo from v1.** Pro: no conflict. Con: drops a goal; System Update is end of life 2027-03-31.
   - **Recommend A.**
4. **Scheduler versus takeover and reboot mode.** Advisor: merge my original W06 and W07, because scheduling without takeover and bounded reboots is incomplete, or keep dispatch inert. Mine: keep them separate for review size.
   - **A. Reorder: primitives first (W06), scheduler second (W07).** Pro: no inert code, no giant PR. Con: W06 has no caller until W07.
   - **B. Merge into one wave.** Pro: one coherent change. Con: largest PR in the feature, touching agent and API.
   - **Recommend A.** This is what the wave table shows.
5. **Where the Windows Update type lives (W08).** Adopted the advisor's correction: my first proposal, `patches.update_type`, would let one tenant's agent report influence a shared row (`services/patchSeverityOverlay.ts`). The plan uses per-device `device_patches.reported_update_type`, NULL meaning "not excluded".
6. **How far the arming gate reaches (W05).** Adopted the advisor's extension: the gate follows effectiveness, not the verb. It covers link write, assignment, child creation under an armed parent, deleting an override that reverts to an armed parent, and re-activating an inactive policy. Precedent: `hpCmslGate` in `configurationPolicies/`. Narrowing writes (turning something off, adding a blocked ID) need only `devices.write`, so stopping a bad update never needs extra rights.
7. **HP BIOS depends on #5515 (#5511 W04, CMSL catalog package).** That wave is open and gated, and CMSL has an EULA consent path.
   - **A. HP BIOS gate stays closed until #5515 ships.** The lab may hand-install CMSL to collect evidence. Pro: no duplicated waves, consent stays in one place. Con: HP BIOS comes last.
   - **B. HP lane installs CMSL itself.** Pro: faster. Con: duplicates #5515 and forks EULA consent.
   - **C. Let HPIA handle BIOS.** Pro: one tool. Con: its guide does not mention BitLocker (§4.5).
   - **Recommend A.**
8. **Dell: BitLocker still suspended after the post-update reboot.** The spec trusts Dell's handling but asks the lab to confirm it.
   - **A. Report and alert in v1; decide on auto-resume with W10 evidence.** Pro: no untested BitLocker write on Dell. Con: a tech must act.
   - **B. Always auto-resume.** Pro: self-healing. Con: writes protection state on a path the owner trusts Dell to manage, untested.
   - **Recommend A.**
9. **Run Now authentication.** The spec says `devices.execute` and MFA.
   - **A. Spec, plus interactive sessions only** (no API keys, MCP or AI; AI is "later"). **B.** Also a single-use step-up grant, as `force_reboot` has. **C.** Allow API keys.
   - **Recommend A** for v1. Pro: smallest surface matching the spec. B is cheap to add if the owner wants hostname-style friction on a BIOS flash.

## Spec deltas found at baseline `36f9d9ca53`

The spec was checked against an older commit. Nothing below changes its intent:

- **Authenticode:** chain verification now exists at `agent/internal/isolation/scheduler_windows.go:87`, added after the spec was written. It verifies trust but reads no publisher, so W01 extracts it and adds the publisher read.
- **Moved lines:** `heartbeat.go` privilege warning is now at `:7883`; gated-row drop in `configurationPolicy.ts` is at `:2982`.
- **New alert source needs a migration:** `BUILT_IN_ALERT_RULE_SOURCES` must agree with `alert_rules_builtin_anchor_uidx`, so W03 ships a second migration.
- **`device_commands.submitted_org_id`** already records the device's org at enqueue, so W04's history filter needs no schema change.
- **`patches` carries only `category`**, not the Windows Update type, so W08 needs a wire field and a column (Decision 5).
- **Tool index:** the lazy index (#10087) moved the ceiling tests to `services/aiToolIndex*.test.ts`.

---

## W01: Agent safety core

Shared contract, publisher verification, flash guard, availability gate. **No migration.** Nothing can dispatch a run after this wave, but T3 changes shared reboot and upgrade paths, so it is not inert.

**Execution split.** No API/web seam. PARALLEL GROUPS: {T1, T2}, then {T3}, then {T4}. Sonnet-eligible: T1. Everything else Opus.

### W01 T1: Shared contract

**Files:** Create `packages/shared/src/validators/oemUpdates.ts`, `.test.ts`, `packages/shared/src/validators/__fixtures__/oemUpdateResult.sample.json`, `packages/shared/src/utils/oemUpdates.ts`, `.test.ts`. Modify `packages/shared/src/validators/index.ts`.

**Interfaces, produces:**
```ts
OEM_LANES = ['dell','surface','hp','lenovo']
OEM_CATEGORIES = ['bios','firmware','driver','application']
OEM_OUTCOMES  // the 12 in Global Constraints
oemUpdateRunPayloadSchema  // strict
// { lane, trigger: 'scheduled'|'on_demand', occurrenceKey: string|null,
//   categories: OemCategory[], blockedUpdateIds: string[] (max 200, each 1..128),
//   rebootControlled: boolean, notAfter: ISO string, escrowedProtectorIds: uuid[] (max 16),
//   tool: { version, minSafeVersion, supportedRange: { min, maxExclusive }, url, sha256,
//           prerequisites: [{ name, minVersion, url, sha256 }] } | null }
oemUpdateRunResultSchema  // strict
// { lane, outcome, toolVersion: string|null, rawExitCode: number|null, errorCode: string|null,
//   rebootRequired: boolean, shutdownRequired: boolean,
//   items: [{ title (max 200), category, version (max 64), result: 'installed'|'failed'|'skipped' }] (max 200),
//   skippedCategories: [{ category, reason: 'gate'|'no_reboot_control'|'no_recovery_key'|'power' }],
//   takeover: 'ok'|'policy_locked'|'not_attempted' }
oemUpdateVerificationSchema  // strict: { commandId, bitlockerAfter: 'on'|'suspended'|'off'|'unknown', biosVersionAfter: string|null }
OEM_UPDATE_MIN_AGENT_VERSION; agentSupportsOemUpdates(version): boolean  // fail closed
```

- [ ] **Tests, red first:** `rejects an unknown key`, `rejects 201 items`, `rejects a title over 200`, `parses the sample fixture`. `agentSupportsOemUpdates`: `null`, `''`, `garbage`, older are false; equal and `-rc.1` are true (copy `utils/forceReboot.test.ts`).
- [ ] **Implement.** `OEM_UPDATE_MIN_AGENT_VERSION` is the next agent release after this wave merges; check at PR time.
- [ ] **Verify:** `cd packages/shared && npx vitest run src/validators/oemUpdates.test.ts src/utils/oemUpdates.test.ts` passes.
- [ ] **Commit:** `feat(shared): oem update run contract`

### W01 T2: Authenticode with publisher read

**Files:** Create `agent/internal/authenticode/{authenticode.go, authenticode_windows.go, authenticode_other.go, authenticode_test.go}`. Modify `agent/internal/isolation/scheduler_windows.go`.

**Interfaces, produces:**
```go
type Signer struct { Subject, ThumbprintSHA256 string }
func Verify(path string) (Signer, error)     // chain, then leaf subject; ErrUnsupported off Windows
func VerifyChain(path string) error          // the moved isolation behaviour, flags unchanged
func PublisherAllowed(s Signer, allowed []string) bool  // exact, case-sensitive on the CN
```

- [ ] **Tests, red first:** `PublisherAllowed` table: exact match true; `Dell Inc` versus `Dell Inc.` false as listed; substring and `Dell Inc Evil` false; empty allowlist false; empty subject false.
- [ ] **Implement.** Move the `WinVerifyTrust` call and its pinning unchanged. `verifyRecoveryAuthenticode` becomes a one-line call to `VerifyChain`; `scheduler_windows_test.go` stays green. Read the leaf with `WTHelperProvDataFromStateData` before `WTD_STATEACTION_CLOSE`. Revocation stays cache-only: a vendor tool run must not hang on certificate infrastructure, and the SHA-256 pin covers downloads. A catalog-signed tool fails closed here; D1 confirms DCU is embedded-signed.
- [ ] **Verify:** `cd agent && go test -race ./internal/authenticode/ ./internal/isolation/...` and `GOOS=windows go vet ./internal/authenticode/ ./internal/isolation/`.
- [ ] **Commit:** `feat(agent): authenticode publisher read, shared with isolation`

### W01 T3: Durable flash guard and every power path

**Files:** Create `agent/internal/flashguard/{guard.go, guard_test.go, callers_test.go}`. Modify `agent/internal/patching/reboot_manager.go` (OS invoke near `:922`), `agent/internal/heartbeat/handlers.go` (`handleForceReboot`), `agent/internal/remote/tools/system.go` (reboot, shutdown), `agent/internal/remote/tools/system_safemode_windows.go`, `agent/internal/heartbeat/heartbeat.go` (`doUpgrade` at `:8847`), `agent/internal/heartbeat/handlers_devupdate.go`, and each further site the caller test finds.

**Interfaces, produces:**
```go
type Section struct { Kind, CommandID string; StartedAt, ExpiresAt time.Time }
func Default() *Guard        // process-wide; state file under config.GetDataDir() via securefs
func (g *Guard) Enter(kind, commandID string, ttl time.Duration) (release func() error, err error)
    // ErrPowerActionPending when an OS shutdown countdown is armed or a power action is executing
func (g *Guard) Active() (Section, bool)     // a section past ExpiresAt counts as inactive and is cleared
func (g *Guard) AdmitPowerAction(name string) (done func(), err error)
    // ErrFlashInProgress during a section; otherwise holds the same lock through the OS invocation
func (g *Guard) SetCountdownProbe(func() bool)
```

Admission and execution share one lock, so a flash cannot start between the check and `shutdown`. TTL maximum 3 h: a crash must not block reboots forever.

- [ ] **Tests, red first:** `TestSectionSurvivesProcessRestart` (new Guard on the same dir sees it); `TestExpiredSectionClearsOnRead`; `TestEnterRefusedWhileCountdownArmed`; `TestAdmitRefusedDuringSection`; `TestAdmitAndEnterAreAtomic` (race, `-race`); `TestNoSectionIsANoOp`: every wired path with no section behaves exactly as before. Reboot timer: `TestRebootTimerHoldsDuringSectionThenFires` keeps the plan's notifications intact. `force_reboot`: `TestForceRebootWaitsForSection`, bounded by the TTL. Upgrade: `TestDoUpgradeSkipsDuringSection` logs once at INFO, not per heartbeat.
- [ ] **Test, red first:** `callers_test.go` scans `agent/internal` source for `"shutdown"` exec sites and `UpdateFromURL(`/`UpdateFrom`, and fails on any file not on its explicit allowlist. Each allowlisted file must call `AdmitPowerAction`. This is the mechanical guard against a new path.
- [ ] **Implement and wire every site.** Include safe-mode reboot before it sets the BCD flag, already-armed timers, dev-push, and the watchdog and rollback replacement paths the scan finds.
- [ ] **Verify:** `cd agent && go test -race ./internal/flashguard/ ./internal/patching/ ./internal/heartbeat/ ./internal/remote/tools/`
- [ ] **Commit:** `feat(agent): durable flash guard honoured by every power and replace path`

### W01 T4: Availability gate

**Files:** Create `agent/internal/oemupdates/{availability.go, availability_test.go}`.

**Interfaces, produces:**
```go
const toolAvailabilityTTL = 24 * time.Hour
type ToolState struct { Present bool; Path, Version string; CheckedAt time.Time }
type ToolGate struct { /* ttl, detect, now, mu, value, valid */ }
func NewToolGate(name string, detect func() ToolState) *ToolGate
func (g *ToolGate) Get() ToolState
func (g *ToolGate) Invalidate()
```

- [ ] **Tests, red first:** `TestAbsentToolDetectsOncePerTTL`: 100 `Get`s call detect once. `TestNoWarnWhenAbsent`: capture `slog`, assert zero WARN records. `TestStateChangeLogsOnceAtDebug`. `TestInvalidateForcesRedetect`. `TestRedetectsAfterTTL` with an injected clock.
- [ ] **Implement.** Same shape as `cachedHostProbe`, with `Invalidate`. A local copy, since `collectors` keeps its type unexported and this wave should not re-home it.
- [ ] **Verify:** `cd agent && go test -race ./internal/oemupdates/`
- [ ] **Commit:** `feat(agent): 24 h availability gate for vendor tools`

**W01 PR body:** states that reboot and upgrade paths changed and are unchanged with no section; names `Refs #<sub-issue>` plus `Closes #<sub-issue>` per lifecycle.

---

## W02: `oem_update_run`, runner, Dell lane on fakes

**No migration.** Nothing dispatches this until W03 and W04.

**Execution split.** Agent only. PARALLEL GROUPS: {T1, T2, T3}, then {T4}, then {T5}, then {T6}. All Opus: this is vendor-tool discovery and invocation.

Every external effect is an injected seam, so the whole runner tests on fakes on any OS: `Exec`, `Verifier`, `Fetcher`, `Power`, `Protectors`, `Clock`, `Store`.

### W02 T1: Lane interface, lock, marker

**Files:** Create `agent/internal/oemupdates/{types.go, lock.go, marker.go, lock_test.go, marker_test.go}`.

**Interfaces, produces:**
```go
type Outcome string   // the 12 constants
type RunRequest struct { /* mirrors oemUpdateRunPayloadSchema */ }
type RunResult struct { /* mirrors oemUpdateRunResultSchema */ }
type Lane interface {
    ID() string
    Gate() *ToolGate
    Allow() LaneAllowlist          // from allowlist.json
    Filter(cats []string, blocked []string) (FilterPlan, error)
    Apply(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error)
    SkippedForNoReboot() []string  // categories needing a Breeze reboot
}
func AcquireRunLock(store Store) (release func(), err error)  // ErrRunInFlight
func WriteMarker(store Store, m Marker) error
func ReadInterruptedMarker(store Store) (Marker, bool)
```

- [ ] **Tests, red first:** `TestSecondRunRefusedWhileLocked`; `TestLockClearedAfterRelease`; `TestMarkerWithoutEndReportsInterrupted`; `TestResultRoundTripsSharedFixture` reads `../../../packages/shared/src/validators/__fixtures__/oemUpdateResult.sample.json` and re-serializes to the same keys, the cross-language contract.
- [ ] **Implement, verify, commit:** `feat(agent): oem lane interface, run lock and marker`

### W02 T2: Verified fetch and install

**Files:** Create `agent/internal/oemupdates/{allowlist.json, allowlist.go, fetch.go, fetch_test.go, install.go, install_test.go, verify_windows.go, verify_other.go}`.

**Interfaces, produces:**
```go
type LaneAllowlist struct { Publishers, Hosts []string }
func Fetch(ctx, client, url, sha256 string, allow LaneAllowlist, dest string) error
func EnsureTool(ctx, lane Lane, spec ToolSpec, deps Deps) (ToolState, Outcome, error)
```

`allowlist.json`: Dell publishers `Dell Inc`, Microsoft `Microsoft Corporation` for .NET; hosts `dl.dell.com`, `downloads.dell.com`, `builds.dotnet.microsoft.com`, `download.visualstudio.microsoft.com`. Researched, not confirmed; D1 confirms real values.

- [ ] **Tests, red first, with `httptest` and a fake verifier:** `TestRefusesOffListHost`; `TestRefusesRedirectToOffListHost` (per-hop `CheckRedirect`); `TestRefusesHTTP`; `TestShaMismatchDeletesFile`; `TestSizeCapEnforced`; `TestWrongPublisherRefusedAfterInstall`; `TestPrerequisiteInstalledFirstAndVerified`; `TestSilentInstallWithoutPrerequisiteDetected`: tool absent after a zero exit returns `tool_unavailable` with `errorCode=install_incomplete` (§5, Dell's silent exit); `TestToolInRangeNotReinstalled`; `TestToolBelowFloorReinstalled`; `TestToolAboveRangeRefused`; `TestUrlGoneWithToolInRangeKeepsWorking`; `TestUrlGoneNoToolIsToolUnavailable`; `TestInstallInvalidatesGate`.
- [ ] **Implement, verify, commit:** `feat(agent): allowlisted fetch, signed install, version range`

### W02 T3: Safety gates

**Files:** Create `agent/internal/oemupdates/{gates.go, gates_test.go, power_windows.go, power_other.go, protectors_windows.go, protectors_other.go}`.

**Interfaces, produces:**
```go
const minFlashBatteryPercent = 25
func CheckFlashPower(p PowerStatus) (ok bool, reason string)
func CheckRecoveryKey(onVolume []string, escrowed []string, bitlockerOn bool) bool
func RefuseUnlessElevated() error
```

**"Current" recovery key, defined (§4.5):** BitLocker on the OS volume, and at least one recovery-password protector read **live immediately before the install** is in `escrowedProtectorIds`. Matched by protector ID, never by `status='active'` or `escrowedAt`, because an unchanged snapshot is not retransmitted and those fields cannot show freshness. A protector rotated since dispatch fails the match, the safe direction. The payload carries IDs only, never key material.

- [ ] **Tests, red first:** `CheckFlashPower` table (Review Focus 2): AC on with battery flag 128 and percent 255 passes; AC on at 24 fails; AC on at 25 passes; AC off fails; AC unknown (255) fails. `CheckRecoveryKey`: BitLocker off passes with empty lists; on with intersection passes; on with none fails; on with empty escrowed fails; on with an empty live read fails. `RefuseUnlessElevated` refuses when not root.
- [ ] **Implement.** Reuse `GetSystemPowerStatus` from `preflight_windows.go`, adding `BatteryFlag`. Live protector read through `security.CollectRecoveryKeys`, filtered to the OS volume.
- [ ] **Verify, commit:** `feat(agent): flash power, recovery key and elevation gates`

### W02 T4: Runner

**Files:** Create `agent/internal/oemupdates/{runner.go, runner_test.go, resume.go, resume_test.go}`.

**Interfaces, produces:**
```go
const maxRunDuration = 110 * time.Minute   // under the 2 h stale-command reaper
func Run(ctx context.Context, req RunRequest, lane Lane, deps Deps) RunResult
func ResumePending(ctx context.Context, deps Deps, report func(Verification) error) error // on agent start
```

Fixed order: elevation, `notAfter`, lock, marker, preflight (`patching.RunPreflight`), tool gate, fresh verification, ensure tool, split categories, guard, `Apply`, mapped result, marker end.

- [ ] **Tests, red first, with fakes:** `TestRefusesAfterNotAfterWithRetryLater` (Review Focus 4, 6 h fast clock); `TestSignatureCheckedOnEveryRunNotCached`: two runs verify twice while the gate stays cached; `TestBiosSkippedWhenRebootNotControlled`: `skippedCategories` carries `no_reboot_control`, drivers still run; `TestBiosSkippedOnLowBattery`; `TestAllSkippedForKeyIsBlockedNoRecoveryKey`; `TestGuardHeldOnlyWhileBiosOrFirmwareRuns`; `TestGuardRefusedIsBlockedRebootPending`; `TestDriverOnlyRunKilledAtDeadline`; `TestFlashNotKilledAtDeadline` (Review Focus 5); `TestRestartAfterMarkerReportsInterrupted`; `TestResumeVerifiesBitlockerAndBios`: state suspend → update → reboot → verify, posting `oemUpdateVerificationSchema` once, retried with backoff on 404; `TestStillSuspendedIsReportedNotChanged` (Decision 8); `TestRunNowChangesNoToolSettings`.
- [ ] **Implement.** Progress through the existing `command_progress` frame, stages `verifying`, `installing_tool`, `installing`, `reporting`.
- [ ] **Verify, commit:** `feat(agent): oem update runner with durable resume`

### W02 T5: Dell lane

**Files:** Create `agent/internal/oemupdates/{lane_dell.go, lane_dell_test.go}`, `testdata/dell/README.md`, doc-derived samples under `testdata/dell/doc-derived/`.

**Interfaces, consumes:** `Lane`, `ToolGate`, `Exec`.

- [ ] **Tests, red first:**
  - `TestDellArgv`: exactly `/applyUpdates -silent -reboot=disable -autoSuspendBitLocker=enable -outputLog=<path>`, plus `-updateType=` and `-updateDeviceCategory=` from categories, plus `-localblockedswb=`. A path with spaces stays one argument.
  - `TestDellExitMap`: 0 success; 1 `success_reboot_required`; 5 `blocked_reboot_pending`; 500 `no_updates`; 3 and 7 `not_supported`; 6, 3003, 3004, 3005 `retry_later`; 1000–1002 and 501–503 `failed`; an unmapped code `failed` with `rawExitCode` kept.
  - `TestDellExitTableKeyedByMajorVersion`: a tool major outside the table yields `failed` with `errorCode=unknown_tool_major` (§4.4).
  - `TestDellGateFindsEitherProgramFilesPath`; `TestDellGateQuietWhenAbsent`.
  - `TestDellReportParseFailureDoesNotFailRun`: the report schema is unconfirmed; parse failure means empty items and `errorCode=report_unavailable` while the outcome comes from the exit code.
  - `TestDellItemsCappedAt200`; `TestDellNonUtf8TitleSanitized`.
- [ ] **Implement.** Samples are marked doc-derived in `README.md`. W10 replaces them with captures; a W10 task deletes this directory.
- [ ] **Verify, commit:** `feat(agent): Dell Command Update lane`

### W02 T6: Command registration

**Files:** Modify `agent/internal/remote/tools/types.go`, `agent/internal/heartbeat/handlers.go`, `agent/internal/heartbeat/handlers_test.go`, `agent/internal/privilege/check.go`, `check_test.go`. Create `agent/internal/heartbeat/handlers_oem.go`, `handlers_oem_test.go`.

**Interfaces, produces:** `tools.CmdOemUpdateRun = "oem_update_run"`.

- [ ] **Tests, red first:** `TestOemHandlerRefusesWhenNotElevated`, independent of the warn-only check at `heartbeat.go:7883` (§4.4); `TestOemHandlerUnknownLaneFails`; `TestOemHandlerNonWindowsIsNotSupportedQuietly`; `TestOemPayloadStrictParse`; journal: a stop during a run yields the marker's `interrupted`, not only the generic synthetic failure.
- [ ] **Implement, verify:** `cd agent && go test -race ./...` and `GOOS=windows go vet ./...`.
- [ ] **Commit:** `feat(agent): register oem_update_run`

---

## W03: API core

**Migrations (2):** `2027-01-21-100000-device-oem-update-status.sql`, `2027-01-21-110000-builtin-alert-rule-oem-updates.sql`. Re-check slots at branch time.

**Execution split.** API only; web starts in W04. PARALLEL GROUPS: {T1, T2}, then {T3, T4}, then {T5}, then {T6}. Sonnet-eligible: the T1 list edits and T3's list additions, under an Opus reviewer.

### W03 T1: Status table and registrations

**Files:** Create the migration, `apps/api/src/db/schema/oemUpdates.ts`, `apps/api/src/__tests__/integration/oemUpdateStatusRls.integration.test.ts`. Modify `db/schema/index.ts`, `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `routes/devices/core.ts`.

**Shape:** tenancy shape 1, direct `org_id`. RLS enabled, forced, policies in this migration. Composite FK `(device_id, org_id) → devices(id, org_id)`, `ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` (`securityAgents.ts:65`). `UNIQUE(device_id)`. CHECKs on `lane`, `applicability`, `last_outcome`, `takeover_state`. No JSON columns.

**Columns:** spec §4.7 list (`device_id, org_id, lane, applicability, reason, tool_version, occurrence_key, attempts, last_attempt_at, last_success_at, last_outcome, last_command_id, installed_count, failed_count, reboot_required, bios_version_before, updated_at`), plus these the later waves need, added now to avoid a second migration on a registered table:

| Column | Used by |
|---|---|
| `id uuid pk`, `created_at` | convention |
| `first_completed_at timestamptz` | W08 "has completed at least one run" |
| `run_started_at`, `return_deadline_at timestamptz` | W03 monitor |
| `reboot_pending_since timestamptz` | W06/W07 holds and **Reboot overdue** |
| `takeover_state varchar(16) default 'none'` | W06 release |
| `not_supported_tool_version varchar(32)` | §4.3 sticky until model or tool changes |
| `bitlocker_after varchar(16)`, `verified_at timestamptz` | W02 verification |

`last_command_id` is a bare uuid, no FK, because `device_commands` is system-scoped. Index `(org_id, applicability)` and partial `(return_deadline_at) WHERE return_deadline_at IS NOT NULL`.

**Registration, all six:**
| List | File | Enforced by |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `tenantCascade.ts` (alphabetical) | Integration |
| merge policy `repoint` | `orgMergeRegistry.ts` | Test API full suite + Integration |
| `CORE_TENANT_EXPORT_POLICY`, all columns `included` | `tenantExportPolicyRegistry.ts` | Integration |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts` | Test API |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | same | Test API |
| `DEVICE_ORG_FK_CASCADE_TABLES` | same | Test API |

No ticket lists: there is no `ticket_id`.

- [ ] **Tests, red first:** `oemUpdateStatusRls.integration.test.ts`: cross-org insert as `breeze_app` fails 42501; another org's row invisible; a device org move restamps through the FK; org merge succeeds with constraints deferred.
- [ ] **Implement, then verify:** `pnpm db:check-drift`; `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts`; `pnpm test-stack up`; `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemUpdateStatusRls src/__tests__/integration/tenantCascade src/__tests__/integration/orgMergeRegistry src/__tests__/integration/tenant-export-policy src/__tests__/integration/tenantExportErasureRoundtrip`, checking the file count; `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; `pnpm test-stack down`.
- [ ] **Commit:** `feat(api): device_oem_update_status table and registrations`

### W03 T2: Alert source

**Files:** Create the second migration, `services/oemUpdates/alerts.ts`, `alerts.test.ts`. Modify `services/builtInAlertRules.ts`.

**Interfaces, produces:**
```ts
export const OEM_UPDATES_ALERT_SOURCE = 'oem-updates';
emitDeviceNotReturnedAlert({ deviceId, orgId, commandId, startedAt }): Promise<void>
emitProtectionStillSuspendedAlert({ deviceId, orgId, commandId }): Promise<void>
resolveReturnedDeviceAlerts(deviceIds: string[]): Promise<number>
```

The migration recreates `alert_rules_builtin_anchor_uidx` with the new source in its predicate, copying `2026-12-03-120000-builtin-alert-rule-unique-index.sql`. W09 reuses this source with a new rule name, so it needs no migration.

- [ ] **Tests, red first:** `builtInAlertRuleUniqueness.integration.test.ts` fails until the index agrees with the constant; `emit… goes through createAlert`, never a bare insert, mirroring `patchAlerts`.
- [ ] **Implement, verify, commit:** `feat(api): built-in alert source for vendor updates`

### W03 T3: Command registration and exposure contract

**Files:** Modify `services/commandTypes.ts`, `commandTimeouts.ts` (`LONG_TIMEOUT_TYPES`), `commandOfflinePolicy.ts` (`live`, so offline rejects), `partnerTrust.ts`, `commandQueue.ts` (`AUDITED_COMMANDS`), `commandMinVersion.ts`, `__tests__/parkedFanoutModules.ts`. Create `__tests__/oemUpdateExposure.contract.test.ts`.

**Interfaces, produces:** `CommandTypes.OEM_UPDATE_RUN`, and `COMMAND_MIN_AGENT_VERSION.oem_update_run = OEM_UPDATE_MIN_AGENT_VERSION`.

- [ ] **Tests, red first:** `commandOfflinePolicy`: `defaultOfflinePolicy('oem_update_run')` is `{ kind: 'reject' }`. Timeouts: 2 h. Exposure contract, copying `forceRebootExposure.contract.test.ts`: `oem_update_run` may appear only in the registration files and `services/oemUpdates/dispatch.ts`, so the generic command route, bulk commands, AI tools, automations and mobile actions cannot name it. Parked-device delivery: refused.
- [ ] **Implement, verify:** `cd apps/api && npx vitest run src/__tests__/oemUpdateExposure.contract.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/commandOfflinePolicy.test.ts src/services/commandTimeouts.test.ts src/services/partnerTrust.test.ts`
- [ ] **Commit:** `feat(api): register oem_update_run, human and scheduler paths only`

### W03 T4: Manifest, gates, flags, applicability

**Files:** Create `services/oemUpdates/{toolManifest.ts, toolManifest.test.ts, flags.ts, flags.test.ts, applicability.ts, applicability.test.ts}`. Modify `config/validate.ts`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `.env.example`, `deploy/.env.example`.

**Interfaces, produces:**
```ts
type LaneManifest = { lane; laneGate: 'open'|'closed'; categoryGates: Record<OemCategory,'open'|'closed'>;
  codeBlocks: OemCategory[]; tool: ToolManifest|null };
getLaneManifest(lane): LaneManifest
isCategoryOpen(lane, category, opts?: { deviceId?: string }): boolean
openCategoriesForLane(lane, opts?): OemCategory[]
oemUpdatesEnabled(partnerId: string): boolean
laneDisabledByKillSwitch(lane): boolean
isLabDevice(deviceId): boolean
resolveApplicability(input: { osType, isVirtual, deviceRole, manufacturer, model, enabledLanes, shippedLanes })
  : { state: 'applicable', lane } | { state: 'not_applicable', reason }
```

Every lane starts with `laneGate: 'closed'` and all category gates closed. Dell's `tool` has the version and floor; `url` and `sha256` stay `null` until W10.

- [ ] **Tests, red first:**
  - Manifest contract: `every gate closed at this wave`; `an open gate requires a 64-hex sha256 and a url on allowlist.json` (reads `agent/internal/oemupdates/allowlist.json`); `a code block beats an open gate`.
  - `applicability.test.ts`, Review Focus 1: `Dell Inc.` is Dell; `HP`, `HP Inc.`, `Hewlett-Packard` are HP; `HPE`, `Hewlett Packard Enterprise`, `CHP Systems`, `Dell EMC` server-style and `Delltron` are not; `LENOVO` is Lenovo; `Microsoft Corporation` with a `Surface …` model is Surface; `Microsoft Corporation` with `Virtual Machine` or `isVirtual` is not; null and empty are not; server role, Linux, macOS, virtual are `not_applicable`.
  - Flags: off by default; allowlist restricts when set; `BREEZE_OEM_UPDATES_LAB_DEVICE_IDS` opens a gate for a listed device only; `validate.ts` refuses it under `NODE_ENV=production`.
  - `envComposeParity.test.ts` and `envReadComposeCoverage.test.ts` stay green.
- [ ] **Implement, verify, commit:** `feat(api): vendor tool manifest, closed gates, anchored applicability`

### W03 T5: Dispatch seam

**Files:** Create `services/oemUpdates/dispatch.ts`, `dispatch.test.ts`. Modify `services/commandClaimEligibility.ts`, `.test.ts`.

**Interfaces, produces:**
```ts
type OemDispatchInput = { deviceId; expectedOrgId; trigger; requestedCategories: OemCategory[]; blockedUpdateIds: string[];
  rebootControlled: boolean; notAfter: Date; occurrenceKey: string|null; actorUserId: string|null };
type OemDispatchRefusal = 'flag_off'|'lane_closed'|'kill_switch'|'agent_too_old'|'not_applicable'|'not_supported'
  |'ephemeral'|'parked'|'offline'|'run_in_flight'|'no_open_categories';
dispatchOemUpdateRun(input): Promise<{ ok: true; commandId } | { ok: false; refusal: OemDispatchRefusal }>
```

This is the only caller of the queue for `oem_update_run`. It intersects requested categories with open gates at send time, adds `escrowedProtectorIds` from `device_recovery_keys` (`status='active'`, `key_type='bitlocker_recovery_password'`, IDs only), sets `submittedOrgId`, passes `expectedOrgId`, sets `deliverBy` to `notAfter`, records `bios_version_before` and arms the monitor when bios or firmware is included.

- [ ] **Tests, red first:** one test per refusal; `a closed category is dropped, not sent`; `all closed returns no_open_categories`; `expectedOrgId mismatch queues nothing` (device moved mid-flight); `row has submitted_org_id and deliver_by` (Review Focus 4); `no key material in payload`. Claim: `an unclaimed oem_update_run is cancelled when its lane kill switch is on`; `… when its gate has closed`; `a running one is untouched`.
- [ ] **Implement, verify, commit:** `feat(api): single gated dispatch seam with claim recheck`

### W03 T6: Result handling, verification route, monitor worker

**Files:** Create `services/oemUpdates/{results.ts, results.test.ts, displayState.ts, displayState.test.ts}`, `routes/agents/oemUpdates.ts`, `.test.ts`, `jobs/oemUpdatesWorker.ts`, `.test.ts`. Modify `services/commandResultHandlers.ts`, `routes/agents/index.ts`, `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, `services/workerEntrypointClosure.contract.test.ts`, `__tests__/parkedFanoutModules.ts`.

**Interfaces, produces:**
```ts
applyOemUpdateResult({ commandId, deviceId, result }): Promise<void>   // parses strictly, upserts status, device's org
applyOemUpdateVerification({ deviceId, verification }): Promise<void>
type OemDisplayState = 'up_to_date'|'overdue'|'failing'|'not_supported'|'not_managed'|'waiting_for_reboot'|'reboot_overdue';
deriveOemDisplayState({ status, linkEnabled, occurrence, now }): OemDisplayState
runOemUpdatesTick(now): Promise<void>  // W03: monitor sweep only. W07 adds dispatch.
```

`PUT /agents/:id/oem-updates/verification` carries the agent's post-reboot report.

- [ ] **Tests, red first:** a malformed result stores `failed` with `errorCode=result_unparseable`, never throws; `a result for another org's device is ignored`; `first_completed_at set once`; `not_supported is sticky to tool version`; verification: mismatched BIOS recorded, `suspended` raises the alert (Decision 8). Monitor: `no check-in 24 h after a bios run raises the alert once`; `a check-in clears the deadline and resolves it`; `a driver-only run never arms`; a device moved mid-monitor raises in its current org. `deriveOemDisplayState` table for all seven states.
- [ ] **Implement.** Worker repeat every 10 minutes, system DB context, ephemeral and parked excluded, early exit when no row has a deadline.
- [ ] **Verify:** `cd apps/api && npx vitest run src/services/oemUpdates src/routes/agents/oemUpdates src/jobs/oemUpdatesWorker src/services/workerEntrypointClosure.contract.test.ts src/__tests__/parkedFanout.contract.test.ts`, checking the reported file count.
- [ ] **Commit:** `feat(api): vendor update results, verification and not-returned monitor`

---

## W04: Run Now

**No migration.**

**Execution split.** API/web seam: T1 and T2 define the JSON; T3 and T4 consume it. PARALLEL GROUPS: {T1, T2}, then {T3, T4}, then {T5}. Sonnet-eligible: T5 (locale fan-out). UI stays Opus.

### W04 T1: Route

**Files:** Create `routes/devices/oemUpdates.ts`, `.test.ts`. Modify `routes/devices/index.ts`, `services/mcpCoverage.ts`, `apps/api/src/openapi.ts`.

**Interfaces, produces:**
```
POST /devices/:id/oem-updates/run
  body { reboot: 'when_finished' | 'leave_to_me' } (strict)
  202 { commandId, categories } ; 409 { code: OemDispatchRefusal, minAgentVersion? } ; 403 ; 404
GET  /devices/:id/oem-updates/status
  200 { displayState, lane, status | null, gates: Record<OemCategory,'open'|'closed'> }
```

Middleware, as in `forceReboot.ts`: `requireScope`, `requireInteractiveSession`, `requirePermission(DEVICES_EXECUTE)`, `requireMfa`, `canAccessDeviceSite`, `assertDeviceExecuteAllowed`. `mcpCoverage`: `'devices/oemUpdates.ts': { exempt: 'human_only_oem_updates', note: … }`. `notAfter` is now + the `live_only` delivery window. All categories whose gates are open are requested; `leave_to_me` sets `rebootControlled: false`, which skips bios and firmware (§4.5). After a `when_finished` run reporting `rebootRequired`, the result handler calls `executeReboot` with the patch policy's delay and prompt text.

- [ ] **Tests, red first:** `refuses API key`, `refuses without MFA`, `refuses without execute`, `refuses other org 404`, `refuses site-restricted`, `refuses Quick Support device`, `refuses decommissioned`, `refuses when flag off`, `offline is 409 offline, nothing queued`, `audit row written`; `when_finished then rebootRequired queues schedule_reboot with source oem_updates`; `leave_to_me queues no reboot and reports the skipped categories`.
- [ ] **Implement, verify, commit:** `feat(api): Run vendor updates route`

### W04 T2: History

**Files:** Modify `routes/devices/oemUpdates.ts`, `.test.ts`. Create `services/oemUpdates/history.ts`, `.test.ts`.

**Interfaces, produces:** `GET /devices/:id/oem-updates/history?limit&offset` → `{ runs: [{ commandId, trigger, status, outcome, toolVersion, items, createdAt, completedAt, actor }], total }`. `normalizeOemRun(row)` parses the result strictly, and a bad result yields `outcome: null`.

A dedicated route, not `PATCH_COMMAND_TYPES`: run history is its own shape (§4.7).

- [ ] **Tests, red first:** `only type oem_update_run`; `filters submitted_org_id to the device's current org`: runs from before an org move are absent, including their actor; `null submitted_org_id excluded`; pagination; malformed result normalizes.
- [ ] **Implement, verify, commit:** `feat(api): org-scoped vendor update history`

### W04 T3: Device action and dialog

**Files:** Create `apps/web/src/components/devices/RunVendorUpdatesDialog.tsx`, `.test.tsx`. Modify `DeviceActions.tsx`, `DeviceActions.permissions.test.tsx`, `bulkActionGating.ts` with its test.

- [ ] **Tests, red first:** `disabled with upgrade hint below minimum agent` using `agentSupportsOemUpdates`; `hidden without devices.execute`; `hidden when status says not_managed and no lane`; `dialog requires choosing reboot when finished or leave reboot to me, no default`; `leave reboot to me names the skipped BIOS and firmware`; `runAction used, 409 refusal shows its reason`; `absent from bulk actions`. All via `data-testid`.
- [ ] **Implement, verify:** `cd apps/web && npx vitest run src/components/devices/RunVendorUpdatesDialog.test.tsx src/components/devices/DeviceActions.permissions.test.tsx`
- [ ] **Commit:** `feat(web): Run vendor updates action`

### W04 T4: Device section

**Files:** Create `apps/web/src/components/devices/DeviceVendorUpdatesSection.tsx`, `.test.tsx`. Modify `DevicePatchStatusTab.tsx`, its test.

- [ ] **Tests, red first:** renders last run, outcome, tool version, installed items, reboot state; `each display state has its own copy`; `blocked_no_recovery_key names the fix`; `unsupported category shows why it is closed`; empty state without a status row; history paginates.
- [ ] **Implement, verify, commit:** `feat(web): vendor updates section on device patches`

### W04 T5: Locales

**Files:** all 8 `apps/web/src/locales/*/devices.json`.

- [ ] Add keys in all 8; machine-draft the seven non-English. **Verify:** `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts`. **Commit:** `i18n(web): vendor update strings`.

---

## W05: `oem_updates` feature

**Migration:** `2027-01-21-120000-config-feature-oem-updates.sql`, one `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'oem_updates';`, mirroring `2027-01-19-120000-config-feature-containment.sql`. Re-check the slot.

**Execution split.** API/web seam: T1 fixes validators and the `/gates` read. PARALLEL GROUPS: {T1}, then {T2, T4}, then {T3}, then {T5, T6}. Sonnet-eligible: locale fan-out in T6. Precedent to copy: `git show 0b71144dd0 --stat` (containment part 1) lists every parity test this will trip.

### W05 T1: Type, settings schema, trust tier

**Files:** Create the migration, `packages/shared/src/validators/oemUpdatesPolicy.ts`, `.test.ts`. Modify `db/schema/configurationPolicies.ts` (append), `packages/shared/src/constants/configFeatureTypes.ts`, its test, `services/configurationPolicy.ts`, `services/policyBaselineDefaults.ts`, its test, `routes/configurationPolicies/featureLinks.ts`, `apps/web/.../featureTabs/types.ts`, `featureTypeParity.test.ts`, `devices/DeviceEffectiveConfigTab.tsx` with its parity test.

**Interfaces, produces:**
```ts
oemUpdatesInlineSettingsSchema  // strict; the §4.1 shape, version: 1
OEM_UPDATES_POLICY_DEFAULTS     // third, wed, 01:00, windowHours 4, catchUpNights 7, reboot overnight
hasArmedCategory(settings): boolean
armsBeyond(prev, next): boolean // enabled false→true, a category newly true, an hour earlier is not arming
```
`CONFIG_POLICY_FEATURE_TRUST_TIER.oem_updates = 'protective'` with the §4.1 reason. Absent vendor or category means off. An empty `vendors` is valid.

- [ ] **Tests, red first:** schema: unknown key rejected, `windowHours` 0 and 9 rejected, `catchUpNights` 15 rejected, `25:00` rejected. `armsBeyond` table; removing a category and adding a blocked ID are false. Parity suites pass with `oem_updates` in all lists.
- [ ] **Implement, verify:** `pnpm db:check-drift`; `cd packages/shared && npx vitest run src/validators/oemUpdatesPolicy.test.ts src/constants/configFeatureTypes.test.ts`; `cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts`.
- [ ] **Commit:** `feat(config-policy): oem_updates feature type, protective tier`

### W05 T2: Link write gate

**Files:** Create `services/oemUpdates/oemUpdatesLinkWrite.ts`, `.test.ts`. Modify `routes/configurationPolicies/featureLinks.ts`, `featureLinks.test.ts`, `services/configurationPolicy.ts`.

**Interfaces, produces:**
```ts
checkOemUpdatesLinkWrite({ featurePolicyId, previous, next, armAuthorized }):
  { ok: true; inlineSettings } | { ok: false; refusal: { status: 400|403; body: { code; error } } }
```

Order, as in `securityAgentsLinkWrite.ts`: arming authorization first, NULL `featurePolicyId`, strict parse, closed-gate refusal. **A category whose gate is closed cannot be stored true** (`oem_updates_category_gate_closed`), because a stored `true` would start flashing the day the gate opens, violating §4.1. Called by both the route and the service backstop.

- [ ] **Tests, red first:** `arming without execute is 403 before validation`; `arming with execute and MFA passes`; `narrowing with devices.write passes`; `bios true on closed gate is 400`; `opening a gate changes no stored link` (load settings, flip test manifest, resolve: BIOS still absent); `featurePolicyId set is 400`; partner-wide policy still needs `canManagePartnerWidePolicies`.
- [ ] **Implement, verify, commit:** `feat(config-policy): oem_updates arming gate`

### W05 T3: Arming through every other door

**Files:** Modify `routes/configurationPolicies/assignments.ts`, `crud.ts`, `featureLinks.ts` (DELETE), each test. Create `routes/configurationPolicies/oemUpdatesGate.ts`, `.test.ts`.

**Interfaces, produces:** `checkOemUpdatesArmAllowed(auth, perms)`, `policyArmsOemUpdates(policy)`, using the effective link: own, else inherited whole; an unresolved parent fails closed. Same shape as `hpCmslGate.ts`.

- [ ] **Tests, red first, one per door:** `assigning an armed policy needs execute`; `assigning an unarmed one does not`; `creating a child of an armed parent needs execute`; `deleting an override that reverts to an armed parent needs execute`; `deleting one with no armed parent does not`; `setting status active on an armed policy needs execute`; `unresolvable parent fails closed`. Also `partner-wide-write-coverage.test.ts` and `site-ceiling-write-coverage.test.ts` still pass.
- [ ] **Implement, verify, commit:** `feat(config-policy): oem_updates gate follows effectiveness`

### W05 T4: AI refusal

**Files:** Modify `services/aiToolsConfigPolicy.ts`, `aiToolsConfigPolicy.test.ts`, `aiToolsConfigPolicyExamples.ts`, `aiGuardrails.ts` with `aiGuardrails.approvalScope.contract.test.ts`, `apps/docs/.../features/ai-tools.mdx`.

- [ ] **Tests, red first:** `manage_policy_feature_link add with an enabled vendor is refused` (reuse `oemUpdatesToolRefusal` built on T2 with `armAuthorized: false`); `disabled settings pass`; `update that arms is refused`; `assign_policy_to_target and apply_configuration_policy refuse an armed policy`. Tool-index suites pass, per Global Constraints.
- [ ] **Implement, verify, commit:** `feat(ai): assistant cannot arm vendor updates`

### W05 T5: Resolver

**Files:** Create `apps/api/src/services/oemUpdates/resolver.ts`, `resolver.test.ts`, `apps/api/src/__tests__/integration/oemUpdatesResolver.integration.test.ts`. Modify `__tests__/parkedFanoutModules.ts`.

**Interfaces, produces:**
```ts
resolveOemUpdatesLinkForDevice(deviceId): Promise<ResolvedOemUpdatesLink | null>
resolveOemUpdatesLinksForDevices(deviceIds): Promise<Map<string, ResolvedOemUpdatesLink>> // chunks of 500
type ResolvedOemUpdatesLink = { linkId; configPolicyId; assignedPolicyId; settings: OemUpdatesInlineSettings };
```

Reads `config_policy_effective_feature_links` so inheritance works, passing `featureLinkReaders.contract.test.ts` without an allowlist entry. **Does not call `resolveExecutionSafeGroupIds`:** tier is protective, because dropping a group override that turns BIOS off could expose a broader policy that turns it on (§4.1). Unparseable settings resolve as disabled, logged once per link.

- [ ] **Tests, red first:** closest wins, closer replaces whole, no merge; role and OS filters apply; inactive policy ignored; child inherits parent's link; `a group override turning BIOS off still wins even for a refused group`. Integration: a partner-wide policy reaches a device in each of two orgs of that partner and neither org of another partner.
- [ ] **Implement, verify, commit:** `feat(api): resolveOemUpdatesLinkForDevice with batch form`

### W05 T6: Tab

**Files:** Create `apps/web/.../featureTabs/VendorUpdatesTab.tsx`, `.test.tsx`. Modify `ConfigPolicyDetailPage.tsx`, `featureTabs/types.ts`, `routes/configurationPolicies/featureLinks.ts` (or a sibling read route `GET /configuration-policies/oem-updates/gates`), locale JSON in 8 dirs.

- [ ] **Tests, red first:** new policy preselects Dell plus open categories only; closed categories render disabled with the reason; `a gate open but category absent shows "now available" and stays off`; arming without execute shows the permission message, narrowing does not; save via `useFeatureLink` and `runAction`; partner-wide badge. `settingsPageRegistry` unaffected: this is a feature tab.
- [ ] **Implement, verify, commit:** `feat(web): Vendor updates policy tab`

---

## W06: Overnight reboot and takeover primitives

**No migration.** No caller until W07, except T4's command, which W07 dispatches.

**Execution split.** API/agent seam: T1 fixes the payload, T2 honours it. PARALLEL GROUPS: {T1, T2}, then {T3}, then {T4}. All Opus.

### W06 T1: Reboot planner

**Files:** Create `services/oemUpdates/rebootPlanner.ts`, `.test.ts`. Modify `services/patchRebootHandler.ts`, its test, `packages/shared` min-version constant.

**Interfaces, produces:**
```ts
const OEM_REBOOT_GRACE_MINUTES = 15;
planOvernightReboot({ now, windowStart, windowEnd, patchDelayMinutes, deferral }):
  | { action: 'dispatch'; delayMinutes; deferral; windowEndsAt: Date; deadlineAction: 'hold' }
  | { action: 'hold'; retryAt: Date /* tomorrow's windowStart */ }
```

Why a new mode: `computeRebootDeadline` will not pull a deadline in front of the scheduled time and an inherited delay may be 1440 minutes (§4.5). `executeReboot` gains an additive `deadlineAction`; its absence keeps today's behaviour, pinned by the existing tests. Prompt text and deferral come from `resolveRebootPlan`, never copied.

- [ ] **Tests, red first:** `grace clamps to fit the window`; `inherited 1440 is clamped`; `no room left is hold until tomorrow's windowStart, not next month's`; `deferral budget cannot pass windowEnd`; `outside the window is hold`; DST: `tomorrow's start computed in device time`.
- [ ] **Implement, verify, commit:** `feat(api): overnight reboot planner`

### W06 T2: Agent `deadlineAction: 'hold'`

**Files:** Modify `agent/internal/heartbeat/handlers_patch.go`, `agent/internal/patching/reboot_manager.go`, `reboot_deferral.go`, tests.

- [ ] **Tests, red first:** `TestHoldAtDeadlineCancelsInsteadOfForcing`: deferred through the window close, the reboot is dropped and `reboot_held` reported, not forced; `TestAbsentActionKeepsForceAtDeadline`; `TestNotificationsStillFire` (#3197 invariant); `TestHoldRespectsFlashGuard`.
- [ ] **Implement, verify:** `cd agent && go test -race ./internal/patching/ ./internal/heartbeat/`. **Commit:** `feat(agent): reboot deadline can hold to the next night`

### W06 T3: Dell schedule takeover and restore

**Files:** Create `agent/internal/oemupdates/{takeover.go, takeover_test.go}`. Modify `lane_dell.go`, `runner.go`, tests. Add `Takeover(ctx, Exec, Store) (string, error)` and `Restore(ctx, Exec, Store) error` to an optional `LaneTakeover` interface.

- [ ] **Tests, red first:** `TestScheduledFirstRunExportsThenConfigures`: `-exportSettings` to the agent directory, then `/configure -scheduleManual -updatesNotification=disable`; `TestReassertedOnLaterRuns`; `TestExportFailureSkipsConfigureAndRuns`; `TestPolicyLockedNoOpReported`: read-back shows no change and result says `policy_locked`; `TestOnDemandNeverTakesOver`; `TestRestoreImportsOnlyWhatWeChanged` following `winupdate.go`'s ownership record; `TestRestoreIdempotent`; `TestRestoreWithNoRecordDoesNothing`.
- [ ] **Implement, verify, commit:** `feat(agent): Dell schedule takeover with owned restore`

### W06 T4: `oem_update_release`

**Files:** Agent: `remote/tools/types.go`, `handlers_oem.go`, `privilege/check.go`. API: `commandTypes.ts`, `commandTimeouts.ts`, `commandOfflinePolicy.ts` (`standard`, so it queues), `partnerTrust.ts`, `commandQueue.ts` audit set, the exposure contract test.

- [ ] **Tests, red first:** agent: `TestReleaseRestoresAndAcks`; `TestReleaseWithNoTakeoverAcks`. API: queues while offline; agent below the release minimum is not sent one; exposure contract allows only `services/oemUpdates/dispatch.ts`.
- [ ] **Implement, verify both, commit:** `feat: oem_update_release restores vendor schedules`

---

## W07: Scheduler

**No migration.**

**Execution split.** API only. PARALLEL GROUPS: {T1}, then {T2}, then {T3, T4}, then {T5}. Sonnet-eligible: none. Opus: fan-out at 10,000+ agents.

### W07 T1: Occurrence maths

**Files:** Create `services/oemUpdates/occurrence.ts`, `.test.ts`.

**Interfaces, produces:**
```ts
computeOccurrence(schedule, timezone, now): {
  occurrenceKey: string;            // 'YYYY-MM' of the anchor date, device-local
  anchorDate: LocalDate; nightIndex: number | null;   // 0 anchor, 1..catchUpNights
  windowStart: Date; windowEnd: Date; inWindow: boolean;
  isPastLastNight: boolean; }
stableOffsetMinutes(deviceId, windowMinutes): number  // in [0, min(60, windowMinutes/2))
notAfterFor(windowEnd, windowMinutes): Date           // windowEnd − min(60 min, windowMinutes/2)
ATTEMPT_CONSUMING_OUTCOMES   // excludes blocked_on_battery, blocked_reboot_pending, and retry_later refused before start
```

- [ ] **Tests, red first (Review Focus 3):** third Wednesday across a year, `last` in February; a window starting in the spring-forward gap fires at the next valid instant once; the autumn repeated hour fires once; a window crossing midnight stays one night; catch-up night crossing into next month keeps the previous `occurrenceKey`; next occurrence does not start while catch-up runs; `stableOffsetMinutes` is stable and in range for a 1-hour window.
- [ ] **Implement.** Timezone from `resolveEffectiveTimezone`, as `patchSchedulerWorker.ts:583` does; reuse `getLocalTimeParts` by exporting it. **Verify, commit:** `feat(api): vendor update occurrence maths`

### W07 T2: Candidate selection

**Files:** Create `services/oemUpdates/candidates.ts`, `.test.ts`, `__tests__/integration/oemUpdatesFanout.integration.test.ts`.

**Interfaces, produces:** `selectDueDevices(now, { limit }): Promise<DueDevice[]>`.

**Query shape:** exit early when no active `oem_updates` link exists. Then Windows, online, `isEphemeral = false`, `notParkedDeviceCondition()`, not virtual, joined to `device_hardware` and `device_oem_update_status`. Batch winners through `resolveOemUpdatesLinksForDevices` in chunks of 500. Cap dispatches per tick with `OEM_UPDATES_MAX_DISPATCH_PER_TICK` (default 200), and a device left over retries next tick because the window is hours long.

- [ ] **Tests, red first:** one exclusion test each: ephemeral, parked, offline, virtual, server role, `not_supported` for this tool version, finished this occurrence, run in flight, attempts at 3, not in window, offset not reached, maintenance suppressed (`checkDeviceMaintenanceWindow`), flag off for the partner. Integration: partner-wide link fans out by the device org's partner against real Postgres; status rows take the device's org.
- [ ] **Implement, verify (`pnpm test-stack up`, integration file, `pnpm test-stack down`), commit:** `feat(api): due-device selection for vendor updates`

### W07 T3: Tick dispatch

**Files:** Modify `jobs/oemUpdatesWorker.ts`, `.test.ts`, `services/oemUpdates/results.ts`.

- [ ] **Tests, red first:** `re-resolves the winning link immediately before dispatch`: disabled between select and send means no command; `passes expectedOrgId from the decision`; `occurrence and notAfter in payload`; attempts: 3 then Overdue, `blocked_on_battery` and `blocked_reboot_pending` consume none, `interrupted` consumes one; `reboot: never skips bios and firmware in the payload`; a finished occurrence stays quiet till next month; a tick that throws for one device continues.
- [ ] **Implement, verify, commit:** `feat(api): scheduled vendor update dispatch`

### W07 T4: Reboot holds and blocked reboot

**Files:** Create `services/oemUpdates/rebootSweep.ts`, `.test.ts`. Modify `jobs/oemUpdatesWorker.ts`, `services/oemUpdates/results.ts`.

- [ ] **Tests, red first:** `success_reboot_required with overnight dispatches in the same window`; `no room holds to tomorrow`; `three nights held shows reboot_overdue, not forced`; `blocked_reboot_pending with overnight reboots in the window, run follows next night`; `with never shows waiting_for_reboot, not failing`; `a reboot held then completed clears reboot_pending_since`; `shutdownRequired is never treated as a reboot`.
- [ ] **Implement, verify, commit:** `feat(api): nightly vendor reboot holds`

### W07 T5: Release sweep

**Files:** Create `services/oemUpdates/releaseSweep.ts`, `.test.ts`. Modify `jobs/oemUpdatesWorker.ts`.

- [ ] **Tests, red first:** `takeover_state taken_over and no enabled lane queues one release`; `not re-queued while pending`; `ack clears state`; `re-enabling before ack keeps takeover and cancels release`; org move does not release when the new org's policy also resolves.
- [ ] **Implement, verify, commit:** `feat(api): hand vendor schedules back when a policy goes away`

---

## W08: One owner per update class

**Migration:** `2027-01-21-130000-device-patches-reported-update-type.sql`, `ADD COLUMN IF NOT EXISTS reported_update_type varchar(16)` on `device_patches` with a CHECK. Re-check the slot. `device_patches` is in the org cascade, so **this column needs an export-policy classification** (`included`). Integration Tests catch it, not Test API.

**Execution split.** API/agent seam at T1. PARALLEL GROUPS: {T1}, then {T2}, then {T3}, then {T4}. Sonnet-eligible: T4 locales.

### W08 T1: Report the type per device

**Files:** Agent: `agent/internal/patching/types.go`, the pending-patch serializer in `heartbeat`, tests. API: migration, `db/schema/patches.ts`, `routes/agents/schemas.ts`, `routes/agents/patches.ts` with tests, `services/tenantExportPolicyRegistry.ts`.

- [ ] **Tests, red first:** agent: `TestPendingPatchIncludesUpdateType`. API: `a scan writes device_patches.reported_update_type`; `never writes to patches`, proving no cross-tenant influence; `absent stays null`; `an unknown value is rejected`. Export policy suite under Integration.
- [ ] **Implement, verify, commit:** `feat: report Windows Update type per device`

### W08 T2: Delivery predicate

**Files:** Create `services/oemUpdates/laneDelivery.ts`, `.test.ts`. Modify `__tests__/parkedFanoutModules.ts`.

**Interfaces, produces:** `getVendorManagedClasses(deviceId): Promise<Set<'driver'|'firmware'>>` and a batch form.

- [ ] **Tests, red first:** one case per §4.6 condition, each alone false yields an empty set: category off; gate closed; `not_supported`; no completed run; Overdue; Failing. All true yields the class. A Surface firmware gate closed returns no firmware, drivers still delivered.
- [ ] **Implement, verify, commit:** `feat(api): vendor lane delivery predicate`

### W08 T3: Eligibility

**Files:** Modify `services/patchEligibility.ts`, its test, `packages/shared/src/types/aiPatchPlan.ts` (`PATCH_INELIGIBLE_REASONS` adds `managed_by_vendor_updates`), `jobs/patchJobExecutor.ts` tests.

Evaluated **live at job execution**, not frozen in the snapshot, so a lane that starts failing returns the class to Windows Update on the next job without any rewrite.

- [ ] **Tests, red first:** `driver excluded only when the lane delivers`; `firmware likewise`; `reported_update_type null is not excluded`; **a security classification on a driver-type update is not excluded**, per `category.go:28`; `quality updates untouched`; `a device with no lane unchanged`; `lane Overdue at execution means installs again`; manual install through `routes/devices/patches.ts:227` is unaffected, pinned by test; native `winupdate.go` untouched.
- [ ] **Implement, verify:** `cd apps/api && npx vitest run src/services/patchEligibility src/jobs/patchJobExecutor src/routes/devices/patches.test.ts`. **Commit:** `feat(api): exclude classes the vendor lane delivers`

### W08 T4: Label

**Files:** Modify `apps/web/src/components/devices/DevicePatchStatusTab.test.tsx` and the ineligible-reason map beside the existing `blocked_by_category` key in `apps/web/src/locales/*/settings.json` (all 8 dirs).

- [ ] **Tests, red first:** the reason renders "Managed by Vendor updates". **Implement, verify (`localeParity`), commit:** `feat(web): show patches managed by vendor updates`

---

## W09: Fleet view, overdue alerts, docs

**No migration.**

**Execution split.** API/web seam: T1 fixes the JSON. PARALLEL GROUPS: {T1, T2}, then {T3, T4}. Sonnet-eligible: T4, and locale fan-out in T3.

### W09 T1: Fleet route

**Files:** Create `routes/oemUpdates/fleet.ts`, `.test.ts`. Modify the mount in `apps/api/src/index.ts`, `services/mcpCoverage.ts`, `openapi.ts`.

**Interfaces, produces:** `GET /oem-updates/fleet?state&orgId&lane&limit&offset` → `{ counts: Record<OemDisplayState, number>, devices: [...], total }`. `devices.read`.

- [ ] **Tests, red first:** org and partner scope; site-restricted user sees only their sites; ephemeral absent; each filter; counts agree with `deriveOemDisplayState`; 10,000-device fixture stays one indexed query per page, no per-device resolver walk.
- [ ] **Implement, verify, commit:** `feat(api): vendor updates fleet view`

### W09 T2: Overdue alerts

**Files:** Modify `services/oemUpdates/alerts.ts`, `.test.ts`, `jobs/oemUpdatesWorker.ts`.

- [ ] **Tests, red first:** `overdue device alerts once per occurrence`; `resolves after a good run`; `suppressed in maintenance`; `reboot_overdue alerts separately`. No migration: source exists, new rule name.
- [ ] **Implement, verify, commit:** `feat(api): overdue vendor update alerts`

### W09 T3: Fleet UI

**Files:** Create `apps/web/src/components/patches/VendorUpdatesView.tsx`, `.test.tsx`. Modify `PatchesPage.tsx`, `patchesHash.ts`, tests, locales.

- [ ] **Tests, red first:** tab at `#vendor-updates`; counts for Up to date, Overdue, Failing, Not supported, Not managed, plus reboot states; filter stays in the hash; row links to the device; existing hash tests pass. **Implement, verify, commit:** `feat(web): vendor updates fleet view`

### W09 T4: Docs

**Files:** Create `apps/docs/src/content/docs/features/vendor-updates.mdx`. Modify `agents/commands.mdx`, `.env.example` docs if needed, `apps/api/src/data/docsIndex.json` through its generator, `docs/release-notes/next-release-draft.md` (a merge-queue hot spot: rebase just before enqueue).

- [ ] Write: what it does, gates, BIOS requirements, what "Overdue" means, trust boundary, self-hoster flag. **Verify:** docs build, index generator clean. **Commit:** `docs: vendor updates`.

---

## W10: Dell lab wave (owner)

**No migration.** Owner runs legs D1–D5 below. Fixer turns the evidence into code. **The Dell category gates open here and nowhere else.**

**Execution split.** Owner first, then {T1}, {T2}. No Sonnet. Fixer never overrides a lab verdict.

### W10 T1: Fixtures replace doc-derived samples

**Files:** Create `agent/internal/oemupdates/testdata/dell/captured/*` (scrubbed). Delete `testdata/dell/doc-derived/`. Modify `lane_dell.go`, `lane_dell_test.go`, `allowlist.json`.

- [ ] **Tests, red first:** the parser against each captured report and log; `TestDellExitMap` adjusted only where a capture contradicts the guide, with the capture cited. Real publisher strings and hosts from D1.
- [ ] **Implement, verify, commit:** `test(agent): Dell lane against captured output`

### W10 T2: Open gates per evidence

**Files:** Modify `services/oemUpdates/toolManifest.ts`, `.test.ts`, the spec (§4.5 and §5 outcomes, §6 "blocks merge" wording per Decision 1).

- [ ] **Tests:** change the manifest contract's `every gate closed` to `Dell open exactly as the lab table says; Surface, HP, Lenovo closed`.
- [ ] **Implement.** Pin version, URL, SHA-256. Open `laneGate` and each category the legs passed. **If D2 fails, `bios` stays closed and the decision returns to the owner with the evidence; do not switch to `-reboot=enable`** (§4.5). PR body carries the lab table.
- [ ] **Commit:** `feat(api): open Dell gates per lab evidence`

**Rollout, not code, and the owner's call:** flag on with a partner allowlist on the owner's own Dells, observe one monthly occurrence, then widen.

---

## W11: Surface lane on fakes, shared BitLocker guard

**No migration.** Surface gates stay closed.

**Execution split.** Agent only, except a manifest entry. PARALLEL GROUPS: {T1}, then {T2}, then {T3}. All Opus.

### W11 T1: BitLocker guard

**Files:** Create `agent/internal/oemupdates/bitlockerguard/{guard.go, guard_test.go, ps_windows.go, ps_other.go}`.

**Interfaces, produces:**
```go
func Suspend(ctx, rebootCount int, deps) (Token, error)  // refuses rebootCount < 3; never 0
func Preflight(ctx, deps) (PCR7Bound bool, err error)    // parses manage-bde -protectors -get C:
func ResumeOnStart(ctx, deps) (Result, error)            // durable: re-enables what WE suspended
```

- [ ] **Tests, red first:** `TestSuspendZeroRefused`; `TestSuspendBelowThreeRefused`; `TestPreflightParsesPcr7` with localized `manage-bde` output treated as unknown, failing closed; `TestResumeOnlyWhatWeSuspended`: a volume someone else suspended stays; `TestResumeRunsAfterCrash` from the durable record; `TestResumeWhenRebootNeverHappens`: past a deadline the guard resumes and reports.
- [ ] **Implement, verify, commit:** `feat(agent): BitLocker suspend guard with durable resume`

### W11 T2: Windows Update driver search

**Files:** Modify `agent/internal/patching/windows.go`. Create `agent/internal/patching/windows_driver.go`, `windows_driver_test.go`.

**Interfaces, produces:** `SearchDriverUpdates(ctx) ([]DriverUpdate, error)`, `InstallDriverUpdates(ctx, ids) (InstallResult, error)`, with `DriverUpdate` carrying `DriverManufacturer`, `DriverClass`, `DriverModel`, `UpdateID`. Search: `Type='Driver' and IsInstalled=0 and IsHidden=0`.

- [ ] **Tests, red first:** pure filter over fakes: `TestSurfaceFilterMatchesSurfaceManufacturer`; `TestNonSurfaceDriverIgnored`; `TestFirmwareClassSplitFromDriver` with `DriverClass` values marked unconfirmed; `TestBlockedUpdateIdsDropped`.
- [ ] **Implement, verify (`GOOS=windows go vet`), commit:** `feat(agent): Windows Update driver search for vendor lanes`

### W11 T3: Surface lane

**Files:** Create `agent/internal/oemupdates/lane_surface.go`, `.test.go`. Modify `handlers_oem.go`, `services/oemUpdates/toolManifest.ts` (`tool: null`, closed), `applicability`'s shipped list.

- [ ] **Tests, red first:** `TestSurfaceInstallsNoSoftware`: no fetch path is reachable; gate quiet on non-Surface; `TestFirmwareRequiresPcr7Binding`; `TestFirmwareRunsSuspendThenResume`; `TestRebootCountAtLeastThree`; `TestBattery25Mandatory`; `TestFirmwareIrreversibleCopyInResult`; `TestSurfaceNoUpdatesMapsToNoUpdates`.
- [ ] **Implement, verify, commit:** `feat(agent): Surface lane`

---

## W12: Surface lab wave (owner)

**No migration.** Owner runs S1–S4. Fixer: captured `DriverClass` fixtures, correct the filter, record `ExcludeWUDriversInQualityUpdate` behaviour, open `driver` then `firmware` per evidence, update spec §5. **Commit:** `feat(api): open Surface gates per lab evidence`. No Sonnet.

---

## W13: HP lane on fakes

**No migration.** HP gates stay closed. **HP warranty via CMSL (#5511) is not touched:** no collector change, no catalog package. The BIOS path only detects an installed CMSL (Decision 7).

**Execution split.** Agent, plus a manifest entry. PARALLEL GROUPS: {T1}, then {T2}. All Opus.

### W13 T1: HPIA lane

**Files:** Create `agent/internal/oemupdates/lane_hp.go`, `.test.go`, `testdata/hp/doc-derived/*`. Modify `allowlist.json`, `handlers_oem.go`, `services/oemUpdates/toolManifest.ts`, `toolManifest.test.ts`.

- [ ] **Tests, red first:**
  - `TestHpArgv`: `/Operation:Analyze /Action:Install /Category:<list> /Selection:All /Silent /ReportFolder:<d> /SoftPaqDownloadFolder:<d> /AutoCleanup /IgnoreGenericOsError`.
  - `TestHpExitMap`: 256 and 257 `no_updates`; 3010 `success_reboot_required`; 3011 `partial`; 3020 `failed`; 4096 `not_supported`; unmapped `failed`.
  - `TestHpBlockedIdsUseAnalyzeThenSpList`: two-step when any ID is blocked.
  - `TestHpSureAdminDownloadOnlyIsPartial`.
  - `TestHpGateInAgentOwnedDirOnly`: a copy elsewhere on disk is ignored.
- [ ] **Implement, verify, commit:** `feat(agent): HP Image Assistant lane`

### W13 T2: HP BIOS path, inert

**Files:** Create `agent/internal/oemupdates/lane_hp_bios.go`, `.test.go`.

- [ ] **Tests, red first:** `TestHpBiosSkippedWithoutCmsl` (`skippedCategories`, no install attempted, availability gate quiet); `TestHpBiosArgv`: `Get-HPBIOSUpdates -Flash -Yes -BitLocker suspend`; `TestHpBiosNeverInstallsCmsl`; `TestHpBiosHoldsFlashGuard`.
- [ ] **Implement, verify, commit:** `feat(agent): HP BIOS path via installed CMSL`

---

## W14: HP lab wave (owner)

**No migration.** Owner runs H1–H5. Fixer: fixtures, parser, switches, manifest pin, open non-BIOS gates per evidence. `bios` opens only if H4 passes **and** Decision 7 is settled. **Commit:** `feat(api): open HP gates per lab evidence`.

---

## W15: Lenovo spike (owner)

**No migration. No lane code.** Blocked on Decision 3. Owner runs L0, then the fixer records the choice in spec §5: tool, source, version pin, BitLocker behaviour, what the lane skips. **Commit:** `docs(spec): Lenovo lane decision from spike`.

## W16: Lenovo lane on fakes

**No migration.** Exact tasks follow W15's choice, written as a plan addendum in the W15 PR. Fixed regardless of tool: same `Lane` interface, one availability gate, per-lane allowlist, no `bios` category until L3, `-noreboot` coverage modelled so package types that can force a reboot or shutdown are skipped or reported through `shutdownRequired`, `lane_lenovo.go` only. **Opus.**

## W17: Lenovo lab wave (owner)

**No migration.** Owner runs L1–L4. Fixer: fixtures and gates per evidence. **Commit:** `feat(api): open Lenovo gates per lab evidence`.

---

## Lab legs Todd owes

**Rules for every leg.** Units are lab machines nobody relies on (§8). BitLocker on unless stated. Before starting, confirm the recovery key is visible in Breeze **and** written down separately. Lab stack only, with `BREEZE_OEM_UPDATES_LAB_DEVICE_IDS` naming the unit. Save artefacts to `internal/lab/oem/<vendor>/<leg>/` (gitignored), scrub before anything is committed. Record pass, fail or surprise; a surprise is a finding, not a retry.

### Dell: one laptop and one desktop, BitLocker on. Owed before W10.

**D1. Clean install.** Fresh Windows, no DCU.
- [ ] Run vendor updates from the console.
- [ ] Download succeeds from Dell's host with the agent's client. Capture final host and every redirect.
- [ ] .NET prerequisite installs; repeat with it removed to confirm the failure is reported, not silent.
- [ ] Capture `Get-AuthenticodeSignature` publisher for `dcu-cli.exe`, installer and .NET. Embedded, not catalog?
- [ ] Capture `dcu-cli.exe` version and path.
- **Pass:** tool present, signed by the allowlisted publisher, run completes, status row correct.

**D2. BIOS with reboot disabled: the blocking question.** Unit with a BIOS update available.
- [ ] Run `dcu-cli /applyUpdates -silent -reboot=disable -autoSuspendBitLocker=enable -updateType=bios -outputLog=<path>`.
- [ ] Does it include the BIOS update? Capture the log.
- [ ] `manage-bde -status C:` every minute until reboot. How long is protection suspended?
- [ ] Reboot through Breeze. BIOS version changes? Recovery prompt? `manage-bde -status C:` afterwards shows protection on?
- [ ] Repeat on the second chassis.
- **Pass:** BIOS included, no recovery prompt, protection back on. **Fail:** `bios` stays closed, evidence goes to the owner (§4.5).

**D3. Outputs and edge states.**
- [ ] Capture a real report; does `-report` take a file or folder? Capture an apply log. Exit codes seen, including no-updates.
- [ ] Which categories honour `-updateType` and `-updateDeviceCategory`? **Does a dock update honour `-localblockedswb`?** (§4.8) Dock attached if one is available.
- [ ] BIOS password set: exact exit and message.
- [ ] Alongside Dell Update, and alongside SupportAssist: conflict or not. Remove nothing.
- [ ] Exit 5 path: leave a reboot pending, then run.
- [ ] Battery: unplug, confirm `blocked_on_battery`; at 20% on AC, confirm BIOS skipped.
- [ ] Escrow: remove the Breeze escrowed key, confirm `blocked_no_recovery_key`.
- **Pass:** every row has a captured answer.

**D4. Interruption.**
- [ ] During a real BIOS run, send force reboot, schedule reboot and an agent upgrade from the console. Each waits; the flash finishes.
- [ ] Stop the agent service during a driver run; confirm `interrupted` after restart.
- [ ] After the BIOS reboot, power off for 25 hours in a separate run: not-returned alert fires, then clears on return.
- **Pass:** nothing interrupts a flash; alert fires and resolves.

**D5. Scheduled overnight.** Requires W07.
- [ ] Policy assigned, window set to tonight. Takeover: `-exportSettings` saved, DCU's own schedule shows manual.
- [ ] Run happens in window, reboots in window, grace notice shown, deferral cannot pass the close.
- [ ] Miss one night (power off): catch-up runs next night.
- [ ] Hit a deferral through the window close: reboot moves to next night, never into the day.
- [ ] Remove the policy: release restores the original schedule, exactly.
- [ ] One-owner: a driver in Windows Update is excluded only after the lane delivers.
- **Pass:** all six, no daytime reboot.

### Surface: one used unit. Owed before W12. Buy first (§8).

**S1. Identity.** [ ] Capture `DriverManufacturer`, `DriverClass`, `DriverModel` for every pending Surface update via the Windows Update API. **Pass:** filter rule writable from real strings.

**S2. Policy interaction.** [ ] Set `ExcludeWUDriversInQualityUpdate` on and off, capture what each search returns. **Pass:** behaviour recorded, lane reports clearly when blocked.

**S3. Driver leg.** [ ] Install driver-class updates through the lane, reboot through Breeze. **Pass:** versions change, status correct, `driver` gate may open.

**S4. Firmware leg.** Battery above 25%, on AC.
- [ ] `manage-bde -protectors -get C:` captured; PCR 7 bound?
- [ ] Unbound state: capsule refused, reported clearly.
- [ ] Bound state: suspend with `RebootCount` at or above 3, install firmware, count how many reboots really occur (Microsoft's docs conflict). Protection resumes? Recovery prompt?
- [ ] Below 25%: refused.
- **Pass:** no recovery prompt, protection on. Note firmware cannot be rolled back. `firmware` gate may open.

### HP: one used business laptop. Owed before W14. Buy first (§8).

**H1. Licence.** [ ] Read HPIA's terms ("valid license from HP required"). Owner decides whether fetching on a customer's behalf is acceptable. **Pass:** decision recorded. **Fail:** HP lane does not ship.

**H2. Install.** [ ] Capture silent install switches for the HPIA SoftPaq, publisher, download host and redirects. **Pass:** runs unattended into the agent-owned directory.

**H3. Non-BIOS run.** [ ] Run the lane for driver, firmware and application: capture report folder, exit codes, 3010 path. [ ] Blocked ID through `/SPList`. [ ] Consumer model if on hand: exit 4096 maps to `not_supported`. **Pass:** fixtures captured; `driver` and `application` may open.

**H4. BIOS through CMSL.** CMSL hand-installed for the lab only (#5511 W04 owns real install).
- [ ] `Get-HPBIOSUpdates -Flash -Yes -BitLocker suspend`, reboot through Breeze, check for prompt, protection on.
- [ ] HP Sure Admin enabled, if available: download-only behaviour recorded.
- [ ] Does a `-Flash` run reboot by itself? **Pass:** no prompt, protection on. `bios` may open under Decision 7.

**H5. Firmware path.** [ ] Which HPIA category delivers firmware, and what happens to BitLocker? **Pass:** answered; if BitLocker is unaddressed, `firmware` stays closed.

### Lenovo: one ThinkPad and one ThinkCentre, used. Buy first (§8).

**L0. Spike, owed before W15 and W16.**
- [ ] Thin Installer: source, lifecycle, repository requirement; `-noreboot` with package types 1, 3, 4; does anything force a reboot or shutdown?
- [ ] LSUClient: is it acceptable to fetch a third-party PowerShell module at a pinned version? Filter by unattended install; confirm it never reboots.
- [ ] Commercial Vantage: conflict with Lenovo Vantage, default cadence.
- [ ] BitLocker behaviour on each, on both chassis. ThinkCentre BIOS shutdown request?
- **Pass:** owner picks a tool; recorded in spec §5 before any lane code.

**L1. Install or fetch**, [ ] publisher, host, redirects, version captured for the chosen tool.
**L2. Non-BIOS run**, [ ] drivers and applications, reports and exit codes captured, shutdown request carried as `shutdownRequired`.
**L3. BIOS**, [ ] **Lenovo says Thin Installer BIOS "cannot be deployed in an unattended mode"; expect this to stay closed.** Record what happens on both chassis. `bios` opens only on clean evidence.
**L4. Blocked ID**, [ ] package filtering works. **Pass:** all recorded, gates per evidence.

---

## Proposed registration

Do not register until this plan merges and the owner labels it `plan-approved`. **Parent:** `Vendor updates: keep Dell, Surface, HP and Lenovo tools running on a schedule`. Anchor context: #3855.

Sub-issue titles: one per wave, exactly the "Title" column above, prefixed `W01:` … `W17:`. Then add `tracking_issue:` to this frontmatter.

## Self-review

**Spec coverage:** §4.1 W05; §4.2 W07, W06 (takeover); §4.3 W03 T4; §4.4 W01, W02, W03; §4.5 W01 T3, W02 T3, T4, W06, W07 T4, W10, W11; §4.6 W08; §4.7 W03, W04 T2; §4.8 W03 T3, T4, W02 T5, W05 T2; §4.9 W04, W05 T6, W09; §5 W02, W10–W17; §6 flag and canary in W03 T4 and W10; §8 W07 and lab rules. §7's optional items (tool-version warning, restore-point wrapper) are left to the builder. Later (AI `manage_patches` action) is out of v1.

**Types:** `oem_update_run`, `OemDispatchRefusal`, `OemDisplayState`, `resolveOemUpdatesLinkForDevice`, `agentSupportsOemUpdates`, `Lane`, `ToolGate` use one spelling throughout.
