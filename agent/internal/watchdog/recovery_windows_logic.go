package watchdog

import (
	"context"
	"errors"
	"fmt"
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
)

// errUnexpectedTerminalState means SCM settled in a definite state that is not
// the one we asked for. It is distinct from a timeout: we have a firm answer,
// it is just the wrong one, so there is nothing to wait for.
var errUnexpectedTerminalState = errors.New("service settled in an unexpected terminal state")

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
		return c.observeTransition(result, req, snapshot)
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

// forcedRecovery is the attempt-2 rung: validate the SCM-named process is
// really our agent, terminate it, wait for it to exit, then bring the service
// back.
//
// TODO(task-3): implement the verified forced ordering
// (validate -> terminate -> process exited -> start/observe -> new live PID)
// per docs/superpowers/plans/2026-07-14-windows-watchdog-verified-recovery.md.
// Until then this fails closed: forced recovery is the only path that can
// terminate a process, and a half-built version of it could terminate the
// wrong one. Returning a terminal failover disposition costs us an escalation
// rung (the watchdog hands off to failover instead of force-restarting) but
// cannot kill anything. This controller is not yet wired into production —
// NewRecoveryManager still builds the legacy Windows controller until task 4 —
// so no shipped behavior depends on this branch today.
func (c *windowsRecoveryController) forcedRecovery(result RecoveryResult, _ RecoveryRequest) (RecoveryResult, error) {
	result.Action = RecoveryActionForced
	result.Disposition = RecoveryDispositionFailover
	return result, &RecoveryError{
		Class: RecoveryFailureControl,
		Phase: "forced_recovery_unimplemented",
		Err:   errors.New("verified forced recovery is not implemented yet"),
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
// a firm wrong answer.
func (c *windowsRecoveryController) waitForState(req RecoveryRequest, want serviceState, timeout time.Duration) (serviceSnapshot, error) {
	deadline := c.clk.Now().Add(timeout)
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
		if !isPendingState(snapshot.State) {
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
