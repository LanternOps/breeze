package watchdog

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// #8934 (decision 2 on #8148): an agent whose heartbeats get 503/429 answers
// from an overloaded API is alive — its heartbeat loop is running and its
// transport reached the server. A restart cannot add server capacity, and
// every restart adds a reconnect to the storm. A fresh server-unavailable
// marker must hold off the stale-heartbeat restart for as long as it stays
// fresh, not just for the staleVetoLimit-1 ticks the IPC veto allows, and
// with or without a live IPC connection.
func TestServerUnavailableAgentIsNeverRestartedOnStaleHeartbeat(t *testing.T) {
	t.Parallel()
	for _, ipcUp := range []bool{true, false} {
		hc := NewHealthChecker(nil, nil, 3*time.Minute)
		for i := 0; i < staleVetoLimit*4; i++ {
			s := &state.AgentState{
				LastHeartbeat:       time.Now().Add(-6 * time.Hour),
				ServerUnavailableAt: time.Now().Add(-45 * time.Second),
			}
			d, _ := hc.EvaluateStaleHeartbeat(s, ipcUp)
			if d != StaleServerUnavailable {
				t.Fatalf("ipcUp=%v tick %d: decision=%v, want StaleServerUnavailable — an agent answered by an overloaded server was sent to restart", ipcUp, i, d)
			}
		}
	}
}

// The wedged-agent case must still restart: a marker older than the stale
// threshold means the heartbeat loop that refreshes it has stopped making
// attempts too.
func TestStaleServerUnavailableMarkerDoesNotMaskAWedgedAgent(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{
		LastHeartbeat:       time.Now().Add(-6 * time.Hour),
		ServerUnavailableAt: time.Now().Add(-10 * time.Minute),
	}
	var restarted bool
	for i := 0; i < staleVetoLimit; i++ {
		if d, _ := hc.EvaluateStaleHeartbeat(s, true); d == StaleRestart {
			restarted = true
			break
		}
	}
	if !restarted {
		t.Fatal("stale server-unavailable marker suppressed the bounded restart escalation")
	}
}

// AV/EDR hosts cannot write agent.state (#2763): the IPC state_sync copy of
// the marker must carry the same weight as the file's.
func TestServerUnavailableViaStateSyncWithoutStateFile(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	hc.NoteStateSync(time.Now().Add(-time.Hour), 0) // last success an hour ago
	hc.NoteServerUnavailable(time.Now().Add(-20 * time.Second))
	for i := 0; i < staleVetoLimit*2; i++ {
		if d, _ := hc.EvaluateStaleHeartbeat(nil, true); d != StaleServerUnavailable {
			t.Fatalf("tick %d: decision=%v, want StaleServerUnavailable", i, d)
		}
	}
	if !hc.AgentAlive(nil) {
		t.Fatal("AgentAlive=false for an agent reporting a fresh server-unavailable answer over IPC")
	}
	if !hc.LastKnownHeartbeat(nil).Before(time.Now().Add(-30 * time.Minute)) {
		t.Fatal("the server-unavailable marker was recorded as a successful heartbeat")
	}
}

// The overload hold must not bank veto budget: once the server recovers and
// the heartbeat later wedges, escalation takes the normal path.
func TestServerUnavailableHoldResetsStaleVetoBudget(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	stale := &state.AgentState{LastHeartbeat: time.Now().Add(-time.Hour)}
	if d, _ := hc.EvaluateStaleHeartbeat(stale, true); d != StaleVetoed {
		t.Fatalf("setup: decision=%v, want StaleVetoed", d)
	}
	busy := &state.AgentState{LastHeartbeat: time.Now().Add(-time.Hour), ServerUnavailableAt: time.Now()}
	if d, _ := hc.EvaluateStaleHeartbeat(busy, true); d != StaleServerUnavailable {
		t.Fatalf("decision=%v, want StaleServerUnavailable", d)
	}
	if got := hc.StaleVetoCount(); got != 0 {
		t.Fatalf("StaleVetoCount=%d after server-unavailable hold, want 0", got)
	}
}

// A never-heartbeated agent that has been answered by the server is past
// startup: once that marker goes stale (its loop wedged) the staleness check
// fires instead of granting startup grace forever.
func TestExpiredServerUnavailableMarkerEndsStartupGrace(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{ServerUnavailableAt: time.Now().Add(-10 * time.Minute)}
	if got := hc.CheckHeartbeatStaleness(s); got != CheckHeartbeatStale {
		t.Fatalf("CheckHeartbeatStaleness = %q, want %q", got, CheckHeartbeatStale)
	}
	if got := hc.CheckHeartbeatStaleness(&state.AgentState{ServerUnavailableAt: time.Now()}); got != CheckOK {
		t.Fatalf("fresh marker, no heartbeat: CheckHeartbeatStaleness = %q, want ok", got)
	}
}

// Auth rejection is the more specific diagnosis and keeps its own decision
// when both markers are fresh.
func TestAuthRejectedWinsOverServerUnavailable(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{
		LastHeartbeat:       time.Now().Add(-time.Hour),
		AuthRejectedAt:      time.Now(),
		ServerUnavailableAt: time.Now(),
	}
	if d, _ := hc.EvaluateStaleHeartbeat(s, true); d != StaleAuthRejected {
		t.Fatalf("decision=%v, want StaleAuthRejected", d)
	}
}

func TestAgentAliveServerUnavailable(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	if !hc.AgentAlive(&state.AgentState{ServerUnavailableAt: time.Now()}) {
		t.Fatal("AgentAlive=false with a fresh server-unavailable marker")
	}
	if hc.AgentAlive(&state.AgentState{ServerUnavailableAt: time.Now().Add(-time.Hour)}) {
		t.Fatal("AgentAlive=true with only a stale server-unavailable marker")
	}
}
