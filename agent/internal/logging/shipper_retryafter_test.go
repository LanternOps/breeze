package logging

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// These tests swap package-level seams and therefore must not use t.Parallel().

const hangGuard = 5 * time.Second

// seamFixture replaces the shipper clock/After/rand/tick seams for one test.
type seamFixture struct {
	now      atomic.Int64 // unix nanos
	randVal  atomic.Uint64
	autoFire atomic.Bool
	waits    chan time.Duration // every After(d) registers d here
	ticks    chan time.Time
}

func newSeamFixture(t *testing.T, autoFire bool, rnd float64) *seamFixture {
	t.Helper()
	f := &seamFixture{waits: make(chan time.Duration, 64), ticks: make(chan time.Time)}
	f.now.Store(time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC).UnixNano())
	f.setRand(rnd)
	f.autoFire.Store(autoFire)

	oldNow, oldAfter, oldRand, oldTick := shipperNow, shipperAfter, shipperRand, shipperTick
	shipperNow = func() time.Time { return time.Unix(0, f.now.Load()).UTC() }
	shipperAfter = func(d time.Duration) <-chan time.Time {
		f.waits <- d
		ch := make(chan time.Time, 1)
		if f.autoFire.Load() {
			ch <- time.Time{}
		}
		return ch
	}
	shipperRand = func() float64 { return float64(f.randVal.Load()) / 1e6 }
	shipperTick = func(time.Duration) (<-chan time.Time, func()) { return f.ticks, func() {} }
	t.Cleanup(func() {
		shipperNow, shipperAfter, shipperRand, shipperTick = oldNow, oldAfter, oldRand, oldTick
	})
	return f
}

func (f *seamFixture) setRand(v float64) { f.randVal.Store(uint64(v * 1e6)) }
func (f *seamFixture) advance(d time.Duration) {
	f.now.Add(int64(d))
}
func (f *seamFixture) time() time.Time { return time.Unix(0, f.now.Load()).UTC() }

func setLoopRetryAfterForTest(t *testing.T, enabled bool) {
	t.Helper()
	SetLoopRetryAfter(enabled)
	t.Cleanup(func() { SetLoopRetryAfter(true) })
}

type raServer struct {
	*httptest.Server
	requests atomic.Int32
	status   atomic.Int32
	hint     string
}

func newRAServer(t *testing.T, status int, hint string) *raServer {
	t.Helper()
	rs := &raServer{hint: hint}
	rs.status.Store(int32(status))
	rs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.requests.Add(1)
		st := int(rs.status.Load())
		if st == http.StatusServiceUnavailable || st == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", rs.hint)
		}
		w.WriteHeader(st)
	}))
	t.Cleanup(rs.Close)
	return rs
}

func newRAShipper(rs *raServer) *Shipper {
	return NewShipper(ShipperConfig{
		ServerURL:  func() string { return rs.URL },
		AgentID:    "test-agent",
		AuthToken:  testToken("tok"),
		MinLevel:   "debug",
		HTTPClient: rs.Client(),
	})
}

func (s *Shipper) carried() time.Time {
	s.retryMu.Lock()
	defer s.retryMu.Unlock()
	return s.notBefore
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(hangGuard)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		runtime.Gosched()
	}
}

func TestShipperStopInterruptsRetryAfterWait(t *testing.T) {
	f := newSeamFixture(t, false, 0)
	rs := newRAServer(t, http.StatusServiceUnavailable, "45")
	s := newRAShipper(rs)

	done := make(chan bool, 1)
	go func() { done <- s.shipChunk(makeEntries(3)) }()

	select {
	case d := <-f.waits:
		if d != 45*time.Second {
			t.Fatalf("retry wait = %v, want 45s", d)
		}
	case <-time.After(hangGuard):
		t.Fatal("shipChunk never entered its retry wait")
	}

	s.Stop()

	select {
	case ok := <-done:
		if ok {
			t.Fatal("shipChunk returned true after shutdown mid-wait; want terminal false")
		}
	case <-time.After(hangGuard):
		t.Fatal("shipChunk still parked after Stop: the retry wait is not cancellable")
	}
	if got := s.DroppedLogCount(); got != 3 {
		t.Fatalf("dropped = %d, want 3 (chunk lost on shutdown)", got)
	}
	if !s.carried().IsZero() {
		t.Fatal("shutdown must not carry a hold")
	}
}

