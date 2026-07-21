# Design: Device Hardware & OS Change Detection (Phase 2 of #2502)

**Status:** Approved (design), pending spec review
**Issue:** #2502 (Phase 2)
**Branch:** `ToddHebebrand/device-change-history-phase2` (stacked on the Phase 1 branch
`ToddHebebrand/device-change-history` / PR #2505)
**Depends on:** Phase 1 (the `device_change_log` subsystem + Change History UI tab).

## Problem

The `device_change_log` subsystem (agent → API → DB → AI tool → UI tab) tracks software,
service, startup, network, scheduled-task, and user-account changes. It does **not** track
hardware or OS-version changes: RAM/CPU/disk/BIOS/serial/`os_version` are stored only as
*current state* on the `devices` row and overwritten on each refresh — no delta is written.
The two headline examples in the community request ("Memory upgraded from 4 GB to 8 GB",
"The operating system was updated") therefore produce no change-log events. Phase 2 closes
that gap.

## Scope (approved)

Detect and log, as `device_change_log` events:

| Component | `change_type` | `subject` | typical `change_action` |
|---|---|---|---|
| RAM total | `hardware` | `Memory` | `modified` |
| CPU model / physical core count | `hardware` | `Processor` | `modified` |
| Fixed-disk total capacity | `hardware` | `Storage` | `modified` |
| Fixed physical disk added / removed | `hardware` | `Storage` | `added` / `removed` |
| BIOS / firmware version | `hardware` | `BIOS` | `updated` |
| Baseboard / system serial | `hardware` | `System Serial` | `modified` |
| OS version string | `os_version` | `Operating System` | `updated` |

**Two new `change_type` enum values only:** `hardware` (groups all hardware components,
disambiguated by `subject`) and `os_version`. `change_action` reuses the existing
`added`/`removed`/`modified`/`updated` enum — no new action values.

Confirmed design points (user sign-off):
- Disk tracks **total fixed-disk capacity AND per-physical-disk add/remove**.
- Serial / motherboard **is** tracked (rare but meaningful — board swap / re-motherboard).

### Out of scope
- No new subsystems; no new UI tab (Phase 1's tab renders these automatically).
- No server-side inventory diffing (see Architecture — agent-side only).
- Removable / USB / network-mounted disks (noise).
- GPU, peripherals, monitors (peripherals have their own tab already).

## Architecture

Phase 2 extends the existing change pipeline end-to-end. No new components.

### 1. Agent (Go) — hardware/OS diff

**Location:** `agent/internal/collectors/change_tracker.go` (+ the per-OS files
`change_tracker_windows.go`, `_linux.go`, `_darwin.go`, `_other.go` as needed for
platform-specific inventory reads). The tracker already persists a JSON snapshot
(`change_snapshot.json`), diffs current vs previous each cycle, and emits
`ChangeRecord{Timestamp, ChangeType, ChangeAction, Subject, BeforeValue, AfterValue, Details}`.

**Add:** `diffHardware(prev, cur)` and `diffOS(prev, cur)` alongside the existing
`diffSoftware`/`diffNetworkAdapters`/etc., wired into the same collection cycle and the same
snapshot file. Extend the snapshot struct with a `hardware` section (ram total, cpu model +
physical cores, fixed disks [{serial/id, capacityGb}], bios version, system/baseboard serial)
and an `osVersion` string.

**Source of current values:** reuse the system-info the agent **already collects** for
heartbeat inventory (the same fields that populate `devices.ram_total_mb`, `cpu_model`,
`cpu_cores`, `os_version`, `bios_version`, and the disk inventory). One source of truth — the
change tracker consumes that struct; it does not issue its own hardware queries.

**Record shape:** `beforeValue` / `afterValue` are small JSON objects carrying the old/new
scalar (e.g. `{"totalGb": 4}` → `{"totalGb": 8}`, `{"version": "…"}`), which the Phase 1 tab's
`formatValue` already renders as `old → new`. `subject` names the component per the table.

**Noise control:**
1. **First-run seeding:** if the snapshot has no `hardware`/`osVersion` section yet (first run
   after upgrade), populate it and emit **no** events — never "changed from nothing".
2. **Fixed/internal only:** disk diffing considers fixed/internal disks; removable, USB, and
   network drives are excluded so docking/undocking and thumb drives don't churn `Storage`.
3. **Stable-identity disks:** disk add/remove keys off a stable disk identifier (serial or
   stable device id), not mount order, to avoid false add/remove churn.
4. **OS version:** track the meaningful OS version string the API already stores
   (`devices.os_version`), so cosmetic build-metadata jitter doesn't over-fire.

**Architectural choice (recommended, approved):** diff **agent-side** in the change tracker,
consistent with every other change type — NOT server-side by comparing incoming heartbeat
inventory against the `devices` row. Server-side diffing would place work on the hot heartbeat
path (the #1105 DB-context/conn-hold class of risk) and does not fit the batched ingest model
(`PUT /api/v1/agents/:id/changes`). The agent already owns snapshot/diff for all other types.

### 2. DB migration

New migration `apps/api/migrations/2026-07-14-*-change-log-hardware-os-enum.sql`:

```sql
ALTER TYPE change_type ADD VALUE IF NOT EXISTS 'hardware';
ALTER TYPE change_type ADD VALUE IF NOT EXISTS 'os_version';
```

- Additive and idempotent (`IF NOT EXISTS`). Same table, same RLS policies — **no** policy
  change (org isolation already covers all rows).
- **Transaction caveat to verify:** `autoMigrate` wraps each migration file in `client.begin`.
  Postgres allows `ALTER TYPE … ADD VALUE` inside a transaction on PG12+, provided the new
  value is not *used* in the same transaction. This migration only ADDs the values (does not
  insert rows using them), so it is safe. Verify the target managed-PG version is ≥12 (it is —
  DO-managed recent Postgres) and that a re-run is a clean no-op. No inner `BEGIN;`/`COMMIT;`.
- Per CLAUDE.md: date-prefixed filename; if it must order after any same-day migration, use the
  `-a-`/`-b-` infix. This migration has no same-day dependency at time of writing.

### 3. API / ingest / AI tool — three lockstep enum lists

Add `'hardware'` and `'os_version'` to each of (kept in sync — see repo memory on the triple
list):
- `apps/api/src/db/schema/changes.ts` — the `changeTypeEnum` pgEnum.
- `apps/api/src/routes/changes.ts` — the `changeTypeValues` array used by the read query schema.
- `apps/api/src/routes/agents/schemas.ts` — the `changeTypeValues` used by the ingest schema
  (`submitChangesSchema`) so the agent can submit the new types.

Add the two values to the `query_change_log` AI-tool `changeType` enum in
`apps/api/src/services/aiToolsAudit.ts`, and update its description to mention hardware/OS.

### 4. UI (web)

Phase 1's tab renders unknown types generically, but its filter dropdown and badges use
literal-key `t()` lookups (`type_software`, …). Add:
- `deviceChangeHistoryTab.type_hardware` and `deviceChangeHistoryTab.type_os_version` labels to
  **all 5 locales** (`en`, `es-419`, `fr-FR`, `de-DE`, `pt-BR`) `devices.json`, exact key
  parity, duplicate-baseline-safe. The two new keys become options in the change-type filter.

No other UI change: the timeline, before→after rendering, pagination, and states are unchanged.

### 5. Tests

- **Go** (`change_tracker_test.go`, table-driven per the repo Go convention):
  - RAM 4096→8192 MB → exactly one `hardware`/`Memory`/`modified` record with before/after.
  - OS version bump → one `os_version`/`Operating System`/`updated` record.
  - CPU model change; BIOS version change; serial change → one `hardware` record each.
  - Fixed disk added / removed → `added` / `removed` records; **removable disk ignored**.
  - **First run** (empty snapshot) → **zero** events; snapshot is seeded.
  - No-change cycle → zero events.
- **API:** a real-Postgres test that the ingest route accepts `changeType: 'hardware'` and
  `'os_version'` (mocked-pg can't validate a pg enum — must hit real DB), and that the
  migration applies + re-applies idempotently.
- **Web:** the change-type filter renders `Hardware` and `Operating System` options with the
  new labels; `localeParity` + `keyUsage` guards pass.

## Delivery split (per user prefs)

- **Codex (gpt-5.5, high)** candidate: the Go agent diff logic (`diffHardware`/`diffOS`,
  snapshot struct, per-OS inventory reads) and its table-driven Go tests — well-scoped,
  single-subsystem, backend.
- **Claude (this session):** the enum migration (architecturally sensitive — hot RLS'd table),
  the three-list + AI-tool enum wiring, the UI/i18n labels, and overall integration/review.
- Executed via subagent-driven development with per-task review + a final whole-branch review,
  matching Phase 1.

## Risks / watch-items

1. **Enum-in-transaction** (see §2) — verify PG≥12 and clean re-run; the migration only ADDs.
2. **Triple enum-list drift** — the three `changeTypeValues`/pgEnum lists must stay in
   lockstep; a missed one either rejects agent submissions (ingest) or hides rows from filters
   (read). One task updates all three + the AI tool together.
3. **Agent inventory field availability across OSes** — serial/BIOS/fixed-disk enumeration
   differs on Windows/Linux/macOS; a field unavailable on a platform must be treated as
   "unknown / do not diff" (never emit a spurious change when the collector returns empty).
4. **Backfill:** none. Existing devices simply start emitting hardware/OS deltas after their
   first post-upgrade cycle seeds the snapshot; historical hardware state is not reconstructed.
