// Package winsvcinstall owns the Service Control Manager half of
// `service install` for the Windows agent and the Windows watchdog.
//
// It exists because of #5299. Both installers used to call CreateService
// unconditionally, which fails outright on a host where the service already
// exists, and neither ever issued a start: the service was created
// StartAutomatic, which starts it at the next BOOT, and the command then
// printed a message claiming the agent was "installed and running". On an
// already-enrolled remote host that is the same stranding bug #5252 fixed for
// Linux and macOS — the device goes Offline and stays Offline until somebody
// reaches the box out of band.
//
// The interfaces below are deliberately expressed in neutral terms with no
// golang.org/x/sys/windows types, so the whole decision sequence — sample
// before stopping, stop before staging the binary, create-or-reconfigure,
// start, confirm RUNNING — compiles and its tests execute on every platform.
// That matters concretely: `internal/agentapp` is NOT in the Test Agent
// (Windows) package list (its inherited Windows reds are tracked in #2523), so
// a //go:build windows test placed next to the installer would have run on no
// CI job at all. Only the thin *_windows.go adapter in this package is
// platform-bound, and `build-agent (windows/amd64)` compiles it.
package winsvcinstall

import (
	"errors"
	"fmt"
	"io"
	"time"
)

// ErrNotInstalled is what Manager.Open reports when the named service does not
// exist yet. It is the signal to create rather than reconfigure, so it must be
// distinguishable from "the SCM refused to tell us".
var ErrNotInstalled = errors.New("service is not installed")

// ErrNotRunning is what Service.RequestStop reports when the service turned out
// to be stopped already. Racing our own state sample is not a failure.
var ErrNotRunning = errors.New("service is not running")

// State is the neutral spelling of a Windows service state.
type State int

// Service states. Only the three the install sequence actually branches on are
// named; everything else collapses into StateOther, which is treated as "busy,
// keep polling".
const (
	StateOther State = iota
	StateStopped
	StateStartPending
	StateRunning
)

func (s State) String() string {
	switch s {
	case StateStopped:
		return "STOPPED"
	case StateStartPending:
		return "START_PENDING"
	case StateRunning:
		return "RUNNING"
	default:
		return "PENDING"
	}
}

// Status is the neutral subset of svc.Status the install sequence reads.
type Status struct {
	State State
	// Win32ExitCode and ServiceExitCode are only meaningful on a STOPPED
	// reading; they are what turns "it isn't running" into a diagnosable
	// message.
	Win32ExitCode   uint32
	ServiceExitCode uint32
}

// Spec is the service identity an install asserts. It is applied on create AND
// on reconfigure, so an upgrade heals a drifted registration (a service left
// Disabled by a previous troubleshooting session, say) instead of silently
// installing a binary that will never run.
type Spec struct {
	Name        string
	DisplayName string
	Description string
	// Args are appended to the service command line after the executable path.
	Args []string
}

// Service is the minimal control surface the install sequence needs over one
// Windows service.
type Service interface {
	// Status reports the current state.
	Status() (Status, error)
	// RequestStop asks the SCM to stop the service. It returns as soon as the
	// request is accepted; STOPPED is confirmed by polling Status.
	// ErrNotRunning means it was already stopped.
	RequestStop() error
	// Reconfigure repoints an existing service at exePath and re-asserts spec.
	Reconfigure(spec Spec, exePath string) error
	// SetRecoveryActions installs the restart-on-failure ladder.
	SetRecoveryActions() error
	// RequestStart asks the SCM to start the service. It returns as soon as the
	// request is accepted; RUNNING is confirmed by polling Status.
	RequestStart() error
	// Close releases the handle.
	Close() error
}

// Manager is the minimal surface over an open SCM connection.
type Manager interface {
	// Open returns a handle to an existing service, or ErrNotInstalled.
	Open(name string) (Service, error)
	// Create registers a new service pointing at exePath.
	Create(spec Spec, exePath string) (Service, error)
	// Close disconnects from the SCM.
	Close() error
}

// StartDecision records whether install must leave the service RUNNING when it
// returns, and the reason — which the caller prints, so an install that
// deliberately leaves the service stopped says why.
type StartDecision struct {
	Start  bool
	Reason string
}

