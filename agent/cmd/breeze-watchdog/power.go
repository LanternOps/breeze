package main

import (
	"time"

	"github.com/breeze-rmm/agent/internal/powerevent"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// powerNotice is a suspend or resume the Windows SCM delivered to the
// watchdog service (SERVICE_CONTROL_POWEREVENT, #6762). at is when the SCM
// handler received it, not when the main loop got to it.
type powerNotice struct {
	eventType uint32
	at        time.Time
}

// powerNoticeBuffer sizes the SCM-handler → main-loop channel. Suspend and
// resume arrive in pairs minutes apart at most; 16 only fills if the main
// loop is wedged for many sleep cycles, and then dropping is the right call —
// the SCM control handler must never block.
const powerNoticeBuffer = 16

// forwardPowerEvent hands a power event from the SCM handler goroutine to the
// main loop, which owns the HealthChecker. Only suspend and resume are
// forwarded; AC/battery status and power-setting changes are irrelevant to
// heartbeat staleness. Never blocks. Returns whether the notice was queued.
func forwardPowerEvent(ch chan<- powerNotice, eventType uint32, at time.Time) bool {
	if powerevent.Classify(eventType) == powerevent.Other {
		return false
	}
	select {
	case ch <- powerNotice{eventType: eventType, at: at}:
		return true
	default:
		return false
	}
}

// applyPowerNotice runs on the main loop. A resume restarts the heartbeat
// staleness clock (HealthChecker.NoteResume) so the time the machine spent
// asleep is not judged as a missed heartbeat and the agent is not restarted on
// wake. Both edges are journaled: the journal is what collect_diagnostics
// ships, and a sleep boundary is the first thing to rule out when reading a
// heartbeat gap.
func applyPowerNotice(n powerNotice, health *watchdog.HealthChecker, journal *watchdog.Journal) {
	kind := powerevent.Classify(n.eventType)
	fields := map[string]any{"event": powerevent.Name(n.eventType)}
	switch kind {
	case powerevent.Resume:
		health.NoteResume(n.at)
		journal.Log(watchdog.LevelInfo, "power.resume", fields)
	case powerevent.Suspend:
		journal.Log(watchdog.LevelInfo, "power.suspend", fields)
	}
}
