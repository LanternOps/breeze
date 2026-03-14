package websocket

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// ---------- helpers ----------

// upgrader for test WebSocket servers
var testUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// newTestServer creates an httptest.Server that upgrades to WebSocket and
// calls onConn with the server-side *websocket.Conn.  The returned server
// URL uses the "http" scheme so the client will convert it to "ws".
func newTestServer(t *testing.T, onConn func(conn *websocket.Conn)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade error: %v", err)
			return
		}
		onConn(conn)
	}))
	return srv
}

// noopHandler is a CommandHandler that does nothing.
func noopHandler(cmd Command) CommandResult {
	return CommandResult{Status: "ok"}
}

// echoHandler echoes back the command type in the result.
func echoHandler(cmd Command) CommandResult {
	return CommandResult{Status: "ok", Result: cmd.Type}
}

// newTestClient creates a Client pointed at the given test server URL.
func newTestClient(serverURL string, handler CommandHandler) *Client {
	cfg := &Config{
		ServerURL: serverURL,
		AgentID:   "test-agent-001",
		AuthToken: secmem.NewSecureString("brz_test_token"),
	}
	return New(cfg, handler)
}

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

// ---------- SendResult ----------

func TestSendResult_Success(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	result := CommandResult{
		Type:      "command_result",
		CommandID: "cmd-1",
		Status:    "ok",
		Result:    "hello",
	}

	err := c.SendResult(result)
	if err != nil {
		t.Fatalf("SendResult error: %v", err)
	}

	// Verify the data is in the sendChan
	select {
	case data := <-c.sendChan:
		var parsed CommandResult
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if parsed.CommandID != "cmd-1" {
			t.Fatalf("commandId = %q, want %q", parsed.CommandID, "cmd-1")
		}
		if parsed.Status != "ok" {
			t.Fatalf("status = %q, want %q", parsed.Status, "ok")
		}
	default:
		t.Fatal("expected data in sendChan")
	}
}

