package desktop

import (
	"log/slog"
	"time"
)

// Watchdog escalation thresholds. see reattachCooldown in session_capture.go
// for the wall-clock mapping from counts to elapsed time.
const (
	watchdogEscalateAfter  int32 = 3
	watchdogTerminateAfter int32 = 5
)

// reattachWatchdog tracks consecutive failed ForceReattach attempts.
// Lives on the stack of the capture goroutine — only the pinned capture
// goroutine reads or writes it, so plain int32 (no atomics) is safe.
type reattachWatchdog struct {
	lastAttempt    time.Time
	lastVideoNanos int64
	failures       int32
}

// evaluate is called when the capture loop is about to attempt another
// ForceReattach. Returns true when the retry budget is exhausted and the
// caller should terminate the session.
func (w *reattachWatchdog) evaluate(sessionID string, currentVideoNanos int64) bool {
	if w.lastAttempt.IsZero() {
		// First attempt — no prior snapshot to compare against.
		return false
	}
	if currentVideoNanos > w.lastVideoNanos {
		// Video advanced since last attempt — reattach worked.
		prev := w.failures
		w.failures = 0
		if prev >= watchdogEscalateAfter {
			slog.Info("desktop watchdog: reattach recovered",
				"session", sessionID,
				"priorFailures", prev)
		}
		return false
	}
	w.failures++
	if w.failures == watchdogEscalateAfter {
		slog.Error("desktop watchdog: reattach failing, escalating",
			"session", sessionID,
			"failures", w.failures,
		)
	}
	if w.failures >= watchdogTerminateAfter {
		slog.Error("desktop watchdog: reattach exhausted, terminating session",
			"session", sessionID,
			"failures", w.failures,
		)
		return true
	}
	return false
}

// recordAttempt snapshots the current video timestamp so evaluate can detect
// whether video advanced between successive ForceReattach calls.
func (w *reattachWatchdog) recordAttempt(currentVideoNanos int64) {
	w.lastAttempt = time.Now()
	w.lastVideoNanos = currentVideoNanos
}
