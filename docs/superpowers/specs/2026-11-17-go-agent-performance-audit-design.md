# Go agent performance audit design

This design describes how we measure and reduce the Breeze Go agent's resource use on endpoints, one proven change at a time.

## 🎯 Intent

The agent runs on 10,000+ endpoints, so its idle cost multiplies across the fleet.

- First target: idle footprint (memory, CPU, binary size).
- Second target: latency on remote desktop, command dispatch and file transfer.
- Every change is measured before it ships.

## 📍 Starting point

- `agent/go.mod` started at `go 1.22` on 2026-01-13 and is `go 1.26.11` on main.
- PR #11943 moves it to `go 1.27.4`.
- Release builds (`agent/scripts/build-edition.sh`) pass `-s -w` (strip symbols and debug info).
- Release builds do not use `-trimpath` or PGO (profile-guided optimization, where the compiler optimizes using a real CPU profile).
- No code sets `GOMEMLIMIT`, `GOGC` or `GOMAXPROCS`.
- The `capture_pprof` command (`agent/internal/heartbeat/handlers_diag.go`) returns heap and goroutine profiles from live agents. It has no CPU profile.
- `capture_pprof` allows one capture per 30 seconds. The API accepts only `heap`, `goroutine` and `all`, and waits 30 seconds for the result.
- Every heartbeat carries `agentRuntime`: Go heap, `Sys` bytes, GC count and goroutines. It does not carry process CPU or working set.
- The agent has 6 benchmarks across about 370k lines.
- No `godebug` line in `go.mod` and no `//go:debug` comment exists, so none of the settings Go 1.27 removed are pinned.
- `docs/guides/AGENT_INSTALLATION.md` lists macOS 11 as the minimum. Go 1.25 already requires macOS 12, Go 1.27 requires macOS 13, and the macOS installer app already sets `LSMinimumSystemVersion` to 13.0.

## ✅ Goals

- A ranked audit of missing Go optimizations, ordered by measured gain and break risk.
- One issue and one PR per fix, with benchstat or VM evidence in the commit message.

## 🚫 Non-goals

- Dependency swaps, such as the JSON, WebSocket or gopsutil libraries.
- A benchmark gate in CI.
- Optimizing `breeze-watchdog` and `breeze-backup`. They are measured only.
- The `scripts/security/yara-pack` module.
- A runtime policy pushed from the server.
- Changing `GOMAXPROCS`. Go 1.25+ already sizes it from CPU count, affinity and cgroup quota.

## ⚠️ Anti-goals

- Keeping a change without a statistically significant win.
- Keeping a change that makes another metric significantly worse. One exception: PGO may grow the binary by up to 2%.

Hygiene changes are exempt from the win rule. Only two exist: `-trimpath` (a `build:` commit) and `go fix ./...` (a `refactor:` commit).

## 🔒 Constraints

- The agent ships to endpoints, so every change gets full review.
- Go 1.27 idioms wait until #11943 merges.
- Every baseline is taken on Go 1.27.4. A comparison that spans the 1.26 to 1.27 toolchain change measures the toolchain, not the code.

## 📐 Measurement discipline

### 🧪 Benchmarks

- New benchmarks use `b.Loop()` and live in `<source>_bench_test.go`, in the same order as the functions they measure.
- Run with `-benchmem -count=10` and compare with `benchstat`.
- Run benchmarks one at a time, never in parallel with other benchmarks or builds.
- Commit messages paste only the affected rows, with the `goos`/`goarch`/`cpu` line, and use the `perf(agent):` type.
- A row marked `~` (not significant) is not a win and is not pasted.

### 🖥️ Lab VMs

- Measure one VM at a time, with the other two shut off.
- Revert each VM to the same libvirt snapshot before every run.
- Run at least 5 runs per arm, alternating before and after builds.
- Report the median and spread of each metric.

### 🌐 Fleet

