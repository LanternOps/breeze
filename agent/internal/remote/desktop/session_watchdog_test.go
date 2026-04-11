package desktop

import "testing"

func TestReattachWatchdog_NoPriorAttempt(t *testing.T) {
	w := reattachWatchdog{}
	if got := w.evaluate("test", 100); got {
		t.Fatalf("first call (no prior attempt) should not terminate, got %v", got)
	}
	if w.failures != 0 {
		t.Fatalf("counter should stay 0 on first call, got %d", w.failures)
	}
}

func TestReattachWatchdog_SuccessResetsCounter(t *testing.T) {
	w := reattachWatchdog{}
	w.recordAttempt(100)
	w.failures = 2
	// currentVideoNanos > lastVideoNanos → recovery
	if got := w.evaluate("test", 200); got {
		t.Fatalf("successful recovery should not terminate, got %v", got)
	}
	if w.failures != 0 {
		t.Fatalf("counter should reset on recovery, got %d", w.failures)
	}
}

func TestReattachWatchdog_EscalatesAndTerminates(t *testing.T) {
	w := reattachWatchdog{}
	w.recordAttempt(100)

	// Simulate repeated reattach attempts where video never advances.
	for i := int32(1); i <= watchdogTerminateAfter; i++ {
		terminate := w.evaluate("test", 100)
		if i < watchdogTerminateAfter && terminate {
			t.Fatalf("iteration %d: terminate=true before budget exhausted", i)
		}
		if i >= watchdogTerminateAfter && !terminate {
			t.Fatalf("iteration %d: terminate=false at or past budget", i)
		}
		if w.failures != i {
			t.Fatalf("iteration %d: counter=%d, want %d", i, w.failures, i)
		}
		w.recordAttempt(100)
	}
}

func TestReattachWatchdog_LateRecoveryResets(t *testing.T) {
	w := reattachWatchdog{}
	w.recordAttempt(100)
	w.evaluate("test", 100)
	w.recordAttempt(100)
	w.evaluate("test", 100)
	if w.failures != 2 {
		t.Fatalf("expected 2 failures, got %d", w.failures)
	}
	w.recordAttempt(100)
	if terminate := w.evaluate("test", 200); terminate {
		t.Fatalf("recovery should not terminate")
	}
	if w.failures != 0 {
		t.Fatalf("counter should reset after recovery, got %d", w.failures)
	}
}

// TestReattachWatchdog_RecoveryFromEscalated verifies that recovering after the
// escalation threshold (>= watchdogEscalateAfter failures) resets the counter
// and does not terminate the session.
func TestReattachWatchdog_RecoveryFromEscalated(t *testing.T) {
	w := reattachWatchdog{}
	w.recordAttempt(100)
	// Drive failures up to and past watchdogEscalateAfter.
	for i := int32(0); i < watchdogEscalateAfter; i++ {
		w.evaluate("test", 100)
		w.recordAttempt(100)
	}
	if w.failures < watchdogEscalateAfter {
		t.Fatalf("expected at least %d failures before recovery test, got %d", watchdogEscalateAfter, w.failures)
	}
	// Now video advances — recovery from escalated state.
	if terminate := w.evaluate("test", 999); terminate {
		t.Fatalf("recovery from escalated state should not terminate")
	}
	if w.failures != 0 {
		t.Fatalf("counter should reset after recovery from escalated state, got %d", w.failures)
	}
}