func TestShipperCarriesRetryAfterToNextBatch(t *testing.T) {
	f := newSeamFixture(t, true, 0) // rand 0 => no jitter, hint is exactly 40 s
	rs := newRAServer(t, http.StatusServiceUnavailable, "40")
	s := newRAShipper(rs)
	start := f.time()

	s.Start()
	t.Cleanup(s.Stop)

	enqueueAndSettle := func(n int) {
		for _, e := range makeEntries(n) {
			s.Enqueue(e)
		}
		waitFor(t, "loop to take the entries", func() bool { return len(s.buffer) == 0 })
	}

	// Batch 1: every attempt answers 503 + Retry-After 40 -> dropped, hold set.
	enqueueAndSettle(3)
	f.ticks <- time.Time{} // ship batch 1
	f.ticks <- time.Time{} // sync: loop finished handling the previous tick
	if got := rs.requests.Load(); got != 3 {
		t.Fatalf("batch 1 requests = %d, want 3 attempts", got)
	}
	if got := s.DroppedLogCount(); got != 3 {
		t.Fatalf("dropped = %d, want 3", got)
	}
	if got, want := s.carried(), start.Add(40*time.Second); !got.Equal(want) {
		t.Fatalf("notBefore = %v, want %v", got, want)
	}

	// Batch 2 while the hold stands: must not be posted.
	rs.status.Store(http.StatusCreated)
	enqueueAndSettle(2)
	f.advance(39 * time.Second)
	f.ticks <- time.Time{}
	f.ticks <- time.Time{}
	if got := rs.requests.Load(); got != 3 {
		t.Fatalf("batch posted %d requests early, want still 3", got-3)
	}

	// Hold passed: batch 2 (kept buffered) is posted.
	f.advance(2 * time.Second)
	f.ticks <- time.Time{}
	f.ticks <- time.Time{}
	if got := rs.requests.Load(); got != 4 {
		t.Fatalf("requests after hold = %d, want 4", got)
	}
	if !s.carried().IsZero() {
		t.Fatalf("hold should clear once passed, got %v", s.carried())
	}
	if got := s.DroppedLogCount(); got != 3 {
		t.Fatalf("dropped = %d, want still 3 (deferred batch must not be lost)", got)
	}
}

func TestShipperDeferralLogsOncePerHold(t *testing.T) {
	f := newSeamFixture(t, true, 0)
	rs := newRAServer(t, http.StatusServiceUnavailable, "40")
	s := newRAShipper(rs)
	s.shipChunk(makeEntries(1))
	if !s.shipDeferred() {
		t.Fatal("expected deferral")
	}
	s.retryMu.Lock()
	logged := s.deferLogged
	s.retryMu.Unlock()
	if !logged {
		t.Fatal("deferral not marked logged")
	}
	f.advance(41 * time.Second)
	if s.shipDeferred() {
		t.Fatal("deferral should end after notBefore")
	}
	s.retryMu.Lock()
	logged = s.deferLogged
	s.retryMu.Unlock()
	if logged {
		t.Fatal("deferLogged must reset when the hold ends")
	}
}

func TestShipperFullBatchHeldDoesNotGrow(t *testing.T) {
	f := newSeamFixture(t, true, 0)
	rs := newRAServer(t, http.StatusCreated, "")
	s := newRAShipper(rs)
	s.carryRetryAfter(40 * time.Second)

	s.Start()
	t.Cleanup(s.Stop)
	for _, e := range makeEntries(defaultMaxBatchSize) {
		s.Enqueue(e)
	}
	waitFor(t, "loop to take a full batch", func() bool { return len(s.buffer) == 0 })
	// Further entries must stay in the buffer while the full batch is held.
	for _, e := range makeEntries(5) {
		s.Enqueue(e)
	}
	f.ticks <- time.Time{}
	f.ticks <- time.Time{}
	if got := len(s.buffer); got != 5 {
		t.Fatalf("buffer = %d, want 5 (held full batch must stop draining the buffer)", got)
	}
	if got := rs.requests.Load(); got != 0 {
		t.Fatalf("posted %d requests during hold", got)
	}
	f.advance(41 * time.Second)
	f.ticks <- time.Time{}
	f.ticks <- time.Time{}
	if got := rs.requests.Load(); got < 1 {
		t.Fatal("full batch not posted after hold")
	}
}

