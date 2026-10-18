---
title: Device form factor — store the chassis type and derive laptop / desktop / tablet / server / VM on devices
status: approved 2026-10-17 — all decisions as recommended (§13); advisor quorum Fable + Codex gpt-6-astra xhigh folded in (§12)
date: 2026-10-15
issues: "#8834"
related: "#1387 (isVirtual / virtualizationPlatform axis); #2142 (batteryStatus); #5351 memory modules (device_hardware column + partner-export excluded-map precedent); #3834 workload host axis (filter-tier precedent); 2026-10-15 customer asset/inventory ask"
---

# Device form factor

## 1. Problem

Customers doing asset inventory expect "laptop vs desktop" to be a built-in device attribute, but today
they tag it by hand. The agent already collects the signal, and the API throws it away.

Verified on `main` at `601877a6ef`:

- **The agent already sends a chassis value, and the API strips it.** `HardwareInfo.ChassisType`
  carries the JSON tag `chassisType` (`agent/internal/collectors/hardware.go:29`) and is set on every
  `CollectHardware()` (`hardware.go:238`). `PUT /agents/:id/hardware` sends `HardwareInfo` embedded in
  `hardwareInventoryPayload` (`agent/internal/heartbeat/heartbeat.go:2828-2862`). The body is validated
  by `updateHardwareSchema` (`apps/api/src/routes/agents/schemas.ts:939-956`), which has no
  `chassisType` key, so zod's default `strip` mode drops it. The field has been on `HardwareInfo` since
  at least `v0.60.0` (`git show v0.60.0:agent/internal/collectors/hardware.go`). As a result, the whole
  supported fleet **can** already report it, but delivery is not guaranteed: hardware is sent at
  startup and on a daily cadence (`heartbeat.go:2174,2361`), and the field is `omitempty`.
  Enrollment never sends it, because enrollment builds a separate `api.HardwareInfo` without the field
  (`agent/pkg/api/client.go:51`, `agent/internal/agentapp/main.go:1818`). On the API side, enrollment
  persists hardware by explicit field list (`routes/agents/enrollment.ts:~928-965`).
- **How each OS gets the signal:**
  - **Windows:** `classify_windows.go:11-29` shells out to `wmic systemenclosure get ChassisTypes` and
    keeps only the first value. It uses bare `exec.Command` with **no timeout**, unlike every other
    collector, which goes through `runCollectorOutput`. `wmic` is a disabled-by-default Feature on Demand
    on new Windows 11 24H2 installs and is being removed, so on those hosts the value is empty today. The
    rest of the Windows hardware collector already reads WMI through one batched PowerShell
    `Get-CimInstance` call with a `Get-WmiObject` fallback (`hardware_windows.go:76-156`).
  - **Linux:** `classify_linux.go:12-21` reads `/sys/class/dmi/id/chassis_type`, which holds one SMBIOS
    integer. The file is absent on ARM boards without DMI.
  - **macOS:** `classify_darwin.go:5-10` returns `""`. `hardware_darwin.go:47-51` stores
    `SPHardwareDataType.model_name` (the marketing name, e.g. "MacBook Pro") as `Model`. `sysctl hw.model`
    is only a fallback (`:75-83`). The model **identifier** (`machine_model`, e.g. `Mac14,2`) is not
    collected.
- **The role classifier folds the signal away.** `ClassifyDeviceRole` (`classify.go:6-57`) maps laptop
  codes 8/9/10/14, tablet codes 30/31/32 and the desktop codes to `workstation`. Only the derived
  `devices.device_role` is stored (`schema/devices.ts:65-66`; enum in
  `packages/shared/src/validators/deviceRoles.ts:14-36`). Chassis 7 (Tower) returns `workstation`
  before the model and Linux-server heuristics run (`classify.go:20-54`). Only the Windows Server OS
  edition check, which runs first, turns a tower server into `server`.
- **`devices` has no form-factor column.** The only `form_factor` column belongs to memory modules
  (`devices.ts:564`). `isVirtual` / `virtualizationPlatform` (`devices.ts:79-80`) and
  `batteryStatus.present` (`devices.ts:200`, jsonb, written by the heartbeat at `heartbeat.ts:1416`)
  exist, but neither is a filter field (`services/filterEngine.ts:73-148`).
- **The virtualization axis mislabels macOS guests.** The Hyper-V needle `"virtual machine"`
  (`classify.go:115`) matches Apple Virtualization.framework guests ("Apple Virtual Machine 1"), so
  tart/UTM macOS VMs report `isVirtual=true, platform=hyperv`. It is also computed only once, at agent
  startup (`heartbeat.go:1150-1179`). A transient hardware-collection failure at startup leaves the
  value unrefreshed until restart.
- **Hardware ingest never requests dynamic-group re-evaluation.** `requestDeviceGroupReevaluation` is
  called from `heartbeat.ts`, `enrollment.ts`, `provision.ts`, `hardwareHealth/ingest.ts` and
  `assignParkedDevice.ts`. It is **not** called from `routes/agents/inventory.ts` (hardware PUT) or
  from `routes/devices/core.ts` (PATCH). No periodic sweep repairs a missed notification.

## 2. Users and scope

