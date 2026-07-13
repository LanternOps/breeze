package logging

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testToken is a simple TokenRevealer for tests (avoids circular secmem import).
type testToken string

func (t testToken) Reveal() string { return string(t) }

func TestNewShipperDefaults(t *testing.T) {
	s := NewShipper(ShipperConfig{
		ServerURL:    "http://localhost:3001",
		AgentID:      "agent-1",
		AuthToken:    testToken("tok"),
		AgentVersion: "1.0.0",
		MinLevel:     "warn",
	})

	if s.serverURL != "http://localhost:3001" {
		t.Fatalf("unexpected serverURL: %s", s.serverURL)
	}
	if s.agentID != "agent-1" {
		t.Fatalf("unexpected agentID: %s", s.agentID)
	}
	if s.httpClient == nil {
		t.Fatal("httpClient should default to non-nil")
	}
	if s.minLevel != slog.LevelWarn {
		t.Fatalf("expected LevelWarn, got %v", s.minLevel)
	}
}

func TestNewShipperCustomHTTPClient(t *testing.T) {
	client := &http.Client{Timeout: 5 * time.Second}
	s := NewShipper(ShipperConfig{
		ServerURL:  "http://localhost:3001",
		AgentID:    "a",
		HTTPClient: client,
	})
	if s.httpClient != client {
		t.Fatal("should use provided HTTP client")
	}
}

func TestShouldShip(t *testing.T) {
	tests := []struct {
		name     string
		minLevel string
		level    slog.Level
		expected bool
	}{
		{"warn ships error", "warn", slog.LevelError, true},
		{"warn ships warn", "warn", slog.LevelWarn, true},
		{"warn drops info", "warn", slog.LevelInfo, false},
		{"warn drops debug", "warn", slog.LevelDebug, false},
		{"debug ships debug", "debug", slog.LevelDebug, true},
		{"debug ships info", "debug", slog.LevelInfo, true},
		{"error ships error", "error", slog.LevelError, true},
		{"error drops warn", "error", slog.LevelWarn, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewShipper(ShipperConfig{MinLevel: tt.minLevel})
			if got := s.ShouldShip(tt.level); got != tt.expected {
				t.Fatalf("ShouldShip(%v) with minLevel=%s: got %v, want %v",
					tt.level, tt.minLevel, got, tt.expected)
			}
		})
	}
}

func TestSetMinLevel(t *testing.T) {
	s := NewShipper(ShipperConfig{MinLevel: "warn"})

	if s.ShouldShip(slog.LevelInfo) {
		t.Fatal("info should not ship at warn level")
	}

	s.SetMinLevel("debug")

	if !s.ShouldShip(slog.LevelInfo) {
		t.Fatal("info should ship at debug level")
	}
	if !s.ShouldShip(slog.LevelDebug) {
		t.Fatal("debug should ship at debug level")
	}
}

func TestEnqueueNonBlocking(t *testing.T) {
	s := NewShipper(ShipperConfig{MinLevel: "debug"})

	// Fill the buffer
	for i := 0; i < defaultBufferSize; i++ {
		s.Enqueue(LogEntry{Message: "fill"})
	}

	// This should not block even with a full buffer
	done := make(chan bool, 1)
	go func() {
		s.Enqueue(LogEntry{Message: "overflow"})
		done <- true
	}()

	select {
	case <-done:
		// Success — didn't block
	case <-time.After(time.Second):
		t.Fatal("Enqueue blocked on full buffer")
	}
}

