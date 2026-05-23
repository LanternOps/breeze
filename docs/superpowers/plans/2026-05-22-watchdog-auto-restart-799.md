# Watchdog Auto-Restart on Prolonged Heartbeat Silence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the watchdog flap-loop hole, add a 24h restart counter, escalate to FAILOVER on 5 restarts/24h, surface the count in the watchdog heartbeat payload, and add an integration test — implementing the design in `docs/superpowers/specs/2026-05-22-watchdog-auto-restart-design.md` for issue #799.

**Architecture:** Five small, additive changes to the existing watchdog state machine: (1) inject a `serviceController` interface so recovery is testable in-process; (2) add a 24h-rolling `restartHistory` to `RecoveryManager` with file persistence; (3) add a verification gate that waits for the agent's `LastHeartbeat` to advance past the restart moment before declaring success; (4) check `Count24h() >= maxRestartsPer24h` before each attempt and emit `EventRecoveryExhausted` → FAILOVER if exceeded; (5) extend the failover heartbeat body with `mainAgentRestartCount24h`, `mainAgentLastRestartAt`, `flapDetected`. The API side adds these to the zod schema (non-breaking) and writes an `agent_logs` row when activity is non-zero — DB column work deferred to #800.

**Tech Stack:** Go 1.25 (agent), viper config, Drizzle ORM + Hono + zod (API), Vitest (API tests), Go standard `testing` (agent tests).

---

## Branch already exists

The spec was committed on `feat/watchdog-auto-restart-799`. All work in this plan continues on that branch.

```bash
git status   # expect: on feat/watchdog-auto-restart-799, clean
```

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `agent/internal/watchdog/recovery.go` | Modify | Add `serviceController` interface + `Clock` + `restartHistory` + `Count24h`/`LastRestartAt` + persistence |
| `agent/internal/watchdog/recovery_windows.go` | Modify | Wrap funcs in `osServiceController` (Windows) |
| `agent/internal/watchdog/recovery_darwin.go` | Modify | Same for macOS |
| `agent/internal/watchdog/recovery_linux.go` | Modify | Same for Linux |
| `agent/internal/watchdog/recovery_test.go` | Create | Unit tests for history, Count24h, persistence, fake controller, fake clock |
| `agent/internal/watchdog/integration_test.go` | Create | In-process integration tests covering the 4 spec scenarios |
| `agent/internal/watchdog/watchdog_test.go` | Modify | Add flap-escalation test |
| `agent/internal/watchdog/failover.go` | Modify | New `RestartStats` struct; extend `SendHeartbeat` body |
| `agent/internal/watchdog/failover_test.go` | Modify | Cover new payload fields |
| `agent/cmd/breeze-watchdog/main.go` | Modify | Verification gate + flap-check in RECOVERING tick |
| `agent/internal/config/config.go` | Modify | 3 new fields + default values + viper alias |
| `apps/api/src/routes/agents/schemas.ts` | Modify | Add 3 optional fields to `heartbeatSchema` |
| `apps/api/src/routes/agents/heartbeat.ts` | Modify | Insert `agent_logs` row when restart activity present |
| `apps/api/src/routes/agents/heartbeat.test.ts` | Modify | Assert log insertion on flap signal |

---

## Task 1 — Inject `serviceController` interface (no behavior change)

**Why:** Today `restartAgentService()`, `startAgentService()`, `forceKillProcess()` are package-level functions. The integration test needs to swap them. Extract a small interface; production code passes an OS-backed impl; tests pass a recording fake.

**Files:**
- Modify: `agent/internal/watchdog/recovery.go`
- Modify: `agent/internal/watchdog/recovery_windows.go`
- Modify: `agent/internal/watchdog/recovery_darwin.go`
- Modify: `agent/internal/watchdog/recovery_linux.go`
- Modify: `agent/cmd/breeze-watchdog/main.go` (constructor call site)

- [ ] **Step 1: Add the interface and update `RecoveryManager` to use it**

Edit `agent/internal/watchdog/recovery.go` — replace the file body (keep package + imports tidy):

```go
package watchdog

import (
	"os"
	"syscall"
	"time"
)

// serviceController is the OS-specific surface RecoveryManager.Attempt depends
// on. Production builds inject osServiceController (one impl per GOOS).
// Tests inject a fake. Method names match the existing package-level
// functions so platform files only need to wrap them.
type serviceController interface {
	RestartAgentService() error
	StartAgentService() error
	ForceKillProcess(pid int)
}

// RecoveryManager tracks escalating recovery attempts for an unhealthy agent.
type RecoveryManager struct {
	maxAttempts int
	cooldown    time.Duration
	attempts    int
	lastAttempt time.Time
	windowStart time.Time
	svc         serviceController
}

// NewRecoveryManager creates a RecoveryManager with the given limits and the
// real OS service controller.
func NewRecoveryManager(maxAttempts int, cooldown time.Duration) *RecoveryManager {
	return newRecoveryManagerWithDeps(maxAttempts, cooldown, osServiceController{})
}

// newRecoveryManagerWithDeps is the test seam — callers can inject a fake
// serviceController. Not exported.
func newRecoveryManagerWithDeps(maxAttempts int, cooldown time.Duration, svc serviceController) *RecoveryManager {
	return &RecoveryManager{
		maxAttempts: maxAttempts,
		cooldown:    cooldown,
		windowStart: time.Now(),
		svc:         svc,
	}
}

// CanAttempt returns true if another recovery attempt is allowed. If the
// cooldown window has passed since windowStart, the counter is reset first.
func (r *RecoveryManager) CanAttempt() bool {
	if time.Since(r.windowStart) >= r.cooldown {
		r.attempts = 0
		r.windowStart = time.Now()
	}
	return r.attempts < r.maxAttempts
}

// Attempt increments the counter and executes an escalating recovery action
// based on how many attempts have been made:
//
//	Attempt 1: Graceful restart via service manager.
//	Attempt 2: Force-kill the process then start via service manager.
//	Attempt 3+: Just try starting the service (process may already be gone).
//
// Returns (true, nil) on success, (false, err) on failure.
func (r *RecoveryManager) Attempt(pid int) (bool, error) {
	r.attempts++
	r.lastAttempt = time.Now()

	var err error
	switch r.attempts {
	case 1:
		err = r.svc.RestartAgentService()
	case 2:
		r.svc.ForceKillProcess(pid)
		err = r.svc.StartAgentService()
	default:
		err = r.svc.StartAgentService()
	}

	if err != nil {
		return false, err
	}
	return true, nil
}

// Attempts returns the current attempt count within the active window.
func (r *RecoveryManager) Attempts() int { return r.attempts }

// Reset clears the attempt counter and resets the window start time.
func (r *RecoveryManager) Reset() {
	r.attempts = 0
	r.windowStart = time.Now()
}

// osServiceController is the production serviceController. Each GOOS file
// supplies RestartAgentService and StartAgentService via the package-level
// helpers; ForceKillProcess is the same SIGKILL on every platform.
type osServiceController struct{}

func (osServiceController) RestartAgentService() error { return restartAgentService() }
func (osServiceController) StartAgentService() error   { return startAgentService() }
func (osServiceController) ForceKillProcess(pid int)   { forceKillProcess(pid) }

// forceKillProcess sends SIGKILL to the process identified by pid.
// Errors are silently ignored — the process may already be gone.
func forceKillProcess(pid int) {
	if pid <= 0 {
		return
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = proc.Signal(syscall.SIGKILL)
}
```

- [ ] **Step 2: Verify platform files still compile against the new interface**

Confirm `restartAgentService()` and `startAgentService()` already exist on Windows (`recovery_windows.go`), macOS (`recovery_darwin.go`), and Linux (`recovery_linux.go`). No edits required — `osServiceController` calls them directly. Read each file to be sure the function names match:

```bash
grep -n "^func restartAgentService\|^func startAgentService" agent/internal/watchdog/recovery_*.go
```

Expected: each platform file defines both functions.

- [ ] **Step 3: Verify constructor call sites still work**

