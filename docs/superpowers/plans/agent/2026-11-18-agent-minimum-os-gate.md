---
issue: 12169
blocks: 11943
status: draft (awaiting approval)
---

# Agent Minimum-OS Gate for Upgrades and the macOS pkg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent release records a minimum OS for each darwin artifact. The server never offers or dispatches a binary to a Mac below that floor and says so on the device page. The agent and the `.pkg` refuse such a binary themselves. All of this ships in a Go 1.26 "bridge" release before #11943 moves the toolchain to Go 1.27, which drops macOS 12.

**Architecture:** One checked-in declaration, `agent/platform-floors.json`, is the policy. A CI tripwire measures the Go toolchain's real floor and fails while the declaration is below it. The release workflow stamps the floor as `minOs` on each darwin asset in the **signed** `release-artifact-manifest.json`. The API stores it in a new nullable `agent_versions.min_os_version` column and gates every path that picks an agent binary through one pure function. The agent's updater and the pkg `preinstall` enforce the same signed value on the device. W3 pins `MACOSX_DEPLOYMENT_TARGET` to the floor, so the Mach-O headers agree with the policy and the release can check them.

**Tech Stack:** Hono/TypeScript API (Drizzle queries, hand-written SQL migration), Vitest, Go agent (`agent/internal/updater`, `agent/internal/heartbeat`), bash pkg scripts, GitHub Actions (`release.yml`, `security.yml`), Node `node --test` for release scripts, React (`DeviceInfoTab`, `DeviceList`), i18next (8 locales).

**Spec:** Issue #12169, plus the must-fix review comment on PR #11943. Read both. This plan **corrects one premise in both**, so read "Verified facts" before Task 1.1.

## Verified facts (2026-11-18, `origin/main` 78b4157c07)

1. **dyld does not enforce `minos` at launch.** On macOS 27.0.1, a C binary and a Go binary rewritten with `vtool -set-build-version macos 99.0 99.0` and re-signed ad hoc both launched and printed. The real risk on an unsupported macOS is a runtime or dynamic-symbol failure when the Go 1.27 runtime uses something macOS 12 lacks. That was not reproduced here (no macOS 12 host), so it is treated as unsupported, not as proven broken.
2. **The shipped darwin headers are not a policy.** The Mach-O headers of v0.100.0, v0.120.0, v0.128.0 and v0.129.0 were parsed:
   - `breeze-agent-`, `breeze-backup-` and `breeze-desktop-helper-darwin-*` declare `minos 26.0.0 sdk 26.5.0`. They are built with cgo on `macos-latest` with no `MACOSX_DEPLOYMENT_TARGET`.
   - `breeze-watchdog-darwin-*` declares `minos 12.0.0` (internal linker).
   - The v0.129 rc gate ran the `minos 26.0` agent on macOS 15.8.1 (lab Intel mini).
   - **Deriving the gate from today's headers would hold every Mac below macOS 26.** A CGO-off darwin build with go1.27.4 declares `minos 13.0`.
