package websocket

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/secmem"
)

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

// ---------- SendBackupProgress ----------

func TestSendBackupProgress_Success(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	event := map[string]any{
		"phase":   "restoring",
		"current": 3,
	}
	err := c.SendBackupProgress("cmd-backup-1", event)
	if err != nil {
		t.Fatalf("SendBackupProgress error: %v", err)
	}

	select {
	case data := <-c.sendChan:
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if parsed["type"] != "backup_progress" {
			t.Fatalf("type = %v, want backup_progress", parsed["type"])
		}
		if parsed["commandId"] != "cmd-backup-1" {
			t.Fatalf("commandId = %v, want cmd-backup-1", parsed["commandId"])
		}
		progress, ok := parsed["progress"].(map[string]any)
		if !ok {
			t.Fatal("progress field missing or wrong type")
		}
		if progress["phase"] != "restoring" {
			t.Fatalf("phase = %v, want restoring", progress["phase"])
		}
	default:
		t.Fatal("expected data in sendChan")
	}
}

func TestSendBackupProgress_ClientStopped(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}
	close(c.done)

	err := c.SendBackupProgress("cmd-1", map[string]any{"current": 0})
	if err == nil {
		t.Fatal("expected error when client is stopped")
	}
	if !strings.Contains(err.Error(), "client is stopped") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendBackupProgress_ChannelFull(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)

	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}

	err := c.SendBackupProgress("cmd-1", map[string]any{"current": 100})
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
	oldTimeout := terminalOutputEnqueueTimeout
	terminalOutputEnqueueTimeout = 10 * time.Millisecond
	defer func() { terminalOutputEnqueueTimeout = oldTimeout }()

	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}

	err := c.SendTerminalOutput("sess-1", []byte("data"))
	if err == nil {
		t.Fatal("expected error when send channel is full")
	}
	if !strings.Contains(err.Error(), "timed out waiting for terminal output queue") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------- Table-driven: Send method error cases ----------

func TestSendMethods_ErrorCases(t *testing.T) {
	tests := []struct {
		name    string
		setup   func(c *Client)
		send    func(c *Client) error
		wantErr string
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
