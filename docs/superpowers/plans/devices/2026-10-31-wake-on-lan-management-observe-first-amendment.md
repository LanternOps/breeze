---
amends: docs/superpowers/plans/devices/2026-10-31-wake-on-lan-management.md
tracking_issue: LanternOps/breeze#10838
waves: ["W07 (#10845) HP", "W08 (#10846) Lenovo", "W09 (#10847) Surface"]
companion_amendments:
  - docs/superpowers/plans/vuln-patch/2026-11-05-oem-vendor-updates-observe-first-amendment.md
  - docs/superpowers/plans/device-lifecycle/2026-09-10-hp-warranty-cmsl-w01-lab-probe-and-ingest-hardening-observe-first-amendment.md
status: draft for owner approval (2026-11-19)
---

# Wake-on-LAN: observe-first amendment for HP, Lenovo and Surface (W07–W09)

## Why this exists

The plan says "No vendor adapter ships before its vendor's machine has been captured and tested" (Global Constraints) and makes W07–W09 wait "until a machine is found" (Task 17). The owner decided on 2026-11-19 that we have no HP, Lenovo or Surface lab hardware, so these waves are built on the vendor documentation and released in two steps. Each step is enabled only for **our own tenant**: one partner, named only by an env value, never in this repo.

- **Step 1, OBSERVE.** The agent reads the vendor's firmware settings interface and reports what it finds. It writes nothing, installs nothing, and changes no BIOS or OS setting.
- **Step 2, ACT.** Once observed data confirms the guesses, the same tenant gets the write path. Other partners are added later.

**Plan rules this amendment overrides, and only for W07–W09:**

| Rule in the plan or spec | Amended to |
|---|---|
| "No vendor adapter ships before its vendor's machine has been captured and tested" | A **read-only** adapter may ship before capture. It runs only at stage `observe` or higher, and only on canary devices. `Apply` still needs captured evidence: the observed data replaces the lab capture in Task 17 Step 1. |
| Task 17 Step 6, "Run spec §9's checklist on the machine" | Split. Read-side items are answered by observe. The write-side items (§9: apply, read back, reboot, wake from S5, no BitLocker recovery) are answered by the **first act run**, on one canary device that the owner picks. See §3 and §5. |
| Spec §9 lab gate on a machine nobody relies on | For HP, Lenovo and Surface only, the first act run is on a real device in our own tenant. This acceptance is **pending D-WOL-2**. §5 sets the bounds. |

**Already true on `main` (checked at `190c74a001`), so this amendment builds on it:**
- W01 and W02 are merged.
- `agent/internal/biosconfig/adapter.go` defines `Adapter` with `Read`, `Protection` and `Apply`. `Detect` returns nil for every make.
- `agent/internal/wakeconfig` computes and uploads the readiness snapshot through `PUT /agents/:id/wake-status`.
- `packages/shared/src/validators/wakeStatus.ts` defines `details` as `z.record(...)`, bounded only by the route's 64 KiB body limit.
- `buildWakeOnLanConfigUpdate` (`apps/api/src/routes/agents/helpers.ts:3697`) delivers `wake_on_lan_settings`.
- W03, W04 and W06, the write paths and activation, are **not** merged. Every act step below depends on them.

**What the fleet in our own tenant can and cannot prove.** This was checked with a read-only production query on 2026-11-19. Exact counts and models stay out of this public repo.
- **Lenovo:** mostly commercial ThinkCentre and ThinkPad, plus a few consumer models. This is enough for Lenovo observe and act.
- **HP:** consumer models only. HP documents its BIOS WMI interface (`root\HP\InstrumentedBIOS`) for business PCs, so we expect HP observe to report "interface absent" on every device. §3 treats that as a valid result, not a failure.
- **Surface:** a mix of ARM64 (Snapdragon) and Intel units, plus Hyper-V guests that report `Microsoft Corporation`.

---

## 1. Gating: stage per vendor, scoped to the canary partner

The full design and the advisor quorum are in the vendor-updates amendment, §1. That design is shared by all three amendments. In summary:

