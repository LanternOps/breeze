package authstate

import (
	"testing"
	"time"
)

// #2796: the watchdog's failover client reuses Monitor with its own schedule
// (a poll tick of 30s makes a 1s initial backoff meaningless) and with a
// jittered skip window so a fleet of stranded watchdogs does not retry in
// lockstep. The agent's default monitor stays exactly as before.
func TestMonitor_WithBackoffUsesCustomSchedule(t *testing.T) {
	now := time.Unix(7_000_000, 0)
	m := NewMonitor(1, WithBackoff(time.Minute, 4*time.Minute), WithClock(func() time.Time { return now }))

	m.RecordAuthFailure() // dead, window = 1m
	now = now.Add(59 * time.Second)
	if !m.ShouldSkip() {
		t.Fatal("expected skip inside the 1m initial window")
	}
	now = now.Add(2 * time.Second)
	if m.ShouldSkip() {
		t.Fatal("expected a retry once the 1m initial window elapsed")
	}

	m.RecordAuthFailure() // 2m
	m.RecordAuthFailure() // 4m
	m.RecordAuthFailure() // capped at 4m
	now = now.Add(4*time.Minute - time.Second)
	if !m.ShouldSkip() {
		t.Fatal("expected skip just inside the 4m cap")
	}
	now = now.Add(2 * time.Second)
	if m.ShouldSkip() {
		t.Fatal("expected retry just past the 4m cap — backoff exceeded its ceiling")
	}
	if got := m.RetryIn(); got != 0 {
		t.Fatalf("RetryIn after window = %v, want 0", got)
	}
}

func TestMonitor_WithJitterSpreadsWindowWithinBounds(t *testing.T) {
	base := 10 * time.Minute
	seen := map[time.Duration]bool{}
	for i := 0; i < 200; i++ {
		now := time.Unix(8_000_000, 0)
		m := NewMonitor(1, WithBackoff(base, base), WithJitter(0.2), WithClock(func() time.Time { return now }))
		m.RecordAuthFailure()
		w := m.RetryIn()
		if w < 8*time.Minute || w > 12*time.Minute {
			t.Fatalf("jittered window %v outside [8m, 12m]", w)
		}
		seen[w] = true
	}
	if len(seen) < 2 {
		t.Fatal("jitter produced a single window value across 200 monitors — windows are in lockstep")
	}
}

func TestMonitor_RetryInZeroWhenAlive(t *testing.T) {
	m := NewMonitor(3)
	if got := m.RetryIn(); got != 0 {
		t.Fatalf("RetryIn on a healthy monitor = %v, want 0", got)
	}
}

// Jitter must not push a window past the configured ceiling.
func TestMonitor_JitterNeverExceedsMaxBackoff(t *testing.T) {
	for i := 0; i < 200; i++ {
		now := time.Unix(8_500_000, 0)
		m := NewMonitor(1, WithBackoff(time.Minute, 30*time.Minute), WithJitter(0.2), WithClock(func() time.Time { return now }))
		for j := 0; j < 12; j++ {
			m.RecordAuthFailure()
		}
		if w := m.RetryIn(); w > 30*time.Minute {
			t.Fatalf("jittered window %v exceeds the 30m ceiling", w)
		}
	}
}

// Reset clears the auth-dead state (new credentials arrived).
func TestMonitor_ResetClearsBackoff(t *testing.T) {
	m := NewMonitor(1, WithBackoff(time.Minute, time.Hour))
	m.RecordAuthFailure()
	if !m.ShouldSkip() {
		t.Fatal("setup: not dead")
	}
	m.Reset()
	if m.ShouldSkip() || m.RetryIn() != 0 {
		t.Fatal("Reset did not clear the backoff")
	}
}
