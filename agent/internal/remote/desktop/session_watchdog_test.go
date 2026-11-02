package desktop

import (
	"testing"
	"time"
)

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

// #10880: the no-video watchdog used to treat any gap in written samples as a
// dead capturer and rebuild the capture stream. It now separates the three
// places a frame can stop: the capturer, the encoder, and the sink.
func TestClassifyVideoStall(t *testing.T) {
	now := time.Unix(1000, 0)
	at := func(ago time.Duration) int64 { return now.Add(-ago).UnixNano() }
	const timeout = 3 * time.Second

	cases := []struct {
		name                            string
		lastWrite, lastCapture, lastOut int64
		want                            videoStallKind
	}{
		{"never wrote: startup guard owns this", 0, 0, 0, videoStallNone},
		{"recent write", at(time.Second), at(time.Second), at(time.Second), videoStallNone},
		{"write exactly at timeout is not yet stalled", at(timeout), 0, 0, videoStallNone},
		{"capturer silent too", at(5 * time.Second), at(5 * time.Second), at(5 * time.Second), videoStallCapture},
		{"capturer never reported a frame", at(5 * time.Second), 0, 0, videoStallCapture},
		{"capturing but encoder silent (dead VideoToolbox)", at(5 * time.Second), at(500 * time.Millisecond), at(5 * time.Second), videoStallEncoder},
		{"capturing, encoder never produced", at(5 * time.Second), at(500 * time.Millisecond), 0, videoStallEncoder},
		{"capturing and encoding but nothing written", at(5 * time.Second), at(200 * time.Millisecond), at(300 * time.Millisecond), videoStallSink},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyVideoStall(now, tc.lastWrite, tc.lastCapture, tc.lastOut, timeout); got != tc.want {
				t.Fatalf("classifyVideoStall = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDecideNoVideoAction(t *testing.T) {
	cases := []struct {
		name        string
		kind        videoStallKind
		ownsDevice  bool
		hardwareEnc bool
		want        noVideoAction
	}{
		{"no stall", videoStallNone, false, true, noVideoActionNone},
		{"capture stall re-attaches", videoStallCapture, false, false, noVideoActionReattach},
		{"capture stall re-attaches (D3D capturer)", videoStallCapture, true, true, noVideoActionReattach},
		{"encoder stall on hardware demotes the encoder, not the capturer", videoStallEncoder, false, true, noVideoActionDemoteEncoder},
		{"encoder stall on software only logs", videoStallEncoder, false, false, noVideoActionLogOnly},
		{"sink stall only logs", videoStallSink, false, true, noVideoActionLogOnly},
		{"D3D capturer keeps legacy re-attach for encoder stalls", videoStallEncoder, true, true, noVideoActionReattach},
		{"D3D capturer keeps legacy re-attach for sink stalls", videoStallSink, true, false, noVideoActionReattach},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decideNoVideoAction(tc.kind, tc.ownsDevice, tc.hardwareEnc); got != tc.want {
				t.Fatalf("decideNoVideoAction = %v, want %v", got, tc.want)
			}
		})
	}
}
