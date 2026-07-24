package watchdog

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// This file is the OS-neutral Windows recovery state machine. It has no build
// tag on purpose: the transition ordering is the part most likely to be wrong
// and most expensive to get wrong (we can terminate a process on a customer
// machine), so it must be testable on any host. Everything that actually talks
// to the SCM or to a process handle lives behind windowsRecoveryBackend and is
// implemented in recovery_windows.go.

// serviceState is an OS-neutral mirror of the SCM service states.
type serviceState string

const (
	serviceStopped         serviceState = "stopped"
	serviceStartPending    serviceState = "start_pending"
	serviceStopPending     serviceState = "stop_pending"
	serviceRunning         serviceState = "running"
	serviceContinuePending serviceState = "continue_pending"
	servicePausePending    serviceState = "pause_pending"
	servicePaused          serviceState = "paused"
)

// serviceSnapshot is one SCM observation. PID is the service's process id as
// SCM reports it; 0 means SCM did not name one.
type serviceSnapshot struct {
	State serviceState
	PID   int
}

// isPendingState reports whether SCM is mid-transition. A pending state is
// never something we act on: SCM (or another controller) already owns the
// transition, and issuing a competing Stop/Start would race it.
func isPendingState(s serviceState) bool {
	switch s {
	case serviceStartPending, serviceStopPending, serviceContinuePending, servicePausePending:
		return true
	default:
		return false
	}
}

// watchedProcess is a handle to a specific process. Used by forced recovery to
// prove the PID SCM named is really our agent before terminating it.
type watchedProcess interface {
	ImagePath() (string, error)
	Alive() (bool, error)
	Terminate() error
	Wait(context.Context, time.Duration) error
	Close() error
}

// windowsRecoveryBackend is the side-effecting surface the state machine drives.
type windowsRecoveryBackend interface {
	Query() (serviceSnapshot, error)
	ConfiguredBinaryPath() (string, error)
	Stop() error
	Start() error
	OpenProcess(pid int) (watchedProcess, error)
}

// recoveryClock is Clock plus a cancellable sleep. Every wait in this file goes
// through it so tests run on virtual time and so an SCM stop can interrupt an
// in-flight transition wait instead of blocking for the full recovery deadline.
type recoveryClock interface {
	Now() time.Time
	Sleep(context.Context, time.Duration) error
}

type realRecoveryClock struct{}

func (realRecoveryClock) Now() time.Time { return time.Now() }

func (realRecoveryClock) Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

const (
	// windowsStopTimeout exceeds the agent's ~21s maximum serial shutdown
	// budget with margin, so a slow-but-healthy shutdown is not mistaken for a
	// hung one and escalated to termination.
	windowsStopTimeout = 35 * time.Second
	// windowsStartTimeout, windowsObserveTimeout and windowsProcessExitTimeout
	// share the same 35s recovery deadline.
	windowsStartTimeout       = 35 * time.Second
	windowsObserveTimeout     = 35 * time.Second
	windowsProcessExitTimeout = 35 * time.Second

	windowsRecoveryPollInterval = 500 * time.Millisecond

	// windowsControlAckGrace is how long after issuing a control SCM may keep
	// reporting the PRE-transition state before we treat it as a firm wrong
	// answer. A stopping agent needs ~100-200ms to acknowledge STOP_PENDING;
	// reading that window as "settled in an unexpected terminal state" made
	// every graceful restart fail in 0-1ms with an orphaned stop already in
	// flight (#2763 — the field's `transition_timeout failed during
	// wait_stopped, elapsed_ms:0` on every kill cycle).
	windowsControlAckGrace = 5 * time.Second
)

// errUnexpectedTerminalState means SCM settled in a definite state that is not
// the one we asked for. It is distinct from a timeout: we have a firm answer,
// it is just the wrong one, so there is nothing to wait for.
var errUnexpectedTerminalState = errors.New("service settled in an unexpected terminal state")

// errSettleQueryFailed distinguishes "SCM stopped answering while we waited"
// from "SCM answered but never settled". Both fail closed, but they are
// different diagnoses in the journal.
var errSettleQueryFailed = errors.New("scm query failed while waiting for the service to settle")

