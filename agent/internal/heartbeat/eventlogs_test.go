package heartbeat

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

func TestEventLogPassOutcome(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want collectors.EventLogPassOutcome
	}{
		{"sent", nil, collectors.EventLogPassSent},
		{"bad request", &eventLogsSubmissionError{status: 400}, collectors.EventLogPassRejected},
		{"payload too large", &eventLogsSubmissionError{status: 413}, collectors.EventLogPassRejected},
		{"request timeout", &eventLogsSubmissionError{status: 408}, collectors.EventLogPassFailed},
		{"rate limited", &eventLogsSubmissionError{status: 429}, collectors.EventLogPassFailed},
		{"server error", &eventLogsSubmissionError{status: 500}, collectors.EventLogPassFailed},
		{"unavailable", &eventLogsSubmissionError{status: 503}, collectors.EventLogPassFailed},
		{"transport failure", errors.New("network unavailable"), collectors.EventLogPassFailed},
		{"wrapped rejection", fmt.Errorf("upload: %w", &eventLogsSubmissionError{status: 400}), collectors.EventLogPassRejected},
		{"wrapped temporary failure", fmt.Errorf("upload: %w", &eventLogsSubmissionError{status: 429}), collectors.EventLogPassFailed},
		{"retry helper server failure", &httputil.RetryableStatusError{StatusCode: 503}, collectors.EventLogPassFailed},
		{"unrelated submission", &hardwareSubmissionError{status: 400}, collectors.EventLogPassFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := eventLogPassOutcome(tc.err); got != tc.want {
				t.Fatalf("eventLogPassOutcome(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

type eventLogsTestTransport func(*http.Request) (*http.Response, error)

func (f eventLogsTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func newEventLogsTestHeartbeat(transport http.RoundTripper) *Heartbeat {
	cfg := config.Default()
	cfg.AgentID = "fixture-agent"
	cfg.ServerURL = "https://eventlogs.example.com"
	cfg.AuthToken = "fixture-token"
	return &Heartbeat{config: cfg, client: &http.Client{Transport: transport}, retryCfg: httputil.RetryConfig{MaxRetries: 0}}
}

func TestEventLogsInventorySubmissionOutcome(t *testing.T) {
	for _, tc := range []struct {
		status    int
		wantTyped bool
		want      collectors.EventLogPassOutcome
	}{
		{200, false, collectors.EventLogPassSent},
		{400, true, collectors.EventLogPassRejected},
		{413, true, collectors.EventLogPassRejected},
		{408, true, collectors.EventLogPassFailed},
		{429, false, collectors.EventLogPassFailed},
		{500, false, collectors.EventLogPassFailed},
		{503, false, collectors.EventLogPassFailed},
	} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			calls := 0
			h := newEventLogsTestHeartbeat(eventLogsTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != http.MethodPut || r.URL.Path != "/api/v1/agents/fixture-agent/eventlogs" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				return &http.Response{StatusCode: tc.status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			}))
			err := h.sendInventoryData("eventlogs", map[string]any{"events": []any{}}, "event logs")
			if calls != 1 {
				t.Fatalf("made %d requests, want one", calls)
			}
			var submission *eventLogsSubmissionError
			if got := errors.As(err, &submission); got != tc.wantTyped {
				t.Fatalf("typed eventlogs error = %v, want %v; err=%v", got, tc.wantTyped, err)
			}
			if submission != nil && submission.status != tc.status {
				t.Errorf("status = %d, want %d", submission.status, tc.status)
			}
			if got := eventLogPassOutcome(err); got != tc.want {
				t.Errorf("outcome = %v, want %v (err=%v)", got, tc.want, err)
			}
		})
	}
}

func TestSendEventLogsSkipsInFlightPass(t *testing.T) {
	var calls atomic.Int32
	h := newEventLogsTestHeartbeat(eventLogsTestTransport(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("unexpected request")
	}))
	// Nil config and collector deliberately make the path below the guard
	// unusable. A skipped tick must neither collect nor reach loopReady.
	h.config = nil
	h.eventLogCol = nil
	h.eventLogSendInFlight.Store(true)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.sendEventLogs()
		}()
	}
	wg.Wait()
	if calls.Load() != 0 {
		t.Fatalf("in-flight pass made %d requests", calls.Load())
	}
	if !h.eventLogSendInFlight.Load() {
		t.Fatal("skipped tick cleared the active pass's guard")
	}
}

func TestSendEventLogsDeferredPassReleasesGuard(t *testing.T) {
	var calls atomic.Int32
	h := newEventLogsTestHeartbeat(eventLogsTestTransport(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("unexpected request")
	}))
	// Do not touch the global Retry-After flag: the existing contract suite
	// expects its default enabled state too.
	if !httputil.LoopRetryAfterEnabled() {
		t.Fatal("test requires default loop Retry-After behavior")
	}
	h.loopDefer.until = map[string]time.Time{loopKey("PUT", h.agentRouteURL("eventlogs")): time.Now().Add(time.Hour)}
	h.sendEventLogs()
	if h.eventLogSendInFlight.Load() {
		t.Fatal("deferred pass did not release its guard")
	}
	if calls.Load() != 0 {
		t.Fatalf("deferred pass made %d requests", calls.Load())
	}
}
