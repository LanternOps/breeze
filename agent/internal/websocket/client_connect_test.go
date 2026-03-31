package websocket

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// ---------- Config / URL building ----------

func TestBuildWSURL_HTTPToWS(t *testing.T) {
	cfg := &Config{
		ServerURL: "http://localhost:3001",
		AgentID:   "abc-123",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	got, err := c.buildWSURL()
	if err != nil {
		t.Fatalf("buildWSURL error: %v", err)
	}
	if got != "ws://localhost:3001/api/v1/agent-ws/abc-123/ws" {
		t.Fatalf("unexpected URL: %s", got)
	}
}

func TestBuildWSURL_HTTPSToWSS(t *testing.T) {
	cfg := &Config{
		ServerURL: "https://rmm.example.com",
		AgentID:   "device-42",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	got, err := c.buildWSURL()
	if err != nil {
		t.Fatalf("buildWSURL error: %v", err)
	}
	if got != "wss://rmm.example.com/api/v1/agent-ws/device-42/ws" {
		t.Fatalf("unexpected URL: %s", got)
	}
}

func TestBuildWSURL_InvalidURL(t *testing.T) {
	cfg := &Config{
		ServerURL: "://bad",
		AgentID:   "a",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	_, err := c.buildWSURL()
	if err == nil {
		t.Fatal("expected error for invalid URL")
	}
}

func TestBuildWSURL_WithPort(t *testing.T) {
	cfg := &Config{
		ServerURL: "http://192.168.1.10:8080",
		AgentID:   "dev-99",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	got, err := c.buildWSURL()
	if err != nil {
		t.Fatalf("buildWSURL error: %v", err)
	}
	if got != "ws://192.168.1.10:8080/api/v1/agent-ws/dev-99/ws" {
		t.Fatalf("unexpected URL: %s", got)
	}
}

// ---------- New ----------

func TestNewCreatesClient(t *testing.T) {
	cfg := &Config{
		ServerURL: "http://localhost:3001",
		AgentID:   "agent-1",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	if c == nil {
		t.Fatal("New returned nil")
	}
	if c.config != cfg {
		t.Fatal("config not stored")
	}
	if c.cmdHandler == nil {
		t.Fatal("command handler not stored")
	}
	if c.sendChan == nil {
		t.Fatal("sendChan not created")
	}
	if c.binaryFrameChan == nil {
		t.Fatal("binaryFrameChan not created")
	}
	if cap(c.sendChan) != 256 {
		t.Fatalf("sendChan capacity = %d, want 256", cap(c.sendChan))
	}
	if cap(c.binaryFrameChan) != 30 {
		t.Fatalf("binaryFrameChan capacity = %d, want 30", cap(c.binaryFrameChan))
	}
}

// ---------- Connect ----------

func TestConnect_SetsAuthHeader(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.Close()
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	err := c.connect()
	if err != nil {
		t.Fatalf("connect error: %v", err)
	}

	if gotAuth != "Bearer brz_test_token" {
		t.Fatalf("Authorization header = %q, want %q", gotAuth, "Bearer brz_test_token")
	}

	c.connMu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.connMu.Unlock()
}

func TestConnect_SetsWSPath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.Close()
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	err := c.connect()
	if err != nil {
		t.Fatalf("connect error: %v", err)
	}

	expected := "/api/v1/agent-ws/test-agent-001/ws"
	if gotPath != expected {
		t.Fatalf("path = %q, want %q", gotPath, expected)
	}

	c.connMu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.connMu.Unlock()
}

func TestConnect_NilAuthToken(t *testing.T) {
	cfg := &Config{
		ServerURL: "http://localhost:9999",
		AgentID:   "a",
		AuthToken: nil,
	}
	c := New(cfg, noopHandler)
	err := c.connect()
	if err == nil {
		t.Fatal("expected error for nil auth token")
	}
	if !strings.Contains(err.Error(), "auth token is nil or zeroed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConnect_ZeroedAuthToken(t *testing.T) {
	tok := secmem.NewSecureString("brz_test")
	tok.Zero()

	cfg := &Config{
		ServerURL: "http://localhost:9999",
		AgentID:   "a",
		AuthToken: tok,
	}
	c := New(cfg, noopHandler)
	err := c.connect()
	if err == nil {
		t.Fatal("expected error for zeroed auth token")
	}
	if !strings.Contains(err.Error(), "auth token is nil or zeroed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConnect_ServerRefusesConnection(t *testing.T) {
	cfg := &Config{
		ServerURL: "http://127.0.0.1:1", // nothing listening
		AgentID:   "a",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)
	err := c.connect()
	if err == nil {
		t.Fatal("expected connection error")
	}
	if !strings.Contains(err.Error(), "failed to connect") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestUpdateTLSConfig(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}

	c.UpdateTLSConfig(tlsCfg)

	if got := c.currentTLSConfig(); got != tlsCfg {
		t.Fatalf("TLS config pointer was not updated")
	}
}

func TestForceReconnectClearsConnection(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		time.Sleep(250 * time.Millisecond)
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	c.ForceReconnect()

	c.connMu.RLock()
	defer c.connMu.RUnlock()
	if c.conn != nil {
		t.Fatal("expected ForceReconnect to clear the active connection")
	}
}

// ---------- Table-driven: buildWSURL scheme conversion ----------

func TestBuildWSURL_SchemeConversion(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantPfx string
	}{
		{"http to ws", "http://example.com", "ws://example.com"},
		{"https to wss", "https://example.com", "wss://example.com"},
		{"http with port", "http://localhost:3001", "ws://localhost:3001"},
		{"https with port", "https://rmm.prod.io:8443", "wss://rmm.prod.io:8443"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &Config{
				ServerURL: tt.input,
				AgentID:   "agent-x",
				AuthToken: secmem.NewSecureString("tok"),
			}
			c := New(cfg, noopHandler)
			got, err := c.buildWSURL()
			if err != nil {
				t.Fatalf("buildWSURL error: %v", err)
			}
			if !strings.HasPrefix(got, tt.wantPfx) {
				t.Fatalf("got %q, want prefix %q", got, tt.wantPfx)
			}
			// All should end with the agent path
			if !strings.HasSuffix(got, "/api/v1/agent-ws/agent-x/ws") {
				t.Fatalf("got %q, missing agent-ws path suffix", got)
			}
		})
	}
}

// ---------- Command / CommandResult types ----------

func TestCommandJSONRoundTrip(t *testing.T) {
	cmd := Command{
		ID:   "cmd-abc",
		Type: "run_script",
		Payload: map[string]any{
			"script":  "echo hello",
			"timeout": float64(30),
		},
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var parsed Command
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if parsed.ID != cmd.ID {
		t.Fatalf("ID = %q, want %q", parsed.ID, cmd.ID)
	}
	if parsed.Type != cmd.Type {
		t.Fatalf("Type = %q, want %q", parsed.Type, cmd.Type)
	}
	if parsed.Payload["script"] != "echo hello" {
		t.Fatalf("payload script = %v, want echo hello", parsed.Payload["script"])
	}
}

func TestCommandResultJSONRoundTrip(t *testing.T) {
	result := CommandResult{
		Type:      "command_result",
		CommandID: "cmd-42",
		Status:    "error",
		Error:     "permission denied",
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var parsed CommandResult
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if parsed.Type != "command_result" {
		t.Fatalf("Type = %q, want command_result", parsed.Type)
	}
	if parsed.CommandID != "cmd-42" {
		t.Fatalf("CommandID = %q, want cmd-42", parsed.CommandID)
	}
	if parsed.Error != "permission denied" {
		t.Fatalf("Error = %q, want permission denied", parsed.Error)
	}
}

func TestCommandResultOmitsEmptyFields(t *testing.T) {
	result := CommandResult{
		Type:      "command_result",
		CommandID: "cmd-1",
		Status:    "ok",
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var parsed map[string]any
	json.Unmarshal(data, &parsed)

	if _, ok := parsed["result"]; ok {
		t.Fatal("result field should be omitted when nil")
	}
	if _, ok := parsed["error"]; ok {
		t.Fatal("error field should be omitted when empty")
	}
}

// ---------- Constants ----------

func TestConstants(t *testing.T) {
	// Verify critical protocol constants are sane
	if writeWait != 10*time.Second {
		t.Fatalf("writeWait = %v, want 10s", writeWait)
	}
	if pongWait != 60*time.Second {
		t.Fatalf("pongWait = %v, want 60s", pongWait)
	}
	if pingPeriod >= pongWait {
		t.Fatalf("pingPeriod (%v) must be less than pongWait (%v)", pingPeriod, pongWait)
	}
	if maxMessageSize != 512*1024 {
		t.Fatalf("maxMessageSize = %d, want 524288", maxMessageSize)
	}
	if initialBackoff != 1*time.Second {
		t.Fatalf("initialBackoff = %v, want 1s", initialBackoff)
	}
	if maxBackoff != 60*time.Second {
		t.Fatalf("maxBackoff = %v, want 60s", maxBackoff)
	}
}

// ---------- Backoff calculation ----------

func TestBackoffGrowth(t *testing.T) {
	// Simulate backoff growth to ensure it caps at maxBackoff
	backoff := initialBackoff
	for i := 0; i < 20; i++ {
		backoff = time.Duration(float64(backoff) * backoffFactor)
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
	if backoff != maxBackoff {
		t.Fatalf("backoff after 20 iterations = %v, want %v", backoff, maxBackoff)
	}
}

func TestBackoffDoublesCorrectly(t *testing.T) {
	backoff := initialBackoff

	// First doubling: 1s -> 2s
	backoff = time.Duration(float64(backoff) * backoffFactor)
	if backoff != 2*time.Second {
		t.Fatalf("first doubling = %v, want 2s", backoff)
	}

	// Second: 2s -> 4s
	backoff = time.Duration(float64(backoff) * backoffFactor)
	if backoff != 4*time.Second {
		t.Fatalf("second doubling = %v, want 4s", backoff)
	}

	// Third: 4s -> 8s
	backoff = time.Duration(float64(backoff) * backoffFactor)
	if backoff != 8*time.Second {
		t.Fatalf("third doubling = %v, want 8s", backoff)
	}
}
