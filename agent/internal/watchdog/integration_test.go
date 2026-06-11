package watchdog

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// integHarness wires a fake state file, fake serviceController, fake clock,
// and a real RecoveryManager + Watchdog state machine. The Tick() method
// drives the same logic as main.go's end-of-tick RECOVERING switch.
type integHarness struct {
	t               *testing.T
	clk             *fakeClock
	svc             *noopServiceController
	wd              *Watchdog
	recovery        *RecoveryManager
	stateFile       string
	maxPer24h       int
	verifyGrace     time.Duration
	verifyTimeout   time.Duration
	pendingVerifyAt time.Time // zero = no pending verification
}

func newIntegHarness(t *testing.T) *integHarness {
	t.Helper()
	dir := t.TempDir()
	clk := &fakeClock{now: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)}
	svc := &noopServiceController{}
	rm := newRecoveryManagerWithDeps(3, 10*time.Minute, svc, clk)
	rm.SetHistoryPath(filepath.Join(dir, "history.json"))

	cfg := Config{
		ProcessCheckInterval:    5 * time.Second,
		IPCProbeInterval:        30 * time.Second,
		HeartbeatStaleThreshold: 3 * time.Minute,
		MaxRecoveryAttempts:     3,
		RecoveryCooldown:        10 * time.Minute,
		StandbyTimeout:          30 * time.Minute,
		FailoverPollInterval:    30 * time.Second,
	}
	wd := NewWatchdog(cfg)
	// Start in RECOVERING for scenario simplicity — the real loop also
	// reaches RECOVERING via CONNECTING→MONITORING→AgentUnhealthy or
	// CONNECTING→AgentUnhealthy; we skip the prelude.
	wd.HandleEvent(EventAgentNotFound) // CONNECTING → RECOVERING

	return &integHarness{
		t:             t,
		clk:           clk,
		svc:           svc,
		wd:            wd,
		recovery:      rm,
		stateFile:     filepath.Join(dir, "agent.state"),
		maxPer24h:     5,
		verifyGrace:   30 * time.Second,
		verifyTimeout: 120 * time.Second,
	}
}

// writeAgentState writes a minimal state file with the given LastHeartbeat.
func (h *integHarness) writeAgentState(lastHb time.Time) {
	h.t.Helper()
	s := &state.AgentState{
		PID:           4242,
		Status:        "running",
		LastHeartbeat: lastHb,
		Timestamp:     h.clk.Now(),
	}
	if err := state.Write(h.stateFile, s); err != nil {
		h.t.Fatalf("writeAgentState: %v", err)
	}
}

// Tick runs the same logic as the production main.go end-of-tick switch for
// StateRecovering / StateMonitoring / StateFailover. It does NOT run the
// process/IPC/heartbeat tickers — scenarios drive AgentUnhealthy events
// directly.
func (h *integHarness) Tick() {
	switch h.wd.State() {
	case StateRecovering:
		h.tickRecovering()
	case StateMonitoring:
		h.recovery.Reset()
		h.pendingVerifyAt = time.Time{}
	case StateFailover:
		h.pendingVerifyAt = time.Time{}
	}
}

func (h *integHarness) tickRecovering() {
	// Verification gate.
	if !h.pendingVerifyAt.IsZero() {
		elapsed := h.clk.Now().Sub(h.pendingVerifyAt)
		s, _ := state.Read(h.stateFile)
		verifyDeadline := h.pendingVerifyAt.Add(h.verifyGrace)
		if s != nil && s.LastHeartbeat.After(verifyDeadline) {
			h.pendingVerifyAt = time.Time{}
			h.wd.HandleEvent(EventAgentRecovered)
			return
		}
		if elapsed > h.verifyTimeout {
			h.pendingVerifyAt = time.Time{}
		}
		return
	}
	// Flap gate.
	if h.recovery.Count24h() >= h.maxPer24h {
		h.wd.HandleEvent(EventRecoveryExhausted)
		return
	}
	if !h.recovery.CanAttempt() {
		h.wd.HandleEvent(EventRecoveryExhausted)
		return
	}
	ok, _ := h.recovery.Attempt(4242)
	if ok {
		h.pendingVerifyAt = h.clk.Now()
	}
}

func Test_HeartbeatStale_TriggersRestartWithinTwoIntervals(t *testing.T) {
	h := newIntegHarness(t)
	// State file shows the agent went silent 5 min ago.
	h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))

	// First tick in RECOVERING: should attempt one restart and enter verify.
	h.Tick()
	if h.svc.restarts != 1 {
		t.Fatalf("first tick: want 1 SCM restart, got %d", h.svc.restarts)
	}
	if h.pendingVerifyAt.IsZero() {
		t.Fatal("first tick: want pendingVerifyAt set, got zero")
	}

	// Advance past grace and write a fresh heartbeat — simulating recovery.
	h.clk.Advance(h.verifyGrace + time.Second)
	h.writeAgentState(h.clk.Now())

	// Second tick: should verify and return to MONITORING.
	h.Tick()
	if h.wd.State() != StateMonitoring {
		t.Fatalf("after verification: want MONITORING, got %s", h.wd.State())
	}
	if h.recovery.Count24h() != 1 {
		t.Fatalf("Count24h after one recovery: want 1, got %d", h.recovery.Count24h())
	}
}

