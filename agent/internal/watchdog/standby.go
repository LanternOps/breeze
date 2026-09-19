package watchdog

import (
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// DefaultStandbyGrace is how long the watchdog tolerates an announced,
// recognized agent shutdown before it treats the agent as stranded and starts
// it again.
//
// Two minutes is chosen to sit comfortably above a systemd stop+start of the
// agent (seconds) and above an in-band binary swap, while being short enough
// that a remote host whose agent was stopped and never restarted — the #5252
// failure — is back before anyone notices. The previous behaviour was to wait
// out StandbyTimeout (30 minutes) and then park in FAILOVER *without* starting
// the agent, i.e. the host stayed offline indefinitely.
const DefaultStandbyGrace = 2 * time.Minute

// StandbyDecision is the action the watchdog should take for the current
// STANDBY tick.
type StandbyDecision int

const (
	// StandbyHold keeps the watchdog in STANDBY and means every "the agent
	// looks dead" signal must be DROPPED: the agent is intentionally down and
	// restarting it now would fight the very operation it announced (an admin
	// `service stop`, an installer's stop-rewrite-start, the in-band updater).
	StandbyHold StandbyDecision = iota
	// StandbyResume means the agent turned out to be alive and healthy after
	// all (the announced shutdown never completed) — return to MONITORING
	// rather than restarting a working agent.
	StandbyResume
	// StandbyRecover means the announced window closed with the agent still
	// gone. Hand off to the normal RECOVERING ladder, which carries the
	// restart budget, flap detection and its own ensure-start-before-FAILOVER.
	StandbyRecover
	// StandbyFailover means we held an UNRECOGNIZED shutdown reason all the
	// way to the ceiling. We deliberately do not run the restart ladder for a
	// reason we do not understand, but we must not leave the host dead either:
	// the caller issues one budget-free ensure-start and parks in FAILOVER so
	// the server learns the host needs attention.
	StandbyFailover
)

func (d StandbyDecision) String() string {
	switch d {
	case StandbyHold:
		return "hold"
	case StandbyResume:
		return "resume"
	case StandbyRecover:
		return "recover"
	case StandbyFailover:
		return "failover"
	default:
		return "unknown"
	}
}

// StandbyInput is the evidence EvaluateStandby judges.
type StandbyInput struct {
	// Elapsed is how long the watchdog has been in STANDBY.
	Elapsed time.Duration
	// Window is the tolerated shutdown window for a recognized reason
	// (see StandbyWindow).
	Window time.Duration
	// Ceiling is the absolute cap on any standby (config StandbyTimeout).
	Ceiling time.Duration
	// Recognized reports whether the shutdown reason is one this agent sends.
	Recognized bool
	// AgentHealthy reports live IPC *and* a fresh heartbeat. It is only
	// consulted once the window has closed — during the window the agent's
	// heartbeat is still fresh purely because it was alive moments ago, and
	// treating that as "healthy" would cancel the standby it just announced.
	AgentHealthy bool
}

// EvaluateStandby is the single source of truth for what STANDBY does.
//
// It is consulted from two places in the watchdog run loop — the per-tick
// STANDBY block and the funnel that every agent_unhealthy signal passes
// through — precisely so those two cannot drift apart. Keeping it pure keeps
// the transition table static and makes the policy table-testable without a
// live agent, an init system, or a clock.
func EvaluateStandby(in StandbyInput) StandbyDecision {
	// Defence in depth. The only production caller already clamps via
	// StandbyWindow, but a future caller passing an unclamped window would
	// reintroduce the indefinite standby this function exists to prevent —
	// and it would do so silently, with every test still green.
	if in.Ceiling > 0 && in.Window > in.Ceiling {
		in.Window = in.Ceiling
	}
	if !in.Recognized {
		// An unfamiliar reason may describe genuinely long maintenance, so we
		// wait out the full ceiling rather than guessing a short window.
		if in.Elapsed < in.Ceiling {
			return StandbyHold
		}
		if in.AgentHealthy {
			return StandbyResume
		}
		return StandbyFailover
	}
	if in.Elapsed < in.Window {
		return StandbyHold
	}
	if in.AgentHealthy {
		return StandbyResume
	}
	return StandbyRecover
}

// RecognizedShutdownReason reports whether reason is one the Breeze agent
// itself sends on a graceful shutdown. An empty reason counts as recognized:
// older agents send the intent without one, and they are still our agents.
func RecognizedShutdownReason(reason string) bool {
	switch reason {
	case "", state.ReasonUserStop, state.ReasonUpdate, state.ReasonConfigReload:
		return true
	default:
		return false
	}
}

// StandbyWindow returns how long an announced shutdown with this reason is
// tolerated before the watchdog acts.
//
// grace is the floor, an agent-declared ExpectedDuration can raise it, and
// ceiling caps it. The declared duration is clamped in SECONDS before it is
// multiplied into a time.Duration: a hostile or corrupt value would otherwise
// overflow int64 nanoseconds and wrap to a negative window, which reads as
// "already expired" and would restart the agent immediately.
func StandbyWindow(reason string, expectedDurationSeconds int, grace, ceiling time.Duration) time.Duration {
	if grace <= 0 {
		grace = DefaultStandbyGrace
	}
	if ceiling <= 0 || ceiling < grace {
		// A misconfigured ceiling must never shrink the window below the
		// grace period; that would make every graceful stop a restart race.
		ceiling = grace
	}
	if !RecognizedShutdownReason(reason) {
		return ceiling
	}
	window := grace
	if expectedDurationSeconds > 0 {
		maxSeconds := int(ceiling / time.Second)
		if expectedDurationSeconds > maxSeconds {
			expectedDurationSeconds = maxSeconds
		}
		if declared := time.Duration(expectedDurationSeconds) * time.Second; declared > window {
			window = declared
		}
	}
	if window > ceiling {
		window = ceiling
	}
	return window
}
