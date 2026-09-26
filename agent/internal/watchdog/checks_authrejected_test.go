package watchdog

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// #2796 defect A: an agent whose credentials the server rejects is alive and
// correctly backing off — it never takes the HTTP-200 path, so LastHeartbeat
// goes stale. Restarting it cannot repair a rejected credential and discards
// the agent's in-memory backoff every time. A fresh auth-rejected marker must
// hold off the stale-heartbeat restart for as long as it stays fresh — NOT
// just for the staleVetoLimit-1 ticks the IPC corroboration veto allows.
func TestAuthRejectedAgentIsNeverRestartedOnStaleHeartbeat(t *testing.T) {
	t.Parallel()
	for _, ipcUp := range []bool{true, false} {
		hc := NewHealthChecker(nil, nil, 3*time.Minute)
		for i := 0; i < staleVetoLimit*4; i++ {
			s := &state.AgentState{
				LastHeartbeat:  time.Now().Add(-6 * time.Hour),
				AuthRejectedAt: time.Now().Add(-30 * time.Second),
			}
			d, _ := hc.EvaluateStaleHeartbeat(s, ipcUp)
			if d != StaleAuthRejected {
				t.Fatalf("ipcUp=%v tick %d: decision=%v, want StaleAuthRejected — an auth-rejected agent was sent to restart", ipcUp, i, d)
			}
		}
	}
}

// The marker only proves liveness while fresh. A marker older than the stale
// threshold means the heartbeat loop that writes it has stopped too, which is
// the wedged-agent case the staleness check exists for (#2763 must not regress).
func TestStaleAuthRejectedMarkerDoesNotMaskAWedgedAgent(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{
		LastHeartbeat:  time.Now().Add(-6 * time.Hour),
		AuthRejectedAt: time.Now().Add(-10 * time.Minute),
	}
	var restarted bool
	for i := 0; i < staleVetoLimit; i++ {
		if d, _ := hc.EvaluateStaleHeartbeat(s, true); d == StaleRestart {
			restarted = true
			break
		}
	}
	if !restarted {
		t.Fatal("stale auth-rejected marker suppressed the bounded restart escalation")
	}
}

// On AV/EDR boxes agent.state is unwritable (#2763): the IPC state_sync copy
// of the marker must carry the same weight as the file's.
func TestAuthRejectedViaStateSyncWithoutStateFile(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	hc.NoteAuthRejected(time.Now().Add(-20 * time.Second))
	for i := 0; i < staleVetoLimit*2; i++ {
		if d, _ := hc.EvaluateStaleHeartbeat(nil, true); d != StaleAuthRejected {
			t.Fatalf("tick %d: decision=%v, want StaleAuthRejected", i, d)
		}
	}
	if !hc.AgentAlive(nil) {
		t.Fatal("AgentAlive=false for an agent reporting a fresh auth rejection over IPC")
	}
}

// The auth-rejected hold must not bank veto budget: once credentials work
// again and the heartbeat later wedges, escalation takes the normal path.
func TestAuthRejectedHoldResetsStaleVetoBudget(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	stale := &state.AgentState{LastHeartbeat: time.Now().Add(-time.Hour)}
	if d, _ := hc.EvaluateStaleHeartbeat(stale, true); d != StaleVetoed {
		t.Fatalf("setup: decision=%v, want StaleVetoed", d)
	}
	rejected := &state.AgentState{LastHeartbeat: time.Now().Add(-time.Hour), AuthRejectedAt: time.Now()}
	if d, _ := hc.EvaluateStaleHeartbeat(rejected, true); d != StaleAuthRejected {
		t.Fatalf("decision=%v, want StaleAuthRejected", d)
	}
	if got := hc.StaleVetoCount(); got != 0 {
		t.Fatalf("StaleVetoCount=%d after auth-rejected hold, want 0", got)
	}
}

func TestAgentAliveFreshHeartbeat(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	if hc.AgentAlive(&state.AgentState{}) {
		t.Fatal("AgentAlive=true with no evidence at all")
	}
	if !hc.AgentAlive(&state.AgentState{LastHeartbeat: time.Now()}) {
		t.Fatal("AgentAlive=false with a fresh heartbeat")
	}
	if hc.AgentAlive(&state.AgentState{LastHeartbeat: time.Now().Add(-time.Hour)}) {
		t.Fatal("AgentAlive=true with only a stale heartbeat")
	}
}