- **MSP tech / internal IT:** filters the device list to "laptops at site X", builds a dynamic group
  "Laptops", adds a Form factor column, and corrects a misclassified device in one click.
- **Customer-facing reporting:** device inventory and hardware lifecycle reports break down by form
  factor, because laptop refresh cycles differ from desktop ones.
- **Integrators:** the Partner API publishes the field (read-only, no new filter). AI `query_devices`
  can filter on it.

In scope:

- agent collection fix (Windows CIM, all `ChassisTypes` values, Mac model identifier, enrollment
  payload)
- API ingest and storage of the raw chassis value
- server-side derivation
- manual override with reset-to-auto
- filter field, list column and Info tab
- two reports
- Partner API field
- AI filter
- versioned backfill/reconciliation
- an `isVirtual` filter field: one line, and the issue names its absence as part of the problem

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Derivation runs server-side** in one pure function, `deriveFormFactor()`, in `packages/shared`. The agent reports raw signals only. | Old agents already send `chassisType`, so Linux and pre-24H2 Windows devices fill in on their next hardware report with **no agent release**. Inputs arrive on two routes (hardware PUT: chassis, model; heartbeat: `isVirtual`, battery, role). Rule fixes ship with the API instead of waiting on fleet promotion. (Codex agreed.) |
| D2 | Raw values go on `device_hardware`: `chassis_types smallint[]` (every SMBIOS code, in reported order) and `model_identifier varchar(64)`. | They sit with the other hardware identity columns, keep every value (dock and expansion enclosures), and let the rules change without re-collecting. A typed array, not jsonb, so it stays `included` in tenant export. |
| D3 | Derived values go on `devices`: `form_factor varchar(20) NOT NULL DEFAULT 'unknown'`, `form_factor_source varchar(10) NOT NULL DEFAULT 'auto'` (both CHECK-constrained), and `form_factor_rules_version smallint` (NULL when manual or never derived). | Mirrors `device_role` / `device_role_source` (varchar, not pgEnum). Widening means dropping and re-adding a CHECK, not `ALTER TYPE … ADD VALUE`. `source` records **ownership** (who decides). The rules version records **which evidence rules** produced an auto value, so reconciliation can find stale rows and the UI does not explain a stored value with newer rules (§5.3, §5.8). |
| D4 | A manual override pins the value. Re-derivation never overwrites a pinned value, and that is enforced in SQL (`WHERE form_factor_source = 'auto'`). **Reset to automatic** recomputes immediately. | Same contract as `deviceRoleSource`, plus the reset path that `deviceRole` lacks. `core.ts:2221-2224` can only set `manual`. |
| D5 | Form factor does **not** re-derive `deviceRole`. The agent's legacy `ChassisType` (role input) keeps its exact current meaning: the **first** reported code. | Role drives privileged targeting (`shouldAutoApplyAgentReportedDeviceRole`, `agents/helpers.ts:3949`). Changing primary-code selection agent-side would change role for WMIC-equipped hosts too, e.g. `[12,23]` (Codex finding). Smarter selection lives only in the server-side derivation. |
| D6 | Precedence: manual → virtual → chassis → Mac model → server role → `unknown`. Battery is **not** used in v1 (OD-4). | VMs report bogus chassis codes (Hyper-V reports 3). Battery is untrustworthy as shipped: a USB HID UPS appears through `GetSystemPowerStatus`, and `mapWindowsPowerStatus` turns the 255/unknown flag into `Present:true` (`battery.go:112-119`). |
| D7 | Unparseable chassis input never fails the hardware report: it is discarded, not coerced. | Same rule as `memory` (#5351) and `coverageKind` (#1320). A 400 here would drop the whole hardware record. |
| D8 | Backfill is a **versioned reconciliation** job running the same `deriveFormFactor()`, with one org per top-level transaction. No SQL copy of the rules. | One implementation. Rule changes re-derive stale auto rows (`rules_version < current`), not just `unknown` ones. Batches that span orgs can violate the partner-export org-lock ordering (`2026-07-18-partner-export-org-locks.sql:58-65,142-145`). (Codex finding.) |
| D9 | `formFactor` is **refused** as an execution-target filter field. | Its derivation consumes the refused `deviceRole` and exposes an agent-influenced `server` value. The execution gate checks named fields, not their derivation inputs (`filterEngine.ts:205-266`). (Changed after Codex review; `isVirtual` is allowed, OD-6.) |

## 4. Agent changes (agent-shipped → full rigor)

### 4.1 Windows: drop `wmic`, collect all values

- Add `Win32_SystemEnclosure` to the batched script in `collectPlatformHardware`
  (`hardware_windows.go:87-118`), using the existing `Get-WmiSafe` helper:
  `ChassisTypes = @(@(Get-WmiSafe 'Win32_SystemEnclosure') | ForEach-Object { $_.ChassisTypes } | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ })`.
  This is the union of every enclosure instance in SMBIOS order, so a docking-station enclosure keeps
  its value.
- Decode with a scalar-or-array tolerant `intList`, the twin of `gpuNameList`
  (`hardware_wmi_parse.go:8-38`). PowerShell 5.1 collapses a one-element array to a scalar, which is the
  common case. A malformed value for this key yields "not collected" and must **not** fail the batch
  decode, so serial, model and the other fields still populate.
- Delete the `wmic` path in `classify_windows.go`. On Windows, `hw.ChassisType` is set inside
  `collectPlatformHardware` to `strconv.Itoa(ChassisTypes[0])`, the first value, exactly what `wmic`
  returned (D5). The generic `hw.ChassisType = getChassisType()` call at `hardware.go:238` runs before
  `collectPlatformHardware`, so it must not overwrite the value: make it platform-specific or move it
  after.
- No new process spawn and no `wmic` dependency. The failure mode is unchanged: if PowerShell is blocked
  by WDAC or AppLocker, every WMI field is empty for that cycle.

### 4.2 Linux

The `/sys/class/dmi/id/chassis_type` read is unchanged. It also fills `ChassisTypes` with a one-element
slice when the value parses as an integer 0–255, or `[]` when the file does not exist (the platform has
no DMI).

### 4.3 macOS

- Parse `machine_model` from the `SPHardwareDataType` JSON that is already fetched
  (`hardware_darwin.go:16-23`, new struct field) into `HardwareInfo.ModelIdentifier`. When that is
  empty, fall back to `sysctl -n hw.model`. No new command.
- `ChassisTypes` = `[]`, because Apple exposes no SMBIOS chassis.

### 4.4 Wire format and back-compat

- `HardwareInfo` gains `ChassisTypes []int \`json:"chassisTypes"\`` (**no** `omitempty`) and
  `ModelIdentifier string \`json:"modelIdentifier,omitempty"\``. `ChassisType string` stays (legacy,
  first code).
- **Failed vs empty:** a `nil` slice serializes to `null`, meaning "not collected / failed", and the API
  leaves the stored value untouched. `[]` means "collected; this platform has none", and the API stores
  `'{}'`, clearing stale values. `omitempty` cannot express that difference (Codex finding).
- The enrollment `api.HardwareInfo` (`agent/pkg/api/client.go`) gains the same two fields, so new
  devices classify at enrollment.

| Agent | API | Result |
|---|---|---|
| old | old | unchanged |
| old | new | legacy `chassisType` string parsed to `[n]`. Linux and pre-24H2 Windows derive on the next hardware report. macOS derives from `model` (marketing name). Windows 24H2+ without `wmic` stays `unknown` until agent upgrade |
| new | old | `chassisTypes` / `modelIdentifier` stripped (schema is not `.strict()`). Wire-compatible. Role inputs only differ on hosts where `wmic` was missing (§4.5) |
| new | new | full signal |

No version gate is needed. A missing key is the gate.

### 4.5 Role classification

`ClassifyDeviceRole` and its input meaning are unchanged (D5). The behavioural change is confined to
Windows hosts where `wmic` was missing: the role now sees a real first code. Laptops and desktops stay
`workstation`. A rack-chassis client OS would now report `server`, a privileged flip that the API
already blocks and audits (`heartbeat.ts:1240-1254`). Regression-test it explicitly and note it in the
agent release notes.

## 5. API

### 5.1 Ingest schema (`routes/agents/schemas.ts`, `updateHardwareSchema` + enrollment `hardwareInfo`)

```ts
chassisType: z.string().max(32).optional().catch(undefined),                      // legacy
chassisTypes: z.array(z.number().int().min(0).max(255)).max(16).nullable().optional().catch(undefined),
modelIdentifier: z.string().max(64).optional().catch(undefined),
```

`.catch(undefined)` **discards** a malformed value. It does not coerce.

### 5.2 Normalization (`services/formFactor.ts`)

`normalizeChassisReport({ chassisTypes, chassisType })`:

- `chassisTypes` is an array → use it.
- `chassisTypes === null`, or absent with no legacy value → `undefined` (leave untouched).
- Otherwise the legacy string must **fully** match `^\{?\s*\d{1,3}(\s*,\s*\d{1,3})*\s*\}?$`. Parse
  every code and drop any above 255.
- Anything else → `undefined`. Values like `"10garbage"` and `"1000"` are rejected.

### 5.3 Derivation: `deriveFormFactor()` in `packages/shared/src/validators/formFactor.ts`

`FORM_FACTORS = ['laptop', 'desktop', 'tablet', 'server', 'virtual_machine', 'other', 'unknown']`
(OD-1). `other` means a recognized class that has no bucket (handheld, IoT gateway, embedded PC).
`unknown` means insufficient evidence. Export `FORM_FACTOR_RULES_VERSION = 1`.

Pure function. Input: `{ chassisTypes, osType, model, modelIdentifier, isVirtual, deviceRole }`.
Output: `{ formFactor, basis: { kind: 'virtual'|'chassis'|'chassis_conflict'|'mac_model'|'server_role'|'none', codes?, detail? } }`.

Order, first match wins:

1. **Virtual:** `isVirtual === true`, or `model` / `modelIdentifier` matches Apple guest strings
   (`/^Apple Virtual Machine/i`, `/^VirtualMac/i`) → `virtual_machine`. The `isVirtual` check already
   covers "Apple Virtual Machine" (mislabelled `hyperv`, §1). The `VirtualMac` identifier is the
   backstop. Confirm both on the Sequoia tart VM.
2. **Chassis:** map every **recognized** code in the table below and ignore the rest. Unassigned codes
   (`0`, `>36`) and the ignore set {1, 2, 12, 18–22} cannot hide a valid code: `[0,10]` and `[12,10]`
   are both laptops. If recognized codes map to more than one class, the class precedence
   tablet > laptop > server > desktop > other decides, and the basis kind is `chassis_conflict` (OD-3).
3. **Server-role refinement:** chassis class `desktop`, specifically code 3, 6 or 7, and
   `deviceRole === 'server'` → `server`. This narrows the draft's "any desktop code". It fires for a
   Windows Server OS on a tower or desktop chassis, and for a manually set server role. In practice
   this makes `server` an inventory category informed by role, not purely physical (OD-2).
4. **Mac model** (`osType === 'macos'`): marketing name first, identifier second.
   - Name `MacBook*`, or identifier `MacBookPro*` / `MacBookAir*` / `MacBook\d` → `laptop`.
   - Name `iMac*`, `Mac mini`, `Mac Studio` or `Mac Pro`, or identifier `iMac*` / `Macmini*` /
     `MacPro*` → `desktop`.
   - Identifier prefixes survive through the M1 generation (`MacBookAir10,1`). From 2022 onward,
     Apple uses `MacNN,M` for **every** line (`Mac14,2` is a MacBook Air, `Mac14,3` a Mac mini), so an
     identifier of that shape alone never classifies. The marketing name does.
5. **Server role, no chassis:** no recognized chassis and `deviceRole === 'server'` → `server`.
6. Otherwise `unknown`.

SMBIOS chassis code → class (DMTF DSP0134 §7.4.1):

| Codes | Meaning | Class |
|---|---|---|
| 8, 9, 10, 14 | Portable, Laptop, Notebook, Sub Notebook | `laptop` |
| 31 | Convertible (attached keyboard) | `laptop` |
| 30, 32 | Tablet, Detachable (Surface Pro-style) | `tablet` (OD-1 for 32) |
| 3, 4, 5, 6, 7, 15, 16, 24 | Desktop, Low Profile, Pizza Box, Mini Tower, Tower, Space-saving, Lunch Box, Sealed-case PC | `desktop` |
| 13 | All in One | `desktop` (OD-1) |
| 35, 36 | Mini PC, Stick PC | `desktop` (OD-1) |
| 17, 23, 25, 26, 27, 28, 29 | Main Server, Rack Mount, Multi-system, Compact PCI, Advanced TCA, Blade, Blade Enclosure | `server` |
| 11, 33, 34 | Hand Held, IoT Gateway, Embedded PC | `other` |
| 1, 2, 12, 18–22 | Other, Unknown, Docking, expansion/peripheral/RAID enclosures | ignored |
| 0, >36 | unassigned | ignored |

### 5.4 Where derivation runs: `recomputeFormFactor(tx, deviceId)`

**Concurrency protocol (Codex finding).** Every caller runs inside a transaction that first takes
`SELECT … FROM devices WHERE id = $1 FOR UPDATE` and then reads `device_hardware`. Lock order is
**devices row → device_hardware**, everywhere. The write is
`UPDATE devices SET form_factor = $v, form_factor_rules_version = $ver WHERE id = $1 AND form_factor_source = 'auto'`
and is skipped when nothing changed. A concurrent manual PATCH serializes on the row lock, and the
SQL predicate means a pinned value can never be overwritten, even by a stale caller.

Callers:

- **Hardware PUT** (`routes/agents/inventory.ts`): the `writeHardwareReport` transaction
  (`services/inventoryChildSync.ts:369-392`) locks the device row **before** upserting
  `device_hardware`, then recomputes. `HardwareReportColumns` gains `chassisTypes` and
  `modelIdentifier`. An undefined key is omitted from the upsert `set`.
- **Enrollment** (`routes/agents/enrollment.ts:~928-965`): persists the new hardware fields and derives
  in the enrollment transaction.
- **Heartbeat** (`routes/agents/heartbeat.ts`): recomputes only when an **accepted** change to
  `deviceRole` or `isVirtual` lands in `deviceUpdates`. These are effective post-merge values, not raw
  reports. That is rare, so the common beat pays one comparison and never reads `device_hardware`.
  When it fires, the recompute runs after the `devices` update in the same transaction, which already
  holds the row lock.
- **PATCH** `deviceRole` change or `formFactor: null` reset (§5.5), and the **reconciliation job**
  (§5.8).

### 5.5 Manual override (`routes/devices/core.ts` PATCH, schema `routes/devices/schemas.ts:217`)

- `formFactor: z.enum(FORM_FACTORS).nullable().optional()`.
  - A value sets `form_factor = value`, `form_factor_source = 'manual'` and
    `form_factor_rules_version = NULL`.
  - `null` sets `source = 'auto'`, then runs `recomputeFormFactor` in the same request transaction.
- Same permission as the role edit. The audit details carry **before and after** for both value and
  source.

### 5.6 Dynamic-group re-evaluation

Every path that changes `devices.form_factor` calls `requestDeviceGroupReevaluation({ deviceId, orgId,
eventType: 'device.updated', reason, changedFields: ['formFactor'] })` from
`runAfterDbContextCommit` (`db/index.ts:858`), so it runs after commit. The paths are hardware PUT,
enrollment, heartbeat, PATCH and reconciliation. (`heartbeat.ts:1690` enqueues inside the transaction
and relies on `deviceGroupJobs.ts:203-229`'s five-second delay. New code uses the real hook.)
Because `isVirtual` becomes a filter field, the heartbeat's `filterableChangedFields` list
(`heartbeat.ts:1695`) also gains `isVirtual` (and `formFactor`), so an `isVirtual` flip notifies even
when form factor is pinned or unchanged.

The wider gap stays out of scope (§9): PATCH edits of `deviceRole`, `tags` and custom fields never
re-evaluate.

### 5.7 Read surfaces

- `PUBLIC_DEVICE_FIELDS` (`routes/devices/helpers.ts:15-27`): add `formFactor`, `formFactorSource`
  and `formFactorRulesVersion`. The list projections (`core.ts:~1250`, `~1481`) add the first two. The
  detail view uses the public projection (`core.ts:~1763`), and its hardware block exposes
  `chassisTypes` and `modelIdentifier`.
- `SAFE_DEVICE_RESOURCE_FIELDS` (`routes/mcpServer.ts:2550`): add `formFactor`, `formFactorSource`.
- **Filter engine** (`services/filterEngine.ts:73`): `formFactor` (enum, column on `devices`) and
  `isVirtual` (boolean). Execution tier (`:205-266` table + `EXECUTION_REFUSED_AGENT_FIELDS`):
  `formFactor` **refused** (D9), `isVirtual` **allowed** (OD-6). Web mirrors:
  `apps/web/src/components/filters/filterFields.ts` (guarded by `filterFields.apiParity.test.ts`) and
  `apps/web/src/lib/executionRefusedFields.ts`.
- **AI `query_devices`:** add a `formFactor` enum filter in all **three** schemas: `aiToolSchemas.ts:204`,
  the JSON `input_schema` in `aiToolsDevice.ts:166-180`, and the SDK tool in `aiAgentSdkTools.ts:~1588`.
  Add the handler condition and `formFactor` in the summary row. Use a zod enum, never `z.undefined()`.
- **Partner API** (`routes/partnerApi/devices.ts:111-117`): add `type.formFactor`, and add it to the
  **strict** `partnerDeviceExportRecordSchema.type` (`routes/partnerApi/schemas.ts:141-149`).
  Otherwise response parsing 500s. No Partner API filter in this spec (OD-9). `form_factor_source` is
  not published. Because `devices` changes are fingerprinted by explicit ROW lists in
  `breeze_partner_export_devices_update` (only definition: `2026-07-18-partner-export-org-locks.sql:310-360`,
  **three comparisons / six ROW tuples**), the migration replays it with `form_factor` in all six.
  Otherwise a form-factor change never advances `partner_export_updated_at`.

### 5.8 Reconciliation job (`jobs/formFactorReconcile.ts`)

This is a boot job. Selection: `form_factor_source = 'auto' AND form_factor_rules_version IS DISTINCT
FROM <current>`. That covers both the initial backfill (all NULL) and future rule bumps.

- Runs with `runOutsideDbContext` + `withSystemDbAccessContext`.
- **No outer transaction.** It groups candidates by `org_id`, and each org's devices go in keyset
  chunks of ≤500. Each chunk is its own **top-level** transaction, so the partner-export org lock is
  only ever one org, in order. Do not copy `patchScheduleBackfill.ts:34`, whose inner "transactions"
  are savepoints under one outer transaction.
- Each device is processed with the §5.4 protocol and after-commit re-evaluation.
- A Redis/advisory lock (`pg_try_advisory_lock` on a fixed key) means only one replica runs it. The
  others skip.
- It logs `{ scanned, changed, failed }` and is safe to rerun. Rerunning converges, because
  reconciled rows carry the current version.
- On day one it classifies VMs and Macs (from the stored marketing name) and stamps everything else
  `unknown` at v1. Windows and Linux rows re-derive on their next hardware report. It does **not** guess
  from Windows or Linux model strings: Lenovo reports machine-type codes (`20XWCTO1WW`) as
  `Win32_ComputerSystem.Model`, and vendor-family regexes rot.

## 6. Web

- **Info tab** (`DeviceInfoTab.tsx:~945-1027`): add a "Form factor" row beside Device Role.
  - It shows the value label and an Auto/Manual badge (`getDeviceRoleSourceColor/Label` styling).
  - For auto values whose `formFactorRulesVersion === FORM_FACTOR_RULES_VERSION`, add a muted basis
    line recomputed from the stored inputs ("Chassis type 10 (Notebook)", "Model: MacBook Pro",
    "Virtual machine", "Conflicting chassis codes 3, 10", "No hardware report yet"). When the versions
    differ, show no basis rather than a possibly wrong one. The page needs `chassisTypes`,
    `modelIdentifier`, `model`, `isVirtual` and `deviceRole`, all already on the detail payload after
    §5.7.
  - Edit opens a select. When manual, show "Reset to automatic" (`PATCH { formFactor: null }`).
  - Both mutations go through `runAction`, and every control gets a `data-testid`.
- **Device list column** `formFactor` ("Form factor"): add it to `COLUMN_IDS` / `COLUMN_LABELS`, the
  `columnDefs` cell renderer and the row type in `DeviceList.tsx`, and the sort key list if sortable
  (`routes/devices/schemas.ts:55`). Leave it **out of** `DEFAULT_VISIBLE_COLUMNS`.
- Labels live in `apps/web/src/lib/formFactors.ts`, importing `FORM_FACTORS` from `@breeze/shared`.
  New i18n keys go in **all 7 locales** (`localeParity`).

## 7. Reports

- **device_inventory** (`reportGenerationService.ts`, device branch ~395-410): add `formFactor`.
  Manual-asset rows show "—".
- **hardware_lifecycle** (`hardwareLifecycleReport.ts:168-222`):
  - Add `formFactor` to `Subject` / `HardwareLifecycleDeviceRow` and a column plus count breakdown.
  - Change the VM exclusion (`:174`) from `is_virtual = false` to also exclude
    `form_factor = 'virtual_machine'`, so model-detected VMs (`VirtualMac`) stop counting as hardware
    to replace.
- The `export_dataset` device_inventory adapter picks the column up through the shared row type.
  Assert this in the report contract test.

## 8. Tenancy and data model impact

No new table. **Two** migrations, named at implementation time to sort after the newest committed one
(today `2026-12-28-130000-…`). Do not use the closed `2026-08-06` block. Both must be idempotent, with
no inner `BEGIN/COMMIT`. `autoMigrate.ts:832` runs each file in **one** transaction. A `VALIDATE` in
the same file as the `ADD COLUMN` / `ADD CONSTRAINT` would hold the `ACCESS EXCLUSIVE` lock through the
full scan of `devices`, hence the split (Codex finding).

**Migration A** (`…-device-form-factor.sql`):

1. Columns on `device_hardware`:
   - `ADD COLUMN IF NOT EXISTS chassis_types smallint[]`
   - `ADD COLUMN IF NOT EXISTS model_identifier varchar(64)`
2. Columns on `devices`:
   - `form_factor varchar(20) NOT NULL DEFAULT 'unknown'`
   - `form_factor_source varchar(10) NOT NULL DEFAULT 'auto'`
   - `form_factor_rules_version smallint`

   Constant defaults are metadata-only (PG11+), so there is no table rewrite.
3. `devices_form_factor_chk` and `devices_form_factor_source_chk`, added `NOT VALID` and guarded by
   `pg_constraint` existence checks. They are enforced for new writes immediately.
4. Replay `breeze_partner_export_devices_update` with `form_factor` in all six ROW tuples. Keep every
   other line verbatim.
5. Replay `breeze_partner_export_device_child_update` verbatim from its latest body
   (`2026-11-01-110000-device-memory-modules.sql`; re-check at implementation time). Add
   `chassis_types` and `model_identifier` to the `device_hardware` excluded map, and preserve the
   owner validation, the other exclusions and the lock-on-change order. The partner export does not
   publish these columns. Left material, each device's first post-deploy report (NULL → value) would
   take the exclusive org lock and advance the inventory watermark for nothing. This follows the same
   reasoning as `memory_observed_at`.
6. Writes no rows, so no `breeze.scope` election.

**Migration B** (`…-device-form-factor-validate.sql`): `VALIDATE CONSTRAINT` for both checks. This
takes `SHARE UPDATE EXCLUSIVE` and does not block writes. Then run `pnpm db:check-drift`.

**RLS and cascade.** Both tables already have org RLS, and new columns inherit it. Both tables are
already in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry` and the device lists, so nothing new is
needed there.

**Tenant export classification** (`services/tenantExportPolicyRegistry.ts`). This is the only registry
that fires on a new column:

| Table | Column | Bucket | Why |
|---|---|---|---|
| `device_hardware` (`:383`) | `chassis_types` | `included` | `smallint[]`, a typed array, not json/jsonb/bytea (same rule as `metric_names text[]`) |
| `device_hardware` | `model_identifier` | `included` | plain varchar hardware identity; no suspicious name part |
| `devices` (`:436`) | `form_factor` | `included` | descriptive enum string |
| `devices` | `form_factor_source` | `included` | provenance; sibling `device_role_source` is `included` |
| `devices` | `form_factor_rules_version` | `included` | monotonic counter |

Codex reviewed these classifications and agreed. The `tenant-export-policy` and
`tenantExportErasureRoundtrip` suites fail only under **Integration Tests**, so run them locally
against `pnpm test-stack` before the PR.

**Drizzle** (`schema/devices.ts`): `chassisTypes: smallint('chassis_types').array()`,
`modelIdentifier`, `formFactor: varchar(...).$type<FormFactor>()`, `formFactorSource`,
`formFactorRulesVersion`.

## 9. Out of scope

- Bulk form-factor edit from the device list. Pair it with the bulk-tag ask as a separate issue.
- Form factor on **manual assets**. `manual_assets.asset_type` uses the role-shaped
  `discovered_asset_type` enum. Reports show "—" for them.
- Fixing PATCH-path dynamic-group re-evaluation for `deviceRole` / `tags` / custom fields (§5.6). File
  it as its own defect.
- Repairing the virtualization axis for macOS guests (OD-7) and refreshing `isVirtual` after a failed
  startup collection (§1). Both are agent changes to an existing axis.
- A `battery_present` filter field and any battery-based derivation (OD-4).
- Partner API filtering by form factor (OD-9).
- Re-deriving `deviceRole` (D5), Raspberry Pi / ARM device-tree form factors, and monitors or docks as
  assets.

## 10. Test and rollout notes

**TDD, red first, on every layer.**

**Go** (`agent/internal/collectors`):

- `intList` decoding: scalar `9`, array `[10,12]`, `null`, `""`, and garbage all decode without
  failing the batch.
- Windows batch fixture JSON with and without `ChassisTypes`. Assert serial and model still populate,
  and `ChassisType` = first code.
- Marshal test: `nil` → `"chassisTypes":null`, `[]int{}` → `[]`.
- macOS `SPHardwareDataType` fixtures: MacBook Air M2 ("MacBook Air" / `Mac14,2`), Mac mini M2,
  `MacBookAir10,1`, Intel `MacBookPro16,1`, tart VM.
- Linux missing-file → `[]`.
- `ClassifyDeviceRole` unchanged for every existing case, plus `[12,23]` behaviour pinned.
- `go test -race ./...`, plus windows/darwin/linux cross-compiles.

**Shared:** a `deriveFormFactor` table covering:

- every code 0–40
- unrecognized-before-recognized (`[0,10]`, `[255,10]`, `[12,10]`)
- conflicts (`[3,10]`, `[23,3]`)
- the narrowed server refinement (code 7 + role server → server; code 13 + role server → desktop)
- Mac name vs identifier (`Mac14,2` with no name → `unknown`)
- Apple guest strings
- `isVirtual` override
- rules-version export

**API:**

- **Schema and normalization:**
  - schema discards garbage without a 400
  - legacy regex rejects `"10garbage"` and `"1000"`
  - `null` keeps the stored value, `[]` clears it
- **Override and recompute:**
  - `form_factor` is written only when source is auto, with the SQL predicate tested by a stale
    caller
  - PATCH with a value → manual with audit before/after; `null` → auto + recompute
  - heartbeat recomputes only on accepted role or `isVirtual` changes
- **Concurrency:** manual PATCH racing hardware PUT, reset racing reconciliation. Two
  `test-stack` connections assert the pinned value survives.
- **Re-evaluation:**
  - enqueued after commit, and not enqueued on rollback
  - `eventType` / `reason` present
  - an `isVirtual` flip notifies independently
- **Enrollment** persists and derives.
- **filterEngine:** `formFactor` equals/in/notIn SQL; tier tests (`formFactor` refused) plus web
  parity.
- **Reconciliation job:**
  - second run changes 0
  - rule-version bump re-derives auto rows and leaves manual rows alone
  - one org per transaction (a multi-org fixture must not deadlock or raise the lock-order error)
- **Partner API:**
  - strict schema parses `type.formFactor`
  - integration: a form-factor change advances `partner_export_updated_at`; a chassis-only or
    source-only change does not
- **AI:** `query_devices` filter in all three schemas.

**Contract suites:**

- `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`,
  the partner-export integration suites, and tenant/site isolation, all locally against
  `pnpm test-stack up`. Tear it down afterwards.
- `filterFields.apiParity.test.ts`, the AI-tool contract tests (line-keyed `SAFE_WRITE_SITES`;
  re-key if `aiToolsDevice.ts` lines shift), and `localeParity`.

**Lab verification (required before the agent PR merges).** Devices:

- a real Windows 11 24H2 laptop with `wmic` absent (`Get-WindowsCapability -Online -Name WMIC*`)
- a real desktop
- the Hyper-V lab VM (`.55`, expect `virtual_machine`)
- a Linux laptop or desktop
- an Apple Silicon MacBook
- the Sequoia tart VM (#8390 recipe; record the actual model strings)

For each, record raw `chassis_types` / `model_identifier`, the derived value and basis, and a filter
and dynamic-group hit. Also run an **old agent against the new API** (chassis arrives through legacy
`chassisType`).

**Rollout:**

- **W1:** shared derivation, both migrations, ingest, enrollment, recompute, reconciliation and read
  surfaces.
- **W2:** web, reports, AI and Partner API.
- **W3:** agent changes plus lab work. W1 and W2 can be one PR if small. W3 is wire-independent.

W1 and W2 give value with no agent release (Linux and pre-24H2 Windows on their next hardware report,
Macs and VMs immediately). The W3 change reaches devices only after an agent release **and fleet
promote**: the `release` skill notes that the tag alone does not update agents. Until then, 24H2+
Windows devices without `wmic` stay `unknown`. The self-host note: migrations only, no env vars, and a
boot reconciliation job that logs its progress.

## 11. Risks

- **Vendors that misreport SMBIOS.** Some white-box boards report 3 for everything, and some mini PCs
  report 1 or 2. Manual override plus reset covers it, and the basis line makes a wrong derivation
  visible.
- **Heartbeat hot path.** Recompute runs only on an accepted role or `isVirtual` change. The heartbeat
  never reads `device_hardware` per beat.
- **Lock order.** Every recompute takes the devices row before `device_hardware`. The hardware PUT
  gains a `devices` row lock once per device per day.
- **Migration on `devices`.** Metadata-only adds, a `NOT VALID` check, then validation in a separate
  transaction.

## 12. Advisor quorum record

Codex `gpt-6-astra`, `xhigh`, read-only, reviewed the Fable draft against `601877a6ef` on 2026-10-15.

- **Agreed:** server-side derivation; raw `smallint[]` on `device_hardware` plus checked varchar
  value/source on `devices`; the seven-member enum with all-in-one / mini-PC kept in raw data;
  convertible → laptop, detachable → tablet; VM first; no `deviceRole` re-derivation; extending the
  batched CIM query instead of in-process WMI; both partner-export trigger replays; the four tenant-export
  `included` classifications; the existing-table RLS and cascade conclusions.
- **Changed after review:**
  - **Agent role inputs:** legacy `ChassisType` stays first-code. The draft's agent-side
    primary-code selection would have changed role for WMIC hosts (`[12,23]`).
  - **Chassis selection:** among recognized codes only, with explicit conflict precedence.
  - **Server refinement:** narrowed from "any desktop code" to 3/6/7.
  - **Battery:** removed from v1 (Windows 255 → `Present:true`, UPS).
  - **Apple guest facts:** "Apple Virtual Machine" is caught by the Hyper-V needle and is not
    `isVirtual=false`. Apple identifier prefixes survive through M1.
  - **Execution tier:** `formFactor` flipped from allowed to **refused**.
  - **Re-evaluation:** enqueued through `runAfterDbContextCommit` with `eventType` / `reason`, not
    in-transaction. `isVirtual` notifies independently.
  - **Recompute and concurrency:** recompute added on accepted role changes and enrollment, with an
    explicit row-lock + SQL predicate protocol.
  - **Wire format:** `chassisTypes` sends `null` vs `[]` (no `omitempty`) so stale values can clear.
    The legacy regex must fully match.
  - **Trigger replay:** six ROW tuples, not two.
  - **Migrations:** CHECK validation split into a second migration (one transaction per file).
  - **Backfill:** became versioned reconciliation (`form_factor_rules_version`), one org per top-level
    transaction, single-replica lock.
  - **Missing surfaces added:** strict Partner schema, the third `query_devices` schema, enrollment
    persistence, the hardware-lifecycle VM exclusion, and the list renderer and row type.
- **Left open at review, approved 2026-10-17 (§13):** the meaning of `server` (OD-2), conflict precedence (OD-3), battery (OD-4),
  the `isVirtual` execution tier (OD-6), the virtualization-axis repair (OD-7), and Partner API
  filtering (OD-9).

## 13. Decisions (approved 2026-10-17)

Todd approved every decision as recommended on 2026-10-17. The OD numbering is kept so in-text
references still resolve. Rejected options are kept one line each for the record.

1. **OD-1: Seven-value enum (option a).** `laptop, desktop, tablet, server, virtual_machine, other,
   unknown`. All-in-one (13) and mini/stick PC (35/36) fold into `desktop`; convertible (31) → laptop;
   detachable (32) → tablet. The raw code is kept for sub-typing, and a later widening is a CHECK swap.
   Rejected: (b) `all_in_one` and `mini_pc` buckets.
2. **OD-2: `server` is an inventory category informed by role (option b).** Server-class chassis, or
   role `server` on a 3/6/7 chassis or with no chassis. Documented as role-informed, which is one reason
   `formFactor` is execution-refused (D9). Rejected: (a) purely physical.
3. **OD-3: Conflicting recognized chassis classes use class precedence tablet > laptop > server >
   desktop > other (option a)**, with basis kind `chassis_conflict` shown as "conflicting". Revisit
   with lab data. Rejected: (b) `unknown` on conflict; (c) first recognized code.
4. **OD-4: Battery is never evidence in v1 (option a).** Option (c), a trusted internal-battery signal,
   is a follow-up only if 24H2+ Windows `unknown`s stay common after the agent wave. Rejected: (b)
   battery-only → laptop.
5. **OD-5: No `deviceRole` re-derivation from form factor; collect and store every `ChassisTypes`
   value** (union of enclosure instances) through the existing batched CIM query, not in-process WMI.
   The agent's role input stays the first code.
6. **OD-6: `isVirtual` is an allowed execution-target filter field (option a)**, like `hardware.*`.
   `formFactor` stays refused regardless (D9). Rejected: (b) refused.
7. **OD-7: The macOS-guest virtualization-axis repair is a follow-up issue (option b)**, not part of
   this spec. Form factor already classifies these VMs through `isVirtual`. Rejected: (a) widen the API
   enum in W1 and add the agent marker in W3.
8. **OD-8: Per-row `form_factor_rules_version` plus a reconciliation job; the basis is recomputed
   client-side only when versions match (option a).** Rejected: (b) a stored `form_factor_basis`
   column; (c) relying on the next hardware report only.
9. **OD-9: The Partner API publishes the field only (option a).** No query filter. Rejected: (b) a
   Partner API filter.
10. **OD-10: The list column is opt-in, hidden by default (option a).** Revisit if the requesting
    customer finds it undiscoverable. Rejected: (b) visible by default.
