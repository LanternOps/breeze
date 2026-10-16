package unifi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// #7970: an idle agent re-checks no sooner than 75% and no later than 125% of
// IdleFetchInterval, so a fleet that restarts together spreads its polls out.
func TestIdleFetchDelayStaysInsideJitterBand(t *testing.T) {
	lo := IdleFetchInterval - time.Duration(float64(IdleFetchInterval)*idleJitterFraction)
	hi := IdleFetchInterval + time.Duration(float64(IdleFetchInterval)*idleJitterFraction)
	if got := idleFetchDelay(func() float64 { return 0 }); got != lo {
		t.Fatalf("rnd=0: got %v, want lower bound %v", got, lo)
	}
	if got := idleFetchDelay(func() float64 { return 0.5 }); got != IdleFetchInterval {
		t.Fatalf("rnd=0.5: got %v, want %v", got, IdleFetchInterval)
	}
	if got := idleFetchDelay(func() float64 { return 0.999999 }); got > hi || got < hi-time.Second {
		t.Fatalf("rnd~1: got %v, want just under %v", got, hi)
	}
	seen := map[time.Duration]bool{}
	for i := 0; i < 200; i++ {
		d := defaultIdleFetchDelay()
		if d < lo || d > hi {
			t.Fatalf("default idle delay %v outside [%v, %v]", d, lo, hi)
		}
		seen[d] = true
	}
	if len(seen) < 2 {
		t.Fatalf("default idle delay is not jittered: %v", seen)
	}
}

// collectorAPI is a fake Breeze API for the loop: GET counts config fetches and
// answers with whatever `assigned` says; POST swallows telemetry uploads.
type collectorAPI struct {
	srv      *httptest.Server
	gets     atomic.Int32
	posts    atomic.Int32
	assigned atomic.Bool
}

func newCollectorAPI(t *testing.T) *collectorAPI {
	t.Helper()
	// A controller that 404s everything: RunOnce still uploads an error payload.
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	t.Cleanup(controller.Close)
	a := &collectorAPI{}
	a.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			a.posts.Add(1)
			w.WriteHeader(http.StatusAccepted)
			return
		}
		a.gets.Add(1)
		if a.assigned.Load() {
			_, _ = w.Write([]byte(`{"collectors":[{"collectorId":"c1","controllerUrl":"` + controller.URL + `","apiKey":"k","pollIntervalSeconds":15}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"collectors":[]}`))
	}))
	t.Cleanup(a.srv.Close)
	return a
}

func (a *collectorAPI) deps(sched *fetchSchedule, waker *Waker) CollectorDeps {
	return CollectorDeps{
		APIBaseURL: func() string { return a.srv.URL },
		AgentID:    "agent-1",
		HTTP:       a.srv.Client(),
		Wake:       waker,
		schedule:   sched,
	}
}

func startLoop(t *testing.T, deps CollectorDeps) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := StartCollectorLoop(ctx, deps)
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("collector loop did not exit after cancel")
		}
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func fastSchedule() *fetchSchedule {
	return &fetchSchedule{
		first:   time.Millisecond,
		active:  5 * time.Millisecond,
		idle:    func() time.Duration { return time.Hour },
		wakeGap: 0,
	}
}

// The core of #7970: an empty list moves the loop to the idle interval
// instead of re-fetching on the 30 s active cadence.
func TestCollectorLoopBacksOffAfterEmptyList(t *testing.T) {
	api := newCollectorAPI(t)
	startLoop(t, api.deps(fastSchedule(), NewWaker()))

	waitFor(t, "first config fetch", func() bool { return api.gets.Load() >= 1 })
	time.Sleep(100 * time.Millisecond) // 20 active intervals
	if got := api.gets.Load(); got != 1 {
		t.Fatalf("an empty list must back off to the idle interval; got %d fetches in 20 active intervals", got)
	}
}

// A device that IS a collector keeps the active cadence.
func TestCollectorLoopKeepsActiveCadenceWhileAssigned(t *testing.T) {
	api := newCollectorAPI(t)
	api.assigned.Store(true)
	startLoop(t, api.deps(fastSchedule(), NewWaker()))

	waitFor(t, "repeated fetches while assigned", func() bool { return api.gets.Load() >= 4 })
	waitFor(t, "a telemetry upload", func() bool { return api.posts.Load() >= 1 })
}

// The heartbeat hint (#7970) wakes an idle loop: a collector assigned while
// the agent is backed off is fetched and run without waiting out the idle
// interval, and the loop returns to the active cadence.
func TestCollectorLoopWakePicksUpNewAssignment(t *testing.T) {
	api := newCollectorAPI(t)
	waker := NewWaker()
	startLoop(t, api.deps(fastSchedule(), waker))

	waitFor(t, "first (empty) fetch", func() bool { return api.gets.Load() >= 1 })
	time.Sleep(30 * time.Millisecond)
	if got := api.gets.Load(); got != 1 {
		t.Fatalf("expected the loop to be idle after an empty list, got %d fetches", got)
	}

	api.assigned.Store(true)
	waker.Wake()
	waitFor(t, "fetch triggered by the wake", func() bool { return api.gets.Load() >= 2 })
	waitFor(t, "the newly assigned collector to run", func() bool { return api.posts.Load() >= 1 })
	waitFor(t, "active cadence after pickup", func() bool { return api.gets.Load() >= 4 })
}

// The heartbeat repeats the hint every beat while a collector exists. A wake
// arriving sooner than wakeGap after the last fetch is dropped, so a hint the
// config list disagrees with (a stale negative cache on another API instance)
// cannot make the agent fetch faster than wakeGap.
func TestCollectorLoopIgnoresWakeInsideWakeGap(t *testing.T) {
	api := newCollectorAPI(t)
	sched := fastSchedule()
	sched.wakeGap = time.Hour
	waker := NewWaker()
	startLoop(t, api.deps(sched, waker))

	waitFor(t, "first (empty) fetch", func() bool { return api.gets.Load() >= 1 })
	for i := 0; i < 5; i++ {
		waker.Wake()
		time.Sleep(10 * time.Millisecond)
	}
	if got := api.gets.Load(); got != 1 {
		t.Fatalf("wakes inside wakeGap must not fetch; got %d fetches", got)
	}
}

// Wake never blocks the heartbeat goroutine and is safe on a nil Waker (support
// mode starts no collector loop and wires no waker).
func TestWakerIsNonBlockingAndNilSafe(t *testing.T) {
	var nilWaker *Waker
	nilWaker.Wake()
	if nilWaker.C() != nil {
		t.Fatal("nil waker must expose a nil channel")
	}

	w := NewWaker()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			w.Wake()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Wake blocked with nobody receiving")
	}
	select {
	case <-w.C():
	default:
		t.Fatal("coalesced wake was lost")
	}
	select {
	case <-w.C():
		t.Fatal("wakes must coalesce into one pending signal")
	default:
	}
}
