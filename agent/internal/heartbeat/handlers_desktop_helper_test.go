package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestStartDesktopViaHelperPreservesTargetSessionOnRetry(t *testing.T) {
	serverConn1, clientConn1 := createTestSocketPair(t)
	serverIPC1 := ipc.NewConn(serverConn1)
	clientIPC1 := ipc.NewConn(clientConn1)
	session1 := sessionbroker.NewSession(serverIPC1, 1000, "1000", "alice", "quartz", "helper-1", []string{"desktop"})

	serverConn2, clientConn2 := createTestSocketPair(t)
	serverIPC2 := ipc.NewConn(serverConn2)
	clientIPC2 := ipc.NewConn(clientConn2)
	session2 := sessionbroker.NewSession(serverIPC2, 1000, "1000", "alice", "quartz", "helper-2", []string{"desktop"})

	go session1.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go session2.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	go func() {
		clientIPC1.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, _ = clientIPC1.Recv()
		_ = clientIPC1.Close()
		_ = session1.Close()
	}()

	go func() {
		clientIPC2.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC2.Recv()
		if err != nil {
			t.Errorf("client recv: %v", err)
			return
		}

		respPayload, _ := json.Marshal(ipc.DesktopStartResponse{
			SessionID: "desktop-1",
			Answer:    "answer-2",
		})
		if err := clientIPC2.Send(&ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeDesktopStart,
			Payload: respPayload,
		}); err != nil {
			t.Errorf("client send: %v", err)
		}
	}()

	var seenTargets []string
	h := &Heartbeat{
		helperFinder: func(targetSession string) *sessionbroker.Session {
			seenTargets = append(seenTargets, targetSession)
			if len(seenTargets) == 1 {
				return session1
			}
			return session2
		},
	}

	result := h.startDesktopViaHelper("desktop-1", "offer", nil, 0, map[string]any{
		"targetSessionId": float64(42),
	})

	_ = session1.Close()
	_ = session2.Close()
	_ = clientIPC2.Close()

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}
	if len(seenTargets) != 2 {
		t.Fatalf("helperFinder called %d times, want 2", len(seenTargets))
	}
	if seenTargets[0] != "42" || seenTargets[1] != "42" {
		t.Fatalf("target session changed across retry: %+v", seenTargets)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("unmarshal result payload: %v", err)
	}
	if payload["answer"] != "answer-2" {
		t.Fatalf("unexpected result payload: %+v", payload)
	}
	owner, ok := h.desktopOwners.Load("desktop-1")
	if !ok {
		t.Fatal("desktop owner was not recorded")
	}
	if owner != session2.SessionID {
		t.Fatalf("desktop owner = %v, want %v", owner, session2.SessionID)
	}
}

func TestHelperSessionForTargetUsesOverride(t *testing.T) {
	want := &sessionbroker.Session{SessionID: "override"}
	h := &Heartbeat{
		helperFinder: func(targetSession string) *sessionbroker.Session {
			if targetSession != "7" {
				t.Fatalf("targetSession = %q, want 7", targetSession)
			}
			return want
		},
	}

	if got := h.helperSessionForTarget("7"); got != want {
		t.Fatalf("helperSessionForTarget returned %+v, want %+v", got, want)
	}
}

func TestStartDesktopViaHelperPassesDisplayIndex(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-display", []string{"desktop"})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	done := make(chan struct{})
	go func() {
		defer close(done)
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("client recv: %v", err)
			return
		}

		var req ipc.DesktopStartRequest
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			t.Errorf("unmarshal request: %v", err)
			return
		}
		if req.DisplayIndex != 3 {
			t.Errorf("DisplayIndex = %d, want 3", req.DisplayIndex)
		}

		respPayload, _ := json.Marshal(ipc.DesktopStartResponse{
			SessionID: req.SessionID,
			Answer:    "ok",
		})
		if err := clientIPC.Send(&ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeDesktopStart,
			Payload: respPayload,
		}); err != nil {
			t.Errorf("client send: %v", err)
		}
	}()

	h := &Heartbeat{
		helperFinder: func(string) *sessionbroker.Session { return session },
	}
	result := h.startDesktopViaHelper("desktop-display", "offer", []desktop.ICEServerConfig{}, 3, map[string]any{})

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}
}

func TestStartDesktopViaHelperDoesNotReuseWrongTargetSessionHelper(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-wrong-target", []string{"desktop"})
	session.Capabilities = &ipc.Capabilities{CanCapture: true}
	session.WinSessionID = "1"
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	seen := make(chan struct{}, 1)
	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(750 * time.Millisecond))
		env, err := clientIPC.Recv()
		if err == nil && env != nil {
			seen <- struct{}{}
		}
	}()

	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		spawnHelper: func(targetSession string) error {
			if targetSession != "42" {
				t.Fatalf("spawn targetSession = %q, want 42", targetSession)
			}
			return nil
		},
	}

	result := h.startDesktopViaHelper("desktop-target", "offer", nil, 0, map[string]any{
		"targetSessionId": float64(42),
	})

	_ = session.Close()
	_ = clientIPC.Close()

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %s", result.Status)
	}
	select {
	case <-seen:
		t.Fatal("start_desktop should not reuse helper from the wrong target session")
	default:
	}
}

