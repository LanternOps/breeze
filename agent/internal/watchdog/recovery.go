package watchdog

import (
	"context"
	"encoding/json"
	"fmt"
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

// RecoveryAction names the side effect a recovery attempt selected.
type RecoveryAction string

const (
	RecoveryActionObserve  RecoveryAction = "observe"
	RecoveryActionGraceful RecoveryAction = "graceful_restart"
	RecoveryActionForced   RecoveryAction = "forced_restart"
	RecoveryActionStart    RecoveryAction = "ensure_started"
)

// RecoveryIntent is what the caller asked for. Controllers must select their
// behavior from the intent — never infer it from the attempt count alone —
// so an operator "start_agent" command can never escalate to forced
// termination just because the escalation ladder happens to sit at attempt 2.
type RecoveryIntent string

const (
	RecoveryIntentUnhealthy   RecoveryIntent = "recover_unhealthy"
	RecoveryIntentEnsureStart RecoveryIntent = "ensure_started"
	RecoveryIntentRestart     RecoveryIntent = "restart"
)

// RecoveryDisposition tells the caller what to do next. It is deliberately
// explicit rather than a bool: the zero value normalizes to
// RecoveryDispositionNone, so an uninitialized or partially populated result
// can never be misread as "the agent recovered".
type RecoveryDisposition string

const (
	RecoveryDispositionNone            RecoveryDisposition = "none"
	RecoveryDispositionVerifyHeartbeat RecoveryDisposition = "verify_heartbeat"
	RecoveryDispositionFailover        RecoveryDisposition = "failover"
)

// RecoveryFailureClass categorizes a RecoveryError for journaling and for
// deciding whether a failure is retryable or terminal.
type RecoveryFailureClass string

const (
	RecoveryFailureQuery              RecoveryFailureClass = "query_failed"
	RecoveryFailureControl            RecoveryFailureClass = "control_failed"
	RecoveryFailureStopTimeout        RecoveryFailureClass = "stop_timeout"
	RecoveryFailureTransitionTimeout  RecoveryFailureClass = "transition_timeout"
	RecoveryFailureIdentityMismatch   RecoveryFailureClass = "identity_mismatch"
	RecoveryFailureProcessExitTimeout RecoveryFailureClass = "process_exit_timeout"
	RecoveryFailureStartTimeout       RecoveryFailureClass = "start_timeout"
	RecoveryFailureCanceled           RecoveryFailureClass = "canceled"
)

// RecoveryRequest is the input to a recovery attempt. StateFilePID is only a
// hint read from the agent's state file — a controller that takes destructive
// action must establish process identity from the service manager itself.
type RecoveryRequest struct {
	StateFilePID int
	Intent       RecoveryIntent
	Context      context.Context
}

// RecoveryResult is the structured outcome of a recovery attempt.
//
// ActionTaken means "a side effect was issued", not "it worked" — a failed
// control call still sets it so the attempt is charged against the escalation
// budget. Callers deciding whether the agent is coming back must look at
// Disposition (and a nil error), never at ActionTaken.
type RecoveryResult struct {
	Intent       RecoveryIntent
	Action       RecoveryAction
	Phase        string
	InitialState string
	FinalState   string
	StateFilePID int
	OldPID       int
	NewPID       int
	Elapsed      time.Duration
	ActionTaken  bool
	Disposition  RecoveryDisposition
}

// RecoveryError is the typed failure returned by a serviceController.
type RecoveryError struct {
	Class RecoveryFailureClass
	Phase string
	State string
	PID   int
	Err   error
}

func (e *RecoveryError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("recovery %s failed during %s", e.Class, e.Phase)
	}
	return fmt.Sprintf("recovery %s failed during %s: %v", e.Class, e.Phase, e.Err)
}

func (e *RecoveryError) Unwrap() error { return e.Err }

// serviceController is the OS-specific surface RecoveryManager.Attempt depends
// on. Production builds inject osServiceController (one impl per GOOS).
// Tests inject a fake. attempt is the 1-based number of the attempt about to
// be performed, used only to select the escalation rung for
// RecoveryIntentUnhealthy.
type serviceController interface {
	Recover(attempt int, req RecoveryRequest) (RecoveryResult, error)
}