func TestCapFields(t *testing.T) {
	// nil and small fields pass through untouched.
	if got := capFields(nil); got != nil {
		t.Fatalf("capFields(nil) = %v, want nil", got)
	}
	small := map[string]any{"key": "value"}
	if got := capFields(small); len(got) != 1 || got["key"] != "value" {
		t.Fatalf("small fields must pass through unchanged, got %v", got)
	}

	// Oversized entry: the huge field is dropped by name, small correlating
	// scalars survive, and the result fits the ship limit (one oversized
	// entry would otherwise 400 the whole batch at the API, #2386).
	huge := map[string]any{
		"dump":       string(bytes.Repeat([]byte("x"), maxShippedFieldsJSONBytes+1)),
		"device_id":  "dev-123",
		"elapsed_ms": 456,
	}
	got := capFields(huge)
	if _, stillThere := got["dump"]; stillThere {
		t.Fatal("oversized field must be dropped")
	}
	if got["device_id"] != "dev-123" {
		t.Fatalf("small correlating field must be salvaged, got %v", got)
	}
	marker, ok := got["fields_dropped"].(string)
	if !ok || marker == "" {
		t.Fatalf("expected fields_dropped marker, got %v", got)
	}
	if !bytes.Contains([]byte(marker), []byte("dump(")) {
		t.Fatalf("marker must name the dropped key with its size, got %q", marker)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal capped fields: %v", err)
	}
	if len(b) > maxShippedFieldsJSONBytes {
		t.Fatalf("capped fields themselves exceed the ship limit: %d bytes", len(b))
	}
}

func TestCapFieldsUnmarshalable(t *testing.T) {
	// An unmarshalable value (NaN) must not survive to shipBatch, where the
	// whole-batch marshal would fail and drop every co-batched entry — the
	// marshal-failure flavor of the #2386 one-bad-entry-burns-the-batch bug.
	fields := map[string]any{
		"cpu_pct":   math.NaN(),
		"device_id": "dev-123",
	}
	got := capFields(fields)
	if _, stillThere := got["cpu_pct"]; stillThere {
		t.Fatal("unmarshalable field must be dropped")
	}
	if got["device_id"] != "dev-123" {
		t.Fatalf("marshalable fields must be salvaged, got %v", got)
	}
	marker, ok := got["fields_dropped"].(string)
	if !ok || !bytes.Contains([]byte(marker), []byte("cpu_pct(unmarshalable)")) {
		t.Fatalf("marker must name the unmarshalable key, got %v", got)
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatalf("capped fields must be marshalable, got error: %v", err)
	}
}

func TestEnqueueCapsOversizedFields(t *testing.T) {
	s := NewShipper(ShipperConfig{MinLevel: "debug"})
	s.Enqueue(LogEntry{
		Message: "watchdog",
		Fields:  map[string]any{"goroutines": string(bytes.Repeat([]byte("g"), maxShippedFieldsJSONBytes+100))},
	})
	entry := <-s.buffer
	b, err := json.Marshal(entry.Fields)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(b) > maxShippedFieldsJSONBytes {
		t.Fatalf("buffered entry fields exceed ship limit: %d bytes", len(b))
	}
	if entry.Message != "watchdog" {
		t.Fatalf("message must be preserved, got %q", entry.Message)
	}
}

func TestShipBatchSendsGzipJSON(t *testing.T) {
	var (
		receivedBody []byte
		receivedAuth string
		receivedCE   string
		receivedCT   string
		mu           sync.Mutex
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()

		receivedAuth = r.Header.Get("Authorization")
		receivedCE = r.Header.Get("Content-Encoding")
		receivedCT = r.Header.Get("Content-Type")

		body, _ := io.ReadAll(r.Body)
		receivedBody = body
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:    server.URL,
		AgentID:      "test-agent",
		AuthToken:    testToken("brz_secret"),
		AgentVersion: "1.0.0",
		MinLevel:     "debug",
		HTTPClient:   server.Client(),
	})

	entries := []LogEntry{
		{
			Timestamp:    time.Now(),
			Level:        "INFO",
			Component:    "heartbeat",
			Message:      "test log",
			Fields:       map[string]any{"key": "value"},
			AgentVersion: "1.0.0",
		},
	}

	s.shipBatch(entries)

	mu.Lock()
	defer mu.Unlock()

	if receivedAuth != "Bearer brz_secret" {
		t.Fatalf("expected Bearer auth header, got: %s", receivedAuth)
	}
	if receivedCE != "gzip" {
		t.Fatalf("expected gzip Content-Encoding, got: %s", receivedCE)
	}
	if receivedCT != "application/json" {
		t.Fatalf("expected application/json Content-Type, got: %s", receivedCT)
	}

	// Decompress and verify JSON
	gr, err := gzip.NewReader(io.NopCloser(bytes.NewReader(receivedBody)))
	if err != nil {
		t.Fatalf("failed to create gzip reader: %v", err)
	}
	defer gr.Close()

	decompressed, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("failed to decompress body: %v", err)
	}

	var payload struct {
		Logs []LogEntry `json:"logs"`
	}
	if err := json.Unmarshal(decompressed, &payload); err != nil {
		t.Fatalf("failed to unmarshal JSON: %v", err)
	}

	if len(payload.Logs) != 1 {
		t.Fatalf("expected 1 log entry, got %d", len(payload.Logs))
	}
	if payload.Logs[0].Message != "test log" {
		t.Fatalf("unexpected message: %s", payload.Logs[0].Message)
	}
	if payload.Logs[0].Component != "heartbeat" {
		t.Fatalf("unexpected component: %s", payload.Logs[0].Component)
	}
}

