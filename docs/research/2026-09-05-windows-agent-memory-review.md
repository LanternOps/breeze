# Windows agent memory review

Reviewed commit `e88f121351`, September 5, 2026. Static source review of the main agent, Windows collectors, logging, command transport, helpers, and remote desktop. No affected Windows endpoint or heap profile was available. The initial review made no runtime changes; the subsequently requested implementation is recorded below.

The reported 200–300 MB deserves a baseline investigation, but this review does not establish a leak or attribute that footprint to a specific subsystem. Prioritize bounded resource use and small lifecycle cleanups. Avoid a broad optimization project or a memory target based solely on a competitor comparison.

## Recommended opportunities

### 1. Release references to shipped log entries — low risk, unmeasured savings

`agent/internal/logging/shipper.go:271–305` allocates a reusable 500-entry batch. Each flush calls `shipBatch(batch)` and then `batch = batch[:0]`. Resetting length preserves the backing array and its references to message strings and field maps. Following a large batch, subsequent small batches leave older entries in the unused tail until overwritten.

Proposed change: `clear(batch)` after the synchronous `shipBatch` returns, before reslicing, at each reset site. Re-buffered entries are struct copies, so clearing the batch slots should not erase their map contents. Preserve that ownership distinction: clear slots, not the maps themselves.

This is bounded retention, not an ever-growing leak. Typical savings may be small; no credible MB estimate is available without inspecting actual entries. Validate normal shipping, auth-dead re-buffering, retry/failure handling, and shutdown under `-race`. This is the first cleanup I would consider.

### 2. Enforce collector output limits while capturing — narrow hardening

`agent/internal/collectors/command_limits.go:38–76` uses `cmd.Output()` / `cmd.CombinedOutput()` and checks the 4 MiB limit only after the command completes. Oversized output can consume much more than the advertised limit before rejection. Windows structured collectors use this path through `runWindowsJSON` in `change_tracker_windows.go:166`.

Proposed change: use bounded capture while continuing to drain output, preserving the existing over-limit error, parent cancellation, exit errors, and process cleanup. `runCollectorBoundedOutput` in the same file provides a starting pattern, but is not a drop-in replacement for the context-aware helpers and needs lifecycle review.

This protects against exceptional peaks; it is not evidence that ordinary inventory accounts for 200–300 MB. Existing bounded-runner tests require a POSIX shell and skip Windows. Add Windows coverage for excessive stdout/stderr, cancellation, nonzero exits, and inherited pipes before shipping a change.

### 3. Avoid full process objects just to count processes — small benefit

`agent/internal/collectors/metrics.go:237` calls `process.Processes()` and uses only its length. The installed gopsutil Windows implementation enumerates PIDs and constructs process objects, including existence/creation-time queries.

`process.Pids()` could avoid those allocations and OS calls. However, it counts enumerated PIDs rather than only successfully constructed process objects; disappearing or inaccessible processes can change the count slightly. Treat this as a small allocation/CPU cleanup, not a likely explanation for the complaint. Validate count semantics and allocation differences on Windows before adopting it.

### 4. Reduce overlapping collectors only if measured peaks justify it

Startup dispatches inventory, hardware, and patch work concurrently (`heartbeat/heartbeat.go:1544`). Inventory itself fans out (`:1884`), and Windows event collection runs up to four PowerShell processes concurrently (`collectors/eventlogs_windows.go:44`). Reliability owns another event collector, although its reporting cadence is daily.

Staggering expensive collection could reduce peak process-tree memory. It also changes inventory completion times, startup behavior, and shutdown scheduling. Measure service and child processes separately first: PowerShell memory is not the main agent PID's memory. Avoid replacing PowerShell with native APIs or sharing mutable query caches without evidence that the additional complexity is warranted.

### 5. Inspect command backlog bytes before changing queues

`agent/internal/websocket/client.go:184` allows 256 queued results. `SendResult` retains both the structured result and its serialized frame (`:742–788`). Queue slots are not preallocated multi-MB payloads, so capacity alone does not explain idle memory. Large results behind a slow connection can nevertheless retain substantial memory.

Measure queued bytes and delivery latency during reconnects and large command results. A byte budget or reduced duplicate representation may help if this appears in profiles, but must preserve result delivery and existing outbox failure handling. Do not simply shrink queues or discard results. The script executor already caps stdout and stderr at 1 MiB each (`executor/executor.go:30,185`).

### 6. Helper and codec changes — measure first, defer by default

Workstations default to always-on helpers; RDS hosts default to on-demand (`sessionbroker/lifecycle_mode.go:32`). Count helpers and user sessions when reporting aggregate memory. An on-demand workstation pilot is possible, but alters session availability/startup behavior and is not a free optimization.

Each desktop session manager starts OpenH264 preload (`remote/desktop/session.go:199`), including managers constructed by the main heartbeat and helpers. Encoder allocation itself is lazy. Deferring preload in a process that never captures might reduce mapped/native memory, but first prove that process never serves a fallback capture path. Preload exists to avoid first-session download timeouts; preserve that behavior in capture helpers.

## Remote desktop: preserve current safeguards

Active capture has an inherently different footprint from idle monitoring. One uncompressed 3840×2160 four-byte pixel buffer is approximately 31.6 MiB. The Windows GDI path has a reusable capture buffer and a separate RGBA output; GPU paths have their own textures and conversion surfaces. These calculations are buffer sizes, not measured private working set, and alternative capture paths should not be added together as if all were active.

