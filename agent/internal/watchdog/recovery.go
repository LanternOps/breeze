package watchdog

import (
	"os"
	"syscall"
	"time"
)

// RecoveryManager tracks escalating recovery attempts for an unhealthy agent.
type RecoveryManager struct {
	maxAttempts int
	cooldown    time.Duration
	attempts    int
	lastAttempt time.Time
	windowStart time.Time
}

// NewRecoveryManager creates a RecoveryManager with the given limits.
func NewRecoveryManager(maxAttempts int, cooldown time.Duration) *RecoveryManager {
	return &RecoveryManager{
		maxAttempts: maxAttempts,
		cooldown:    cooldown,
		windowStart: time.Now(),
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
//	Attempt 1: Graceful restart via service manager (restartAgentService).
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
		// Step 1: ask the service manager for a clean restart.
		err = restartAgentService()
	case 2:
		// Step 2: force-kill the stale process then let the service manager
		// start a fresh one.
		forceKillProcess(pid) // best-effort; ignore error
		err = startAgentService()
	default:
		// Step 3+: the process is likely already gone; just start.
		err = startAgentService()
	}

	if err != nil {
		return false, err
	}
	return true, nil
}

// Attempts returns the current attempt count within the active window.
func (r *RecoveryManager) Attempts() int {
	return r.attempts
}

// Reset clears the attempt counter and resets the window start time.
func (r *RecoveryManager) Reset() {
	r.attempts = 0
	r.windowStart = time.Now()
}

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