func TestSendResult_ClientStopped(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	// Fill the send channel so the select can only choose the done case
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}
	close(c.done)

	err := c.SendResult(CommandResult{CommandID: "cmd-1"})
	if err == nil {
		t.Fatal("expected error when client is stopped")
	}
	if !strings.Contains(err.Error(), "client is stopped") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendResult_ChannelFull(t *testing.T) {
	cfg := &Config{
		ServerURL: "http://localhost",
		AgentID:   "a",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	// Fill the send channel
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}

	err := c.SendResult(CommandResult{CommandID: "overflow"})
	if err == nil {
		t.Fatal("expected error when send channel is full")
	}
	if !strings.Contains(err.Error(), "send channel is full") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------- SendDesktopFrame ----------

func TestSendDesktopFrame_Success(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	sessionID := "12345678-1234-1234-1234-123456789abc"
	frameData := []byte{0xFF, 0xD8, 0xFF, 0xE0} // fake JPEG header

	err := c.SendDesktopFrame(sessionID, frameData)
	if err != nil {
		t.Fatalf("SendDesktopFrame error: %v", err)
	}

	select {
	case msg := <-c.binaryFrameChan:
		// Verify format: [0x02][36-byte sessionId][data]
		if msg[0] != 0x02 {
			t.Fatalf("first byte = 0x%02x, want 0x02", msg[0])
		}
		gotSessionID := string(msg[1:37])
		if gotSessionID != sessionID {
			t.Fatalf("sessionID = %q, want %q", gotSessionID, sessionID)
		}
		gotData := msg[37:]
		if len(gotData) != len(frameData) {
			t.Fatalf("frame data len = %d, want %d", len(gotData), len(frameData))
		}
		for i, b := range gotData {
			if b != frameData[i] {
				t.Fatalf("frame data[%d] = 0x%02x, want 0x%02x", i, b, frameData[i])
			}
		}
	default:
		t.Fatal("expected data in binaryFrameChan")
	}
}

func TestSendDesktopFrame_ClientStopped(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	// Fill the binary frame channel so the select can only choose the done case
	for i := 0; i < cap(c.binaryFrameChan); i++ {
		c.binaryFrameChan <- []byte("filler")
	}
	close(c.done)

	err := c.SendDesktopFrame("session-1", []byte{0x01})
	if err == nil {
		t.Fatal("expected error when client is stopped")
	}
	if !strings.Contains(err.Error(), "client is stopped") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendDesktopFrame_ChannelFull(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	// Fill the binary frame channel
	for i := 0; i < cap(c.binaryFrameChan); i++ {
		c.binaryFrameChan <- []byte("filler")
	}

	err := c.SendDesktopFrame("session-1", []byte{0x01})
	if err == nil {
		t.Fatal("expected error when frame channel is full")
	}
	if !strings.Contains(err.Error(), "frame channel full") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------- SendPatchProgress ----------

func TestSendPatchProgress_Success(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	event := map[string]any{
		"percent": 50,
		"phase":   "downloading",
	}
	err := c.SendPatchProgress("cmd-patch-1", event)
	if err != nil {
		t.Fatalf("SendPatchProgress error: %v", err)
	}

	select {
	case data := <-c.sendChan:
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if parsed["type"] != "patch_progress" {
			t.Fatalf("type = %v, want patch_progress", parsed["type"])
		}
		if parsed["commandId"] != "cmd-patch-1" {
			t.Fatalf("commandId = %v, want cmd-patch-1", parsed["commandId"])
		}
		progress, ok := parsed["progress"].(map[string]any)
		if !ok {
			t.Fatal("progress field missing or wrong type")
		}
		if progress["phase"] != "downloading" {
			t.Fatalf("phase = %v, want downloading", progress["phase"])
		}
	default:
		t.Fatal("expected data in sendChan")
	}
}

func TestSendPatchProgress_ClientStopped(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	// Fill the send channel so the select can only choose the done case
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}
	close(c.done)

	err := c.SendPatchProgress("cmd-1", map[string]any{"percent": 0})
	if err == nil {
		t.Fatal("expected error when client is stopped")
	}
	if !strings.Contains(err.Error(), "client is stopped") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendPatchProgress_ChannelFull(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	// Fill the send channel
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}

	err := c.SendPatchProgress("cmd-1", map[string]any{"percent": 100})
	if err == nil {
		t.Fatal("expected error when send channel is full")
	}
	if !strings.Contains(err.Error(), "send channel full") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------- SendTerminalOutput ----------

func TestSendTerminalOutput_Success(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	err := c.SendTerminalOutput("sess-term-1", []byte("$ whoami\nroot\n"))
	if err != nil {
		t.Fatalf("SendTerminalOutput error: %v", err)
	}

	select {
	case data := <-c.sendChan:
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if parsed["type"] != "terminal_output" {
			t.Fatalf("type = %v, want terminal_output", parsed["type"])
		}
		if parsed["sessionId"] != "sess-term-1" {
			t.Fatalf("sessionId = %v, want sess-term-1", parsed["sessionId"])
		}
		if parsed["data"] != "$ whoami\nroot\n" {
			t.Fatalf("data = %v, want terminal output", parsed["data"])
		}
	default:
		t.Fatal("expected data in sendChan")
	}
}

func TestSendTerminalOutput_ClientStopped(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	// Fill the send channel so the select can only choose the done case
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}
	close(c.done)

	err := c.SendTerminalOutput("sess-1", []byte("data"))
	if err == nil {
		t.Fatal("expected error when client is stopped")
	}
	if !strings.Contains(err.Error(), "client is stopped") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendTerminalOutput_ChannelFull(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}

	err := c.SendTerminalOutput("sess-1", []byte("data"))
	if err == nil {
		t.Fatal("expected error when send channel is full")
	}
	if !strings.Contains(err.Error(), "send channel full") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------- Start / Stop ----------

func TestStartIsIdempotent(t *testing.T) {
	// Start blocks in reconnectLoop, so we need to stop it quickly.
	// Use a server that immediately closes to let connect fail fast.
	cfg := &Config{
		ServerURL: "http://127.0.0.1:1",
		AgentID:   "a",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	// Start in background — it will loop trying to reconnect
	go c.Start()
	time.Sleep(50 * time.Millisecond)

	// Second Start should be a no-op (not panic or deadlock)
	started := make(chan struct{})
	go func() {
		c.Start() // should return immediately
		close(started)
	}()

	select {
	case <-started:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("second Start() blocked — not idempotent")
	}

	c.Stop()
}

func TestStopIsIdempotent(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	// Call Stop multiple times — should not panic
	c.Stop()
	c.Stop()
	c.Stop()
}

func TestStopClosesConnection(t *testing.T) {
	serverClosed := make(chan struct{})
	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Read until close
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				close(serverClosed)
				return
			}
		}
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	c.Stop()

	select {
	case <-serverClosed:
		// good — server saw the close
	case <-time.After(5 * time.Second):
		t.Fatal("server did not see connection close")
	}
}

// ---------- readPump ----------

func TestReadPump_CommandDispatched(t *testing.T) {
	var handledType atomic.Value

	handler := func(cmd Command) CommandResult {
		handledType.Store(cmd.Type)
		return CommandResult{Status: "ok"}
	}

	resultReceived := make(chan struct{})
	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Send a command
		cmd := map[string]any{
			"id":      "cmd-100",
			"type":    "run_script",
			"payload": map[string]any{"script": "echo hi"},
		}
		if err := conn.WriteJSON(cmd); err != nil {
			t.Logf("write error: %v", err)
			return
		}

		// Read the command_result response
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Logf("read error: %v", err)
			return
		}
		var result CommandResult
		json.Unmarshal(msg, &result)
		if result.Type == "command_result" && result.CommandID == "cmd-100" {
			close(resultReceived)
		}
	})
	defer srv.Close()

	c := newTestClient(srv.URL, handler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	// Run read and write pumps
	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)
	go func() {
		c.readPump()
		close(pumpDone)
	}()

	select {
	case <-resultReceived:
		// good
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for command result")
	}

	if got, ok := handledType.Load().(string); !ok || got != "run_script" {
		t.Fatalf("handler saw type = %v, want run_script", handledType.Load())
	}

	c.Stop()
}