// windowsRecoveryController implements serviceController on top of a
// windowsRecoveryBackend.
type windowsRecoveryController struct {
	backend windowsRecoveryBackend
	clk     recoveryClock

	stopTimeout        time.Duration
	startTimeout       time.Duration
	observeTimeout     time.Duration
	processExitTimeout time.Duration
	pollInterval       time.Duration
	ackGrace           time.Duration
}

func newWindowsRecoveryController(backend windowsRecoveryBackend, clk recoveryClock) *windowsRecoveryController {
	return &windowsRecoveryController{
		backend:            backend,
		clk:                clk,
		stopTimeout:        windowsStopTimeout,
		startTimeout:       windowsStartTimeout,
		observeTimeout:     windowsObserveTimeout,
		processExitTimeout: windowsProcessExitTimeout,
		pollInterval:       windowsRecoveryPollInterval,
		ackGrace:           windowsControlAckGrace,
	}
}

// Recover selects a recovery branch and runs it.
//
// The branch comes from the intent first and only then from the attempt
// number: an operator "start_agent" must never escalate to forced termination
// just because the escalation ladder happens to sit at attempt 2.
func (c *windowsRecoveryController) Recover(attempt int, req RecoveryRequest) (result RecoveryResult, err error) {
	if req.Intent == "" {
		req.Intent = RecoveryIntentUnhealthy
	}
	if req.Context == nil {
		req.Context = context.Background()
	}

	startedAt := c.clk.Now()
	result = RecoveryResult{Intent: req.Intent, StateFilePID: req.StateFilePID}
	defer func() {
		result.Elapsed = c.clk.Now().Sub(startedAt)
		// RecoveryManager also normalizes this, but the controller must not
		// depend on a caller to make its result safe to read: an unset
		// disposition escaping from here is exactly the ambiguity that could be
		// misread as "recovered".
		if result.Disposition == "" {
			result.Disposition = RecoveryDispositionNone
		}
		// On failure the phase the error names is the last phase actually
		// reached, which is more precise than whatever the happy path last set.
		var recoveryErr *RecoveryError
		if err != nil && errors.As(err, &recoveryErr) && recoveryErr.Phase != "" {
			result.Phase = recoveryErr.Phase
		}
	}()

	switch {
	case req.Intent == RecoveryIntentEnsureStart:
		return c.ensureStartRecovery(result, req)
	case req.Intent == RecoveryIntentRestart, attempt <= 1:
		return c.gracefulRecovery(result, req)
	case attempt == 2:
		return c.forcedRecovery(result, req)
	default:
		// The process is most likely already gone by now; just make sure the
		// service is up.
		return c.ensureStartRecovery(result, req)
	}
}

// gracefulRecovery is the attempt-1 rung: ask SCM to stop the service, wait for
// a verified Stopped, then start it and verify a new live PID. It never
// terminates a process.
func (c *windowsRecoveryController) gracefulRecovery(result RecoveryResult, req RecoveryRequest) (RecoveryResult, error) {
	result.Action = RecoveryActionGraceful
	result.Phase = "query_scm"

	snapshot, err := c.backend.Query()
	if err != nil {
		return result, recoveryQueryError("query_scm", snapshot, err)
	}
	result.InitialState = string(snapshot.State)
	result.FinalState = string(snapshot.State)

	if isPendingState(snapshot.State) {
		// SCM already owns a transition. Watch it; do not compete with it.
		return c.observeTransition(result, req, snapshot)
	}
	if snapshot.State == serviceStopped {
		result.Action = RecoveryActionStart
		return c.ensureStarted(result, req, 0)
	}
	if snapshot.State != serviceRunning || snapshot.PID <= 0 {
		// Paused, or Running with no PID: we cannot say what we would be
		// restarting, so we stop here rather than guess.
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "validate_scm_owner",
			State: string(snapshot.State),
			PID:   snapshot.PID,
		}
	}
	result.OldPID = snapshot.PID

	out := c.control(result, req, controlStop, serviceStopped, c.stopTimeout, "stop_service", "wait_stopped", RecoveryFailureStopTimeout)
	if out.stop {
		return out.result, out.err
	}
	return c.ensureStarted(out.result, req, out.result.OldPID)
}

