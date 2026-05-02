package httputil

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// ---------- ParseRetryAfter — integer seconds ----------

func TestParseRetryAfterIntegerSeconds(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "30")

	got := ParseRetryAfter(h, time.Now())
	want := 30 * time.Second
	if got != want {
		t.Fatalf("ParseRetryAfter(\"30\") = %v, want %v", got, want)
	}
}

func TestParseRetryAfterZero(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "0")

	got := ParseRetryAfter(h, time.Now())
	if got != 0 {
		t.Fatalf("ParseRetryAfter(\"0\") = %v, want 0", got)
	}
}

func TestParseRetryAfterNegative(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "-5")

	got := ParseRetryAfter(h, time.Now())
	if got != 0 {
		t.Fatalf("ParseRetryAfter(\"-5\") = %v, want 0", got)
	}
}

func TestParseRetryAfterMalformed(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "abc")

	got := ParseRetryAfter(h, time.Now())
	if got != 0 {
		t.Fatalf("ParseRetryAfter(\"abc\") = %v, want 0", got)
	}
}

func TestParseRetryAfterEmptyString(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "")

	got := ParseRetryAfter(h, time.Now())
	if got != 0 {
		t.Fatalf("ParseRetryAfter(\"\") = %v, want 0", got)
	}
}

func TestParseRetryAfterMissingHeader(t *testing.T) {
	h := http.Header{}

	got := ParseRetryAfter(h, time.Now())
	if got != 0 {
		t.Fatalf("ParseRetryAfter(missing) = %v, want 0", got)
	}
}

func TestParseRetryAfterNilHeader(t *testing.T) {
	got := ParseRetryAfter(nil, time.Now())
	if got != 0 {
		t.Fatalf("ParseRetryAfter(nil) = %v, want 0", got)
	}
}

// ---------- ParseRetryAfter — HTTP-date ----------

func TestParseRetryAfterHTTPDateFuture(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	future := now.Add(60 * time.Second)
	h := http.Header{}
	h.Set("Retry-After", future.Format(http.TimeFormat))

	got := ParseRetryAfter(h, now)
	want := 60 * time.Second
	// Allow ±2s tolerance for any rounding in formatting/parsing.
	diff := got - want
	if diff < -2*time.Second || diff > 2*time.Second {
		t.Fatalf("ParseRetryAfter(future RFC1123) = %v, want ~%v (±2s)", got, want)
	}
}

func TestParseRetryAfterHTTPDatePast(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-60 * time.Second)
	h := http.Header{}
	h.Set("Retry-After", past.Format(http.TimeFormat))

	got := ParseRetryAfter(h, now)
	if got != 0 {
		t.Fatalf("ParseRetryAfter(past date) = %v, want 0", got)
	}
}

func TestParseRetryAfterHTTPDateRFC1123(t *testing.T) {
	// Spec example from RFC 7231: "Tue, 15 Nov 1994 08:12:31 GMT"
	// Use a "now" that is 60s before that fixed date so the duration is deterministic.
	target, err := time.Parse(time.RFC1123, "Tue, 15 Nov 1994 08:12:31 GMT")
	if err != nil {
		t.Fatalf("setup parse: %v", err)
	}
	now := target.Add(-60 * time.Second)

	h := http.Header{}
	h.Set("Retry-After", "Tue, 15 Nov 1994 08:12:31 GMT")

	got := ParseRetryAfter(h, now)
	want := 60 * time.Second
	if got != want {
		t.Fatalf("ParseRetryAfter(RFC1123 spec example) = %v, want %v", got, want)
	}
}

// ---------- ParseRetryAfter — cap enforcement ----------

func TestParseRetryAfterAboveCap(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "99999")

	got := ParseRetryAfter(h, time.Now())
	want := 300 * time.Second
	if got != want {
		t.Fatalf("ParseRetryAfter(\"99999\") = %v, want %v (cap)", got, want)
	}
}

func TestParseRetryAfterAtCap(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", strconv.Itoa(int((300 * time.Second).Seconds())))

	got := ParseRetryAfter(h, time.Now())
	want := 300 * time.Second
	if got != want {
		t.Fatalf("ParseRetryAfter(at cap) = %v, want %v", got, want)
	}
}

func TestParseRetryAfterHTTPDateAboveCap(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	veryFuture := now.Add(2 * time.Hour)
	h := http.Header{}
	h.Set("Retry-After", veryFuture.Format(http.TimeFormat))

	got := ParseRetryAfter(h, now)
	want := 300 * time.Second
	if got != want {
		t.Fatalf("ParseRetryAfter(2h future) = %v, want %v (cap)", got, want)
	}
}

// ---------- Do — Retry-After is honored on 429 ----------

func TestDoHonorsRetryAfterOn429(t *testing.T) {
	var attempts atomic.Int32
	var attemptTimes []time.Time
	mu := make(chan struct{}, 1)
	mu <- struct{}{}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-mu
		attemptTimes = append(attemptTimes, time.Now())
		mu <- struct{}{}

		n := attempts.Add(1)
		if n == 1 {
			// First attempt: rate-limited, ask for 1s wait.
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries: 2,
		// Internal exponential schedule would be 5ms; if Retry-After were
		// ignored, the second attempt would happen ~5ms after the first.
		// We want to confirm we instead wait ≥1s.
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      10 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(t.Context(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if attempts.Load() != 2 {
		t.Fatalf("expected 2 attempts, got %d", attempts.Load())
	}
	if len(attemptTimes) < 2 {
		t.Fatalf("expected ≥2 recorded attempt times, got %d", len(attemptTimes))
	}

	gap := attemptTimes[1].Sub(attemptTimes[0])
	if gap < 1*time.Second {
		t.Fatalf("expected ≥1s gap honoring Retry-After, got %v", gap)
	}
	// Sanity ceiling — should not be much more than 1s + scheduling slop.
	if gap > 3*time.Second {
		t.Fatalf("gap %v unreasonably long; expected ~1s", gap)
	}
}

func TestDoHonorsRetryAfterOn503(t *testing.T) {
	var attempts atomic.Int32
	var attemptTimes []time.Time
	mu := make(chan struct{}, 1)
	mu <- struct{}{}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-mu
		attemptTimes = append(attemptTimes, time.Now())
		mu <- struct{}{}

		n := attempts.Add(1)
		if n == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    2,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      10 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(t.Context(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if len(attemptTimes) < 2 {
		t.Fatalf("expected ≥2 attempts, got %d", len(attemptTimes))
	}
	gap := attemptTimes[1].Sub(attemptTimes[0])
	if gap < 1*time.Second {
		t.Fatalf("expected ≥1s gap honoring Retry-After on 503, got %v", gap)
	}
}

// Verify that without Retry-After, exponential delay is still small (regression
// guard: we shouldn't accidentally start sleeping forever when no header sent).
func TestDoNoRetryAfterUsesExponentialDelay(t *testing.T) {
	var attempts atomic.Int32
	var attemptTimes []time.Time
	mu := make(chan struct{}, 1)
	mu <- struct{}{}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-mu
		attemptTimes = append(attemptTimes, time.Now())
		mu <- struct{}{}

		n := attempts.Add(1)
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    2,
		InitialDelay:  10 * time.Millisecond,
		MaxDelay:      50 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(t.Context(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()

	gap := attemptTimes[1].Sub(attemptTimes[0])
	// Should be ~10ms, definitely <500ms (no Retry-After to trigger the long sleep).
	if gap > 500*time.Millisecond {
		t.Fatalf("expected ≪500ms gap without Retry-After, got %v", gap)
	}
}
