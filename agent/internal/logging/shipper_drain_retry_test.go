package logging

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// W09 (#8148) review: the shutdown drain must still ride out a transient
// failure with the short fixed backoff, as before the waits became
// cancellable; only a long server Retry-After is cut short by Stop.
func TestShipperShutdownDrainRetriesTransientFailure(t *testing.T) {
	newSeamFixture(t, true, 0)
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)
	s := NewShipper(ShipperConfig{
		ServerURL: func() string { return srv.URL }, AgentID: "a",
		AuthToken: testToken("tok"), MinLevel: "debug", HTTPClient: srv.Client(),
	})
	close(s.stopChan) // as during Stop's drain
	if !s.shipChunk(makeEntries(2)) {
		t.Fatal("a drain chunk was dropped after one transient 502; want the short retry")
	}
	if got := n.Load(); got != 2 {
		t.Fatalf("requests = %d, want 2", got)
	}
}

func TestShipperShutdownDrainDoesNotWaitOutLongRetryAfter(t *testing.T) {
	f := newSeamFixture(t, true, 0)
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.Header().Set("Retry-After", "45")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	s := NewShipper(ShipperConfig{
		ServerURL: func() string { return srv.URL }, AgentID: "a",
		AuthToken: testToken("tok"), MinLevel: "debug", HTTPClient: srv.Client(),
	})
	close(s.stopChan)
	if s.shipChunk(makeEntries(2)) {
		t.Fatal("chunk reported shipped against a 503")
	}
	if got := n.Load(); got != 1 {
		t.Fatalf("requests = %d, want 1 (no 45 s wait during shutdown)", got)
	}
	select {
	case d := <-f.waits:
		t.Fatalf("registered a %v wait during shutdown", d)
	case <-time.After(10 * time.Millisecond):
	}
}
