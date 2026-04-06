package sessionbroker

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func createTestSession(t *testing.T) (*Session, *ipc.Conn) {
	t.Helper()
	serverConn, clientConn := createSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := NewSession(serverIPC, 1000, "1000", "testuser", "x11:0", "test-session-1", []string{"notify", "tray", "run_as_user"})
	return session, clientIPC
}

func createSocketPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	clientCh := make(chan net.Conn, 1)
	go func() {
		conn, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Errorf("dial: %v", err)
			return
		}
		clientCh <- conn
	}()

	serverConn, err := listener.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}

	clientConn := <-clientCh
	return serverConn, clientConn
}

func TestHasScope(t *testing.T) {
	session := &Session{
		AllowedScopes: []string{"notify", "tray", "run_as_user"},
	}

	tests := []struct {
		scope    string
		expected bool
	}{
		{"notify", true},
		{"tray", true},
		{"run_as_user", true},
		{"desktop", false},
		{"clipboard", false},
		{"", false},
	}

	for _, tt := range tests {
		if got := session.HasScope(tt.scope); got != tt.expected {
			t.Errorf("HasScope(%q) = %v, want %v", tt.scope, got, tt.expected)
		}
	}
}

func TestHasScopeWildcard(t *testing.T) {
	session := &Session{
		AllowedScopes: []string{"*"},
	}

	if !session.HasScope("anything") {
		t.Error("wildcard scope should match anything")
	}
	if !session.HasScope("run_as_user") {
		t.Error("wildcard scope should match run_as_user")
	}
}

func TestHasScopeEmpty(t *testing.T) {
	session := &Session{
		AllowedScopes: nil,
	}

	if session.HasScope("notify") {
		t.Error("empty scopes should not match anything")
	}
}

func TestSendCommandAndResponse(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	// Simulate the client reading the command and responding
	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("client recv: %v", err)
			return
		}

		// Send response back
		payload, _ := json.Marshal(map[string]string{"result": "ok"})
		resp := &ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeCommandResult,
			Payload: payload,
		}
		if err := clientIPC.Send(resp); err != nil {
			t.Errorf("client send: %v", err)
		}
	}()

	// Start recv loop in background to route responses
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {
		// No unmatched messages expected
	})

	resp, err := session.SendCommand("cmd-1", ipc.TypeCommand, map[string]string{"action": "test"}, 2*time.Second)
	if err != nil {
		t.Fatalf("SendCommand: %v", err)
	}
	if resp == nil {
		t.Fatal("expected non-nil response")
	}
	if resp.ID != "cmd-1" {
		t.Errorf("expected response ID cmd-1, got %s", resp.ID)
	}
}

func TestSendCommandTimeout(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	// Start recv loop but client never responds
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {})

	_, err := session.SendCommand("cmd-timeout", ipc.TypeCommand, map[string]string{"action": "test"}, 100*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if err != ErrCommandTimeout {
		t.Errorf("expected ErrCommandTimeout, got %v", err)
	}
}

func TestSendCommandSessionClosed(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer clientIPC.Close()

	// Close session after a brief delay
	go func() {
		time.Sleep(50 * time.Millisecond)
		session.Close()
	}()

	_, err := session.SendCommand("cmd-close", ipc.TypeCommand, map[string]string{"action": "test"}, 2*time.Second)
	if err == nil {
		t.Fatal("expected error when session closed")
	}
}

func TestCloseDoesNotClosePendingResponseChannel(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer clientIPC.Close()

	ch := make(chan *ipc.Envelope, 1)
	session.mu.Lock()
	session.pending["cmd-close"] = pendingResponse{ch: ch}
	session.mu.Unlock()

	if err := session.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("send on pending response channel panicked after Close: %v", r)
		}
	}()

	ch <- &ipc.Envelope{ID: "cmd-close"}
}

func TestHandleResponseUnknownID(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	env := &ipc.Envelope{
		ID:   "unknown-id",
		Type: ipc.TypeCommandResult,
	}

	matched := session.HandleResponse(env)
	if matched {
		t.Error("HandleResponse should return false for unknown command ID")
	}
}

func TestHandleResponseRejectsMismatchedType(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	ch := make(chan *ipc.Envelope, 1)
	session.mu.Lock()
	session.pending["cmd-1"] = pendingResponse{
		ch:           ch,
		expectedType: ipc.TypeCommandResult,
	}
	session.mu.Unlock()

	matched := session.HandleResponse(&ipc.Envelope{
		ID:   "cmd-1",
		Type: ipc.TypeNotifyResult,
	})
	if !matched {
		t.Fatal("expected pending command ID to be recognized")
	}

	select {
	case <-ch:
		t.Fatal("expected mismatched response type not to be delivered")
	default:
	}
}

