package authstate

import (
	"testing"
	"time"
)

// trip drives the monitor to the auth-dead state using a controllable clock.
func tripDead(m *Monitor, clk *time.Time) {
	for i := 0; i < int(m.threshold); i++ {
		m.RecordAuthFailure()
	}
	if !m.ShouldSkip() {
		panic("expected dead immediately after threshold failures")
	}
	_ = clk
}

// Regression: once auth-dead, the agent must NOT skip forever. After the
// backoff elapses, ShouldSkip() must return false so the next heartbeat is
// attempted (a backoff-gated retry). Before the fix, ShouldSkip() returned the
// raw dead flag and the agent stayed silent until the process restarted, even
// after auth recovered.
func TestMonitor_RetryAllowedAfterBackoff(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	m := NewMonitor(3)
	m.now = func() time.Time { return now }

	tripDead(m, &now)

	// Within the (initial) 1s backoff window: still skipping.
	now = now.Add(500 * time.Millisecond)
	if !m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=true within the backoff window")
	}

	// Backoff elapsed: a retry must be allowed.
	now = now.Add(2 * time.Second)
	if m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=false after backoff elapsed (retry must be allowed) — this is the livelock fix")
	}
}

// A successful retry after backoff clears the dead state (self-heal), which is
// exactly what recovers an agent after a transient credential rejection.
func TestMonitor_SelfHealsOnRetrySuccess(t *testing.T) {
	now := time.Unix(2_000_000, 0)
	m := NewMonitor(3)
	m.now = func() time.Time { return now }

	tripDead(m, &now)
	now = now.Add(2 * time.Second) // past initial backoff
	if m.ShouldSkip() {
		t.Fatal("expected retry to be allowed after backoff")
	}

	m.RecordSuccess() // the retry succeeded
	if m.ShouldSkip() {
		t.Fatal("expected not-dead after a successful retry")
	}
}

// A failed retry lengthens the backoff (exponential) and keeps skipping until
// the new, longer window elapses — so retries slow down but never stop.
func TestMonitor_FailedRetryLengthensBackoff(t *testing.T) {
	now := time.Unix(3_000_000, 0)
	m := NewMonitor(3)
	m.now = func() time.Time { return now }

	tripDead(m, &now)        // backoff = 1s
	now = now.Add(2 * time.Second)
	if m.ShouldSkip() {
		t.Fatal("retry should be allowed after 1s backoff")
	}

	m.RecordAuthFailure() // retry failed -> backoff = 2s, lastFailure = now

	now = now.Add(1 * time.Second) // within the new 2s window
	if !m.ShouldSkip() {
		t.Fatal("expected to skip within the lengthened 2s backoff window")
	}
	now = now.Add(2 * time.Second) // past 2s
	if m.ShouldSkip() {
		t.Fatal("expected retry allowed after the lengthened backoff elapsed")
	}
}

// Backoff must cap at maxBackoff no matter how many retries fail.
func TestMonitor_BackoffCapsAtMax(t *testing.T) {
	now := time.Unix(4_000_000, 0)
	m := NewMonitor(3)
	m.now = func() time.Time { return now }

	tripDead(m, &now)
	for i := 0; i < 20; i++ {
		m.RecordAuthFailure()
	}
	now = now.Add(maxBackoff)
	// At exactly maxBackoff elapsed it should be on the boundary; just past it,
	// a retry must be allowed (proves the window never exceeds maxBackoff).
	now = now.Add(1 * time.Second)
	if m.ShouldSkip() {
		t.Fatal("expected retry allowed once maxBackoff elapsed (backoff must be capped)")
	}
}
