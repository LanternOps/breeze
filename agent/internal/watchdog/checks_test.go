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

// TestEvaluateStaleHeartbeat exercises the complete heartbeat-ticker decision
// (staleness + bounded veto) — the seam main.go's ticker branch calls, so the
// incident path (stale file + live IPC must not restart) is proven end to end
// at the decision layer.
func TestEvaluateStaleHeartbeat(t *testing.T) {
	t.Parallel()
	stale := &state.AgentState{LastHeartbeat: time.Now().Add(-10 * time.Minute)}
	fresh := &state.AgentState{LastHeartbeat: time.Now()}

	t.Run("stale with live IPC vetoes then escalates with context", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{healthy: true}, 3*time.Minute)
		for i := 1; i < staleVetoLimit; i++ {
			decision, vetoes := hc.EvaluateStaleHeartbeat(stale, true)
			if decision != StaleVetoed {
				t.Fatalf("verdict %d: decision = %v, want StaleVetoed", i, decision)
			}
			if vetoes != i {
				t.Fatalf("verdict %d: vetoes = %d, want %d", i, vetoes, i)
			}
		}
		decision, vetoes := hc.EvaluateStaleHeartbeat(stale, true)
		if decision != StaleRestart {
			t.Fatalf("limit-th verdict: decision = %v, want StaleRestart", decision)
		}
		// vetoesBefore > 0 with live IPC is the forced-escalation marker
		// operators use to distinguish a wedged-heartbeat-goroutine restart
		// from a routine dead-agent restart.
		if vetoes != staleVetoLimit-1 {
			t.Errorf("escalation vetoesBefore = %d, want %d", vetoes, staleVetoLimit-1)
		}
	})

	t.Run("stale with disconnected IPC restarts immediately with zero vetoes", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{}, 3*time.Minute)
		decision, vetoes := hc.EvaluateStaleHeartbeat(stale, false)
		if decision != StaleRestart || vetoes != 0 {
			t.Errorf("= (%v, %d), want (StaleRestart, 0)", decision, vetoes)
		}
	})

	t.Run("fresh heartbeat returns OK and resets the budget", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{healthy: true}, 3*time.Minute)
		if d, _ := hc.EvaluateStaleHeartbeat(stale, true); d != StaleVetoed {
			t.Fatalf("stale verdict = %v, want StaleVetoed", d)
		}
		if d, _ := hc.EvaluateStaleHeartbeat(fresh, true); d != HeartbeatOK {
			t.Fatalf("fresh verdict = %v, want HeartbeatOK", d)
		}
		if d, vetoes := hc.EvaluateStaleHeartbeat(stale, true); d != StaleVetoed || vetoes != 1 {
			t.Errorf("post-fresh stale = (%v, %d), want (StaleVetoed, 1)", d, vetoes)
		}
	})

	t.Run("startup grace resets the budget for a restarted agent", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{healthy: true}, 3*time.Minute)
		if d, _ := hc.EvaluateStaleHeartbeat(stale, true); d != StaleVetoed {
			t.Fatalf("stale verdict = %v, want StaleVetoed", d)
		}
		// Startup grace: state exists but LastHeartbeat is still zero.
		if d, _ := hc.EvaluateStaleHeartbeat(&state.AgentState{}, true); d != HeartbeatOK {
			t.Fatalf("grace verdict = %v, want HeartbeatOK", d)
		}
		if hc.StaleVetoCount() != 0 {
			t.Errorf("StaleVetoCount = %d after grace period, want 0", hc.StaleVetoCount())
		}
	})

	t.Run("nil state is stale", func(t *testing.T) {
		t.Parallel()
		hc := NewHealthChecker(&mockProcessChecker{}, &mockIPCProber{}, 3*time.Minute)
		if d, _ := hc.EvaluateStaleHeartbeat(nil, false); d != StaleRestart {
			t.Errorf("nil state = %v, want StaleRestart", d)
		}
	})
}

// --- State-sync corroboration (#2763): the freshest of (file, IPC state_sync)
// drives staleness. A missing/frozen agent.state with live state_syncs is a
// blocked WRITER (AV/EDR), not a dead agent — field-confirmed 2026-07-24 where
// the watchdog killed a heartbeating agent 5x and stranded it stopped.

