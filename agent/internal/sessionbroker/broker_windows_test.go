//go:build windows

package sessionbroker

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// testPipeName returns a unique named pipe path for testing.
func testPipeName(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf(`\\.\pipe\breeze-test-%d`, os.Getpid())
}

func TestNamedPipeListenAndAccept(t *testing.T) {
	pipeName := testPipeName(t)
	stopChan := make(chan struct{})

	broker := New(pipeName, nil)
	defer broker.Close()

	// Start broker listener in background
	listenErr := make(chan error, 1)
	go func() {
		listenErr <- broker.Listen(stopChan)
	}()

	// Give the listener time to start
	time.Sleep(200 * time.Millisecond)

	// Verify broker started (check for immediate errors)
	select {
	case err := <-listenErr:
		t.Fatalf("broker.Listen failed immediately: %v", err)
	default:
	}

	// Connect a client
	timeout := 2 * time.Second
	conn, err := winio.DialPipe(pipeName, &timeout)
	if err != nil {
		t.Fatalf("DialPipe failed: %v", err)
	}
	conn.Close()

	// Shut down
	close(stopChan)
}

func TestNamedPipeFullHandshake(t *testing.T) {
	pipeName := testPipeName(t) + "-handshake"
	stopChan := make(chan struct{})

	var receivedMessage bool
	broker := New(pipeName, func(session *Session, env *ipc.Envelope) {
		receivedMessage = true
	})
	defer func() {
		close(stopChan)
		time.Sleep(100 * time.Millisecond)
		broker.Close()
	}()

	// Start broker
	go broker.Listen(stopChan)
	time.Sleep(200 * time.Millisecond)

	// Connect via named pipe
	timeout := 2 * time.Second
	rawConn, err := winio.DialPipe(pipeName, &timeout)
	if err != nil {
		t.Fatalf("DialPipe: %v", err)
	}
	defer rawConn.Close()

	conn := ipc.NewConn(rawConn)

	// Compute our own binary hash (same as broker does)
	binaryHash := computeTestBinaryHash(t)

	// Get current user info
	cu, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}

	// Send auth request with SID (required on Windows)
	authReq := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             0,      // Windows: UID is always 0
		SID:             cu.Uid, // Go returns SID as Uid on Windows
		Username:        cu.Username,
		SessionID:       fmt.Sprintf("test-helper-%d", os.Getpid()),
		DisplayEnv:      "windows",
		PID:             os.Getpid(),
		BinaryHash:      binaryHash,
	}

	err = conn.SendTyped("auth", ipc.TypeAuthRequest, authReq)
	if err != nil {
		t.Fatalf("send auth request: %v", err)
	}

	// Read auth response
	env, err := conn.Recv()
	if err != nil {
		t.Fatalf("recv auth response: %v", err)
	}

	if env.Type != ipc.TypeAuthResponse {
		t.Fatalf("expected auth_response, got %s", env.Type)
	}

	var authResp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &authResp); err != nil {
		t.Fatalf("unmarshal auth response: %v", err)
	}

	if !authResp.Accepted {
		t.Fatalf("auth rejected: %s", authResp.Reason)
	}

	if authResp.SessionKey == "" {
		t.Fatal("expected non-empty session key")
	}

	t.Logf("Auth accepted: sessionKey=%s..., scopes=%v", authResp.SessionKey[:8], authResp.AllowedScopes)

	// Verify session appears in broker
	sessions := broker.AllSessions()
	if len(sessions) == 0 {
		// Give it a moment — the session registration happens in the broker's goroutine
		time.Sleep(200 * time.Millisecond)
		sessions = broker.AllSessions()
	}
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}

	info := sessions[0]
	if info.Username != cu.Username {
		t.Errorf("session username = %q, want %q", info.Username, cu.Username)
	}
	if info.DisplayEnv != "windows" {
		t.Errorf("session displayEnv = %q, want %q", info.DisplayEnv, "windows")
	}

	t.Logf("Session registered: uid=%d, user=%s, sessionId=%s", info.UID, info.Username, info.SessionID)

	// Set session key for HMAC on subsequent messages
	keyBytes, err := hex.DecodeString(authResp.SessionKey)
	if err != nil {
		t.Fatalf("decode session key: %v", err)
	}
	conn.SetSessionKey(keyBytes)

	// Send capabilities
	caps := ipc.Capabilities{
		CanNotify:     true,
		CanTray:       true,
		CanCapture:    false,
		CanClipboard:  true,
		DisplayServer: "windows",
	}
	if err := conn.SendTyped("caps", ipc.TypeCapabilities, caps); err != nil {
		t.Fatalf("send capabilities: %v", err)
	}

	// Give broker time to process capabilities
	time.Sleep(200 * time.Millisecond)

	// Verify capabilities were received
	session := broker.SessionForUser(cu.Username)
	if session == nil {
		t.Fatal("SessionForUser returned nil")
	}
	if session.Capabilities == nil {
		t.Fatal("capabilities not received")
	}
	if !session.Capabilities.CanNotify {
		t.Error("expected CanNotify=true")
	}
	if session.Capabilities.DisplayServer != "windows" {
		t.Errorf("DisplayServer = %q, want %q", session.Capabilities.DisplayServer, "windows")
	}

	t.Log("Capabilities received and verified")

	// Send a ping and verify pong
	if err := conn.SendTyped("ping-1", ipc.TypePing, nil); err != nil {
		t.Fatalf("send ping: %v", err)
	}

	pongEnv, err := conn.Recv()
	if err != nil {
		t.Fatalf("recv pong: %v", err)
	}
	if pongEnv.Type != ipc.TypePong {
		t.Errorf("expected pong, got %s", pongEnv.Type)
	}

	t.Log("Ping/pong verified over named pipe with HMAC")

	// Send disconnect
	_ = conn.SendTyped("disconnect", ipc.TypeDisconnect, nil)
	time.Sleep(200 * time.Millisecond)

	// Verify session was cleaned up
	remaining := broker.SessionCount()
	if remaining != 0 {
		t.Errorf("expected 0 sessions after disconnect, got %d", remaining)
	}

	t.Log("Session disconnected and cleaned up")
	_ = receivedMessage // suppress unused warning
}

