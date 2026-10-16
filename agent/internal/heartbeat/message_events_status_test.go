package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// A replay answered with already_resolved means the user closed the card in
// this helper process (e.g. the ack frame was lost). It must retire the
// message without a spurious "displayed" event, or it comes back after the
// next helper restart.
func TestReplayAnsweredAlreadyResolvedRetiresMessage(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, rec := newMessagingHeartbeat(t, assist.session)
	if err := h.endpointMessages.Put(testShow("m1", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessagePresented,
		ipc.MessagePresented{MessageID: "m1", Status: ipc.MessagePresentedAlreadyResolved}))
	time.Sleep(100 * time.Millisecond)

	if _, ok := h.endpointMessages.Get("m1"); ok {
		t.Fatal("an already-resolved replay must retire the stored message")
	}
	for _, ev := range rec.snapshot() {
		if ev.EventType == "displayed" {
			t.Fatalf("already-resolved replay emitted a displayed event: %+v", ev)
		}
	}
}

// A replay the helper could not draw stays stored (retried at the next auth)
// and is not reported as displayed.
func TestReplayAnsweredFailedKeepsMessageAndEmitsNothing(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, rec := newMessagingHeartbeat(t, assist.session)
	if err := h.endpointMessages.Put(testShow("m1", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessagePresented,
		ipc.MessagePresented{MessageID: "m1", Status: ipc.MessagePresentedFailed}))
	time.Sleep(100 * time.Millisecond)

	if _, ok := h.endpointMessages.Get("m1"); !ok {
		t.Fatal("a replay that failed to draw must stay stored")
	}
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("failed replay emitted events: %+v", got)
	}
}
