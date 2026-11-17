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
