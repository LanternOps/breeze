package httputil

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// ---------- DefaultRetryConfig ----------

func TestDefaultRetryConfigValues(t *testing.T) {
	cfg := DefaultRetryConfig()

	if cfg.MaxRetries != 3 {
		t.Fatalf("MaxRetries = %d, want 3", cfg.MaxRetries)
	}
	if cfg.InitialDelay != 1*time.Second {
		t.Fatalf("InitialDelay = %v, want 1s", cfg.InitialDelay)
	}
	if cfg.MaxDelay != 30*time.Second {
		t.Fatalf("MaxDelay = %v, want 30s", cfg.MaxDelay)
	}
	if cfg.BackoffFactor != 2.0 {
		t.Fatalf("BackoffFactor = %f, want 2.0", cfg.BackoffFactor)
	}
	if cfg.JitterFrac != 0.3 {
		t.Fatalf("JitterFrac = %f, want 0.3", cfg.JitterFrac)
	}
}

// ---------- isRetryableStatus ----------

func TestIsRetryableStatus(t *testing.T) {
	tests := []struct {
		code    int
		want    bool
	}{
		{http.StatusOK, false},
		{http.StatusCreated, false},
		{http.StatusBadRequest, false},
		{http.StatusUnauthorized, false},
		{http.StatusForbidden, false},
		{http.StatusNotFound, false},
		{http.StatusTooManyRequests, true},
		{http.StatusInternalServerError, true},
		{http.StatusBadGateway, true},
		{http.StatusServiceUnavailable, true},
		{http.StatusGatewayTimeout, true},
		{http.StatusConflict, false},
		{http.StatusTeapot, false},
	}

	for _, tt := range tests {
		t.Run(http.StatusText(tt.code), func(t *testing.T) {
			got := isRetryableStatus(tt.code)
			if got != tt.want {
				t.Fatalf("isRetryableStatus(%d) = %v, want %v", tt.code, got, tt.want)
			}
		})
	}
}

// ---------- Do — success on first attempt ----------

func TestDoSuccessFirstAttempt(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    3,
		InitialDelay:  10 * time.Millisecond,
		MaxDelay:      100 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}

// ---------- Do — retries on 503, then succeeds ----------

func TestDoRetriesThenSucceeds(t *testing.T) {
	var attempts atomic.Int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("success"))
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    3,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      50 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if attempts.Load() != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts.Load())
	}
}

// ---------- Do — exhausts retries ----------

func TestDoExhaustsRetries(t *testing.T) {
	var attempts atomic.Int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    2,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      50 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if resp != nil {
		t.Fatal("expected nil response on exhausted retries")
	}
	if err == nil {
		t.Fatal("expected error on exhausted retries")
	}

	var retryErr *RetryableStatusError
	if !errors.As(err, &retryErr) {
		t.Fatalf("expected *RetryableStatusError, got %T: %v", err, err)
	}
	if retryErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected status 502, got %d", retryErr.StatusCode)
	}

	// 1 initial + 2 retries = 3
	if attempts.Load() != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts.Load())
	}
}

// ---------- Do — non-retryable status codes return immediately ----------

func TestDoNonRetryableStatusReturnsImmediately(t *testing.T) {
	var attempts atomic.Int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusBadRequest) // 400 — not retryable
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    5,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      50 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
	if attempts.Load() != 1 {
		t.Fatalf("expected exactly 1 attempt, got %d", attempts.Load())
	}
}

// ---------- Do — context cancellation ----------

