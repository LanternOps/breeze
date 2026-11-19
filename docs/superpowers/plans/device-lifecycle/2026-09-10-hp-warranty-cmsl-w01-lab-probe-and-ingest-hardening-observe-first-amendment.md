---
amends:
  - docs/superpowers/plans/device-lifecycle/2026-09-10-hp-warranty-cmsl-w01-lab-probe-and-ingest-hardening.md
  - docs/superpowers/plans/device-lifecycle/2026-09-10-hp-warranty-cmsl-w03-collector.md
  - docs/superpowers/plans/device-lifecycle/2026-09-10-hp-warranty-cmsl-w04-builtin-package.md
  - docs/superpowers/plans/device-lifecycle/2026-09-10-hp-warranty-cmsl-w05-cleanup-and-docs.md
spec: docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md
tracking_issue: LanternOps/breeze#5511
waves: [W01 #5512 lab probe -> observe, W03 #5514 collector, W04 #5515 CMSL package, W05 #5516 cleanup]
companion_amendments:
  - docs/superpowers/plans/vuln-patch/2026-11-05-oem-vendor-updates-observe-first-amendment.md
  - docs/superpowers/plans/devices/2026-10-31-wake-on-lan-management-observe-first-amendment.md
status: draft for owner approval (2026-11-19)
---

# HP warranty via CMSL: observe-first amendment (W01 probe → observe; W03–W05)

This file sits next to the W01 plan because #5511 links that plan. It amends W01, W03, W04 and W05.

## Why this exists

W01's lab probe was never run. On 2026-09-21, #5512 recorded that no HP machine was reachable, and the maintainers parked the feature with "W03–W05 stay gated on this probe". On 2026-11-19 the owner decided we will not get HP lab hardware. Instead, the probe's questions are answered by **observe mode** on real devices in **our own tenant**. That tenant is one partner, identified only by an env value and never named in this repo. The write and act parts then open for that tenant only.

### What is on `main` (checked at `190c74a001`)

- **W01, server half (Tasks 4–11): shipped** in #9404. This covers ingest hardening, entitlements bounds, and the 409 on manual refresh.
- **W01, probe (Tasks 1–3): never committed.**
- **W02: shipped** (#5700). It includes:
  - `hpCmsl` in the warranty policy link, with a server-stamped EULA consent;
  - `routes/configurationPolicies/hpCmslGate.ts`, which requires `devices.execute` and MFA;
  - heartbeat delivery of `warranty_settings.hp_cmsl_enabled` (`routes/agents/helpers.ts:3675`);
  - persistence on the agent side as `HPWarrantyCollectionEnabled` (`agent/internal/heartbeat/warranty_config.go`, `config.go:250`).
- **Not on main:** no collector exists, no partner scoping exists, and `HP_WARRANTY_ENABLED` is dead.
- **Already done:** W05's `agent_cmsl` label is on main via #10456.

### What the fleet in our own tenant can prove

This was checked with a read-only production query on 2026-11-19. Counts and model lists stay out of the repo.

- **Every HP device is a consumer model.** There are no EliteBook, ProBook or Z machines.
- **HP documents CMSL as supported on business PCs.** The WMI warranty namespace `root/HP/InstrumentedServices/v1` is **not confirmed** to exist on consumer HP at all.
- **Expected observe outcome: "no warranty source on this device"** on every one. That is a real answer to the probe's Q1 for consumer HP. It is not a failure. §3 says what follows from it.

### Plan rules this overrides

| Rule | Amended to |
|---|---|
| W01 Tasks 1–3: lab probe script run by hand "on hardware you own or have written permission to modify", with JSON output pasted onto #5512 | **Withdrawn.** The probe's `Baseline` mode (Q1) becomes agent observe (§2). Its `InstallPinned`, `WingetScan`, `Collect` and `Teardown` modes become act steps (§4). **Never paste device output on a public issue.** The probe captured BIOS serial, UUID and hostname, and this repo and its issues are public. |
| W03: "Tasks 2–5 need the probe answers" | Tasks 2–5 are written against **observed** schema. Tasks 1 and 6–10 are independent and may proceed. The collector runs only under `hp_cmsl_mode` (§1), never under the persisted `hp_cmsl_enabled` alone. |
| W04 Gate 1: "a recorded Q1 answer plus Todd's ruling" | The Q1 answer comes from observe tallies (§3). The ruling is D-HPW-1. |

---

## 1. Gating

The shared design and the advisor quorum are in the vendor-updates amendment, §1.
- **Shared helper:** `services/vendorCanary.ts`. It is controlled by env `BREEZE_VENDOR_CANARY_PARTNER_IDS` (empty by default, which means off), env `BREEZE_VENDOR_CANARY_DISABLED`, and the code table `VENDOR_STAGES`.
- **Precedent:** the env partner allowlist `BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST` (`services/oemUpdates/flags.ts:21-30`), together with the code-only gate table in `toolManifest.ts`.
- **Starting state:** `VENDOR_STAGES.hp_warranty = { hp: 'observe' }`.
- **New code constant,** `HP_WARRANTY_ACT_TIERS: readonly ('t0_ingest' | 't1_refresh' | 'install')[] = []`. It lists which act tiers are open. Each tier opens in its own PR (§3).

### How the agent learns: the existing heartbeat block, with explicit fields

`buildWarrantyConfigUpdate` (`helpers.ts:3675`) adds two fields to `warranty_settings`. **It always sends both**, and never omits them.

- `hp_cmsl_mode: 'off' | 'observe' | 'act'`. This is `vendorStage('hp_warranty', 'hp', agent.partnerId)` when the device's policy has `hpCmsl` enabled **with consent to the current EULA** (`warrantyHpCmslCollectionEffective`, `packages/shared/src/validators/warrantyInlineSettings.ts:120`). Otherwise it is `off`.
- `hp_cmsl_tiers: string[]`. This is `HP_WARRANTY_ACT_TIERS` when the mode is `act`, otherwise `[]`.

**Revocation is explicit.** This was adopted from the quorum.
- **Older agents persist `hp_cmsl_enabled` and keep it when the key is omitted.** The server therefore sends `hp_cmsl_enabled: true` only when `hp_cmsl_mode === 'act'`, and `false` otherwise.
- **Agents built with the W03 collector keep `hp_cmsl_mode` and `hp_cmsl_tiers` in memory only.** That authority expires 24 h after the last heartbeat that carried it, and it starts empty after a restart. The collector does nothing without a fresh `observe` or `act`.
- The partner id is already on the heartbeat context (`agent.partnerId`), so this adds **no database query**.

### Why observe still requires the EULA consent

The consent stamp is this feature's existing per-device opt-in. A tech in our own tenant chooses the devices, and the quorum agreed. Observe never uses CMSL, so the EULA itself is not exercised, but reusing the opt-in avoids inventing a second one.

### Precedence on the agent

The agent acts only when all of these hold:

1. The anchored HP manufacturer match is true. `HP`, `HP Inc.` and `Hewlett-Packard` count; `HPE` and `Hewlett Packard Enterprise` do not.
2. `hp_cmsl_mode` is fresh.
3. For any act tier, that tier is in `hp_cmsl_tiers`.

---

## 2. What observe collects

Observe is **W03's T0 path, read-only**, plus detection. The agent never runs `Get-HPWarrantyInfo`, makes no call to HP, runs no winget, installs no module and writes no WMI.

| Item | How | Bound / redaction | Answers |
|---|---|---|---|
| `namespace` | `Get-CimInstance -Namespace root/HP/InstrumentedServices/v1 -ClassName __NAMESPACE` probe | `present`, `absent` (`0x8004100E`) or `access_denied` | Q1, whether the namespace exists without CMSL. Consumer HP is a new case. |
| `classes[]` | Class names in that namespace | ≤ 32 names, ≤ 64 chars each | Whether `HP_Warranty` and `HP_Entitlements` exist under those names |
| `schema.<class>[]` | Property **names and CIM types** for `HP_Warranty` and `HP_Entitlements` | ≤ 64 per class | W03's candidate field lists (W03:1174-1190) |
| `values.<class>` | Values **only** for names passing deny-then-allow. Deny: `(?i)serial\|product.?(number\|no)\|sku\|uuid\|identif\|customer\|email\|name\|address\|phone\|country`. Allow: `(?i)(start\|end\|expir\w*)\w*date\|type\|status\|desc\|level\|coverage\|offer\|lastupdat\|cache\|timestamp` | ≤ 25 rows, value ≤ 64 chars | Date formats, entitlement counts, and the cache-timestamp property behind W03's `hpCacheTTL` and jitter |
| `dateFormat` per date field | Classifies the raw value as `cim_datetime`, `ms_json_date`, `iso8601` or `other` | enum | W03's date parser |
| `rowCounts` | `HP_Warranty` and `HP_Entitlements` row counts | int | The entitlements cap of 25 |
| `cmsl` | Module directories under `Program Files\WindowsPowerShell\Modules` that match `HPCMSL` or `HP.*`, with versions | ≤ 16 | Module path and version guesses (spec:43) |
| `powershell` | PS 5.1 present; TLS 1.2 strong-crypto registry values | bool / enum | Prerequisites (spec:42) |
| `winget` | Whether `winget.exe` is present for SYSTEM (App Installer path), and its file version. Never invoked. | bool, version | Pre-check for Q2 only |
| `businessBios` | Whether `root\HP\InstrumentedBIOS` is present | bool | Consumer versus business marker |
| `conflicts` | HP Support Assistant or HP Insights present, with version | ≤ 4 | Whether consumer HP software brings its own warranty data |
| `nativeArch`, `model`, `family` | As in the vendor-updates amendment | as there | |
| `errors[]` | `{ step, code }` | ≤ 16 | |

**Never collected:** BIOS serial, `IdentifyingNumber`, UUID, hostname, product number value, customer or contact fields, or raw dumps. The serial for any later ingest still comes from `device_hardware` on the server (spec:442).

### Where it goes

The **existing agent-log path**, so there is no new table, column or route.
- **Record format:** one structured record, `component=hp_warranty_observe`, `message=vendor_observation`, with `fields` holding the observation. It is at most 16 KiB, well under the 32,000-character `fields` cap in `routes/agents/logs.ts`.
- **Shipping:** the record is sent with `ShipAlways()` (`agent/internal/logging/logging.go:43`), so the shipping level cannot filter it.
- **Frequency:** at most once per 24 h, plus once when the mode changes.
- **On arrival:** it goes through `redactAgentLogFields` into `agent_logs`. The `fields` column is classified `excludedOpen` in the export policy.

**Retention is 7 days by default** (`AGENT_LOG_RETENTION_DAYS`). That is enough, because the record is re-sent every day while observe is on, so the last 7 days always hold every reporting device.
- When a flip decision is due, the tally is exported into `internal/` (gitignored) and dated, and the PR quotes only the tally.
- A test plus a first-day check confirm that the daily record actually reaches the API. The quorum asked for this.

**Visible to:** technicians in our own tenant, on the device's diagnostic logs (`GET /devices/:id/diagnostic-logs`, `devices.read`) and through MCP `search_agent_logs`. The data shown there is redacted.

---

## 3. Evidence that opens each act tier

**Each tier is its own PR.** That PR adds the tier to `HP_WARRANTY_ACT_TIERS`, sets the stage to `act` the first time, and carries the tally. The owner approves it.

| Tier | What it does | Evidence required | Reachable in our own tenant? |
|---|---|---|---|
| `t0_ingest` | W03 T0: parse WMI and `PUT /agents/:id/warranty-info` (`source: agent_cmsl`). This is a **server-side write only** and changes nothing on the device. | `namespace=present` on ≥ 3 HP devices; the class and property names map to W03's candidates; every date field's format is handled; the entitlement count is ≤ 25; fixtures rebuilt from observed schema, with values replaced | **Unlikely.** Consumer HP probably lacks the namespace. If consumer HP software provides it, this becomes reachable. Observe settles it. |
| `t1_refresh` | W03 T1: run `Get-HPWarrantyInfo` on devices that **already have** CMSL. This calls HP's backend and writes WMI. | `t0_ingest` open; CMSL present on ≥ 2 devices; first act run on one owner-chosen device, capturing the cmdlet's parameters, refresh behaviour and 429 wording | **No.** No device in our own tenant has CMSL. |
| `install` | W04: provision CMSL via winget `HP.HPCMSL` and accept the EULA (the probe's `InstallPinned`, `WingetScan`, `Collect` and `Teardown`) | `t1_refresh` evidence, Q2 answered on one device, and D-HPW-1 | **No.** CMSL targets business PCs, and HP does not support it on consumer models. |

**What observe teaches even with consumer HP only:**
1. Whether consumer HP has any on-device warranty source at all. That is Q1 for consumer devices.
2. Whether consumer HP software, such as HP Support Assistant, exposes warranty data elsewhere. This is recorded as a lead, and it is **not** a guessed new source.
3. PowerShell and TLS prerequisites on real customer devices.
4. That the collector's gating, freshness and redaction behave in production.

**If every consumer HP reports `absent`,** the right outcome is that consumer HP stays `unknown` in the warranty card. That is the current, honest state. The decision returns to the owner (D-HPW-1).

---

## 4. Tasks

### Step 1: OBSERVE (lands under W03 #5514; closing W01 #5512 is D-HPW-2)

**C0. Shared canary helper.** Owned by the vendor-updates amendment (T-C0). Consumed here.

**O1. Server delivery.**
- **Files:** `routes/agents/helpers.ts` (`buildWarrantyConfigUpdate`), `packages/shared/src/validators/warrantyInlineSettings.ts` (wire type), and `routes/agents/heartbeat.test.ts`.
- **Tests, red first:**
  - `hp_cmsl_mode off for a non-canary partner even with consent`
  - `observe for the canary partner with current-EULA consent`
  - `off with stale-EULA consent`
  - `hp_cmsl_enabled false unless act`
  - `fields always present`
  - `disabled pair: off`
  - `hot-path budget unchanged`

**O2. Agent mode handling.**
- **Files:** `agent/internal/heartbeat/warranty_config.go` + test.
- **Tests:**
  - `TestModeNotPersisted`
  - `TestModeExpiresAfter24h`
  - `TestRestartStartsOff`
  - `TestPersistedEnabledAloneDoesNothing`
  - `TestUnknownModeIsOff`

**O3. Observer.** This is W03 Task 1 (types and stubs) plus a new `observe` path.
- **Files:** `agent/internal/collectors/hp_warranty_observe_windows.go`, `_other.go`, `_test.go`, `testdata/hpwarranty/doc-derived/*`.
- **Tests:**
  - `TestObserveNeverInvokesGetHPWarrantyInfo` (source scan, plus a fake exec that fails on any `HPCMSL` import)
  - `TestObserveNeverRunsWinget`
  - `TestNamespaceAbsentRecorded`
  - `TestDenyBeatsAllow` (a `SerialNumber`, a `ProductNumber`, and a `WarrantyEndDate` that has `Serial` in a sibling name)
  - `TestDateFormatClassified`
  - `TestBoundsTruncate`
  - `TestHpeNotHp`
  - `TestShipAlwaysRecordOncePer24h`
- **Ingest test (API):** an `agent_logs` record with this component survives `redactAgentLogFields` with its allowlisted keys intact.

**O4. W03 Tasks 6–10** (bounding, persisted state and jitter, retries and back-off, claim gate, tick wiring). These are probe-independent and proceed as planned. Every tier in them is gated by `hp_cmsl_tiers`, so they are dormant until act.

**O5. Evidence query.** `internal/hp-warranty-observe/tally.sql`. Not committed.

**W01 Tasks 1–3 are replaced.** The probe script is not committed. Its `Baseline` questions are answered by O3.

### Step 2: ACT (per tier, only after §3)

- **A1, `t0_ingest`.** W03 Tasks 2, 3 and 5. Rewrite the T0 parser against observed schema, and replace the invented fixture at W03:964 with a scrubbed one built from the observation. Tier flip PR.
- **A2, `t1_refresh`.** W03 Task 4, plus a first-act run on one device. Capture: parameters, the forced-refresh option, the 429 text, and whether the namespace survives an uninstall. Tier flip PR.
- **A3, `install`.** W04 as planned. Gate 1 is now "§3 `install` evidence plus D-HPW-1". Gate 2 (#5508) is unchanged.
- **A4, widen.** Remove the `VENDOR_STAGES.hp_warranty` entry. Delivery then depends only on consent, as W02 designed.
- **A5, W05 cleanup.** Unchanged, and runs after A3. It may delete `HP_WARRANTY_ENABLED` and `hpProvider.ts` earlier, because they are dead today. Owner's call.

---

## 5. Risks and bounds

| Risk | Bound |
|---|---|
| A WMI query on a consumer HP hangs or errors | It is one namespace probe with the collector's context deadline, never run on the heartbeat goroutine. The error is recorded as a code. |
| Warranty or identity data leaks into logs | The field filter denies before it allows. There is no serial, product number or host field. The `fields` column is `excludedOpen`. Evidence stays in `internal/`. The probe's "paste JSON on #5512" instruction is withdrawn. |
| The stale persisted `hp_cmsl_enabled` later reads as authority | Every act path keys on the fresh in-memory `hp_cmsl_mode` and `hp_cmsl_tiers`. The server sends `false` unless the mode is act. |
| A guessed field mapping shows wrong warranty dates to customers | Nothing is ingested at observe. `t0_ingest` needs observed names and formats on ≥ 3 devices. |
| CMSL install or EULA acceptance on a customer machine | The `install` tier is closed and not reachable from consumer-only evidence. W04's gates still apply. |
| Calls to HP's backend hit the rate limit | Only at `t1_refresh`, which is closed. W03's jitter and back-off apply there. |

---

## 6. Decisions for the owner

- **D-HPW-1, consumer-only HP fleet.**
  - **A. Ship observe, then park `t1_refresh` and `install`** until a business HP is in a canary tenant. Consumer HP stays `unknown`.
  - **B. Trial CMSL on one consumer HP** with that customer's consent. CMSL is not supported on consumer models, so a failure teaches little.
  - **C. Close the feature for now.**
  - **Recommend A.** Observe is cheap, read-only, and settles Q1 for consumer devices. B spends a customer's goodwill on an unsupported path.
- **D-HPW-2, close #5512.** The probe wave is replaced by observe (O1–O3). **Recommend closing it** when the observe PR merges, with a comment pointing here. Closing an issue needs your go.
- **D-HPW-3, production.** Setting the canary env in production is a production change and needs your go.
