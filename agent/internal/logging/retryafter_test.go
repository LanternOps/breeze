package logging

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------- parseRetryAfter — integer seconds ----------

func TestParseRetryAfterIntegerSeconds(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "30")

	got := parseRetryAfter(h, time.Now())
	want := 30 * time.Second
	if got != want {
		t.Fatalf("parseRetryAfter(\"30\") = %v, want %v", got, want)
	}
}

func TestParseRetryAfterZero(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "0")

	if got := parseRetryAfter(h, time.Now()); got != 0 {
		t.Fatalf("parseRetryAfter(\"0\") = %v, want 0", got)
	}
}

func TestParseRetryAfterNegative(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "-5")

	if got := parseRetryAfter(h, time.Now()); got != 0 {
		t.Fatalf("parseRetryAfter(\"-5\") = %v, want 0", got)
	}
}

func TestParseRetryAfterMalformed(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "abc")

	if got := parseRetryAfter(h, time.Now()); got != 0 {
		t.Fatalf("parseRetryAfter(\"abc\") = %v, want 0", got)
	}
}

func TestParseRetryAfterMissingHeader(t *testing.T) {
	h := http.Header{}
	if got := parseRetryAfter(h, time.Now()); got != 0 {
		t.Fatalf("parseRetryAfter(missing) = %v, want 0", got)
	}
}

func TestParseRetryAfterNilHeader(t *testing.T) {
	if got := parseRetryAfter(nil, time.Now()); got != 0 {
		t.Fatalf("parseRetryAfter(nil) = %v, want 0", got)
	}
}

// ---------- parseRetryAfter — HTTP-date ----------

func TestParseRetryAfterHTTPDateFuture(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	future := now.Add(60 * time.Second)
	h := http.Header{}
	h.Set("Retry-After", future.Format(http.TimeFormat))

	got := parseRetryAfter(h, now)
	want := 60 * time.Second
	diff := got - want
	if diff < -2*time.Second || diff > 2*time.Second {
		t.Fatalf("parseRetryAfter(future RFC1123) = %v, want ~%v (±2s)", got, want)
	}
}

func TestParseRetryAfterHTTPDatePast(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	past := now.Add(-60 * time.Second)
	h := http.Header{}
	h.Set("Retry-After", past.Format(http.TimeFormat))

	if got := parseRetryAfter(h, now); got != 0 {
		t.Fatalf("parseRetryAfter(past date) = %v, want 0", got)
	}
}

func TestParseRetryAfterAboveCap(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "99999")

	got := parseRetryAfter(h, time.Now())
	want := 300 * time.Second
	if got != want {
		t.Fatalf("parseRetryAfter(\"99999\") = %v, want %v (cap)", got, want)
	}
}

func TestParseRetryAfterAtCap(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", strconv.Itoa(int((300 * time.Second).Seconds())))

	got := parseRetryAfter(h, time.Now())
	want := 300 * time.Second
	if got != want {
		t.Fatalf("parseRetryAfter(at cap) = %v, want %v", got, want)
	}
}

// ---------- shipBatch honors Retry-After on 429 ----------

func TestShipBatchHonorsRetryAfterOn429(t *testing.T) {
	var attempts atomic.Int32
	var attemptTimes []time.Time
	var mu sync.Mutex

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attemptTimes = append(attemptTimes, time.Now())
		mu.Unlock()

		n := attempts.Add(1)
		if n == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:    server.URL,
		AgentID:      "test-agent",
		AuthToken:    testToken("brz_secret"),
		AgentVersion: "1.0.0",
		MinLevel:     "debug",
		HTTPClient:   server.Client(),
	})

	entries := []LogEntry{{
		Timestamp: time.Now(),
		Level:     "INFO",
		Component: "test",
		Message:   "rate-limited test",
	}}

	s.shipBatch(entries)

	if attempts.Load() != 2 {
		t.Fatalf("expected 2 attempts (1 retry), got %d", attempts.Load())
	}

	mu.Lock()
	defer mu.Unlock()
	if len(attemptTimes) < 2 {
		t.Fatalf("expected ≥2 attempt times, got %d", len(attemptTimes))
	}
	gap := attemptTimes[1].Sub(attemptTimes[0])
	if gap < 1*time.Second {
		t.Fatalf("expected ≥1s gap honoring Retry-After, got %v", gap)
	}
	if gap > 3*time.Second {
		t.Fatalf("gap %v unreasonably long; expected ~1s", gap)
	}
}

// ---------- shipBatch honors Retry-After on 503 ----------

func TestShipBatchHonorsRetryAfterOn503(t *testing.T) {
	var attempts atomic.Int32
	var attemptTimes []time.Time
	var mu sync.Mutex

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attemptTimes = append(attemptTimes, time.Now())
		mu.Unlock()

		n := attempts.Add(1)
		if n == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:    server.URL,
		AgentID:      "test-agent",
		AuthToken:    testToken("brz_secret"),
		AgentVersion: "1.0.0",
		MinLevel:     "debug",
		HTTPClient:   server.Client(),
	})

	entries := []LogEntry{{
		Timestamp: time.Now(),
		Level:     "INFO",
		Component: "test",
		Message:   "503 test",
	}}

	s.shipBatch(entries)

	mu.Lock()
	defer mu.Unlock()
	if len(attemptTimes) < 2 {
		t.Fatalf("expected ≥2 attempts, got %d", len(attemptTimes))
	}
	gap := attemptTimes[1].Sub(attemptTimes[0])
	if gap < 1*time.Second {
		t.Fatalf("expected ≥1s gap honoring Retry-After on 503, got %v", gap)
	}
}