func TestDoCancelledContext(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    10,
		InitialDelay:  500 * time.Millisecond,
		MaxDelay:      5 * time.Second,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := Do(ctx, ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err == nil {
		t.Fatal("expected error from cancelled context")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
}

// ---------- Do — passes body and headers ----------

func TestDoPassesBodyAndHeaders(t *testing.T) {
	var receivedBody []byte
	var receivedHeaders http.Header

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header
		body := make([]byte, 1024)
		n, _ := r.Body.Read(body)
		receivedBody = body[:n]
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    0,
		InitialDelay:  time.Millisecond,
		MaxDelay:      time.Millisecond,
		BackoffFactor: 1.0,
		JitterFrac:    0,
	}

	headers := http.Header{
		"Content-Type":  {"application/json"},
		"X-Custom":      {"custom-value"},
		"Authorization": {"Bearer tok123"},
	}

	body := []byte(`{"key":"value"}`)

	resp, err := Do(context.Background(), ts.Client(), "POST", ts.URL, body, headers, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer resp.Body.Close()

	if string(receivedBody) != `{"key":"value"}` {
		t.Fatalf("expected body={\"key\":\"value\"}, got %q", string(receivedBody))
	}
	if receivedHeaders.Get("Content-Type") != "application/json" {
		t.Fatalf("expected Content-Type=application/json, got %q", receivedHeaders.Get("Content-Type"))
	}
	if receivedHeaders.Get("X-Custom") != "custom-value" {
		t.Fatalf("expected X-Custom=custom-value, got %q", receivedHeaders.Get("X-Custom"))
	}
}

// ---------- Do — nil body ----------

func TestDoNilBody(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.ContentLength > 0 {
			t.Error("expected nil/empty body")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := RetryConfig{MaxRetries: 0, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond, BackoffFactor: 1.0}
	resp, err := Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp.Body.Close()
}

// ---------- Do — zero retries ----------

func TestDoZeroRetriesFailsImmediately(t *testing.T) {
	var attempts atomic.Int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    0,
		InitialDelay:  time.Millisecond,
		MaxDelay:      time.Millisecond,
		BackoffFactor: 1.0,
		JitterFrac:    0,
	}

	_, err := Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	if err == nil {
		t.Fatal("expected error with zero retries on 503")
	}
	if attempts.Load() != 1 {
		t.Fatalf("expected 1 attempt, got %d", attempts.Load())
	}
}

// ---------- Do — body is replayed on retry ----------

func TestDoBodyReplayedOnRetry(t *testing.T) {
	var bodies []string
	var attempts atomic.Int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		b := make([]byte, 1024)
		nn, _ := r.Body.Read(b)
		bodies = append(bodies, string(b[:nn]))
		if n <= 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    2,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      50 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	body := []byte("replay-me")
	resp, err := Do(context.Background(), ts.Client(), "POST", ts.URL, body, nil, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp.Body.Close()

	if len(bodies) != 2 {
		t.Fatalf("expected 2 attempts, got %d", len(bodies))
	}
	for i, b := range bodies {
		if b != "replay-me" {
			t.Fatalf("attempt %d body = %q, want %q", i+1, b, "replay-me")
		}
	}
}

// ---------- Do — network error triggers retry ----------

func TestDoNetworkErrorRetriesAndFails(t *testing.T) {
	// Use a server that we close immediately to cause connection refused
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	ts.Close() // Close immediately

	cfg := RetryConfig{
		MaxRetries:    1,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      50 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	_, err := Do(context.Background(), &http.Client{Timeout: 100 * time.Millisecond}, "GET", ts.URL, nil, nil, cfg)
	if err == nil {
		t.Fatal("expected error for closed server")
	}
}

// ---------- RetryableStatusError ----------

func TestRetryableStatusErrorMessage(t *testing.T) {
	err := &RetryableStatusError{
		StatusCode: http.StatusBadGateway,
		URL:        "https://example.com/api/v1/foo",
	}

	got := err.Error()
	want := "request to https://example.com/api/v1/foo failed after retries with status Bad Gateway"
	if got != want {
		t.Fatalf("Error() = %q, want %q", got, want)
	}
}

func TestRetryableStatusErrorImplementsError(t *testing.T) {
	var err error = &RetryableStatusError{StatusCode: 503, URL: "http://test"}
	if err.Error() == "" {
		t.Fatal("expected non-empty error message")
	}
}

// ---------- applyJitter ----------

func TestApplyJitterZeroFrac(t *testing.T) {
	d := 100 * time.Millisecond
	got := applyJitter(d, 0)
	if got != d {
		t.Fatalf("applyJitter with frac=0: got %v, want %v", got, d)
	}
}

func TestApplyJitterNegativeFrac(t *testing.T) {
	d := 100 * time.Millisecond
	got := applyJitter(d, -1.0)
	if got != d {
		t.Fatalf("applyJitter with negative frac: got %v, want %v", got, d)
	}
}

func TestApplyJitterBoundsWithPositiveFrac(t *testing.T) {
	d := 1 * time.Second
	frac := 0.3

	minExpected := time.Duration(float64(d) * (1 - frac))
	maxExpected := time.Duration(float64(d) * (1 + frac))

	// Run many times to check bounds probabilistically
	for i := 0; i < 1000; i++ {
		got := applyJitter(d, frac)
		if got < minExpected || got > maxExpected {
			t.Fatalf("applyJitter(%v, %f) = %v, expected between %v and %v",
				d, frac, got, minExpected, maxExpected)
		}
	}
}

func TestApplyJitterNonNegativeResult(t *testing.T) {
	// Even with a very small duration and high jitter, result should not be negative
	d := 1 * time.Nanosecond
	for i := 0; i < 1000; i++ {
		got := applyJitter(d, 0.99)
		if got < 0 {
			t.Fatalf("applyJitter returned negative: %v", got)
		}
	}
}

// ---------- Do — MaxDelay cap ----------

func TestBackoffCappedAtMaxDelay(t *testing.T) {
	var attempts atomic.Int32

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    2,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      8 * time.Millisecond, // cap lower than what backoff would produce
		BackoffFactor: 100.0,                // aggressive backoff
		JitterFrac:    0,
	}

	start := time.Now()
	_, _ = Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
	elapsed := time.Since(start)

	// With 2 retries, delays should be capped at 8ms each. Total < 50ms
	// Without cap, 5ms * 100 = 500ms per retry
	if elapsed > 200*time.Millisecond {
		t.Fatalf("took %v, MaxDelay cap does not appear to be working", elapsed)
	}
}

// ---------- Do — 429 is retryable ----------

func TestDo429IsRetryable(t *testing.T) {
	var attempts atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n <= 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	cfg := RetryConfig{
		MaxRetries:    2,
		InitialDelay:  5 * time.Millisecond,
		MaxDelay:      50 * time.Millisecond,
		BackoffFactor: 2.0,
		JitterFrac:    0,
	}

	resp, err := Do(context.Background(), ts.Client(), "GET", ts.URL, nil, nil, cfg)
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
}

// ---------- Do — invalid URL is not retried ----------

func TestDoInvalidURLNotRetried(t *testing.T) {
	cfg := RetryConfig{
		MaxRetries:    3,
		InitialDelay:  time.Millisecond,
		MaxDelay:      time.Millisecond,
		BackoffFactor: 1.0,
	}

	// An invalid method causes NewRequestWithContext to fail — should not retry
	_, err := Do(context.Background(), http.DefaultClient, "BAD METHOD", "http://example.com", nil, nil, cfg)
	if err == nil {
		t.Fatal("expected error for invalid method")
	}
}
