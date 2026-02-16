package logging

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestNewShipperDefaults(t *testing.T) {
	s := NewShipper(ShipperConfig{
		ServerURL:    "http://localhost:3001",
		AgentID:      "agent-1",
		AuthToken:    "tok",
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
		AuthToken:    "brz_secret",
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
		AuthToken:    "tok",
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
		AuthToken:  "tok",
		HTTPClient: server.Client(),
	})

	s.shipBatch([]LogEntry{{Message: "test"}})

	if receivedPath != "/api/v1/agents/abc-123/logs" {
		t.Fatalf("unexpected URL path: %s", receivedPath)
	}
}