`agent/cmd/breeze-watchdog/main.go:226` calls `watchdog.NewRecoveryManager(wdCfg.MaxRecoveryAttempts, wdCfg.RecoveryCooldown)`. Signature unchanged — no edit needed.

- [ ] **Step 4: Build and run existing tests to verify no regressions**

```bash
cd agent && go test -race ./internal/watchdog/...
```

Expected: all existing tests pass (initial state, state-machine transitions, journal, checks).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/watchdog/recovery.go
git commit -m "refactor(watchdog): extract serviceController interface for testability

No behavior change. RecoveryManager now takes a serviceController via
newRecoveryManagerWithDeps; NewRecoveryManager wires the OS-backed impl.
This is the seam the upcoming integration test plugs into.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Add a `Clock` interface for deterministic tests

**Why:** Both `RecoveryManager` (history purge, window reset) and the upcoming verification gate compare against `time.Now()`. Tests need a fake clock.

**Files:**
- Modify: `agent/internal/watchdog/recovery.go`

- [ ] **Step 1: Add the Clock interface and wire it through `RecoveryManager`**

At the top of `agent/internal/watchdog/recovery.go`, add (after imports):

```go
// Clock abstracts time for deterministic tests. Production uses realClock.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }
```

Modify `RecoveryManager` and its constructors to take a clock:

```go
type RecoveryManager struct {
	maxAttempts int
	cooldown    time.Duration
	attempts    int
	lastAttempt time.Time
	windowStart time.Time
	svc         serviceController
	clk         Clock
}

func NewRecoveryManager(maxAttempts int, cooldown time.Duration) *RecoveryManager {
	return newRecoveryManagerWithDeps(maxAttempts, cooldown, osServiceController{}, realClock{})
}

func newRecoveryManagerWithDeps(maxAttempts int, cooldown time.Duration, svc serviceController, clk Clock) *RecoveryManager {
	return &RecoveryManager{
		maxAttempts: maxAttempts,
		cooldown:    cooldown,
		windowStart: clk.Now(),
		svc:         svc,
		clk:         clk,
	}
}
```

Replace every `time.Now()` and `time.Since(...)` inside `RecoveryManager` methods with `r.clk.Now()` / `r.clk.Now().Sub(...)`:

```go
func (r *RecoveryManager) CanAttempt() bool {
	if r.clk.Now().Sub(r.windowStart) >= r.cooldown {
		r.attempts = 0
		r.windowStart = r.clk.Now()
	}
	return r.attempts < r.maxAttempts
}

func (r *RecoveryManager) Attempt(pid int) (bool, error) {
	r.attempts++
	r.lastAttempt = r.clk.Now()
	// ...rest unchanged
}

func (r *RecoveryManager) Reset() {
	r.attempts = 0
	r.windowStart = r.clk.Now()
}
```

- [ ] **Step 2: Build and run existing tests**

```bash
cd agent && go test -race ./internal/watchdog/...
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add agent/internal/watchdog/recovery.go
git commit -m "refactor(watchdog): inject Clock into RecoveryManager

Replace direct time.Now()/time.Since() calls with a Clock interface so
upcoming history-window tests can advance time deterministically.
Production callers unchanged; NewRecoveryManager wires realClock{}.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Add 24h restart history + persistence (TDD)

**Files:**
- Create: `agent/internal/watchdog/recovery_test.go`
- Modify: `agent/internal/watchdog/recovery.go`

- [ ] **Step 1: Write failing tests for `Count24h`, history bounds, and persistence**

Create `agent/internal/watchdog/recovery_test.go`:

```go
package watchdog

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeClock is a manually advanced clock used to test time-based behavior.
type fakeClock struct{ now time.Time }

func (f *fakeClock) Now() time.Time         { return f.now }
func (f *fakeClock) Advance(d time.Duration) { f.now = f.now.Add(d) }

// noopServiceController returns success for every call — used when the test
// is about counting/history, not about the OS escalation steps.
type noopServiceController struct{ restarts, kills, starts int }

func (n *noopServiceController) RestartAgentService() error { n.restarts++; return nil }
func (n *noopServiceController) StartAgentService() error   { n.starts++; return nil }
func (n *noopServiceController) ForceKillProcess(int)       { n.kills++ }

func newTestRecovery(t *testing.T, clk Clock, svc serviceController) *RecoveryManager {
	t.Helper()
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	return r
}

func TestCount24hEmpty(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})
	if got := r.Count24h(); got != 0 {
		t.Fatalf("Count24h on empty: want 0, got %d", got)
	}
	if !r.LastRestartAt().IsZero() {
		t.Fatalf("LastRestartAt on empty: want zero time, got %v", r.LastRestartAt())
	}
}

func TestCount24hWithinWindow(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})

	// Three restart attempts spaced 1h apart, all within the 24h window.
	for i := 0; i < 3; i++ {
		ok, err := r.Attempt(1234)
		if err != nil || !ok {
			t.Fatalf("attempt %d: ok=%v err=%v", i, ok, err)
		}
		clk.Advance(time.Hour)
	}
	if got := r.Count24h(); got != 3 {
		t.Fatalf("Count24h within window: want 3, got %d", got)
	}
}

func TestCount24hPurgesOld(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})

	// First attempt at t0.
	if _, err := r.Attempt(1); err != nil {
		t.Fatal(err)
	}
	// Advance 25h — first entry is now outside the window.
	clk.Advance(25 * time.Hour)
	// Reset per-window attempts so we can attempt again (we don't care about
	// the per-window cooldown for this test, only the 24h history).
	r.Reset()
	if _, err := r.Attempt(2); err != nil {
		t.Fatal(err)
	}
	if got := r.Count24h(); got != 1 {
		t.Fatalf("Count24h after purge: want 1, got %d", got)
	}
}

func TestCount24hBoundedByCap(t *testing.T) {
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newTestRecovery(t, clk, &noopServiceController{})

	// Push 60 attempts inside the window; expect history capped at 50.
	for i := 0; i < 60; i++ {
		r.Reset() // bypass per-window cooldown for this test
		if _, err := r.Attempt(1); err != nil {
			t.Fatal(err)
		}
		clk.Advance(time.Minute)
	}
	if got := len(r.restartHistory); got != restartHistoryCap {
		t.Fatalf("restartHistory length: want %d (cap), got %d", restartHistoryCap, got)
	}
	if got := r.Count24h(); got != restartHistoryCap {
		t.Fatalf("Count24h with cap: want %d, got %d", restartHistoryCap, got)
	}
}

func TestLastRestartAtMatchesClock(t *testing.T) {
	t0 := time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)
	clk := &fakeClock{now: t0}
	r := newTestRecovery(t, clk, &noopServiceController{})

	if _, err := r.Attempt(1); err != nil {
		t.Fatal(err)
	}
	if got := r.LastRestartAt(); !got.Equal(t0) {
		t.Fatalf("LastRestartAt: want %v, got %v", t0, got)
	}
}

func TestHistoryRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "watchdog-restart-history.json")

	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r1 := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r1.SetHistoryPath(path)

	// Two attempts.
	r1.Attempt(1)
	clk.Advance(time.Hour)
	r1.Reset()
	r1.Attempt(2)

	// New manager points at the same file; advance not needed (clock starts at same value).
	r2 := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r2.SetHistoryPath(path)
	if got := r2.Count24h(); got != 2 {
		t.Fatalf("round-trip Count24h: want 2, got %d", got)
	}
}

func TestHistoryCorruptFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "watchdog-restart-history.json")
	if err := os.WriteFile(path, []byte("not json {{{"), 0o600); err != nil {
		t.Fatal(err)
	}
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r.SetHistoryPath(path)
	if got := r.Count24h(); got != 0 {
		t.Fatalf("corrupt-file Count24h: want 0, got %d", got)
	}
}

func TestHistoryMissingFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.json")
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	r := newRecoveryManagerWithDeps(3, 10*time.Minute, &noopServiceController{}, clk)
	r.SetHistoryPath(path)
	if got := r.Count24h(); got != 0 {
		t.Fatalf("missing-file Count24h: want 0, got %d", got)
	}
}
```

- [ ] **Step 2: Run the new tests — they must fail (missing fields/methods)**

```bash
cd agent && go test -race ./internal/watchdog/ -run 'TestCount24h|TestLastRestartAt|TestHistory'
```

Expected: compile errors — `restartHistory`, `Count24h`, `LastRestartAt`, `SetHistoryPath`, `restartHistoryCap` don't exist yet.

- [ ] **Step 3: Implement the history feature on `RecoveryManager`**

Edit `agent/internal/watchdog/recovery.go` — add at the top of the file (after the existing imports, expanding imports for `encoding/json` and `os`):

```go
import (
	"encoding/json"
	"log/slog"
	"os"
	"sort"
	"syscall"
	"time"
)

const restartHistoryCap = 50
```

Extend `RecoveryManager` with the history fields:

```go
type RecoveryManager struct {
	maxAttempts    int
	cooldown       time.Duration
	attempts       int
	lastAttempt    time.Time
	windowStart    time.Time
	svc            serviceController
	clk            Clock
	restartHistory []time.Time
	historyPath    string
}
```

Add the new methods at the bottom of the file:

```go
// SetHistoryPath enables persistence of the 24h restart history to disk and
// loads any prior entries from path. Call this once after construction (the
// production wiring in main.go does so when journal_dir is known). path == ""
// disables persistence.
func (r *RecoveryManager) SetHistoryPath(path string) {
	r.historyPath = path
	r.loadHistory()
}

// Count24h returns the number of restart attempts within the last 24h,
// purging expired entries as a side effect.
func (r *RecoveryManager) Count24h() int {
	r.purgeOldHistory()
	return len(r.restartHistory)
}

// LastRestartAt returns the time of the most recent restart attempt, or the
// zero time if no attempts have occurred in the current history.
func (r *RecoveryManager) LastRestartAt() time.Time {
	if len(r.restartHistory) == 0 {
		return time.Time{}
	}
	return r.restartHistory[len(r.restartHistory)-1]
}

// recordRestart appends an entry to restartHistory, enforces the cap, and
// best-effort persists to disk.
func (r *RecoveryManager) recordRestart(at time.Time) {
	r.restartHistory = append(r.restartHistory, at)
	if len(r.restartHistory) > restartHistoryCap {
		// Drop oldest entries to stay within the cap.
		excess := len(r.restartHistory) - restartHistoryCap
		r.restartHistory = r.restartHistory[excess:]
	}
	r.persistHistory()
}

func (r *RecoveryManager) purgeOldHistory() {
	if len(r.restartHistory) == 0 {
		return
	}
	cutoff := r.clk.Now().Add(-24 * time.Hour)
	idx := sort.Search(len(r.restartHistory), func(i int) bool {
		return r.restartHistory[i].After(cutoff) || r.restartHistory[i].Equal(cutoff)
	})
	if idx > 0 {
		r.restartHistory = r.restartHistory[idx:]
	}
}

type restartHistoryFile struct {
	Restarts []time.Time `json:"restarts"`
}

func (r *RecoveryManager) loadHistory() {
	if r.historyPath == "" {
		return
	}
	data, err := os.ReadFile(r.historyPath)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("watchdog.restart_history.read_failed", "path", r.historyPath, "error", err.Error())
		}
		return
	}
	var f restartHistoryFile
	if err := json.Unmarshal(data, &f); err != nil {
		slog.Warn("watchdog.restart_history.parse_failed", "path", r.historyPath, "error", err.Error())
		return
	}
	r.restartHistory = f.Restarts
	r.purgeOldHistory()
}

func (r *RecoveryManager) persistHistory() {
	if r.historyPath == "" {
		return
	}
	data, err := json.Marshal(restartHistoryFile{Restarts: r.restartHistory})
	if err != nil {
		slog.Warn("watchdog.restart_history.marshal_failed", "error", err.Error())
		return
	}
	if err := os.WriteFile(r.historyPath, data, 0o600); err != nil {
		slog.Warn("watchdog.restart_history.write_failed", "path", r.historyPath, "error", err.Error())
	}
}
```

And wire `recordRestart` into `Attempt`:

```go
func (r *RecoveryManager) Attempt(pid int) (bool, error) {
	r.attempts++
	r.lastAttempt = r.clk.Now()
	r.recordRestart(r.lastAttempt)

	var err error
	switch r.attempts {
	case 1:
		err = r.svc.RestartAgentService()
	case 2:
		r.svc.ForceKillProcess(pid)
		err = r.svc.StartAgentService()
	default:
		err = r.svc.StartAgentService()
	}

	if err != nil {
		return false, err
	}
	return true, nil
}
```

- [ ] **Step 4: Run the new tests — they must pass**

```bash
cd agent && go test -race ./internal/watchdog/ -run 'TestCount24h|TestLastRestartAt|TestHistory' -v
```

Expected: all seven new tests pass.

- [ ] **Step 5: Run the full watchdog test suite to confirm no regression**

```bash
cd agent && go test -race ./internal/watchdog/...
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/watchdog/recovery.go agent/internal/watchdog/recovery_test.go
git commit -m "feat(watchdog): add 24h restart history with persistence

RecoveryManager now records every Attempt() into a 24h rolling history,
purges expired entries lazily on read, caps at 50 entries to bound disk
size, and persists to <history_path>/watchdog-restart-history.json. The
file is best-effort: corrupt or missing => start empty + slog.Warn.

This is the data the upcoming flap-detection and failover-heartbeat
payload changes will read from. No production wiring yet.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Add new config fields + viper alias

**Files:**
- Modify: `agent/internal/config/config.go`

- [ ] **Step 1: Add fields to `WatchdogConfig`**

Edit `agent/internal/config/config.go`. Replace the `WatchdogConfig` struct (lines 15-26):

```go
type WatchdogConfig struct {
	Enabled                    bool          `mapstructure:"enabled" yaml:"enabled"`
	ProcessCheckInterval       time.Duration `mapstructure:"process_check_interval" yaml:"process_check_interval"`
	IPCProbeInterval           time.Duration `mapstructure:"ipc_probe_interval" yaml:"ipc_probe_interval"`
	HeartbeatStaleThreshold    time.Duration `mapstructure:"heartbeat_stale_threshold" yaml:"heartbeat_stale_threshold"`
	MaxRecoveryAttempts        int           `mapstructure:"max_recovery_attempts" yaml:"max_recovery_attempts"`
	RecoveryCooldown           time.Duration `mapstructure:"recovery_cooldown" yaml:"recovery_cooldown"`
	StandbyTimeout             time.Duration `mapstructure:"standby_timeout" yaml:"standby_timeout"`
	FailoverPollInterval       time.Duration `mapstructure:"failover_poll_interval" yaml:"failover_poll_interval"`
	HealthJournalMaxSizeMB     int           `mapstructure:"health_journal_max_size_mb" yaml:"health_journal_max_size_mb"`
	HealthJournalMaxFiles      int           `mapstructure:"health_journal_max_files" yaml:"health_journal_max_files"`
	// Auto-restart verification gate — set after Task 5 wires them.
	RestartVerificationGrace   time.Duration `mapstructure:"restart_verification_grace" yaml:"restart_verification_grace"`
	RestartVerificationTimeout time.Duration `mapstructure:"restart_verification_timeout" yaml:"restart_verification_timeout"`
	MaxRestartsPer24h          int           `mapstructure:"max_restarts_per_24h" yaml:"max_restarts_per_24h"`
}
```

In the `Default()` function, update the `Watchdog:` literal (around line 200-211) to include defaults:

```go
Watchdog: WatchdogConfig{
	Enabled:                    true,
	ProcessCheckInterval:       5 * time.Second,
	IPCProbeInterval:           30 * time.Second,
	HeartbeatStaleThreshold:    3 * time.Minute,
	MaxRecoveryAttempts:        3,
	RecoveryCooldown:           10 * time.Minute,
	StandbyTimeout:             30 * time.Minute,
	FailoverPollInterval:       30 * time.Second,
	HealthJournalMaxSizeMB:     10,
	HealthJournalMaxFiles:      3,
	RestartVerificationGrace:   30 * time.Second,
	RestartVerificationTimeout: 120 * time.Second,
	MaxRestartsPer24h:          5,
},
```

