# Process-Level Resource Drill-Down — Design

**Date:** 2026-06-07
**Status:** Approved (brainstorm) — ready for implementation plan
**Author:** Todd Hebebrand (with Claude)

## Problem / Feature Request

On a device's Performance screen you can see aggregate resource usage (CPU %, RAM %,
disk, network) over time, but you cannot see **which processes** are responsible for
that usage. When RAM is at 70% or CPU spikes, the operator wants to drill down and see
the top processes consuming that resource — including the ability to scrub **back in
time** to a past spike and see what caused it. This is a familiar and heavily-used
capability for operators coming from N-Central.

## Goals

- From the device Performance screen, click a point on the CPU/RAM chart and see the
  **top processes at that moment**, sortable by resource.
- Support **historical** scrubbing — not just "right now" — so past spikes can be
  investigated after the fact.
- Cover **CPU, RAM, disk I/O, and network** per process (phased by collection difficulty).
- Stay affordable at **10,000+ agent** scale on DigitalOcean-managed PostgreSQL
  (no TimescaleDB in production).

## Non-Goals (this iteration)

- Per-process **trend lines** over time (e.g. "chrome's memory across the whole day").
  The point-in-time snapshot model does not serve this well; it would require the
  normalized storage approach (Approach B, rejected below).
- Spike-triggered extra capture (listed as a future option).
- Changing the existing aggregate `deviceMetrics` pipeline.

## Key Decisions (from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Time window | **Historical** drill-down (scrub to past spikes), not live-only | Core operator need: investigate spikes after the fact |
| Resources | CPU, RAM, **disk I/O, network** | Full parity with N-Central; phased by difficulty |
| UI entry point | **Click the chart/gauge** on the Performance tab | Keeps drill-down contextual to the resource clicked |
| Storage | **Approach A** — snapshot table, decoupled sampler cadence | ~1 row/device/sample; matches point-in-time UI; cheap at scale |

## Current State (what already exists)

- **Agent** (`agent/`, *not* `apps/agent/`) already enumerates processes on demand via
  WebSocket commands `list_processes` / `get_process` / `kill_process` using gopsutil v3
  (`agent/internal/remote/tools/processes.go`, `ListProcesses()`). Returns per-process
  `PID, Name, User, CPUPercent, MemoryMB` (plus detail fields on demand). gopsutil
  `process` sub-package already imported.
- **Metrics collection**: `agent/internal/collectors/metrics.go` (`SystemMetrics`,
  `MetricsCollector.Collect()`) gathers aggregate CPU/RAM/disk/network + an aggregate
  `ProcessCount`, sent on the heartbeat (default 60s) to `POST /agents/:id/heartbeat`.
- **DB**: `deviceMetrics` (`apps/api/src/db/schema/devices.ts`) stores aggregate
  time-series; only `processCount` (count, no breakdown).
- **API**: `GET /devices/:id/metrics` (`apps/api/src/routes/devices/metrics.ts`) serves
  bucketed history; `GET /devices/:id/processes`
  (`apps/api/src/routes/systemTools/processes.ts`) serves the live, on-demand list.
- **Web**: `DeviceDetails.tsx` (tab-based, hash state) → Performance tab renders
  `DevicePerformanceGraphs.tsx` (Recharts line/area charts, fetch-on-mount, no live
  poll). Reusable `ProcessManager.tsx` table (sort/filter/search/kill) and `Dialog.tsx`
  drawer/modal exist.

**The gap:** process data and the performance charts are not connected, and no
per-process data is stored historically.

## Architecture

A new **process-sample pipeline** runs alongside (not inside) the 60s heartbeat:

```
Agent process-sampler ticker (default ~180s)
  → build top-N process snapshot (CPU/RAM in Phase 1; disk, net later)
  → POST /agents/:id/process-sample   (agentAuth bearer; org_id derived server-side)
  → INSERT into device_process_samples (1 row/device/sample, JSONB array of processes)

Web Performance tab → click a point on the CPU/RAM chart
  → GET /devices/:id/process-samples?at=<ts>   (nearest snapshot)
  → drill-down panel: sortable process table + time scrubber synced to chart range
```

The existing `deviceMetrics` (incl. `processCount`) is unchanged; this work is purely
additive.

### Component boundaries

- **Agent process sampler** — owns: building the periodic top-N snapshot and POSTing it.
  Depends on the existing `ListProcesses` collection logic. Testable via the top-N
  selector unit and per-OS collector interfaces (fakes for disk/net).
- **Ingest route** — owns: validating + persisting a snapshot. Depends on `agentAuth`
  and the device record (for `org_id`). No business logic beyond validation/insert.
- **Read route** — owns: nearest-snapshot lookup + sample-existence query. Depends on
  RLS context. Pure read.
- **Drill-down panel (web)** — owns: click→fetch→render, sort-by-clicked-resource, time
  scrubber, Live toggle. Depends on the read route and (for Live) the existing
  `GET /devices/:id/processes`.

## Agent (Go)

- **Reuse** `agent/internal/remote/tools/processes.go` (`ListProcesses`) for per-process
  collection — do not write a second enumerator.
- **Top-N selector**: union of top-N by CPU and top-N by RAM, dedupe by PID, cap at
  ~10–12 entries. Each entry: `{name, pid, cpu, ramMb, diskBps?, netBps?}`. Disk/net
  fields are nullable and omitted on OSes that cannot supply them.
