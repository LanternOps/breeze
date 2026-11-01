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

// recordSleeps swaps the afterFn seam for one that records each requested wait
// and fires immediately, so the tests below assert the delay Do asked for
// without timing a real sleep (a wall-clock ceiling flaked under -race on
// loaded CI runners, #10742). Must not be combined with t.Parallel().
func recordSleeps(t *testing.T) *[]time.Duration {
	t.Helper()
	var sleeps []time.Duration
	orig := afterFn
	afterFn = func(d time.Duration) <-chan time.Time {
		sleeps = append(sleeps, d)
		ch := make(chan time.Time, 1)
		ch <- time.Time{}
		return ch
	}
	t.Cleanup(func() { afterFn = orig })
	return &sleeps
}

// doTwoAttempts serves firstStatus (with retryAfter when non-empty) then 200,
// and returns the waits Do requested between attempts.
func doTwoAttempts(t *testing.T, firstStatus int, retryAfter string, cfg RetryConfig) []time.Duration {
	t.Helper()
	sleeps := recordSleeps(t)
	var attempts atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 1 {
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			w.WriteHeader(firstStatus)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

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
	return *sleeps
}

func TestDoHonorsRetryAfterOn429(t *testing.T) {
	// Internal exponential schedule would be 5ms; if Retry-After were ignored
	// the requested wait would be ~5ms. We assert it is >=1s.
	sleeps := doTwoAttempts(t, http.StatusTooManyRequests, "1", RetryConfig{
		MaxRetries: 2, InitialDelay: 5 * time.Millisecond, MaxDelay: 10 * time.Millisecond,
		BackoffFactor: 2.0, JitterFrac: 0,
	})
	if len(sleeps) != 1 || sleeps[0] < 1*time.Second {
		t.Fatalf("expected one wait >=1s honoring Retry-After, got %v", sleeps)
	}
}

func TestDoHonorsRetryAfterOn503(t *testing.T) {
	sleeps := doTwoAttempts(t, http.StatusServiceUnavailable, "1", RetryConfig{
		MaxRetries: 2, InitialDelay: 5 * time.Millisecond, MaxDelay: 10 * time.Millisecond,
		BackoffFactor: 2.0, JitterFrac: 0,
	})
	if len(sleeps) != 1 || sleeps[0] < 1*time.Second {
		t.Fatalf("expected one wait >=1s honoring Retry-After on 503, got %v", sleeps)
	}
}

// Verify that without Retry-After, exponential delay is still small (regression
// guard: we shouldn't accidentally start sleeping forever when no header sent).
func TestDoNoRetryAfterUsesExponentialDelay(t *testing.T) {
	sleeps := doTwoAttempts(t, http.StatusTooManyRequests, "", RetryConfig{
		MaxRetries: 2, InitialDelay: 10 * time.Millisecond, MaxDelay: 50 * time.Millisecond,
		BackoffFactor: 2.0, JitterFrac: 0,
	})
	if len(sleeps) != 1 || sleeps[0] != 10*time.Millisecond {
		t.Fatalf("expected one 10ms exponential wait without Retry-After, got %v", sleeps)
	}
}