func Test_OptimisticRestart_DoesNotResetCounter(t *testing.T) {
	h := newIntegHarness(t)
	h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))

	// Cycle 5 times: each restart "succeeds" at the SCM level but the
	// heartbeat never advances, so the verification gate times out.
	for cycle := 1; cycle <= 5; cycle++ {
		// Attempt tick.
		h.Tick()
		if h.svc.restarts != cycle {
			t.Fatalf("cycle %d: want %d total SCM restarts, got %d", cycle, cycle, h.svc.restarts)
		}
		// Verification timeout.
		h.clk.Advance(h.verifyTimeout + time.Second)
		h.Tick()
		if h.wd.State() != StateRecovering {
			t.Fatalf("cycle %d: want still RECOVERING after timeout, got %s", cycle, h.wd.State())
		}
		if !h.pendingVerifyAt.IsZero() {
			t.Fatalf("cycle %d: pendingVerifyAt should be cleared after timeout", cycle)
		}
		// Reset per-window counter manually to model the cooldown elapsing
		// (otherwise CanAttempt() would block us at attempts=3).
		h.recovery.Reset()
	}

	if got := h.recovery.Count24h(); got != 5 {
		t.Fatalf("Count24h after 5 failed cycles: want 5, got %d", got)
	}

	// Sixth tick should flap-escalate.
	h.Tick()
	if h.wd.State() != StateFailover {
		t.Fatalf("after 5 flaps: want FAILOVER, got %s", h.wd.State())
	}
}

func Test_RealRecovery_ClearsPerWindowCounter_NotHistory(t *testing.T) {
	h := newIntegHarness(t)

	// Two clean restart cycles.
	for cycle := 1; cycle <= 2; cycle++ {
		h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))
		h.Tick() // attempt
		h.clk.Advance(h.verifyGrace + time.Second)
		h.writeAgentState(h.clk.Now()) // heartbeat resumed
		h.Tick()                       // verify success
		if h.wd.State() != StateMonitoring {
			t.Fatalf("cycle %d: want MONITORING after recovery, got %s", cycle, h.wd.State())
		}
		// MONITORING tick should reset per-window attempts.
		h.Tick()
		if h.recovery.Attempts() != 0 {
			t.Fatalf("cycle %d: per-window Attempts should be 0 after Monitoring tick, got %d", cycle, h.recovery.Attempts())
		}
		// Back to RECOVERING for the next cycle.
		h.wd.HandleEvent(EventAgentUnhealthy)
	}

	if got := h.recovery.Count24h(); got != 2 {
		t.Fatalf("Count24h after 2 verified recoveries: want 2 (retained), got %d", got)
	}
}

func Test_FailoverHeartbeatIncludesNewFields(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	h := newIntegHarness(t)
	// Plant 5 history entries directly so the next tick will flap-escalate.
	for i := 0; i < 5; i++ {
		h.recovery.restartHistory = append(h.recovery.restartHistory, h.clk.Now().Add(time.Duration(-i)*time.Minute))
	}
	h.writeAgentState(h.clk.Now().Add(-5 * time.Minute))
	h.Tick() // flap-detected → FAILOVER
	if h.wd.State() != StateFailover {
		t.Fatalf("expected FAILOVER, got %s", h.wd.State())
	}

	stats := RestartStats{
		Count24h:      h.recovery.Count24h(),
		LastRestartAt: h.recovery.LastRestartAt(),
		FlapDetected:  h.recovery.Count24h() >= h.maxPer24h,
	}
	fc := NewFailoverClient(server.URL, "agent-test", "tok", nil)
	if _, err := fc.SendHeartbeat("v-test", h.wd.State(), nil, stats); err != nil {
		t.Fatalf("SendHeartbeat: %v", err)
	}
	if got := captured["mainAgentRestartCount24h"]; got != float64(5) {
		t.Errorf("mainAgentRestartCount24h: want 5, got %v", got)
	}
	if got := captured["flapDetected"]; got != true {
		t.Errorf("flapDetected: want true, got %v", got)
	}
	// LastRestartAt has its own emit path (only set when non-zero, RFC3339
	// formatted) — assert it's present so a zero-value or seeding bug surfaces.
	got, ok := captured["mainAgentLastRestartAt"].(string)
	if !ok || got == "" {
		t.Errorf("mainAgentLastRestartAt: want non-empty RFC3339 string, got %v", captured["mainAgentLastRestartAt"])
	}
	if _, err := time.Parse(time.RFC3339, got); err != nil {
		t.Errorf("mainAgentLastRestartAt: want RFC3339, got %q (parse err: %v)", got, err)
	}
}