func TestShipperStartStopDrains(t *testing.T) {
	var (
		received []LogEntry
		mu       sync.Mutex
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gr, _ := gzip.NewReader(io.NopCloser(bytes.NewReader(body)))
		decompressed, _ := io.ReadAll(gr)
		gr.Close()

		var payload struct {
			Logs []LogEntry `json:"logs"`
		}
		json.Unmarshal(decompressed, &payload)

		mu.Lock()
		received = append(received, payload.Logs...)
		mu.Unlock()

		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:    server.URL,
		AgentID:      "test-agent",
		AuthToken:    testToken("tok"),
		AgentVersion: "1.0.0",
		MinLevel:     "debug",
		HTTPClient:   server.Client(),
	})

	s.Start()

	// Enqueue some entries
	for i := 0; i < 5; i++ {
		s.Enqueue(LogEntry{
			Timestamp: time.Now(),
			Level:     "INFO",
			Component: "test",
			Message:   "entry",
		})
	}

	// Stop should drain
	s.Stop()

	mu.Lock()
	count := len(received)
	mu.Unlock()

	if count != 5 {
		t.Fatalf("expected 5 drained entries, got %d", count)
	}
}

// decodeShippedLogs decompresses one shipped request body and returns its
// log entries. It uses t.Errorf (not Fatalf) because it runs inside httptest
// handler goroutines, where FailNow/Goexit is undefined behavior; on decode
// failure it returns nil and the caller's count assertions fail loudly.
func decodeShippedLogs(t *testing.T, body []byte) []LogEntry {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Errorf("gzip reader: %v", err)
		return nil
	}
	defer gr.Close()
	decompressed, err := io.ReadAll(gr)
	if err != nil {
		t.Errorf("decompress: %v", err)
		return nil
	}
	var payload struct {
		Logs []LogEntry `json:"logs"`
	}
	if err := json.Unmarshal(decompressed, &payload); err != nil {
		t.Errorf("unmarshal: %v", err)
		return nil
	}
	return payload.Logs
}

// makeEntries builds n entries with sequential messages "entry-0".."entry-n-1"
// so tests can verify which entries survived chunked shipping.
func makeEntries(n int) []LogEntry {
	entries := make([]LogEntry, n)
	for i := range entries {
		entries[i] = LogEntry{
			Timestamp: time.Now(),
			Level:     "INFO",
			Component: "test",
			Message:   fmt.Sprintf("entry-%d", i),
		}
	}
	return entries
}

// TestMaxEntriesPerShipRequestMatchesAPICap pins the agent-side chunk size to
// the API's per-request cap (apps/api/src/routes/agents/logs.ts,
// z.array(...).max(200)). If this fails, someone changed one side without
// re-checking the other — see the comment on maxEntriesPerShipRequest.
func TestMaxEntriesPerShipRequestMatchesAPICap(t *testing.T) {
	if maxEntriesPerShipRequest != 200 {
		t.Fatalf("maxEntriesPerShipRequest = %d, want 200 (the API rejects requests with more than 200 entries; #2397)", maxEntriesPerShipRequest)
	}
	if maxEntriesPerShipRequest > defaultMaxBatchSize {
		t.Fatalf("chunk size %d exceeds batch size %d — chunking would be dead code", maxEntriesPerShipRequest, defaultMaxBatchSize)
	}
}