func TestReadPump_IgnoresNonCommandMessages(t *testing.T) {
	var handlerCalled atomic.Bool

	handler := func(cmd Command) CommandResult {
		handlerCalled.Store(true)
		return CommandResult{Status: "ok"}
	}

	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Send non-command messages (no ID)
		msgs := []map[string]any{
			{"type": "connected"},
			{"type": "ack"},
			{"type": "heartbeat_ack"},
			{"type": "error", "message": "something"},
		}
		for _, msg := range msgs {
			conn.WriteJSON(msg)
		}
		time.Sleep(200 * time.Millisecond)
		conn.Close()
	})
	defer srv.Close()

	c := newTestClient(srv.URL, handler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	c.readPump()

	if handlerCalled.Load() {
		t.Fatal("handler should not be called for non-command messages")
	}
}

func TestReadPump_RespondsToServerPing(t *testing.T) {
	pongReceived := make(chan struct{})

	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Send a server-level application ping
		ping := map[string]any{"type": "ping"}
		if err := conn.WriteJSON(ping); err != nil {
			t.Logf("write error: %v", err)
			return
		}

		// Read the pong response
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Logf("read error: %v", err)
			return
		}
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err != nil {
			t.Logf("unmarshal error: %v", err)
			return
		}
		if parsed["type"] == "pong" {
			if _, ok := parsed["timestamp"]; ok {
				close(pongReceived)
			}
		}
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)
	go func() {
		c.readPump()
		close(pumpDone)
	}()

	select {
	case <-pongReceived:
		// good
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for pong")
	}

	c.Stop()
}

func TestReadPump_MalformedJSON(t *testing.T) {
	// readPump should log a warning and continue, not crash
	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Send malformed JSON
		conn.WriteMessage(websocket.TextMessage, []byte("{not valid json"))
		// Send a valid command after to prove readPump survived
		cmd := map[string]any{"id": "cmd-after", "type": "test_cmd"}
		conn.WriteJSON(cmd)
		// Read result
		conn.ReadMessage()
		time.Sleep(100 * time.Millisecond)
		conn.Close()
	})
	defer srv.Close()

	var handlerCalled atomic.Bool
	handler := func(cmd Command) CommandResult {
		if cmd.ID == "cmd-after" {
			handlerCalled.Store(true)
		}
		return CommandResult{Status: "ok"}
	}

	c := newTestClient(srv.URL, handler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)
	go func() {
		c.readPump()
		close(pumpDone)
	}()

	// Wait a bit for processing
	time.Sleep(500 * time.Millisecond)
	c.Stop()

	if !handlerCalled.Load() {
		t.Fatal("handler should be called for valid command after malformed JSON")
	}
}

func TestReadPump_NilConnection(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	// conn is nil — readPump should return immediately without panic
	c.readPump()
}

// ---------- writePump ----------