- **Sampler ticker**: new config `ProcessSampleIntervalSeconds`, default **180s**,
  min 60, max 3600 — a dedicated goroutine decoupled from the heartbeat. Trade-off:
  shorter interval catches briefer spikes but costs more storage.
- **Send path**: `POST /agents/:id/process-sample` with `{timestamp, processes: [...]}`,
  using the same bearer auth as the heartbeat.

### Per-resource phasing (collection difficulty)

1. **CPU% + RAM** — already cheap and cross-platform via gopsutil.
2. **Disk I/O per process** — Linux `/proc/[pid]/io`; Windows IO counters; macOS
   degrades gracefully (field omitted).
3. **Network per process** — Linux socket→PID mapping (reuse `connections_linux.go`);
   Windows `GetExtendedTcpTable`; macOS best-effort. Hardest/most privileged; ships last.

Disk/net collectors should sit behind small interfaces so they can be faked in tests
and so an unsupported OS cleanly returns "no data" rather than erroring.

## API / DB

### New table `device_process_samples`

| Column | Type | Notes |
|---|---|---|
| `device_id` | uuid | FK → devices |
| `org_id` | uuid | FK → organizations; **set server-side**, not from agent |
| `timestamp` | timestamptz | sample time |
| `top_processes` | jsonb | array of `{name, pid, cpu, ramMb, diskBps?, netBps?}` |

- **PK** `(device_id, timestamp)`; index `(device_id, timestamp DESC)`.
- **RLS shape #1** (direct `org_id`): `breeze_has_org_access(org_id)`, RLS **enabled +
  forced + policies** created in the **same idempotent migration** that creates the
  table (per CLAUDE.md tenancy rules). Mirrors how `deviceMetrics` is scoped.
- Migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `pg_policies` existence checks),
  no inner `BEGIN/COMMIT`, named `2026-MM-DD-<slug>.sql`.
- Add Drizzle definition to `apps/api/src/db/schema/devices.ts`.

### Routes

- **`POST /agents/:id/process-sample`** (in `apps/api/src/routes/agents/`): Zod-validated
  payload, `agentAuth` bearer. **`org_id` is derived server-side from the authenticated
  device record — the agent payload is never trusted for tenancy.** Inserts one row.
- **`GET /devices/:id/process-samples?at=<ts>`**: returns the snapshot nearest to `<ts>`.
  Also supports `?from&to` returning lightweight `(timestamp)` markers so the scrubber
  knows which samples exist in a range. Runs through `withDbAccessContext` (RLS enforced).

### Retention

Hook into the existing metrics cleanup job with a **separate, shorter window**
(default **14 days**), independent of aggregate-metric retention. Per-process snapshots
are heavier and only needed for recent forensic investigation.

## Web UI

- In `DevicePerformanceGraphs.tsx`, make CPU/RAM chart points clickable. On click, fetch
  the nearest process sample and open a drill-down panel (reuse `Dialog.tsx` drawer +
  `ProcessManager.tsx` table styling).
- Panel contents:
  - Sortable process table, **pre-sorted by the resource clicked** (click CPU → CPU desc;
    click RAM → RAM desc).
  - **Time scrubber** synced to the chart's current range; moving it re-fetches the
    nearest snapshot.
  - **"Live" toggle** that switches to the existing on-demand
    `GET /devices/:id/processes` for "right now."
- Disk/net columns appear once their phases ship; show "—" / "not available" where an OS
  or phase has no data.

## Scale Notes

- Approach A keeps row volume at roughly **1 row per device per sample**, the same order
  of magnitude as the existing `deviceMetrics` table — not the ~10× of a per-process
  normalized table (Approach B).
- At 10k agents × 180s cadence ≈ 10k × 480 samples/day ≈ **4.8M rows/day**, each a small
  JSONB blob, pruned at 14 days. Comparable to existing metrics load; viable on
  DO-managed Postgres without TimescaleDB.

## Testing (per `breeze-testing`)

- **API**: route tests for ingest (Zod validation, auth, **server-side org_id
  derivation**) and read (nearest-snapshot, range markers). **RLS contract test** for
  `device_process_samples` (`rls-coverage.integration.test.ts`) — verify cross-tenant
  insert/select is blocked as `breeze_app`.
- **Agent**: table-driven tests for the top-N union/dedupe selector; per-OS disk/net
  collectors behind interfaces, tested with fakes; unsupported-OS returns "no data".
- **Web**: component test for click→fetch→sorted-table, the time scrubber re-fetch, and
  the Live toggle.

## Rejected Alternatives

- **Approach B — normalized per-process rows** `(device_id, timestamp, process_name, pid,
  cpu, ram, disk, net)`: enables per-process trend lines but ~10× storage and higher
  operational risk at 10k agents without TimescaleDB. Rejected; revisit only if
  per-process trends become a hard requirement.
- **Live-only drill-down** (reuse existing on-demand process list, no storage): cheapest,
  but cannot investigate past spikes — the core requirement. Kept as the "Live" toggle.

## Future Options (out of scope)

- **Spike-triggered capture**: in addition to the steady cadence, capture an extra
  snapshot when CPU/RAM crosses a threshold, so short spikes between samples are always
  covered.
- **Per-process trend lines** (would require Approach B storage).
