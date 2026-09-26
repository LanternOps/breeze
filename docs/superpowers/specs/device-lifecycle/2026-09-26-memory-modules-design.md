---
issue: LanternOps/breeze#5351
status: approved-scope
quorum: Opus 5.5 + Codex gpt-6-astra xhigh, 2026-09-26 — AGREE on D1/D2, amendments folded in
---

# Device memory modules (per-slot RAM inventory) — design

## Problem

The device hardware view shows one memory number (`device_hardware.ram_total_mb`,
from gopsutil). MSPs want per-slot detail for upgrade planning: slot label,
capacity, type, speed, manufacturer, part number, serial, and how many slots are
free (#5351). Today users approximate it with script custom fields (#7121).

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Per-slot rows in a new child table `device_memory_modules`, not a jsonb column on `device_hardware` | Matches the `device_disks` / `device_network` precedent; queryable for fleet questions; a jsonb column would be `excludedOpen` and vanish from tenant export |
| D2 | Agent reads raw SMBIOS (type 16 Physical Memory Array, type 17 Memory Device) on Windows and Linux with one pure Go parser; macOS uses `system_profiler SPMemoryDataType -json` | One code path; type 17 enumerates **empty** slots so the free-slot count is direct; no PowerShell cost, no `dmidecode` dependency |
| D3 | v1 is inventory display: UI, REST read route, AI tool, partner inventory reconstruction | Change events (DIMM added/removed), fleet filters/reports and ECC counters are follow-ups |
| D4 | Empty slots are stored as rows with `populated = false` | UI lists them by label; free = count of unpopulated rows |
| D5 | Collected only on the hardware-send path (startup, 24 h, manual refresh), independently guarded, not inside `CollectHardware()` | `CollectHardware()` also runs every 15 min from the change tracker and at enrollment; a memory failure must never block base hardware |
| D6 | Each slot carries an agent-computed stable `slotKey`; the API syncs rows by it | `locator` alone collides across memory arrays (multi-socket servers) |

## Wire contract (agent → `PUT /api/v1/agents/:agentId/hardware`)

New optional top-level key on the existing body:

```jsonc
"memory": {
  "slotsTotal": 4,              // int 0..256 | null — system-memory arrays only; null = not reported
  "maxCapacityMb": 131072,      // int | null
  "soldered": false,            // true = on-package memory with no slot inventory (Apple Silicon)
  "modules": [                  // REQUIRED when memory is present; max 256; one entry per slot, populated or not
    {
      "slotKey": "smbios:0x1100", // required 1..160, stable per slot (SMBIOS type 17 handle; macOS "macos:<_name>")
      "locator": "DIMM_A1",       // required 1..128; agent substitutes "Slot <n>" when firmware gives a placeholder
      "bankLabel": "BANK 0",      // ≤128 | null
      "populated": true,
      "capacityMb": 16384,        // int | null
      "memoryType": "DDR4",       // ≤32 | null
      "formFactor": "DIMM",       // ≤32 | null
      "speedMts": 3200,           // rated, int | null
      "configuredSpeedMts": 2933, // int | null
      "manufacturer": "Samsung",  // ≤128 | null
      "partNumber": "M378A2K43DB1-CTD", // ≤128 | null
      "serialNumber": "12345678"        // ≤128 | null
    }
  ]
}
```

Semantics:

- **`memory` absent** → stored modules and `memory_*` columns untouched (older agents, collection failure, unsupported firmware).
- **`memory` present** → authoritative snapshot: modules synced to exactly this list; absent optional fields are stored as `NULL` (never "keep old value").
- The API validates `memory` **separately** (`safeParse`). An invalid `memory` block (over limit, missing `modules`, bad types) is logged and ignored — the base hardware update still succeeds and stored memory is untouched. It is never truncated.
- The agent **omits `memory`** on any collection error, malformed/truncated SMBIOS table, missing array linkage, or more than 256 slots. It never sends an empty list to mean "unknown".
- Agent normalises strings: trim whitespace/NULs; placeholders (`Unknown`, `Not Specified`, `None`, `To Be Filled By O.E.M.`, `NO DIMM`, `Empty`, all-zero / all-`F` serials, `SerNum*` / `PartNum*` fillers) → null.
- Older APIs strip the unknown key (plain `z.object`), so agent and API can ship in either order.

## Storage

### New table `device_memory_modules` (tenancy shape 5, denormalized `org_id`)

| Column | Type |
|---|---|
| `id` | uuid PK `gen_random_uuid()` |
| `device_id` | uuid NOT NULL → `devices(id)` |
| `org_id` | uuid NOT NULL → `organizations(id)` |
| `slot_key` | varchar(160) NOT NULL |
| `slot_index` | integer NOT NULL — order as reported |
| `locator` | varchar(128) NOT NULL |
| `bank_label` | varchar(128) |
| `populated` | boolean NOT NULL |
| `capacity_mb` | integer |
| `memory_type` | varchar(32) |
| `form_factor` | varchar(32) |
| `speed_mts` | integer |
| `configured_speed_mts` | integer |
| `manufacturer` | varchar(128) |
| `part_number` | varchar(128) |
| `serial_number` | varchar(128) |
| `updated_at` | timestamp NOT NULL default now() |

- Composite FK `(device_id, org_id) → devices(id, org_id)` **`ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE`** (per CLAUDE.md; `device_disks_device_org_fk` is `INITIALLY DEFERRED` — do not copy that detail).
- Index on `device_id`.
- RLS enabled + forced + the four org policies, in the same migration, mirroring `device_disks`.
- Migration file sorts after the newest committed migration (`2026-11-01-110000-device-memory-modules.sql` at time of writing — recheck).

### New columns on `device_hardware`

`memory_slots_total integer`, `memory_max_capacity_mb integer`, `memory_soldered boolean`, `memory_observed_at timestamp` — all nullable. `memory_observed_at` is set only when a valid `memory` block is applied (general `updated_at` advances even when memory collection failed). The Oct-28 material trigger compares the whole row minus its two timestamps, so these columns become material automatically; no trigger change for them.

### Registration checklist (from the quorum trace)

| Where | Enforced by |
|---|---|
| Schema `apps/api/src/db/schema/devices.ts` + new migration (table, index, RLS, FK) | RLS coverage auto-discovers `org_id` |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`) | `cascadeDelete.test.ts` (Test API) |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`) | `moveOrg.coverage.test.ts` (Test API) |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `tenantCascade.integration.test.ts` |
| `REPOINT_TABLES` (`services/orgMergeRegistry.ts`) | `orgMergeRegistry.integration.test.ts`, full `orgMerge.test.ts` |
| `CORE_TENANT_EXPORT_POLICY` — new table (all `included`) **and** the 4 new `device_hardware` columns | `tenant-export-policy.integration.test.ts`, export/erasure roundtrip |
| Partner-export material statement triggers (AFTER INSERT/UPDATE/DELETE with transition tables) installed on the new table, reusing the current INSERT/DELETE functions (latest bodies: `2026-10-14-100200-*`) | **not auto-discovered** — add explicit test cases |
| Current device-child UPDATE trigger function (`2026-10-28-100000-*`): new migration adds `WHEN 'device_memory_modules' THEN ARRAY['updated_at']` keeping change-filter-before-lock | add memory cases to its tests |
| `FIXTURE_TABLE_TEMPLATES` (`apps/api/scripts/migrationReplayTenantFixture.ts`) + its test | migration replay rejects missing templates |
| Ownership constraint list in `partnerApiReconstructionWatermark.integration.test.ts` (new FK name; forged-owner, watermark, owner-move cases) | fixed list |
| Expected-table assertion in `apps/api/src/db/migrationPartnerExportLocks.test.ts` | fixed list |
| Partner inventory reconstruction `routes/partnerApi/inventory.ts` (projection, serializer, ordering, counts) | runtime — add tests |

