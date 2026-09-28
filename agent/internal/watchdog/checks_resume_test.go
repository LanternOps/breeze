package watchdog

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// #6762: a system resume must restart the staleness clock. The heartbeat
// timestamp is wall-clock, so every second the machine spent asleep counts
// toward HeartbeatStaleThreshold; without the resume grace the first
// heartbeat tick after a sleep longer than the threshold reads a healthy
// agent as stale.

func TestResumeGraceSuppressesStaleVerdictFromSleepInterval(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-40 * time.Minute)}

	if got := hc.CheckHeartbeatStaleness(s); got != CheckHeartbeatStale {
		t.Fatalf("precondition: 40-minute-old heartbeat without resume should be stale, got %q", got)
	}

	hc.NoteResume(time.Now())
	if got := hc.CheckHeartbeatStaleness(s); got != CheckOK {
		t.Fatalf("heartbeat stale only because of the sleep interval must be OK right after resume, got %q", got)
	}
	if d, _ := hc.EvaluateStaleHeartbeat(s, false); d != HeartbeatOK {
		t.Fatalf("EvaluateStaleHeartbeat after resume = %v, want HeartbeatOK (no restart, even with IPC down)", d)
	}
}

func TestResumeGraceExpiresAfterStaleThreshold(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-40 * time.Minute)}

	// Resumed 4 minutes ago and the agent has still not heartbeated: that is
	// a genuinely stale agent again, not the sleep interval.
	hc.NoteResume(time.Now().Add(-4 * time.Minute))
	if got := hc.CheckHeartbeatStaleness(s); got != CheckHeartbeatStale {
		t.Fatalf("resume grace must end after staleThreshold, got %q", got)
	}
	if d, _ := hc.EvaluateStaleHeartbeat(s, false); d != StaleRestart {
		t.Fatalf("stale past the resume grace with IPC down = %v, want StaleRestart", d)
	}
}

func TestResumeReArmsStaleVetoBudgetAccumulatedAcrossWakes(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-40 * time.Minute)}

	// Earlier short maintenance wakes, each spending one IPC-alive veto while
	// the network was still down.
	for i := 1; i <= staleVetoLimit-1; i++ {
		if d, n := hc.EvaluateStaleHeartbeat(s, true); d != StaleVetoed || n != i {
			t.Fatalf("setup veto %d: got (%v, %d), want (StaleVetoed, %d)", i, d, n, i)
		}
	}

	// Next wake: without the resume the very next stale verdict escalates.
	hc.NoteResume(time.Now())
	if d, _ := hc.EvaluateStaleHeartbeat(s, true); d != HeartbeatOK {
		t.Fatalf("first tick after resume = %v, want HeartbeatOK", d)
	}
	if n := hc.StaleVetoCount(); n != 0 {
		t.Fatalf("resume must re-arm the veto budget, StaleVetoCount = %d", n)
	}

	// Once the grace lapses the agent starts from a full budget: the first
	// stale verdict is vetoed, not an immediate restart.
	hc.resumedAt = time.Now().Add(-4 * time.Minute)
	if d, n := hc.EvaluateStaleHeartbeat(s, true); d != StaleVetoed || n != 1 {
		t.Fatalf("first stale verdict after grace = (%v, %d), want (StaleVetoed, 1)", d, n)
	}
}

func TestNoteResumeNeverRegresses(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-40 * time.Minute)}

	hc.NoteResume(time.Now())
	hc.NoteResume(time.Now().Add(-time.Hour)) // late/out-of-order delivery
	if got := hc.CheckHeartbeatStaleness(s); got != CheckOK {
		t.Fatalf("an older resume timestamp must not shorten the grace, got %q", got)
	}
}

func TestResumeDoesNotInventLivenessWithoutAnyEvidence(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)

	// No state file and no state_sync ever: resume changes nothing — there
	// is no heartbeat whose age the sleep could have inflated.
	hc.NoteResume(time.Now())
	if got := hc.CheckHeartbeatStaleness(nil); got != CheckHeartbeatStale {
		t.Fatalf("nil state with no sync must stay stale after resume, got %q", got)
	}
}

func TestResumeGraceIsNotPositiveLivenessEvidence(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-40 * time.Minute)}

	// AgentAlive gates FAILOVER self-recovery and restart verification; a
	// resume is the absence of evidence, never proof the agent is running.
	hc.NoteResume(time.Now())
	if hc.AgentAlive(s) {
		t.Fatal("AgentAlive must not treat a resume as a fresh heartbeat")
	}
}
