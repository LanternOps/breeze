package unifi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

// W09 (#8148): the collector loop honours the server's Retry-After on both the
// config fetch and the telemetry upload.

func TestJitterRetryAfter(t *testing.T) {
	if got := jitterRetryAfter(300*time.Second, 0.999); got != 300*time.Second {
		t.Fatalf("RA 300 @0.999: got %v, want cap 300s", got)
	}
	if got := jitterRetryAfter(40*time.Second, 0.5); got != 46*time.Second {
		t.Fatalf("RA 40 @0.5: got %v, want 46s", got)
	}
	if got := jitterRetryAfter(40*time.Second, 0); got != 40*time.Second {
		t.Fatalf("RA 40 @0: got %v, want 40s", got)
	}
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)}
}

// fetchRig serves GET /unifi-collectors with a fixed status/header and records
// the waits the loop computes. The waitHook swaps every wait for 1 ms so the
// test never waits in real time.
type fetchRig struct {
	status     int
	retryAfter string
	waits      chan time.Duration
	srv        *httptest.Server
}

func newFetchRig(t *testing.T, status int, retryAfter string) *fetchRig {
	t.Helper()
	r := &fetchRig{status: status, retryAfter: retryAfter, waits: make(chan time.Duration, 64)}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if r.retryAfter != "" {
			w.Header().Set("Retry-After", r.retryAfter)
		}
		w.WriteHeader(r.status)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

// firstWait runs the loop until it has computed its first post-fetch wait.
func (r *fetchRig) firstWait(t *testing.T, rnd float64) time.Duration {
	t.Helper()
	clk := newFakeClock()
	sched := &fetchSchedule{first: time.Millisecond, active: ActiveFetchInterval, idle: func() time.Duration { return IdleFetchInterval }, wakeGap: time.Millisecond}
	deps := CollectorDeps{
		APIBaseURL: func() string { return r.srv.URL },
		AgentID:    "agent-1",
		HTTP:       r.srv.Client(),
		schedule:   sched,
		now:        clk.Now,
		rnd:        func() float64 { return rnd },
		waitHook: func(d time.Duration) time.Duration {
			select {
			case r.waits <- d:
			default:
			}
			return time.Millisecond
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := StartCollectorLoop(ctx, deps)
	defer func() { cancel(); <-done }()
	select {
	case d := <-r.waits:
		return d
	case <-time.After(5 * time.Second):
		t.Fatal("loop never computed a wait")
		return 0
	}
}

func TestFetchConfigsHonoursRetryAfter(t *testing.T) {
	if !httputil.LoopRetryAfterEnabled() {
		t.Fatal("loop Retry-After should default to enabled")
	}
	if got := newFetchRig(t, 503, "40").firstWait(t, 0.5); got != 46*time.Second {
		t.Fatalf("rnd 0.5: next wait %v, want 46s (40 x 1.15), not the 30s cadence", got)
	}
	got := newFetchRig(t, 503, "40").firstWait(t, 1)
	if got < 40*time.Second || got > 52*time.Second {
		t.Fatalf("rnd 1: next wait %v, want within [40s, 52s]", got)
	}
	if got := newFetchRig(t, 429, "40").firstWait(t, 0.5); got != 46*time.Second {
		t.Fatalf("429: next wait %v, want 46s", got)
	}
}

func TestUnifiNoHintUnchanged(t *testing.T) {
	if got := newFetchRig(t, 503, "").firstWait(t, 0.5); got != ActiveFetchInterval {
		t.Fatalf("bare 503: next wait %v, want %v", got, ActiveFetchInterval)
	}
	// An unusable header is the same as none.
	if got := newFetchRig(t, 503, "soon").firstWait(t, 0.5); got != ActiveFetchInterval {
		t.Fatalf("garbage Retry-After: next wait %v, want %v", got, ActiveFetchInterval)
	}
}

func TestUnifiLoopRetryAfterDisabled(t *testing.T) {
	httputil.SetLoopRetryAfter(false)
	t.Cleanup(func() { httputil.SetLoopRetryAfter(true) })
	if got := newFetchRig(t, 503, "40").firstWait(t, 0.5); got != ActiveFetchInterval {
		t.Fatalf("disabled: next wait %v, want %v", got, ActiveFetchInterval)
	}
}

// A Wake during a Retry-After deferral must not fetch before RetryAt.
func TestWakeDuringRetryAfterDeferralDoesNotFetch(t *testing.T) {
	clk := newFakeClock()
	getCh := make(chan int32, 16)
	var gets atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		n := gets.Add(1)
		if n == 1 {
			_, _ = w.Write([]byte(`{"collectors":[]}`)) // goes idle
		} else {
			w.Header().Set("Retry-After", "40")
			w.WriteHeader(503)
		}
		select {
		case getCh <- n:
		default:
		}
	}))
	t.Cleanup(srv.Close)
	waker := NewWaker()
	waits := make(chan time.Duration, 64)
	sched := &fetchSchedule{first: time.Millisecond, active: ActiveFetchInterval, idle: func() time.Duration { return time.Millisecond }, wakeGap: time.Millisecond}
	deps := CollectorDeps{
		APIBaseURL: func() string { return srv.URL }, AgentID: "agent-1", HTTP: srv.Client(),
		Wake: waker, schedule: sched, now: clk.Now, rnd: func() float64 { return 0 },
		waitHook: func(d time.Duration) time.Duration {
			select {
			case waits <- d:
			default:
			}
			if d >= 40*time.Second {
				return time.Hour // park: only a Wake can end this wait early
			}
			return time.Millisecond
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := StartCollectorLoop(ctx, deps)
	defer func() { cancel(); <-done }()
	wait := func() {
		select {
		case <-getCh:
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for a GET")
		}
	}
	wait() // GET #1: ok, empty -> idle
	wait() // GET #2: 503 + Retry-After 40
	deferred := false
	guard := time.After(5 * time.Second)
	for !deferred {
		select {
		case d := <-waits:
			deferred = d >= 40*time.Second
		case <-guard:
			t.Fatal("loop never deferred")
		}
	}
	waker.Wake()
	deadline := time.Now().Add(5 * time.Second)
	for len(waker.ch) != 0 && time.Now().Before(deadline) {
		runtime.Gosched()
	}
	select {
	case n := <-getCh:
		t.Fatalf("Wake during deferral fetched (GET #%d) before RetryAt", n)
	case <-time.After(150 * time.Millisecond):
	}
	// Once RetryAt has passed, a Wake fetches again.
	clk.Add(41 * time.Second)
	waker.Wake()
	wait()
}

// One collector (poll interval 15 s); POST telemetry answers 503 + Retry-After
// 120. waitHook advances the fake clock by a script of steps, so the loop
// iterations are deterministic.
func TestTelemetryHonoursRetryAfter(t *testing.T) {
	clk := newFakeClock()
	var posts, controllerHits atomic.Int32
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controllerHits.Add(1)
		w.WriteHeader(404)
	}))
	t.Cleanup(controller.Close)
	type seen struct{ posts, controller int32 }
	var mu sync.Mutex
	var atGet []seen
	getCh := make(chan struct{}, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(503)
			return
		}
		mu.Lock()
		atGet = append(atGet, seen{posts.Load(), controllerHits.Load()})
		mu.Unlock()
		_, _ = w.Write([]byte(`{"collectors":[{"collectorId":"c1","controllerUrl":"` + controller.URL + `","apiKey":"k","pollIntervalSeconds":15}]}`))
		select {
		case getCh <- struct{}{}:
		default:
		}
	}))
	t.Cleanup(srv.Close)

	// t0+20 s (past the 15 s poll interval, before RetryAt), then t0+121 s (past RetryAt).
	steps := []time.Duration{20 * time.Second, 101 * time.Second}
	var call atomic.Int32
	sched := &fetchSchedule{first: time.Millisecond, active: ActiveFetchInterval, idle: func() time.Duration { return IdleFetchInterval }, wakeGap: time.Millisecond}
	deps := CollectorDeps{
		APIBaseURL: func() string { return srv.URL }, AgentID: "agent-1", HTTP: srv.Client(),
		schedule: sched, now: clk.Now, rnd: func() float64 { return 0 },
		waitHook: func(d time.Duration) time.Duration {
			if i := int(call.Add(1)) - 1; i < len(steps) {
				clk.Add(steps[i])
			}
			return time.Millisecond
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := StartCollectorLoop(ctx, deps)
	defer func() { cancel(); <-done }()
	for i := 0; i < 4; i++ {
		select {
		case <-getCh:
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for GET #%d", i+1)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	// Counts at the start of each config fetch = end of the previous iteration.
	// GET #3 (t0+20 s) must not have run the collector: RetryAt is t0+120 s.
	want := []seen{{0, 0}, {1, 1}, {1, 1}, {2, 2}}
	for i, w := range want {
		if atGet[i] != w {
			t.Fatalf("at GET #%d: posts/controller polls = %+v, want %+v (all: %+v)", i+1, atGet[i], w, atGet)
		}
	}
}
