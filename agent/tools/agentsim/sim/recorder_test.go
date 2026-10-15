package sim

import (
	"context"
	"errors"
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

// A request cut off by the run's own deadline/Ctrl-C is not a server or
// network failure and must not show up as a transport error in the report.
func TestRecordingTransportIgnoresRequestsCancelledByTheRunEnding(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	t0 := time.Now().Add(-time.Second)
	rec := NewRecorder("r", t0, t0, t0.Add(time.Hour))
	client := &http.Client{Transport: &recordingTransport{base: http.DefaultTransport, rec: rec}}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/v1/agents/a1/unifi-collectors", nil)
	if _, err := client.Do(req); err == nil {
		t.Fatal("want the cancelled request to fail")
	}
	if st := rec.routes[RouteUnifi]; st != nil && (st.transportErrors != 0 || st.attempts != 0) {
		t.Fatalf("a request cancelled by the run ending was recorded: %+v", st)
	}
}

func TestRecorderFeedsTheTimelineOutsideTheSteadyWindow(t *testing.T) {
	start := time.Now()
	rec := NewRecorder("t", start, start.Add(time.Hour), start.Add(2*time.Hour)) // window far away
	rec.EnableTimeline(time.Second, 10*time.Second)
	rec.ObserveHTTP(RouteHeartbeat, true, start.Add(time.Second), 30*ms, 503, nil)
	rec.ObserveOutcome(RouteHeartbeat, start.Add(2*time.Second), false)
	rec.ObserveOutcome(RouteCrawlConfig, start.Add(2*time.Second), true)
	rec.WSConnected(true, 10*ms)
	b := rec.timeline.Buckets()
	if b[1].Attempts503 != 1 || b[2].HeartbeatsLost != 1 || b[2].RequestsLost != 1 {
		t.Fatalf("timeline not fed outside the window: %+v %+v", b[1], b[2])
	}
	var connects uint64
	for _, x := range b {
		connects += x.WSConnects
	}
	if connects != 1 {
		t.Fatalf("ws connects on the timeline %d, want 1", connects)
	}
}

func TestOutcomeFromResponse(t *testing.T) {
	cases := []struct {
		route  string
		status int
		err    error
		want   bool
	}{
		{RouteHeartbeat, 200, nil, true},
		{RouteHeartbeat, 503, nil, false},
		{RouteHeartbeat, 0, errors.New("reset"), false},
		{RouteCrawlConfig, 401, nil, true}, // workspace module off (README)
		{RouteCrawlConfig, 404, nil, true},
		{RouteSoftware, 429, nil, false},
	}
	for _, c := range cases {
		if got := outcomeOK(c.route, c.status, c.err); got != c.want {
			t.Errorf("%s %d %v: got %v", c.route, c.status, c.err, got)
		}
	}
}

func TestHeartbeatGapIsTimeBetweenSuccesses(t *testing.T) {
	start := time.Now()
	rec := NewRecorder("t", start, start, start.Add(time.Hour))
	rec.EnableTimeline(time.Second, 200*time.Second)
	rec.HeartbeatOK(7, start.Add(10*time.Second))
	rec.HeartbeatOK(7, start.Add(80*time.Second))
	rec.HeartbeatOK(8, start.Add(81*time.Second)) // another agent's first beat: no gap
	b := rec.timeline.Buckets()
	if b[80].MaxHeartbeatGapS != 70 || b[81].MaxHeartbeatGapS != 0 {
		t.Fatalf("gap buckets: %v / %v", b[80].MaxHeartbeatGapS, b[81].MaxHeartbeatGapS)
	}
	if got := rec.OpenGaps(start.Add(150 * time.Second)); got != 70 {
		t.Fatalf("open gap at run end %v, want 70 (agent 7 silent since 80 s)", got)
	}
}

func TestLegacyTransportIgnoresRetryAfter(t *testing.T) {
	var calls atomic.Int32 // the handler runs on the server's goroutine; -race flags a plain int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	rec := newTestRecorder()
	client := newAgentHTTPClient(rec, 2*time.Second)
	client.Transport = &stripRetryAfter{base: client.Transport}
	cfg := httputil.RetryConfig{MaxRetries: 3, InitialDelay: 10 * ms, MaxDelay: 40 * ms, BackoffFactor: 2}
	start := time.Now()
	resp, err := httputil.Do(withLogicalRequest(context.Background()), client, http.MethodPost, srv.URL+"/api/v1/agents/a/process-sample", nil, http.Header{}, cfg)
	if err == nil {
		_ = resp.Body.Close()
	}
	if n := calls.Load(); n != 4 || time.Since(start) > 2*time.Second {
		t.Fatalf("legacy agent made %d attempts in %s; want 4 quick ones (Retry-After 30 ignored)", n, time.Since(start))
	}
}

func TestLegacyCohortIsTheFirstFraction(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	cfg.Agents, cfg.LegacyRetryFraction = 8, 0.25
	for i, want := range []bool{true, true, false, false} {
		a := NewAgent(&cfg, newTestRecorder(), Identity{Index: i}, nil)
		if _, legacy := a.client.Transport.(*stripRetryAfter); legacy != want {
			t.Errorf("agent %d legacy=%v, want %v (round(0.25·8) = 2)", i, legacy, want)
		}
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
	_ = resp.Body.Close()
	st := rec.routes[RouteHeartbeat]
	if st.requests != 1 || st.attempts != 2 || st.status[503] != 1 || st.status[200] != 1 {
		t.Fatalf("want 1 request / 2 attempts / one 503 + one 200, got %+v", st)
	}
}