- **Server helper (new, shared):** `apps/api/src/services/vendorCanary.ts` exports `vendorStage(feature, vendor, partnerId): 'off' | 'observe' | 'act'`.
  - **Who** is set by env `BREEZE_VENDOR_CANARY_PARTNER_IDS`: comma-separated UUIDs, default empty, which turns everything off.
  - **How far** is set by an in-code table, `VENDOR_STAGES`. Only a reviewed PR that carries the observe evidence moves an entry.
  - **Kill switch:** env `BREEZE_VENDOR_CANARY_DISABLED` (for example `wake_on_lan:lenovo`) takes effect without a code release. The API containers must still be recreated with the new env. It cannot recall a write that is already running.
- **Precedent reused:** the per-partner env allowlist in `apps/api/src/services/oemUpdates/flags.ts:21-30` (`BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST`), which is validated in `config/validate.ts` and mapped in both compose files. Also the code-only gate table in `services/oemUpdates/toolManifest.ts`.
- **Starting state for WOL:** `VENDOR_STAGES.wake_on_lan = { hp: 'observe', lenovo: 'observe', surface: 'observe' }`. Dell is not in the table, because Dell follows the existing plan (W04, W06).

**How the agent learns: the existing heartbeat block, no new channel.**
- `buildWakeOnLanConfigUpdate` adds `observe_vendors: string[]` to `wake_on_lan_settings`. It contains each vendor whose `vendorStage('wake_on_lan', vendor, device.partnerId)` is `observe` or `act`.
- At act, the vendor is also added to the `firmware_writes` list that W06 introduces. For canary partners, `firmware_writes` is the union of the global `WOL_FIRMWARE_WRITE_VENDORS` env (W06) and the vendors whose stage is `act`.
- The partner id is already on the heartbeat context (`agent.partnerId`, `heartbeat.ts:735`). The stage is an env and code lookup with **no database query**, so the hot-path budget (`agentHotPathQueryBudget.integration.test.ts`) does not change.

**Revocation is explicit.** This was added from the quorum.
- The server always sends `observe_vendors`, as `[]` when the vendor is off, so turning it off reaches the agent on the next heartbeat. It is never left to an absent key.
- The agent keeps `observe_vendors` and the act-stage `firmware_writes` entries in memory only, never in `agent.yaml`, and they expire 24 h after the last heartbeat that carried them.
- After a restart, a vendor gets no observe or write authority until a fresh heartbeat grants it again.

**Default off, in five places:**
1. The canary env var is empty by default.
2. There is no `wake_on_lan` policy link, so `enabled` is false and the agent does nothing new (Global Constraints).
3. An absent `observe_vendors` key, which is what older APIs send, means no observation.
4. An older agent ignores the unknown key (`TestApplyWakeSettingsIgnoresUnknownFields`).
5. `biosconfig.Detect` returns a read adapter for a vendor only when that vendor is in `observe_vendors`.

**The device must still be opted in.** Observe runs only where a `wake_on_lan` policy link applies (the existing `enabled`). A tech in our own tenant chooses which devices take part. No device outside a policy is touched.
- **Act needs more than the stage.** It also needs `configureSettings: true` and W06's `devices.execute` + MFA write gate. A stage of `act` never bypasses those gates.

**Quorum (2026-11-19, `gpt-6.2-astra` at `xhigh`, read-only).**
- **Agreed:** the shared helper and env var; using each feature's existing delivery channel; requiring the device's normal opt-in.
- **Partly agreed on risks.** The advisor added three things, and all three are adopted above:
  - explicit revocation, with no persisted authority;
  - keeping observation data out of the readiness fingerprint, because a fingerprint change resets the timeout counters;
  - wording the kill switch as "needs the containers recreated".

The full record is in the vendor-updates amendment, §1.

---

## 2. What observe collects, per vendor

Every observation goes into the existing readiness snapshot as `details.vendorObservation`, and readiness stays `unproven` with reason code `vendor_observe_only`.
- **No new table, no new column, no new route.** `device_wake_status.details` already exists, and its tenancy and export registration is already done.
- **Schema change:** `wakeStatusSnapshotSchema.details` gets an optional, typed, `.strict()` `vendorObservation`, so the 64 KiB body limit is no longer the only bound.

