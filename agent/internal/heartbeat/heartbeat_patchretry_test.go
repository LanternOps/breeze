package heartbeat

import (
	"sync"
	"testing"
	"time"
)

// Issue #2728 — a patch submission rejected by the server (typically a 429 from
// the per-org agent rate limiter) used to leave the device's patch posture
// stale for a full scan interval, because lastPatchUpdate was stamped at
// dispatch time regardless of whether the upload landed.

func TestPatchScanDue(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	day := 24 * time.Hour

	cases := []struct {
		name        string
		lastUpdate  time.Time
		nextRetryAt time.Time
		interval    time.Duration
		want        bool
	}{
		{
			name:       "never run is due",
			lastUpdate: time.Time{},
			interval:   day,
			want:       true,
		},
		{
			name:       "normal interval elapsed is due",
			lastUpdate: now.Add(-25 * time.Hour),
			interval:   day,
			want:       true,
		},
		{
			name:       "within interval and no retry armed is not due",
			lastUpdate: now.Add(-1 * time.Hour),
			interval:   day,
			want:       false,
		},
		{
			name:        "armed retry that has come due fires inside the interval",
			lastUpdate:  now.Add(-1 * time.Hour),
			nextRetryAt: now.Add(-time.Second),
			interval:    day,
			want:        true,
		},
		{
			name:        "armed retry exactly at now fires",
			lastUpdate:  now.Add(-1 * time.Hour),
			nextRetryAt: now,
			interval:    day,
			want:        true,
		},
		{
			name:        "armed retry still in the future does not fire",
			lastUpdate:  now.Add(-1 * time.Hour),
			nextRetryAt: now.Add(5 * time.Minute),
			interval:    day,
			want:        false,
		},
		{
			name:        "zero retry slot is ignored",
			lastUpdate:  now.Add(-1 * time.Hour),
			nextRetryAt: time.Time{},
			interval:    day,
			want:        false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := patchScanDue(now, c.lastUpdate, c.nextRetryAt, c.interval)
			if got != c.want {
				t.Errorf("patchScanDue = %v, want %v", got, c.want)
			}
		})
	}
}

func TestPatchRetryDelay(t *testing.T) {
	cases := []struct {
		name     string
		failures int
		rnd      float64
		want     time.Duration
	}{
		{name: "zero failures is not a retry", failures: 0, want: 0},
		{name: "negative failures is not a retry", failures: -1, want: 0},
		{name: "first retry, no jitter", failures: 1, rnd: 0, want: 5 * time.Minute},
		{name: "second retry, no jitter", failures: 2, rnd: 0, want: 10 * time.Minute},
		{name: "third retry, no jitter", failures: 3, rnd: 0, want: 20 * time.Minute},
		{name: "fourth retry, no jitter", failures: 4, rnd: 0, want: 40 * time.Minute},
		{name: "budget exhausted returns 0", failures: 5, rnd: 0, want: 0},
		{name: "well past budget returns 0", failures: 99, rnd: 0, want: 0},
		{name: "max jitter on first retry", failures: 1, rnd: 1.0, want: 6*time.Minute + 30*time.Second},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := patchRetryDelay(c.failures, patchRetryJitterFrac, c.rnd)
			if got != c.want {
				t.Errorf("patchRetryDelay(%d, %v, %v) = %v, want %v",
					c.failures, patchRetryJitterFrac, c.rnd, got, c.want)
			}
		})
	}
}

// Jitter must be additive-only: a retry must never be scheduled sooner than the
// base delay, or a synchronized fleet would converge again.
func TestPatchRetryDelayJitterIsAdditiveOnly(t *testing.T) {
	for failures := 1; failures <= maxPatchSendRetries; failures++ {
		base := patchRetryDelay(failures, 0, 0)
		for _, rnd := range []float64{0, 0.25, 0.5, 0.75, 1.0} {
			got := patchRetryDelay(failures, patchRetryJitterFrac, rnd)
			if got < base {
				t.Fatalf("patchRetryDelay(%d, jitter, %v) = %v, earlier than base %v",
					failures, rnd, got, base)
			}
			maxExpected := time.Duration(float64(base) * (1 + patchRetryJitterFrac))
			if got > maxExpected {
				t.Fatalf("patchRetryDelay(%d, jitter, %v) = %v, want <= %v",
					failures, rnd, got, maxExpected)
			}
		}
	}
}