func TestStaleFileVetoedByFreshStateSync(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-30 * time.Minute)} // file frozen
	if got := hc.CheckHeartbeatStaleness(s); got != CheckHeartbeatStale {
		t.Fatalf("precondition: frozen file should be stale, got %q", got)
	}
	hc.NoteStateSync(time.Now().Add(-20*time.Second), 0) // agent just heartbeated

	if got := hc.CheckHeartbeatStaleness(s); got != CheckOK {
		t.Fatalf("fresh state_sync must override frozen file: expected %q, got %q", CheckOK, got)
	}
}

func TestNilFileWithFreshStateSyncIsOK(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	// The field shape: agent.state was NEVER writable, state.Read fails
	// forever, agentState stays nil — but state_syncs flow.
	hc.NoteStateSync(time.Now().Add(-10*time.Second), 0)
	if got := hc.CheckHeartbeatStaleness(nil); got != CheckOK {
		t.Fatalf("nil file with fresh sync must be OK: got %q", got)
	}
}

func TestNilFileWithoutAnySyncStaysStale(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	if got := hc.CheckHeartbeatStaleness(nil); got != CheckHeartbeatStale {
		t.Fatalf("nil file and no sync ever must remain stale: got %q", got)
	}
}

func TestStaleSyncDoesNotMaskFreshFile(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	hc.NoteStateSync(time.Now().Add(-1*time.Hour), 0)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-5 * time.Second)}
	if got := hc.CheckHeartbeatStaleness(s); got != CheckOK {
		t.Fatalf("fresh file must win over stale sync: got %q", got)
	}
}

func TestBothSourcesStaleIsStale(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	hc.NoteStateSync(time.Now().Add(-10*time.Minute), 0)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-20 * time.Minute)}
	if got := hc.CheckHeartbeatStaleness(s); got != CheckHeartbeatStale {
		t.Fatalf("both sources stale must be stale: got %q", got)
	}
}

func TestNoteStateSyncNeverRegresses(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	fresh := time.Now().Add(-10 * time.Second)
	hc.NoteStateSync(fresh, 0)
	hc.NoteStateSync(fresh.Add(-1*time.Hour), 0) // out-of-order older value

	if got := hc.LastKnownHeartbeat(nil); !got.Equal(fresh) {
		t.Fatalf("older sync must not regress stored heartbeat: got %v want %v", got, fresh)
	}
}

func TestFreshSyncReArmsStaleVetoBudget(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	stale := &state.AgentState{LastHeartbeat: time.Now().Add(-30 * time.Minute)}
	// Burn one veto against the stale file.
	if d, _ := hc.EvaluateStaleHeartbeat(stale, true); d != StaleVetoed {
		t.Fatalf("expected first stale verdict to be vetoed")
	}
	// Agent heartbeats (sync arrives) → staleness clears AND veto budget re-arms.
	hc.NoteStateSync(time.Now(), 0)
	if d, _ := hc.EvaluateStaleHeartbeat(stale, true); d != HeartbeatOK {
		t.Fatalf("fresh sync must clear staleness")
	}
	if hc.StaleVetoCount() != 0 {
		t.Fatalf("fresh sync must re-arm veto budget, count=%d", hc.StaleVetoCount())
	}
}

func TestLastKnownHeartbeatPicksFreshest(t *testing.T) {
	t.Parallel()
	hc := NewHealthChecker(nil, nil, 3*time.Minute)
	fileHB := time.Now().Add(-2 * time.Minute)
	syncHB := time.Now().Add(-1 * time.Minute)
	hc.NoteStateSync(syncHB, 0)
	s := &state.AgentState{LastHeartbeat: fileHB}
	if got := hc.LastKnownHeartbeat(s); !got.Equal(syncHB) {
		t.Fatalf("expected sync heartbeat (fresher), got %v", got)
	}
	if got := hc.LastKnownHeartbeat(nil); !got.Equal(syncHB) {
		t.Fatalf("nil file: expected sync heartbeat, got %v", got)
	}
}

// --- IPC veto while a backup run is in flight (D3): during a 10k-file
// backup on Windows Server 2022 the IPC ping/pong round trip intermittently
// exceeded IPCProbeInterval under load, so CheckIPC escalated straight to
// CheckIPCFailed -> graceful_restart -> StopBackupHelper killed the helper
// mid-run (9,751/10,046 files done). There was no in-flight-backup veto
// anywhere in the watchdog before this. The veto below fires only while a
// backup is actually running AND a recent state_sync corroborates the agent
// is alive, and it is bounded (ipcVetoLimit) so a genuinely wedged agent
// that keeps reporting an active run still gets restarted eventually.