func TestWritePump_TextMessage(t *testing.T) {
	msgReceived := make(chan []byte, 1)

	srv := newTestServer(t, func(conn *websocket.Conn) {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		msgReceived <- msg
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)

	// Send via sendChan
	payload := []byte(`{"type":"test"}`)
	c.sendChan <- payload

	select {
	case got := <-msgReceived:
		if string(got) != string(payload) {
			t.Fatalf("received = %s, want %s", got, payload)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for message")
	}

	close(pumpDone)
	c.Stop()
}

func TestWritePump_BinaryFrame(t *testing.T) {
	msgReceived := make(chan struct {
		msgType int
		data    []byte
	}, 1)

	srv := newTestServer(t, func(conn *websocket.Conn) {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		msgReceived <- struct {
			msgType int
			data    []byte
		}{mt, msg}
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)

	// Send via binaryFrameChan
	frame := []byte{0x02, 0x01, 0x02, 0x03}
	c.binaryFrameChan <- frame

	select {
	case got := <-msgReceived:
		if got.msgType != websocket.BinaryMessage {
			t.Fatalf("message type = %d, want BinaryMessage (%d)", got.msgType, websocket.BinaryMessage)
		}
		if len(got.data) != len(frame) {
			t.Fatalf("data len = %d, want %d", len(got.data), len(frame))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for binary frame")
	}

	close(pumpDone)
	c.Stop()
}

func TestWritePump_StopsOnDone(t *testing.T) {
	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Just keep the connection open
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				return
			}
		}
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpExited := make(chan struct{})
	pumpDone := make(chan struct{})
	go func() {
		c.writePump(pumpDone)
		close(pumpExited)
	}()

	// Signal done
	close(c.done)

	select {
	case <-pumpExited:
		// good
	case <-time.After(5 * time.Second):
		t.Fatal("writePump did not exit after done was closed")
	}

	// Cleanup — create new done chan to prevent Stop from panicking
	c.done = make(chan struct{})
	c.Stop()
}

func TestWritePump_NilConnSkipsWrite(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	// conn is nil — writePump should not panic when trying to write

	pumpDone := make(chan struct{})
	exited := make(chan struct{})
	go func() {
		c.writePump(pumpDone)
		close(exited)
	}()

	// Send a message — should be dropped silently (nil conn)
	c.sendChan <- []byte("test")
	time.Sleep(100 * time.Millisecond)

	// Stop the pump
	close(pumpDone)

	select {
	case <-exited:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("writePump did not exit")
	}
}

// ---------- processCommand ----------

func TestProcessCommand_SetsTypeAndCommandID(t *testing.T) {
	capturedCh := make(chan CommandResult, 1)

	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Send command
		conn.WriteJSON(map[string]any{
			"id":   "cmd-42",
			"type": "list_processes",
		})
		// Read result
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var result CommandResult
		json.Unmarshal(msg, &result)
		capturedCh <- result
		conn.Close()
	})
	defer srv.Close()

	handler := func(cmd Command) CommandResult {
		return CommandResult{Status: "completed", Result: "42 processes"}
	}

	c := newTestClient(srv.URL, handler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)
	c.readPump()
	close(pumpDone)

	select {
	case captured := <-capturedCh:
		if captured.Type != "command_result" {
			t.Fatalf("type = %q, want command_result", captured.Type)
		}
		if captured.CommandID != "cmd-42" {
			t.Fatalf("commandId = %q, want cmd-42", captured.CommandID)
		}
		if captured.Status != "completed" {
			t.Fatalf("status = %q, want completed", captured.Status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for captured result")
	}
}

// ---------- E2E connect + command round-trip ----------

func TestEndToEnd_CommandRoundTrip(t *testing.T) {
	type serverResult struct {
		Type      string `json:"type"`
		CommandID string `json:"commandId"`
		Status    string `json:"status"`
		Result    string `json:"result"`
	}

	results := make(chan serverResult, 3)

	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Send multiple commands
		commands := []map[string]any{
			{"id": "cmd-1", "type": "run_script", "payload": map[string]any{"script": "echo a"}},
			{"id": "cmd-2", "type": "list_processes"},
			{"id": "cmd-3", "type": "get_service", "payload": map[string]any{"name": "sshd"}},
		}
		for _, cmd := range commands {
			conn.WriteJSON(cmd)
		}

		// Read results
		for i := 0; i < 3; i++ {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var r serverResult
			json.Unmarshal(msg, &r)
			results <- r
		}
	})
	defer srv.Close()

	handler := func(cmd Command) CommandResult {
		return CommandResult{
			Status: "ok",
			Result: "handled-" + cmd.Type,
		}
	}

	c := newTestClient(srv.URL, handler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)
	go func() {
		c.readPump()
		close(pumpDone)
	}()

	// Collect all 3 results
	got := make(map[string]serverResult)
	for i := 0; i < 3; i++ {
		select {
		case r := <-results:
			got[r.CommandID] = r
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out after receiving %d/3 results", i)
		}
	}

	c.Stop()

	// Verify each result
	for _, cmdID := range []string{"cmd-1", "cmd-2", "cmd-3"} {
		r, ok := got[cmdID]
		if !ok {
			t.Fatalf("missing result for %s", cmdID)
		}
		if r.Type != "command_result" {
			t.Fatalf("%s: type = %q, want command_result", cmdID, r.Type)
		}
		if r.Status != "ok" {
			t.Fatalf("%s: status = %q, want ok", cmdID, r.Status)
		}
	}
}

