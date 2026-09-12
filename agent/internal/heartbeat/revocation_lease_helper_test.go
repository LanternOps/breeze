package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// newLeaseBridgeHelper builds a connected helper session plus a reader on the
// helper end, so a test can assert on what the agent actually put on the wire.
func newLeaseBridgeHelper(t *testing.T, id string) (*sessionbroker.Session, chan *ipc.Envelope) {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", id, []string{"desktop"})
	session.Capabilities = &ipc.Capabilities{CanCapture: true}
	session.HelperRole = ipc.HelperRoleSystem
	session.WinSessionID = "1"

	received := make(chan *ipc.Envelope, 4)
	go func() {
		for {
			_ = clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second))
			env, err := clientIPC.Recv()
			if err != nil {
				close(received)
				return
			}
			received <- env
		}
	}()
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	return session, received
}

func awaitEnvelope(t *testing.T, ch chan *ipc.Envelope, msgType string) *ipc.Envelope {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case env, ok := <-ch:
			if !ok {
				t.Fatalf("helper connection closed before a %q arrived", msgType)
			}
			if env.Type == msgType {
				return env
			}
		case <-deadline:
			t.Fatalf("no %q reached the helper", msgType)
		}
	}
}

// A helper-hosted session's renewals arrive as an unsolicited IPC message; the
// agent is the only process holding the command WebSocket, so it must turn them
// into a renew on that socket. Before the bridge existed this message type did
// not exist at all and helper-hosted sessions renewed nothing.
func TestHelperLeaseRenewIsForwardedToTheControlPlane(t *testing.T) {
	session, _ := newLeaseBridgeHelper(t, "helper-renew")
	asked := make(chan string, 1)
	h := &Heartbeat{
		sessionBroker:       newTestBrokerWithSessions(t, session),
		isHeadless:          true,
		desktopMgr:          desktop.NewSessionManager(),
		leaseRenewRequester: func(sessionID string) { asked <- sessionID },
	}
	h.rememberDesktopOwner("desk-renew", session.SessionID)

	payload, err := json.Marshal(ipc.DesktopLeaseRenewRequest{SessionID: "desk-renew"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	h.handleUserHelperMessage(session, &ipc.Envelope{
		ID:      "lease-1",
		Type:    ipc.TypeDesktopLeaseRenew,
		Payload: payload,
	})

	select {
	case got := <-asked:
		if got != "desk-renew" {
			t.Fatalf("renewed %q, want desk-renew", got)
		}
	case <-time.After(time.Second):
		t.Fatal("the agent never asked the control plane to renew the helper's lease")
	}
}

// A helper may only renew the desktop sessions it actually owns — otherwise one
// helper could keep another session alive (or, with the API's answer routed
// back, learn about it).
func TestHelperLeaseRenewFromANonOwnerIsDropped(t *testing.T) {
	owner, _ := newLeaseBridgeHelper(t, "helper-owner")
	stranger, _ := newLeaseBridgeHelper(t, "helper-stranger")
	asked := make(chan string, 1)
	h := &Heartbeat{
		sessionBroker:       newTestBrokerWithSessions(t, owner, stranger),
		isHeadless:          true,
		desktopMgr:          desktop.NewSessionManager(),
		leaseRenewRequester: func(sessionID string) { asked <- sessionID },
	}
	h.rememberDesktopOwner("desk-owned", owner.SessionID)

	payload, _ := json.Marshal(ipc.DesktopLeaseRenewRequest{SessionID: "desk-owned"})
	h.handleUserHelperMessage(stranger, &ipc.Envelope{
		ID:      "lease-2",
		Type:    ipc.TypeDesktopLeaseRenew,
		Payload: payload,
	})

	select {
	case got := <-asked:
		t.Fatalf("a non-owning helper renewed %q", got)
	case <-time.After(250 * time.Millisecond):
	}
}

// The control plane's answer must reach the process that actually holds the
// session. For a helper-hosted session that is the helper, not h.desktopMgr —
// applying it only locally is exactly the bug that killed every service-install
// session at 150s.
func TestLeaseAnswerIsForwardedToTheOwningHelper(t *testing.T) {
	session, received := newLeaseBridgeHelper(t, "helper-answer")
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
		desktopMgr:    desktop.NewSessionManager(),
	}
	h.rememberDesktopOwner("desk-answer", session.SessionID)

	expiresAt := time.Now().Add(time.Minute).UnixMilli()
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:       "desk-answer",
		ExpiresAtUnixMs: expiresAt,
	})

	env := awaitEnvelope(t, received, ipc.TypeDesktopLeaseUpdate)
	var update ipc.DesktopLeaseUpdate
	if err := json.Unmarshal(env.Payload, &update); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if update.SessionID != "desk-answer" {
		t.Fatalf("sessionId = %q", update.SessionID)
	}
	if update.ExpiresAtUnixMs != expiresAt {
		t.Fatalf("expiresAtUnixMs = %d, want %d", update.ExpiresAtUnixMs, expiresAt)
	}
	if update.Revoked {
		t.Fatal("a successful renewal must not be forwarded as a revocation")
	}
}

func TestLeaseRevocationIsForwardedToTheOwningHelper(t *testing.T) {
	session, received := newLeaseBridgeHelper(t, "helper-revoke")
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
		desktopMgr:    desktop.NewSessionManager(),
	}
	h.rememberDesktopOwner("desk-revoke", session.SessionID)

	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID: "desk-revoke",
		Revoked:   true,
		Reason:    "membership_removed",
	})

	env := awaitEnvelope(t, received, ipc.TypeDesktopLeaseUpdate)
	var update ipc.DesktopLeaseUpdate
	if err := json.Unmarshal(env.Payload, &update); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !update.Revoked || update.Reason != "membership_removed" {
		t.Fatalf("update = %+v, want a revocation with the reason carried", update)
	}
}

// applyRevocationLeaseAnswer runs inline on the WebSocket read pump, which
// websocket/client.go documents as "must not block". The revoke path used to
// run a synchronous 10s SendCommand plus a StopSession -> wg.Wait() there,
// stalling every other inbound command for the duration.
func TestRevocationAnswerDoesNotBlockTheReadPump(t *testing.T) {
	session, _ := newLeaseBridgeHelper(t, "helper-slow")
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
		desktopMgr:    desktop.NewSessionManager(),
	}
	// An owner whose helper session is NOT in the broker: the stop path falls
	// through to the direct manager, and nothing may be awaited inline.
	h.rememberDesktopOwner("desk-slow", "missing-session")

	done := make(chan struct{})
	go func() {
		h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
			SessionID: "desk-slow",
			Revoked:   true,
			Reason:    "epoch_mismatch",
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("applyRevocationLeaseAnswer blocked the read pump on the stop path")
	}
}
