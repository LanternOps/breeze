package watchdog

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// mockProcessChecker is a test double for ProcessChecker.
type mockProcessChecker struct {
	alive  bool
	zombie bool
}

func (m *mockProcessChecker) IsAlive(_ int) bool  { return m.alive }
func (m *mockProcessChecker) IsZombie(_ int) bool { return m.zombie }

// mockIPCProber is a test double for IPCProber.
type mockIPCProber struct {
	healthy bool
	err     error
}

func (m *mockIPCProber) Ping() (bool, error) { return m.healthy, m.err }

// TestTier1ProcessAlive verifies that a live non-zombie process returns CheckOK.
func TestTier1ProcessAlive(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(&mockProcessChecker{alive: true, zombie: false}, nil, 3*time.Minute)
	if got := hc.CheckProcess(1); got != CheckOK {
		t.Fatalf("expected %q, got %q", CheckOK, got)
	}
}

// TestTier1ProcessDead verifies that a dead process returns CheckProcessGone.
func TestTier1ProcessDead(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(&mockProcessChecker{alive: false, zombie: false}, nil, 3*time.Minute)
	if got := hc.CheckProcess(1); got != CheckProcessGone {
		t.Fatalf("expected %q, got %q", CheckProcessGone, got)
	}
}

// TestTier1ProcessZombie verifies that a zombie process (alive=true but zombie=true)
// returns CheckProcessGone.
func TestTier1ProcessZombie(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(&mockProcessChecker{alive: true, zombie: true}, nil, 3*time.Minute)
	if got := hc.CheckProcess(1); got != CheckProcessGone {
		t.Fatalf("expected %q, got %q", CheckProcessGone, got)
	}
}

// TestTier2IPCHealthy verifies that a successful ping returns CheckOK and
// resets the fail counter to zero.
func TestTier2IPCHealthy(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, &mockIPCProber{healthy: true}, 3*time.Minute)
	if got := hc.CheckIPC(); got != CheckOK {
		t.Fatalf("expected %q, got %q", CheckOK, got)
	}
	if hc.IPCFailCount() != 0 {
		t.Fatalf("expected failCount=0, got %d", hc.IPCFailCount())
	}
}

// TestTier2IPCFailure verifies that three consecutive failures return CheckIPCFailed.
func TestTier2IPCFailure(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, &mockIPCProber{healthy: false}, 3*time.Minute)
	for i := 0; i < ipcFailThreshold-1; i++ {
		result := hc.CheckIPC()
		if result != CheckIPCDegraded {
			t.Fatalf("iteration %d: expected %q, got %q", i+1, CheckIPCDegraded, result)
		}
	}
	if got := hc.CheckIPC(); got != CheckIPCFailed {
		t.Fatalf("expected %q after %d failures, got %q", CheckIPCFailed, ipcFailThreshold, got)
	}
}

// TestTier2IPCRecovery verifies that two failures followed by a success returns
// CheckOK and resets the fail counter.
func TestTier2IPCRecovery(t *testing.T) {
	t.Parallel()
	prober := &mockIPCProber{healthy: false}
	hc := NewHealthChecker(nil, prober, 3*time.Minute)

	// Two failures — below threshold.
	hc.CheckIPC()
	hc.CheckIPC()
	if hc.IPCFailCount() != 2 {
		t.Fatalf("expected failCount=2 after two failures, got %d", hc.IPCFailCount())
	}

	// Recovery.
	prober.healthy = true
	if got := hc.CheckIPC(); got != CheckOK {
		t.Fatalf("expected %q on recovery, got %q", CheckOK, got)
	}
	if hc.IPCFailCount() != 0 {
		t.Fatalf("expected failCount=0 after recovery, got %d", hc.IPCFailCount())
	}
}

// TestTier3HeartbeatFresh verifies that a recent heartbeat returns CheckOK.
func TestTier3HeartbeatFresh(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-1 * time.Minute)}
	if got := hc.CheckHeartbeatStaleness(s); got != CheckOK {
		t.Fatalf("expected %q, got %q", CheckOK, got)
	}
}