// StartWhenRunningOrEnrolled is the agent's rule, mirroring the Linux/macOS
// behaviour settled in #5252/#5296.
//
// Two independent triggers, either sufficient:
//
//   - wasRunning: the service was up before this install stopped it. Install is
//     the documented upgrade path, and an upgrade must not change whether the
//     service is running.
//   - enrolled: the host already has an agent ID, so the service is meant to be
//     running even if it happened to be down at install time.
//
// Neither means a fresh, un-enrolled host: nothing to talk to a server about
// yet, so the operator enrolls first and starts it deliberately.
func StartWhenRunningOrEnrolled(enrolled bool) func(wasRunning bool) StartDecision {
	return func(wasRunning bool) StartDecision {
		switch {
		case wasRunning:
			return StartDecision{Start: true, Reason: "it was running before this install"}
		case enrolled:
			return StartDecision{Start: true, Reason: "this host is already enrolled"}
		default:
			return StartDecision{Start: false, Reason: "this host is not enrolled yet"}
		}
	}
}

// AlwaysStart is the watchdog's rule. Unconditional, because a watchdog has no
// credentials to wait for and an installed-but-not-started watchdog is exactly
// the failure it exists to prevent.
func AlwaysStart() func(wasRunning bool) StartDecision {
	return func(bool) StartDecision {
		return StartDecision{Start: true, Reason: "a watchdog is useless unless it is running"}
	}
}

// Timeouts bounds the two waits the install sequence performs.
type Timeouts struct {
	// Stop bounds the wait for STOPPED after a stop request.
	Stop time.Duration
	// Start bounds the wait for RUNNING after a start request.
	Start time.Duration
	// Poll is the interval between Status reads.
	Poll time.Duration
	// Settle is how long a STOPPED reading after a start request is treated as
	// "the SCM has not moved it yet" rather than "it started and died".
	// StartService is asynchronous, so without this the very first read after a
	// successful start request would be misread as an immediate crash.
	Settle time.Duration
}

// DefaultTimeouts are the production values.
func DefaultTimeouts() Timeouts {
	return Timeouts{
		Stop:   30 * time.Second,
		Start:  60 * time.Second,
		Poll:   500 * time.Millisecond,
		Settle: 3 * time.Second,
	}
}

// Request is one `service install` invocation.
type Request struct {
	Spec Spec
	// Stage copies the binary into its protected location and returns the path
	// the service must point at. It is a callback rather than a path because it
	// MUST run after the stop: Windows holds an exclusive lock on the image of
	// a running service, so staging over it while the service runs fails.
	Stage func() (string, error)
	// Decide chooses whether to start, given whether the service was running
	// before this install stopped it.
	Decide func(wasRunning bool) StartDecision
	// Timeouts is DefaultTimeouts() when zero.
	Timeouts Timeouts
	// Warn receives non-fatal diagnostics. nil discards them.
	Warn io.Writer
}

// Outcome is what actually happened, so the caller can print the truth rather
// than a hardcoded "installed and running".
type Outcome struct {
	// Existed is true when the service was already registered before this run.
	Existed bool
	// WasRunning is the state sampled BEFORE this install stopped anything.
	WasRunning bool
	// Installed is true once the service is registered and pointing at the new
	// binary — i.e. a later error is a start failure, not an install failure.
	Installed bool
	// StartAttempted is true when the policy asked for a start, whether or not
	// it succeeded.
	StartAttempted bool
	// Started is true only when the service was confirmed RUNNING.
	Started bool
	// StartReason is the Decide reason, printed either way.
	StartReason string
}

// Summary is the one-line truth about what an install did — the replacement for
// the hardcoded "The agent service is installed and running" that #5299 is
// named after. It says "is running" only when the service was observed RUNNING.
func (o Outcome) Summary(name string) string {
	verb := "installed"
	if o.Existed {
		verb = "upgraded"
	}
	switch {
	case o.Started:
		return fmt.Sprintf("Service %q %s and is running.", name, verb)
	case o.StartAttempted:
		return fmt.Sprintf("Service %q %s but FAILED TO START.", name, verb)
	default:
		return fmt.Sprintf("Service %q %s and is NOT running (%s).", name, verb, o.StartReason)
	}
}