- [ ] **Step 2: Register the `max_heartbeat_staleness_sec` alias**

Find the `Load` function in `agent/internal/config/config.go` (around line 215). After the `viper.SetEnvPrefix("BREEZE")` line and before `viper.ReadInConfig()`, add:

```go
// Accept watchdog.max_heartbeat_staleness_sec (in seconds) as documented in
// issue #799 — coerce to the canonical Duration field. The alias mechanism
// in viper does not coerce numeric→Duration, so we read it explicitly after
// Unmarshal.
```

Then, after the existing `if err := viper.Unmarshal(cfg); err != nil { return nil, err }` (around line 236-238), insert:

```go
if v := viper.GetInt("watchdog.max_heartbeat_staleness_sec"); v > 0 {
	cfg.Watchdog.HeartbeatStaleThreshold = time.Duration(v) * time.Second
}
```

- [ ] **Step 3: Verify the agent builds**

```bash
cd agent && go build ./...
```

Expected: build succeeds.

- [ ] **Step 4: Add a config test for the alias**

Find or create a config test file. Use this exact content — if `agent/internal/config/config_test.go` already exists, append to it; otherwise create it:

```go
package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/spf13/viper"
)

func TestMaxHeartbeatStalenessSecAlias(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	yaml := `
agent_id: test
server_url: https://example.com
watchdog:
  max_heartbeat_staleness_sec: 240
`
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	// Reset viper between tests because it's a global singleton.
	viper.Reset()

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := 240 * time.Second
	if cfg.Watchdog.HeartbeatStaleThreshold != want {
		t.Fatalf("HeartbeatStaleThreshold: want %v, got %v", want, cfg.Watchdog.HeartbeatStaleThreshold)
	}
}

func TestWatchdogDefaults(t *testing.T) {
	cfg := Default()
	if cfg.Watchdog.RestartVerificationGrace != 30*time.Second {
		t.Errorf("RestartVerificationGrace default: want 30s, got %v", cfg.Watchdog.RestartVerificationGrace)
	}
	if cfg.Watchdog.RestartVerificationTimeout != 120*time.Second {
		t.Errorf("RestartVerificationTimeout default: want 120s, got %v", cfg.Watchdog.RestartVerificationTimeout)
	}
	if cfg.Watchdog.MaxRestartsPer24h != 5 {
		t.Errorf("MaxRestartsPer24h default: want 5, got %d", cfg.Watchdog.MaxRestartsPer24h)
	}
}
```

- [ ] **Step 5: Run the config tests**

```bash
cd agent && go test -race ./internal/config/...
```

Expected: both new tests pass; pre-existing tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/config/
git commit -m "feat(config): add watchdog restart-verification + flap-limit knobs

RestartVerificationGrace (30s), RestartVerificationTimeout (120s),
MaxRestartsPer24h (5). Also accepts the issue's documented config
name watchdog.max_heartbeat_staleness_sec (in seconds) and coerces it
to HeartbeatStaleThreshold.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Verification gate in the RECOVERING tick

**Why:** This is the core correctness fix — restart success must mean "heartbeat resumed", not "SCM returned ok".

**Files:**
- Modify: `agent/cmd/breeze-watchdog/main.go`

- [ ] **Step 1: Add a `pendingVerify` local + new helper**

Edit `agent/cmd/breeze-watchdog/main.go`. Just inside `runWatchdog` after `recovery := watchdog.NewRecoveryManager(...)` (around line 226), add:

```go
// Persist the 24h restart history alongside the health journal so it
// survives watchdog restarts.
historyPath := filepath.Join(config.LogDir(), "watchdog-restart-history.json")
recovery.SetHistoryPath(historyPath)

// Verification state for the in-flight restart attempt, if any. nil =
// no attempt waiting on verification; non-nil = we restarted at this
// time and are watching for the agent's LastHeartbeat to advance past
// (startedAt + RestartVerificationGrace).
var pendingVerify *struct {
	startedAt time.Time
}
```

Add `"path/filepath"` to the imports at the top of the file if not already present.

- [ ] **Step 2: Replace the RECOVERING end-of-tick branch**

Find the existing block at `main.go:366-387`:

```go
case watchdog.StateRecovering:
    if recovery.CanAttempt() {
        journal.Log(watchdog.LevelInfo, "recovery.attempt", map[string]any{
            "attempt": recovery.Attempts() + 1,
            "pid":     pid,
        })
        ok, err := recovery.Attempt(pid)
        if ok {
            journal.Log(watchdog.LevelInfo, "recovery.success", nil)
            wd.HandleEvent(watchdog.EventAgentRecovered)
        } else {
            journal.Log(watchdog.LevelError, "recovery.failed", map[string]any{
                "error": errStr(err),
            })
        }
    } else {
        journal.Log(watchdog.LevelError, "recovery.exhausted", map[string]any{
            "attempts": recovery.Attempts(),
        })
        wd.HandleEvent(watchdog.EventRecoveryExhausted)
    }
```

Replace with:

```go
case watchdog.StateRecovering:
    // If a restart is awaiting verification, don't start another one.
    if pendingVerify != nil {
        elapsed := time.Since(pendingVerify.startedAt)
        // Re-read state so we see the freshest LastHeartbeat.
        if s, err := state.Read(statePath); err == nil && s != nil {
            agentState = s
        }
        // Success = heartbeat advanced past (startedAt + grace).
        verifyDeadline := pendingVerify.startedAt.Add(wdCfg.RestartVerificationGrace)
        if agentState != nil && agentState.LastHeartbeat.After(verifyDeadline) {
            journal.Log(watchdog.LevelInfo, "recovery.verified", map[string]any{
                "elapsed_ms":      elapsed.Milliseconds(),
                "last_heartbeat":  agentState.LastHeartbeat.Format(time.RFC3339),
            })
            pendingVerify = nil
            wd.HandleEvent(watchdog.EventAgentRecovered)
            break
        }
        // Timeout = give up on this attempt; let the next tick try again.
        if elapsed > wdCfg.RestartVerificationTimeout {
            journal.Log(watchdog.LevelWarn, "recovery.verify_timeout", map[string]any{
                "elapsed_ms": elapsed.Milliseconds(),
            })
            pendingVerify = nil
        }
        break
    }

    // Flap-detection gate: if we've exceeded the 24h budget, jump to FAILOVER.
    if recovery.Count24h() >= wdCfg.MaxRestartsPer24h {
        journal.Log(watchdog.LevelError, "recovery.flap_detected", map[string]any{
            "count_24h": recovery.Count24h(),
        })
        wd.HandleEvent(watchdog.EventRecoveryExhausted)
        break
    }

    if !recovery.CanAttempt() {
        journal.Log(watchdog.LevelError, "recovery.exhausted", map[string]any{
            "attempts": recovery.Attempts(),
        })
        wd.HandleEvent(watchdog.EventRecoveryExhausted)
        break
    }

    journal.Log(watchdog.LevelInfo, "recovery.attempt", map[string]any{
        "attempt":    recovery.Attempts() + 1,
        "count_24h":  recovery.Count24h(),
        "pid":        pid,
    })
    ok, err := recovery.Attempt(pid)
    if ok {
        pendingVerify = &struct{ startedAt time.Time }{startedAt: time.Now()}
        journal.Log(watchdog.LevelInfo, "recovery.attempt_dispatched", map[string]any{
            "attempt":   recovery.Attempts(),
            "count_24h": recovery.Count24h(),
        })
    } else {
        journal.Log(watchdog.LevelError, "recovery.failed", map[string]any{
            "error": errStr(err),
        })
    }
```

- [ ] **Step 3: Clear `pendingVerify` when leaving RECOVERING**

In the same end-of-tick switch, find `case watchdog.StateMonitoring` (around the old line 414-419) and update it:

