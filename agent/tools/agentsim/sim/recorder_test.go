package sim

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

func TestRecorderCountsOnlyInsideTheWindow(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("r", t0, t0.Add(time.Minute), t0.Add(2*time.Minute))
	rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(30*time.Second), 10*time.Millisecond, 200, nil) // before
	rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(90*time.Second), 10*time.Millisecond, 200, nil) // inside
	rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(3*time.Minute), 10*time.Millisecond, 503, nil)  // after
	st := rec.routes[RouteHeartbeat]
	if st.requests != 1 || st.status[200] != 1 || st.statusTotal[200] != 2 || st.statusTotal[503] != 1 {
		t.Fatalf("window accounting wrong: %+v", st)
	}
}

func TestAgentMinutesClipToTheWindow(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("r", t0, t0.Add(time.Minute), t0.Add(3*time.Minute))
	rec.AgentOnline(0, t0)                      // runs through the whole window: 2 min
	rec.AgentOnline(1, t0.Add(2*time.Minute))   // joins late: 1 min
	rec.AgentOnline(2, t0)                      // leaves early
	rec.AgentOffline(2, t0.Add(90*time.Second)) // 0.5 min
	minutes, onlineAtOpen := rec.agentMinutes(t0.Add(10 * time.Minute))
	if minutes < 3.49 || minutes > 3.51 {
		t.Fatalf("agent-minutes = %.3f, want 3.5", minutes)
	}
	if onlineAtOpen != 2 {
		t.Fatalf("online at window open = %d, want 2", onlineAtOpen)
	}
}

func TestRecordingTransportCountsOneRequestAcrossRetries(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t0 := time.Now().Add(-time.Second)
	rec := NewRecorder("r", t0, t0, t0.Add(time.Hour))
	client := &http.Client{Transport: &recordingTransport{base: http.DefaultTransport, rec: rec}}
	retry := httputil.RetryConfig{MaxRetries: 2, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond, BackoffFactor: 1}
	resp, err := httputil.Do(withLogicalRequest(context.Background()), client, http.MethodPost,
		srv.URL+"/api/v1/agents/a1/heartbeat", []byte(`{}`), http.Header{}, retry)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	st := rec.routes[RouteHeartbeat]
	if st.requests != 1 || st.attempts != 2 || st.status[503] != 1 || st.status[200] != 1 {
		t.Fatalf("want 1 request / 2 attempts / one 503 + one 200, got %+v", st)
	}
}