- Before wave 2 ships, record the p50 and p95 of `agentRuntime` `sysBytes`, `heapInuseBytes` and `goroutines` from stored heartbeats.
- Repeat the same query after each wave reaches the fleet.

## 🧭 Approaches

| Approach | Trade-off | Decision |
|---|---|---|
| Sweep by grep counts | Fast, but no evidence and huge PRs | Rejected |
| Profile first, fix in risk tiers | Slower start, every gain proven | Chosen |
| Write benchmarks first | Delays the no-code-change wins | Rejected |

## 🌊 Waves

### 🔧 Wave 0: Go 1.27.4

- Take over #11943 and fix the Lint Agent job.
- Cause: the golangci-lint cache key has no Go version, so CI restores a binary built with Go 1.26.
- Fix: add the Go version to the cache key.
- Update the macOS minimum in `docs/guides/AGENT_INSTALLATION.md` to macOS 13, matching the installer.
- Before handing the PR back, check the Go 1.27 changes:
  1. Run the agent test suite and enroll one lab VM, to catch stricter JSON decoding of real heartbeat and command payloads.
  2. Record the binary size change from the new small-object allocator in the PR body.
- The user merges the PR.

### 📏 Wave 1: Measure

- Add a `cpu` profile type to `capture_pprof`:
  - It records for 30 seconds and shares the existing rate limit.
  - It does not force a GC.
  - It returns an error when another CPU profile is already running.
  - `all` keeps returning heap and goroutine only, so existing callers stay fast.
  - The API accepts `cpu` in `aiToolsAgentLogs.ts`, `aiAgentSdkTools.ts` and `aiToolSchemas.ts`, and waits at least 60 seconds for it.
- Add a `goroutineleak` profile type (Go 1.27), which reports goroutines blocked forever. `all` includes it.
- Collect heap, goroutine and CPU profiles from fleet agents once an agent release includes the `cpu` type.
- Run controlled tests on lab VMs Win10-22H2-01, Win11-26H2-01 and Win2025-01, using their existing specs.
- Drive the VMs with `virsh` and OpenSSH, and enroll them against a local `worktree-stack`.
- Measure four workloads:
  1. 30 minutes idle with a 60-second heartbeat.
  2. One inventory and patch scan.
  3. A 5-minute remote desktop session.
  4. A 500 MB file transfer.
- Record working set, private bytes, CPU seconds, handles, goroutines and binary size.
- Add the ranked audit as an appendix to this document.

### ⚙️ Wave 2: Build and runtime settings

- Add `-trimpath` to release builds.
- Enable PGO:
  - Merge lab and fleet CPU profiles with `go tool pprof -proto` into one `default.pgo` per main package.
  - `go build` picks up `default.pgo` automatically.
  - Refresh the profile when the hot paths change.
- Run a GC experiment with three arms on the lab VMs:
  1. Default settings.
  2. `GOGC=50`.
  3. A soft memory limit at about 1.5 times the observed peak of Go runtime memory (`runtime/metrics` total minus released), not working set.
- Keep only an arm that significantly lowers working set without significantly raising CPU.
- A kept setting gets a built-in default that config or an environment variable can override.
- A memory limit only acts above the peak. There the GC runs harder, using at most about half of the CPU.

### 🆕 Wave 3: Go 1.27 modernization

- Base changes on the Go 1.27 release notes, read at the time.
- Start with `go fix ./...` and the golangci-lint `modernize` linter.

### 🔥 Wave 4: Hot paths

Change only code that profiles show is costly. Candidates:

- Regular expressions compiled inside functions.
- `io.ReadAll` on large bodies and files.
- `json.Marshal` on heartbeat and inventory paths.
- Buffer reuse in remote desktop.

Waves 2 to 4 cover `breeze-agent` and `breeze-desktop-helper`.

## 📋 Tracking

- A parent issue labeled `feature`, with one `wave` sub-issue per wave.
- Registered with `feature-lifecycle`.

## 🛠️ Left to the builder