func TestNamedPipeSessionDetector(t *testing.T) {
	detector := NewSessionDetector()

	sessions, err := detector.ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}

	if len(sessions) == 0 {
		t.Skip("no interactive sessions detected (headless CI?)")
	}

	for _, s := range sessions {
		t.Logf("Detected session: user=%s, session=%s, state=%s, display=%s",
			s.Username, s.Session, s.State, s.Display)

		if s.Username == "" {
			t.Error("session has empty username")
		}
		if s.Session == "" {
			t.Error("session has empty session ID")
		}
	}
}

func TestNamedPipeSIDMismatchRejected(t *testing.T) {
	pipeName := testPipeName(t) + "-sid-reject"
	stopChan := make(chan struct{})

	broker := New(pipeName, nil)
	defer func() {
		close(stopChan)
		time.Sleep(100 * time.Millisecond)
		broker.Close()
	}()

	go broker.Listen(stopChan)
	time.Sleep(200 * time.Millisecond)

	timeout := 2 * time.Second
	rawConn, err := winio.DialPipe(pipeName, &timeout)
	if err != nil {
		t.Fatalf("DialPipe: %v", err)
	}
	defer rawConn.Close()

	conn := ipc.NewConn(rawConn)
	binaryHash := computeTestBinaryHash(t)

	cu, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}

	// Send auth request with WRONG SID
	authReq := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             0,
		SID:             "S-1-5-21-FAKE-SID-12345",
		Username:        cu.Username,
		SessionID:       fmt.Sprintf("test-fake-%d", os.Getpid()),
		DisplayEnv:      "windows",
		PID:             os.Getpid(),
		BinaryHash:      binaryHash,
	}

	if err := conn.SendTyped("auth", ipc.TypeAuthRequest, authReq); err != nil {
		t.Fatalf("send auth request: %v", err)
	}

	env, err := conn.Recv()
	if err != nil {
		t.Fatalf("recv auth response: %v", err)
	}

	var authResp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &authResp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if authResp.Accepted {
		t.Fatal("expected auth to be REJECTED for fake SID, but it was accepted")
	}

	if authResp.Reason != "SID mismatch" {
		t.Errorf("expected reason 'SID mismatch', got %q", authResp.Reason)
	}

	t.Logf("SID mismatch correctly rejected: %s", authResp.Reason)
}

func TestNamedPipeMissingSIDRejected(t *testing.T) {
	pipeName := testPipeName(t) + "-no-sid"
	stopChan := make(chan struct{})

	broker := New(pipeName, nil)
	defer func() {
		close(stopChan)
		time.Sleep(100 * time.Millisecond)
		broker.Close()
	}()

	go broker.Listen(stopChan)
	time.Sleep(200 * time.Millisecond)

	timeout := 2 * time.Second
	rawConn, err := winio.DialPipe(pipeName, &timeout)
	if err != nil {
		t.Fatalf("DialPipe: %v", err)
	}
	defer rawConn.Close()

	conn := ipc.NewConn(rawConn)
	binaryHash := computeTestBinaryHash(t)

	cu, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}

	// Send auth request with NO SID (old-style, should be rejected on Windows)
	authReq := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             0,
		Username:        cu.Username,
		SessionID:       fmt.Sprintf("test-nosid-%d", os.Getpid()),
		DisplayEnv:      "windows",
		PID:             os.Getpid(),
		BinaryHash:      binaryHash,
	}

	if err := conn.SendTyped("auth", ipc.TypeAuthRequest, authReq); err != nil {
		t.Fatalf("send auth request: %v", err)
	}

	env, err := conn.Recv()
	if err != nil {
		t.Fatalf("recv auth response: %v", err)
	}

	var authResp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &authResp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if authResp.Accepted {
		t.Fatal("expected auth to be REJECTED for missing SID, but it was accepted")
	}

	t.Logf("Missing SID correctly rejected: %s", authResp.Reason)
}

func computeTestBinaryHash(t *testing.T) string {
	t.Helper()
	exePath, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	data, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", exePath, err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
