# Go Agent Performance Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Go 1.27.4, add CPU and goroutine-leak profiling to `capture_pprof`, measure the agent on three Windows lab VMs, then ship only build, runtime and code changes the measurements prove.

**Architecture:** Wave 0 finishes the toolchain bump PR (#11943). Wave 1 adds the profile types (agent plus API), a lab harness and a fleet baseline, and writes the ranked audit. Waves 2 to 4 are experiments driven by that audit; their tasks are fixed here only as far as the spec allows.

**Tech Stack:** Go 1.27.4, `runtime/pprof`, `benchstat`, GitHub Actions, Hono/TypeScript (API, Vitest), PowerShell over OpenSSH, libvirt `virsh`.

**Spec:** `docs/superpowers/specs/2026-11-17-go-agent-performance-audit-design.md`

## Global Constraints

- Go toolchain is exactly `1.27.4`. Every baseline is taken on Go 1.27.4.
- Never commit on `main`. One issue and one PR per fix.
- Commit messages for performance changes use `perf(agent):` and paste only significant benchstat rows plus the `goos`/`goarch`/`cpu` line. Rows marked `~` are never pasted.
- Benchmarks: `b.Loop()`, file `<source>_bench_test.go`, run with `-benchmem -count=10`, one at a time.
- Lab VMs: Win10-22H2-01, Win11-26H2-01, Win2025-01, existing specs. One VM running at a time, reverted to the same snapshot before each run, at least 5 runs per arm, before and after alternating. Enroll only against a local `worktree-stack`, never the production droplets. Tear down after each run.
- Keep a change only with a significant win and no significantly worse metric. PGO may grow the binary by up to 2%. `-trimpath` (`build:`) and `go fix ./...` (`refactor:`) are exempt from the win rule.
- Non-goals: dependency swaps, a CI benchmark gate, optimizing `breeze-watchdog` and `breeze-backup`, `scripts/security/yara-pack`, a server-pushed runtime policy, changing `GOMAXPROCS`.
- No IPs, hostnames or internal domains in committed files. Scripts discover VM addresses with `virsh domifaddr`.
- No emoji in PR or issue titles and bodies.

## Review Focus

1. A `cpu` capture issued while another CPU profile runs. Expected: a failed result whose error names the conflict, with no panic and no hang. The throttle slot stays consumed, matching the existing documented behavior. Pinned in Task 2.
2. An agent on an older release that receives `profile: "cpu"` returns "invalid profile". Expected: the API passes that agent error through instead of reporting "contract drifted". Pinned in Task 3.
3. `all` must stay fast. Expected: `all` never includes `cpu`, so existing callers and the 30-second API wait still work. Pinned in Tasks 2 and 3.
4. A CPU profile from a busy agent could exceed the 1 MiB result cap. Expected: the same size-cap error as heap and goroutine. Pinned in Task 2.
5. Lint Agent restoring a golangci-lint binary built by a different Go version after the next toolchain bump. Expected: the cache misses and reinstalls. Pinned in Task 1 by the key check.

---

## Wave 0: Go 1.27.4

Work on PR #11943's branch `chore/11941-go-1-27-4-toolchain` (head `428f4398`) in a worktree. Take it over with the `takeover` skill. The user merges.

### Task 1: Fix the Lint Agent cache key and finish the bump checks

**Files:**
- Modify: `.github/workflows/ci.yml` (Lint Agent "Cache golangci-lint binary" step, `key:` at about line 3537 on the branch)
- Modify: `.github/workflows/ci-cache-seed.yml` (restore `key:` at about line 235, save `key:` at about line 261)
- Modify: `docs/guides/AGENT_INSTALLATION.md:38`

- [ ] **Step 1: Show the stale key.** Run `grep -rn 'golangci-lint-v2.12.2-' .github/workflows/`. Expected: three hits, all `golangci-lint-v2.12.2-${{ runner.os }}`.
- [ ] **Step 2: Change all three keys** to `golangci-lint-v2.12.2-go${{ env.GO_VERSION }}-${{ runner.os }}`. Both workflows already define `env.GO_VERSION: '1.27.4'`. Update the "Keep the version in lockstep" comment in `ci-cache-seed.yml` to say the key also carries the Go version.
- [ ] **Step 3: Verify the keys match.** Run `grep -rhn 'golangci-lint-v2.12.2-' .github/workflows/ | sed 's/.*key: //' | sort -u`. Expected: exactly one line, `golangci-lint-v2.12.2-go${{ env.GO_VERSION }}-${{ runner.os }}`.
- [ ] **Step 4: Run lint locally with a 1.27.4-built binary.** Run `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2` and then `cd agent && golangci-lint run ./...` using the agent's CI lint config. Expected: exit 0, with no "go version" refusal.
- [ ] **Step 5: Change the macOS row** in `AGENT_INSTALLATION.md` from `macOS 11 (Big Sur)+` to `macOS 13 (Ventura)+`.
- [ ] **Step 6: Run the agent tests.** Run `cd agent && go test -race ./...`. Expected: PASS.
- [ ] **Step 7: Measure the binary size.** Build `breeze-agent` for windows/amd64 with `agent/scripts/build-edition.sh` on `origin/main` (Go 1.26.11) and on the branch (Go 1.27.4). Record both sizes in bytes for the PR body.
- [ ] **Step 8: Run a lab smoke test for JSON strictness.**
  1. Bring up a `worktree-stack` from the branch.
  2. Start Win11-26H2-01 with `virsh -c qemu:///system start`.
  3. Install and enroll the branch-built agent over OpenSSH.
  4. Confirm at least 3 heartbeats are stored, and that one `capture_pprof` and one inventory command complete with no JSON decode errors in the agent log.
  5. Tear down the stack and shut the VM off.
- [ ] **Step 9: Commit and push.**

```bash
git add .github/workflows/ci.yml .github/workflows/ci-cache-seed.yml docs/guides/AGENT_INSTALLATION.md
git commit -m "ci: key the golangci-lint cache on the Go version (#11941)"
git push
```

- [ ] **Step 10: Update the PR body** with the size delta and the smoke result, then confirm Lint Agent (Go) is green. Hand the PR back to the user for merge.

## Wave 1: Measure

Starts after #11943 merges. Branch `feature/<parent#>-go-agent-perf/wave-<sub#>` from `origin/main`.

### Task 2: Agent `cpu` and `goroutineleak` profile types

**Files:**
- Modify: `agent/internal/heartbeat/handlers_diag.go`
- Test: `agent/internal/heartbeat/handlers_diag_test.go`

**Interfaces:**
- Produces: result keys `cpuProfileBase64` (string), `cpuProfileBytes` (int), `goroutineleakProfileBase64` (string), `goroutineleakProfileBytes` (int). Accepted `profile` values: `heap`, `goroutine`, `goroutineleak`, `cpu`, `all`.
- Produces: `var capturePprofCPUDurationNs atomic.Int64` (defaults to 30s in `init`) and `func setCapturePprofCPUDuration(t testing.TB, d time.Duration)`, which restores the value on cleanup like `setCapturePprofMinInterval`.
- Produces: `func captureCPUProfile(d time.Duration) (b64 string, size int, err error)`.

- [ ] **Step 1: Write the failing tests**

```go
func TestHandleCapturePprofCPUOnly(t *testing.T) {
	setCapturePprofCPUDuration(t, 50*time.Millisecond)
	res := handleCapturePprof(newTestHeartbeatForDiag(t), Command{ID: "c", Type: "capture_pprof", Payload: map[string]any{"profile": "cpu"}})
	// status completed; assertValidPprofBlob(t, result, "cpuProfileBase64");
	// cpuProfileBytes > 0; heapProfileBase64, goroutineProfileBase64 absent
}

func TestHandleCapturePprofCPUBusy(t *testing.T) {
	setCapturePprofCPUDuration(t, 50*time.Millisecond)
	// pprof.StartCPUProfile(io.Discard) first; defer pprof.StopCPUProfile()
	// handleCapturePprof(profile "cpu") → Status "failed", Error contains "CPU profile already running"
}

func TestHandleCapturePprofGoroutineLeakOnly(t *testing.T) {
	// profile "goroutineleak" → assertValidPprofBlob(t, result, "goroutineleakProfileBase64"); no other blobs
}

func TestHandleCapturePprofAllExcludesCPU(t *testing.T) {
	// default payload → heap, goroutine, goroutineleak blobs present; cpuProfileBase64 absent
}

func TestHandleCapturePprofCPUSizeCap(t *testing.T) {
	setCapturePprofCPUDuration(t, 50*time.Millisecond)
	// maxProfileBytes = 1 (restore after), as in TestHandleCapturePprofSizeCap
	// profile "cpu" → Status "failed", Error contains "exceeds the 1 byte result cap"
}
```

  Also extend `TestHandleCapturePprofRejectsUnknownProfile` to expect the error `must be heap, goroutine, goroutineleak, cpu, or all`. Each new test calls `resetCapturePprofThrottle` the same way the existing tests do.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `cd agent && go test ./internal/heartbeat -run 'TestHandleCapturePprof' -count=1`. Expected: FAIL. `cpu` and `goroutineleak` are rejected as invalid profiles.
- [ ] **Step 3: Implement the change in `handlers_diag.go`.**
  - Add `wantCPU` and `wantLeak` to the switch. `all` sets heap, goroutine and leak.
  - `captureCPUProfile`: `pprof.StartCPUProfile` into a `bytes.Buffer`. On error, return `fmt.Errorf("CPU profile already running: %w", err)`. Then sleep `d`, stop, apply `maxProfileBytes`, and base64-encode.
  - The goroutine leak profile goes through the existing `capturePprofProfile("goroutineleak")`.
  - CPU capture never calls `runtime.GC()`.
  - Update the file header comment and the throttle error text to say heap and goroutineleak captures run a GC.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `cd agent && go test -race ./internal/heartbeat -run 'TestHandleCapturePprof|TestCapturePprof' -count=1`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add agent/internal/heartbeat/handlers_diag.go agent/internal/heartbeat/handlers_diag_test.go
git commit -m "feat(agent): cpu and goroutineleak capture_pprof profiles"
```

### Task 3: API accepts the new profile types

**Files:**
- Modify: `apps/api/src/services/commandTypes.ts` (add the shared constant)
- Modify: `apps/api/src/services/aiToolsAgentLogs.ts:425-530`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:3690`
- Modify: `apps/api/src/services/aiToolSchemas.ts:2099`
- Test: `apps/api/src/services/aiToolsAgentLogs.test.ts` (`describe('capture_agent_pprof')`, about line 467)

**Interfaces:**
- Consumes: the result keys from Task 2.
- Produces: `export const CAPTURE_PPROF_PROFILES = ['heap', 'goroutine', 'goroutineleak', 'cpu', 'all'] as const;` in `commandTypes.ts`. The two `z.enum` sites, the tool's JSON-schema `enum` and the runtime check all use it.

- [ ] **Step 1: Write the failing tests** in `describe('capture_agent_pprof')`:
  - `it('should dispatch profile cpu with a 60s timeout')`: `aiExecuteCommand` is called with `{ profile: 'cpu' }` and `timeoutMs: 60000`.
  - `it('should keep a 30s timeout for all')`: `timeoutMs: 30000`.
  - `it('should report cpu and goroutineleak profile sizes')`: mock stdout with `cpuProfileBytes: 10` and `goroutineleakProfileBytes: 20`. The output's `profiles` equals `{ cpu: { sizeBytes: 10 }, goroutineleak: { sizeBytes: 20 } }`.
  - `it('should pass through an old agent rejecting cpu')`: `result.status` is `'failed'` with error `invalid profile "cpu"...`. The returned error contains `invalid profile`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @breeze/api exec vitest run src/services/aiToolsAgentLogs.test.ts` (see `docs/agents/testing.md` for scoped runs). Expected: the 4 new tests FAIL.
- [ ] **Step 3: Implement the change.**
  - Use `CAPTURE_PPROF_PROFILES` at all four sites.
  - Set `timeoutMs: profile === 'cpu' ? 60000 : 30000`.
  - Add `cpu` and `goroutineleak` to the `profiles` map and to the download hint's field list.
  - Update the tool description to "heap/goroutine/goroutineleak/cpu".
- [ ] **Step 4: Run the tests and confirm they pass**, along with the API typecheck. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/commandTypes.ts apps/api/src/services/aiToolsAgentLogs.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiToolsAgentLogs.test.ts
git commit -m "feat(api): accept cpu and goroutineleak capture_agent_pprof profiles"
```

### Task 4: Lab measurement harness

**Files:**
- Create: `agent/scripts/perf/sample-process.ps1` (runs on the VM)
- Create: `agent/scripts/perf/run-lab.sh` (runs on the host)
- Create: `agent/scripts/perf/README.md`

**Interfaces:**
- `sample-process.ps1 -Name breeze-agent -Seconds <n> -Out <csv>`: one row every 10 seconds. Columns: `ts,workingSetBytes,privateBytes,cpuSeconds,handles`.
- `run-lab.sh --vm <name> --snapshot <name> --agent <path.exe> --workload idle|scan|desktop|transfer --runs <n> --out <dir>`. For each run it:
  1. Reverts the snapshot.
  2. Starts the VM and waits for SSH (address from `virsh -c qemu:///system domifaddr`).
  3. Copies the agent, enrolls it against `$BREEZE_STACK_URL`, and runs the workload.
  4. Samples the process and pulls the CSV.
  5. Queries `device_metrics.custom_metrics->'agentRuntime'` for goroutines, and shuts the VM off.
- Workload lengths come from the spec: idle 30 minutes with a 60-second heartbeat, one inventory and patch scan, a 5-minute remote desktop session, and a 500 MB file transfer.

- [ ] **Step 1: Write `sample-process.ps1`.** Verify on Win11-26H2-01 with `-Seconds 30`. Expected: 3 or 4 rows with non-zero values.
- [ ] **Step 2: Write `run-lab.sh`** with `set -euo pipefail` and a `trap` that shuts the VM off on exit. Run `shellcheck agent/scripts/perf/run-lab.sh`. Expected: clean.
- [ ] **Step 3: Smoke run.** Run `run-lab.sh --workload idle --runs 1` with the idle length shortened through `--seconds 120`. Expected: one CSV plus a goroutine count, and the VM shut off afterwards.
- [ ] **Step 4: Write the README** with usage and the measurement-discipline rules copied from the spec.
- [ ] **Step 5: Commit.**

```bash
git add agent/scripts/perf/
git commit -m "chore(agent): lab measurement harness for the performance audit"
```

### Task 5: Baselines and the ranked audit

**Files:**
- Modify: `docs/superpowers/specs/2026-11-17-go-agent-performance-audit-design.md` (add an "Appendix: ranked audit" section)

- [ ] **Step 1: Run the lab baseline.** For each VM, one at a time, run all four workloads 5 times with the Go 1.27.4 release build. Record the median and spread of each metric, plus the binary sizes of `breeze-agent` and `breeze-desktop-helper`.
- [ ] **Step 2: Capture lab profiles.** During the idle and desktop workloads, capture `cpu`, `heap`, `goroutine` and `goroutineleak` profiles. Store them under the gitignored `internal/perf/`.
- [ ] **Step 3: Record the fleet baseline.** Query p50 and p95 of `sysBytes`, `heapInuseBytes` and `goroutines` from `device_metrics.custom_metrics->'agentRuntime'` over the last 7 days. Fleet CPU profiles wait until an agent release ships Task 2.
- [ ] **Step 4: Write the appendix.** List the top hotspots from `go tool pprof -top`. Rank each candidate from waves 2 to 4 by measured share and break risk. Any `goroutineleak` finding becomes its own bug issue.
- [ ] **Step 5: Commit, open the wave 1 PR** (`Closes #<wave-1 sub-issue>`), and run the full suites (Go race tests, API tests) before marking it ready.

## Wave 2: Build and runtime settings

The detail depends on the Task 5 appendix. Each item is its own issue and PR.

### Task 6: `-trimpath` (hygiene, exempt from the win rule)

- Modify `agent/scripts/build-edition.sh` to pass `-trimpath` next to `-s -w`.
- Verify: `go version -m <binary>` shows `-trimpath=true`, and `strings <binary> | grep -c "$HOME"` returns 0.
- Commit: `build(agent): build release binaries with -trimpath`.

### Task 7: PGO

- Merge lab and fleet CPU profiles with `go tool pprof -proto a.pprof b.pprof ... > default.pgo`, into `agent/cmd/breeze-agent/default.pgo` and `agent/cmd/breeze-desktop-helper/default.pgo`.
- Measure: lab idle and desktop workloads, 5 runs per arm, CPU seconds compared with and without PGO. Binary growth must be at most 2%.
- Commit: `perf(agent): enable PGO`, with the evidence table.

### Task 8: GC experiment

- Arms: default, `GOGC=50`, and a soft memory limit at about 1.5 times the observed peak of Go runtime memory (`runtime/metrics` total minus released). All are set through environment variables on the lab VMs first.
- Keep an arm only if working set drops significantly without a significant CPU rise. A kept arm gets a built-in default in agent startup that config or an environment variable can override. The builder chooses the key name.

## Wave 3: Go 1.27 modernization

### Task 9: `go fix` and the modernize linter

- Run `cd agent && go fix ./...` (a `refactor:` commit, exempt). Enable the golangci-lint `modernize` linter and fix its findings.
- Any further 1.27 change, chosen from the release notes read at the time, needs benchstat evidence.

## Wave 4: Hot paths

### Task 10 and later: one task per appendix hotspot

- Candidates, only where the profiles show cost: regular expressions compiled inside functions, `io.ReadAll` on large bodies and files, `json.Marshal` on heartbeat and inventory paths, and buffer reuse in remote desktop.
- Each task first writes a `<source>_bench_test.go` benchmark. Then it takes a baseline, makes one change and runs benchstat, and the commit is `perf(agent):` with the significant rows.

## Tracking

- After the plan is approved: `register_feature` (parent labeled `feature`, one `wave` sub-issue per wave), then add `tracking_issue:` to this plan's frontmatter.
- Wave 0 rides #11943 and references its wave sub-issue in the PR body.