func TestShipperDrainIgnoresHold(t *testing.T) {
	newSeamFixture(t, true, 0)
	rs := newRAServer(t, http.StatusCreated, "")
	s := newRAShipper(rs)
	s.carryRetryAfter(200 * time.Second)

	s.Start()
	for _, e := range makeEntries(4) {
		s.Enqueue(e)
	}
	waitFor(t, "loop to take entries", func() bool { return len(s.buffer) == 0 })
	s.Stop()
	if got := rs.requests.Load(); got != 1 {
		t.Fatalf("shutdown drain requests = %d, want 1 (hold must not block the final flush)", got)
	}
}

func TestShipperShortHintsUnchanged(t *testing.T) {
	f := newSeamFixture(t, true, 0.5) // jitter -> 3 s x 1.15
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			w.Header().Set("Retry-After", "3")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)
	s := NewShipper(ShipperConfig{
		ServerURL: func() string { return srv.URL }, AgentID: "a",
		AuthToken: testToken("tok"), MinLevel: "debug", HTTPClient: srv.Client(),
	})

	if !s.shipChunk(makeEntries(2)) {
		t.Fatal("chunk should ship on the second attempt")
	}
	select {
	case d := <-f.waits:
		if want := 3450 * time.Millisecond; d < want-time.Millisecond || d > want+time.Millisecond {
			t.Fatalf("in-loop wait = %v, want jittered %v", d, want)
		}
	default:
		t.Fatal("no in-loop wait registered")
	}
	if !s.carried().IsZero() {
		t.Fatalf("nothing should be carried, got %v", s.carried())
	}
	if s.DroppedLogCount() != 0 {
		t.Fatal("nothing should be dropped")
	}
}

func TestShipperLoopRetryAfterDisabled(t *testing.T) {
	newSeamFixture(t, true, 0)
	setLoopRetryAfterForTest(t, false)
	rs := newRAServer(t, http.StatusServiceUnavailable, "40")
	s := newRAShipper(rs)

	if s.shipChunk(makeEntries(3)) {
		t.Fatal("chunk should be given up on")
	}
	if !s.carried().IsZero() {
		t.Fatalf("disabled: nothing may be carried, got %v", s.carried())
	}
	if s.shipDeferred() {
		t.Fatal("disabled: next batch must not be deferred")
	}
	rs.status.Store(http.StatusCreated)
	before := rs.requests.Load()
	if !s.shipChunk(makeEntries(1)) || rs.requests.Load() != before+1 {
		t.Fatal("next batch should post immediately")
	}
}

func TestShipperNotBeforeClampedTo300s(t *testing.T) {
	f := newSeamFixture(t, true, 0.999)
	rs := newRAServer(t, http.StatusTooManyRequests, "99999")
	s := newRAShipper(rs)
	now := f.time()

	s.shipChunk(makeEntries(1))
	nb := s.carried()
	if nb.IsZero() {
		t.Fatal("expected a carried hold")
	}
	if nb.After(now.Add(300 * time.Second)) {
		t.Fatalf("notBefore %v exceeds now+300s", nb.Sub(now))
	}
	if !nb.Equal(now.Add(300 * time.Second)) {
		t.Fatalf("notBefore = now+%v, want exactly the 300 s cap", nb.Sub(now))
	}
}

func TestShipperKeepsLaterHold(t *testing.T) {
	newSeamFixture(t, true, 0)
	s := NewShipper(ShipperConfig{ServerURL: func() string { return "" }, AuthToken: testToken("t")})
	s.carryRetryAfter(100 * time.Second)
	first := s.carried()
	if first.IsZero() {
		t.Fatal("first hint was not recorded")
	}
	s.carryRetryAfter(10 * time.Second)
	if !s.carried().Equal(first) {
		t.Fatal("a shorter hint must not shorten an existing hold")
	}
}
