package desktop

import (
	"testing"
	"time"
)

// hardwareRestorePolicy governs when a session that fell back to a software
// encoder (e.g. VideoToolbox demoted to OpenH264 after a cold-start stall on an
// Intel Mac) should retry restoring the hardware encoder. It is a pure state
// machine — the actual encoder rebuild lives in Session — so the backoff/cap
// logic can be unit tested in isolation, mirroring reattachWatchdog.

func TestHardwareRestorePolicy_FreshNeverAttempts(t *testing.T) {
	var p hardwareRestorePolicy
	now := time.Unix(0, 0)
	if p.shouldAttempt(now) {
		t.Fatalf("a policy that was never demoted should not attempt a restore")
	}
}

func TestHardwareRestorePolicy_WaitsForBackoffAfterDemotion(t *testing.T) {
	var p hardwareRestorePolicy
	t0 := time.Unix(100, 0)
	p.onDemotedFromHardware(t0)

	if p.shouldAttempt(t0) {
		t.Fatalf("should not attempt immediately after demotion")
	}
	if p.shouldAttempt(t0.Add(4 * time.Second)) {
		t.Fatalf("should not attempt before the first backoff (5s) elapses")
	}
	if !p.shouldAttempt(t0.Add(5 * time.Second)) {
		t.Fatalf("should attempt once the first backoff (5s) has elapsed")
	}
}

func TestHardwareRestorePolicy_BackoffEscalatesPerAttempt(t *testing.T) {
	var p hardwareRestorePolicy
	t0 := time.Unix(0, 0)
	p.onDemotedFromHardware(t0)

	// First attempt due at +5s.
	if !p.shouldAttempt(t0.Add(5 * time.Second)) {
		t.Fatalf("attempt 1 should be due at +5s")
	}
	p.recordAttempt(t0.Add(5 * time.Second))

	// Second attempt waits 15s more.
	if p.shouldAttempt(t0.Add(5*time.Second + 14*time.Second)) {
		t.Fatalf("attempt 2 should not be due before +15s after attempt 1")
	}
	if !p.shouldAttempt(t0.Add(5*time.Second + 15*time.Second)) {
		t.Fatalf("attempt 2 should be due +15s after attempt 1")
	}
	p.recordAttempt(t0.Add(20 * time.Second))

	// Third attempt waits 45s more.
	if !p.shouldAttempt(t0.Add(20*time.Second + 45*time.Second)) {
		t.Fatalf("attempt 3 should be due +45s after attempt 2")
	}
}

func TestHardwareRestorePolicy_CapsAtMaxAttempts(t *testing.T) {
	var p hardwareRestorePolicy
	now := time.Unix(0, 0)
	p.onDemotedFromHardware(now)

	for i := 0; i < maxHardwareRestoreAttempts; i++ {
		now = now.Add(time.Hour) // always past backoff
		if !p.shouldAttempt(now) {
			t.Fatalf("attempt %d should be due", i+1)
		}
		p.recordAttempt(now)
	}

	now = now.Add(time.Hour)
	if p.shouldAttempt(now) {
		t.Fatalf("should stop attempting after %d attempts", maxHardwareRestoreAttempts)
	}
}

func TestHardwareRestorePolicy_RestoreClearsButKeepsAttemptCount(t *testing.T) {
	var p hardwareRestorePolicy
	t0 := time.Unix(0, 0)
	p.onDemotedFromHardware(t0)
	p.recordAttempt(t0.Add(5 * time.Second))
	p.onRestored()

	// Back on hardware: no pending attempt.
	if p.shouldAttempt(t0.Add(time.Hour)) {
		t.Fatalf("after a successful restore there should be no pending attempt")
	}

	// If hardware stalls again, re-arming must keep the prior attempt count so
	// total restore churn across the session stays bounded.
	reDemote := t0.Add(time.Hour)
	p.onDemotedFromHardware(reDemote)
	// Only one attempt remains (we already used 1 of maxHardwareRestoreAttempts=3,
	// wait — used 1, so 2 remain). Drive to the cap.
	remaining := 0
	now := reDemote
	for i := 0; i < maxHardwareRestoreAttempts+2; i++ {
		now = now.Add(time.Hour)
		if p.shouldAttempt(now) {
			remaining++
			p.recordAttempt(now)
		}
	}
	if remaining != maxHardwareRestoreAttempts-1 {
		t.Fatalf("expected %d attempts remaining after one prior attempt, got %d", maxHardwareRestoreAttempts-1, remaining)
	}
}

