package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/httputil"
)

func sampleElevationEvent() etwlua.Event {
	return etwlua.Event{
		SubjectUsername:      "CORP\\alice",
		TargetExecutablePath: `C:\Windows\System32\cmd.exe`,
		TargetExecutableHash: "deadbeef",
		PID:                  4321,
		ObservedAt:           time.Now().UTC(),
	}
}

func TestSendElevationRequestParsesIngestDecision(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"req-123","status":"auto_approved"}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		ServerURL: ts.URL,
		AuthToken: "token",
	}, "test", nil, nil)

	outcome, err := h.SendElevationRequest(sampleElevationEvent())
	if err != nil {
		t.Fatalf("SendElevationRequest returned error: %v", err)
	}
	if outcome.RequestID != "req-123" {
		t.Fatalf("RequestID = %q, want %q", outcome.RequestID, "req-123")
	}
	if outcome.Status != "auto_approved" {
		t.Fatalf("Status = %q, want %q", outcome.Status, "auto_approved")
	}
}

// TestSendElevationRequestErrorsOnServerError exercises the retry-exhaustion
// path: 500 is a retryable status (httputil.isRetryableStatus), so httputil.Do
// makes its attempts and finally returns a non-nil error. SendElevationRequest
// then hits the post-Do error branch (handlers_elevation.go:44-46). It does NOT
// cover the non-2xx status branch — see
// TestSendElevationRequestErrorsOnNonRetryableStatus for that.
//
// We pin MaxRetries:0 so the test makes a single attempt and returns in ~ms
// instead of burning DefaultRetryConfig's ~7s of real backoff (1+2+4s). The
// retryable-500 error branch is identical with 0 retries — Do still returns a
// non-nil error after the lone attempt — so the assertion is unchanged.
func TestSendElevationRequestErrorsOnServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		ServerURL: ts.URL,
		AuthToken: "token",
	}, "test", nil, nil)
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}

	start := time.Now()
	_, err := h.SendElevationRequest(sampleElevationEvent())
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("SendElevationRequest returned nil error on 500, want non-nil")
	}
	// With MaxRetries:0 there is no backoff sleep, so this must return fast.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("500 with MaxRetries:0 took %s, want fast (no backoff)", elapsed)
	}
}

// TestSendElevationRequestErrorsOnNonRetryableStatus covers the non-2xx status
// branch (handlers_elevation.go:49-52). 403 is NOT a retryable status, so
// httputil.Do returns the response immediately (no retries, no backoff sleep)
// and SendElevationRequest builds the "elevation-requests returned status %d"
// error itself. This is the fast counterpart to the 500 retry-exhaustion test.
func TestSendElevationRequestErrorsOnNonRetryableStatus(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"nope"}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		ServerURL: ts.URL,
		AuthToken: "token",
	}, "test", nil, nil)

	start := time.Now()
	_, err := h.SendElevationRequest(sampleElevationEvent())
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("SendElevationRequest returned nil error on 403, want non-nil")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("error %q does not mention status code 403", err.Error())
	}
	// 403 must short-circuit without burning retry backoff. DefaultRetryConfig's
	// first retry alone sleeps ~1s, so anything over a few hundred ms means we
	// wrongly retried.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("non-retryable 403 took %s, want fast (no retries)", elapsed)
	}
}

// TestSendElevationRequestMalformedBodyIsNonFatal locks in the deliberate
// non-fatal-unmarshal decision (handlers_elevation.go:54-64): a 201 with a junk
// or empty body must still return err == nil and a zero-value ElevationOutcome,
// because the request was accepted regardless of the body we can parse back.
func TestSendElevationRequestMalformedBodyIsNonFatal(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"junk", "this is not json"},
		{"empty", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer ts.Close()

			h := NewWithVersion(&config.Config{
				AgentID:   "agent-1",
				ServerURL: ts.URL,
				AuthToken: "token",
			}, "test", nil, nil)

			outcome, err := h.SendElevationRequest(sampleElevationEvent())
			if err != nil {
				t.Fatalf("SendElevationRequest returned error on malformed 201 body: %v", err)
			}
			if outcome.RequestID != "" {
				t.Fatalf("RequestID = %q, want empty (zero value)", outcome.RequestID)
			}
			if outcome.Status != "" {
				t.Fatalf("Status = %q, want empty (zero value)", outcome.Status)
			}
		})
	}
}
