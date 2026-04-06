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