3. **macOS `os_version` looks like `darwin 15.8.1`.** gopsutil v3 `host_darwin.go` gives `kern.ostype` plus `sw_vers -productVersion`, and `collectors/hardware.go` `normalizeOSVersionBuild` joins them. If `sw_vers` fails, the string is just `darwin`.
4. **The macOS updater falls back to raw-binary replacement when `installer -pkg` fails** (`updater.go` `updateTo`, around line 1139). A `preinstall` refusal on its own therefore does not stop an auto-update. The updater must refuse before that point.
5. **`agent_versions` is a global, non-tenant table.** It has no `org_id`, no RLS, and is allowlisted in `rls-coverage.integration.test.ts`. The new column needs no RLS, cascade, merge or export-policy registration.
6. **`devices.update_offer_withheld_reason` already exists** (varchar(50), #6449, code `edition_unconfirmed`). It is written on transition at `heartbeat.ts` around line 1292, before targets resolve at around line 2131. Both UI surfaces render every reason with edition-specific copy.
7. **Hosted prod uses `BINARY_SOURCE=local`** and registers from the hosted official manifest (`registerFromOfficialManifest`). Self-host defaults to `BINARY_SOURCE=github` (`upsertVersion`). Local mode serves only the build in its volume (`isUpgradeTargetServable`).

## Global Constraints

- `agent/platform-floors.json` is the only place a floor is written by hand: `{"schemaVersion":1,"macos":"12.0"}`. #11943 must change `macos` to `"13.0"` in the same PR, and the tripwire (Task 1.1) makes that mandatory.
- Floor strings match `^\d{1,3}(\.\d{1,3}){0,2}$` everywhere (manifest, column CHECK, API parser, Go parser, pkg script). Compare them as numeric tuples, with missing parts as 0, so `13` equals `13.0` equals `13.0.0`.
- Assets that carry `minOs`: `breeze-(agent|backup|watchdog|desktop-helper)-darwin-(amd64|arm64)` and `breeze-agent-darwin-(amd64|arm64).pkg`. Do not stamp `-unsigned` signing inputs or Tauri `.dmg`/`.app.zip` files.
- `NULL`/absent `minOs` means "no floor known" and allows the offer. The exception is from `FIRST_RELEASE_WITH_MIN_OS` on, where a darwin asset without `minOs` is refused at registration (Task 1.3).
- **Unknown device OS** (unparseable, empty, or the compat value `10.16`): **allow, and log once per (platform, raw-shape) per process**, as the issue asks. See Open Decision 1. The advisor recommends holding instead.
- No step-down. A held device stays on its installed version (Open Decision 2).
- Reason code `os_below_minimum` (fits varchar(50)). The edition reason always wins. Each writer clears only its own code.
- Migration: `apps/api/migrations/2027-01-27-160000-agent-versions-min-os.sql`. Re-check at implementation time that it still sorts after the newest file on `origin/main` (`ls apps/api/migrations | LC_ALL=C sort | tail -3`). Then run `pnpm db:check-drift`.
- Any new en locale key goes into all 8 locales (en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR). Never write `t(cond ? 'a' : 'b')`: `keyUsage.test.ts` fails on it. Use two literal `t()` calls in branches.
- Public repo: no hostnames, IPs or customer names in code, tests or docs.

## Review Focus

1. **A Mac reporting `darwin 10.16`** (SYSTEM_VERSION_COMPAT), or a bare `darwin`, must read as *unknown*. Holding it as "10.16 < 12" would be wrong. Pinned in Task 1.4 (`parses compat 10.16 as unknown`, `bare darwin is unknown`).
2. **Two withhold writers on one column.** An OS hold must not clear an edition withhold, and an edition-clear must not clear an OS hold. Pinned in Task 1.5 (`edition reason wins over os hold`, `edition clear leaves os_below_minimum`).
3. **A failed target lookup must not clear an existing OS hold.** With `upgradeTargets === null`, nothing is written. Pinned in Task 1.5 (`lookup failure keeps os_below_minimum`).
4. **Re-registering a release must update `min_os_version`, and must not erase a known floor.** `onConflictDoUpdate` sets the floor when the manifest has one and keeps the existing value when it does not (`COALESCE`). Pinned in Task 1.3 (`re-registration updates min_os_version`, `pre-threshold re-registration keeps existing floor`).
5. **The pkg refusal happens before any service is stopped.** The floor check in `preinstall` precedes the first `launchctl`, so a refused install leaves the running agent and watchdog untouched. Pinned in Task 2.2 (`floor check precedes every launchctl call`).

---

## Wave plan and ship order

| Wave | Content | Ships | Depends on |
|---|---|---|---|
| **W1** | Declaration plus tripwire, manifest stamping, column, registration, API offer/dispatch/delivery gate, reason-aware UI copy | First. Must be in the bridge release. | — |
| **W2** | Agent backstop (updater refuses below-floor assets; cooldown) and pkg `preinstall` floor | Bridge release | W1 Task 1.2 (manifest `minOs`) |
| **W3** | `MACOSX_DEPLOYMENT_TARGET` pinned to the floor; release asserts each darwin Mach-O `minos` ≤ floor; macOS lab smoke on the oldest supported OS | Bridge release (recommended) | W1 Task 1.1 |
| **W4** | Device page detail: "held on vX: macOS Y is below Z, required by vW" | Any time after W1 | W1 |

**Bridge-release sequence (blocks #11943):**
1. Merge W1–W3 (and W4 if ready). Cut a release on Go 1.26.11 with floor `12.0`.
2. Promote it on US/EU. Wait until macOS 12 devices have reached it.
3. The hosted lane stamps `minOs` too (Open Decision 4).
4. Run the fleet query (Open Decision 3).
5. Only then merge #11943 with `macos: "13.0"`.

---

## W1 — API and release-metadata gate

### Task 1.1: Floor declaration, Mach-O reader, and the toolchain tripwire

**Files:**
- Create: `agent/platform-floors.json`
- Create: `scripts/release/macho-min-os.mjs` (CLI plus exported `readMachOMinOs(buf): string | null`)
- Create: `scripts/release/macho-min-os.test.mjs`
- Create: `scripts/release/check-darwin-floor.sh`
- Modify: `.github/workflows/security.yml` (new step after `Setup Go`, beside the Go-pin guard around line 236)
- Modify: `package.json`, adding `scripts/release/macho-min-os.test.mjs` to the `test:workflow-security` `node --test` list

**Interfaces:**
- Produces: `agent/platform-floors.json` `{ "schemaVersion": 1, "macos": "12.0" }`.
- Produces: `node scripts/release/macho-min-os.mjs <file>...`, which prints `{"<basename>":"<minos>|null"}` JSON. `readMachOMinOs` returns `"X.Y"` or `"X.Y.Z"` (patch dropped when 0), or null for non-Mach-O, fat, truncated input, or no version load command. It reads `LC_BUILD_VERSION` (0x32) and falls back to `LC_VERSION_MIN_MACOSX` (0x24). Accept magic `0xFEEDFACF` only (thin 64-bit LE).
- Produces: `check-darwin-floor.sh`. It builds a `package main` hello with `CGO_ENABLED=0 GOOS=darwin GOARCH=arm64` and `amd64` using the toolchain on PATH, reads both with the `.mjs`, and exits 1 when the measured `minos` is **greater than** `platform-floors.json .macos`. The message names both values and says "bump agent/platform-floors.json in the PR that raises the toolchain; this drops support for older macOS".

- [ ] **Step 1: Write the failing tests** in `macho-min-os.test.mjs`. Build buffers in-test: a 32-byte `mach_header_64` plus one load command.
  - `reads LC_BUILD_VERSION minos`: minos `0x000D0000` gives `"13.0"`; `0x000C0700` gives `"12.7"`; `0x000F0801` gives `"15.8.1"`.
  - `falls back to LC_VERSION_MIN_MACOSX`.
  - `returns null for fat, truncated, ELF, and no-version-command inputs`.
- [ ] **Step 2:** Run `node --test scripts/release/macho-min-os.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the `.mjs`, the floors file and the `.sh`. Wire the security.yml step `Check darwin toolchain floor is declared` as `bash scripts/release/check-darwin-floor.sh`.
- [ ] **Step 4:** Run the tests, then run `bash scripts/release/check-darwin-floor.sh` with the pinned Go 1.26.11. Expected: PASS (12.0 ≤ 12.0). Check the control: with go1.27.4 on PATH, expect exit 1 naming `13.0 > 12.0`. Record both outputs in the PR body.
- [ ] **Step 5:** Commit `feat(release): declare the macOS floor and trip on a toolchain that raises it (#12169)`.

### Task 1.2: Stamp `minOs` into the signed release manifest

**Files:**
- Modify: `.github/workflows/release.yml`:
  - the manifest-generation Python around lines 2867–3046;
  - the `Verify signing-input manifest entries` guard around line 3052;
  - fix the stale comment at line 279 ("runs on macOS 12+") to "weak-links ScreenCaptureKit; the supported floor is agent/platform-floors.json".

**Interfaces:**
- Produces: each manifest asset matching the Global Constraints set gets `"minOs": "<platform-floors.json .macos>"`. The value is read once from the checked-out file. The step fails if the file is missing or the value is malformed.

- [ ] **Step 1:** Add assertions to the guard step: every asset in the stamped set has `minOs == floor`; no other asset has a `minOs` key. Prove the guard is red by running that Python locally against a manifest fixture without `minOs` (the inline script can run against a tmp `release-assets/`). Expected: AssertionError.
- [ ] **Step 2:** Add the stamping (`MIN_OS_ASSET_RE`, `entry["minOs"] = floor`). Re-run the local fixture. Expected: PASS. Run `pnpm test:workflow-security`. Expected: PASS.
- [ ] **Step 3:** Commit `feat(release): stamp the macOS floor on darwin assets in the signed manifest (#12169)`.

### Task 1.3: Column, manifest parsing, and every registration path

**Files:**
- Create: `apps/api/migrations/2027-01-27-160000-agent-versions-min-os.sql`
- Modify: `apps/api/src/db/schema/agentVersions.ts`
- Modify: `apps/api/src/services/releaseArtifactManifest.ts`:
  - asset type;
  - `VerifiedReleaseArtifact`;
  - `verifyReleaseArtifactManifestAsset`;
  - new `FIRST_RELEASE_WITH_MIN_OS`;
  - new `ReleaseManifestMinOsMissingError extends ReleaseAssetNotDistributableError`.
- Modify: `apps/api/src/services/binarySync.ts`:
  - `getReleaseAssetMetadata`;
  - `UpsertMetadata` (around line 2600);
  - `applyDeploymentSigning`;
  - `upsertVersion`;
  - `backfillBackupRowsForVersion`;
  - `registerFromOfficialManifest`;
  - `registerLocalBinaries` (re-signed `manifestObj` carries `minOs` when known).
- Modify: `apps/api/src/routes/agentVersions.ts`:
  - `POST /` derives `minOsVersion` from a schema-v1 manifest;
  - `POST /promote` refuses a darwin agent/backup/watchdog row at or above the threshold with a NULL floor (409, `reason: "min_os_missing"`);
  - `GET /` lists `minOsVersion`.
- Test: `releaseArtifactManifest.test.ts`, `binarySync.test.ts`, `agentVersions.test.ts`

**Interfaces:**
- Produces: column `agent_versions.min_os_version varchar(16) NULL` with CHECK `min_os_version IS NULL OR min_os_version ~ '^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$'`. Drizzle: `minOsVersion: varchar('min_os_version', { length: 16 })`.
- Produces: `VerifiedReleaseArtifact.minOs: string | null`. A malformed value throws `ReleaseManifestAssetLookupError` (present but bad means refuse; D4 precedent).
- Produces: a new verify arg `requireDarwinMinOs?: boolean`. Only the three registration callers pass `true`. When the asset is in the stamped set, the release is not `releasePredates(release, FIRST_RELEASE_WITH_MIN_OS)`, and `minOs` is absent, throw `ReleaseManifestMinOsMissingError`. The serving path (`validateReleaseManifest`) never passes it.
- `FIRST_RELEASE_WITH_MIN_OS`: the first tag cut after W1 merges. Read `gh release list` at implementation time and set the next unreleased minor.

**Migration header must say:** `agent_versions` is a **global, non-tenant release catalog** with no `org_id` and no RLS (allowlisted in `rls-coverage.integration.test.ts`). So: no policies, no cascade/merge/export registration. The column is nullable with no default and no backfill, and no rows are written, so no `breeze.scope` election is needed (still add the line for replay safety per README). Use an idempotent `ADD COLUMN IF NOT EXISTS` and a `pg_constraint`-guarded CHECK, following the shape of `2027-01-27-140000-device-control-plane-block.sql`.

- [ ] **Step 1: Write the failing tests:**
  - `verifyReleaseArtifactManifestAsset returns minOs for a stamped darwin asset` (`"12.0"`).
  - `rejects malformed minOs` (`"12.x"` throws `ReleaseManifestAssetLookupError`).
  - `requireDarwinMinOs refuses a post-threshold darwin asset without minOs` (`ReleaseManifestMinOsMissingError`).
  - `pre-threshold darwin asset without minOs verifies with minOs null`.
  - binarySync: `upsertVersion writes min_os_version from the verified asset`; `re-registration updates min_os_version`; `pre-threshold re-registration keeps existing floor` (conflict set uses `sql\`COALESCE(excluded.min_os_version, agent_versions.min_os_version)\``); `registerFromOfficialManifest records minOs and excludes a post-threshold darwin asset missing it` (lands in `excludedFilenames`, reported with `manifest_refusal_reason: "not-distributable"`); `backfillBackupRowsForVersion carries minOs`.
  - routes: `promote refuses a post-threshold darwin row with NULL min_os_version` (409 `min_os_missing`, nothing demoted); `GET / lists minOsVersion`.
- [ ] **Step 2:** Run `pnpm --filter @breeze/api exec vitest run src/services/releaseArtifactManifest.test.ts src/services/binarySync.test.ts src/routes/agentVersions.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Write the migration, then run `pnpm db:migrate && pnpm db:check-drift`.
- [ ] **Step 4:** Re-run the step-2 command. Expected: PASS. Also run `pnpm --filter @breeze/api exec vitest run src/db/migrationRlsScope.test.ts src/db/migrationOrdering.test.ts`.
- [ ] **Step 5:** Commit `feat(api): record each release's minimum OS on agent_versions (#12169)`.

### Task 1.4: The OS-floor evaluator (pure)

**Files:**
- Create: `apps/api/src/services/agentOsFloor.ts`
- Test: `apps/api/src/services/agentOsFloor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DeviceOsFacts { platform: string; reportedOsVersion: string | null; storedOsVersion: string | null }
  export type OsFloorDecision =
    | { kind: 'allow' }
    | { kind: 'hold'; requiredOs: string; reportedOs: string }
    | { kind: 'unknown_os'; requiredOs: string; rawOs: string | null };
  export function parseDeviceOsVersion(platform: string, raw: string | null): number[] | null;
  export function compareOsVersions(a: number[], b: number[]): number;
  export function evaluateOsFloor(device: DeviceOsFacts, minOs: string | null): OsFloorDecision;
  export function noteUnknownDeviceOs(platform: string, raw: string | null, requiredOs: string): void; // deduped console.warn + one captureMessage per shape per process
  ```
- Parsing (macOS only; any other platform returns null): trim; strip a leading `darwin`, `macos` or `mac os x` token (case-insensitive); the rest must match `^\d{1,3}(\.\d{1,3}){0,2}$`. `[10,16]` gives null (compat sentinel). The beat value is tried first, then the stored value.
- `evaluateOsFloor`: null `minOs` gives allow; parsed below the floor gives hold; unparseable gives `unknown_os`. Callers treat `unknown_os` as allow and call `noteUnknownDeviceOs` (Global Constraints; Open Decision 1).

- [ ] **Step 1: Write the failing tests:**
  - `holds darwin 12.7.6 below 13.0`; `allows darwin 13.0`; `allows 13 vs floor 13.0.0`.
  - `parses compat 10.16 as unknown`; `bare darwin is unknown`.
  - `falls back to the stored version when the beat omits it`; `null floor always allows`.
  - `non-macos platform is unknown_os when a floor exists`; `noteUnknownDeviceOs warns once per shape`.
- [ ] **Step 2:** Run `pnpm --filter @breeze/api exec vitest run src/services/agentOsFloor.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): pure minimum-OS evaluator for agent offers (#12169)`.

### Task 1.5: Gate both resolvers, persist the hold, cover every offer caller

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts`. In `resolvePinnedUpgradeTarget` and `resolvePinnedUpgradeTargets`, select `minOsVersion` in the same statement (no extra query) and apply the gate after `servableTargetOrNull`.
- Modify: `apps/api/src/routes/agents/heartbeat.ts`:
  - edition writer (around line 1292): owns only `edition_unconfirmed`;
  - watchdog branch (around lines 1054 and 1130): pass `deviceOs`, no persistence;
  - main branch (around line 2131): collect holds, then do a transition-only write;
  - edition migration (around line 2472): pass `deviceOs`.
- Modify: `apps/api/src/services/aiToolsAgentMgmt.ts` (select `devices.osVersion`; a hold becomes an `errors[d.id]` string)
- Modify: `apps/api/src/routes/agents/heartbeatTestHarness.ts` (resolver mocks accept the new args)
- Test: `apps/api/src/routes/agents/helpers.osFloor.test.ts` (new), `heartbeat.test.ts`, `aiToolsAgentMgmt` test, `__tests__/integration/agentVersionsBatchParity.integration.test.ts`, `agentHotPathQueryBudget.integration.test.ts` (counts must not change)

**Interfaces:**
- Consumes: `evaluateOsFloor`, `DeviceOsFacts`, `noteUnknownDeviceOs` (Task 1.4); the `min_os_version` column (Task 1.3).
- Produces: both resolvers take a **required** `deviceOs: DeviceOsFacts`, so tsc finds every caller, and an optional `onOsHold?: (hold: UpgradeOsHold) => void`. Export `interface UpgradeOsHold { component: string; blockedVersion: string; requiredOs: string; reportedOs: string }`. On a hold the resolver returns `null` for that component and calls `onOsHold`. Pins get no exception: a pinned version above the floor is held too.
- Produces: `export const OS_BELOW_MINIMUM_REASON = 'os_below_minimum'` (heartbeat.ts, beside `EDITION_OFFER_WITHHELD_REASON`).
- Heartbeat device OS: `{ platform: device.osType, reportedOsVersion: data.osVersion ?? null, storedOsVersion: device.osVersion }`.
- Persistence after resolution: only when `acceptsServedEdition && upgradeTargets !== null`. Desired = an agent or watchdog hold → `os_below_minimum`, else null. Write `updateOfferWithheldReason`/`Since` with one `db.update(devices)` only when the stored reason is not `edition_unconfirmed` and differs from desired. The edition writer at line 1292 sets `edition_unconfirmed`, and clears only when the stored value **is** `edition_unconfirmed`.

- [ ] **Step 1: Write the failing tests:**
  - helpers: `macOS 12 device is not offered a 13.0 agent and onOsHold reports it` (`osType 'macos'`, `osVersion 'darwin 12.7.6'`, row `min_os_version '13.0'` gives `null`, hold `{component:'agent', blockedVersion, requiredOs:'13.0', reportedOs:'12.7.6'}`).
  - `macOS 13 device is offered it`; `NULL floor offers`; `unknown OS offers and warns once`.
  - `pinned version above the floor is held`; `watchdog component is gated the same way`.
  - `batch and single resolvers agree under a floor` (extend the batch-parity integration suite).
  - heartbeat: `macOS 12 beat gets no upgradeTo and persists os_below_minimum`; `edition reason wins over os hold`; `edition clear leaves os_below_minimum`; `lookup failure keeps os_below_minimum`; `os hold clears when the device upgrades its OS`; `steady-state held beat writes nothing`; `watchdog-branch recovery offer is gated`.
  - AI tool: `trigger_agent_upgrade refuses a held Mac with the floor in the error`.
- [ ] **Step 2:** Run `pnpm --filter @breeze/api exec vitest run src/routes/agents/helpers.osFloor.test.ts src/routes/agents/heartbeat.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Run the API typecheck the way CI does (turbo). Watch the exit code: a heap OOM piped to `tail` reads as green.
- [ ] **Step 4:** Re-run the step-2 tests and the AI tool test. Expected: PASS. Run the integration suites `agentVersionsBatchParity` and `agentHotPathQueryBudget` per `docs/agents/testing.md`. Expected: PASS with unchanged statement counts.
- [ ] **Step 5:** Commit `feat(api): hold Macs below a release's minimum OS on their current agent (#12169)`.

### Task 1.6: Gate exact-version dispatch and queued-command delivery

**Files:**
- Create: `apps/api/src/services/agentOsFloorCommands.ts`
- Modify: `apps/api/src/services/commandQueue.ts` (next to `agentBinaryUpdateDispatchRefusal`, around line 1360)
- Modify: `apps/api/src/services/commandClaimEligibility.ts` (`revalidateCommandForDelivery`, around line 462)
- Test: `agentOsFloorCommands.test.ts`, plus one case each in the commandQueue and commandClaimEligibility suites

**Interfaces:**
- Produces: `export async function agentOsFloorRefusal(reader: Pick<Tx,'select'>, row: { type: string; deviceId: string; payload: unknown }): Promise<typeof OS_BELOW_MINIMUM_REASON | null>`.
  - Applies to `update`, `update_agent` (component `agent`) and `update_watchdog` (component `watchdog`).
  - Version: `payload.version` when present, else the promoted row for this edition.
  - Reads the device's `osType`/`osVersion`/`architecture` and the matching `agent_versions` row, then calls `evaluateOsFloor`.
  - `agent_rollback_v1` and `dev_update` are out of scope. Rollback installs older signed artifacts; dev push is dev-only.

- [ ] **Step 1: Write the failing tests:** `refuses update_agent to a 13.0 build on darwin 12.7.6`; `allows on darwin 13.1`; `version-less payload is judged by the promoted row`; `queued update_agent is refused at delivery after the release is promoted`; `rollback and dev_update are untouched`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. At dispatch, return `{ ok:false, result:{ status:'failed', error:'os_below_minimum' } }`. At delivery, return the refusal (same shape as `isolationUpgradeFloorRefusal`).
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): refuse agent-binary commands below the release's minimum OS (#12169)`.

### Task 1.7: Reason-aware withheld copy

**Files:**
- Modify: `apps/web/src/components/devices/DeviceInfoTab.tsx` (around line 1448)
- Modify: `apps/web/src/components/devices/DeviceList.tsx` (around lines 2259 and 2556)
- Modify: `apps/web/src/locales/*/devices.json` (8 locales). New keys: `deviceInfoTab.updateOfferWithheldOs`, `deviceList.updateWithheldTooltipOs`.
- Test: `DeviceInfoTab.test.tsx`, `DeviceList.statusHealthBadges.test.tsx`

**Copy (en):**
- `updateOfferWithheldOs`: "Agent updates are on hold for this device (since {{since}}): its macOS version is below the minimum the current agent release requires, so it stays on its installed agent version. Upgrade macOS to resume agent updates."
- `updateWithheldTooltipOs`: "Updates are on hold because this device's macOS version is below the minimum the current agent release requires."

- [ ] **Step 1: Write the failing tests:** `os_below_minimum renders the OS copy, not the edition copy`; `edition_unconfirmed keeps the edition copy`; the list tooltip has the same pair.
- [ ] **Step 2:** Run `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceInfoTab.test.tsx src/components/devices/DeviceList.statusHealthBadges.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement the branches with literal keys, and translate into all 8 locales.
- [ ] **Step 4:** Re-run, plus the locale key-parity and key-usage tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): say when an agent update is held for the device's macOS version (#12169)`.

**W1 done when:** full `test-api` and `test-web` are green, and the PR body states:
- the floor's home is `agent/platform-floors.json`;
- `agent_versions` is global, so nothing was registered for cascade or export;
- the before/after: 0 places gate on OS before, 1 evaluator used by 6 callers after.

---

## W2 — Agent and pkg backstop

### Task 2.1: The updater refuses a below-floor asset before download

**Files:**
- Modify: `agent/internal/updater/updater.go`: `releaseArtifactAsset` and `updateManifest` gain `MinOS string \`json:"minOs,omitempty"\``; `downloadBinary` around line 1550 checks right after manifest verification, before any bytes are fetched.
- Create: `agent/internal/updater/osfloor.go` (pure compare), `osfloor_darwin.go` (`hostOSVersion()` via `syscall.Sysctl("kern.osproductversion")`, `sync.OnceValues`), `osfloor_other.go` (returns `""`).
- Modify: `agent/internal/updater/typed_errors.go` (add `ErrOSBelowMinimum`, include it in `IsDeterministicArtifactFailure`).
- Modify: `agent/internal/agentapp/first_install_release.go` (`verifyFirstInstallManifest`, line 263: same check on the asset).
- Test: `agent/internal/updater/osfloor_test.go`, `updater_test.go`, `agent/internal/agentapp/first_install_release_test.go`

**Interfaces:**
- Produces: `func checkHostOSFloor(minOS, hostVersion string) error`. It returns `trustErrorf(ErrOSBelowMinimum, "release requires macOS %s; this host runs %s", ...)` when the host is below the floor, and nil when `minOS == ""` or the host version is unparseable (logged once).
- Because `downloadBinary` is shared by `UpdateTo`/`UpdateToWithOptions`, `DownloadBinary` (watchdog install and repair via `downloadWatchdogBinaryTo`), backup prefetch, and the watchdog's own failover `u.UpdateTo`, one check covers all of them. The refusal comes before the backup, before the update marker, and before `installViaPkg`, so the raw-binary fallback is never reached.

- [ ] **Step 1: Write the failing tests:** `checkHostOSFloor holds 12.7.6 below 13.0`; `empty floor allows`; `unparseable host allows`; `UpdateTo with a 13.0 asset on a 12.7 host returns ErrOSBelowMinimum and leaves the binary, backup and marker untouched` (inject the host version via a package var seam); `DownloadBinary refuses the same way`; `IsDeterministicArtifactFailure(ErrOSBelowMinimum) is true`; `first install refuses a below-floor companion`.
- [ ] **Step 2:** Run `cd agent && go test -race ./internal/updater/... ./internal/agentapp/...`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, plus `GOOS=windows go vet ./internal/updater/...`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(agent): refuse an update whose signed manifest needs a newer macOS (#12169)`.

### Task 2.2: pkg `preinstall` floor

**Files:**
- Create: `agent/installer/macos/os-floor.sh` (sourced; function `breeze_os_floor_check <current> <minimum>` returns 0 allow, 1 refuse, 2 unknown)
- Create: `agent/installer/macos/os-floor.test.mjs`
- Modify: `agent/installer/macos/preinstall` (source the file and check before the first `launchctl`)
- Modify: `agent/installer/macos/build-pkg.sh`. Add an 8th arg `<min-macos>`, validated against the floor regex. Copy `os-floor.sh` into `$SCRIPTS`. Render `__BREEZE_MIN_MACOS__` in the scripts copy of `preinstall`.
- Modify: `.github/workflows/release.yml` (around line 1007: pass `"$(jq -r .macos agent/platform-floors.json)"`)
- Modify: `package.json` (add the test to `test:workflow-security`)

**Behavior:**
- `preinstall` reads `SYSTEM_VERSION_COMPAT=0 /usr/bin/sw_vers -productVersion`.
- On refuse (1), it prints to stderr "Breeze Agent requires macOS <min> or later. This Mac runs macOS <current>." and exits 1.
- On unknown (2) or an unrendered placeholder, it logs and continues.

- [ ] **Step 1: Write the failing tests** (node runs `bash -c 'source os-floor.sh; breeze_os_floor_check A B'`):
  - `12.7.6 vs 13.0 refuses`; `13.0 vs 13.0 allows`; `15.8.1 vs 13.0 allows`; `empty is unknown`.
  - `floor check precedes every launchctl call in preinstall` (line order in the file).
  - `build-pkg.sh rejects a malformed floor`.
- [ ] **Step 2:** Run `node --test agent/installer/macos/os-floor.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS. On a Mac, run `build-pkg.sh` with dummy binaries and floor `99.0`, then `sudo installer -pkg … -target /` on a host *without* Breeze. Expected: install fails with the message, and nothing is written.
- [ ] **Step 5:** Commit `feat(installer): macOS pkg refuses hosts below the release's minimum OS (#12169)`.

**W2 lab gate (before the bridge release):** on the oldest supported macOS (12.x VM, Open Decision 5), with a test release whose floor is set to 13.0:
- the server holds the device;
- a forced `update_agent` is refused at dispatch;
- the agent refuses a hand-fed below-floor manifest;
- the pkg refuses with the agent and watchdog still running.

Record the evidence in the PR.

---

## W3 — Make the headers match the floor

### Task 3.1: Pin `MACOSX_DEPLOYMENT_TARGET` and check every darwin Mach-O

**Files:**
- Modify: `.github/workflows/release.yml`. In the `build-agent` darwin steps (agent around line 281, backup around line 301, desktop-helper around line 341), add a prior step that reads `jq -r .macos agent/platform-floors.json` into `MACOSX_DEPLOYMENT_TARGET`. In `create-release`, before the manifest Python, run `node scripts/release/macho-min-os.mjs release-assets/breeze-*-darwin-{amd64,arm64}` and fail if any value is null or **above** the floor (lower is compatible).
- Modify: `.github/workflows/ci.yml` (darwin build around line 2278) and `.github/workflows/dev-build-agent.yml` (around line 186) the same way, so CI and dev builds match release.

- [ ] **Step 1:** Prove the release check is red against the v0.129.0 headers: run `macho-min-os.mjs` on the downloaded first 64 KB of each darwin asset (`curl -r 0-65535`). Expected: `26.0` > `12.0`, and the check fails.
- [ ] **Step 2:** Add the env pin and the check. On a `macos-latest` CI run, the built agent, backup and desktop-helper read `12.0` and the watchdog reads `12.0`. Expected: PASS.
- [ ] **Step 3:** macOS smoke: install the CI-built pkg on the oldest supported macOS (12.x VM) and on macOS 15 Intel (lab mini). Check that the agent enrolls, the desktop helper starts, and Remote Desktop opens. Then upgrade from the previous release through the agent. Record the evidence.
- [ ] **Step 4:** Commit `build(agent): pin the macOS deployment target to the declared floor and verify each binary (#12169)`.

---

## W4 — Device page detail

### Task 4.1: "Held on vX" detail at read time

**Files:**
- Create: `apps/api/src/services/agentOsHoldDetail.ts`
- Modify: `apps/api/src/routes/devices/core.ts` (detail payload, beside `controlPlaneBlock` around line 1629)
- Modify: `apps/web/src/components/devices/DeviceInfoTab.tsx` (`DeviceInfo` type plus the notice)
- Modify: 8 locales, key `deviceInfoTab.updateOfferWithheldOsDetail`

**Interfaces:**
- Produces: `deriveOsHoldDetail(device): Promise<{ heldOnVersion: string; blockedVersion: string; requiredOs: string; reportedOs: string } | null>`. It runs only when `device.updateOfferWithheldReason === 'os_below_minimum'`. It resolves the device's **current** target with `getOrgAgentUpdateConfigCached` (pin) and `resolvePinnedUpgradeTarget({ …, onOsHold })`.
- en copy: "Held on {{heldOnVersion}}: macOS {{reportedOs}} is below macOS {{requiredOs}}, which the current target {{blockedVersion}} requires."

- [ ] **Step 1: Write the failing tests:** `detail is null unless the reason is os_below_minimum`; `detail names held, blocked, required and reported versions`; `web renders the detail line under the notice`.
- [ ] **Step 2:** Run the API and web tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit `feat: show which agent release a Mac is held from and why (#12169)`.

---

## Open Decisions

1. **Unknown device OS: allow + log (as the issue asks) or hold?** This plan implements allow + log. The Codex advisor (gpt-6.2-astra) dissents. Its argument: allowing an upgrade for an unknown OS can strand an older agent that lacks the W2 backstop, while a hold is visible and reversible. In practice an unknown OS means `sw_vers` failed (`darwin` with no version) or the compat value `10.16`. **Recommend hold for macOS when the target has a floor, with the device notice saying "macOS version unknown".** It is a one-branch change in `evaluateOsFloor` and its tests.
2. **Step-down to "the newest release that supports it".** Dropped from this plan. "Newest registered below promoted" can pick an RC or a build an operator deliberately skipped (registration ≠ promotion). It also cannot work on hosted local mode, which serves only one build. **Recommend holding on the installed version, and getting Macs onto the newest compatible build through the bridge-release sequence.** Revisit only if the fleet query shows stragglers. A real fix would need an explicitly promoted per-floor fallback target.
3. **Fleet check before #11943 (Todd, read-only prod).** Run this on US and EU with system scope:
   ```sql
   SELECT split_part(regexp_replace(os_version, '^(darwin|macos)\s+', '', 'i'), '.', 1) AS macos_major, count(*)
   FROM devices WHERE os_type = 'macos' AND decommissioned_at IS NULL GROUP BY 1 ORDER BY 1;
   ```
   A zero count for major 12 makes this plan a safeguard rather than a blocker. It still has to ship for self-hosters.
4. **Hosted lane (outside this repo).** The private hosted build must stamp `minOs` on its darwin assets the same way, or Task 1.3 refuses its post-threshold darwin rows. That fails closed: Macs stay on their version, and the refusal is reported to Sentry. **Recommend keeping the fail-closed refusal** so a forgotten stamp is loud rather than silently ungated. Verify the registered hosted rows (`SELECT version, platform, architecture, component, min_os_version FROM agent_versions WHERE platform='macos' ORDER BY created_at DESC LIMIT 12`) before promoting #11943. The hosted lane's own Go pin must also move with #11943.
5. **A macOS 12 test host.** The lab mini moved from 12.7.6 to 15.8.1 on 11-01. W2 and W3 need a Monterey VM (UTM or tart on Apple Silicon). **Recommend creating one before the bridge release.**
6. **Windows/Linux floors.** The column and evaluator are platform-generic, but only `macos` is declared and parsed. Go 1.27 does not change those floors as far as this review found. **Recommend deferring** until a toolchain or dependency change raises them. Then add a `windows` key, parsing `os_build`, and a `linux` key, parsing the kernel.
7. **`LSMinimumSystemVersion` in the GUI installer app is already `13.0`** (`agent/installer/macos-app/Resources/Info.plist`), above today's floor of `12.0`. The app already refuses macOS 12 while the pkg accepts it. **Recommend leaving the app alone.** It aligns once #11943 sets the floor to 13.0. W3 could later render it from `platform-floors.json`.

## Self-review notes

- Issue coverage:
  - per-platform minimum recorded per release: Tasks 1.1–1.3;
  - offer holds and says so on the device page: 1.5, 1.7 and 4.1;
  - pkg `preinstall` refuses: 2.2;
  - test of a macOS 12 device not offered a 1.27-built release: 1.5 Step 1, first case.
- The "newest release that supports it" wording is deliberately narrowed (Open Decision 2).
- The #11943 review's premise ("dyld refuses to load") is corrected by Verified fact 1. The gate is still required: Go 1.27 does not support macOS 12.