// Install runs the SCM half of `service install`.
//
// The order is the whole bug:
//
//  1. open the existing service, if any;
//  2. sample whether it is running — BEFORE our own stop. Asking afterwards is
//     the inverted check that shipped #5252;
//  3. stop it, and wait for STOPPED, so the staged binary can replace a locked
//     image;
//  4. stage the binary;
//  5. reconfigure the existing registration, or create a new one;
//  6. set recovery actions;
//  7. start it when the policy says so, and confirm RUNNING before claiming it.
func Install(m Manager, req Request) (Outcome, error) {
	var out Outcome
	warn := req.Warn
	if warn == nil {
		warn = io.Discard
	}
	t := req.Timeouts
	if t == (Timeouts{}) {
		t = DefaultTimeouts()
	}

	svcHandle, err := m.Open(req.Spec.Name)
	switch {
	case err == nil:
		out.Existed = true
		defer func() { _ = svcHandle.Close() }()
	case errors.Is(err, ErrNotInstalled):
	default:
		return out, fmt.Errorf("failed to open the existing %q service: %w", req.Spec.Name, err)
	}

	if out.Existed {
		// Sample BEFORE our own stop. Sampling afterwards can only ever answer
		// "not running", which is the inverted check that shipped #5252.
		status, err := svcHandle.Status()
		if err != nil {
			return out, fmt.Errorf("failed to read the state of the existing %q service: %w", req.Spec.Name, err)
		}
		out.WasRunning = status.State != StateStopped

		if out.WasRunning {
			if err := stopAndWait(svcHandle, t); err != nil {
				return out, fmt.Errorf("failed to stop the running %q service before upgrading it: %w",
					req.Spec.Name, err)
			}
		}
	}

	// Only now: Windows holds an exclusive lock on the image of a running
	// service, so staging over it before the stop fails with a file-in-use
	// error that says nothing about the real problem.
	exePath, err := req.Stage()
	if err != nil {
		return out, err
	}

	if out.Existed {
		if err := svcHandle.Reconfigure(req.Spec, exePath); err != nil {
			return out, fmt.Errorf("failed to reconfigure the existing %q service: %w", req.Spec.Name, err)
		}
	} else {
		svcHandle, err = m.Create(req.Spec, exePath)
		if err != nil {
			return out, fmt.Errorf("failed to create the %q service: %w", req.Spec.Name, err)
		}
		defer func() { _ = svcHandle.Close() }()
	}
	out.Installed = true

	// Best-effort: a service that runs without a restart ladder is strictly
	// better than an install aborted half-done.
	if err := svcHandle.SetRecoveryActions(); err != nil {
		_, _ = fmt.Fprintf(warn, "Warning: failed to set recovery actions: %v\n", err)
	}

	decision := req.Decide(out.WasRunning)
	out.StartReason = decision.Reason
	if !decision.Start {
		return out, nil
	}
	out.StartAttempted = true

	if err := startAndWait(svcHandle, t); err != nil {
		// Installed stays true: the registration and the new binary are in
		// place, so the caller can finish the rest of the install (the watchdog
		// bootstrap) before surfacing this as a non-zero exit.
		return out, fmt.Errorf("the %q service was installed but did not start: %w", req.Spec.Name, err)
	}
	out.Started = true
	return out, nil
}

// StartAndWait starts an already-installed service and blocks until the SCM
// reports it RUNNING. Exported so `service start` reports the same truth the
// installer does — "the request was accepted" is not "it is running".
func StartAndWait(m Manager, name string, t Timeouts) error {
	if t == (Timeouts{}) {
		t = DefaultTimeouts()
	}
	s, err := m.Open(name)
	if err != nil {
		return fmt.Errorf("failed to open the %q service: %w", name, err)
	}
	defer func() { _ = s.Close() }()
	return startAndWait(s, t)
}

// stopAndWait requests a stop and blocks until the service reports STOPPED.
func stopAndWait(s Service, t Timeouts) error {
	if err := s.RequestStop(); err != nil && !errors.Is(err, ErrNotRunning) {
		return err
	}
	deadline := time.Now().Add(t.Stop)
	for {
		status, err := s.Status()
		if err != nil {
			return fmt.Errorf("failed to read the service state while waiting for it to stop: %w", err)
		}
		if status.State == StateStopped {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("it was still %s after %s", status.State, t.Stop)
		}
		time.Sleep(t.Poll)
	}
}

// startAndWait requests a start and blocks until the service reports RUNNING.
//
// Waiting matters twice over: it is what makes an "installed and running"
// message true, and it is the only way a service that starts and immediately
// dies becomes a non-zero exit instead of a silent success.
func startAndWait(s Service, t Timeouts) error {
	if err := s.RequestStart(); err != nil {
		return err
	}
	start := time.Now()
	deadline := start.Add(t.Start)
	settled := start.Add(t.Settle)
	for {
		status, err := s.Status()
		if err != nil {
			return fmt.Errorf("failed to read the service state after requesting a start: %w", err)
		}
		switch status.State {
		case StateRunning:
			return nil
		case StateStopped:
			// StartService is asynchronous, so an immediate STOPPED reading
			// usually means "the SCM has not moved it yet", not "it died".
			// Past the settle window it does mean it died.
			if !time.Now().Before(settled) {
				return fmt.Errorf(
					"it stopped again immediately (Win32 exit code %d, service exit code %d)",
					status.Win32ExitCode, status.ServiceExitCode)
			}
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("it was still %s after %s", status.State, t.Start)
		}
		time.Sleep(t.Poll)
	}
}