// ensureStartRecovery is the "make sure it is up" branch. It never stops or
// terminates anything.
func (c *windowsRecoveryController) ensureStartRecovery(result RecoveryResult, req RecoveryRequest) (RecoveryResult, error) {
	result.Action = RecoveryActionStart
	result.Phase = "query_scm"

	snapshot, err := c.backend.Query()
	if err != nil {
		return result, recoveryQueryError("query_scm", snapshot, err)
	}
	result.InitialState = string(snapshot.State)
	result.FinalState = string(snapshot.State)

	if isPendingState(snapshot.State) {
		observed, oerr := c.observeTransition(result, req, snapshot)
		if oerr != nil {
			return observed, oerr
		}
		if observed.FinalState == string(serviceStopped) {
			// The transition we watched settled to Stopped. The generic
			// observe path leaves Stopped alone so "the next attempt can
			// issue Start" — but the ensure-start intent has no next attempt
			// (it runs once, e.g. on the recovery-exhaustion path before
			// FAILOVER, #2763). The transition has settled, so starting now
			// races nothing.
			return c.ensureStarted(observed, req, 0)
		}
		return observed, nil
	}
	if snapshot.State == serviceRunning {
		// Already started. Nothing was restarted, so the disposition stays
		// none: there is no recovery for the heartbeat check to confirm.
		result.Action = RecoveryActionObserve
		result.Phase = "verify_running"
		if snapshot.PID <= 0 {
			result.Disposition = RecoveryDispositionFailover
			return result, &RecoveryError{
				Class: RecoveryFailureIdentityMismatch,
				Phase: "verify_running_pid",
				State: string(snapshot.State),
				PID:   snapshot.PID,
			}
		}
		result.NewPID = snapshot.PID
		return result, nil
	}
	if snapshot.State != serviceStopped {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "validate_scm_owner",
			State: string(snapshot.State),
			PID:   snapshot.PID,
		}
	}
	return c.ensureStarted(result, req, 0)
}

// forcedRecovery is the attempt-2 rung and the only path that terminates a
// process. Its ordering is:
//
//	validate -> terminate -> process exited -> (Stopped -> start | SCM already
//	restarting -> observe) -> Running with a new live PID
//
// Two rules make it safe. First, req.StateFilePID is never used for anything
// destructive: it is a hint written by the agent that may be arbitrarily stale,
// and Windows recycles PIDs aggressively, so terminating it could kill an
// unrelated process. Every destructive step targets the PID SCM names right
// now, re-checked immediately before the kill.
//
// Second, every uncertainty fails closed to RecoveryDispositionFailover, which
// RecoveryManager latches as terminal so attempt 3 cannot come back and try the
// same kill against the same fog. "We could not tell" is never "recovered".
func (c *windowsRecoveryController) forcedRecovery(result RecoveryResult, req RecoveryRequest) (RecoveryResult, error) {
	result.Action = RecoveryActionForced
	result.Phase = "query_scm_pid"

	snapshot, err := c.backend.Query()
	if err != nil {
		result.Disposition = RecoveryDispositionFailover
		return result, recoveryQueryError("query_scm_pid", snapshot, err)
	}
	result.InitialState = string(snapshot.State)
	result.FinalState = string(snapshot.State)

	if isPendingState(snapshot.State) {
		// SCM already owns a transition; watch it rather than race it.
		return c.observeTransition(result, req, snapshot)
	}
	if snapshot.State == serviceStopped {
		// Nothing to terminate — the process we were going to kill is already
		// gone.
		result.Action = RecoveryActionStart
		return c.ensureStarted(result, req, 0)
	}
	if snapshot.State != serviceRunning || snapshot.PID <= 0 {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "validate_scm_owner",
			State: string(snapshot.State),
			PID:   snapshot.PID,
		}
	}
	result.OldPID = snapshot.PID

	configured, err := c.backend.ConfiguredBinaryPath()
	if err != nil {
		result.Disposition = RecoveryDispositionFailover
		return result, recoveryQueryError("service_config", snapshot, err)
	}

	proc, err := c.backend.OpenProcess(snapshot.PID)
	if err != nil {
		result.Disposition = RecoveryDispositionFailover
		return result, recoveryQueryError("open_service_process", snapshot, err)
	}
	defer proc.Close()

	// Prove the handle we are about to terminate is our agent's image, and that
	// it is a live process rather than a zombie whose PID may already have been
	// handed to someone else.
	result.Phase = "validate_image"
	actual, err := proc.ImagePath()
	if err != nil || !sameWindowsExecutable(configured, actual) {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_image", State: string(snapshot.State), PID: snapshot.PID, Err: err}
	}
	result.Phase = "validate_process_live"
	alive, err := proc.Alive()
	if err != nil || !alive {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_process_live", State: string(snapshot.State), PID: snapshot.PID, Err: err}
	}

	// Close the TOCTOU window: SCM may have restarted the service while we were
	// validating, in which case our handle names a process SCM no longer owns.
	result.Phase = "revalidate_scm_pid"
	fresh, err := c.backend.Query()
	if err != nil {
		result.Disposition = RecoveryDispositionFailover
		return result, recoveryQueryError("revalidate_scm_pid", fresh, err)
	}
	result.FinalState = string(fresh.State)
	if isPendingState(fresh.State) {
		// SCM recovery or another controller already owns the transition.
		return c.observeTransition(result, req, fresh)
	}
	if fresh.State != serviceRunning || fresh.PID != snapshot.PID {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "revalidate_scm_owner",
			State: string(fresh.State),
			PID:   snapshot.PID,
		}
	}

	// Everything past here is a side effect, so the attempt is charged even if
	// the control itself fails.
	result.ActionTaken = true
	result.Phase = "terminate"
	if err := proc.Terminate(); err != nil {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{Class: RecoveryFailureControl, Phase: "terminate", State: string(fresh.State), PID: snapshot.PID, Err: err}
	}

	result.Phase = "wait_process_exit"
	if err := proc.Wait(req.Context, c.processExitTimeout); err != nil {
		if isRecoveryCancellation(err) {
			// A shutdown is not a diagnosis: leave the disposition alone so it
			// normalizes to none rather than latching terminal failover.
			return result, &RecoveryError{Class: RecoveryFailureCanceled, Phase: "wait_process_exit", PID: snapshot.PID, Err: err}
		}
		// The process may still hold the agent's ports, locks and state file.
		// Starting a second one on top of it is worse than failing over.
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{Class: RecoveryFailureProcessExitTimeout, Phase: "wait_process_exit", PID: snapshot.PID, Err: err}
	}

	return c.startAfterTermination(result, req, configured)
}

