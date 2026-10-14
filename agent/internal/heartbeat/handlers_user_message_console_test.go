package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// The Assist card is a Windows console-session surface (#8741 plan, W1 scope).
// These tests pin the three ways a card could escape that boundary: a
// non-Windows host, a stale off-console Assist helper chosen by the session
// picker, and a card left on screen after the agent gave up waiting for it.

var messagingScopes = []string{ipc.ScopeAssist, ipc.ScopeConsentUI, ipc.ScopeMessaging}

func countType(p *helperProbe, typ string) int {
	n := 0
	for _, got := range p.types() {
		if got == typ {
			n++
		}
	}
	return n
}

func TestMessageCardIsWindowsOnlyNativeToastElsewhere(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, _ := newMessagingHeartbeat(t, assist.session, user.session)
	h.sessionBroker.SetGOOSForTest("darwin")

	res := handleNotifyUser(h, Command{ID: "cmd-mac", Type: CmdNotifyUser, Payload: messagePayload("warning", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if out := decodeResult(t, res.Stdout); out["surface"] != "native" {
		t.Fatalf("result = %v, want the native surface on macOS/Linux", out)
	}
	if n := countType(assist, ipc.TypeMessageShow); n != 0 {
		t.Fatalf("assist got %d message_show on a non-Windows host, want 0", n)
	}
	if n := countType(user, ipc.TypeNotify); n != 1 {
		t.Fatalf("user got %d native toasts, want 1", n)
	}

	// Replay must not draw a card on a non-Windows host either.
	if err := h.endpointMessages.Put(testShow("m-mac", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	h.replayEndpointMessages(assist.session)
	time.Sleep(100 * time.Millisecond)
	if n := countType(assist, ipc.TypeMessageShow); n != 0 {
		t.Fatalf("replay drew %d cards on a non-Windows host", n)
	}
}

func TestMessageCardRefusesOffConsoleAssist(t *testing.T) {
	// Console is session 1; the only messaging Assist helper is a stale one in
	// session 3 (a disconnected RDS user, or the previous console user).
	stale := newHelperProbe(t, ipc.HelperRoleAssist, "bob", "3", messagingScopes)
	console := newHelperProbe(t, ipc.HelperRoleUser, "alice", "1", []string{"notify"})
	h, rec := newMessagingHeartbeat(t, stale.session, console.session)

	res := handleNotifyUser(h, Command{ID: "cmd-stale", Type: CmdNotifyUser, Payload: messagePayload("warning", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if n := countType(stale, ipc.TypeMessageShow); n != 0 {
		t.Fatalf("off-console assist got %d message_show, want 0", n)
	}
	if n := countType(console, ipc.TypeNotify); n != 1 {
		t.Fatalf("console user got %d native toasts, want 1", n)
	}

	// No replay into the off-console session.
	if err := h.endpointMessages.Put(testShow("m-stale", time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	h.replayEndpointMessages(stale.session)
	time.Sleep(100 * time.Millisecond)
	if n := countType(stale, ipc.TypeMessageShow); n != 0 {
		t.Fatalf("replay drew %d cards in an off-console session", n)
	}

	// An ack from the off-console helper is dropped: the message stays live
	// and nothing is reported for it.
	h.handleUserHelperMessage(stale.session, helperEvent(t, ipc.TypeMessageAck, ipc.MessageRef{MessageID: "m-stale"}))
	time.Sleep(100 * time.Millisecond)
	if _, ok := h.endpointMessages.Get("m-stale"); !ok {
		t.Fatal("an ack from an off-console helper must not retire the message")
	}
	if got := rec.snapshot(); len(got) != 0 {
		for _, ev := range got {
			if ev.MessageID == "m-stale" {
				t.Fatalf("off-console ack was reported: %+v", ev)
			}
		}
	}
}

func TestMessageCardPicksConsoleAssistOverNewerStaleOne(t *testing.T) {
	onConsole := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	stale := newHelperProbe(t, ipc.HelperRoleAssist, "bob", "3", messagingScopes)
	// The stale helper is the most recently seen: a naive "newest wins" picker
	// chooses it and then drops the whole device to native.
	onConsole.session.LastSeen = time.Now().Add(-time.Minute)
	stale.session.LastSeen = time.Now()
	h, _ := newMessagingHeartbeat(t, onConsole.session, stale.session)

	res := handleNotifyUser(h, Command{ID: "cmd-pick", Type: CmdNotifyUser, Payload: messagePayload("warning", time.Now().Add(time.Hour))})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if out := decodeResult(t, res.Stdout); out["surface"] != "assist" || out["username"] != "alice" {
		t.Fatalf("result = %v, want the console Assist card", out)
	}
	if n := countType(onConsole, ipc.TypeMessageShow); n != 1 {
		t.Fatalf("console assist got %d message_show, want 1", n)
	}
	if n := countType(stale, ipc.TypeMessageShow); n != 0 {
		t.Fatalf("stale assist got %d message_show, want 0", n)
	}
}

func TestMessageCardTimeoutRetractsBeforeNativeFallback(t *testing.T) {
	old := endpointMessageHelperTimeout
	endpointMessageHelperTimeout = 150 * time.Millisecond
	t.Cleanup(func() { endpointMessageHelperTimeout = old })

	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	user := newHelperProbe(t, ipc.HelperRoleUser, "alice", "2", []string{"notify"})
	// The helper draws the card but its message_presented arrives after the
	// agent stopped waiting.
	assist.setPresent("", func(ipc.MessageShow) { time.Sleep(400 * time.Millisecond) })
	h, rec := newMessagingHeartbeat(t, assist.session, user.session)

	payload := messagePayload("critical", time.Now().Add(time.Hour))
	res := handleNotifyUser(h, Command{ID: "cmd-slow", Type: CmdNotifyUser, Payload: payload})
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if out := decodeResult(t, res.Stdout); out["surface"] != "native" {
		t.Fatalf("result = %v, want native after the card timed out", out)
	}
	msgID := payload["messageId"].(string)
	if _, ok := h.endpointMessages.Get(msgID); ok {
		t.Fatal("a timed-out card must not stay in the replay store")
	}

	eventually(t, func() bool { return countType(assist, ipc.TypeMessageRetract) == 1 }, "message_retract to the slow helper")
	var retract ipc.MessageRef
	for _, env := range assist.envelopes() {
		if env.Type == ipc.TypeMessageRetract {
			if err := json.Unmarshal(env.Payload, &retract); err != nil {
				t.Fatal(err)
			}
		}
	}
	if retract.MessageID != msgID {
		t.Fatalf("retract names %q, want %q", retract.MessageID, msgID)
	}
	if n := countType(user, ipc.TypeNotify); n != 1 {
		t.Fatalf("native toast shown %d times, want once", n)
	}

	// The late message_presented is not reported as a second display.
	eventually(t, func() bool { return len(rec.snapshot()) >= 1 }, "native displayed event")
	before := len(rec.snapshot())
	h.handleUserHelperMessage(assist.session, helperEvent(t, ipc.TypeMessagePresented, ipc.MessagePresented{MessageID: msgID}))
	time.Sleep(100 * time.Millisecond)
	if got := rec.snapshot(); len(got) != before {
		t.Fatalf("late presented produced events: %+v", got[before:])
	}
}

// nativeTargetsBesideCard: with no usable Windows session id ("" / "0") the
// same signed-in identity is treated as the card's screen.
func TestNativeTargetsBesideCardWithoutWinSessionUsesIdentity(t *testing.T) {
	assist := &sessionbroker.Session{SessionID: "a", IdentityKey: "S-1-5-21-alice", WinSessionID: "0"}
	sameUser := &sessionbroker.Session{SessionID: "b", IdentityKey: "S-1-5-21-alice", WinSessionID: "0"}
	otherUser := &sessionbroker.Session{SessionID: "c", IdentityKey: "S-1-5-21-bob", WinSessionID: "0"}
	got := nativeTargetsBesideCard([]*sessionbroker.Session{sameUser, otherUser}, assist)
	if len(got) != 1 || got[0] != otherUser {
		t.Fatalf("targets = %v, want only the other user", got)
	}
}
