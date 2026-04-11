package desktop

import "testing"

// evaluateReattachFailure is covered here directly rather than through the
// capture loop because the loop has heavy Win32/DXGI dependencies. The helper
// is the entire escalation decision, so exercising it end-to-end over the
// counter lifecycle is sufficient to guard the watchdog's termination path.

func TestEvaluateReattachFailure_NoPriorReattach(t *testing.T) {
	s := &Session{id: "test"}
	if got := s.evaluateReattachFailure(100, 0, false); got {
		t.Fatalf("first attempt should not terminate, got %v", got)
	}
	if c := s.failedReattaches.Load(); c != 0 {
		t.Fatalf("counter should stay 0 on first attempt, got %d", c)
	}
}

func TestEvaluateReattachFailure_SuccessResetsCounter(t *testing.T) {
	s := &Session{id: "test"}
	s.failedReattaches.Store(2)
	// currentVideo > priorReattachVideo → recovery succeeded.
	if got := s.evaluateReattachFailure(200, 100, true); got {
		t.Fatalf("successful recovery should not terminate, got %v", got)
	}
	if c := s.failedReattaches.Load(); c != 0 {
		t.Fatalf("counter should reset on recovery, got %d", c)
	}
}

func TestEvaluateReattachFailure_EscalatesAndTerminates(t *testing.T) {
	s := &Session{id: "test"}

	// Simulate repeated reattach attempts where video never advances:
	// priorReattachVideoNanos keeps matching currentVideoNanos.
	for i := int32(1); i <= watchdogTerminateAfter; i++ {
		terminate := s.evaluateReattachFailure(100, 100, true)
		if i < watchdogTerminateAfter && terminate {
			t.Fatalf("iteration %d: terminate=true before budget exhausted", i)
		}
		if i >= watchdogTerminateAfter && !terminate {
			t.Fatalf("iteration %d: terminate=false at or past budget", i)
		}
		if got := s.failedReattaches.Load(); got != i {
			t.Fatalf("iteration %d: counter=%d, want %d", i, got, i)
		}
	}
}

func TestEvaluateReattachFailure_LateRecoveryResets(t *testing.T) {
	s := &Session{id: "test"}
	// Two failures, then a successful one.
	s.evaluateReattachFailure(100, 100, true)
	s.evaluateReattachFailure(100, 100, true)
	if c := s.failedReattaches.Load(); c != 2 {
		t.Fatalf("expected 2 failures, got %d", c)
	}
	if terminate := s.evaluateReattachFailure(200, 100, true); terminate {
		t.Fatalf("recovery should not terminate")
	}
	if c := s.failedReattaches.Load(); c != 0 {
		t.Fatalf("counter should reset after recovery, got %d", c)
	}
}