func TestKillDesktopStaleHelpersUsesRoleScopedKey(t *testing.T) {
	var seen string
	h := &Heartbeat{
		killStaleHelpers: func(staleKey string) {
			seen = staleKey
		},
	}

	h.killDesktopStaleHelpers("42")

	if seen != "42-system" {
		t.Fatalf("stale helper key = %q, want 42-system", seen)
	}
}

func TestHandleStopDesktopUsesRecordedOwner(t *testing.T) {
	ownerServerConn, ownerClientConn := createTestSocketPair(t)
	ownerServerIPC := ipc.NewConn(ownerServerConn)
	ownerClientIPC := ipc.NewConn(ownerClientConn)
	ownerSession := sessionbroker.NewSession(ownerServerIPC, 1000, "1000", "alice", "quartz", "helper-owner", []string{"desktop"})
	ownerSession.Capabilities = &ipc.Capabilities{CanCapture: true}
	ownerSession.HelperRole = ipc.HelperRoleSystem
	ownerSession.WinSessionID = "1"

	otherServerConn, otherClientConn := createTestSocketPair(t)
	otherServerIPC := ipc.NewConn(otherServerConn)
	otherClientIPC := ipc.NewConn(otherClientConn)
	otherSession := sessionbroker.NewSession(otherServerIPC, 1000, "1000", "bob", "quartz", "helper-other", []string{"desktop"})
	otherSession.Capabilities = &ipc.Capabilities{CanCapture: true}
	otherSession.HelperRole = ipc.HelperRoleSystem
	otherSession.WinSessionID = "2"

	go ownerSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go otherSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	seen := make(chan string, 2)
	go func() {
		ownerClientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := ownerClientIPC.Recv()
		if err != nil {
			t.Errorf("owner recv: %v", err)
			return
		}
		seen <- "owner"
		if err := ownerClientIPC.Send(&ipc.Envelope{
			ID:      env.ID,
			Type:    ipc.TypeDesktopStop,
			Payload: json.RawMessage(`{"stopped":true}`),
		}); err != nil {
			t.Errorf("owner send: %v", err)
		}
	}()

	go func() {
		otherClientIPC.SetReadDeadline(time.Now().Add(750 * time.Millisecond))
		env, err := otherClientIPC.Recv()
		if err == nil && env != nil {
			seen <- "other"
		}
	}()

	broker := newTestBrokerWithSessions(t, ownerSession, otherSession)
	h := &Heartbeat{
		sessionBroker: broker,
		isHeadless:    true,
	}
	h.rememberDesktopOwner("desktop-stop-1", ownerSession.SessionID)

	result := handleStopDesktop(h, Command{
		ID:   "cmd-stop-1",
		Type: tools.CmdStopDesktop,
		Payload: map[string]any{
			"sessionId": "desktop-stop-1",
		},
	})

	_ = ownerSession.Close()
	_ = otherSession.Close()
	_ = ownerClientIPC.Close()
	_ = otherClientIPC.Close()

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}
	select {
	case got := <-seen:
		if got != "owner" {
			t.Fatalf("desktop_stop targeted %q helper, want owner", got)
		}
	default:
		t.Fatal("no helper received desktop_stop")
	}
	if owner := h.desktopOwnerSession("desktop-stop-1"); owner != nil {
		t.Fatalf("desktop owner should be cleared after stop, got %+v", owner)
	}
}

func TestHandleUserHelperMessageClearsOwnerOnPeerDisconnect(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-owner", []string{"desktop"})
	session.Capabilities = &ipc.Capabilities{CanCapture: true}
	session.HelperRole = ipc.HelperRoleSystem

	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
	}
	h.rememberDesktopOwner("desktop-peer-disconnect", session.SessionID)

	payload, err := json.Marshal(ipc.DesktopPeerDisconnectedNotice{SessionID: "desktop-peer-disconnect"})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	h.handleUserHelperMessage(session, &ipc.Envelope{
		ID:      "notice-1",
		Type:    ipc.TypeDesktopPeerDisconnected,
		Payload: payload,
	})

	if owner := h.desktopOwnerSession("desktop-peer-disconnect"); owner != nil {
		t.Fatalf("desktop owner should be cleared after peer disconnect, got %+v", owner)
	}

	_ = session.Close()
	_ = clientConn.Close()
}

func TestHandleStopDesktopFailsWhenOwnerUnavailable(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-fallback", []string{"desktop"})
	session.Capabilities = &ipc.Capabilities{CanCapture: true}
	session.HelperRole = ipc.HelperRoleSystem
	session.WinSessionID = "1"
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	seen := make(chan struct{}, 1)
	go func() {
		clientIPC.SetReadDeadline(time.Now().Add(750 * time.Millisecond))
		env, err := clientIPC.Recv()
		if err == nil && env != nil {
			seen <- struct{}{}
		}
	}()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{
		sessionBroker: broker,
		isHeadless:    true,
	}
	h.rememberDesktopOwner("desktop-stop-missing", "missing-session")

	result := handleStopDesktop(h, Command{
		ID:   "cmd-stop-2",
		Type: tools.CmdStopDesktop,
		Payload: map[string]any{
			"sessionId": "desktop-stop-missing",
		},
	})

	_ = session.Close()
	_ = clientIPC.Close()

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %s", result.Status)
	}
	if result.Error != "desktop session owner unavailable; cannot safely stop session" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	select {
	case <-seen:
		t.Fatal("desktop_stop should not be routed to a fallback helper")
	default:
	}
}
