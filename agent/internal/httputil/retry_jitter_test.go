package httputil

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// ---------- applyPositiveJitter (#2728) ----------

func TestApplyPositiveJitterPassthrough(t *testing.T) {
	tests := []struct {
		name string
		d    time.Duration
		frac float64
		want time.Duration
	}{
		{name: "zero frac returns input", d: 100 * time.Millisecond, frac: 0, want: 100 * time.Millisecond},
		{name: "negative frac returns input", d: 100 * time.Millisecond, frac: -1.0, want: 100 * time.Millisecond},
		{name: "zero duration returns input", d: 0, frac: 0.3, want: 0},
		{name: "negative duration returns input", d: -5 * time.Second, frac: 0.3, want: -5 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := applyPositiveJitter(tt.d, tt.frac); got != tt.want {
				t.Fatalf("applyPositiveJitter(%v, %f) = %v, want %v", tt.d, tt.frac, got, tt.want)
			}
		})
	}
}

// The whole point of the additive-only jitter is that an agent NEVER retries
// before the server-provided Retry-After. A ±jitter would let ~half the fleet
// come back early and get rejected again.
func TestApplyPositiveJitterNeverReturnsLessThanInput(t *testing.T) {
	tests := []struct {
		name string
		d    time.Duration
		frac float64
	}{
		{name: "60s Retry-After, 30% jitter", d: 60 * time.Second, frac: 0.3},
		{name: "1s, high jitter", d: 1 * time.Second, frac: 0.99},
		{name: "1ns, high jitter", d: 1 * time.Nanosecond, frac: 0.99},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			maxExpected := time.Duration(float64(tt.d) * (1 + tt.frac))
			for i := 0; i < 2000; i++ {
				got := applyPositiveJitter(tt.d, tt.frac)
				if got < tt.d {
					t.Fatalf("applyPositiveJitter(%v, %f) = %v — retried EARLIER than the server asked",
						tt.d, tt.frac, got)
				}
				if got > maxExpected {
					t.Fatalf("applyPositiveJitter(%v, %f) = %v, want <= %v", tt.d, tt.frac, got, maxExpected)
				}
			}
		})
	}
}

func TestApplyPositiveJitterClampsToRetryAfterMaxCap(t *testing.T) {
	// A Retry-After already at the cap must not be pushed past it by jitter.
	for i := 0; i < 1000; i++ {
		got := applyPositiveJitter(retryAfterMaxCap, 0.3)
		if got > retryAfterMaxCap {
			t.Fatalf("applyPositiveJitter exceeded cap: got %v, cap %v", got, retryAfterMaxCap)
		}
	}
}

// Regression guard for the actual bug: identical Retry-After values must not
// produce identical sleeps, or the fleet stays in lockstep.
func TestApplyPositiveJitterSpreadsIdenticalInputs(t *testing.T) {
	const samples = 500
	seen := make(map[time.Duration]struct{}, samples)
	for i := 0; i < samples; i++ {
		seen[applyPositiveJitter(60*time.Second, 0.3)] = struct{}{}
	}
	// With real jitter this should be near `samples` distinct values; a
	// non-jittered implementation collapses to exactly 1.
	if len(seen) < samples/10 {
		t.Fatalf("Retry-After sleeps are not being spread: only %d distinct values out of %d samples",
			len(seen), samples)
	}
}

// ---------- Do() honors AND jitters Retry-After (#2728) ----------

// End-to-end proof through Do(): a 429 carrying Retry-After is respected as a
// lower bound, and concurrent callers do not all wake at the same instant.
func TestDoJittersServerRetryAfter(t *testing.T) {
	const retryAfterSecs = 1

	var mu sync.Mutex
	var gaps []time.Duration

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	cfg := RetryConfig{
		MaxRetries:    1,
		InitialDelay:  10 * time.Millisecond,
		MaxDelay:      time.Second,
		BackoffFactor: 2.0,
		JitterFrac:    0.3,
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			start := time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			// Expected to fail: the server always 429s.
			_, _ = Do(ctx, srv.Client(), "GET", srv.URL, nil, nil, cfg)
			mu.Lock()
			gaps = append(gaps, time.Since(start))
			mu.Unlock()
		}()
	}
	wg.Wait()

	minSleep := time.Duration(retryAfterSecs) * time.Second
	distinct := make(map[time.Duration]struct{})
	for _, g := range gaps {
		if g < minSleep {
			t.Fatalf("retried after %v — earlier than the server's Retry-After of %v", g, minSleep)
		}
		// Bucket to 10ms so scheduling noise doesn't fake a spread.
		distinct[g.Round(10*time.Millisecond)] = struct{}{}
	}
	if len(distinct) < 2 {
		t.Fatalf("all %d callers slept the same amount — Retry-After is not jittered", len(gaps))
	}
}