// startAfterTermination brings the service back once the terminated process has
// exited. SCM's own failure-recovery action may already be restarting it, so
// this observes before deciding whether to issue a Start — a competing Start
// would race SCM. Either way the resulting process must clear the same identity
// and liveness bar as the one we killed.
func (c *windowsRecoveryController) startAfterTermination(result RecoveryResult, req RecoveryRequest, configured string) (RecoveryResult, error) {
	result.Phase = "wait_service_settled"
	settled, err := c.waitForSettled(req, c.stopTimeout)
	if settled.State != "" {
		result.FinalState = string(settled.State)
	}
	if err != nil {
		if isRecoveryCancellation(err) {
			return result, &RecoveryError{Class: RecoveryFailureCanceled, Phase: "wait_service_settled", State: string(settled.State), PID: settled.PID, Err: err}
		}
		class := RecoveryFailureStopTimeout
		if errors.Is(err, errSettleQueryFailed) {
			class = RecoveryFailureQuery
		}
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{Class: class, Phase: "wait_service_settled", State: string(settled.State), PID: settled.PID, Err: err}
	}

	oldPID := result.OldPID
	switch settled.State {
	case serviceStopped:
		result, err = c.ensureStarted(result, req, oldPID)
	case serviceRunning:
		// SCM restarted it for us. Do not issue a competing Start.
		result, err = c.verifyRunning(result, settled, oldPID)
	default:
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "verify_running",
			State: string(settled.State),
			PID:   settled.PID,
		}
	}
	if err != nil {
		return result, err
	}
	if result.Disposition != RecoveryDispositionVerifyHeartbeat || result.NewPID <= 0 {
		// ensureStarted lost a race to SCM and the transition it observed ended
		// somewhere other than Running (typically back at Stopped). Nothing came
		// up, so there is no new process to verify — leave the disposition as the
		// observation found it rather than manufacturing a verdict here.
		return result, nil
	}
	return c.verifyNewProcess(result, configured, result.NewPID)
}