**Common block:**

| Field | Bound |
|---|---|
| `schema` | literal `1` |
| `vendor` | `hp` \| `lenovo` \| `microsoft` |
| `nativeArch` | `amd64` \| `arm64` \| `x86` \| `unknown`, read with `IsWow64Process2`. The Windows agent is amd64-only and runs emulated on ARM64, so `GOARCH` is not the native architecture. |
| `interface` | `present` \| `absent` \| `access_denied` \| `error` |
| `errorCode` | Identifier of at most 64 characters, for example a WMI `HRESULT` such as `0x8004100E` (invalid namespace) |
| `durationMs` | integer |
| `collectedWith` | agent version |

### HP (W07)

**Read:** `root\HP\InstrumentedBIOS`, classes `HP_BIOSEnumeration` (`Name`, `CurrentValue`, `PossibleValues`) and `HP_BIOSPassword` (`Name`, `IsSet`), plus the presence of `HP_BIOSSettingInterface`. It is never called.

**Collected:**
- Every setting **name** that matches the WOL allowlist, with its current value and possible values. The allowlist is in this order:
  1. Deny first: `(?i)asset|owner|serial|uuid|tag|password|pin|key|cert|user|email|phone|name of|location`.
  2. Then allow: `(?i)wake|wol|\blan\b|s4|s5|deep ?sleep|power ?sav|after power|ac (recovery|power)|erp|network boot|pxe`.
- `settingCount`: the total number of settings, as an integer only.
- `IsSet` for `Setup Password` and `Power-On Password`.
- The value of `Enhanced BIOS Authentication Mode` (Sure Admin) if that name exists.

**Bounds:**
- At most 48 settings.
- Name ≤ 64 characters, value ≤ 64, possible values ≤ 16 each ≤ 64.
- Control characters are stripped.
- At most 8 KiB in total. Above that, entries are dropped and `truncated: true` is set.

**Expected in our own tenant:** `interface: absent`, error `0x8004100E`, on every consumer HP. The observation is still useful, see §3.

### Lenovo (W08)

**Read:**
- `root\wmi` `Lenovo_BiosSetting.CurrentSetting`, a `Name,Value[;[Optional:...]]` string.
- `Lenovo_BiosPasswordSettings.PasswordState`.
- The presence of `Lenovo_SetBiosSetting`, `Lenovo_SaveBiosSettings` and `Lenovo_GetBiosSelections`. They are never invoked for writes.
- Whether certificate-based BIOS authentication is configured, read from whichever class exposes it. The exact class is **not confirmed**, so observe records the list of `Lenovo_*` class names that are present, capped at 64.

**Collected:**
- Allowlisted settings, using the same deny-then-allow rule and bounds as HP.
- `PasswordState`, as an integer bitmask.
- The class-name list.
- **The machine type,** the first four characters of SMBIOS `Model`, for example `20U9`. This is a model code, not a serial number, and the agent already reports it as model in `device_hardware`.

**Possible values come from `Lenovo_GetBiosSelections`.** It is a read-only method that returns the allowed values for a setting name. It is called **only** for allowlisted names, with at most 48 calls and a 2-second timeout each.

**Expected:**
- **ThinkPad:** a `WakeOnLAN` setting with values such as `ACOnly`, `ACandBattery` and `Disable`.
- **ThinkCentre:** setting names are **not confirmed** to match. Observe settles this.
- **IdeaPad:** `interface: absent` (consumer).

### Surface (W09)

There are no firmware settings to read, so Surface observe confirms the readiness classifier instead.
- **Identity:** SMBIOS `SystemSKU` and `Model`, which carry the model name, not a serial. `nativeArch` is recorded as in the common block.
- **Wired adapters:** for each one, its PnP vendor and device IDs (`PCI\VEN_xxxx&DEV_xxxx` or `USB\VID_xxxx&PID_xxxx`), its driver provider, and whether it is on the dock or the Surface Connect path (`InterfaceDescription` matched against `(?i)surface`, both the raw match and the result).
- **Hyper-V guest check:** the existing VM check runs first, and the result records which rule decided.
- **Not collected:** MAC addresses. The existing snapshot already handles adapter memory, and MACs stay out of this block.

