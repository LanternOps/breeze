//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// windowsWatchdogServiceName is the SCM name installed by
// `breeze-watchdog service install` (agent/cmd/breeze-watchdog/service_cmd_windows.go:16).
// Kept duplicated here rather than imported so this file can stand alone in
// the breeze-agent package without pulling watchdog cmd internals.
const watchdogSupervisorServiceName = "BreezeWatchdog"

// Supervisor tick cadence. Sixty seconds is fast enough to recover from a
// crashed-and-disabled watchdog within one heartbeat window, while staying
// well below any reasonable detection-window for "watchdog flapping".
const watchdogSupervisorInterval = 60 * time.Second

// After this many consecutive failures (open-service or start), the
// supervisor goes into slow-tick mode (5x interval) to avoid log spam when
// the watchdog has been deliberately uninstalled or quarantined. It still
// keeps trying so a re-install is auto-detected, just more quietly.
const watchdogSupervisorBackoffAfter = 3

// watchdogServiceController is the minimal subset of the Windows SCM API
// the supervisor needs. Defined as an interface so unit tests can substitute
// a fake without touching the real Service Control Manager. Production code
// uses windowsSCMController below.
type watchdogServiceController interface {
	QueryState(name string) (svc.State, error)
	Start(name string) error
}

// windowsSCMController is the production implementation backed by the real
// Windows SCM via golang.org/x/sys/windows/svc/mgr.
type windowsSCMController struct{}

func (windowsSCMController) QueryState(name string) (svc.State, error) {
	m, err := mgr.Connect()
	if err != nil {
		return 0, fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return 0, fmt.Errorf("open service %q: %w", name, err)
	}
	defer s.Close()

	st, err := s.Query()
	if err != nil {
		return 0, fmt.Errorf("query service %q: %w", name, err)
	}
	return st.State, nil
}

func (windowsSCMController) Start(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("open service %q: %w", name, err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("start service %q: %w", name, err)
	}
	return nil
}

// watchdogSupervisorCtl is the package-level seam that production wires to
// the real SCM. Tests overwrite it.
var watchdogSupervisorCtl watchdogServiceController = windowsSCMController{}

// watchdogSupervisorRestartCount is incremented every time the supervisor
// successfully issues a Start. Exposed for tests and future telemetry
// (A2 — TypeTamperAlert wiring will read this).
var watchdogSupervisorRestartCount atomic.Int64

// startWatchdogSupervisor launches a goroutine that periodically verifies
// the BreezeWatchdog Windows service is running, restarting it if found
// stopped or paused. Cancel ctx to stop the goroutine.
//
// Intentionally conservative:
//   - Does NOT attempt to reinstall a missing service (that's bootstrap
//     territory; see watchdog_bootstrap.go).
//   - Does NOT touch StartContinuous / paused-pending / start-pending
//     transient states — only Stopped and Paused trigger a Start.
//   - Backs off to a slow tick after consecutive failures so a removed or
//     quarantined watchdog doesn't pin the agent log at 100% volume.
//
// Returns a stop channel that closes after the goroutine has exited. Useful
// in tests and in case shutdownAgent ever needs to await full teardown.
func startWatchdogSupervisor(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go runWatchdogSupervisor(ctx, watchdogSupervisorCtl, watchdogSupervisorInterval, done)
	return done
}

// runWatchdogSupervisor is the pure-Go loop body, separated from
// startWatchdogSupervisor so tests can drive it with a stub controller and
// a short interval.
func runWatchdogSupervisor(ctx context.Context, ctl watchdogServiceController, interval time.Duration, done chan<- struct{}) {
	defer close(done)

	log.Info("watchdog supervisor started",
		"service", watchdogSupervisorServiceName,
		"interval", interval.String())

	t := time.NewTicker(interval)
	defer t.Stop()

	consecutiveFailures := 0
	currentInterval := interval

	checkAndMaybeRestart := func() {
		if err := ctx.Err(); err != nil {
			return
		}
		state, qErr := ctl.QueryState(watchdogSupervisorServiceName)
		if qErr != nil {
			consecutiveFailures++
			log.Warn("watchdog supervisor: query failed",
				"error", qErr.Error(),
				"consecutiveFailures", consecutiveFailures)
			return
		}

		switch state {
		case svc.Running:
			if consecutiveFailures > 0 {
				log.Info("watchdog supervisor: watchdog healthy again", "previousFailures", consecutiveFailures)
			}
			consecutiveFailures = 0
			return
		case svc.StartPending, svc.StopPending, svc.ContinuePending, svc.PausePending:
			// Transient: SCM will resolve to a steady state on its own.
			// Don't touch.
			return
		case svc.Stopped, svc.Paused:
			// Re-check ctx right before the side-effecting call so that
			// an in-flight Stop request from the SCM doesn't race a
			// restart into a stop sequence.
			if err := ctx.Err(); err != nil {
				return
			}
			log.Warn("watchdog supervisor: watchdog is not running, attempting restart",
				"state", state)
			if err := ctl.Start(watchdogSupervisorServiceName); err != nil {
				consecutiveFailures++
				log.Error("watchdog supervisor: start failed",
					"error", err.Error(),
					"consecutiveFailures", consecutiveFailures)
				return
			}
			watchdogSupervisorRestartCount.Add(1)
			log.Info("watchdog supervisor: restart issued",
				"totalRestarts", watchdogSupervisorRestartCount.Load())
			consecutiveFailures = 0
		default:
			// Unknown state code — log and move on.
			log.Warn("watchdog supervisor: unexpected service state, ignoring", "state", state)
		}
	}

	// Probe once on start so the supervisor doesn't have to wait an entire
	// interval to react to a watchdog that was already down at agent
	// startup.
	checkAndMaybeRestart()

	for {
		select {
		case <-ctx.Done():
			log.Info("watchdog supervisor stopping", "reason", ctx.Err().Error())
			return
		case <-t.C:
			checkAndMaybeRestart()
			// Adjust cadence based on failure count.
			newInterval := interval
			if consecutiveFailures >= watchdogSupervisorBackoffAfter {
				newInterval = interval * 5
			}
			if newInterval != currentInterval {
				t.Reset(newInterval)
				currentInterval = newInterval
				log.Info("watchdog supervisor: cadence adjusted",
					"interval", newInterval.String(),
					"consecutiveFailures", consecutiveFailures)
			}
		}
	}
}

// errSupervisorStopped is a sentinel for tests that want to assert the
// goroutine exited via ctx-cancel rather than a panic.
var errSupervisorStopped = errors.New("watchdog supervisor stopped")
