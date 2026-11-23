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
// edge), when the evidence says the agent is not running (agent_not_found, the
// same recovery ladder as before), or at its deadline.
type bootCheck struct {
	startedAt    time.Time
	deadline     time.Duration
	queryService func() watchdog.AgentServiceStatus
	process      watchdog.ProcessChecker

	done          bool
	holdJournaled bool
}

func newBootCheck(now time.Time, deadline time.Duration, queryService func() watchdog.AgentServiceStatus, process watchdog.ProcessChecker) *bootCheck {
	return &bootCheck{startedAt: now, deadline: deadline, queryService: queryService, process: process}
}

// bootCheckDeadline bounds the hold. It reuses the time the watchdog already
// allows a restarted agent to come back, and always covers at least two IPC
// reconnect attempts, because the IPC ticker's reconnect is what moves a held
// watchdog to MONITORING.
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

// evaluate runs one check on evidence gathered now and acts on it. statePID is
// the freshest PID read from agent.state. It returns true when the caller must
// skip its own cached-PID process check this tick.
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
	switch decision {
	case watchdog.BootHold:
		if !b.holdJournaled {
			b.holdJournaled = true
			journal.Log(watchdog.LevelInfo, "agent.boot_wait_service", fields)
		}
		return true
	case watchdog.BootNotFound:
		b.done = true
		wd.HandleEvent(watchdog.EventAgentNotFound)
		journal.Log(watchdog.LevelWarn, "agent.not_found", fields)
		return true
	default:
		b.done = true
		if b.holdJournaled || elapsed >= b.deadline {
			journal.Log(watchdog.LevelInfo, "agent.boot_check_released", fields)
		}
		return false
	}
}
