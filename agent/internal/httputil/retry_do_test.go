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
