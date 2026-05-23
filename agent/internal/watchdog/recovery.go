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