// verifyNewProcess is the last gate before reporting a forced restart as
// successful. verifyRunning already proved SCM says Running with a PID distinct
// from the one we killed; this proves that PID is our agent's image and is
// actually alive. Without it a forced recovery could report success for a PID
// SCM named but that had already died, or for a recycled PID belonging to
// something else entirely.
func (c *windowsRecoveryController) verifyNewProcess(result RecoveryResult, configured string, pid int) (RecoveryResult, error) {
	proc, err := c.backend.OpenProcess(pid)
	if err != nil {
		result.Disposition = RecoveryDispositionFailover
		return result, recoveryQueryError("open_new_process", serviceSnapshot{State: serviceRunning, PID: pid}, err)
	}
	defer proc.Close()

	result.Phase = "validate_new_image"
	actual, err := proc.ImagePath()
	if err != nil || !sameWindowsExecutable(configured, actual) {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_new_image", State: string(serviceRunning), PID: pid, Err: err}
	}
	result.Phase = "validate_new_process_live"
	alive, err := proc.Alive()
	if err != nil || !alive {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{Class: RecoveryFailureIdentityMismatch, Phase: "validate_new_process_live", State: string(serviceRunning), PID: pid, Err: err}
	}

	result.Phase = "verify_new_process"
	return result, nil
}

// waitForSettled polls SCM until it leaves every pending state, returning
// whatever definite state it landed in. Unlike waitForState it does not want a
// specific outcome: after a termination either Stopped (we start it) or Running
// (SCM already did) is legitimate, and the caller decides.
func (c *windowsRecoveryController) waitForSettled(req RecoveryRequest, timeout time.Duration) (serviceSnapshot, error) {
	deadline := c.clk.Now().Add(timeout)
	var last serviceSnapshot
	for {
		if err := req.Context.Err(); err != nil {
			return last, err
		}
		snapshot, err := c.backend.Query()
		if err != nil {
			return last, fmt.Errorf("%w: %w", errSettleQueryFailed, err)
		}
		last = snapshot
		if !isPendingState(snapshot.State) {
			return snapshot, nil
		}
		if !c.clk.Now().Before(deadline) {
			return snapshot, fmt.Errorf("timed out after %s waiting for the service to settle (last state %s)", timeout, snapshot.State)
		}
		if err := c.clk.Sleep(req.Context, c.pollInterval); err != nil {
			return snapshot, err
		}
	}
}

// ensureStarted issues Start and verifies the service reaches Running with a
// PID that is not oldPID. Callers must have established that the service is
// Stopped: Start is only ever called from a verified Stopped state.
func (c *windowsRecoveryController) ensureStarted(result RecoveryResult, req RecoveryRequest, oldPID int) (RecoveryResult, error) {
	out := c.control(result, req, controlStart, serviceRunning, c.startTimeout, "start_service", "wait_running", RecoveryFailureStartTimeout)
	if out.stop {
		return out.result, out.err
	}
	return c.verifyRunning(out.result, out.snapshot, oldPID)
}

// verifyRunning is the single success gate. A recovery is reported as "the
// agent is coming back" only when SCM says Running and names a PID we can tell
// apart from the process we were replacing. Anything ambiguous — no PID, or
// still the old PID — is uncertainty, and uncertainty fails closed into
// failover rather than being reported as a successful restart.
func (c *windowsRecoveryController) verifyRunning(result RecoveryResult, snapshot serviceSnapshot, oldPID int) (RecoveryResult, error) {
	result.Phase = "verify_running"
	result.FinalState = string(snapshot.State)

	if snapshot.State != serviceRunning {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "verify_running",
			State: string(snapshot.State),
			PID:   snapshot.PID,
		}
	}
	if snapshot.PID <= 0 {
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "verify_running_pid",
			State: string(snapshot.State),
			PID:   snapshot.PID,
		}
	}
	if oldPID > 0 && snapshot.PID == oldPID {
		// SCM still owns the PID we just restarted away from, so the "new"
		// process is the old one we already judged unhealthy.
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "verify_new_pid",
			State: string(snapshot.State),
			PID:   snapshot.PID,
		}
	}

	result.NewPID = snapshot.PID
	result.Disposition = RecoveryDispositionVerifyHeartbeat
	return result, nil
}

