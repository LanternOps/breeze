---
amends: docs/superpowers/plans/vuln-patch/2026-11-05-oem-vendor-updates.md
tracking_issue: LanternOps/breeze#11065
waves: [W12 #11077 Surface, W14 #11079 HP, W15 #11080 Lenovo tool, W16 #11081 Lenovo lane, W17 #11082 Lenovo lab]
companion_amendments:
  - docs/superpowers/plans/devices/2026-10-31-wake-on-lan-management-observe-first-amendment.md
  - docs/superpowers/plans/device-lifecycle/2026-09-10-hp-warranty-cmsl-w01-lab-probe-and-ingest-hardening-observe-first-amendment.md
status: draft for owner approval (2026-11-19)
---

# Vendor updates: observe-first amendment for Surface, HP and Lenovo (W12, W14–W17)

## Why this exists

The plan makes each non-Dell vendor's last wave a lab wave run on a used unit "nobody relies on" (Lab legs Todd owes; spec §8). On 2026-11-19 the owner decided not to buy that hardware. Instead, each vendor gets a best-guess implementation released in two steps. Each step is enabled only for **our own tenant**: one partner, identified by an env value and never named in this repo.

- **Step 1, OBSERVE.** The agent detects the vendor's tooling and reads versions, settings, capabilities and pending updates. It reports a structured, bounded, redacted observation. It does not write, install, flash or reboot.
- **Step 2, ACT.** Once the observations confirm the guesses, the write path opens for that same tenant only. Other partners come later.

This amendment is also the home of the **shared gating design** (§1). The WOL and HP-warranty amendments consume it.

### Plan and spec rules this overrides, for Surface, HP and Lenovo only

| Rule | Amended to |
|---|---|
| Global Constraints: "No scan-only mode (§2)" | Still true for users: no policy setting or UI offers scan-only. `oem_observe` is an internal canary instrument that runs only at stage `observe`, only for canary partners. |
| Lab legs run on "lab machines nobody relies on" (§8); W12/W14/W17 are owner lab waves | The read-side legs become observe (§4 map). The write-side legs become the **first act run** on one owner-chosen device in our own tenant, under the protocol in §3. Dell is unchanged: W10 stays a lab wave, and the lab Dell exists. |
| Decision 3: "W15–W17 do not start until answered"; spec §5 "spike on real hardware before any lane code" | W15 becomes a desk decision backed by vendor evidence (§6 D-OEM-1, for the owner) plus Lenovo observe on real ThinkPads and ThinkCentres in our own tenant. W16 lane code is written after the decision and against observed catalog data. |
| Manifest gates are `open \| closed` | Adds `canary`: open only for partners whose `vendorStage` is `act` (§1.3). |

### Already on `main` (checked at `190c74a001`)

- **Merged:** W01–W09, W11 (Surface lane, BitLocker guard, Windows Update driver search) and W13 (HP lane: HPIA, plus an inert BIOS path).
- **Manifest:** every gate is closed. `SHIPPED_OEM_LANES = ['dell','surface','hp']`.
- **Env locks:** `BREEZE_OEM_UPDATES_ENABLED`, `BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST`, `…_DISABLED_LANES` and `…_LAB_DEVICE_IDS`. The last of these is refused in production. All are in `services/oemUpdates/flags.ts`.
- **Run Now** dispatches with or without a policy (`dispatch.ts:168`).

### Fleet in our own tenant

Read-only production query, 2026-11-19. Counts and models stay out of the repo.

- **Dell:** well represented, mostly business models from 2019 or later. Not in scope here.
- **Lenovo:** mostly commercial ThinkCentre and ThinkPad, plus a few consumer models. This is enough for Lenovo observe and act.
- **HP:** consumer lines only. HPIA, CMSL and HP's BIOS tooling target business models, so **HP observe is expected to report "platform unsupported" on every device.** §3 states what that still teaches.
- **Surface:**
  - Both ARM64 (Snapdragon) and Intel Surface units.
  - Hyper-V guests that report `Microsoft Corporation` also show up and must be excluded. Applicability already does this.
  - The Windows agent is built **amd64 only** (`agent/Makefile:68`), so on ARM64 it runs under x64 emulation. Whether the Windows Update COM search and `manage-bde` behave the same there is **not confirmed**, and observe records it.

---

## 1. Gating mechanism (shared by all three amendments)

### 1.1 Choice

**The precedent we reuse** is the per-partner env allowlist checked server-side at dispatch: `BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST` in `apps/api/src/services/oemUpdates/flags.ts:21-30`.
- It is validated in `config/validate.ts` (around `:912`, with a refine around `:2616`).
- It is mapped in `docker-compose.yml` and `deploy/docker-compose.prod.yml`.
- It is folded into `oemGatesFingerprint` (`policySideStore.ts:120`).

We combine it with the code-only gate table in `services/oemUpdates/toolManifest.ts`, where only a reviewed PR with evidence opens a gate. The same env shape is used by `NETWORK_ISOLATION_ENABLED_PARTNER_IDS` (`services/networkIsolation/gates.ts:7-10`).

**New shared module: `apps/api/src/services/vendorCanary.ts`**

```ts
type VendorFeature = 'oem_updates' | 'wake_on_lan' | 'hp_warranty';
type VendorStage = 'off' | 'observe' | 'act';
// Code table; only a PR carrying observe evidence changes an entry.
export const VENDOR_STAGES: Readonly<Record<VendorFeature, Partial<Record<string, Exclude<VendorStage,'off'>>>>> = {
  oem_updates: { surface: 'observe', hp: 'observe', lenovo: 'observe' },
  wake_on_lan: { hp: 'observe', lenovo: 'observe', surface: 'observe' },
  hp_warranty: { hp: 'observe' },
};
export function vendorStage(feature: VendorFeature, vendor: string, partnerId: string | null): VendorStage;
export function vendorCanaryFingerprint(): string; // partner list + disabled list + VENDOR_STAGES
```

**Environment variables:**
- `BREEZE_VENDOR_CANARY_PARTNER_IDS` lists who. It is comma-separated canonical UUIDs, at most 3, and empty by default, which means every stage is `off`.
  - `validate.ts` refuses a malformed value at boot.
  - Unlike `…_LAB_DEVICE_IDS`, it **is allowed in production**, because that is its purpose.
  - It goes in both compose files, `.env.example` and `deploy/.env.example`, with a placeholder value.
- `BREEZE_VENDOR_CANARY_DISABLED`, for example `oem_updates:hp,wake_on_lan:lenovo`, is a kill switch. It needs no code release, but the API and worker containers must be recreated with the new env. It stops new dispatch and delivery. It never recalls a run already claimed, which matches the plan's §4.5 rule.

**`vendorStage` returns `VENDOR_STAGES[feature][vendor]`** only when all three hold: the partner is in the list, the pair is not disabled, and the table has an entry. Otherwise it returns `off`.

**Widening** past our own tenant is a separate decision for each feature and vendor pair, and it uses that feature's existing switches. For vendor updates, that means the manifest gate moves from `canary` to `open` and the existing partner allowlist applies. Widening removes the `VENDOR_STAGES` entry.

### 1.2 How the agent learns (vendor updates): per command, no heartbeat field

**Observe uses a new command type, `oem_observe`.** It is **not** a mode on `oem_update_run`.
- The existing runner writes a durable marker before preflight, can fetch and install tooling, and owns the flash guard and reboot accounting (`agent/internal/oemupdates/runner.go:65`).
- A separate handler that cannot import those paths is a structural guarantee. A mode flag would only be a branch.

**Delivery:**
- `oem_observe` is sent only to agents at or above `agentSupportsOemObserve`, its own minimum version.
- An older agent never receives it.
- An agent that does not know the type rejects it as unknown, which is the existing behaviour.

### 1.3 Precedence

**`oem_observe` dispatch,** in `services/oemUpdates/observe.ts`, a new sibling of `dispatch.ts`. Checks run in order, and the first failure refuses:

1. Device found, and `expectedOrgId` matches → otherwise `device_not_found`.
2. `oemUpdatesEnabled(partnerId)`: the existing master flag plus the existing allowlist → `flag_off`.
3. `vendorStage('oem_updates', lane, partnerId) ∈ {observe, act}` → `not_canary`.
4. Not ephemeral, not parked, not decommissioned → the existing refusals.
5. **Observe applicability** (`resolveObserveApplicability`). It uses the same anchored manufacturer and model matching as W03 T4, but does **not** require the lane to be in `SHIPPED_OEM_LANES`, so Lenovo can be observed before its lane exists. Consumer HP is still matched as `hp`, because observing it is the point → `not_applicable`.
6. `laneDisabledByKillSwitch(lane)`, or the canary pair disabled → `kill_switch`.
7. `agentSupportsOemObserve` → `agent_too_old`.
8. **Effective opt-in:** the device resolves an armed `oem_updates` link through `resolveOemUpdatesLinkForDevice`, and the link does not exclude the lane → `no_policy`. **This holds for Run Now too.** Observe never runs on a device outside a policy, even though `oem_update_run` Run Now can.
9. Online → `offline`.
10. No `oem_observe` for this device and lane in the last 24 h, or already in flight → `recent_observation`.

**Observe does not consult manifest gates or categories.** It installs nothing, so there is nothing for a gate to protect.

**Claim recheck.** Checks 2, 3, 6 and 8 run again at claim, over both HTTP and WebSocket, in `services/oemUpdates/revalidation.ts` and `commandClaimEligibility.ts`. A stage that was turned off, or a policy that was removed, cancels the unclaimed command.

**`oem_update_run` at stage `act`, canary only.** Every existing lock still applies: the flag, the allowlist, the kill switch, the agent version and the manifest. In addition, `GateState` becomes `'open' | 'canary' | 'closed'`, and `categoryOpenIn` treats `canary` as open only when `vendorStage('oem_updates', lane, partnerId) === 'act'`.
- `isCategoryOpen`, `isLaneOpen` and `openCategoriesForLane` take `partnerId`.
- Every caller is updated: dispatch, candidates, laneDelivery, policySide and the claim recheck.
- The manifest contract test treats `canary` exactly like `open`: a real SHA-256 and an allowlisted URL are required, except for the tool-free Surface lane.

**Refresh.** `vendorCanaryFingerprint()` is folded into `oemGatesFingerprint()`, so changing the canary env or a stage refreshes every device's policy side, as the allowlist already does.

### 1.4 Alternatives rejected

| Option | Why not |
|---|---|
| One env var per feature | Three places to name the same tenant, which drift apart. |
| `partners.settings` flag (for example `topologyFeatureFlags`, `services/topology/flags.ts`) | Partner-writable, so a partner could enable best-guess code on itself. |
| New operator-only column or table (`aiForOfficeEnabled` style) | Needs a migration, UI and tenancy registration for a temporary canary. |
| `agentVersionPins` | Pins binary versions only, not features. Still useful to pin our own tenant to the build that carries observe. |
| `BREEZE_OEM_UPDATES_LAB_DEVICE_IDS` | Refused in production by design, and opens write gates. |

### 1.5 Advisor quorum

Run 2026-11-19 with `codex exec`, `gpt-6.2-astra`, `xhigh`, read-only. The advisor's verdicts:

| Question | Verdict | Effect |
|---|---|---|
| (a) One shared helper and env var, versus one per feature or a DB flag | **AGREE.** Unset is off, malformed fails boot, an unknown partner is off. During the canary, require `act` **and** the feature's existing write gates. Widening is a separate decision for each pair. | Adopted as written (§1.1, §1.3). |
| (b) Each feature's existing channel, with OEM observe as its own command | **AGREE.** The runner writes a marker and can install, so the observe handler must be read-only, with its own minimum version. Its results must stay out of reboot accounting and Windows Update suppression. Recheck at HTTP and WS claim. Lenovo needs observe eligibility before its lane ships. | Adopted (§1.2, §1.3, §2.4). |
| (c) Require the feature's normal opt-in | **AGREE.** OEM observe needs the armed link even for Run Now. WOL observe sits inside readiness collection. Warranty observe needs current-EULA consent. | Adopted here; the WOL and warranty amendments apply it to their features. |
| (d) Missed risks | **PARTIAL.** Make revocation explicit: send an empty list or `off`, never leave a key out, because an HP agent persists `hp_cmsl_enabled`. Act authority must not survive a restart. Fold canary state into the OEM fingerprint. An env kill needs the containers recreated. The planned WOL `WOL_FIRMWARE_WRITE_VENDORS` rollout text named the tenant. Logs retain only 7 days. Observation proves availability, not behaviour across a reboot. | All adopted. The tenant name was removed from the WOL plan and spec and from the OEM spec in this PR. §3 keeps every unverified operation closed. |

**No disagreement remains.** My position and the advisor's match on the mechanism. The advisor's additions are hardening, and all of them are in.

---

## 2. What observe collects

### 2.1 Common block (every lane)

Command result `oemObserveResultSchema` in `packages/shared/src/validators/oemUpdates.ts`. Every object is `.strict()`, and every string uses `toolText(n)`, so control characters are refused.

| Field | Bound | Confirms |
|---|---|---|
| `lane`, `schema: 1`, `agentVersion` | enum or ≤ 32 chars | |
| `nativeArch` | `amd64\|arm64\|x86\|unknown`, read with `IsWow64Process2` | ARM64 behaviour (Surface) |
| `osBuild` | ≤ 32 | |
| `smbios.manufacturer`, `model`, `systemSku`, `family` | ≤ 64 each | Applicability near-misses (Review Focus 1) on real strings |
| `smbios.baseboardProduct` | ≤ 32 | HP platform ID, used by HPIA's platform support |
| `bios.version`, `bios.releaseDate` | ≤ 64 / date | |
| `chassis` | enum from SMBIOS chassis type | Desktop versus laptop battery rules |
| `power` | `{ acLine: on\|off\|unknown, batteryFlag:int, batteryPercent:int }` | Review Focus 2 (`BatteryFlag=128`, `255`) on real devices |
| `bitlocker` | `{ protection: on\|off\|suspended\|unknown, pcr7Bound: bool\|null, activeProtectorEscrowed: bool\|null }` | Reuses the read-only `bitlockerguard.Preflight` and its localised-output rule. The server sends the escrowed protector IDs, as `oem_update_run` already does; the agent replies with a boolean only, never key material. |
| `pendingReboot` | bool | Exit-5 and `blocked_reboot_pending` paths |
| `tools[]` (≤ 12) | `{ name, version, publisher, signatureValid, location: program_files\|agent_dir\|windows_apps\|other }` | Detection gates. **Paths are reduced to a location class**, because a path can contain a user name. |
| `conflicts[]` (≤ 8) | `{ name, version }` for HP Support Assistant, Lenovo Vantage, Commercial Vantage, Lenovo System Update, Dell SupportAssist | Plan's conflict questions (D3, L0) |
| `errors[]` (≤ 16) | `{ step, code }`, code is an identifier ≤ 64 | Which reads failed, and how |

### 2.2 Per lane

**Surface** (replaces legs S1 and S2):
- **Windows Update search:** the read-only search `Type='Driver' and IsInstalled=0 and IsHidden=0` through the W11 T2 searcher. Nothing is downloaded or installed.
- **Per pending update** (≤ 50): `title` (≤ 200), `updateId`, `driverManufacturer`, `driverClass`, `driverModel`, `driverProvider`, plus `laneWouldSelect: driver|firmware|none`, computed by the shipped Surface `Filter` code with no side effects.
- **Policy value:** `ExcludeWUDriversInQualityUpdate`, as present, absent or a value.
- **On ARM64,** this answers whether Snapdragon-era Surface drivers carry `Microsoft`/`Surface` as `DriverManufacturer` or a silicon vendor such as `Qualcomm`. The lane's filter keeps only Surface's own updates, so the answer decides whether it would deliver anything on ARM64. The firmware `DriverClass` strings are marked unconfirmed in W11 T2; observe answers that too.

**HP** (replaces the detection part of H2 and H3; H1, H4 and H5 stay at act):
- **HPIA:** the shipped HP availability gate (agent-owned directory) reports `Present` and `Version`. Copies elsewhere get the location class `other`, as they do today, and are never run.
- **CMSL:** whether the module is present, and its version, from `Program Files\WindowsPowerShell\Modules\HPCMSL`.
- **Business-BIOS marker:** whether `root\HP\InstrumentedBIOS` is present. This is a namespace check only. The settings themselves are read by the WOL amendment's adapter, not here.
- **Platform support, passive:** one HTTPS `HEAD` to HP's HPIA reference catalog for `smbios.baseboardProduct`. The URL pattern is **not confirmed**: confirm it from HP's HPIA documentation in task O4, and add the host to an `observeHosts` section of `allowlist.json`, which permits GET and HEAD only and never exec. Record the HTTP status only.
- **Expected in our own tenant:** consumer platform, no HPIA, no CMSL, no business-BIOS namespace, catalog 404. That is the `not_supported` path, on real devices.

**Lenovo** (replaces the L0 desk work and L1 detection):
- **Machine type** (`MTM`, the first four characters of `Model`) and family: `ThinkPad`, `ThinkCentre` or `IdeaPad`, from `SystemFamily` or `Version`.
- **Installed tools:** System Update (end of life 2027-03-31), Thin Installer, Commercial Vantage, Lenovo Vantage, and the PowerShell modules `LSUClient` and `Lenovo.Client.Update`, each with presence and version.
- **Passive catalog read:** one HTTPS GET of `https://download.lenovo.com/catalog/<MTM>_Win<10|11>.xml`. That is the catalog that LSUClient and Lenovo.Client.Update read; see §6 D-OEM-1.
  - Parsed **in Go**, bounded to 512 KiB. No package XML or installer is fetched, and nothing is executed.
  - Records the HTTP status, the package count, and counts by `PackageType` (1 app, 2 driver, 3 BIOS, 4 firmware) and by `RebootType` (0, 1, 3, 4, 5), plus whether a BIOS package is listed.
- **What this answers:** how much of a real ThinkCentre or ThinkPad catalog falls into reboot types 0, 3 or 5, which Breeze can control, versus 1 or 4, which force a reboot or shutdown. That ratio decides whether the Lenovo lane is worth building.

**The "scan" rung is not part of observe by default** (§6 D-OEM-2). That rung would fetch the vendor tool, verify it, and run its read-only analysis:
- HPIA `/Operation:Analyze /Action:List`;
- Lenovo.Client.Update `Get-LnvUpdate`, which runs Lenovo's signed detection programs as SYSTEM.

Both fetch and execute vendor code, so they count as installs under the owner's rule. They are offered as a separate rung for the owner to approve.

### 2.3 Redaction and size

- **Never collected:** serial numbers, UUIDs, asset tags, hostnames, user names, full file paths, MAC addresses, raw vendor logs, or key material. The serial already sits in `device_hardware` and is not repeated.
- **Size:** the whole result is at most 32 KiB serialized. Lists are truncated with `truncated: true`.
- **Agent logs:** count and error codes only, at DEBUG.

### 2.4 Where it is stored and shown

- **Stored:** in `device_commands.result` for type `oem_observe`, the existing command-result path.
  - **Retention:** `jobs/deviceCommandRetention.ts`, which is report-only by default and 120 days when enforced.
  - **No new table or column.**
  - **Isolation:** `applyOemObserveResult` validates strictly, then stores. It **never** writes `device_oem_update_status`, reboot accounting, or W08's update-type exclusion, so observe cannot change display state or Windows Update ownership.
- **Shown:** the W04 history list gains an `Observed` row (lane, verdict, tools found), with new locale keys in all 8 locales. There is no other UI.
- **Evidence:** a read-only query script under `internal/` (gitignored) produces the tallies. PRs quote tallies only, never device rows.

---

## 3. Evidence that moves a lane from observe to act

A move is **one PR per lane and category**. It changes `VENDOR_STAGES.oem_updates.<lane>` to `act`, sets the passed categories to `canary`, replaces `doc-derived` fixtures with scrubbed captures, and carries the tally. The owner approves it.

**Observation cannot prove behaviour across a reboot or flash.** Those items are proved by the **first act run**:
- one device the owner picks;
- out of hours;
- recovery key visible in Breeze and written down separately;
- someone able to type it is reachable;
- then 3 devices, then every opted-in canary device of that family.

A recovery prompt, an unexpected reboot or a shutdown at any point sets the kill switch, reverts the stage in code, and returns the decision to the owner.

| Lane / category | Evidence required (all) | Reachable in our own tenant? |
|---|---|---|
| **Surface `driver`** | ≥ 4 Surface devices across both architectures present; ≥ 2 observations each, ≥ 14 days apart; Windows Update search succeeds on every one, including emulated ARM64; every update with `laneWouldSelect=driver` reviewed by title as Surface's own, with zero false positives; `ExcludeWUDriversInQualityUpdate` known on each | Yes |
| **Surface `firmware`** | Everything above, plus `pcr7Bound=true` and `activeProtectorEscrowed=true` on the target; firmware `DriverClass` strings observed; `driver` run clean for 2 monthly occurrences; owner approval naming the first device (D-OEM-4) | Possible, deliberately late |
| **HP `driver` / `application` / `firmware`** | ≥ 2 HP **business** devices with platform catalog `200`; H1 licence decision; D-OEM-2 = yes (HPIA must be fetched) | **No.** Consumer-only fleet. HP stays at `observe` (D-OEM-3). |
| **HP `bios`** | As above, plus #5515 shipped (Decision 7) and leg H4 | No |
| **Lenovo `driver` / `application`** | D-OEM-1 decided; ≥ 3 commercial devices across ThinkPad and ThinkCentre with catalog `200`; reboot-type distribution recorded; W16 lane merged on fakes built from those catalogs; if D-OEM-2 = yes, the scan rung run on ≥ 2 devices shows `PendingAction` matching the filter | Yes |
| **Lenovo `firmware`** | As above, plus every selected firmware package's reboot type is 0, 3 or 5 | Likely partial |
| **Lenovo `bios`** | Stays closed. Lenovo says Thin Installer BIOS cannot run unattended; Lenovo.Client.Update flashes and suspends BitLocker, but ThinkCentre BIOS asks for a **shutdown**, which needs a separate owner decision (leg L3). | No |

**What HP observe still teaches with consumer devices only:**
1. The applicability and detection gates behave on real HP strings.
2. Consumer HP should be `not_applicable` with reason `platform_unsupported`, so the HP lane never fetches HPIA onto a consumer device. That fix is a narrowing change and ships at observe (§4, O4b).
3. The battery, BitLocker-preflight and pending-reboot readers work on real hardware, which serves every lane.
4. Whether any customer has HP Support Assistant installed, which is a conflict question.

---

## 4. Tasks

Branch per wave from fresh `origin/main` as the plan requires. The existing wave issues are reused: observe work lands under W12 (Surface), W14 (HP), and W15/W16 (Lenovo). C0 and O1–O3 are shared and land under whichever of those starts first.

### Step 1: OBSERVE

**C0. Shared canary helper** (shared with the WOL and warranty amendments)
- **Files:** create `services/vendorCanary.ts` + test. Modify `config/validate.ts`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `.env.example`, `deploy/.env.example`, `services/oemUpdates/policySideStore.ts` (fingerprint).
- **Tests, red first:**
  - `empty env: every pair is off`
  - `partner listed + table observe: observe`
  - `partner not listed: off`
  - `disabled pair: off`
  - `malformed UUID fails validate`
  - `allowed under NODE_ENV=production`
  - `more than 3 ids fails validate`
  - `VENDOR_STAGES equals the reviewed table` (snapshot of the exact table, so a stage change is always a visible diff)
  - `fingerprint changes when the env or the table changes`
  - `envComposeParity` and `envReadComposeCoverage` stay green

**O1. Contract**
- **Files:** `packages/shared/src/validators/oemUpdates.ts` (`oemObservePayloadSchema = { lane, escrowedProtectorIds, observeLevel: 'passive' }`, `oemObserveResultSchema`), its test, command registration and the exposure contract (`oemUpdateExposure.contract.test.ts`), and `agentSupportsOemObserve`.
- **Tests:**
  - `strict at every depth`
  - `observeLevel scan is refused until D-OEM-2`
  - `no path, serial or MAC field exists`
  - `result over 32 KiB is refused`

**O2. API**
- **Files:** create `services/oemUpdates/observe.ts` + test. Modify `revalidation.ts`, `commandClaimEligibility.ts`, `commandResultHandlers.ts`, `candidates.ts` (weekly observe sweep for armed canary devices), `routes/devices/oemUpdates.ts` (Run Now dispatches `oem_observe` when the lane's stage is `observe`), `history.ts`, and `__tests__/parkedFanoutModules.ts`.
- **Tests, red first:**
  - one per refusal in §1.3
  - `Run Now without a policy refuses no_policy for observe`
  - `observe ignores manifest gates`
  - `lenovo observable though not in SHIPPED_OEM_LANES`
  - `stage off at claim cancels, over HTTP and WS`
  - `result never touches device_oem_update_status, reboot planner or update-type exclusion`
  - `a non-canary partner's device is never swept`

**O3. Agent core**
- **Files:** create `agent/internal/oemupdates/observe/{observe.go, common_windows.go, common_other.go, observe_test.go}`. Modify `handlers_oem.go` for the `oem_observe` handler.
- **Tests:**
  - `TestObserveImportsNoInstallPath`: a `go list -deps` assertion that the package does not import `fetch`, `install`, `runner`, `flashguard`, `marker`, `takeover` or the reboot packages
  - `TestObserveWritesNoMarker`
  - `TestNativeArchArm64UnderEmulation` (fake `IsWow64Process2`)
  - `TestPathsReducedToLocationClass`
  - `TestBoundsTruncate`
  - `TestBatteryFlag128And255Recorded`
  - `TestPreflightLocalisedIsUnknown`
- **Verify:** `cd agent && go test -race ./internal/oemupdates/...`, then `GOOS=windows go vet` on the touched packages.

**O4a / O4b / O4c. Per-lane observers** (Surface / HP / Lenovo; parallel)
- **Files:** `observe/{surface,hp,lenovo}_windows.go` + tests + `testdata/<lane>/doc-derived/*`, and the `observeHosts` section of `allowlist.json` (`download.lenovo.com`; the HP reference host once confirmed).
- **Surface tests:** `TestSurfaceObserveSearchOnlyNeverDownloads`, `TestQualcommDriverRecordedWithLaneVerdict`, `TestExcludeWUDriversPolicyRead`.
- **HP tests:** `TestHpObserveNeverRunsHpia`, `TestHpCatalogHeadOnly`, `TestHpInstrumentedBiosAbsentRecorded`.
  - **O4b also ships the narrowing:** `applicability.ts` returns `not_applicable` with `platform_unsupported` for HP devices with a recorded `404` platform catalog. The server reads this from the newest `oem_observe` result.
  - **Test:** `consumer HP with 404 catalog: oem_update_run refuses not_applicable`.
- **Lenovo tests:** `TestLenovoCatalogParseBounded`, `TestLenovoCatalogOver512KiBTruncated`, `TestLenovoNeverFetchesPackageXml`, `TestIdeaPadCatalog404Recorded`, `TestOffAllowlistHostRefused`.

**O5. Web.** History row `Observed`, locales × 8, and `data-testid`. Use `runAction` if a Run Now path changes.

**O6. Evidence query.** `internal/oem-observe/tally.sql`, read-only. Not committed.

**Replaces:**

| Plan item | Observe answers | Moves to first act |
|---|---|---|
| **W12** | S1 (identity strings); S2 (policy interaction, read side) | S3, S4 |
| **W14** | H2 and H3 detection only | H1 (owner decision); H2 fetch and install, H3 run, H4, H5 |
| **W15** | L0 desk questions, by D-OEM-1 plus the catalog read | L0 BitLocker and shutdown behaviour |
| **W17** | L1 detection | L1 fetch, L2, L3, L4 |

### Step 2: ACT (per lane and category, only after §3)

**A1. Manifest `canary` state**, shipped with the first act PR.
- **Files:** `toolManifest.ts` + test, and every `isCategoryOpen` caller (`dispatch.ts`, `candidates.ts`, `laneDelivery.ts`, `policySide.ts`, `revalidation.ts`) passing `partnerId`.
- **Tests:**
  - `canary gate opens only for an act-stage canary partner`
  - `canary requires sha256 and an allowlisted url like open`
  - `code block beats canary`

**A2. Surface `driver`** (W12): captured fixtures, filter corrections (for example, whether to admit `Qualcomm` on ARM64 Surface), stage flip. Commit: `feat(api): open Surface driver gate for canary per observe evidence`.

**A3. Lenovo lane** (W16, rewritten): `lane_lenovo.go` on Lenovo.Client.Update per D-OEM-1.
- Pinned zip from `download.lenovo.com/cdrt/tools/`, with SHA-256 and Lenovo publisher in `allowlist.json`.
- Filter: `Installer.Unattended` and `RebootType ∈ {0,3,5}`.
- `PendingAction` mapped to `rebootRequired` / `shutdownRequired`.
- No `bios` category.
- Tests are built from the observed catalog tallies.
- **Add to `SHIPPED_OEM_LANES`.** The plan's W16 fixed rules all stand.

**A4. Lenovo stage flip** (W17): first act run, then `driver` and `application` move to `canary`.

**A5. Surface `firmware`**, if D-OEM-4 allows.

**A6. HP** stays parked under D-OEM-3, and resumes from W14's plan text once a business HP is observed.

**A7. Widen** (owner, per pair): `canary` → `open`, remove the `VENDOR_STAGES` entry, and the existing allowlist governs.

---

## 5. Risks of best-guess code on customer machines, and how observe bounds them

| Risk | Bound |
|---|---|
| Observe code accidentally installs or flashes | Separate command and package. A `go list -deps` test forbids the install, flash and reboot imports. Observe ignores manifest gates, so no gate change can widen it. Observe results are isolated from status and reboot state. |
| A passive network read becomes an exec path | `observeHosts` permits GET and HEAD only, with no redirect off the list. The response is parsed in Go, bounded, and never written to an executable location. |
| Windows Update search misbehaves under ARM64 emulation | Read-only search. The failure is recorded as `errors[]`. The ARM64 result is a required part of the evidence before Surface `driver` opens. |
| Observation leaks identifying data | No serial, path, MAC, host or user field exists in the schema. The schema is strict, with a size cap. Evidence stays in `internal/`. |
| Guessed exit codes or report formats wrong at act | Observe cannot confirm these. The first-act protocol on one device does, and the parser treats unmapped codes as `failed` (existing). |
| BitLocker recovery after firmware | **Not observable.** Firmware stays closed until PCR 7 binding and escrow are observed, driver has run clean, and the owner names the first device. That residual risk is accepted for our own tenant only (D-OEM-5). |
| Consumer HP gets HPIA fetched once HP opens | Fixed at observe: O4b makes those devices `not_applicable`. |
| Best-guess code reaches other partners | Only `vendorStage` = `act` for listed partners opens a `canary` gate. Widening is a separate PR per pair. |

---

## 6. Decisions for the owner

- **D-OEM-1, W15 Lenovo tool: the decision this wave was blocked on.** **Recommend Lenovo.Client.Update (LCU).** Evidence was gathered 2026-11-19; all claims are vendor-sourced.
  - **System Update is out.** "maintenance will end on October 31, 2026… End of Life (EOL) on March 31, 2027… Lenovo recommends migrating to Lenovo Commercial Vantage" (support.lenovo.com HT037099).
  - **Thin Installer** is "scheduled to be sunset in 2027… superseded by an Intune Win32 app built around the Lenovo.Client.Update (LCU) module" (blog.lenovocdrt.com). It also needs a repository we would have to build, and it forces type-5 reboots.
  - **Commercial Vantage** is a resident app (`suhelper.exe`), whose exit codes only mean "session triggered", with results arriving later in WMI. By default it reboots within 5 minutes after type-5 updates (docs.lenovocdrt.com/guides/lcv/suhelper).
  - **LCU** is first-party: PSGallery owner `lenovocdrt`, "(c) Copyright 2026 Lenovo Ltd.", version 1.0.7 dated 2026-11-04. It is based on the open-source LSUClient engine and adds a Lenovo signature check on every package file. It contains no reboot calls and reports `PendingAction` per package (REBOOT_SUGGESTED, REBOOT_MANDATORY or SHUTDOWN). It reads `download.lenovo.com/catalog` directly, so no repository is needed. A pinnable zip is served from Lenovo's own host.
  - **LCU's cons:**
    - It is only 7 months old.
    - Its manifest states no licence, so redistribution terms are **not confirmed**. We would fetch the tool from Lenovo, never host it.
    - Package payloads are fetched at run time and cannot be pinned.
    - Its `Unattended` filter does not exclude reboot types 1 and 4, so Breeze must add a `RebootType ∈ {0,3,5}` filter.
  - **Fit with our own tenant:** commercial ThinkCentre and ThinkPad, which is LCU's target. Consumer Lenovo models are expected to have no catalog.
  - **Alternative:** LSUClient. It has the same engine, an MIT licence and a long track record, but it is community-maintained and does no signature checks.
- **D-OEM-2, scan rung.** This would allow observe to fetch the vendor tool into the agent-owned directory and run its read-only analysis (HPIA Analyze/List; LCU `Get-LnvUpdate`, which runs signed detection programs as SYSTEM). It would confirm argv, report formats and `PendingAction` before any install. **Recommend no for now.** Revisit for Lenovo only after the passive catalog read, if the act-step uncertainty is still material. HP is moot under D-OEM-3.
- **D-OEM-3, HP.** HP act cannot be justified from consumer-only data. **Recommend parking HP at `observe`**, shipping the consumer `not_applicable` fix, and resuming when a business HP appears in a canary tenant or a used EliteBook is bought.
- **D-OEM-4, Surface firmware.** Firmware cannot be rolled back. **Recommend it stays closed** until `driver` has run clean for two monthly occurrences. After that, the owner names the first device.
- **D-OEM-5, relied-on devices.** First act runs happen on devices people in our own tenant rely on, under §3's protocol. This overrides spec §8 for Surface and Lenovo. **Recommend yes, drivers and applications first.**
- **D-OEM-6, production.** Setting `BREEZE_VENDOR_CANARY_PARTNER_IDS`, turning on `BREEZE_OEM_UPDATES_ENABLED` with the partner allowlist, and arming an `oem_updates` policy in our own tenant are production changes. Each needs the owner's go.