**Expected:**
- **ARM64 Surface laptops without built-in Ethernet:**, so it is likely `no_wired_adapter` unless a USB-C adapter is attached.
- **Intel Surface models:** Surface Connect dock or USB adapter.
- **On ARM64, not confirmed:** whether the x64-emulated agent can query `Get-NetAdapter` and the PnP data the same way. Observe records `errorCode` if it cannot.

### Not collected on any vendor

- BIOS serial numbers, UUIDs, asset tags, ownership tags, hostnames or user names.
- Any setting outside the allowlist.
- Raw WMI dumps.
- **Logs:** the agent logs only counts and error codes at DEBUG. Agent logs never carry values.

**Where it is shown:**
- **Device page:** the existing WOL status panel (`services/wakeStatusPanel.ts`) shows `Observing (vendor)` together with `interface` and `errorCode`. Setting values are visible **only to our own staff**, and only through the read-only evidence query below. They are not added to the panel, because the panel's reason copy covers this.
- **Evidence query:** a read-only SQL script under `internal/` (gitignored) tallies `details->'vendorObservation'` across canary devices. Its output stays in `internal/`. Pull requests carry tallies only, such as "N of M devices", the setting names seen, and the values seen, and never device or tenant identifiers.

---

## 3. Evidence that moves a vendor from observe to act

Moving a vendor means one PR that changes `VENDOR_STAGES.wake_on_lan.<vendor>` to `act`, adds the vendor's `Apply`, and carries the tally in its body. The owner approves it.

| Vendor | Flip evidence (all required) | What our own tenant can actually provide |
|---|---|---|
| **HP** | ≥ 2 HP **business** devices with `interface: present`; the target names from Task 17 (`Wake On LAN`, `S5 Maximum Power Savings`) seen with `Boot to Hard Drive` / `Disable` in their possible values; `HP_BIOSPassword` readable; Sure Admin state readable | **Not reachable.** Consumer-only fleet. HP stays at `observe`, and the device keeps showing `unproven`. That is the right answer for a consumer HP, because it has no WMI BIOS path. Decision **D-WOL-1**. |
| **Lenovo, ThinkPad** | ≥ 3 devices across ≥ 2 machine types; a WOL setting name seen on every one; the target value in `Lenovo_GetBiosSelections` output; `PasswordState` read on every one; observed for ≥ 14 days with a stable fingerprint | Likely reachable |
| **Lenovo, ThinkCentre** | The same, counted separately, because setting names may differ by family | Likely reachable |
| **Surface** (no writes ever; "act" means the classifier may return `ready`) | ≥ 2 Surface devices with a Microsoft adapter identified by PnP ID and driver provider; ≥ 1 recorded wake outcome `came_online` on a Surface from W01's attempts table; VM rule never misfires on a Hyper-V guest | Intel models likely. ARM64 laptops without Ethernet depend on an adapter being attached. |

**Moving to act also needs the infrastructure:** W03 (Windows and NIC writes), W04 (BitLocker guard and Limiter) and W06 (write gate, `devices.execute` + MFA, and `firmware_writes` delivery) must be merged, and the **Dell** lab gate (Task 16) must have passed. The first firmware write on any vendor must not be a non-Dell one. Moving the stage does not bypass the plan's write conditions: `configure_settings`, `Protection == ProtectionNone`, the BitLocker check, a wrong current value, and the limiter.

**First act run (spec §9 write items).** One device, chosen by the owner. Out of hours. The recovery key is visible in Breeze and written down separately, and someone who can type it is reachable. Check, in order:
1. apply,
2. read back,
3. reboot through Breeze,
4. wake from S5 and from sleep,
5. no BitLocker recovery prompt.

Then widen to 3 devices, then to every canary device of that family. A BitLocker prompt at any point moves the vendor back to `observe` (the kill-switch env first, then a code PR) and returns it to the owner.