// escalatingServiceRecover adapts the unix service helpers
// (restartAgentService / startAgentService / forceKillProcess) to the
// structured contract, preserving the historical escalation ladder:
//
//	Attempt 1: graceful restart via the service manager.
//	Attempt 2: force-kill the state-file PID then start via the service manager.
//	Attempt 3+: just start (the process may already be gone).
//
// RecoveryIntentEnsureStart and RecoveryIntentRestart pin a single behavior
// regardless of the attempt number.
func escalatingServiceRecover(attempt int, req RecoveryRequest) (RecoveryResult, error) {
	result := RecoveryResult{Intent: req.Intent, StateFilePID: req.StateFilePID}

	var err error
	switch {
	case req.Intent == RecoveryIntentEnsureStart:
		result.Action = RecoveryActionStart
		result.Phase = "start_service"
		result.ActionTaken = true
		err = startAgentService()
	case req.Intent == RecoveryIntentRestart, attempt <= 1:
		result.Action = RecoveryActionGraceful
		result.Phase = "restart_service"
		result.ActionTaken = true
		err = restartAgentService()
	case attempt == 2:
		result.Action = RecoveryActionForced
		result.Phase = "force_kill"
		result.ActionTaken = true
		forceKillProcess(req.StateFilePID)
		result.Phase = "start_service"
		err = startAgentService()
	default:
		result.Action = RecoveryActionStart
		result.Phase = "start_service"
		result.ActionTaken = true
		err = startAgentService()
	}

	if err != nil {
		return result, &RecoveryError{
			Class: RecoveryFailureControl,
			Phase: result.Phase,
			PID:   req.StateFilePID,
			Err:   err,
		}
	}
	// These service managers report only that the control call was accepted,
	// so success here means "restart dispatched" — the heartbeat check is
	// still what proves the agent actually came back.
	result.Disposition = RecoveryDispositionVerifyHeartbeat
	return result, nil
}

// RecoveryManager tracks escalating recovery attempts for an unhealthy agent.
// Not goroutine-safe: the watchdog main loop owns the manager and calls all
// methods serially. If future callers want background access (e.g. a
// heartbeat goroutine reading Count24h while Attempt runs), guard with a
// mutex.
type RecoveryManager struct {
	maxAttempts       int
	cooldown          time.Duration
	attempts          int
	lastAttempt       time.Time
	windowStart       time.Time
	svc               serviceController
	clk               Clock
	restartHistory    []time.Time
	historyPath       string
	terminalExhausted bool
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
//
// A terminal failure (identity/ownership uncertainty) is checked first and is
// never cleared by the passage of time: retrying a forced restart against a
// process we could not identify is exactly the action that could kill the
// wrong process. Only an explicit Reset clears it.
func (r *RecoveryManager) CanAttempt() bool {
	if r.terminalExhausted {
		return false
	}
	now := r.clk.Now()
	if now.Sub(r.windowStart) >= r.cooldown {
		r.attempts = 0
		r.windowStart = now
	}
	return r.attempts < r.maxAttempts
}

// Attempt dispatches one recovery attempt to the OS controller and accounts
// for it.
//
// Only an attempt that actually issued a side effect (result.ActionTaken)
// consumes an escalation slot and a 24h restart-history entry. A controller
// that merely observed an in-progress service transition costs nothing — it
// did not restart anything, so charging it would burn the recovery budget and
// trip the flap detector while the service manager was already recovering on
// its own.
//
// A RecoveryDispositionFailover result is terminal: recovery is exhausted
// immediately rather than retried.
func (r *RecoveryManager) Attempt(req RecoveryRequest) (RecoveryResult, error) {
	if req.Intent == "" {
		req.Intent = RecoveryIntentUnhealthy
	}
	if req.Context == nil {
		req.Context = context.Background()
	}

	nextAttempt := r.attempts + 1
	result, err := r.svc.Recover(nextAttempt, req)
	result.StateFilePID = req.StateFilePID
	result.Intent = req.Intent
	if result.Disposition == "" {
		result.Disposition = RecoveryDispositionNone
	}

	if result.ActionTaken {
		r.attempts++
		r.lastAttempt = r.clk.Now()
		r.recordRestart(r.lastAttempt)
	}
	if result.Disposition == RecoveryDispositionFailover {
		r.attempts = r.maxAttempts
		r.terminalExhausted = true
	}
	return result, err
}

// Attempts returns the current attempt count within the active window.
func (r *RecoveryManager) Attempts() int { return r.attempts }

// BestEffortEnsureStart dispatches an ensure-start to the OS controller
// WITHOUT consuming an escalation slot, a 24h history entry, or checking the
// budget. It exists for exactly one moment: recovery exhaustion. A failed
// graceful attempt may have already issued the SCM stop when the flap/budget
// gate aborts the ladder, and parking in FAILOVER must never leave the agent
// service stopped — FAILOVER ignores health events and its only restart
// channel requires a reachable server, so a stop at that boundary is
// permanent until a human intervenes (#2763, field-confirmed 2026-07-24).
// Best-effort by design: the caller journals the outcome and proceeds to
// FAILOVER regardless.
func (r *RecoveryManager) BestEffortEnsureStart(ctx context.Context) (RecoveryResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	req := RecoveryRequest{Intent: RecoveryIntentEnsureStart, Context: ctx}
	result, err := r.svc.Recover(r.attempts, req)
	result.Intent = req.Intent
	if result.Disposition == "" {
		result.Disposition = RecoveryDispositionNone
	}
	return result, err
}

// Reset clears the attempt counter, the terminal-failure latch, and resets the
// window start time.
func (r *RecoveryManager) Reset() {
	r.attempts = 0
	r.terminalExhausted = false
	r.windowStart = r.clk.Now()
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