// observeTransition watches a pending SCM transition to its conclusion without
// issuing any control. It is deliberately free: it consumes no attempt and
// records no restart, because it did not restart anything.
func (c *windowsRecoveryController) observeTransition(result RecoveryResult, req RecoveryRequest, snapshot serviceSnapshot) (RecoveryResult, error) {
	if !result.ActionTaken {
		// Only relabel when we truly did nothing. If a control was already
		// issued and lost a race to SCM, keep the original action so the
		// attempt accounting still reflects the side effect.
		result.Action = RecoveryActionObserve
	}
	result.Phase = "observe_transition"
	result.FinalState = string(snapshot.State)

	last := snapshot
	deadline := c.clk.Now().Add(c.observeTimeout)
	for isPendingState(last.State) {
		if err := req.Context.Err(); err != nil {
			return result, &RecoveryError{Class: RecoveryFailureCanceled, Phase: "observe_transition", State: string(last.State), PID: last.PID, Err: err}
		}
		if !c.clk.Now().Before(deadline) {
			return result, &RecoveryError{
				Class: RecoveryFailureTransitionTimeout,
				Phase: "observe_transition",
				State: string(last.State),
				PID:   last.PID,
				Err:   fmt.Errorf("service still %s after %s", last.State, c.observeTimeout),
			}
		}
		if err := c.clk.Sleep(req.Context, c.pollInterval); err != nil {
			return result, &RecoveryError{Class: RecoveryFailureCanceled, Phase: "observe_transition", State: string(last.State), PID: last.PID, Err: err}
		}
		next, err := c.backend.Query()
		if err != nil {
			return result, recoveryQueryError("observe_transition", last, err)
		}
		last = next
		result.FinalState = string(last.State)
	}

	switch last.State {
	case serviceStopped:
		// SCM finished stopping on its own. Leave the disposition at none so
		// the next attempt can issue Start; starting here would race whatever
		// drove the stop.
		return result, nil
	case serviceRunning:
		return c.verifyRunning(result, last, result.OldPID)
	default:
		result.Disposition = RecoveryDispositionFailover
		return result, &RecoveryError{
			Class: RecoveryFailureIdentityMismatch,
			Phase: "observe_transition",
			State: string(last.State),
			PID:   last.PID,
		}
	}
}

type controlKind int

const (
	controlStop controlKind = iota
	controlStart
)

// controlOutcome carries the state machine's decision after a control call.
// stop=true means the caller must return (result, err) verbatim rather than
// continuing the recovery sequence.
type controlOutcome struct {
	result   RecoveryResult
	snapshot serviceSnapshot
	err      error
	stop     bool
}

// control issues one SCM control and waits for the requested terminal state.
//
// ActionTaken is set before the control is issued, not after it succeeds: a
// control that failed still perturbed the service, so it must be charged
// against the escalation budget. A query or observation, by contrast, costs
// nothing.
//
// A control error is not classified until SCM has been re-queried. Windows
// reports ERROR_SERVICE_NOT_ACTIVE / ERROR_SERVICE_ALREADY_RUNNING /
// ERROR_SERVICE_CANNOT_ACCEPT_CTRL when the transition we asked for is already
// happening or already done — treating those as failures would escalate a race
// we actually won into forced termination.
func (c *windowsRecoveryController) control(
	result RecoveryResult,
	req RecoveryRequest,
	kind controlKind,
	want serviceState,
	timeout time.Duration,
	controlPhase string,
	waitPhase string,
	timeoutClass RecoveryFailureClass,
) controlOutcome {
	result.Phase = controlPhase
	result.ActionTaken = true

	var controlErr error
	if kind == controlStop {
		controlErr = c.backend.Stop()
	} else {
		controlErr = c.backend.Start()
	}

	if controlErr != nil {
		result.Phase = controlPhase + "_requery"
		fresh, queryErr := c.backend.Query()
		if queryErr != nil {
			return controlOutcome{
				result: result,
				err:    &RecoveryError{Class: RecoveryFailureControl, Phase: controlPhase, Err: errors.Join(controlErr, queryErr)},
				stop:   true,
			}
		}
		result.FinalState = string(fresh.State)
		switch {
		case isPendingState(fresh.State):
			// SCM already owns the transition we asked for.
			r, err := c.observeTransition(result, req, fresh)
			return controlOutcome{result: r, snapshot: fresh, err: err, stop: true}
		case fresh.State == want:
			// Already where we wanted to be; carry on.
			result.Phase = waitPhase
			return controlOutcome{result: result, snapshot: fresh}
		default:
			return controlOutcome{
				result: result,
				err:    &RecoveryError{Class: RecoveryFailureControl, Phase: controlPhase, State: string(fresh.State), PID: fresh.PID, Err: controlErr},
				stop:   true,
			}
		}
	}

	result.Phase = waitPhase
	snapshot, waitErr := c.waitForState(req, want, timeout)
	if snapshot.State != "" {
		result.FinalState = string(snapshot.State)
	}
	if waitErr != nil {
		class := timeoutClass
		switch {
		case isRecoveryCancellation(waitErr):
			class = RecoveryFailureCanceled
		case errors.Is(waitErr, errUnexpectedTerminalState):
			class = RecoveryFailureTransitionTimeout
		}
		return controlOutcome{
			result:   result,
			snapshot: snapshot,
			err:      &RecoveryError{Class: class, Phase: waitPhase, State: string(snapshot.State), PID: snapshot.PID, Err: waitErr},
			stop:     true,
		}
	}
	return controlOutcome{result: result, snapshot: snapshot}
}

