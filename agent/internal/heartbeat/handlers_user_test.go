package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestHandleNotifyUserUsesPreferredNotifySession(t *testing.T) {
	olderServerConn, olderClientConn := createTestSocketPair(t)
	olderServerIPC := ipc.NewConn(olderServerConn)
	olderClientIPC := ipc.NewConn(olderClientConn)
	olderSession := sessionbroker.NewSession(olderServerIPC, 1000, "1000", "alice", "quartz", "notify-older", []string{"notify"})
	olderSession.HelperRole = ipc.HelperRoleUser
	olderSession.ConnectedAt = time.Now().Add(-2 * time.Hour)
	olderSession.LastSeen = time.Now().Add(-time.Hour)

	newerServerConn, newerClientConn := createTestSocketPair(t)
	newerServerIPC := ipc.NewConn(newerServerConn)
	newerClientIPC := ipc.NewConn(newerClientConn)
	newerSession := sessionbroker.NewSession(newerServerIPC, 1001, "1001", "bob", "quartz", "notify-newer", []string{"notify"})
	newerSession.HelperRole = ipc.HelperRoleUser
	newerSession.ConnectedAt = time.Now().Add(-30 * time.Minute)
	newerSession.LastSeen = time.Now().Add(-time.Minute)

	go olderSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go newerSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	seen := make(chan string, 2)
	startResponder := func(label string, client *ipc.Conn) {
		t.Helper()
		go func() {
			client.SetReadDeadline(time.Now().Add(750 * time.Millisecond))
			env, err := client.Recv()
			if err != nil {
				return
			}
			seen <- label
			respPayload, _ := json.Marshal(ipc.NotifyResult{Delivered: true})
			if err := client.Send(&ipc.Envelope{
				ID:      env.ID,
				Type:    ipc.TypeNotifyResult,
				Payload: respPayload,
			}); err != nil {
				t.Errorf("send notify response for %s: %v", label, err)
			}
		}()
	}

	startResponder("older", olderClientIPC)
	startResponder("newer", newerClientIPC)

	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, olderSession, newerSession),
	}
	result := handleNotifyUser(h, Command{
		ID:   "notify-1",
		Type: CmdNotifyUser,
		Payload: map[string]any{
			"body": "hello",
		},
	})

	_ = olderSession.Close()
	_ = newerSession.Close()
	_ = olderClientIPC.Close()
	_ = newerClientIPC.Close()

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}

	select {
	case got := <-seen:
		if got != "newer" {
			t.Fatalf("notify_user targeted %q helper, want newer preferred helper", got)
		}
	default:
		t.Fatal("no helper received notify_user")
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("unmarshal result payload: %v", err)
	}
	if payload["username"] != "bob" {
		t.Fatalf("notify_user result username = %v, want bob", payload["username"])
	}
}

func TestHandleTrayUpdateSendsToAllSameIdentityHelpers(t *testing.T) {
	serverConn1, clientConn1 := createTestSocketPair(t)
	serverIPC1 := ipc.NewConn(serverConn1)
	clientIPC1 := ipc.NewConn(clientConn1)
	session1 := sessionbroker.NewSession(serverIPC1, 1000, "1000", "alice", "quartz", "tray-1", []string{"tray"})

	serverConn2, clientConn2 := createTestSocketPair(t)
	serverIPC2 := ipc.NewConn(serverConn2)
	clientIPC2 := ipc.NewConn(clientConn2)
	session2 := sessionbroker.NewSession(serverIPC2, 1000, "1000", "alice", "quartz", "tray-2", []string{"tray"})

	seen := make(chan string, 2)
	startReceiver := func(label string, client *ipc.Conn) {
		t.Helper()
		go func() {
			client.SetReadDeadline(time.Now().Add(2 * time.Second))
			env, err := client.Recv()
			if err != nil {
				t.Errorf("recv tray update for %s: %v", label, err)
				return
			}
			if env.Type != ipc.TypeTrayUpdate {
				t.Errorf("unexpected message type for %s: %s", label, env.Type)
				return
			}
			seen <- label
		}()
	}

	startReceiver("tray-1", clientIPC1)
	startReceiver("tray-2", clientIPC2)

	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session1, session2),
	}
	result := handleTrayUpdate(h, Command{
		ID:   "tray-update-1",
		Type: CmdTrayUpdate,
		Payload: map[string]any{
			"status":  "ok",
			"tooltip": "Breeze Agent",
		},
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}

	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case label := <-seen:
			got[label] = true
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for tray updates")
		}
	}

	_ = session1.Close()
	_ = session2.Close()
	_ = clientIPC1.Close()
	_ = clientIPC2.Close()

	if !got["tray-1"] || !got["tray-2"] {
		t.Fatalf("tray updates delivered to %+v, want both sessions", got)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("unmarshal tray result payload: %v", err)
	}
	if payload["sentTo"] != float64(2) {
		t.Fatalf("sentTo = %v, want 2", payload["sentTo"])
	}
}