// TestShipBatchChunksFullBatch verifies a full 500-entry flush is split into
// three requests of 200/200/100 entries — a single 500-entry request would be
// rejected wholesale by the API's 200-entry cap (#2397).
func TestShipBatchChunksFullBatch(t *testing.T) {
	var (
		mu     sync.Mutex
		chunks [][]LogEntry
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		chunks = append(chunks, decodeShippedLogs(t, body))
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:  server.URL,
		AgentID:    "test-agent",
		AuthToken:  testToken("tok"),
		MinLevel:   "debug",
		HTTPClient: server.Client(),
	})

	s.shipBatch(makeEntries(defaultMaxBatchSize))

	mu.Lock()
	defer mu.Unlock()
	if len(chunks) != 3 {
		t.Fatalf("expected 3 requests for a %d-entry batch, got %d", defaultMaxBatchSize, len(chunks))
	}
	for i, want := range []int{200, 200, 100} {
		if got := len(chunks[i]); got != want {
			t.Fatalf("chunk %d: expected %d entries, got %d", i, want, got)
		}
	}
	// Entries must arrive in order with none lost or duplicated.
	idx := 0
	for _, chunk := range chunks {
		for _, e := range chunk {
			if want := fmt.Sprintf("entry-%d", idx); e.Message != want {
				t.Fatalf("entry %d: expected message %q, got %q", idx, want, e.Message)
			}
			idx++
		}
	}
	if got := s.DroppedLogCount(); got != 0 {
		t.Fatalf("expected 0 dropped entries, got %d", got)
	}
}

// TestShipBatchSmallBatchSingleRequest verifies batches at or under the cap
// still go out as one request.
func TestShipBatchSmallBatchSingleRequest(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:  server.URL,
		AgentID:    "test-agent",
		AuthToken:  testToken("tok"),
		MinLevel:   "debug",
		HTTPClient: server.Client(),
	})

	s.shipBatch(makeEntries(maxEntriesPerShipRequest))

	if got := requests.Load(); got != 1 {
		t.Fatalf("expected exactly 1 request for a %d-entry batch, got %d", maxEntriesPerShipRequest, got)
	}
}

// TestShipBatchMidChunk4xxDropsOnlyThatChunk verifies a 400 on the second
// chunk drops only that chunk's 200 entries — chunks 1 and 3 still ship
// (previously a 4xx burned the whole 500-entry batch, #2397).
func TestShipBatchMidChunk4xxDropsOnlyThatChunk(t *testing.T) {
	var (
		mu       sync.Mutex
		received []LogEntry
		requests int
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests++
		reject := requests == 2
		if !reject {
			received = append(received, decodeShippedLogs(t, body)...)
		}
		mu.Unlock()
		if reject {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:  server.URL,
		AgentID:    "test-agent",
		AuthToken:  testToken("tok"),
		MinLevel:   "debug",
		HTTPClient: server.Client(),
	})

	s.shipBatch(makeEntries(500))

	mu.Lock()
	defer mu.Unlock()
	if requests != 3 {
		t.Fatalf("expected 3 requests (4xx is not retried), got %d", requests)
	}
	if len(received) != 300 {
		t.Fatalf("expected 300 delivered entries (chunks 1 and 3), got %d", len(received))
	}
	// Chunk 3 (entries 400..499) must have shipped despite chunk 2's 400.
	if got, want := received[200].Message, "entry-400"; got != want {
		t.Fatalf("first entry after the rejected chunk: expected %q, got %q", want, got)
	}
	if got, want := received[299].Message, "entry-499"; got != want {
		t.Fatalf("last delivered entry: expected %q, got %q", want, got)
	}
	if got := s.DroppedLogCount(); got != 200 {
		t.Fatalf("expected exactly the rejected chunk's 200 entries dropped, got %d", got)
	}
}