// ---------- Reconnect behavior ----------

func TestReconnectLoop_ReconnectsAfterDisconnect(t *testing.T) {
	var connectCount atomic.Int32

	srv := newTestServer(t, func(conn *websocket.Conn) {
		count := connectCount.Add(1)
		if count == 1 {
			// First connection: close immediately
			conn.Close()
		} else {
			// Second connection: stay open briefly, then close
			time.Sleep(200 * time.Millisecond)
			conn.Close()
		}
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)

	done := make(chan struct{})
	go func() {
		c.Start()
		close(done)
	}()

	// Wait for at least 2 connections
	deadline := time.After(10 * time.Second)
	for connectCount.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("only %d connections in 10s, expected at least 2", connectCount.Load())
		default:
			time.Sleep(50 * time.Millisecond)
		}
	}

	c.Stop()

	select {
	case <-done:
		// good
	case <-time.After(5 * time.Second):
		t.Fatal("reconnectLoop did not exit after Stop")
	}
}

func TestReconnectLoop_StopsDuringBackoff(t *testing.T) {
	// Use a server that always refuses
	cfg := &Config{
		ServerURL: "http://127.0.0.1:1",
		AgentID:   "a",
		AuthToken: secmem.NewSecureString("tok"),
	}
	c := New(cfg, noopHandler)

	done := make(chan struct{})
	go func() {
		c.Start()
		close(done)
	}()

	// Let reconnect loop enter backoff
	time.Sleep(100 * time.Millisecond)

	c.Stop()

	select {
	case <-done:
		// good — loop exited
	case <-time.After(5 * time.Second):
		t.Fatal("reconnectLoop did not exit after Stop during backoff")
	}
}

// ---------- Concurrent safety ----------

func TestConcurrentSendResult(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			c.SendResult(CommandResult{
				CommandID: "cmd-" + string(rune('0'+n%10)),
				Status:    "ok",
			})
		}(i)
	}
	wg.Wait()
}

func TestConcurrentSendDesktopFrame(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.SendDesktopFrame("session-1234567890123456789012345", []byte{0xFF})
		}()
	}
	wg.Wait()
}

func TestConcurrentSendAndStop(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	var wg sync.WaitGroup

	// Concurrent sends
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.SendResult(CommandResult{Status: "ok"})
		}()
	}

	// Concurrent stop
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(10 * time.Millisecond)
		c.Stop()
	}()

	wg.Wait()
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

// ---------- Table-driven: buildWSURL scheme conversion ----------

