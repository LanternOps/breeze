package logging

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// testAuthSkipper is a minimal AuthSkipper for tests.
type testAuthSkipper struct {
	skip      atomic.Bool
	failures  atomic.Int32
	successes atomic.Int32
}

func (t *testAuthSkipper) ShouldSkip() bool    { return t.skip.Load() }
func (t *testAuthSkipper) RecordAuthFailure()  { t.failures.Add(1) }
func (t *testAuthSkipper) RecordSuccess()      { t.successes.Add(1) }

// testTokenRevealer is a fake TokenRevealer that never reveals anything.
type testTokenRevealer struct{}

func (testTokenRevealer) Reveal() string { return "test-token" }

func TestShipBatch_SkipsWhenAuthDead(t *testing.T) {
	// Server that fails the test if called.
	var called atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	auth := &testAuthSkipper{}
	auth.skip.Store(true)

	s := NewShipper(ShipperConfig{
		ServerURL:   srv.URL,
		AgentID:     "test-agent",
		AuthToken:   testTokenRevealer{},
		MinLevel:    "info",
		AuthMonitor: auth,
	})

	// Drain the shipper's buffer so we can observe re-buffering.
	s.shipBatch([]LogEntry{
		{Timestamp: time.Now(), Level: "info", Message: "entry1"},
		{Timestamp: time.Now(), Level: "info", Message: "entry2"},
	})

	if called.Load() != 0 {
		t.Fatalf("expected 0 HTTP calls while auth-dead, got %d", called.Load())
	}
	if auth.failures.Load() != 0 {
		t.Fatalf("expected no recorded failures (we never hit the network), got %d", auth.failures.Load())
	}
	if auth.successes.Load() != 0 {
		t.Fatalf("expected no recorded successes, got %d", auth.successes.Load())
	}

	// Re-buffered entries should be sitting in the channel.
	if len(s.buffer) != 2 {
		t.Fatalf("expected 2 entries re-buffered, got %d", len(s.buffer))
	}
}

func TestShipBatch_RecordsAuthFailureOn401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer srv.Close()

	auth := &testAuthSkipper{}

	s := NewShipper(ShipperConfig{
		ServerURL:   srv.URL,
		AgentID:     "test-agent",
		AuthToken:   testTokenRevealer{},
		MinLevel:    "info",
		AuthMonitor: auth,
	})

	s.shipBatch([]LogEntry{
		{Timestamp: time.Now(), Level: "info", Message: "entry1"},
	})

	if auth.failures.Load() != 1 {
		t.Fatalf("expected 1 recorded failure, got %d", auth.failures.Load())
	}
	if auth.successes.Load() != 0 {
		t.Fatalf("expected no successes, got %d", auth.successes.Load())
	}
}

func TestShipBatch_RecordsSuccessOn200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	auth := &testAuthSkipper{}

	s := NewShipper(ShipperConfig{
		ServerURL:   srv.URL,
		AgentID:     "test-agent",
		AuthToken:   testTokenRevealer{},
		MinLevel:    "info",
		AuthMonitor: auth,
	})

	s.shipBatch([]LogEntry{
		{Timestamp: time.Now(), Level: "info", Message: "entry1"},
	})

	if auth.successes.Load() != 1 {
		t.Fatalf("expected 1 recorded success, got %d", auth.successes.Load())
	}
	if auth.failures.Load() != 0 {
		t.Fatalf("expected no failures, got %d", auth.failures.Load())
	}
}

func TestShipBatch_SkipDropsWhenStopping(t *testing.T) {
	// Verify the critical shutdown-drain fix: when auth-dead and stopChan
	// is closed, entries must be dropped (not re-buffered), to prevent
	// the drain loop from spinning forever.
	auth := &testAuthSkipper{}
	auth.skip.Store(true)

	s := NewShipper(ShipperConfig{
		ServerURL:   "http://unused", // never called
		AgentID:     "test-agent",
		AuthToken:   testTokenRevealer{},
		MinLevel:    "info",
		AuthMonitor: auth,
	})

	// Simulate shutdown: close stopChan manually (Stop() would normally
	// do this and then wait, but we never called Start() so there's no
	// loop to wait on).
	close(s.stopChan)

	entries := []LogEntry{
		{Timestamp: time.Now(), Level: "info", Message: "e1"},
		{Timestamp: time.Now(), Level: "info", Message: "e2"},
		{Timestamp: time.Now(), Level: "info", Message: "e3"},
	}
	s.shipBatch(entries)

	if len(s.buffer) != 0 {
		t.Fatalf("expected buffer empty (entries dropped on shutdown drain), got %d buffered", len(s.buffer))
	}
	if got := s.droppedCount.Load(); got != 3 {
		t.Fatalf("expected 3 dropped entries, got %d", got)
	}
}
