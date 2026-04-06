package watchdog

import (
	"testing"
	"time"
)

// DefaultTestConfig returns a Config suitable for unit tests.
func DefaultTestConfig() Config {
	return Config{
		ProcessCheckInterval:    5 * time.Second,
		IPCProbeInterval:        30 * time.Second,
		HeartbeatStaleThreshold: 3 * time.Minute,
		MaxRecoveryAttempts:     3,
		RecoveryCooldown:        10 * time.Minute,
		StandbyTimeout:          30 * time.Minute,
		FailoverPollInterval:    30 * time.Second,
	}
}

func TestInitialState(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	if got := w.State(); got != StateConnecting {
		t.Fatalf("expected initial state %s, got %s", StateConnecting, got)
	}
}

func TestConnectingToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	next, ok := w.HandleEvent(EventIPCConnected)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateMonitoring {
		t.Fatalf("expected %s, got %s", StateMonitoring, next)
	}
	if w.State() != StateMonitoring {
		t.Fatalf("State() mismatch: expected %s, got %s", StateMonitoring, w.State())
	}
}

func TestMonitoringToRecovering(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected) // CONNECTING → MONITORING
	next, ok := w.HandleEvent(EventAgentUnhealthy)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateRecovering {
		t.Fatalf("expected %s, got %s", StateRecovering, next)
	}
}

func TestMonitoringToStandby(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected) // CONNECTING → MONITORING
	next, ok := w.HandleEvent(EventShutdownIntent)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateStandby {
		t.Fatalf("expected %s, got %s", StateStandby, next)
	}
}

func TestRecoveringToFailover(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventAgentNotFound) // CONNECTING → RECOVERING
	next, ok := w.HandleEvent(EventRecoveryExhausted)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateFailover {
		t.Fatalf("expected %s, got %s", StateFailover, next)
	}
}

func TestRecoveringToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventAgentNotFound) // CONNECTING → RECOVERING
	next, ok := w.HandleEvent(EventAgentRecovered)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateMonitoring {
		t.Fatalf("expected %s, got %s", StateMonitoring, next)
	}
}

func TestFailoverToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventAgentNotFound)    // CONNECTING → RECOVERING
	w.HandleEvent(EventRecoveryExhausted) // RECOVERING → FAILOVER
	next, ok := w.HandleEvent(EventAgentRecovered)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateMonitoring {
		t.Fatalf("expected %s, got %s", StateMonitoring, next)
	}
}

func TestStandbyToFailover(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)  // CONNECTING → MONITORING
	w.HandleEvent(EventShutdownIntent) // MONITORING → STANDBY
	next, ok := w.HandleEvent(EventStandbyTimeout)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateFailover {
		t.Fatalf("expected %s, got %s", StateFailover, next)
	}
}

func TestStandbyToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)  // CONNECTING → MONITORING
	w.HandleEvent(EventShutdownIntent) // MONITORING → STANDBY
	next, ok := w.HandleEvent(EventAgentRecovered)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateMonitoring {
		t.Fatalf("expected %s, got %s", StateMonitoring, next)
	}
}

func TestConnectingToRecovering(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	next, ok := w.HandleEvent(EventAgentNotFound)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateRecovering {
		t.Fatalf("expected %s, got %s", StateRecovering, next)
	}
}

func TestFailoverToMonitoringViaIPC(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventAgentNotFound)     // CONNECTING → RECOVERING
	w.HandleEvent(EventRecoveryExhausted) // RECOVERING → FAILOVER
	next, ok := w.HandleEvent(EventIPCConnected)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateMonitoring {
		t.Fatalf("expected %s, got %s", StateMonitoring, next)
	}
}

func TestRecoveringToMonitoringViaIPC(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventAgentNotFound) // CONNECTING → RECOVERING
	next, ok := w.HandleEvent(EventIPCConnected)
	if !ok {
		t.Fatal("expected transition to succeed")
	}
	if next != StateMonitoring {
		t.Fatalf("expected %s, got %s", StateMonitoring, next)
	}
}

func TestInvalidTransitionIgnored(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	// CONNECTING has no transition for EventAgentRecovered
	_, ok := w.HandleEvent(EventAgentRecovered)
	if ok {
		t.Fatal("expected no transition for invalid event in CONNECTING")
	}
	if w.State() != StateConnecting {
		t.Fatalf("state should remain %s, got %s", StateConnecting, w.State())
	}
	// History should only contain the initial entry
	if h := w.StateHistory(); len(h) != 1 {
		t.Fatalf("expected 1 history entry, got %d", len(h))
	}
}

func TestStateHistory(t *testing.T) {
	before := time.Now()
	w := NewWatchdog(DefaultTestConfig())

	w.HandleEvent(EventIPCConnected)   // CONNECTING → MONITORING
	w.HandleEvent(EventAgentUnhealthy) // MONITORING → RECOVERING
	w.HandleEvent(EventAgentRecovered) // RECOVERING → MONITORING

	history := w.StateHistory()
	// 1 initial + 3 transitions = 4 entries
	if len(history) != 4 {
		t.Fatalf("expected 4 history entries, got %d", len(history))
	}

	expected := []struct {
		state string
		event string
	}{
		{StateConnecting, ""},
		{StateMonitoring, EventIPCConnected},
		{StateRecovering, EventAgentUnhealthy},
		{StateMonitoring, EventAgentRecovered},
	}

	for i, exp := range expected {
		rec := history[i]
		if rec.State != exp.state {
			t.Errorf("history[%d].State: expected %s, got %s", i, exp.state, rec.State)
		}
		if rec.Event != exp.event {
			t.Errorf("history[%d].Event: expected %q, got %q", i, exp.event, rec.Event)
		}
		if rec.EnteredAt.Before(before) {
			t.Errorf("history[%d].EnteredAt is before test start", i)
		}
	}
}
