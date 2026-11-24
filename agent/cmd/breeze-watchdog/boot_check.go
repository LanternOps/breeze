package main

import (
	"time"

	"github.com/breeze-rmm/agent/internal/watchdog"
)

// bootCheck owns the "is the agent there?" decision for a watchdog that could
// not reach the agent over IPC when it started (#12291). While it is active
// the watchdog is in CONNECTING and no cached-PID verdict (startup not-found,
// process-gone, stale heartbeat) may start recovery: after a reboot the PID in
// agent.state belongs to the previous boot, and restarting the new, healthy
// agent on that evidence spent a recovery attempt from the 24h budget on every
// boot. The service manager decides instead (watchdog.EvaluateBootCheck).
//
// The check ends when IPC connects (the ordinary CONNECTING -> MONITORING
// edge), on a confirmed not-found verdict (agent_not_found, the same recovery
// ladder as before), or on a release to the ordinary checks.
type bootCheck struct {
	startedAt    time.Time
	deadline     time.Duration
	queryService func() watchdog.AgentServiceStatus
	process      watchdog.ProcessChecker

	done          bool
	holdJournaled bool
	// notFoundPending: the previous check said not found. One more, on
	// fresh evidence, is needed before recovery starts.
	notFoundPending bool
}

func newBootCheck(now time.Time, deadline time.Duration, queryService func() watchdog.AgentServiceStatus, process watchdog.ProcessChecker) *bootCheck {
	return &bootCheck{startedAt: now, deadline: deadline, queryService: queryService, process: process}
}

// bootCheckDeadline bounds the hold. It reuses the time the watchdog already
// allows a restarted agent to come back, with a floor of two IPC probe
// intervals, because the IPC ticker's reconnect is what moves a held watchdog
// to MONITORING.
func bootCheckDeadline(restartVerificationTimeout, ipcProbeInterval time.Duration) time.Duration {
	if floor := 2 * ipcProbeInterval; restartVerificationTimeout < floor {
		return floor
	}
	return restartVerificationTimeout
}

// active reports whether the check still owns the decision. It never does once
// the watchdog has left CONNECTING (IPC connected, or recovery started).
func (b *bootCheck) active(wd *watchdog.Watchdog) bool {
	if b == nil || b.done {
		return false
	}
	if wd.State() != watchdog.StateConnecting {
		b.done = true
		return false
	}
	return true
}

// deferUnhealthy reports whether an "agent looks dead" signal must be dropped
// because the boot check owns the decision. Such a signal is built on
// agent.state (a previous boot's PID, or its old heartbeat), which is exactly
// the evidence the check exists to overrule. The check's own deadline, or its
// next confirming not-found, bounds the wait.
func (b *bootCheck) deferUnhealthy(now time.Time, wd *watchdog.Watchdog, journal *watchdog.Journal) bool {
	if !b.active(wd) {
		return false
	}
	journal.Log(watchdog.LevelInfo, "check.unhealthy_deferred_boot", map[string]any{
		"elapsed_ms":        now.Sub(b.startedAt).Milliseconds(),
		"deadline_ms":       b.deadline.Milliseconds(),
		"not_found_pending": b.notFoundPending,
	})
	return true
}

// evaluate runs one check on evidence gathered now and acts on it. statePID is
// the freshest PID read from agent.state. It returns true when the caller must
// skip its own cached-PID process check this tick. The caller runs it at
// startup and on every process tick, which is also what re-checks the
// deadline.
func (b *bootCheck) evaluate(now time.Time, statePID int, agentAlive bool, wd *watchdog.Watchdog, journal *watchdog.Journal) bool {
	if !b.active(wd) {
		return false
	}
	svc := b.queryService()
	statePIDAlive := statePID > 0 && b.process.IsAlive(statePID) && !b.process.IsZombie(statePID)
	elapsed := now.Sub(b.startedAt)
	decision := watchdog.EvaluateBootCheck(watchdog.BootCheckInput{
		Service:       svc,
		StatePID:      statePID,
		StatePIDAlive: statePIDAlive,
		AgentAlive:    agentAlive,
		Elapsed:       elapsed,
		Deadline:      b.deadline,
	})
	fields := map[string]any{
		"pid":             statePID,
		"pid_alive":       statePIDAlive,
		"service_state":   string(svc.State),
		"service_pid":     svc.PID,
		"service_detail":  svc.Detail,
		"elapsed_ms":      elapsed.Milliseconds(),
		"deadline_ms":     b.deadline.Milliseconds(),
		"boot_check":      decision.String(),
		"agent_heartbeat": agentAlive,
	}
	if decision != watchdog.BootNotFound {
		b.notFoundPending = false
	}
	switch decision {
	case watchdog.BootHold:
		if !b.holdJournaled {
			b.holdJournaled = true
			journal.Log(watchdog.LevelInfo, "agent.boot_wait_service", fields)
		}
		return true
	case watchdog.BootNotFound:
		// Act only on a second consecutive not-found, so the verdict and the
		// recovery dispatch that follows it rest on evidence from the same
		// tick: at watchdog start SCM may simply not have started the agent
		// yet. The first check runs at startup and the second on the first
		// process tick. At the default intervals that tick is also the first
		// loop iteration, where the first recovery attempt was dispatched
		// before #12291, so a dead agent is recovered no later than before.
		if !b.notFoundPending {
			b.notFoundPending = true
			journal.Log(watchdog.LevelInfo, "agent.not_found_unconfirmed", fields)
			return true
		}
		b.done = true
		wd.HandleEvent(watchdog.EventAgentNotFound)
		journal.Log(watchdog.LevelWarn, "agent.not_found", fields)
		return true
	default:
		// Journaled every time (at most once per check): a release on an
		// unknown service means the service-manager query did not work on
		// this host and the pre-#12291 state-file rule decided instead.
		b.done = true
		level := watchdog.LevelInfo
		if svc.State == watchdog.AgentServiceUnknown {
			level = watchdog.LevelWarn
		}
		journal.Log(level, "agent.boot_check_released", fields)
		return false
	}
}