Not needed: RLS allowlists (auto-discovered), DB device-move discovery function (auto), removed-device purge (reaches the device-deletion registry), ticket/site rewrite lists, append-only exemptions.

### Ingest

`routes/agents/inventory.ts` `PUT /:id/hardware`: pull `memory` out of the body before the `device_hardware` upsert (the handler spreads `...data`). If it validates, in the **same short transaction** as the hardware upsert: set the four `memory_*` columns and call `syncDeviceMemoryModules(tx, device, modules, now)` in `services/inventoryChildSync.ts`, built on `planChildRowSync` with `key = exact = slotKey`. Preserve row ids; `updated_at` is volatile so an unchanged report takes **zero** org advisory locks (#6698). Integration tests: unchanged report takes no org lock; add/remove/replace advance the partner watermark; rollback; overlapping reports.

## Read + UI + AI

- `GET /devices/:id/hardware` returns `memoryModules` ordered by `slot_index`; `hardware` carries the `memory_*` columns. Keep the route's org/site authorization.
- Update shared `DeviceHardware` type (`packages/shared/src/types/index.ts`), OpenAPI (`apps/api/src/openapi.ts`), and the web response types.
- `DeviceHardwareInventory.tsx`: memory card shows total + "N of M slots used" and the speed (a single value when uniform, a range when mixed; configured vs rated labelled) or "On-package memory"; a horizontally scrollable "Memory modules" table (Slot, Capacity, Type, Speed, Manufacturer, Part number, Serial) with empty slots as "Empty". No module rows and no `memory_observed_at` → a "Not reported yet — needs agent update" hint instead of a misleading empty state.
- All 8 locale catalogs (`en`, `pt-BR`, `es-419`, `fr-FR`, `fr-CA`, `de-DE`, `it-IT`, `tr-TR` `devices.json`) — parity and duplicate-budget tests apply.
- AI tool `get_device_details`: add `memoryModules` (bounded array + full count) and a populated/free summary computed before truncation; update its description and tests. MCP coverage already maps the tool.
- Docs: device inventory page (`apps/docs/.../features/devices.mdx`) — fields, cadence, needs agent release.

## Agent

- `agent/internal/collectors/smbios/` — pure, build-tag-free parser. Every read length-gated; structure and string-set bounds validated (malformed → error, never partial). Type 17 resolved to its type 16 array by handle; only arrays with `Use == 0x03` (system memory) count; each array summed once; missing linkage → error (not "zero slots").
  - Type 16 max capacity: KiB, or Extended Maximum Capacity (bytes) when `0x80000000`.
  - Type 17 size: `0` empty; `0xFFFF` unknown; bit 15 set = KiB granularity else MiB; `0x7FFF` → Extended Size (MiB, bit 31 reserved).
  - Length thresholds: `0x17` speed, `0x1C` extended size (at offset 0x1C, needs length ≥ 0x20), `0x22` configured speed, `0x58/0x5C` extended speed / extended configured speed. Speed `0` unknown; `0xFFFF` → the extended field. Report the value as MT/s without doubling (pre-3.1 firmware already reported transfer rates).
  - Memory type and form factor enums per DMTF DSP0134 §7.18.
  - Table-driven tests from real dumps (physical DDR4 desktop, SODIMM laptop, server with empty slots and multiple arrays, VM) plus synthetic malformed/truncated tables.
- `collectors/memory.go` — DTOs + normalisation; `memory_windows.go` (`GetSystemFirmwareTable('RSMB', 0, …)`, two-call sizing, validate returned size and the `RawSMBIOSData` header `Length`, keep the version bytes, strip the 8-byte header; syscall pattern from `battery_windows.go`), `memory_linux.go` (`/sys/firmware/dmi/tables/DMI`, version from `smbios_entry_point`), `memory_darwin.go` (`SPMemoryDataType -json` via the bounded command helper in `command_limits.go`; Intel slots incl. `empty`; Apple Silicon → `soldered: true` with the single on-package entry).
- `heartbeat.go` `sendHardwareInventory`: collect memory independently; attach via a wire wrapper with `Memory *MemoryInfo \`json:"memory,omitempty"\``; memory failure logs and still sends base hardware.

## Delivery

| PR | Contents |
|---|---|
| A — API + web | migration, schema, all registrations above, ingest + sync, read route, partner reconstruction, UI, i18n, AI tool, docs, tests incl. contract suites |
| B — agent | SMBIOS parser + readers, macOS path, wire field, tests; physical-hardware lab proof (a VM only yields virtual SMBIOS) |

A lands first; B needs an agent release before anyone sees data.

## Out of scope (follow-ups)

DIMM added/removed change events; device-list filter and fleet report on free slots / memory type; ECC error counters (hardware health).