func TestBuildWSURL_SchemeConversion(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantPfx  string
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

// ---------- Table-driven: Send method error cases ----------

func TestSendMethods_ErrorCases(t *testing.T) {
	tests := []struct {
		name     string
		setup    func(c *Client)
		send     func(c *Client) error
		wantErr  string
	}{
		{
			name: "SendResult_stopped",
			setup: func(c *Client) {
				for i := 0; i < cap(c.sendChan); i++ {
					c.sendChan <- []byte("x")
				}
				close(c.done)
			},
			send: func(c *Client) error {
				return c.SendResult(CommandResult{Status: "ok"})
			},
			wantErr: "client is stopped",
		},
		{
			name: "SendDesktopFrame_stopped",
			setup: func(c *Client) {
				for i := 0; i < cap(c.binaryFrameChan); i++ {
					c.binaryFrameChan <- []byte("x")
				}
				close(c.done)
			},
			send: func(c *Client) error {
				return c.SendDesktopFrame("sess-123456789012345678901234567", []byte{1})
			},
			wantErr: "client is stopped",
		},
		{
			name: "SendPatchProgress_stopped",
			setup: func(c *Client) {
				for i := 0; i < cap(c.sendChan); i++ {
					c.sendChan <- []byte("x")
				}
				close(c.done)
			},
			send: func(c *Client) error {
				return c.SendPatchProgress("cmd", map[string]any{})
			},
			wantErr: "client is stopped",
		},
		{
			name: "SendTerminalOutput_stopped",
			setup: func(c *Client) {
				for i := 0; i < cap(c.sendChan); i++ {
					c.sendChan <- []byte("x")
				}
				close(c.done)
			},
			send: func(c *Client) error {
				return c.SendTerminalOutput("sess", []byte("data"))
			},
			wantErr: "client is stopped",
		},
		{
			name: "SendResult_full",
			setup: func(c *Client) {
				for i := 0; i < cap(c.sendChan); i++ {
					c.sendChan <- []byte("x")
				}
			},
			send: func(c *Client) error {
				return c.SendResult(CommandResult{Status: "ok"})
			},
			wantErr: "send channel is full",
		},
		{
			name: "SendDesktopFrame_full",
			setup: func(c *Client) {
				for i := 0; i < cap(c.binaryFrameChan); i++ {
					c.binaryFrameChan <- []byte("x")
				}
			},
			send: func(c *Client) error {
				return c.SendDesktopFrame("sess-123456789012345678901234567", []byte{1})
			},
			wantErr: "frame channel full",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := newTestClient("http://localhost", noopHandler)
			tt.setup(c)
			err := tt.send(c)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %q, want contains %q", err.Error(), tt.wantErr)
			}
		})
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

// ---------- Multiple commands concurrent ----------

func TestMultipleConcurrentCommands(t *testing.T) {
	var handledCount atomic.Int32

	handler := func(cmd Command) CommandResult {
		handledCount.Add(1)
		// Simulate work
		time.Sleep(10 * time.Millisecond)
		return CommandResult{Status: "ok"}
	}

	resultCount := make(chan int, 1)
	srv := newTestServer(t, func(conn *websocket.Conn) {
		// Send 10 commands rapidly
		for i := 0; i < 10; i++ {
			conn.WriteJSON(map[string]any{
				"id":   "cmd-" + string(rune('A'+i)),
				"type": "run_script",
			})
		}

		// Collect 10 results
		count := 0
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		for count < 10 {
			_, _, err := conn.ReadMessage()
			if err != nil {
				break
			}
			count++
		}
		resultCount <- count
	})
	defer srv.Close()

	c := newTestClient(srv.URL, handler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	pumpDone := make(chan struct{})
	go c.writePump(pumpDone)
	go func() {
		c.readPump()
		close(pumpDone)
	}()

	select {
	case count := <-resultCount:
		if count != 10 {
			t.Fatalf("received %d results, want 10", count)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for all results")
	}

	c.Stop()

	if got := handledCount.Load(); got != 10 {
		t.Fatalf("handler called %d times, want 10", got)
	}
}

// ---------- Desktop frame format ----------

func TestSendDesktopFrame_MessageFormat(t *testing.T) {
	tests := []struct {
		name      string
		sessionID string
		data      []byte
		wantLen   int
	}{
		{
			name:      "normal frame",
			sessionID: "abcdefgh-1234-5678-9012-abcdefghijkl",
			data:      []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00},
			wantLen:   1 + 36 + 5,
		},
		{
			name:      "empty frame data",
			sessionID: "abcdefgh-1234-5678-9012-abcdefghijkl",
			data:      []byte{},
			wantLen:   1 + 36,
		},
		{
			name:      "large frame",
			sessionID: "abcdefgh-1234-5678-9012-abcdefghijkl",
			data:      make([]byte, 1024),
			wantLen:   1 + 36 + 1024,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := newTestClient("http://localhost", noopHandler)

			err := c.SendDesktopFrame(tt.sessionID, tt.data)
			if err != nil {
				t.Fatalf("SendDesktopFrame error: %v", err)
			}

			msg := <-c.binaryFrameChan
			if len(msg) != tt.wantLen {
				t.Fatalf("message len = %d, want %d", len(msg), tt.wantLen)
			}
			if msg[0] != 0x02 {
				t.Fatalf("type byte = 0x%02x, want 0x02", msg[0])
			}
		})
	}
}
