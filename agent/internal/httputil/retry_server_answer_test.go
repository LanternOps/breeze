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

// #8934: an overloaded API answers 503 with a Retry-After longer than the
// caller's context. Do sleeps toward the hint, the context expires, and the
// caller used to get a bare context.DeadlineExceeded — indistinguishable from
// a dead network. The server's answer must survive in the error chain, and
// the context error must stay matchable for existing callers.
func TestDoKeepsServerAnswerWhenContextExpiresDuringRetryAfter(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	cfg := RetryConfig{MaxRetries: 3, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond, BackoffFactor: 1}
	resp, err := Do(ctx, ts.Client(), "POST", ts.URL, nil, nil, cfg)
	if resp != nil {
		_ = resp.Body.Close()
		t.Fatal("expected no response")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want it to still match context.DeadlineExceeded", err)
	}
	var rse *RetryableStatusError
	if !errors.As(err, &rse) {
		t.Fatalf("err = %v, want the server's 503 answer in the chain", err)
	}
	if rse.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("StatusCode = %d, want 503", rse.StatusCode)
	}
}

// An earlier attempt answered 503; the next attempt hangs until the context
// expires mid-request. The 503 is still the last thing the server said.
func TestDoKeepsEarlierServerAnswerWhenLaterAttemptTimesOut(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer ts.Close()
	defer close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	cfg := RetryConfig{MaxRetries: 3, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond, BackoffFactor: 1}
	_, err := Do(ctx, ts.Client(), "POST", ts.URL, nil, nil, cfg)
	if err == nil {
		t.Fatal("expected an error")
	}
	var rse *RetryableStatusError
	if !errors.As(err, &rse) || rse.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("err = %v, want the earlier 503 answer in the chain", err)
	}
}

// A request that never got an HTTP answer must not grow a fabricated one.
func TestDoTransportFailureCarriesNoServerAnswer(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := ts.URL
	ts.Close() // connection refused from here on

	cfg := RetryConfig{MaxRetries: 1, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond, BackoffFactor: 1}
	_, err := Do(context.Background(), http.DefaultClient, "GET", url, nil, nil, cfg)
	if err == nil {
		t.Fatal("expected an error")
	}
	var rse *RetryableStatusError
	if errors.As(err, &rse) {
		t.Fatalf("err = %v carries a server answer the server never gave", err)
	}
}