- Benchmark names.
- Where profiles are stored.
- The exact config key for the memory limit.

## Appendix: ranked audit

Measured 2026-11-17/18 on the wave 1 branch.

### Lab environment

| VM | vCPU | RAM |
|---|---|---|
| Win11-26H2-01 | 4 | 4 GB |
| Win10-22H2-01 | 2 | 2 GB |
| Win2025-01 | 4 | 4 GB |

- Build: Go 1.27.4, `build-edition.sh --edition self-host`, `GOOS=windows GOARCH=amd64 CGO_ENABLED=0` (`-s -w`, no `-trimpath`, no PGO).
- Harness: `agent/scripts/perf/run-lab.sh`, one VM running at a time, enrolled against a local worktree stack.
- Runs per VM: 5 × `idle` (1800 s), 5 × `scan` (600 s: one `refresh_inventory` plus one patch scan), and 1 extra `idle` run for profiles only, so captures do not disturb the measured runs.
- Deviation: no libvirt snapshots exist, so runs were **not snapshot-reverted**. Each run backed up `C:\ProgramData\Breeze`, ran the test agent, and restored it. Hashes matched after all 33 runs.
- Deviation: only `idle` and `scan` were measured. `desktop` (needs a WebRTC viewer) and `transfer` (no API path moves 500 MB to the agent) are not automated, so remote desktop and `breeze-desktop-helper` have no runtime numbers.
- Steady = median of the second half of the run's 10-second samples. CPU = process CPU seconds over the whole run. Spread = min to max of the 5 runs.

### Baselines

**Win11-26H2-01**

| Metric | idle median | idle spread | scan median | scan spread |
|---|---|---|---|---|
| Working set, steady (MB) | 44.2 | 43.7-44.5 | 43.4 | 42.4-43.8 |
| Working set, peak (MB) | 47.6 | 47.3-47.9 | 48.4 | 47.7-49.5 |
| Private bytes, steady (MB) | 63.9 | 63.4-64.7 | 65.0 | 63.8-65.4 |
| Private bytes, peak (MB) | 67.4 | 67.0-68.4 | 68.4 | 66.4-70.3 |
| CPU (s per run) | 1.48 | 1.25-6.25 | 0.94 | 0.83-1.88 |
| Handles, steady | 611 | 546-620 | 560 | 549-611 |
| Goroutines | 54 | 54-54 | 54 | 54-54 |
| Go `sysBytes` (MB) | 25.5 | 21.5-25.8 | 21.8 | 21.5-25.5 |
| Go `heapInuseBytes` (MB) | 5.9 | 5.7-7.0 | 5.6 | 5.5-5.7 |

**Win10-22H2-01**

| Metric | idle median | idle spread | scan median | scan spread |
|---|---|---|---|---|
| Working set, steady (MB) | 34.3 | 27.3-34.8 | 35.2 | 33.5-35.9 |
| Working set, peak (MB) | 36.2 | 33.7-39.4 | 40.3 | 39.1-44.5 |
| Private bytes, steady (MB) | 64.3 | 64.1-65.4 | 64.8 | 63.4-65.2 |
| Private bytes, peak (MB) | 66.6 | 64.9-67.0 | 67.2 | 66.1-69.0 |
| CPU (s per run) | 4.70 | 4.25-6.38 | 3.44 | 3.23-4.27 |
| Handles, steady | 581 | 512-615 | 523 | 516-552 |
| Goroutines | 54 | 54-56 | 54 | 54-54 |
| Go `sysBytes` (MB) | 25.5 | 21.5-25.8 | 21.8 | 21.5-25.5 |
| Go `heapInuseBytes` (MB) | 8.7 | 5.8-8.9 | 5.6 | 5.5-5.8 |

**Win2025-01**

