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

// statusSequenceServer answers with statuses in order, repeating the last.
func statusSequenceServer(t *testing.T, statuses ...int) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		i := n
		n++
		mu.Unlock()
		if i >= len(statuses) {
			i = len(statuses) - 1
		}
		w.WriteHeader(statuses[i])
	}))
	t.Cleanup(ts.Close)
	return ts, func() int { mu.Lock(); defer mu.Unlock(); return n }
}

// A server outage (5xx) is retried until the report lands.
func TestDeliverPamUnableRetriesTransientFailures(t *testing.T) {
	ts, attempts := statusSequenceServer(t, http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusOK)
	h := unableReportHeartbeat(ts.URL)
	var slept []time.Duration

	err := h.deliverPamUnable("req", pamUnable{Reason: pamUnableHelperUnavailable}, time.Minute,
		[]time.Duration{time.Second, 2 * time.Second}, func(d time.Duration) { slept = append(slept, d) }, time.Now)

	if err != nil {
		t.Fatalf("deliverPamUnable: %v", err)
	}
	if attempts() != 3 {
		t.Fatalf("attempts = %d, want 3", attempts())
	}
	if len(slept) != 2 || slept[0] != time.Second || slept[1] != 2*time.Second {
		t.Fatalf("slept = %v, want [1s 2s]", slept)
	}
}

// 429 is the server shedding load, not a rejection: retry it.
func TestDeliverPamUnableRetriesRateLimit(t *testing.T) {
	ts, attempts := statusSequenceServer(t, http.StatusTooManyRequests, http.StatusOK)
	h := unableReportHeartbeat(ts.URL)

	if err := h.deliverPamUnable("req", pamUnable{Reason: pamUnableHelperUnavailable}, time.Minute,
		[]time.Duration{time.Millisecond}, func(time.Duration) {}, time.Now); err != nil {
		t.Fatalf("deliverPamUnable: %v", err)
	}
	if attempts() != 2 {
		t.Fatalf("attempts = %d, want 2", attempts())
	}
}

// A 429 with Retry-After longer than the next scheduled delay is honored.
func TestDeliverPamUnableHonorsRetryAfter(t *testing.T) {
	var mu sync.Mutex
	n := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		i := n
		n++
		mu.Unlock()
		if i == 0 {
			w.Header().Set("Retry-After", "45")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	h := unableReportHeartbeat(ts.URL)
	var slept []time.Duration

	if err := h.deliverPamUnable("req", pamUnable{Reason: pamUnableHelperUnavailable}, 5*time.Minute,
		[]time.Duration{5 * time.Second}, func(d time.Duration) { slept = append(slept, d) }, time.Now); err != nil {
		t.Fatalf("deliverPamUnable: %v", err)
	}
	if len(slept) != 1 || slept[0] > 45*time.Second || slept[0] < 44*time.Second {
		t.Fatalf("slept = %v, want [~45s] from Retry-After", slept)
	}
}

// Time already spent inside the attempt after the server's answer (httputil
// sleeping toward Retry-After until the attempt timeout) counts toward the
// wait: the next attempt comes Retry-After after the answer, not after the
// attempt returned.
func TestDeliverPamUnableCountsRetryAfterAlreadySpent(t *testing.T) {
	var mu sync.Mutex
	n := 0
	var offset time.Duration
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		i := n
		n++
		mu.Unlock()
		if i == 0 {
			// From here on the agent's clock reads 20 s later than the
			// moment httputil records the answer, as if Do had slept that
			// long toward the Retry-After before its context ended.
			mu.Lock()
			offset = 20 * time.Second
			mu.Unlock()
			w.Header().Set("Retry-After", "45")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	h := unableReportHeartbeat(ts.URL)
	var slept []time.Duration
	now := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return time.Now().Add(offset)
	}
	sleep := func(d time.Duration) { slept = append(slept, d) }

	if err := h.deliverPamUnable("req", pamUnable{Reason: pamUnableHelperUnavailable}, 5*time.Minute,
		[]time.Duration{5 * time.Second}, sleep, now); err != nil {
		t.Fatalf("deliverPamUnable: %v", err)
	}
	if len(slept) != 1 || slept[0] > 25*time.Second || slept[0] < 24*time.Second {
		t.Fatalf("slept = %v, want [~25s]: 45s Retry-After minus the 20s already spent", slept)
	}
}

// A 4xx rejection is final: resending the same report cannot help.
func TestDeliverPamUnableStopsOnRejection(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusForbidden, http.StatusNotFound} {
		ts, attempts := statusSequenceServer(t, status)
		h := unableReportHeartbeat(ts.URL)

		err := h.deliverPamUnable("req", pamUnable{Reason: pamUnableHelperUnavailable}, time.Minute,
			[]time.Duration{time.Millisecond}, func(time.Duration) {}, time.Now)

		if err == nil {
			t.Fatalf("status %d: want an error", status)
		}
		if attempts() != 1 {
			t.Fatalf("status %d: attempts = %d, want 1", status, attempts())
		}
	}
}

// A server that stays down is given up on once the window would be exceeded.
func TestDeliverPamUnableGivesUpAfterWindow(t *testing.T) {
	ts, attempts := statusSequenceServer(t, http.StatusServiceUnavailable)
	h := unableReportHeartbeat(ts.URL)
	clock := time.Date(2027, 1, 2, 12, 0, 0, 0, time.UTC)
	var slept []time.Duration

	err := h.deliverPamUnable("req", pamUnable{Reason: pamUnableHelperUnavailable}, 10*time.Second,
		[]time.Duration{3 * time.Second},
		func(d time.Duration) { slept = append(slept, d); clock = clock.Add(d) },
		func() time.Time { return clock })

	if err == nil {
		t.Fatal("want an error once the window is spent")
	}
	// 10s window, 3s delays: attempts at t=0,3,6,9; the next would start at 12s.
	if attempts() != 4 || len(slept) != 3 {
		t.Fatalf("attempts=%d slept=%v, want 4 attempts and 3 sleeps", attempts(), slept)
	}
}

// A hung attempt cannot carry the report past its window: each attempt's
// timeout is capped by the time left.
func TestDeliverPamUnableAttemptNeverOutlivesWindow(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	hits := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(ts.Close)
	t.Cleanup(func() { close(release) })
	h := unableReportHeartbeat(ts.URL)

	start := time.Now()
	err := h.deliverPamUnable("req", pamUnable{Reason: pamUnableHelperUnavailable}, 300*time.Millisecond,
		[]time.Duration{time.Millisecond}, func(d time.Duration) { time.Sleep(d) }, time.Now)

	if err == nil {
		t.Fatal("want an error from a server that never answers")
	}
	// 300ms window plus scheduling slack; a regression that lets an attempt run
	// its full 30s timeout lands far outside this.
	elapsed := time.Since(start)
	if elapsed > 900*time.Millisecond {
		t.Fatalf("delivery ran %s past a 300ms window", elapsed)
	}
	// The report was actually attempted and held until the window ran out,
	// not abandoned before reaching the server.
	mu.Lock()
	got := hits
	mu.Unlock()
	if got == 0 {
		t.Fatal("no attempt reached the server")
	}
	if elapsed < 250*time.Millisecond {
		t.Fatalf("delivery gave up after %s, before its 300ms window", elapsed)
	}
}