func TestPatchRetryDelayNeverExceedsMaxDelay(t *testing.T) {
	for failures := 1; failures <= maxPatchSendRetries; failures++ {
		got := patchRetryDelay(failures, 0, 0)
		if got > patchRetryMaxDelay {
			t.Fatalf("patchRetryDelay(%d) = %v, exceeds cap %v", failures, got, patchRetryMaxDelay)
		}
	}
}

// The retry budget must stay well inside the shortest supported scan interval
// (1 h after clamping) so retries can never outlive the cadence they belong to.
func TestPatchRetryBudgetIsBounded(t *testing.T) {
	var total time.Duration
	attempts := 0
	for failures := 1; ; failures++ {
		d := patchRetryDelay(failures, patchRetryJitterFrac, 1.0)
		if d == 0 {
			break
		}
		total += d
		attempts++
		if attempts > 100 {
			t.Fatal("patchRetryDelay never returned 0 — retry budget is unbounded")
		}
	}
	if attempts != maxPatchSendRetries {
		t.Fatalf("retry attempts = %d, want %d", attempts, maxPatchSendRetries)
	}
	// 5+10+20+40 = 75 min, +30% jitter = 97.5 min worst case.
	if total > 2*time.Hour {
		t.Fatalf("worst-case total retry window %v is too long", total)
	}
}

// ---------- recordPatchSendOutcome ----------

func TestRecordPatchSendOutcomeArmsAndClearsRetry(t *testing.T) {
	h := &Heartbeat{}

	// First failure arms a retry.
	h.recordPatchSendOutcome(false)
	if h.patchSendFailures != 1 {
		t.Fatalf("patchSendFailures = %d, want 1", h.patchSendFailures)
	}
	if h.nextPatchRetryAt.IsZero() {
		t.Fatal("expected a retry to be armed after a failed submission")
	}
	if time.Until(h.nextPatchRetryAt) > patchRetryMaxDelay {
		t.Fatalf("armed retry too far out: %v", time.Until(h.nextPatchRetryAt))
	}

	// Success clears both the counter and the armed retry.
	h.recordPatchSendOutcome(true)
	if h.patchSendFailures != 0 {
		t.Fatalf("patchSendFailures = %d after success, want 0", h.patchSendFailures)
	}
	if !h.nextPatchRetryAt.IsZero() {
		t.Fatal("expected the armed retry to be cleared after a successful submission")
	}
}

func TestRecordPatchSendOutcomeStopsAfterBudgetExhausted(t *testing.T) {
	h := &Heartbeat{}

	for i := 0; i < maxPatchSendRetries; i++ {
		h.recordPatchSendOutcome(false)
		if h.nextPatchRetryAt.IsZero() {
			t.Fatalf("retry %d: expected an armed retry while budget remains", i+1)
		}
	}

	// One more failure spends the budget — no further retry is armed, so the
	// device falls back to the normal scan interval instead of retrying forever.
	h.recordPatchSendOutcome(false)
	if !h.nextPatchRetryAt.IsZero() {
		t.Fatal("expected no armed retry once the attempt budget is exhausted")
	}
	if h.patchSendFailures != maxPatchSendRetries+1 {
		t.Fatalf("patchSendFailures = %d, want %d", h.patchSendFailures, maxPatchSendRetries+1)
	}

	// A later success must fully reset the state so the next transient failure
	// gets a fresh budget.
	h.recordPatchSendOutcome(true)
	if h.patchSendFailures != 0 || !h.nextPatchRetryAt.IsZero() {
		t.Fatalf("state not reset after success: failures=%d retryAt=%v",
			h.patchSendFailures, h.nextPatchRetryAt)
	}
	h.recordPatchSendOutcome(false)
	if h.nextPatchRetryAt.IsZero() {
		t.Fatal("expected a fresh retry budget after a success")
	}
}

func TestRecordPatchSendOutcomeIsConcurrencySafe(t *testing.T) {
	h := &Heartbeat{}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			h.recordPatchSendOutcome(i%2 == 0)
		}(i)
	}
	wg.Wait()
	// No assertion on the final value — interleaving is nondeterministic. This
	// exists so `go test -race` proves the mutex actually covers the fields.
}