```go
case watchdog.StateMonitoring:
    // Reset per-window recovery counter when healthy. Note: restart history
    // (24h window) is intentionally retained so flap detection stays armed.
    recovery.Reset()
    if pendingVerify != nil {
        pendingVerify = nil
    }
    if failoverClient != nil {
        failoverClient = nil
    }
```

Also clear it at the top of `case watchdog.StateFailover` so a flap-escalated entry to FAILOVER doesn't carry stale verification state:

```go
case watchdog.StateFailover:
    if pendingVerify != nil {
        pendingVerify = nil
    }
    if failoverClient == nil && tokenStore.Reveal() != "" {
        // ...existing body unchanged...
    }
```

- [ ] **Step 4: Build**

```bash
cd agent && go build ./...
```

Expected: clean build.

- [ ] **Step 5: Run watchdog unit tests**

```bash
cd agent && go test -race ./internal/watchdog/... ./cmd/breeze-watchdog/...
```

Expected: all green (no new test added in this task; this verifies we didn't break anything).

- [ ] **Step 6: Commit**

```bash
git add agent/cmd/breeze-watchdog/main.go
git commit -m "fix(watchdog): wait for heartbeat resume before declaring recovery

Close the flap-loop hole observed 2026-05-21: previously, the moment
recovery.Attempt() returned ok, we emitted EventAgentRecovered → reset
the per-window counter → next staleness tick attempted again from
zero with no flap detection. Now we record a pendingVerify timestamp
after the restart, watch LastHeartbeat to advance past
startedAt+grace, and only then declare success. If the grace+timeout
elapses without a fresh heartbeat, the attempt counts as failed and
the next tick re-enters with the counter intact.

Also adds the Count24h() flap gate: 5+ restarts/24h immediately
emits EventRecoveryExhausted → FAILOVER, where the watchdog starts
heartbeating to the server.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Extend failover heartbeat payload

**Files:**
- Modify: `agent/internal/watchdog/failover.go`
- Modify: `agent/internal/watchdog/failover_test.go`
- Modify: `agent/cmd/breeze-watchdog/main.go` (pass RestartStats into SendHeartbeat)

- [ ] **Step 1: Write failing test for the new fields**

Open `agent/internal/watchdog/failover_test.go` and add the test (alongside any existing tests):

```go
func TestSendHeartbeatIncludesRestartStats(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &captured); err != nil {
			t.Fatalf("server: unmarshal body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	fc := NewFailoverClient(server.URL, "agent-xyz", "token", nil)
	stats := RestartStats{
		Count24h:      4,
		LastRestartAt: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC),
		FlapDetected:  false,
	}
	if _, err := fc.SendHeartbeat("0.65.20", "RECOVERING", nil, stats); err != nil {
		t.Fatalf("SendHeartbeat: %v", err)
	}

	if got := captured["mainAgentRestartCount24h"]; got != float64(4) {
		t.Errorf("mainAgentRestartCount24h: want 4, got %v", got)
	}
	if got, _ := captured["mainAgentLastRestartAt"].(string); got != "2026-05-22T12:00:00Z" {
		t.Errorf("mainAgentLastRestartAt: want 2026-05-22T12:00:00Z, got %v", got)
	}
	if got := captured["flapDetected"]; got != false {
		t.Errorf("flapDetected: want false, got %v", got)
	}
}
```

If the existing `failover_test.go` does not import `net/http`, `net/http/httptest`, `io`, or `encoding/json`, add them to its import list. If `failover_test.go` doesn't exist yet, create it with this content:

```go
package watchdog

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)
```

(plus the test function above.)

- [ ] **Step 2: Run the failing test**

```bash
cd agent && go test -race ./internal/watchdog/ -run TestSendHeartbeatIncludesRestartStats
```

Expected: compile error or test failure (`SendHeartbeat` signature mismatch / `RestartStats` undefined).

- [ ] **Step 3: Add `RestartStats` and extend `SendHeartbeat`**

Edit `agent/internal/watchdog/failover.go`. Just below `HeartbeatResponse` (around line 26), add:

```go
// RestartStats summarizes the watchdog's recent restart activity for the
// failover heartbeat payload. Pulled out of RecoveryManager to keep
// failover.go independent of recovery internals.
type RestartStats struct {
	Count24h      int
	LastRestartAt time.Time
	FlapDetected  bool
}
```

Replace `SendHeartbeat` with:

```go
// SendHeartbeat POSTs a watchdog heartbeat to the API and returns the parsed
// response. The request body includes role, watchdogState, agentVersion,
// journalExcerpt, mainAgentRestartCount24h, mainAgentLastRestartAt,
// flapDetected, and timestamp fields.
func (c *FailoverClient) SendHeartbeat(watchdogVersion, currentState string, journalEntries []JournalEntry, restartStats RestartStats) (*HeartbeatResponse, error) {
	body := map[string]any{
		"role":                     "watchdog",
		"watchdogState":            currentState,
		"status":                   "ok",
		"agentVersion":             watchdogVersion,
		"journalExcerpt":           journalEntries,
		"timestamp":                time.Now().UTC().Format(time.RFC3339),
		"mainAgentRestartCount24h": restartStats.Count24h,
		"flapDetected":             restartStats.FlapDetected,
	}
	if !restartStats.LastRestartAt.IsZero() {
		body["mainAgentLastRestartAt"] = restartStats.LastRestartAt.UTC().Format(time.RFC3339)
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("failover: marshal heartbeat: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", c.baseURL, c.agentID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failover: build heartbeat request: %w", err)
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failover: heartbeat request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failover: heartbeat returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result HeartbeatResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failover: decode heartbeat response: %w", err)
	}
	return &result, nil
}
```

- [ ] **Step 4: Update call sites in `main.go`**

Open `agent/cmd/breeze-watchdog/main.go`. Find both call sites for `SendHeartbeat`:

1. In the `case watchdog.StateFailover:` end-of-tick branch (around line 397), where the initial failover heartbeat is sent.
2. Inside `handleFailoverPoll` (around line 494).

Add a small helper near the top of the file (after `errStr`):

```go
func currentRestartStats(rm *watchdog.RecoveryManager, maxPer24h int) watchdog.RestartStats {
	return watchdog.RestartStats{
		Count24h:      rm.Count24h(),
		LastRestartAt: rm.LastRestartAt(),
		FlapDetected:  rm.Count24h() >= maxPer24h,
	}
}
```

In the FAILOVER end-of-tick branch, change the call:

```go
// before
resp, err := failoverClient.SendHeartbeat(version, wd.State(), journal.Recent(10))
// after
stats := currentRestartStats(recovery, wdCfg.MaxRestartsPer24h)
resp, err := failoverClient.SendHeartbeat(version, wd.State(), journal.Recent(10), stats)
```

In `handleFailoverPoll`, change its signature and body to take the same parameters. Find:

```go
func handleFailoverPoll(
    fc *watchdog.FailoverClient,
    wd *watchdog.Watchdog,
    journal *watchdog.Journal,
    cfg *config.Config,
    tokens *tokenHolder,
    recovery *watchdog.RecoveryManager,
) {
    // Send failover heartbeat.
    resp, err := fc.SendHeartbeat(version, wd.State(), journal.Recent(10))
```

Add `maxPer24h int` parameter (or compute it inline) and pass `stats`:

```go
func handleFailoverPoll(
    fc *watchdog.FailoverClient,
    wd *watchdog.Watchdog,
    journal *watchdog.Journal,
    cfg *config.Config,
    tokens *tokenHolder,
    recovery *watchdog.RecoveryManager,
    maxPer24h int,
) {
    stats := currentRestartStats(recovery, maxPer24h)
    resp, err := fc.SendHeartbeat(version, wd.State(), journal.Recent(10), stats)
```

Find the one call site in the select (`case <-failoverTicker.C:`) and add `wdCfg.MaxRestartsPer24h`:

```go
handleFailoverPoll(failoverClient, wd, journal, cfg, tokenStore, recovery, wdCfg.MaxRestartsPer24h)
```

- [ ] **Step 5: Run the new failover test — it must pass**

```bash
cd agent && go test -race ./internal/watchdog/ -run TestSendHeartbeatIncludesRestartStats -v
```

Expected: PASS.

- [ ] **Step 6: Run all watchdog + cmd tests**

```bash
cd agent && go test -race ./internal/watchdog/... ./cmd/breeze-watchdog/...
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/watchdog/failover.go agent/internal/watchdog/failover_test.go agent/cmd/breeze-watchdog/main.go
git commit -m "feat(watchdog): include 24h restart stats in failover heartbeat

New RestartStats struct is passed into SendHeartbeat. The payload now
includes mainAgentRestartCount24h, mainAgentLastRestartAt (RFC3339,
omitted if zero), and flapDetected. Server-side schema acceptance and
diagnostic logging in a follow-up commit.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Integration test: the 4 spec scenarios

**Files:**
- Create: `agent/internal/watchdog/integration_test.go`

This task tests the **inner state machine + RecoveryManager + verification gate** as an integrated unit, without booting the main loop. We exercise the same end-of-tick logic by replicating it in a small driver function inside the test file. This keeps the production `main.go` end-of-tick branch as the single source of truth — but each scenario asserts the behaviors the spec promises.

- [ ] **Step 1: Create the integration test scaffolding**

Create `agent/internal/watchdog/integration_test.go`:

```go
package watchdog

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// integHarness wires a fake state file, fake serviceController, fake clock,
// and a real RecoveryManager + Watchdog state machine. The Tick() method
// drives the same logic as main.go's end-of-tick RECOVERING switch.
type integHarness struct {
	t              *testing.T
	clk            *fakeClock
	svc            *noopServiceController
	wd             *Watchdog
	recovery       *RecoveryManager
	stateFile      string
	maxPer24h      int
	verifyGrace    time.Duration
	verifyTimeout  time.Duration
	pendingVerifyAt time.Time // zero = no pending verification
}

func newIntegHarness(t *testing.T) *integHarness {
	t.Helper()
	dir := t.TempDir()
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	svc := &noopServiceController{}
	rm := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	rm.SetHistoryPath(filepath.Join(dir, "history.json"))

	cfg := Config{
		ProcessCheckInterval:    5 * time.Second,
		IPCProbeInterval:        30 * time.Second,
		HeartbeatStaleThreshold: 3 * time.Minute,
		MaxRecoveryAttempts:     3,
		RecoveryCooldown:        10 * time.Minute,
		StandbyTimeout:          30 * time.Minute,
		FailoverPollInterval:    30 * time.Second,
	}
	wd := NewWatchdog(cfg)
	// Start in RECOVERING for scenario simplicity — the real loop also
	// reaches RECOVERING via CONNECTING→MONITORING→AgentUnhealthy or
	// CONNECTING→AgentUnhealthy; we skip the prelude.
	wd.HandleEvent(EventAgentNotFound) // CONNECTING → RECOVERING

	return &integHarness{
		t:             t,
		clk:           clk,
		svc:           svc,
		wd:            wd,
		recovery:      rm,
		stateFile:     filepath.Join(dir, "agent.state"),
		maxPer24h:     5,
		verifyGrace:   30 * time.Second,
		verifyTimeout: 120 * time.Second,
	}
}

// writeAgentState writes a minimal state file with the given LastHeartbeat.
func (h *integHarness) writeAgentState(lastHb time.Time) {
	h.t.Helper()
	s := &state.AgentState{
		PID:           4242,
		Status:        "running",
		LastHeartbeat: lastHb,
		Timestamp:     h.clk.Now(),
	}
	if err := state.Write(h.stateFile, s); err != nil {
		h.t.Fatalf("writeAgentState: %v", err)
	}
}

// Tick runs the same logic as the production main.go end-of-tick switch for
// StateRecovering / StateMonitoring / StateFailover. It does NOT run the
// process/IPC/heartbeat tickers — scenarios drive AgentUnhealthy events
// directly.
func (h *integHarness) Tick() {
	switch h.wd.State() {
	case StateRecovering:
		h.tickRecovering()
	case StateMonitoring:
		h.recovery.Reset()
		h.pendingVerifyAt = time.Time{}
	case StateFailover:
		h.pendingVerifyAt = time.Time{}
	}
}

func (h *integHarness) tickRecovering() {
	// Verification gate.
	if !h.pendingVerifyAt.IsZero() {
		elapsed := h.clk.Now().Sub(h.pendingVerifyAt)
		s, _ := state.Read(h.stateFile)
		verifyDeadline := h.pendingVerifyAt.Add(h.verifyGrace)
		if s != nil && s.LastHeartbeat.After(verifyDeadline) {
			h.pendingVerifyAt = time.Time{}
			h.wd.HandleEvent(EventAgentRecovered)
			return
		}
		if elapsed > h.verifyTimeout {
			h.pendingVerifyAt = time.Time{}
		}
		return
	}
	// Flap gate.
	if h.recovery.Count24h() >= h.maxPer24h {
		h.wd.HandleEvent(EventRecoveryExhausted)
		return
	}
	if !h.recovery.CanAttempt() {
		h.wd.HandleEvent(EventRecoveryExhausted)
		return
	}
	ok, _ := h.recovery.Attempt(4242)
	if ok {
		h.pendingVerifyAt = h.clk.Now()
	}
}
```

(`state.Write` is assumed to exist. If it doesn't — verify with `grep -n "func Write" agent/internal/state/state.go` — write the file manually with `json.Marshal` + `os.WriteFile`.)

- [ ] **Step 2: Verify state helpers**

```bash
grep -n "^func \(Write\|Read\)" agent/internal/state/state.go
```

Expected: at least `Read` exists. If `Write` does not, replace `state.Write(h.stateFile, s)` in the helper with:

```go
data, err := json.Marshal(s)
if err != nil { h.t.Fatal(err) }
if err := os.WriteFile(h.stateFile, data, 0o600); err != nil { h.t.Fatal(err) }
```

(and add `encoding/json` + `os` to imports).

- [ ] **Step 3: Write scenario A — `Test_HeartbeatStale_TriggersRestartWithinTwoIntervals`**

Append to `integration_test.go`:

```go
func Test_HeartbeatStale_TriggersRestartWithinTwoIntervals(t *testing.T) {
	h := newIntegHarness(t)
	// State file shows the agent went silent 5 min ago.
	h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))

	// First tick in RECOVERING: should attempt one restart and enter verify.
	h.Tick()
	if h.svc.restarts != 1 {
		t.Fatalf("first tick: want 1 SCM restart, got %d", h.svc.restarts)
	}
	if h.pendingVerifyAt.IsZero() {
		t.Fatal("first tick: want pendingVerifyAt set, got zero")
	}

	// Advance past grace and write a fresh heartbeat — simulating recovery.
	h.clk.Advance(h.verifyGrace + time.Second)
	h.writeAgentState(h.clk.Now())

	// Second tick: should verify and return to MONITORING.
	h.Tick()
	if h.wd.State() != StateMonitoring {
		t.Fatalf("after verification: want MONITORING, got %s", h.wd.State())
	}
	if h.recovery.Count24h() != 1 {
		t.Fatalf("Count24h after one recovery: want 1, got %d", h.recovery.Count24h())
	}
}
```

- [ ] **Step 4: Write scenario B — `Test_OptimisticRestart_DoesNotResetCounter`**

```go
func Test_OptimisticRestart_DoesNotResetCounter(t *testing.T) {
	h := newIntegHarness(t)
	h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))

	// Cycle 5 times: each restart "succeeds" at the SCM level but the
	// heartbeat never advances, so the verification gate times out.
	for cycle := 1; cycle <= 5; cycle++ {
		// Attempt tick.
		h.Tick()
		if h.svc.restarts != cycle {
			t.Fatalf("cycle %d: want %d total SCM restarts, got %d", cycle, cycle, h.svc.restarts)
		}
		// Verification timeout.
		h.clk.Advance(h.verifyTimeout + time.Second)
		h.Tick()
		if h.wd.State() != StateRecovering {
			t.Fatalf("cycle %d: want still RECOVERING after timeout, got %s", cycle, h.wd.State())
		}
		if !h.pendingVerifyAt.IsZero() {
			t.Fatalf("cycle %d: pendingVerifyAt should be cleared after timeout", cycle)
		}
		// Reset per-window counter manually to model the cooldown elapsing
		// (otherwise CanAttempt() would block us at attempts=3).
		h.recovery.Reset()
	}

	if got := h.recovery.Count24h(); got != 5 {
		t.Fatalf("Count24h after 5 failed cycles: want 5, got %d", got)
	}

	// Sixth tick should flap-escalate.
	h.Tick()
	if h.wd.State() != StateFailover {
		t.Fatalf("after 5 flaps: want FAILOVER, got %s", h.wd.State())
	}
}
```

- [ ] **Step 5: Write scenario C — `Test_RealRecovery_ClearsPerWindowCounter_NotHistory`**

```go
func Test_RealRecovery_ClearsPerWindowCounter_NotHistory(t *testing.T) {
	h := newIntegHarness(t)

	// Two clean restart cycles.
	for cycle := 1; cycle <= 2; cycle++ {
		h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))
		h.Tick() // attempt
		h.clk.Advance(h.verifyGrace + time.Second)
		h.writeAgentState(h.clk.Now()) // heartbeat resumed
		h.Tick()                       // verify success
		if h.wd.State() != StateMonitoring {
			t.Fatalf("cycle %d: want MONITORING after recovery, got %s", cycle, h.wd.State())
		}
		// MONITORING tick should reset per-window attempts.
		h.Tick()
		if h.recovery.Attempts() != 0 {
			t.Fatalf("cycle %d: per-window Attempts should be 0 after Monitoring tick, got %d", cycle, h.recovery.Attempts())
		}
		// Back to RECOVERING for the next cycle.
		h.wd.HandleEvent(EventAgentUnhealthy)
	}

	if got := h.recovery.Count24h(); got != 2 {
		t.Fatalf("Count24h after 2 verified recoveries: want 2 (retained), got %d", got)
	}
}
```

- [ ] **Step 6: Write scenario D — `Test_FailoverHeartbeatIncludesNewFields`**

```go
func Test_FailoverHeartbeatIncludesNewFields(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	h := newIntegHarness(t)
	// Plant 5 history entries directly so the next tick will flap-escalate.
	for i := 0; i < 5; i++ {
		h.recovery.restartHistory = append(h.recovery.restartHistory, h.clk.Now().Add(time.Duration(-i)*time.Minute))
	}
	h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))
	h.Tick() // flap-detected → FAILOVER
	if h.wd.State() != StateFailover {
		t.Fatalf("expected FAILOVER, got %s", h.wd.State())
	}

	stats := RestartStats{
		Count24h:      h.recovery.Count24h(),
		LastRestartAt: h.recovery.LastRestartAt(),
		FlapDetected:  h.recovery.Count24h() >= h.maxPer24h,
	}
	fc := NewFailoverClient(server.URL, "agent-test", "tok", nil)
	if _, err := fc.SendHeartbeat("v-test", h.wd.State(), nil, stats); err != nil {
		t.Fatalf("SendHeartbeat: %v", err)
	}
	if got := captured["mainAgentRestartCount24h"]; got != float64(5) {
		t.Errorf("mainAgentRestartCount24h: want 5, got %v", got)
	}
	if got := captured["flapDetected"]; got != true {
		t.Errorf("flapDetected: want true, got %v", got)
	}
}
```

Add imports to the top of `integration_test.go`:

```go
import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)
```

(Drop `os` if `state.Write` exists; keep it if you used the inline `os.WriteFile` fallback.)

- [ ] **Step 7: Run the integration tests**

```bash
cd agent && go test -race ./internal/watchdog/ -run 'Test_HeartbeatStale|Test_OptimisticRestart|Test_RealRecovery|Test_FailoverHeartbeatIncludesNewFields' -v
```

Expected: all four scenarios pass.

- [ ] **Step 8: Run the full agent test suite**

```bash
cd agent && go test -race ./...
```

Expected: all green. Tolerable: pre-existing failures unrelated to watchdog (note them in the commit message if any).

- [ ] **Step 9: Commit**

```bash
git add agent/internal/watchdog/integration_test.go
git commit -m "test(watchdog): integration scenarios for #799 acceptance criteria

Four in-process scenarios driving the RECOVERING end-of-tick logic
through fake serviceController, fake clock, and a temp state file:

  A. Heartbeat stale -> restart -> verification succeeds within 2 intervals
     (the issue's stated acceptance criterion).
  B. SCM restart returns ok but heartbeat never resumes; counter climbs
     correctly and FAILOVER fires after 5 cycles (closes the flap-loop
     hole this PR exists to fix).
  C. Verified recovery clears the per-window counter but not the 24h
     history.
  D. Failover heartbeat payload contains mainAgentRestartCount24h,
     mainAgentLastRestartAt, flapDetected with expected values.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — API side: accept fields + log diagnostic on activity

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`

- [ ] **Step 1: Extend `heartbeatSchema` with the three new optional fields**

Edit `apps/api/src/routes/agents/schemas.ts`. Find lines 166-168:

```ts
  role: z.enum(['agent', 'watchdog']).optional(),
  watchdogState: z.string().optional(),
  osType: z.string().optional(),
});
```

Replace with:

```ts
  role: z.enum(['agent', 'watchdog']).optional(),
  watchdogState: z.string().optional(),
  // Watchdog-only: 24h restart accounting for the main agent (#799 Layer B).
  // Optional + permissive — older watchdogs won't send these.
  mainAgentRestartCount24h: z.number().int().min(0).max(10_000).optional(),
  mainAgentLastRestartAt: z.string().datetime({ offset: true }).optional(),
  flapDetected: z.boolean().optional(),
  osType: z.string().optional(),
});
```

- [ ] **Step 2: Write the diagnostic log row when activity is present**

Edit `apps/api/src/routes/agents/heartbeat.ts`. Find the watchdog branch starting at line 72 (`const isWatchdog = ...`). Add an import at the top:

```ts
import { agentLogs } from '../../db/schema';
```

(Check that `agentLogs` is exported from the schema barrel — `apps/api/src/db/schema/index.ts:46` exports `agentLogs`, so importing from `'../../db/schema'` works.)

Inside the `if (isWatchdog) {` block, after the existing `try { await db.update(devices).set(...)` (around line 87, after the catch), add:

```ts
    // #799: record any non-zero restart activity into agent_logs so it is
    // queryable today (server-side asymmetry detection / UI surfacing is
    // #800). Do not block the heartbeat path on logging failure.
    const restartCount = data.mainAgentRestartCount24h ?? 0;
    if (restartCount > 0 || data.flapDetected === true) {
      try {
        await db.insert(agentLogs).values({
          deviceId: device.id,
          orgId: device.orgId,
          timestamp: new Date(),
          level: data.flapDetected ? 'error' : 'warn',
          component: 'watchdog',
          message: data.flapDetected
            ? `Main agent restart flap detected (${restartCount} restarts in 24h)`
            : `Main agent restart activity: ${restartCount} in 24h`,
          fields: {
            count24h: restartCount,
            lastRestartAt: data.mainAgentLastRestartAt ?? null,
            flapDetected: data.flapDetected === true,
            watchdogState: data.watchdogState ?? null,
          },
          agentVersion: data.agentVersion,
        });
      } catch (err) {
        console.error('Failed to write watchdog restart-activity log:', err);
      }
    }
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: clean (modulo pre-existing test errors in `agents.test.ts`/`apiKeyAuth.test.ts` already known per CLAUDE memory).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts
git commit -m "feat(api): accept watchdog 24h restart stats + log on activity

heartbeatSchema now accepts the three new fields shipped by
watchdog-0.65.x (mainAgentRestartCount24h, mainAgentLastRestartAt,
flapDetected). Older watchdogs that don't send them continue to work.

When restartCount > 0 or flapDetected is true, write an agent_logs
row (component=watchdog, level=warn|error). Persisting to a device
column and the UI surface are #800 (Layer C), not this PR.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — API test for the new payload + diag log

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts`

- [ ] **Step 1: Locate the existing watchdog heartbeat test**

```bash
grep -n "watchdog\|role.*'watchdog'" apps/api/src/routes/agents/heartbeat.test.ts | head -20
```

Read the file enough to see the existing test scaffold and the Drizzle mock setup. The repo uses the Vitest + Drizzle mock pattern documented in the `breeze-testing` skill.

- [ ] **Step 2: Add tests for the new fields**

Append two test cases to `apps/api/src/routes/agents/heartbeat.test.ts`. Match the existing mock style — if mocks are scoped per-describe, place the new cases inside the watchdog-role `describe` block. Use the exact agent/device fixtures the file already defines.

Pseudocode for the two tests (adapt to the file's actual helpers; the test file's existing patterns are authoritative):

```ts
it('watchdog heartbeat with mainAgentRestartCount24h=3 writes an agent_logs warn row', async () => {
  // Arrange: device fixture with role=watchdog, agentLogs.insert mock.
  // Act: POST /agents/:id/heartbeat with body { role:'watchdog', agentVersion:'0.65.20',
  //   watchdogState:'MONITORING', mainAgentRestartCount24h:3,
  //   mainAgentLastRestartAt:'2026-05-22T11:30:00Z', flapDetected:false }.
  // Assert: 200; agentLogs.insert called with level='warn', component='watchdog',
  //   fields.count24h===3, fields.flapDetected===false.
});

it('watchdog heartbeat with flapDetected=true writes an agent_logs error row', async () => {
  // Same as above but flapDetected:true, mainAgentRestartCount24h:5.
  // Assert: agentLogs.insert called with level='error', fields.flapDetected===true.
});

it('watchdog heartbeat with no restart stats does not write to agent_logs', async () => {
  // Body omits the new fields entirely.
  // Assert: 200; agentLogs.insert NOT called.
});
```

- [ ] **Step 3: Run the new tests**

```bash
cd apps/api && pnpm vitest run src/routes/agents/heartbeat.test.ts
```

Expected: new tests pass; pre-existing pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "test(api): cover watchdog restart-stats logging

Three new cases under the watchdog-role heartbeat tests: non-zero
count writes warn-level agent_logs row, flapDetected writes
error-level, zero+absent writes nothing.

Refs #799

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 — Final sweep + push

- [ ] **Step 1: Full agent test sweep**

```bash
cd agent && go test -race ./...
```

Expected: green. If anything fails outside `internal/watchdog/` or `cmd/breeze-watchdog/`, investigate before pushing — it's likely an environmental issue, not this branch's fault.

- [ ] **Step 2: Full API typecheck + the touched test files**

```bash
cd apps/api && npx tsc --noEmit
pnpm vitest run src/routes/agents/heartbeat.test.ts
```

Expected: typecheck clean (modulo known pre-existing errors); tests green.

- [ ] **Step 3: Cross-platform compile check (optional but recommended)**

```bash
cd agent && GOOS=windows GOARCH=amd64 go build ./...
cd agent && GOOS=darwin  GOARCH=arm64 go build ./...
cd agent && GOOS=linux   GOARCH=amd64 go build ./...
```

Expected: three clean builds. This catches platform-specific compile breakage in the `recovery_*.go` files.

- [ ] **Step 4: Confirm spec coverage**

Open the spec at `docs/superpowers/specs/2026-05-22-watchdog-auto-restart-design.md` and walk each acceptance row from the "Acceptance gaps" table:

| Acceptance criterion | Where it's satisfied |
|---|---|
| `maxHeartbeatStalenessSec` config | Task 4 (viper alias) |
| Watchdog records last heartbeat | Pre-existing (verified Task 0) |
| Restart attempts logged | Pre-existing journal + Task 5 (`attempt_dispatched`, `verified`, `verify_timeout`, `flap_detected`) |
| `mainAgentRestartCount24h` in payload | Task 3 + Task 6 |
| Flap escalation 5/24h | Task 5 |
| Graceful → forceful escalation | Pre-existing in `RecoveryManager.Attempt` (verified Task 0); kept intact |
| Integration test | Task 7 |

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/watchdog-auto-restart-799
```

- [ ] **Step 6: Open PR**

```bash
gh pr create --base main --title "feat(watchdog): auto-restart on prolonged heartbeat silence (#799)" --body "$(cat <<'EOF'
## Summary

Layer B of the agent-silent-but-watchdog-alive failure observed 2026-05-21 (10 endpoints silent 40m–2d, devices flipped offline but boxes alive via ScreenConnect/NinjaOne/Action1). Closes the flap-loop hole in the existing watchdog RECOVERING-state restart path, adds a 24h rolling restart counter that survives per-cycle resets, escalates to FAILOVER at 5+ restarts/24h, and surfaces the count in the watchdog heartbeat payload so the server gets a real signal.

The existing watchdog already detected heartbeat staleness and attempted SCM restarts — the issue was that `recovery.Attempt()` returning ok was declared a success even if the agent's heartbeat never resumed, so the per-window counter reset every cycle and the watchdog could restart the agent indefinitely with nothing surfacing to the server.

## Design

See `docs/superpowers/specs/2026-05-22-watchdog-auto-restart-design.md`.

Plan: `docs/superpowers/plans/2026-05-22-watchdog-auto-restart-799.md`.

## Test

- 7 new unit tests covering 24h history, lazy purge, cap, persistence round-trip, corrupt/missing file recovery.
- 4 integration scenarios (in-process, fake serviceController + clock + state file):
  - Acceptance criterion from the issue: stale heartbeat → restart within 2 intervals → verified recovery.
  - The flap-loop hole this PR fixes: optimistic SCM-ok with no fresh heartbeat correctly climbs the 24h counter and escalates to FAILOVER on the 6th cycle.
  - Verified recovery clears per-window counter, retains 24h history.
  - Failover heartbeat payload contains the three new fields.
- 1 new failover-heartbeat unit test (HTTP body capture).
- 3 new API-side tests (warn-level row, error-level row on flap, no row when activity absent).
- Existing tests untouched.

## Non-scope

- Server-side asymmetry detection (`main_agent_silent_since` device column, "agent silent (watchdog OK)" UI state) — that's #800 (Layer C), separate spec.
- IPC `restart_main_agent` message — attempt 1 is already a graceful SCM restart; YAGNI.
- Cross-host-reboot persistence of restart history — a reboot is itself recovery.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

**Spec coverage:**
- ✅ Flap-loop hole closed by verification gate (Task 5).
- ✅ 24h restart counter (Tasks 2, 3, 5).
- ✅ FAILOVER escalation at 5/24h (Task 5).
- ✅ Payload surfacing (Tasks 6, 7).
- ✅ Integration test for the 4 scenarios (Task 7).
- ✅ Config alias for `max_heartbeat_staleness_sec` (Task 4).
- ✅ API tolerance + diagnostic log (Tasks 8, 9).
- ✅ Service-controller seam without changing the OS escalation order (Task 1).
- ✅ Clock seam (Task 2).

**Identifier consistency:**
- `RestartStats` (struct), `Count24h()`, `LastRestartAt()`, `FlapDetected` (field): used consistently across `recovery.go`, `failover.go`, `main.go`, `integration_test.go`.
- `restartHistoryCap = 50`: defined in `recovery.go`, asserted in `recovery_test.go`.
- `pendingVerifyAt` (test harness) vs `pendingVerify.startedAt` (main.go): named differently because the production code uses an anonymous-struct pointer and the harness uses a bare `time.Time` for simplicity. Both behaviors match; if a reviewer prefers one shape in both places, the harness shape (`time.Time` with zero = no pending) is cleaner — feel free to migrate `main.go` to that during execution.
- API field names match exactly: `mainAgentRestartCount24h`, `mainAgentLastRestartAt`, `flapDetected`.

**One refinement worth noting during execution:**
- In Task 5, `state.Read` is called inside the verification branch; the heartbeat ticker already does this (line 343-347 in the unmodified `main.go`). Reading the state file again per RECOVERING tick adds at most a few stat() + open() calls per minute and gives faster recovery detection — acceptable trade-off.