// TestShipBatchRetries5xxPerChunk verifies the 5xx retry loop applies to each
// chunk independently: a transient 500 on the second chunk is retried and the
// full batch is eventually delivered.
func TestShipBatchRetries5xxPerChunk(t *testing.T) {
	var (
		mu       sync.Mutex
		received []LogEntry
		requests int
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests++
		fail := requests == 2 // first attempt of chunk 2
		if !fail {
			received = append(received, decodeShippedLogs(t, body)...)
		}
		mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:  server.URL,
		AgentID:    "test-agent",
		AuthToken:  testToken("tok"),
		MinLevel:   "debug",
		HTTPClient: server.Client(),
	})

	s.shipBatch(makeEntries(500))

	mu.Lock()
	defer mu.Unlock()
	if requests != 4 {
		t.Fatalf("expected 4 requests (3 chunks + 1 retry of chunk 2), got %d", requests)
	}
	if len(received) != 500 {
		t.Fatalf("expected all 500 entries delivered after retry, got %d", len(received))
	}
	if got := s.DroppedLogCount(); got != 0 {
		t.Fatalf("expected 0 dropped entries, got %d", got)
	}
}

// TestShipBatch401AbortsRemainingChunks verifies a 401 is treated as
// terminal for the whole batch: the token is dead for every chunk alike, so
// only one request is made, RecordAuthFailure fires exactly once per flush
// (the pre-chunking behavior the auth monitor's skip threshold was tuned
// for), and the remaining chunks are dropped with count.
func TestShipBatch401AbortsRemainingChunks(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	auth := &testAuthSkipper{}
	s := NewShipper(ShipperConfig{
		ServerURL:   server.URL,
		AgentID:     "test-agent",
		AuthToken:   testToken("tok"),
		MinLevel:    "debug",
		HTTPClient:  server.Client(),
		AuthMonitor: auth,
	})

	s.shipBatch(makeEntries(500))

	if got := requests.Load(); got != 1 {
		t.Fatalf("expected exactly 1 request (401 is terminal, not retried), got %d", got)
	}
	if got := auth.failures.Load(); got != 1 {
		t.Fatalf("expected exactly 1 RecordAuthFailure per flush, got %d", got)
	}
	if got := s.DroppedLogCount(); got != 500 {
		t.Fatalf("expected all 500 entries dropped (200 rejected + 300 aborted), got %d", got)
	}
}

// TestShipBatchAbortsRemainingChunksOnTerminalFailure verifies that when a
// chunk exhausts its retries against a dead server, the batch's remaining
// chunks are dropped (with count) instead of each burning another full retry
// cycle while the ship loop is blocked.
func TestShipBatchAbortsRemainingChunksOnTerminalFailure(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:  server.URL,
		AgentID:    "test-agent",
		AuthToken:  testToken("tok"),
		MinLevel:   "debug",
		HTTPClient: server.Client(),
	})

	s.shipBatch(makeEntries(500))

	if got, want := requests.Load(), int64(shipRetryCount+1); got != want {
		t.Fatalf("expected %d requests (only chunk 1's retry cycle), got %d", want, got)
	}
	if got := s.DroppedLogCount(); got != 500 {
		t.Fatalf("expected all 500 entries dropped (200 exhausted + 300 aborted), got %d", got)
	}
}

func TestShipBatchURLFormat(t *testing.T) {
	var receivedPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	s := NewShipper(ShipperConfig{
		ServerURL:  server.URL,
		AgentID:    "abc-123",
		AuthToken:  testToken("tok"),
		HTTPClient: server.Client(),
	})

	s.shipBatch([]LogEntry{{Message: "test"}})

	if receivedPath != "/api/v1/agents/abc-123/logs" {
		t.Fatalf("unexpected URL path: %s", receivedPath)
	}
}