| Metric | idle median | idle spread | scan median | scan spread |
|---|---|---|---|---|
| Working set, steady (MB) | 47.5 | 46.1-48.0 | 48.3 | 46.1-48.5 |
| Working set, peak (MB) | 49.5 | 47.8-49.9 | 48.9 | 48.8-49.0 |
| Private bytes, steady (MB) | 65.9 | 65.7-66.7 | 66.6 | 64.6-67.0 |
| Private bytes, peak (MB) | 67.6 | 67.1-69.5 | 68.1 | 67.7-69.7 |
| CPU (s per run) | 1.44 | 1.08-3.84 | 0.81 | 0.66-1.22 |
| Handles, steady | 622 | 548-669 | 554 | 551-579 |
| Goroutines | 54 | 54-56 | 54 | 54-56 |
| Go `sysBytes` (MB) | 25.8 | 25.5-26.0 | 25.5 | 21.8-26.0 |
| Go `heapInuseBytes` (MB) | 6.0 | 5.8-9.4 | 5.9 | 5.9-7.6 |

- Idle CPU is 0.08% of one core (Win11, Win2025) to 0.26% (Win10, 2 vCPU).
- The Go runtime holds about 25 MB of 64-66 MB private bytes; the live Go heap is 6-9 MB.
- Patch scans: 12 of 15 completed. 3 failed with `wuauserv is StartPending ... An instance of the service is already running` (Win10 runs 4-5, Win2025 run 4).

### Binary sizes

| Binary | Bytes | With `-trimpath` | Change |
|---|---|---|---|
| `breeze-agent.exe` | 35,917,312 | 35,824,128 | -0.26% |
| `breeze-desktop-helper.exe` | 16,327,680 | 16,259,584 | -0.42% |

### Hotspots (idle, 3 VMs merged)

All profiles were captured at idle; scan was not profiled. Every hotspot and every ranked share below is idle-only. Heap sizes are pprof units (MiB).

CPU: 30 × 30 s profiles, 900 s profiled. On Windows the profiler also samples threads parked in system calls: 99.6% of the 87 s of samples sit flat in `runtime.cgocall`/`syscall.syscalln`, against 1.4-4.7 s of real process CPU per 30 minutes. Go code on CPU is under 1%. The cumulative view shows where the agent waits:

| cum% | Function |
|---|---|
| 29.1 | `bytes.(*Buffer).ReadFrom` (reading child process output) |
| 11.0 | `heartbeat.(*Heartbeat).staggerStartup.func1` |
| 10.9 | `security.CollectStatus` via `sendSecurityStatus` |
| 10.7 | `patching.(*WindowsUpdateProvider).searchUpdates` via `sendPatchInventory` |
| 9.3 | `collectors.runCollectorCommand` |
| 7.2 | `security.runCommand` |
| 7.0 | `collectors.(*EventLogCollector).collectWindowsStreams` |
| 4.3 | `collectors.(*BootPerformanceCollector).Collect` |

Heap, allocated over each profile run's lifetime (378 MB total):

| flat% | Function |
|---|---|
| 47.9 | `gopsutil/v3/process.(*Process).ExeWithContext`, via `NameWithContext` from `sendInventory`, `sendProcessSample`, `sendNetworkInventory`, `sendConnectionsInventory` and `mgmtdetect` |
| 10.9 | `svcquery.queryBaseConfig` |
| 8.7 | `runtime/pprof.StartCPUProfile` (the capture itself; 16.7% cum for `runtime/pprof`) |
| 3.7 | `compress/flate.(*fastGen).addBlock` |
| 2.5 | `svc/mgr.(*Mgr).ListServices` |

Heap in use (12.4 MB across 3 profiles): `regexp` compilation holds 29.0%, almost all from package `init` (`patching`, `collectors/workloads`) and `executor.(*SecurityValidator).initPatterns`.

### Fleet baseline (to be run)

Run against production by someone with access. Results pending. Wave 2 (GC arms and the other runtime knobs) cannot be gated until this table is filled; the spec requires it before wave 2 ships.

