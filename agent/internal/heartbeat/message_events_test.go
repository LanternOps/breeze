package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func helperEvent(t *testing.T, typ string, payload any) *ipc.Envelope {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &ipc.Envelope{ID: "evt-" + typ, Type: typ, Payload: raw}
}

func TestMessageAckFromHelperMarksTerminalAndPostsEvent(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, rec := newMessagingHeartbeat(t, assist.session)
	if err := h.endpointMessages.Put(testShow("m1", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}

	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessageAck, ipc.MessageRef{MessageID: "m1"}))

	eventually(t, func() bool { return len(rec.snapshot()) == 1 }, "acknowledged event")
	ev := rec.snapshot()[0]
	if ev.EventType != "acknowledged" || ev.MessageID != "m1" || ev.BatchID != "batch-m1" {
		t.Fatalf("event = %+v", ev)
	}
	if ev.Session.Username != "alice" || ev.Session.WinSessionID == nil || *ev.Session.WinSessionID != 1 {
		t.Fatalf("event session = %+v, want the agent-attested helper session", ev.Session)
	}
	if _, ok := h.endpointMessages.Get("m1"); ok {
		t.Fatal("an acknowledged message must leave the replay store")
	}
}

func TestMessageDismissedMapsExpiryReason(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, rec := newMessagingHeartbeat(t, assist.session)
	for _, id := range []string{"user-closed", "timed-out"} {
		if err := h.endpointMessages.Put(testShow(id, time.Now().Add(time.Hour)), time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessageDismissed, ipc.MessageDismissed{MessageID: "user-closed", Reason: ipc.MessageDismissReasonUser}))
	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessageDismissed, ipc.MessageDismissed{MessageID: "timed-out", Reason: ipc.MessageDismissReasonExpired}))

	eventually(t, func() bool { return len(rec.snapshot()) == 2 }, "two events")
	got := map[string]string{}
	for _, ev := range rec.snapshot() {
		got[ev.MessageID] = ev.EventType
	}
	if got["user-closed"] != "dismissed" || got["timed-out"] != "expired" {
		t.Fatalf("event types = %v", got)
	}
}

func TestMessagePresentedAfterReplayPostsDisplayedButKeepsMessage(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	h, rec := newMessagingHeartbeat(t, assist.session)
	if err := h.endpointMessages.Put(testShow("m1", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessagePresented, ipc.MessageRef{MessageID: "m1"}))
	eventually(t, func() bool { return len(rec.snapshot()) == 1 }, "displayed event")
	if rec.snapshot()[0].EventType != "displayed" {
		t.Fatalf("event = %+v", rec.snapshot()[0])
	}
	if _, ok := h.endpointMessages.Get("m1"); !ok {
		t.Fatal("a displayed (not yet acked) message must stay replayable")
	}
}

// A helper can only report on messages this agent actually showed it, and a
// session without the messaging scope cannot report at all.
func TestMessageEventsForUnknownMessageOrUnscopedSessionAreDropped(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, rec := newMessagingHeartbeat(t, assist.session, user.session)
	if err := h.endpointMessages.Put(testShow("m1", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}

	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessageAck, ipc.MessageRef{MessageID: "never-sent"}))
	h.handleUserHelperMessage(user.session, helperEvent(t, ipc.TypeMessageAck, ipc.MessageRef{MessageID: "m1"}))
	h.handleUserHelperMessage(assist.session, &ipc.Envelope{ID: "bad", Type: ipc.TypeMessageAck, Payload: []byte("{")})
	time.Sleep(100 * time.Millisecond)

	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("dropped events were posted: %+v", got)
	}
	if _, ok := h.endpointMessages.Get("m1"); !ok {
		t.Fatal("an ack from an unscoped session must not retire the message")
	}
}

func TestPostMessageEventSendsAgentAuthenticatedRequest(t *testing.T) {
	type captured struct {
		path, auth string
		body       map[string]any
	}
	got := make(chan captured, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		got <- captured{path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"duplicate":false}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
	win := uint32(2)
	err := h.postMessageEvent(messageEvent{
		MessageID: "m1",
		BatchID:   "b1",
		EventType: "acknowledged",
		Session:   messageEventSession{Username: "alice", SID: "S-1-5-21-1", WinSessionID: &win},
		At:        "2026-10-13T10:00:00Z",
	})
	if err != nil {
		t.Fatalf("postMessageEvent: %v", err)
	}
	c := <-got
	if c.path != "/api/v1/agents/agent-1/message-events" {
		t.Fatalf("path = %s", c.path)
	}
	if c.auth == "" {
		t.Fatal("message events must carry the agent bearer token")
	}
	sess, _ := c.body["session"].(map[string]any)
	if c.body["eventType"] != "acknowledged" || c.body["messageId"] != "m1" || sess["username"] != "alice" || sess["winSessionId"] != float64(2) {
		t.Fatalf("body = %v", c.body)
	}
}