---

## 4. Tasks

Every bare path follows the plan's convention (`apps/api/src/` for `routes/`, `services/`, and so on).

### Step 1: OBSERVE (one wave per vendor, still W07, W08 and W09; may run in parallel after O0)

**O0. Shared canary helper.** Ships once, in whichever of the three amendments' first waves merges first. The vendor-updates amendment §4 T-C0 owns it, and the WOL waves consume it.

**O1 (W07/W08/W09 T1). Wire field and server stage.**
- **Files:** `routes/agents/helpers.ts` (`buildWakeOnLanConfigUpdate`), `routes/agents/heartbeat.test.ts`, `agent/internal/heartbeat/wake_config.go`, `wake_config_test.go`.
- **Tests, red first:**
  - `observe_vendors is empty for a non-canary partner`
  - `observe_vendors lists hp when the canary partner's stage is observe`
  - `a disabled vendor in BREEZE_VENDOR_CANARY_DISABLED is omitted`
  - `no wake_on_lan link: block says enabled false and observe_vendors is empty`
  - `budget unchanged`
  - Go: `TestObserveVendorsAbsentMeansNone`, `TestObserveVendorsUnknownVendorIgnored`

**O2 (per vendor T2). Read-only adapter.**
- **Files:** `agent/internal/biosconfig/{hp,lenovo}_windows.go` + `_other.go` + tests + `testdata/<vendor>/doc-derived/*.json`. For Surface: `agent/internal/wakeconfig/surface.go` + test. Plus `biosconfig/adapter.go` (`Detect(manufacturer, model, observeVendors)`).
- `Apply` returns `ErrNotEnabled` and is covered by a test. **No `SetBIOSSetting`, `Lenovo_SetBiosSetting` or `Lenovo_SaveBiosSettings` string may appear in an executed code path at this stage.** A source-scan test enforces it, the same way `TestHpBiosNeverInstallsCmsl` does.
- **Fixtures:** built from vendor documentation (HP *BIOS WMI interface* white paper, Lenovo *Think BIOS Config* / *WMI BIOS Deployment Guide*). They are marked `doc-derived` and replaced by scrubbed captures in the act PR.
- **Tests, red first:**
  - `TestHpReadParsesDocDerived`
  - `TestHpNamespaceAbsentIsInterfaceAbsent` (`0x8004100E`)
  - `TestDenylistBeatsAllowlist` (`Asset Tracking Number`, `Ownership Tag`, `Wake On LAN` with `Asset` in it)
  - `TestBoundsTruncate`
  - `TestControlCharsStripped`
  - `TestLenovoCurrentSettingSplit` (with and without `;[Optional:...]`)
  - `TestLenovoSelectionsOnlyForAllowlistedNames`
  - `TestLenovoIdeaPadAbsent`
  - `TestApplyNotEnabled`
  - `TestNoWriteMethodReachable`
  - Surface: `TestSurfaceAdapterByPnpId`, `TestSurfaceArm64RecordsNativeArch`, `TestHyperVIsNotSurface`, `TestNoMacInObservation`

**O3 (per vendor T3). Snapshot schema and readiness.**
- **Files:** `packages/shared/src/validators/wakeStatus.ts` + test, `agent/internal/wakeconfig/readiness.go` + test, `services/wakeStatusPanel.ts` + test, locale `devices.json` × 8 for `Observing`.
- **Tests:**
  - `vendorObservation is strict and bounded`
  - `oversized observation is rejected, not stored`
  - `an observe-only vendor is always unproven with vendor_observe_only`
  - `observation never changes the fingerprint` (so it does not reset `consecutive_timeouts`)
  - `panel shows Observing without values`
- **Pre-existing finding to fix here:** `normaliseVendor` (`readiness.go:95`) maps any `hewlett*` prefix to `hp`, so `Hewlett Packard Enterprise` servers are labelled HP. Add the near-miss list from the vendor-updates plan's Review Focus 1 as a test, and make HPE `other`.

**O4. Evidence query** (`internal/`, not committed). A read-only script that tallies the observation per vendor and family.