// TestTier3HeartbeatStale verifies that an old heartbeat returns CheckHeartbeatStale.
func TestTier3HeartbeatStale(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-5 * time.Minute)}
	if got := hc.CheckHeartbeatStaleness(s); got != CheckHeartbeatStale {
		t.Fatalf("expected %q, got %q", CheckHeartbeatStale, got)
	}
}

// TestTier3HeartbeatNeverSet verifies that a zero-value LastHeartbeat returns
// CheckOK (grace period — agent hasn't sent a heartbeat yet).
func TestTier3HeartbeatNeverSet(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{} // LastHeartbeat is zero value
	if got := hc.CheckHeartbeatStaleness(s); got != CheckOK {
		t.Fatalf("expected %q for zero heartbeat (grace period), got %q", CheckOK, got)
	}
}

func TestShouldRestartOnStaleHeartbeat(t *testing.T) {
	t.Parallel()

	t.Run("ipc disconnected allows restart immediately", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{}, 3*time.Minute)
		if !hc.ShouldRestartOnStaleHeartbeat(false) {
			t.Error("disconnected IPC should allow restart")
		}
	})

	t.Run("ipc connected but probe failing allows restart immediately", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{healthy: false}, 3*time.Minute)
		hc.CheckIPC() // records one probe failure
		if hc.IPCFailCount() != 1 {
			t.Fatalf("IPCFailCount = %d, want 1", hc.IPCFailCount())
		}
		if !hc.ShouldRestartOnStaleHeartbeat(true) {
			t.Error("failing IPC probes should allow restart")
		}
	})

	t.Run("ipc alive vetoes until staleVetoLimit consecutive verdicts", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{healthy: true}, 3*time.Minute)
		for i := 1; i < staleVetoLimit; i++ {
			if hc.ShouldRestartOnStaleHeartbeat(true) {
				t.Fatalf("veto %d/%d should suppress restart", i, staleVetoLimit)
			}
			if hc.StaleVetoCount() != i {
				t.Fatalf("StaleVetoCount = %d, want %d", hc.StaleVetoCount(), i)
			}
		}
		// The limit-th consecutive stale verdict escalates despite live IPC.
		if !hc.ShouldRestartOnStaleHeartbeat(true) {
			t.Error("stale verdicts past the veto limit must force a restart")
		}
		if hc.StaleVetoCount() != 0 {
			t.Errorf("StaleVetoCount = %d after escalation, want 0", hc.StaleVetoCount())
		}
	})

	t.Run("fresh heartbeat re-arms the veto budget", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{healthy: true}, 3*time.Minute)
		if hc.ShouldRestartOnStaleHeartbeat(true) {
			t.Fatal("first veto should suppress restart")
		}
		// A fresh heartbeat clears the consecutive-veto count...
		fresh := &state.AgentState{LastHeartbeat: time.Now()}
		if got := hc.CheckHeartbeatStaleness(fresh); got != CheckOK {
			t.Fatalf("CheckHeartbeatStaleness = %q, want %q", got, CheckOK)
		}
		if hc.StaleVetoCount() != 0 {
			t.Fatalf("StaleVetoCount = %d after fresh heartbeat, want 0", hc.StaleVetoCount())
		}
		// ...so sporadic stale verdicts hours apart don't accumulate.
		if hc.ShouldRestartOnStaleHeartbeat(true) {
			t.Error("veto budget should restart from zero after a fresh heartbeat")
		}
	})

	t.Run("restart decision resets the veto count", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{healthy: true}, 3*time.Minute)
		if hc.ShouldRestartOnStaleHeartbeat(true) {
			t.Fatal("first veto should suppress restart")
		}
		if !hc.ShouldRestartOnStaleHeartbeat(false) {
			t.Fatal("disconnected IPC should allow restart")
		}
		if hc.StaleVetoCount() != 0 {
			t.Errorf("StaleVetoCount = %d after restart decision, want 0", hc.StaleVetoCount())
		}
	})
}
