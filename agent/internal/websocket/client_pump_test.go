package websocket

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/secmem"
)

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
	writerDone := make(chan struct{})
	go c.writePump(pumpDone, writerDone)
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
	if c.terminalOutputBase64Enabled() {
		t.Fatal("connected without capabilities should not enable terminal base64")
	}
}

func TestReadPump_ConnectedMessageEnablesTerminalOutputBase64(t *testing.T) {
	srv := newTestServer(t, func(conn *websocket.Conn) {
		conn.WriteJSON(map[string]any{
			"type":         "connected",
			"capabilities": []string{"terminal_output_base64"},
		})
		time.Sleep(100 * time.Millisecond)
		conn.Close()
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	c.readPump()

	if !c.terminalOutputBase64Enabled() {
		t.Fatal("expected terminal_output_base64 capability to be enabled")
	}
}

func TestConnectResetsTerminalOutputBase64Capability(t *testing.T) {
	srv := newTestServer(t, func(conn *websocket.Conn) {
		conn.WriteJSON(map[string]any{
			"type":         "connected",
			"capabilities": []string{"terminal_output_base64"},
		})
		time.Sleep(100 * time.Millisecond)
		conn.Close()
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}
	c.readPump()

	if !c.terminalOutputBase64Enabled() {
		t.Fatal("expected capability enabled after connected message")
	}

	c.closeCurrentConn(false)
	if c.terminalOutputBase64Enabled() {
		t.Fatal("expected capability reset after disconnect")
	}

	if err := c.connect(); err != nil {
		t.Fatalf("reconnect error: %v", err)
	}
	if c.terminalOutputBase64Enabled() {
		t.Fatal("expected capability reset on reconnect before connected message")
	}
}

func TestHasServerCapability_ReflectsHandshakeCapabilityList(t *testing.T) {
	srv := newTestServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteJSON(map[string]any{
			"type":         "connected",
			"capabilities": []string{"terminal_output_base64", "backup_run_async"},
		})
		time.Sleep(100 * time.Millisecond)
		_ = conn.Close()
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}

	c.readPump()

	if !c.HasServerCapability("backup_run_async") {
		t.Fatal("expected backup_run_async capability to be recognized")
	}
	if !c.HasServerCapability("terminal_output_base64") {
		t.Fatal("expected terminal_output_base64 capability to still be recognized")
	}
	if c.HasServerCapability("some_unadvertised_capability") {
		t.Fatal("expected unadvertised capability to be false")
	}
}

func TestHasServerCapability_FalseBeforeHandshake(t *testing.T) {
	c := newTestClient("http://127.0.0.1:1", noopHandler)
	if c.HasServerCapability("backup_run_async") {
		t.Fatal("expected no capabilities before any connected handshake")
	}
}

func TestConnectResetsServerCapabilities(t *testing.T) {
	srv := newTestServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteJSON(map[string]any{
			"type":         "connected",
			"capabilities": []string{"backup_run_async"},
		})
		time.Sleep(100 * time.Millisecond)
		_ = conn.Close()
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	if err := c.connect(); err != nil {
		t.Fatalf("connect error: %v", err)
	}
	c.readPump()

	if !c.HasServerCapability("backup_run_async") {
		t.Fatal("expected capability enabled after connected message")
	}

	c.closeCurrentConn(false)
	if c.HasServerCapability("backup_run_async") {
		t.Fatal("expected capability reset after disconnect")
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
	writerDone := make(chan struct{})
	go c.writePump(pumpDone, writerDone)
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
	writerDone := make(chan struct{})
	go c.writePump(pumpDone, writerDone)
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
	writerDone := make(chan struct{})
	go c.writePump(pumpDone, writerDone)

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
	writerDone := make(chan struct{})
	go c.writePump(pumpDone, writerDone)

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
	writerDone := make(chan struct{})
	go func() {
		c.writePump(pumpDone, writerDone)
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
	writerDone := make(chan struct{})
	go func() {
		c.writePump(pumpDone, writerDone)
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

// TestWritePump_ResultWriteFailure_PreservedViaHook proves FIX 3: a command
// result popped off resultChan that cannot be delivered — either because the
// connection was already torn down (conn == nil) or because WriteMessage
// errored — is handed to OnResultWriteFailed instead of being silently
// dropped. This is the loss window where SendResult already reported success
// (the frame reached the channel) yet the terminal result never made the wire.
func TestWritePump_ResultWriteFailure_PreservedViaHook(t *testing.T) {
	t.Run("conn nil re-enqueues", func(t *testing.T) {
		c := newTestClient("http://localhost", noopHandler) // conn is nil

		var mu sync.Mutex
		var preserved []CommandResult
		c.OnResultWriteFailed = func(r CommandResult) {
			mu.Lock()
			preserved = append(preserved, r)
			mu.Unlock()
		}

		pumpDone := make(chan struct{})
		writerDone := make(chan struct{})
		go c.writePump(pumpDone, writerDone)

		c.resultChan <- outboundResult{
			data:   []byte(`{"type":"command_result","commandId":"cmd-nil"}`),
			result: CommandResult{Type: "command_result", CommandID: "cmd-nil"},
		}

		deadline := time.After(2 * time.Second)
		for {
			mu.Lock()
			n := len(preserved)
			mu.Unlock()
			if n == 1 {
				break
			}
			select {
			case <-deadline:
				t.Fatal("OnResultWriteFailed not called for conn==nil result")
			default:
				time.Sleep(5 * time.Millisecond)
			}
		}
		mu.Lock()
		got := preserved[0].CommandID
		mu.Unlock()
		if got != "cmd-nil" {
			t.Fatalf("preserved result commandId = %q, want cmd-nil", got)
		}

		close(pumpDone)
		<-writerDone
	})

	t.Run("write error re-enqueues", func(t *testing.T) {
		srv := newTestServer(t, func(conn *websocket.Conn) {
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		})
		defer srv.Close()

		c := newTestClient(srv.URL, noopHandler)
		if err := c.connect(); err != nil {
			t.Fatalf("connect error: %v", err)
		}

		preserved := make(chan CommandResult, 1)
		c.OnResultWriteFailed = func(r CommandResult) { preserved <- r }

		pumpDone := make(chan struct{})
		writerDone := make(chan struct{})
		go c.writePump(pumpDone, writerDone)

		// Close the underlying connection while c.conn stays non-nil, so
		// writePump takes the WriteMessage-error path (not the conn==nil path)
		// deterministically when the result is dequeued.
		c.connMu.RLock()
		conn := c.conn
		c.connMu.RUnlock()
		_ = conn.Close()

		c.resultChan <- outboundResult{
			data:   []byte(`{"type":"command_result","commandId":"cmd-err"}`),
			result: CommandResult{Type: "command_result", CommandID: "cmd-err"},
		}

		select {
		case r := <-preserved:
			if r.CommandID != "cmd-err" {
				t.Fatalf("preserved result commandId = %q, want cmd-err", r.CommandID)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("OnResultWriteFailed not called on WriteMessage error")
		}

		// writePump returns on write error; writerDone must close.
		select {
		case <-writerDone:
		case <-time.After(2 * time.Second):
			t.Fatal("writePump did not exit after write error")
		}
	})
}

// TestReadPump_OnConnectedFiresEveryReconnect proves the property the backup-
// result outbox flush depends on: OnConnected fires on EVERY (re)connect
// handshake, not just the first. The outbox would strand pending results if a
// later reconnect skipped the flush.
func TestReadPump_OnConnectedFiresEveryReconnect(t *testing.T) {
	var count atomic.Int32

	// Each accepted connection sends one "connected" welcome frame then closes,
	// forcing the client to reconnect.
	srv := newTestServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteJSON(map[string]any{"type": "connected"})
		time.Sleep(20 * time.Millisecond)
		_ = conn.Close()
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	c.OnConnected = func() { count.Add(1) }

	// Drive two connect + readPump cycles (two reconnects).
	for i := 0; i < 2; i++ {
		if err := c.connect(); err != nil {
			t.Fatalf("connect cycle %d: %v", i, err)
		}
		c.readPump() // returns when the server closes the connection
		c.closeCurrentConn(false)
	}

	if got := count.Load(); got != 2 {
		t.Fatalf("OnConnected fired %d times across 2 reconnects, want 2", got)
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
	writerDone := make(chan struct{})
	go c.writePump(pumpDone, writerDone)
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
