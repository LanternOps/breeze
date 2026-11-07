package heartbeat

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestParseDesktopSessionPolicyRelayOnly(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload map[string]any
		want    bool
	}{
		{"true", map[string]any{"relayOnly": true}, true},
		{"false", map[string]any{"relayOnly": false}, false},
		{"absent", map[string]any{}, false},
		{"nil", nil, false},
		{"string", map[string]any{"relayOnly": "true"}, false},
		{"number", map[string]any{"relayOnly": 1.0}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseDesktopSessionPolicy(tc.payload); got.RelayOnly != tc.want {
				t.Fatalf("RelayOnly = %v, want %v", got.RelayOnly, tc.want)
			}
		})
	}
}

func TestStartDesktopViaHelperPassesRelayOnly(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-relay", []string{"desktop"})
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Errorf("set read deadline: %v", err)
			return
		}
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("recv: %v", err)
			return
		}
		var req ipc.DesktopStartRequest
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			t.Errorf("decode: %v", err)
			return
		}
		if !req.RelayOnly {
			t.Error("helper request discarded RelayOnly")
		}
		payload, _ := json.Marshal(ipc.DesktopStartResponse{SessionID: req.SessionID, Answer: "ok"})
		if err := clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStart, Payload: payload}); err != nil {
			t.Errorf("send: %v", err)
			return
		}
		// Drain the follow-up notification so the in-memory pipe does not
		// block the synchronous write that starts helper ICE trickling.
		if _, err := clientIPC.Recv(); err != nil {
			t.Errorf("recv trickle notification: %v", err)
		}
	}()
	h := &Heartbeat{helperFinder: func(string) *sessionbroker.Session { return session }}
	policy := desktop.DefaultSessionPolicy()
	policy.RelayOnly = true
	result := h.startDesktopViaHelper("desktop-relay", "offer", nil, 0, policy, map[string]any{})
	<-done
	if result.Status != "completed" {
		t.Fatalf("status = %s: %s", result.Status, result.Error)
	}
}
