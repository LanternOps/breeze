package authstate

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
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

// The cap has to exceed the caller's tick interval or it suppresses nothing.
//
// ShouldSkip() is evaluated once per heartbeat tick and compares elapsed-since-
// last-failure against the backoff. With the default 60s heartbeat
// (config.HeartbeatIntervalSeconds), a cap at or below 60s means 60s has always
// elapsed by the next tick, so every tick goes through and the backoff never
// removes a single request. That was the state that let ~87 permanently
// deauthorized devices in US prod keep heartbeating at full cadence (#2774
// follow-up): the machinery ran, reported itself as backing off, and cost
// nothing.
// Read from config rather than copied, so raising the heartbeat default fails
// this test instead of silently invalidating the invariant it documents.
var defaultHeartbeatInterval = time.Duration(config.DefaultHeartbeatIntervalSeconds) * time.Second

func TestMonitor_MaxBackoffSuppressesTicksAtDefaultCadence(t *testing.T) {
	if maxBackoff <= defaultHeartbeatInterval {
		t.Fatalf("maxBackoff = %s, must exceed the %s default heartbeat interval or "+
			"ShouldSkip() never suppresses a tick", maxBackoff, defaultHeartbeatInterval)
	}
}

// End-to-end rate check: a permanently deauthorized agent, ticking at the
// default heartbeat cadence for 24h, must settle to a small number of requests.
// This is the property that matters to the API — not the value of any constant.
func TestMonitor_StrandedAgentDailyRequestBudget(t *testing.T) {
	now := time.Unix(5_000_000, 0)
	m := NewMonitor(3)
	m.now = func() time.Time { return now }

	attempts := 0
	for elapsed := time.Duration(0); elapsed < 24*time.Hour; elapsed += defaultHeartbeatInterval {
		if !m.ShouldSkip() {
			attempts++
			// The server is permanently rejecting this agent.
			m.RecordAuthFailure()
		}
		now = now.Add(defaultHeartbeatInterval)
	}

	t.Logf("stranded agent: %d requests/day (uncapped cadence would be %d)",
		attempts, int(24*time.Hour/defaultHeartbeatInterval))

	// 24h at 60s ticks is 1440 attempts with no effective backoff. Allow generous
	// headroom over the theoretical floor (24h / maxBackoff) so the bound tracks
	// the behaviour, not the exact escalation curve.
	const maxDailyAttempts = 100
	if attempts > maxDailyAttempts {
		t.Fatalf("stranded agent made %d requests/day, want <= %d "+
			"(uncapped cadence would be %d)", attempts, maxDailyAttempts,
			int(24*time.Hour/defaultHeartbeatInterval))
	}
	// Guard the other direction: it must never go fully silent, or a recovered
	// tenant could never reach its fleet again.
	if attempts == 0 {
		t.Fatal("stranded agent made no attempts at all — it must keep probing so it can self-heal")
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