**Replaces:** Task 17 Step 1 ("capture on a real machine") for these vendors. Step 2's tests are now written against doc-derived fixtures first.

### Step 2: ACT (per vendor; only after §3 evidence, W03/W04/W06 merged, and the Dell gate passed)

**A1. Replace the fixtures.** `testdata/<vendor>/captured/*`, scrubbed and built from the observation's allowlisted fields only. Delete `doc-derived/`.

**A2. Apply.** The plan's Task 17 Steps 2–5 as written: `SetBIOSSetting` (HP) or `Lenovo_SetBiosSetting` + `Lenovo_SaveBiosSettings` (Lenovo); return-code mapping; Sure Admin and certificate auth treated as protected; "System Busy" reported as `needs_reboot`; `targets.go` updated from the observed names.

**A3. Stage flip.** `VENDOR_STAGES.wake_on_lan.<vendor> = 'act'`. `vendorCanary.test.ts` asserts the exact table. The PR body carries the §3 tally.

**A4. First act run** (manual, blocking widening) per §3. Results go in the PR.

**A5. Widen** (owner's call, a separate PR): `VENDOR_STAGES.wake_on_lan.<vendor>` → `general`, so the read adapter and `observe_vendors` keep working for every partner, and the vendor is added to the global `WOL_FIRMWARE_WRITE_VENDORS` env. The entry is never deleted, because a missing entry resolves to `off`.

Surface skips A2. Its "act" is a change to the classifier (`ready` for listed models with a Microsoft adapter, spec §6). It ships in A3, with the tests from Task 17 Step 2.

---

## 5. Risks of best-guess code on customer machines, and how observe bounds them

| Risk | Bound |
|---|---|
| A read adapter crashes or hangs WMI on an unusual BIOS | It runs only on canary devices that are under a WOL policy; it uses the 2 s timeout per method call and the collector's existing context deadline; it never runs on the heartbeat goroutine (Task 7 queues it); errors become `interface: error` with a code |
| Collected values leak an asset tag or owner string | Deny-before-allow name filter; values only for allowlisted names; tests on adversarial names; nothing logged above DEBUG; evidence stays in `internal/` |
| A guessed setting name or value is wrong at act | Act needs every target name and value seen in observed output on ≥ 3 devices; readiness already reports `unproven` for a target value outside the observed `Allowed` list (`TestTargetValueNotInAllowedListIsUnproven`); A2 adds `TestApplyRefusesValueOutsideAllowed` so `Apply` refuses it too |
| BIOS write triggers BitLocker recovery | **Observe cannot detect this.** Bounded by W04's guard (no write when PCR 1 is in the profile or the profile is unreadable), by one-device first act with a key-holder reachable, and by the plan's 1 write per setting per 24 h with a stop after 3 failures. Residual risk is for our own tenant only, and acceptance is **pending D-WOL-2** |
| A password-protected BIOS is written | `Protection != None` means no `Apply` call (existing W04 rule); observe confirms the protection read works before act |
| HPE servers mis-labelled HP | Fixed in O3 |
| Consumer HP never becomes `ready` | Correct behaviour: the button still shows under `always`, and under `verified` the device is `unproven` with a clear reason |

---

## 6. Decisions for the owner

- **D-WOL-1 (HP).** Our own tenant has no HP business devices, so HP act cannot be justified from its data.
  - **A. Park HP at `observe`** until a business HP is in a canary tenant or a used unit is bought for the lab.
  - **B. Write HP from documentation alone.**
  - **Recommend A.** A write on unobserved names is exactly what this amendment exists to avoid. HP consumer devices still get a correct `unproven`.
- **D-WOL-2 (first act on a relied-on device).** Accept that the first Lenovo firmware write happens on a device in our own tenant, under §3's protocol. **Recommend yes, Lenovo only.** The owner's 2026-11-19 instruction points this way, but the acceptance is not recorded until the owner answers.
- **D-WOL-3 (enable in production).** Setting `BREEZE_VENDOR_CANARY_PARTNER_IDS` in production is a production change and needs the owner's go.