The shipping Windows build disables CGO (`.github/workflows/release.yml:131`), so the legacy `C.GoBytes` capture path is not a useful target. Current code limits desktop sessions per process, retains only the latest cached frame, caps pooled encoded buffers, streams file transfers, and releases capture/encoder resources on teardown (`remote/desktop/session.go:425–479`). No specific remote teardown leak was confirmed. Avoid changing GPU fallback, buffer ownership, or teardown to save speculative MB.

## Measurement plan using existing support

1. Select a few representative Windows machines, including an affected device. Record exact agent version, uptime, memory column used, RAM, active sessions, and enabled workloads. Compare equivalent features and process scope before making a Ninja comparison.
2. Collect per-PID working set and private bytes for the main service, watchdog, user/system helpers, backup helper, and collector children. Observe startup, settled idle, a 15-minute inventory cycle, normal daily scans, and a desktop session followed by teardown. A 24–48 hour baseline distinguishes recurring peaks from sustained growth. Sum private bytes for a process-tree commit view; summed working sets can double-count shared pages. Windows working set and private committed memory are different measurements: [Microsoft working set documentation](https://learn.microsoft.com/en-us/windows/win32/memory/working-set), [memory counter definitions](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex).
3. Inspect the existing heartbeat `agentRuntime` fields: heap allocation, heap in use, released bytes, runtime system bytes, GC count, goroutines, and commands in flight. Defined in `collectors/runtime_stats.go`; persisted with metrics in `apps/api/src/routes/agents/heartbeat.ts:1053`. Verify affected versions actually send these fields. These describe the main Go process, not all helper/native/child memory.
4. Capture an occasional `capture_pprof` command with `{"profile":"all"}` through the existing authorized command workflow. The API also exposes `capture_agent_pprof` (`apps/api/src/services/aiToolsAgentLogs.ts:239`). Save/decode the returned `heapProfileBase64` and inspect with `go tool pprof -top -inuse_space heap.pprof`; compare equivalent idle captures with `go tool pprof -top -inuse_space -base baseline.pprof later.pprof`.
5. Record Windows counters before capturing: heap capture explicitly invokes GC and changes the observed state. The embedded runtime snapshot is taken before that GC (`heartbeat/handlers_diag.go:124–139`). Captures are throttled to one per 30 seconds; use occasional diagnostic samples, not continuous capture. A main-service heap profile cannot explain a helper's native allocations.
6. Interpret trends: growing live heap at equivalent idle points warrants allocation investigation; a small Go heap with high process memory points toward native allocations/mappings or other runtime memory; stable idle with workload-linked peaks points toward concurrent work and temporary buffers. Validate these hypotheses against profiles, process counters, and activity timestamps.

Do not introduce an arbitrary `GOMEMLIMIT`, lower `GOGC`, periodic forced collection, or additional working-set trimming as the first response. Go's memory limit is soft, excludes external/native memory, and can increase GC CPU pressure. `Sys - HeapReleased` is a runtime-managed memory measure, not Windows RSS. See the [Go GC guide](https://go.dev/doc/gc-guide). Existing desktop teardown already calls `debug.FreeOSMemory`; leave it unchanged during baseline measurement.

Recommended sequence: baseline affected machines, then consider the log-reference cleanup and collector output hardening as separate small changes. Require Windows validation and stable command delivery, heartbeat latency, inventory completeness, and remote access before any broader rollout. There is no evidence yet to promise a particular reduction in MB.

## Implementation follow-up

At the user's request, opportunities 1–3 are now implemented in this worktree:

- Clear the log batch slots after synchronous shipping and before reuse, preserving re-buffered entries.
- Bound stdout/combined collector capture to 4 MiB while draining excess output. Preserve partial output on command failure and up to 64 KiB of stderr on `ExitError.Stderr`. Preserve parent cancellation and timeout handling. A 10-second `WaitDelay` now prevents descendants holding inherited output pipes from blocking cleanup indefinitely. When the command itself exited 0 and only a descendant kept the pipe open, the runner logs a warning and returns the captured output as success rather than surfacing `exec.ErrWaitDelay`: every caller treats an error as command failure, and the change tracker in particular clones its previous snapshot on error, so the sentinel would have turned a benign orphaned handle into a permanent detection gap. Cost: a command's worst-case wall time is now its timeout plus 10 seconds, which exceeds the change tracker's 8-second `collectWithTimeout` default.
- Count the PID enumeration snapshot directly. Counts can include processes that would disappear or fail validation before the previous per-process object construction finished, so `ProcessCount` may step up slightly on Windows at upgrade. The saving is larger than "small": gopsutil's Windows `PidExists` re-enumerates the full PID list for most PIDs, so the old path was quadratic per metrics tick.

No collector cadence, helper lifecycle, remote desktop behavior, or GC configuration was changed. Portable subprocess tests cover output boundaries, both streams, exit failures, cancellation, timeout, bounded stderr, and inherited pipes, and the Windows CI job now runs them natively. A shipper test drives the main loop through a full 500-entry flush and asserts shipped entries keep their message and `Fields` map. Actual memory savings still require endpoint validation.
