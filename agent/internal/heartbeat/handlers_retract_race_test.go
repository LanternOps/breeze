package heartbeat

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestRetractMessageReportsFailedWhenAssistUnreachable(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	h, _ := newMessagingHeartbeat(t, assist.session)
	if err := h.endpointMessages.Put(testShow(retractTestID, time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	// Break the transport but leave the session registered, so the handler
	// still selects it and SendNotify fails.
	_ = assist.client.Close()
	_ = assist.session.Close()

	res := handleRetractMessage(h, retractCmd(map[string]any{"messageId": retractTestID}))
	if res.Status != "failed" {
		t.Fatalf("status = %s, want failed when the assist helper cannot be reached", res.Status)
	}
	if res.Error != "could not reach the assist helper to retract the message" {
		t.Fatalf("error = %q", res.Error)
	}
	if _, ok := h.endpointMessages.Get(retractTestID); ok {
		t.Fatal("replay suppression must still happen when the take-down fails")
	}
}

func TestRetractBeforeNotifySuppressesLaterNotify(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	console := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, rec := newMessagingHeartbeat(t, assist.session, console.session)

	if res := handleRetractMessage(h, retractCmd(map[string]any{"messageId": retractTestID})); res.Status != "completed" {
		t.Fatalf("retract status = %s (%s)", res.Status, res.Error)
	}
	res := handleNotifyUser(h, Command{ID: "cmd-late", Type: CmdNotifyUser, Payload: messagePayload("warning", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("notify status = %s (%s), want completed (failed maps to failed:undelivered)", res.Status, res.Error)
	}
	out := decodeResult(t, res.Stdout)
	if out["delivered"] != false || out["retracted"] != true {
		t.Fatalf("result = %v, want delivered:false retracted:true", out)
	}
	time.Sleep(100 * time.Millisecond)
	if n := countType(assist, ipc.TypeMessageShow); n != 0 {
		t.Fatalf("tombstoned message drew %d cards", n)
	}
	if got := console.types(); len(got) != 0 {
		t.Fatalf("console got %v; tombstoned message must not toast", got)
	}
	if _, ok := h.endpointMessages.Get(retractTestID); ok {
		t.Fatal("tombstoned message must not be stored for replay")
	}
	if len(rec.snapshot()) != 0 {
		t.Fatalf("tombstoned message emitted events: %+v", rec.snapshot())
	}
}

func TestTombstonesAreBounded(t *testing.T) {
	s := newMessageStore("")
	now := time.Now()
	for i := 0; i < maxTombstones+10; i++ {
		s.Tombstone(uuid.NewString(), now)
	}
	if n := s.tombstoneCount(); n != maxTombstones {
		t.Fatalf("tombstones = %d, want cap %d", n, maxTombstones)
	}
	s.Tombstone("expiring", now)
	if !s.IsTombstoned("expiring", now) {
		t.Fatal("fresh tombstone must be visible")
	}
	if s.IsTombstoned("expiring", now.Add(tombstoneTTL+time.Second)) {
		t.Fatal("tombstone must expire after the max message lifetime")
	}
}
