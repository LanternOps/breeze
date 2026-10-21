package heartbeat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

type capturedUnableRequest struct {
	method, path, auth, contentType string
	body                            map[string]any
}

func unableReportServer(t *testing.T, status int) (*httptest.Server, func() []capturedUnableRequest) {
	t.Helper()
	var mu sync.Mutex
	var got []capturedUnableRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		got = append(got, capturedUnableRequest{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), body})
		mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"status":"recorded"}`))
	}))
	t.Cleanup(ts.Close)
	return ts, func() []capturedUnableRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]capturedUnableRequest(nil), got...)
	}
}

func unableReportHeartbeat(serverURL string) *Heartbeat {
	h := NewWithVersion(&config.Config{AgentID: "agent-9517", ServerURL: serverURL, AuthToken: "token"}, "test", nil, nil)
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond}
	return h
}

// #9517: the wire shape the API's pamElevationUnableSchema accepts.
func TestSendPamElevationUnablePostsReport(t *testing.T) {
	ts, captured := unableReportServer(t, http.StatusOK)
	h := unableReportHeartbeat(ts.URL)

	err := h.sendPamElevationUnable(context.Background(), "11111111-1111-4111-8111-111111111111",
		pamUnable{Reason: pamUnableSessionUnavailable, Detail: "session 7 cannot host a SYSTEM helper"})
	if err != nil {
		t.Fatalf("sendPamElevationUnable: %v", err)
	}
	got := captured()
	if len(got) != 1 {
		t.Fatalf("requests = %d, want 1", len(got))
	}
	r := got[0]
	if r.method != http.MethodPost || r.path != "/api/v1/agents/agent-9517/pam/elevation-unable" {
		t.Fatalf("request = %s %s", r.method, r.path)
	}
	if r.auth == "" || r.contentType != "application/json" {
		t.Fatalf("auth=%q contentType=%q", r.auth, r.contentType)
	}
	want := map[string]any{
		"elevationRequestId": "11111111-1111-4111-8111-111111111111",
		"reason":             "session_unavailable",
		"detail":             "session 7 cannot host a SYSTEM helper",
	}
	if len(r.body) != len(want) {
		t.Fatalf("body = %v, want exactly %v", r.body, want)
	}
	for k, v := range want {
		if r.body[k] != v {
			t.Fatalf("body[%q] = %v, want %v", k, r.body[k], v)
		}
	}
}

// An empty detail is omitted rather than sent as "".
func TestSendPamElevationUnableOmitsEmptyDetail(t *testing.T) {
	ts, captured := unableReportServer(t, http.StatusOK)
	h := unableReportHeartbeat(ts.URL)

	if err := h.sendPamElevationUnable(context.Background(), "req", pamUnable{Reason: pamUnableHelperUnavailable}); err != nil {
		t.Fatalf("sendPamElevationUnable: %v", err)
	}
	if _, ok := captured()[0].body["detail"]; ok {
		t.Fatalf("detail sent although empty: %v", captured()[0].body)
	}
}

// 404 (unknown request, or a server that predates the endpoint) is an error
// and is not retried.
func TestSendPamElevationUnableNotFoundIsAnErrorWithoutRetry(t *testing.T) {
	ts, captured := unableReportServer(t, http.StatusNotFound)
	h := unableReportHeartbeat(ts.URL)
	h.retryCfg = httputil.RetryConfig{MaxRetries: 3, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond}

	if err := h.sendPamElevationUnable(context.Background(), "req", pamUnable{Reason: pamUnableHelperUnavailable}); err == nil {
		t.Fatal("want an error for 404")
	}
	if n := len(captured()); n != 1 {
		t.Fatalf("attempts = %d, want 1 (404 is not retryable)", n)
	}
}

// The default (no seam) path sends the report asynchronously, so RunPamFlow
// on the etwlua loop never waits on the network.
func TestReportPamUnableSendsAsynchronously(t *testing.T) {
	release := make(chan struct{})
	arrived := make(chan struct{}, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		arrived <- struct{}{}
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	t.Cleanup(func() { close(release) })
	h := unableReportHeartbeat(ts.URL)

	done := make(chan struct{})
	go func() {
		h.reportPamUnable("req-async", &pamUnable{Reason: pamUnableHelperStartFailed, Detail: "helper did not become ready in time"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reportPamUnable blocked on the server")
	}
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("report never reached the server")
	}
}

// A nil report (cancelled flow) or a missing request id sends nothing.
func TestReportPamUnableIgnoresNilAndEmptyRequest(t *testing.T) {
	calls := 0
	h := &Heartbeat{pamReportUnable: func(string, pamUnable) { calls++ }}
	h.reportPamUnable("req", nil)
	h.reportPamUnable("", &pamUnable{Reason: pamUnableHelperUnavailable})
	if calls != 0 {
		t.Fatalf("calls = %d, want 0", calls)
	}
}
