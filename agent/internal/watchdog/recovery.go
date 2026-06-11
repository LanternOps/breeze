package watchdog

import (
	"encoding/json"
	"log/slog"
	"os"
	"sort"
	"syscall"
	"time"
)

const restartHistoryCap = 50

// Clock abstracts time for deterministic tests. Production uses realClock.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

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
// Not goroutine-safe: the watchdog main loop owns the manager and calls all
// methods serially. If future callers want background access (e.g. a
// heartbeat goroutine reading Count24h while Attempt runs), guard with a
// mutex.
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

// NewRecoveryManager creates a RecoveryManager with the given limits and the
// real OS service controller.
func NewRecoveryManager(maxAttempts int, cooldown time.Duration) *RecoveryManager {
	return newRecoveryManagerWithDeps(maxAttempts, cooldown, osServiceController{}, realClock{})
}

// newRecoveryManagerWithDeps is the test seam — callers can inject a fake
// serviceController. Not exported.
func newRecoveryManagerWithDeps(maxAttempts int, cooldown time.Duration, svc serviceController, clk Clock) *RecoveryManager {
	return &RecoveryManager{
		maxAttempts: maxAttempts,
		cooldown:    cooldown,
		windowStart: clk.Now(),
		svc:         svc,
		clk:         clk,
	}
}

// CanAttempt returns true if another recovery attempt is allowed. If the
// cooldown window has passed since windowStart, the counter is reset first.
func (r *RecoveryManager) CanAttempt() bool {
	now := r.clk.Now()
	if now.Sub(r.windowStart) >= r.cooldown {
		r.attempts = 0
		r.windowStart = now
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

// Attempts returns the current attempt count within the active window.
func (r *RecoveryManager) Attempts() int { return r.attempts }

// Reset clears the attempt counter and resets the window start time.
func (r *RecoveryManager) Reset() {
	r.attempts = 0
	r.windowStart = r.clk.Now()
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
	// Defensive sort: purgeOldHistory uses binary search and assumes the
	// slice is ascending. A torn write or future-version layout could
	// produce out-of-order entries; sorting on load is cheap.
	sort.Slice(f.Restarts, func(i, j int) bool {
		return f.Restarts[i].Before(f.Restarts[j])
	})
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
	// Atomic write: write to a sibling temp file then rename. Prevents a
	// torn file if the watchdog is killed mid-write — exactly the scenario
	// (rapid restart loop) where the 24h count matters most. os.Rename is
	// atomic on POSIX and on Windows via MoveFileEx.
	tmp := r.historyPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		slog.Warn("watchdog.restart_history.write_failed", "path", tmp, "error", err.Error())
		return
	}
	if err := os.Rename(tmp, r.historyPath); err != nil {
		slog.Warn("watchdog.restart_history.rename_failed", "path", r.historyPath, "error", err.Error())
		_ = os.Remove(tmp)
	}
}