func TestHandleResponseRejectsMismatchedCommandResultPayloadID(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	ch := make(chan *ipc.Envelope, 1)
	session.mu.Lock()
	session.pending["cmd-1"] = pendingResponse{
		ch:           ch,
		expectedType: ipc.TypeCommandResult,
		validate: responseValidator(ipc.TypeCommand, ipc.IPCCommand{
			CommandID: "cmd-expected",
			Type:      "exec",
		}),
	}
	session.mu.Unlock()

	payload, err := json.Marshal(ipc.IPCCommandResult{
		CommandID: "cmd-other",
		Status:    "completed",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	matched := session.HandleResponse(&ipc.Envelope{
		ID:      "cmd-1",
		Type:    ipc.TypeCommandResult,
		Payload: payload,
	})
	if !matched {
		t.Fatal("expected pending command ID to be recognized")
	}

	select {
	case <-ch:
		t.Fatal("expected mismatched command result payload not to be delivered")
	default:
	}
}

func TestHandleResponseRejectsMismatchedDesktopStartSessionID(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	ch := make(chan *ipc.Envelope, 1)
	session.mu.Lock()
	session.pending["desk-1"] = pendingResponse{
		ch:           ch,
		expectedType: ipc.TypeDesktopStart,
		validate: responseValidator(ipc.TypeDesktopStart, ipc.DesktopStartRequest{
			SessionID: "session-expected",
		}),
	}
	session.mu.Unlock()

	payload, err := json.Marshal(ipc.DesktopStartResponse{
		SessionID: "session-other",
		Answer:    "fake-answer",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	matched := session.HandleResponse(&ipc.Envelope{
		ID:      "desk-1",
		Type:    ipc.TypeDesktopStart,
		Payload: payload,
	})
	if !matched {
		t.Fatal("expected pending command ID to be recognized")
	}

	select {
	case <-ch:
		t.Fatal("expected mismatched desktop response payload not to be delivered")
	default:
	}
}

func TestHandleResponseRejectsMismatchedBackupCommandResultPayloadID(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	ch := make(chan *ipc.Envelope, 1)
	session.mu.Lock()
	session.pending["backup-1"] = pendingResponse{
		ch:           ch,
		expectedType: backupipc.TypeBackupResult,
		validate: responseValidator(backupipc.TypeBackupCommand, backupipc.BackupCommandRequest{
			CommandID:   "backup-expected",
			CommandType: "run_backup",
		}),
	}
	session.mu.Unlock()

	payload, err := json.Marshal(backupipc.BackupCommandResult{
		CommandID: "backup-other",
		Success:   true,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	matched := session.HandleResponse(&ipc.Envelope{
		ID:      "backup-1",
		Type:    backupipc.TypeBackupResult,
		Payload: payload,
	})
	if !matched {
		t.Fatal("expected pending command ID to be recognized")
	}

	select {
	case <-ch:
		t.Fatal("expected mismatched backup response payload not to be delivered")
	default:
	}
}

func TestCloseIdempotent(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer clientIPC.Close()

	// Close should not panic when called multiple times
	session.Close()
	session.Close()
}

func TestTouch(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	initial := session.IdleDuration()
	time.Sleep(50 * time.Millisecond)
	afterSleep := session.IdleDuration()

	if afterSleep <= initial {
		t.Error("idle duration should increase over time")
	}

	session.Touch()
	afterTouch := session.IdleDuration()

	if afterTouch >= afterSleep {
		t.Error("idle duration should decrease after Touch")
	}
}

func TestInfo(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer session.Close()
	defer clientIPC.Close()

	info := session.Info()
	if info.UID != 1000 {
		t.Errorf("expected UID 1000, got %d", info.UID)
	}
	if info.Username != "testuser" {
		t.Errorf("expected username testuser, got %s", info.Username)
	}
	if info.DisplayEnv != "x11:0" {
		t.Errorf("expected displayEnv x11:0, got %s", info.DisplayEnv)
	}
	if info.SessionID != "test-session-1" {
		t.Errorf("expected sessionId test-session-1, got %s", info.SessionID)
	}
}

func TestTCCStatusPrefersDesktopHelper(t *testing.T) {
	broker := &Broker{
		sessions: make(map[string]*Session),
	}

	userHelper := &Session{
		SessionID:     "helper-user",
		AllowedScopes: []string{"desktop"},
		Capabilities:  &ipc.Capabilities{CanCapture: true},
		BinaryKind:    ipc.HelperBinaryUserHelper,
		TCCStatus: &ipc.TCCStatus{
			ScreenRecording: true,
			Accessibility:   true,
		},
	}
	loginWindow := &Session{
		SessionID:      "desktop-login",
		AllowedScopes:  []string{"desktop"},
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextLoginWindow,
		TCCStatus: &ipc.TCCStatus{
			ScreenRecording: true,
			Accessibility:   true,
		},
	}
	userSession := &Session{
		SessionID:      "desktop-user",
		AllowedScopes:  []string{"desktop"},
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextUserSession,
		TCCStatus: &ipc.TCCStatus{
			ScreenRecording: true,
			Accessibility:   true,
			RemoteDesktop:   ptrBool(true),
		},
	}

	broker.sessions[userHelper.SessionID] = userHelper
	broker.sessions[loginWindow.SessionID] = loginWindow
	broker.sessions[userSession.SessionID] = userSession

	status := broker.TCCStatus()
	if status == nil {
		t.Fatal("expected TCC status")
	}
	if status.RemoteDesktop == nil || !*status.RemoteDesktop {
		t.Fatalf("expected preferred desktop helper TCC status, got %+v", status)
	}
}

func ptrBool(v bool) *bool {
	return &v
}
