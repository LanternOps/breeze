package watchdog

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// TestEvaluateStandby is the decision table behind #5252.
//
// The stranding failure was: agent announces a graceful stop, the installer
// never starts it again, and the watchdog waits out a 30-minute standby and
// then parks in FAILOVER — leaving a remote host offline with no management
// path. The policy now has to distinguish four situations, and getting any of
// them wrong is a production incident in one direction or the other:
// restarting an agent that is mid-shutdown, or leaving a dead one dead.
func TestEvaluateStandby(t *testing.T) {
	const (
		grace   = 2 * time.Minute
		ceiling = 30 * time.Minute
	)
	tests := []struct {
		name string
		in   StandbyInput
		want StandbyDecision
	}{
		{
			name: "inside the window: the announced stop is still in progress",
			in:   StandbyInput{Elapsed: 10 * time.Second, Window: grace, Ceiling: ceiling, Recognized: true},
			want: StandbyHold,
		},
		{
			name: "inside the window and the agent still looks alive: still hold",
			// Health is deliberately NOT consulted before the window closes:
			// an agent that announced a stop 10s ago still has a fresh
			// heartbeat, and resuming on that would cancel every standby.
			in:   StandbyInput{Elapsed: 10 * time.Second, Window: grace, Ceiling: ceiling, Recognized: true, AgentHealthy: true},
			want: StandbyHold,
		},
		{
			name: "window closed with the agent gone: escalate to the recovery ladder",
			in:   StandbyInput{Elapsed: grace, Window: grace, Ceiling: ceiling, Recognized: true},
			want: StandbyRecover,
		},
		{
			name: "window closed but the shutdown never happened: resume monitoring",
			in:   StandbyInput{Elapsed: grace + time.Second, Window: grace, Ceiling: ceiling, Recognized: true, AgentHealthy: true},
			want: StandbyResume,
		},
		{
			name: "unrecognized reason inside the ceiling: hold, do not guess a short window",
			in:   StandbyInput{Elapsed: 5 * time.Minute, Window: grace, Ceiling: ceiling},
			want: StandbyHold,
		},
		{
			name: "unrecognized reason at the ceiling with the agent gone: ensure-start then failover",
			in:   StandbyInput{Elapsed: ceiling, Window: grace, Ceiling: ceiling},
			want: StandbyFailover,
		},
		{
			name: "unrecognized reason at the ceiling but healthy: resume monitoring",
			in:   StandbyInput{Elapsed: ceiling, Window: grace, Ceiling: ceiling, AgentHealthy: true},
			want: StandbyResume,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := EvaluateStandby(tc.in); got != tc.want {
				t.Errorf("EvaluateStandby(%+v) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

// TestEvaluateStandbyNeverHoldsForeverOnAGoneAgent is the property that #5252
// is really about: whatever the reason and whatever the config, a standby that
// has outlived its ceiling with a dead agent must produce an action, never
// another hold. A hold here is an offline host.
func TestEvaluateStandbyNeverHoldsForeverOnAGoneAgent(t *testing.T) {
	const ceiling = 30 * time.Minute
	for _, recognized := range []bool{true, false} {
		for _, window := range []time.Duration{0, time.Minute, ceiling} {
			in := StandbyInput{
				Elapsed:    ceiling + time.Second,
				Window:     window,
				Ceiling:    ceiling,
				Recognized: recognized,
			}
			if got := EvaluateStandby(in); got == StandbyHold {
				t.Errorf("EvaluateStandby(%+v) = hold — a stranded host would stay offline", in)
			}
		}
	}
}

func TestRecognizedShutdownReason(t *testing.T) {
	tests := []struct {
		reason string
		want   bool
	}{
		{state.ReasonUserStop, true},
		{state.ReasonUpdate, true},
		{state.ReasonConfigReload, true},
		{"", true}, // older agents send no reason; still our agent
		{"scheduled_maintenance", false},
		{"something_a_future_version_invents", false},
	}
	for _, tc := range tests {
		if got := RecognizedShutdownReason(tc.reason); got != tc.want {
			t.Errorf("RecognizedShutdownReason(%q) = %v, want %v", tc.reason, got, tc.want)
		}
	}
}

// TestStandbyWindow pins the window arithmetic, including the overflow clamp:
// ExpectedDuration arrives over IPC as an int of seconds, and multiplying a
// large one into time.Duration wraps int64 nanoseconds NEGATIVE — which reads
// as "already expired" and would restart the agent instantly, the exact
// opposite of what a long declared maintenance asked for.
func TestStandbyWindow(t *testing.T) {
	const (
		grace   = 2 * time.Minute
		ceiling = 30 * time.Minute
	)
	tests := []struct {
		name     string
		reason   string
		expected int
		want     time.Duration
	}{
		{"recognized reason with no declared duration uses the grace period", state.ReasonUserStop, 0, grace},
		{"a short declared duration cannot shrink the grace period", state.ReasonUpdate, 5, grace},
		{"a longer declared duration is honoured", state.ReasonUpdate, 600, 10 * time.Minute},
		{"a declared duration past the ceiling is capped", state.ReasonUpdate, 3600, ceiling},
		{"an unrecognized reason waits out the ceiling", "scheduled_maintenance", 0, ceiling},
		{"an int64-overflowing declared duration is clamped, not wrapped", state.ReasonUpdate, 1 << 40, ceiling},
		{"a negative declared duration is ignored", state.ReasonUpdate, -1, grace},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := StandbyWindow(tc.reason, tc.expected, grace, ceiling)
			if got != tc.want {
				t.Errorf("StandbyWindow(%q, %d, %s, %s) = %s, want %s",
					tc.reason, tc.expected, grace, ceiling, got, tc.want)
			}
			if got <= 0 {
				t.Errorf("window must always be positive, got %s", got)
			}
		})
	}
}

// TestStandbyWindowSurvivesMisconfiguration — a zero or nonsensical config
// must never produce a window that has already expired, because that turns
// every graceful stop into an immediate restart race.
func TestStandbyWindowSurvivesMisconfiguration(t *testing.T) {
	tests := []struct {
		name    string
		grace   time.Duration
		ceiling time.Duration
	}{
		{"both unset", 0, 0},
		{"grace unset", 0, 30 * time.Minute},
		{"ceiling unset", 2 * time.Minute, 0},
		{"ceiling below grace", 2 * time.Minute, time.Second},
		{"negative values", -time.Minute, -time.Hour},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := StandbyWindow(state.ReasonUserStop, 0, tc.grace, tc.ceiling); got <= 0 {
				t.Errorf("StandbyWindow with grace=%s ceiling=%s = %s; must be positive",
					tc.grace, tc.ceiling, got)
			}
		})
	}
}

// TestEvaluateStandbyClampsAWindowPastTheCeiling — the production caller
// clamps via StandbyWindow, but EvaluateStandby must not depend on that. An
// unclamped window from a future caller would silently reintroduce the
// indefinite standby of #5252 with every other test still green.
func TestEvaluateStandbyClampsAWindowPastTheCeiling(t *testing.T) {
	const ceiling = 30 * time.Minute
	in := StandbyInput{
		Elapsed:    ceiling + time.Minute,
		Window:     10 * time.Hour, // absurd, unclamped
		Ceiling:    ceiling,
		Recognized: true,
	}
	if got := EvaluateStandby(in); got != StandbyRecover {
		t.Errorf("EvaluateStandby(%+v) = %s, want %s — an over-long window must be clamped to the ceiling",
			in, got, StandbyRecover)
	}
}
