package websocket

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/secmem"
)

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
