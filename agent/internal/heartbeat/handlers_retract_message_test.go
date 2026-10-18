package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const retractTestID = "11111111-1111-4111-8111-111111111111"

func retractCmd(payload map[string]any) Command {
	return Command{ID: "cmd-retract", Type: CmdRetractMessage, Payload: payload}
}

func TestRetractMessageMarksStoredTerminalAndRetractsCard(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	h, _ := newMessagingHeartbeat(t, assist.session)
	if err := h.endpointMessages.Put(testShow(retractTestID, time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}

	res := handleRetractMessage(h, retractCmd(map[string]any{"messageId": retractTestID}))
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	out := decodeResult(t, res.Stdout)
	if out["retracted"] != true || out["wasPending"] != true {
		t.Fatalf("result = %v, want retracted:true wasPending:true", out)
	}
	if _, ok := h.endpointMessages.Get(retractTestID); ok {
		t.Fatal("a retracted message must leave the replay store")
	}
	eventually(t, func() bool { return countType(assist, ipc.TypeMessageRetract) == 1 }, "message_retract to the console assist helper")
	for _, env := range assist.envelopes() {
		if env.Type != ipc.TypeMessageRetract {
			continue
		}
		var ref ipc.MessageRef
		if err := json.Unmarshal(env.Payload, &ref); err != nil || ref.MessageID != retractTestID {
			t.Fatalf("retract payload = %s (err %v), want messageId %s", env.Payload, err, retractTestID)
		}
	}
}

func TestRetractMessageUnknownIDIsIdempotentSuccess(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	h, _ := newMessagingHeartbeat(t, assist.session)

	for i := 0; i < 2; i++ {
		res := handleRetractMessage(h, retractCmd(map[string]any{"messageId": retractTestID}))
		if res.Status != "completed" {
			t.Fatalf("call %d status = %s (%s)", i, res.Status, res.Error)
		}
		out := decodeResult(t, res.Stdout)
		if out["retracted"] != false || out["reason"] != "unknown_or_terminal" {
			t.Fatalf("call %d result = %v, want retracted:false reason:unknown_or_terminal", i, out)
		}
	}
}

func TestRetractMessageSucceedsWithoutAnyHelper(t *testing.T) {
	h, _ := newMessagingHeartbeat(t)
	if err := h.endpointMessages.Put(testShow(retractTestID, time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	res := handleRetractMessage(h, retractCmd(map[string]any{"messageId": retractTestID}))
	if res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	if out := decodeResult(t, res.Stdout); out["retracted"] != true || out["wasPending"] != true {
		t.Fatalf("result = %v", out)
	}
	if _, ok := h.endpointMessages.Get(retractTestID); ok {
		t.Fatal("message must be terminal even with no helper to tell")
	}
}

func TestRetractedMessageIsNotReplayedAfterHelperReauth(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	h, _ := newMessagingHeartbeat(t, assist.session)
	if err := h.endpointMessages.Put(testShow(retractTestID, time.Now().Add(time.Hour)), time.Now()); err != nil {
		t.Fatal(err)
	}
	if res := handleRetractMessage(h, retractCmd(map[string]any{"messageId": retractTestID})); res.Status != "completed" {
		t.Fatalf("status = %s (%s)", res.Status, res.Error)
	}
	// A restarted helper authenticates; the agent replays what it still holds.
	h.replayEndpointMessages(assist.session)
	time.Sleep(150 * time.Millisecond)
	if n := countType(assist, ipc.TypeMessageShow); n != 0 {
		t.Fatalf("retracted message replayed %d times after re-auth, want 0", n)
	}
}

func TestRetractMessageRejectsInvalidMessageID(t *testing.T) {
	assist := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", messagingScopes)
	h, _ := newMessagingHeartbeat(t, assist.session)
	for _, p := range []map[string]any{
		nil,
		{},
		{"messageId": ""},
		{"messageId": "not-a-uuid"},
		{"messageId": "../../etc/passwd"},
		{"messageId": 42},
	} {
		res := handleRetractMessage(h, retractCmd(p))
		if res.Status != "failed" {
			t.Fatalf("payload %v: status = %s, want failed", p, res.Status)
		}
		if !strings.Contains(res.Error, "messageId") {
			t.Fatalf("payload %v: error %q should name messageId", p, res.Error)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if n := countType(assist, ipc.TypeMessageRetract); n != 0 {
		t.Fatalf("invalid retract sent %d IPCs", n)
	}
}