```sql
SELECT d.os_type,
  count(DISTINCT m.device_id) AS devices, count(*) AS samples,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY (m.custom_metrics->'agentRuntime'->>'sysBytes')::bigint)       AS sys_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (m.custom_metrics->'agentRuntime'->>'sysBytes')::bigint)       AS sys_p95,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY (m.custom_metrics->'agentRuntime'->>'heapInuseBytes')::bigint) AS heap_inuse_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (m.custom_metrics->'agentRuntime'->>'heapInuseBytes')::bigint) AS heap_inuse_p95,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY (m.custom_metrics->'agentRuntime'->>'goroutines')::int)        AS goroutines_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (m.custom_metrics->'agentRuntime'->>'goroutines')::int)        AS goroutines_p95
FROM device_metrics m JOIN devices d ON d.id = m.device_id
WHERE m.timestamp > now() - interval '7 days' AND m.custom_metrics ? 'agentRuntime'
GROUP BY ROLLUP (d.os_type) ORDER BY d.os_type NULLS LAST;
```

| os_type | devices | samples | sys p50 | sys p95 | heapInuse p50 | heapInuse p95 | goroutines p50 | goroutines p95 |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

### Ranked candidates

Ordered by the basis of each share, strongest first: in-use heap (reaches RSS), then allocation only, then hygiene, then nothing measured at idle. Within a basis, by share, then break risk. All shares are from the merged idle profiles.

1. Lazy-compile package-level regular expressions (new, wave 4). Basis: in-use heap. 29.0% of in-use heap at idle, about 1.2 MiB per agent; low risk.
2. Cache process name and exe by PID and start time (new, wave 4). Basis: allocation only. 47.9% of allocation at idle, in `gopsutil` `ExeWithContext`. No CPU, GC or RSS cost is attributed (Go code is under 1% of idle CPU, live heap 6-9 MB), so the win is unproven; low-medium risk (stale PID reuse).
3. `svcquery.queryBaseConfig` buffer reuse (new, wave 4). Basis: allocation only. 10.9% of allocation at idle; win unproven; low risk.
4. `json.Marshal` on heartbeat and inventory paths (wave 4). Basis: allocation only. 1.6% of allocation, 0% of in-use heap at idle; win unproven; low risk.
5. `io.ReadAll` on large bodies (wave 4). Basis: allocation only. 0.13% of allocation at idle; scan not profiled; win unproven; low risk.
6. `-trimpath` (wave 2). Basis: binary size. -0.26% agent, -0.42% helper; very low risk; hygiene, exempt from the win rule.
7. `go fix ./...` and `modernize` (wave 3). Basis: hygiene. No measured share; low risk.
8. GC arms `GOGC=50` / soft memory limit (wave 2). Basis: none measured. At idle it can only act on the 6-9 MB live heap inside 64-66 MB private bytes; low gain at idle, medium risk; gated on the fleet baseline.
9. Regular expressions compiled inside functions (wave 4). Basis: none measured at idle. The 2.65% cumulative allocation of `regexp.Compile` is mostly the init-time and package-level compiles counted in item 1; in-function compiles are not hit at idle. 40 call sites, mostly macOS and Linux; `executor.SanitizeOutput` compiles 7 per script run; low risk.
10. PGO (wave 2). Basis: none measured at idle. Go code is under 1% of idle CPU samples and idle CPU is 0.08-0.26% of a core, so near-zero gain at idle; scan (0.8-3.4 s CPU per 600 s) was not profiled; medium risk (binary growth, stale profile).
11. Remote desktop buffer reuse (wave 4). Not measured; `desktop` is not automated; unranked until a desktop workload exists.

### Goroutine leaks

`goroutineleak` reported 0 leaked goroutines on all three VMs (53 goroutines in each `goroutine` profile). No bug issues to file.

### Other bug issues to file

- Patch scan fails when `wuauserv` is `StartPending` (3 of 15 scans): the pre-check treats a service that is already starting as a start failure.