// TestCheckIPCVetoedWhileBackupInFlightWithFreshSync covers case (a): three
// consecutive IPC failures with an active backup run and a fresh state_sync
// must NOT escalate to CheckIPCFailed, and the veto must be counted.
func TestCheckIPCVetoedWhileBackupInFlightWithFreshSync(t *testing.T) {
	t.Parallel()
	prober := &mockIPCProber{healthy: false}
	hc := NewHealthChecker(nil, prober, 3*time.Minute)
	hc.SetIPCProbeInterval(50 * time.Millisecond)
	hc.NoteStateSync(time.Now(), 1) // backup running, sync just arrived

	var last string
	for i := 0; i < ipcFailThreshold; i++ {
		last = hc.CheckIPC()
	}
	if last != CheckIPCDegraded {
		t.Fatalf("expected veto to hold escalation at %q, got %q", CheckIPCDegraded, last)
	}
	if got := hc.IPCVetoCount(); got != 1 {
		t.Fatalf("expected exactly one veto to be counted, got %d", got)
	}
	if !hc.LastIPCCheckVetoed() {
		t.Fatal("expected the threshold-crossing check to be flagged as vetoed")
	}
}

// TestCheckIPCFailsWithoutActiveBackupRun covers case (b): the same failure
// sequence with ActiveBackupRuns=0 must reproduce the existing behaviour —
// CheckIPCFailed on the 3rd consecutive failure, no veto.
func TestCheckIPCFailsWithoutActiveBackupRun(t *testing.T) {
	t.Parallel()
	prober := &mockIPCProber{healthy: false}
	hc := NewHealthChecker(nil, prober, 3*time.Minute)
	hc.SetIPCProbeInterval(50 * time.Millisecond)
	hc.NoteStateSync(time.Now(), 0) // sync fresh, but no backup running

	var last string
	for i := 0; i < ipcFailThreshold; i++ {
		last = hc.CheckIPC()
	}
	if last != CheckIPCFailed {
		t.Fatalf("expected existing behaviour (fail at threshold) with no active run, got %q", last)
	}
	if hc.LastIPCCheckVetoed() {
		t.Fatal("must not report a veto when no backup run is active")
	}
}

// TestCheckIPCVetoLimitExhausted covers case (c): once ipcVetoLimit
// consecutive vetoes have been consumed, the next threshold-crossing failure
// must escalate anyway, even though the backup run is still reported active
// and the sync stays fresh — otherwise a wedged agent could dodge restarts
// forever just by keeping ActiveBackupRuns above zero.
func TestCheckIPCVetoLimitExhausted(t *testing.T) {
	t.Parallel()
	prober := &mockIPCProber{healthy: false}
	hc := NewHealthChecker(nil, prober, 3*time.Minute)
	hc.SetIPCProbeInterval(50 * time.Millisecond)

	var last string
	total := (ipcFailThreshold - 1) + ipcVetoLimit + 1
	for i := 0; i < total; i++ {
		hc.NoteStateSync(time.Now(), 1) // keep the sync fresh on every tick
		last = hc.CheckIPC()
	}
	if last != CheckIPCFailed {
		t.Fatalf("expected escalation once the veto budget (%d) is exhausted, got %q", ipcVetoLimit, last)
	}
}

// TestCheckIPCVetoDoesNotApplyToStaleSync covers case (d): a state_sync
// older than the recency window (ipcVetoRecencyMultiplier *
// IPCProbeInterval) must not corroborate liveness, so the escalation must
// proceed exactly as if no backup were reported running.
func TestCheckIPCVetoDoesNotApplyToStaleSync(t *testing.T) {
	t.Parallel()
	prober := &mockIPCProber{healthy: false}
	hc := NewHealthChecker(nil, prober, 3*time.Minute)
	hc.SetIPCProbeInterval(10 * time.Millisecond) // recency window = 30ms
	hc.NoteStateSync(time.Now(), 1)
	time.Sleep(100 * time.Millisecond) // well past the 30ms recency window

	var last string
	for i := 0; i < ipcFailThreshold; i++ {
		last = hc.CheckIPC()
	}
	if last != CheckIPCFailed {
		t.Fatalf("stale sync must not veto escalation, got %q", last)
	}
	if hc.LastIPCCheckVetoed() {
		t.Fatal("stale sync must not be flagged as vetoed")
	}
}
