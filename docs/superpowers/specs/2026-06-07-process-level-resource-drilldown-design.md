# Process-Level Resource Drill-Down — Design

**Date:** 2026-06-07 (revised 2026-06-13)
**Status:** Approved (brainstorm) — ready for implementation plan
**Author:** Todd Hebebrand (with Claude)

**2026-06-13 revision** (after code-grounded review): corrected the retention plan (no
existing metrics-cleanup job exists — it's net-new), pinned CPU% to the instantaneous
sample path, added server-stamped timestamp + clock-skew handling, added ingest payload
bounds, made the web lazy-load contract explicit, and replaced "Scale Notes" with a full
**Performance & Load Budget** section. Net conclusion: no added page-load cost; storage
(retention) is the only real lever.

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
- **CPU% must be instantaneous, not lifetime-average (hard invariant).** gopsutil's
  `process.CPUPercent()` returns total-CPU-time ÷ uptime — a lifetime average — which
  would make "top processes at that moment" silently wrong. The reused path already
  avoids this: `ListProcesses` calls `sampleProcessCPUPercents` with a shared 250ms
  sample window (`processes.go:43,211` — "what makes the list show *current* CPU rather
  than a lifetime average"). The sampler **must** go through that path; a unit test
  should pin this so a later refactor can't reintroduce raw `CPUPercent()`. Cost: one
  ~250ms sleep window per sample per agent (negligible at the 180s cadence).
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
| `timestamp` | timestamptz | **server receive time** — the key for chart correlation |
| `agent_timestamp` | timestamptz | agent-reported sample time (clock-skew forensics) |
| `top_processes` | jsonb | array of `{name, pid, cpu, ramMb, diskBps?, netBps?}` |

- **Clock skew:** the Performance charts plot **server-stamped** `deviceMetrics`
  timestamps, so the `?at=` nearest-snapshot lookup must key on the **server receive
  time** (`timestamp`), not the agent-supplied value — otherwise a skewed agent clock
  makes "click the 14:32 spike" fetch a snapshot from a different minute. Keep the
  agent's reported time in `agent_timestamp` for forensics only.
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
  device record — the agent payload is never trusted for tenancy.** Stamps `timestamp`
  server-side at receipt; stores the agent-reported time in `agent_timestamp`. Inserts
  one row. **Bound the payload in Zod** — cap the `processes` array (e.g. ≤ 16) and each
  string field's length, so a buggy or compromised agent can't insert an oversized JSONB
  blob. Mirror the single-insert-per-request shape of the existing heartbeat metrics
  insert (`apps/api/src/routes/agents/heartbeat.ts`); no cross-request batching needed
  (the new write rate is ~⅓ of the existing heartbeat-metrics rate — see Performance).
- **`GET /devices/:id/process-samples?at=<ts>`**: returns the snapshot nearest to `<ts>`.
  Also supports `?from&to` returning lightweight `(timestamp)` markers so the scrubber
  knows which samples exist in a range. Runs through `withDbAccessContext` (RLS enforced).

### Retention

> **Correction (verified 2026-06-13):** there is **no** existing `deviceMetrics`
> cleanup job to "hook into" — `apps/api/src/jobs/` has `auditRetention.ts`,
> `reliabilityRetention.ts`, `eventLogRetention.ts`, `backupRetention.ts`, etc., but
> nothing for device metrics. This retention is **net-new work**, not a hook.

Add a **new** retention job for `device_process_samples`, modeled on
`reliabilityRetention.ts` (BullMQ queue + worker, env-driven `*_RETENTION_DAYS`).
Default window **7 days** (configurable, max 14) — shorter than aggregate metrics
because per-process snapshots are heavier and only needed for recent forensic
investigation. Deletes **must be batched** (time-range or `ctid`-chunked `DELETE`
loops, per CLAUDE.md large-table guidance), never a single unbounded
`DELETE ... WHERE timestamp < ...` — large sweeps are rough on DO-managed Postgres and
contend for the tight connection budget (US `max_connections=25`).

## Web UI

- **Lazy by construction — zero added page-load cost (hard requirement).** The
  Performance tab today fires exactly one fetch on mount (`DevicePerformanceGraphs.tsx`
  → `GET /devices/:id/metrics`). The drill-down must add **nothing** to initial render or
  tab-switch: the nearest-snapshot fetch, the `?from&to` scrubber-markers fetch, and the
  Live poll all fire **only after the user clicks a chart point** and the panel opens,
  and the Live poll stops when the panel closes. A web test should assert no
  process-sample request fires on mount.
- In `DevicePerformanceGraphs.tsx`, make CPU/RAM chart points clickable. On click, fetch
  the nearest process sample and open a drill-down panel (reuse `Dialog.tsx` drawer +
  `ProcessManager.tsx` table styling).
- **Show the actual sample time.** Samples (180s) are sparser than chart points (~60s),
  so the nearest snapshot can be ±90s from the clicked point. Display the real sample
  timestamp in the panel header ("nearest sample: 14:31:40") so operators don't read it
  as exact.
- Panel contents:
  - Sortable process table, **pre-sorted by the resource clicked** (click CPU → CPU desc;
    click RAM → RAM desc).
  - **Time scrubber** synced to the chart's current range; moving it re-fetches the
    nearest snapshot.
  - **"Live" toggle** that switches to the existing on-demand
    `GET /devices/:id/processes` for "right now."
- Disk/net columns appear once their phases ship; show "—" / "not available" where an OS
  or phase has no data.

## Performance & Load Budget

Where load lands, verified against the current code (2026-06-13). Summary: **the
overview/Performance page gains zero initial-load cost**, agent and DB-write overhead are
modest (below today's heartbeat-metrics load), and **DB storage is the only real cost
lever** — fully controlled by retention.

| Surface | Impact | Risk |
|---|---|---|
| Web initial page load | **0 new requests** — drill-down fetches are click-lazy (see Web UI) | none |
| Agent CPU | one ~250ms CPU-sample window per sample, every 180s, reusing the existing worker-pooled enumerator | low |
| Agent network | ~1 small POST / device / 180s | low |
| DB writes | ~**56 inserts/sec** at 10k agents — **~⅓** of today's heartbeat-metrics write rate | low (watch conn pool) |
| DB read (drill-down) | single index-backed `ORDER BY timestamp DESC LIMIT 1`, on click only | none |
| DB storage | ~67M rows / 14d; JSONB → main cost, bounded by retention | **medium — manage** |

**Web page load.** The Performance tab fires one fetch on mount today
(`DevicePerformanceGraphs.tsx` → `GET /devices/:id/metrics`). The drill-down adds nothing
to that path: nearest-snapshot, scrubber-markers, and Live-poll requests all fire only
after a click opens the panel (enforced by the lazy-load requirement + a test). No new
JS runs on the hot render path; the click handler and panel are inert until used.

**Agent CPU / network.** A dedicated 180s goroutine (separate from the 60s heartbeat,
matching the existing boot-check/user-helper ticker pattern in `heartbeat.go`). Each tick
reuses `ListProcesses`' worker-pooled enumeration + one shared 250ms CPU-sample sleep —
the same cost the live Process Manager already pays on demand, now once per 180s. The
known-expensive part (Windows per-process SID lookups) is already mitigated by the
8-worker pool. One small POST per tick. Negligible at this cadence.

**DB writes.** One insert per request, mirroring the heartbeat-metrics insert — no
batching. At 10k agents / 180s that's ~56 rows/sec, roughly **⅓** of the existing
~167 rows/sec heartbeat-metrics rate that production already sustains. The one thing to
watch is the tight US connection budget (`max_connections=25`): these inserts are short
and index-cheap, but if pool pressure shows up, server-side micro-batching is the lever
(deferred — not needed at launch).

**DB storage (the lever).** Row volume is ~1 row/device/sample — same order as
`deviceMetrics`, not the ~10× of normalized Approach B. At 10k × 480 samples/day ≈
**4.8M rows/day**, ≈ **67M rows at 14d**. Each row is heavier than a metrics row (a JSONB
array of ~10–12 compact `{name,pid,cpu,ramMb}` entries ≈ 1–1.5 KB; Postgres TOAST-
compresses larger blobs), so figure **tens of GB**, not the single-digit GB of aggregate
metrics. This is bounded entirely by retention: the **7-day default** (vs 14) roughly
halves it, and the top-N cap keeps each row small. This is why retention is a hard
requirement of this work, not a follow-up. Viable on DO-managed Postgres without
TimescaleDB.

## Testing (per `breeze-testing`)

- **API**: route tests for ingest (Zod validation incl. **payload bounds** — array cap +
  string lengths, auth, **server-side org_id derivation**, **server-stamped timestamp**)
  and read (**nearest-snapshot keyed on server time**, range markers). **RLS contract
  test** for `device_process_samples` (`rls-coverage.integration.test.ts`) — verify
  cross-tenant insert/select is blocked as `breeze_app`. Add the table to RLS shape #1
  in the same PR.
- **Agent**: table-driven tests for the top-N union/dedupe selector; a test pinning that
  CPU% comes from the **instantaneous** sample path (not raw `CPUPercent()`); per-OS
  disk/net collectors behind interfaces, tested with fakes; unsupported-OS returns
  "no data".
- **Web**: component test for click→fetch→sorted-table, the time scrubber re-fetch, the
  Live toggle, and a test asserting **no process-sample request fires on mount / tab
  switch** (the lazy-load contract).

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
