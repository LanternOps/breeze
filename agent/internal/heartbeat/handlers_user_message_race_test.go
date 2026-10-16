package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Review Focus 4: an ack that races the message_presented reply must not be
// lost, and the message must not be stored (and later replayed) after it.
func TestAckRacingPresentedIsNotResurrected(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, rec := newMessagingHeartbeat(t, assist.session)
	assist.setPresent("", func(show ipc.MessageShow) {
		raw, _ := json.Marshal(ipc.MessageRef{MessageID: show.MessageID})
		h.handleUserHelperMessage(assist.session, &ipc.Envelope{ID: "ack-race", Type: ipc.TypeMessageAck, Payload: raw})
	})

	res := handleNotifyUser(h, Command{ID: "cmd-race", Type: CmdNotifyUser, Payload: messagePayload("warning", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if got := h.endpointMessages.Pending(time.Now()); len(got) != 0 {
		t.Fatalf("an acked message is still pending for replay: %+v", got)
	}
	eventually(t, func() bool {
		for _, ev := range rec.snapshot() {
			if ev.EventType == "acknowledged" {
				return true
			}
		}
		return false
	}, "acknowledged event")
}

func TestHelperAlreadyResolvedSkipsNativeFallback(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	console := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, _ := newMessagingHeartbeat(t, assist.session, console.session)
	assist.setPresent(ipc.MessagePresentedAlreadyResolved, nil)

	start := time.Now()
	res := handleNotifyUser(h, Command{ID: "cmd-dup", Type: CmdNotifyUser, Payload: messagePayload("info", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("an explicit already-resolved reply must not wait for the helper timeout")
	}
	out := decodeResult(t, res.Stdout)
	if out["surface"] != "assist" || out["alreadyResolved"] != true {
		t.Fatalf("result = %v", out)
	}
	if got := console.types(); len(got) != 0 {
		t.Fatalf("console user got %v; a message the user already closed must not come back as a toast", got)
	}
	if _, ok := h.endpointMessages.Get("11111111-1111-4111-8111-111111111111"); ok {
		t.Fatal("an already-resolved message must not be stored for replay")
	}
}

func TestHelperFailedShowFallsBackToNativeImmediately(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	console := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, _ := newMessagingHeartbeat(t, assist.session, console.session)
	assist.setPresent(ipc.MessagePresentedFailed, nil)

	res := handleNotifyUser(h, Command{ID: "cmd-fail", Type: CmdNotifyUser, Payload: messagePayload("info", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if out := decodeResult(t, res.Stdout); out["surface"] != "native" {
		t.Fatalf("surface = %v, want native", out["surface"])
	}
	if got := console.types(); len(got) != 1 || got[0] != ipc.TypeNotify {
		t.Fatalf("console user got %v, want the native fallback", got)
	}
	if _, ok := h.endpointMessages.Get("11111111-1111-4111-8111-111111111111"); ok {
		t.Fatal("a card that was not shown must not be stored for replay")
	}
}
