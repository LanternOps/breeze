package logging

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func promotionTestEntry() LogEntry {
	return LogEntry{
		Timestamp:    time.Now(),
		Level:        "ERROR",
		Component:    "test",
		Message:      "after the primary died",
		AgentVersion: "1.0.0",
	}
}

// countingLogServer returns an httptest server that counts the log-ship
// requests it receives.
func countingLogServer(t *testing.T) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/logs") {
			hits.Add(1)
		}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// TestShipperFollowsServerURLPromotion is the regression test for #2463.
//
// The shipper used to copy cfg.ServerURL by value at InitShipper time, so
// after the heartbeat's backup-server-URL promotion (#2323) it kept POSTing
// diagnostics to the DEAD primary for the rest of the process lifetime —
// exactly when those logs are most wanted. With ServerURL as a func() string
// provider resolved on every flush, the next batch goes to the promoted
// primary instead.
func TestShipperFollowsServerURLPromotion(t *testing.T) {
	primary, primaryHits := countingLogServer(t)
	backup, backupHits := countingLogServer(t)

	// The provider stands in for heartbeat.ServerURL: promotion swaps the URL
	// it returns, without the shipper being reconstructed.
	var current atomic.Value
	current.Store(primary.URL)

	s := NewShipper(ShipperConfig{
		ServerURL:    func() string { return current.Load().(string) },
		AgentID:      "agent-1",
		AuthToken:    testToken("tok"),
		AgentVersion: "1.0.0",
		MinLevel:     "debug",
		HTTPClient:   primary.Client(),
	})

	s.shipBatch([]LogEntry{promotionTestEntry()})
	if got := primaryHits.Load(); got != 1 {
		t.Fatalf("before promotion: primary hits = %d, want 1", got)
	}
	if got := backupHits.Load(); got != 0 {
		t.Fatalf("before promotion: backup hits = %d, want 0", got)
	}

	// The primary dies and the heartbeat promotes the backup (#2323).
	current.Store(backup.URL)

	s.shipBatch([]LogEntry{promotionTestEntry()})

	if got := backupHits.Load(); got != 1 {
		t.Fatalf("after promotion: promoted-server hits = %d, want 1 — "+
			"a by-value cfg.ServerURL copy never observes promotion and ships to the dead primary forever (#2463)", got)
	}
	if got := primaryHits.Load(); got != 1 {
		t.Fatalf("after promotion: dead-primary hits = %d, want 1 (no new requests)", got)
	}
}

// TestShipperNilProviderDoesNotPanic pins the nil-provider hazard that PR
// #2454 fixed in the sibling clients: a nil func() string called inside the
// ship-loop goroutine would panic, and the shipper has no recover(), so it
// would take the whole agent down. It must degrade to a counted drop instead.
func TestShipperNilProviderDoesNotPanic(t *testing.T) {
	tests := []struct {
		name     string
		provider func() string
	}{
		{name: "nil provider", provider: nil},
		{name: "provider returns empty", provider: func() string { return "" }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := NewShipper(ShipperConfig{
				ServerURL:    tc.provider,
				AgentID:      "agent-1",
				AuthToken:    testToken("tok"),
				AgentVersion: "1.0.0",
				MinLevel:     "debug",
			})

			// Must not panic — the real hazard is a panic in shipLoop's
			// goroutine, so run it through the loop, not just shipBatch.
			s.Start()
			s.Enqueue(promotionTestEntry())
			s.Stop() // drains, which flushes the batch through shipChunk

			if got := s.DroppedLogCount(); got != 1 {
				t.Fatalf("dropped count = %d, want 1 (entry must be dropped, not silently lost or panicked on)", got)
			}
		})
	}
}

// TestShipperUnresolvableURLAbortsRemainingChunks: an unset/empty provider
// dooms every chunk alike, so shipBatch must abort the batch rather than burn
// a request-build attempt per chunk. All entries are still accounted for in
// the dropped counter.
func TestShipperUnresolvableURLAbortsRemainingChunks(t *testing.T) {
	s := NewShipper(ShipperConfig{
		ServerURL:    func() string { return "" },
		AgentID:      "agent-1",
		AuthToken:    testToken("tok"),
		AgentVersion: "1.0.0",
		MinLevel:     "debug",
	})

	// Two chunks' worth of entries (maxEntriesPerShipRequest = 200).
	entries := make([]LogEntry, maxEntriesPerShipRequest+5)
	for i := range entries {
		entries[i] = promotionTestEntry()
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.shipBatch(entries)
	}()
	wg.Wait()

	if got := s.DroppedLogCount(); got != int64(len(entries)) {
		t.Fatalf("dropped count = %d, want %d (every entry in the aborted batch must be counted)", got, len(entries))
	}
}
