package logging

import (
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/parked"
)

// #8318 D-1a: while parked the shipper holds its batch (no request at all),
// ships it as soon as the device is assigned, and drops it without a request
// at shutdown. These tests swap package seams: no t.Parallel().

func newParkedShipper(rs *raServer, st *parked.State) *Shipper {
	return NewShipper(ShipperConfig{
		ServerURL:  func() string { return rs.URL },
		AgentID:    "test-agent",
		AuthToken:  testToken("tok"),
		MinLevel:   "debug",
		HTTPClient: rs.Client(),
		Parked:     st,
	})
}

func fireTick(t *testing.T, f *seamFixture) {
	t.Helper()
	select {
	case f.ticks <- time.Now():
	case <-time.After(hangGuard):
		t.Fatal("ship loop did not take the tick")
	}
}

func TestShipperHoldsWhileParkedAndShipsOnAssignment(t *testing.T) {
	f := newSeamFixture(t, true, 0)
	rs := newRAServer(t, http.StatusOK, "")
	st := parked.New()
	st.ObserveBeat(true)
	s := newParkedShipper(rs, st)
	s.Start()
	t.Cleanup(s.Stop)

	for _, e := range makeEntries(3) {
		s.Enqueue(e)
	}
	waitFor(t, "entries pulled into the batch", func() bool { return len(s.buffer) == 0 })
	// Two ticks: neither ships while parked.
	fireTick(t, f)
	fireTick(t, f)
	if n := rs.requests.Load(); n != 0 {
		t.Fatalf("requests while parked = %d, want 0", n)
	}

	// Assigned: the held batch ships without waiting for a tick.
	st.ObserveBeat(false)
	waitFor(t, "held batch shipped on assignment", func() bool { return rs.requests.Load() == 1 })
	if got := s.DroppedLogCount(); got != 0 {
		t.Fatalf("dropped = %d, want 0", got)
	}
}

func TestShipperDropsHeldEntriesAtShutdownWhileParked(t *testing.T) {
	newSeamFixture(t, true, 0)
	rs := newRAServer(t, http.StatusOK, "")
	st := parked.New()
	st.ObserveBeat(true)
	s := newParkedShipper(rs, st)
	s.Start()

	for _, e := range makeEntries(4) {
		s.Enqueue(e)
	}
	s.Stop()
	if n := rs.requests.Load(); n != 0 {
		t.Fatalf("requests at a parked shutdown = %d, want 0", n)
	}
	if got := s.DroppedLogCount(); got != 4 {
		t.Fatalf("dropped = %d, want 4", got)
	}
}

// Memory stays bounded while parked: a full batch stops pulling, the buffer
// fills, and Enqueue drops (and counts) the rest.
func TestShipperParkedHoldIsBounded(t *testing.T) {
	f := newSeamFixture(t, true, 0)
	rs := newRAServer(t, http.StatusOK, "")
	st := parked.New()
	st.ObserveBeat(true)
	s := newParkedShipper(rs, st)
	s.Start()
	t.Cleanup(s.Stop)

	total := defaultMaxBatchSize + defaultBufferSize + 25
	for i := 0; i < total; i++ {
		s.Enqueue(makeEntries(1)[0])
	}
	fireTick(t, f)
	waitFor(t, "overflow counted", func() bool { return s.DroppedLogCount() >= 25 })
	if n := rs.requests.Load(); n != 0 {
		t.Fatalf("requests while parked = %d, want 0", n)
	}
}

func TestShipperUnwiredParkedShipsAsBefore(t *testing.T) {
	f := newSeamFixture(t, true, 0)
	rs := newRAServer(t, http.StatusOK, "")
	s := newParkedShipper(rs, nil)
	s.Start()
	t.Cleanup(s.Stop)
	for _, e := range makeEntries(2) {
		s.Enqueue(e)
	}
	waitFor(t, "entries pulled into the batch", func() bool { return len(s.buffer) == 0 })
	fireTick(t, f)
	waitFor(t, "batch shipped", func() bool { return rs.requests.Load() == 1 })
}
