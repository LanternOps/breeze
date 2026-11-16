package watchdog

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// #8868: an agent whose control plane is blocked by a network filter is alive
// and a restart cannot lift the filter. A fresh marker holds the restart.
func TestEvaluateStaleHeartbeat_FreshControlPlaneBlockedHoldsRestart(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{
		LastHeartbeat:         time.Now().Add(-6 * time.Hour),
		ControlPlaneBlockedAt: time.Now(),
	}
	for i := 0; i < staleVetoLimit+2; i++ {
		d, _ := hc.EvaluateStaleHeartbeat(s, false)
		if d != StaleControlPlaneBlocked {
			t.Fatalf("tick %d: decision=%v, want StaleControlPlaneBlocked", i, d)
		}
	}
}

func TestEvaluateStaleHeartbeat_StaleControlPlaneBlockedRestarts(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{
		LastHeartbeat:         time.Now().Add(-6 * time.Hour),
		ControlPlaneBlockedAt: time.Now().Add(-10 * time.Minute),
	}
	var restarted bool
	for i := 0; i < staleVetoLimit+1; i++ {
		d, _ := hc.EvaluateStaleHeartbeat(s, true)
		if d == StaleControlPlaneBlocked {
			t.Fatal("stale marker still held the restart")
		}
		if d == StaleRestart {
			restarted = true
			break
		}
	}
	if !restarted {
		t.Fatal("stale blocked marker suppressed the bounded restart escalation")
	}
}

func TestCheckHeartbeatStaleness_UsesControlPlaneBlockedReference(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	if got := hc.CheckHeartbeatStaleness(&state.AgentState{ControlPlaneBlockedAt: time.Now().Add(-10 * time.Minute)}); got != CheckHeartbeatStale {
		t.Fatalf("expired marker, no heartbeat: got %q, want %q", got, CheckHeartbeatStale)
	}
	if got := hc.CheckHeartbeatStaleness(&state.AgentState{ControlPlaneBlockedAt: time.Now()}); got != CheckOK {
		t.Fatalf("fresh marker, no heartbeat: got %q, want ok", got)
	}
}

func TestAgentAlive_FreshControlPlaneBlockedMarker(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	if !hc.AgentAlive(&state.AgentState{ControlPlaneBlockedAt: time.Now()}) {
		t.Fatal("AgentAlive=false with a fresh control-plane-blocked marker")
	}
	if hc.AgentAlive(&state.AgentState{ControlPlaneBlockedAt: time.Now().Add(-time.Hour)}) {
		t.Fatal("AgentAlive=true with only a stale control-plane-blocked marker")
	}
	hc2 := NewHealthChecker(nil, nil, 3*time.Minute)
	hc2.NoteControlPlaneBlocked(time.Now())
	if !hc2.AgentControlPlaneBlockedAlive(nil) {
		t.Fatal("IPC-synced marker not honoured")
	}
}
