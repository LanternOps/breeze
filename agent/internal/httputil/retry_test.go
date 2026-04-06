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
		code int
		want bool
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