// waitForState polls SCM until it reports want, returning the matching
// snapshot. It fails on cancellation, query error, deadline, or when SCM
// settles in a definite state that is not want — there is no point waiting out
// a firm wrong answer. "Settles" allows for the acknowledge window: right
// after a control is issued SCM can still report the pre-transition state
// (RUNNING immediately after a stop request) until the service acknowledges,
// so a non-pending, non-target state only becomes a firm wrong answer once it
// persists past ackGrace.
func (c *windowsRecoveryController) waitForState(req RecoveryRequest, want serviceState, timeout time.Duration) (serviceSnapshot, error) {
	start := c.clk.Now()
	deadline := start.Add(timeout)
	ackDeadline := start.Add(c.ackGrace)
	var last serviceSnapshot
	for {
		if err := req.Context.Err(); err != nil {
			return last, err
		}
		snapshot, err := c.backend.Query()
		if err != nil {
			return last, err
		}
		last = snapshot
		if snapshot.State == want {
			return snapshot, nil
		}
		if !isPendingState(snapshot.State) && !c.clk.Now().Before(ackDeadline) {
			return snapshot, fmt.Errorf("%w: %s while waiting for %s", errUnexpectedTerminalState, snapshot.State, want)
		}
		if !c.clk.Now().Before(deadline) {
			return snapshot, fmt.Errorf("timed out after %s waiting for %s (last state %s)", timeout, want, snapshot.State)
		}
		if err := c.clk.Sleep(req.Context, c.pollInterval); err != nil {
			return snapshot, err
		}
	}
}

// normalizeWindowsExecutablePath canonicalizes a Windows executable path for
// comparison. SCM's service config and QueryFullProcessImageName do not agree
// on surface form — the config value is often quoted, may use forward slashes,
// and may carry the \\?\ extended-length prefix — while Windows paths are
// case-insensitive. Comparing raw strings would reject our own agent.
func normalizeWindowsExecutablePath(path string) string {
	path = strings.Trim(strings.TrimSpace(path), `"`)
	path = strings.ReplaceAll(path, "/", `\`)
	path = strings.TrimPrefix(path, `\\?\`)
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(path), `\`))
}

// sameWindowsExecutable reports whether two paths name the same image.
//
// An empty normalized path means "we do not know", and two unknowns are not a
// match: a backend that failed to report a path must never satisfy the identity
// gate that guards termination.
func sameWindowsExecutable(configured, actual string) bool {
	c := normalizeWindowsExecutablePath(configured)
	a := normalizeWindowsExecutablePath(actual)
	if c == "" || a == "" {
		return false
	}
	return c == a
}

func recoveryQueryError(phase string, snapshot serviceSnapshot, err error) *RecoveryError {
	return &RecoveryError{
		Class: RecoveryFailureQuery,
		Phase: phase,
		State: string(snapshot.State),
		PID:   snapshot.PID,
		Err:   err,
	}
}

// isRecoveryCancellation distinguishes "we are shutting down" from "recovery
// failed". Cancellation must never escalate to failover.
func isRecoveryCancellation(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