func TestHardwareRestorePolicy_GiveUpStopsRetries(t *testing.T) {
	var p hardwareRestorePolicy
	now := time.Unix(0, 0)
	p.onDemotedFromHardware(now)
	p.giveUp()
	if p.shouldAttempt(now.Add(time.Hour)) {
		t.Fatalf("giveUp() must permanently stop restore attempts")
	}
}

func TestHardwareRestorePolicy_ReDemotionWithoutRestorePreservesCountAndEscalates(t *testing.T) {
	// Hardware that re-stalls before any successful restore (no intervening
	// onRestored) must keep the attempt count and re-arm with the escalated
	// backoff, not reset to the first (5s) interval.
	var p hardwareRestorePolicy
	t0 := time.Unix(0, 0)
	p.onDemotedFromHardware(t0)
	p.recordAttempt(t0.Add(5 * time.Second)) // attempts == 1

	reDemote := t0.Add(30 * time.Second)
	p.onDemotedFromHardware(reDemote)
	if p.attempts != 1 {
		t.Fatalf("re-demotion without restore must preserve attempt count, got %d", p.attempts)
	}
	if p.shouldAttempt(reDemote.Add(14 * time.Second)) {
		t.Fatalf("re-demotion should re-arm with the escalated 15s backoff, not 5s")
	}
	if !p.shouldAttempt(reDemote.Add(15 * time.Second)) {
		t.Fatalf("attempt should be due 15s after re-demotion")
	}
}

// The following exercise the hardware-independent early-exit branches of
// Session.maybeRestoreHardwareEncoder. They avoid the encoder-rebuild tail
// (NewVideoEncoder), which requires cgo/VideoToolbox, so they run identically
// on every platform/CI runner.

func TestMaybeRestoreHardwareEncoder_NotDueConsumesNothing(t *testing.T) {
	s := &Session{}
	sw := &stubEncoder{} // IsHardware()==false
	s.encoder.Store(&VideoEncoder{backend: sw})

	t0 := time.Unix(0, 0)
	s.hwRestore.onDemotedFromHardware(t0)
	// Before the 5s backoff: not due.
	s.maybeRestoreHardwareEncoder(t0)

	if s.hwRestore.attempts != 0 {
		t.Fatalf("a not-due tick must not consume a restore attempt, got %d", s.hwRestore.attempts)
	}
	if !s.hwRestore.demoted {
		t.Fatalf("a not-due tick must leave the policy armed")
	}
	if s.encoder.Load().backend != sw {
		t.Fatalf("a not-due tick must not swap the encoder")
	}
}

func TestMaybeRestoreHardwareEncoder_AlreadyHardwareDisarms(t *testing.T) {
	// If something else restored hardware (e.g. the Windows desktop-switch
	// path), the next due tick must observe hardware and disarm the policy so
	// it stops scheduling retries — without consuming an attempt.
	s := &Session{}
	hw := &stubEncoder{hardware: true}
	s.encoder.Store(&VideoEncoder{backend: hw})

	t0 := time.Unix(0, 0)
	s.hwRestore.onDemotedFromHardware(t0)
	s.maybeRestoreHardwareEncoder(t0.Add(10 * time.Second)) // past backoff → due

	if s.hwRestore.demoted {
		t.Fatalf("observing hardware on a due tick must disarm the policy")
	}
	if s.hwRestore.attempts != 0 {
		t.Fatalf("disarming on already-hardware must not consume an attempt, got %d", s.hwRestore.attempts)
	}
}

func TestMaybeRestoreHardwareEncoder_NilEncoderDisarms(t *testing.T) {
	s := &Session{} // no encoder stored
	t0 := time.Unix(0, 0)
	s.hwRestore.onDemotedFromHardware(t0)

	s.maybeRestoreHardwareEncoder(t0.Add(10 * time.Second)) // must not panic

	if s.hwRestore.demoted {
		t.Fatalf("a nil encoder must disarm the policy rather than spin")
	}
}
