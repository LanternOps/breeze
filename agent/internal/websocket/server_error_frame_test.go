package websocket

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// serverRejectionSource is the TypeScript that BUILDS the frame this file
// parses. Relative to this package's directory.
const serverRejectionSource = "../../../apps/api/src/routes/agentWs.ts"

// canonicalRejectionFrame is the frame the server emits for a rejected
// command_result, as pinned on the other side by agentWs.rejectionFrame.test.ts.
const canonicalRejectionFrame = `{
  "type": "error",
  "code": "INVALID_MESSAGE",
  "message": "Invalid message format",
  "messageType": "command_result",
  "commandId": "cmd-7",
  "details": [{"code":"custom","path":["result"],"message":"Command result payload exceeds the 5000000-byte ` + "`result`" + ` limit"}]
}`

// TestServerErrorFrameParsesEveryAttributionField is the agent half of the
// error-frame contract.
//
// #3001's defining symptom was that the agent had NO trace of a rejected
// terminal result: the write succeeded, so every send path reported success,
// and the server's explanation was discarded on arrival. These four fields are
// the entire remedy, so each is asserted individually — a frame that parses but
// yields an empty commandId is worth almost nothing to an operator trying to
// find which job died.
func TestServerErrorFrameParsesEveryAttributionField(t *testing.T) {
	var frame struct {
		Code        string          `json:"code"`
		Message     string          `json:"message"`
		MessageType string          `json:"messageType"`
		CommandID   string          `json:"commandId"`
		Details     json.RawMessage `json:"details"`
	}
	if err := json.Unmarshal([]byte(canonicalRejectionFrame), &frame); err != nil {
		t.Fatalf("the canonical server rejection frame does not parse: %v", err)
	}

	for _, tc := range []struct{ name, got, want string }{
		{"code", frame.Code, "INVALID_MESSAGE"},
		{"messageType", frame.MessageType, "command_result"},
		{"commandId", frame.CommandID, "cmd-7"},
		{"message", frame.Message, "Invalid message format"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q — logServerErrorFrame would log this rejection unattributed",
				tc.name, tc.got, tc.want)
		}
	}
	if len(frame.Details) == 0 {
		t.Error("details did not parse; the operator loses the reason the frame was rejected")
	}

	// Does not panic and does not depend on any field being present.
	logServerErrorFrame([]byte(canonicalRejectionFrame))
	logServerErrorFrame([]byte(`{"type":"error"}`))
	logServerErrorFrame([]byte(`not json at all`))
}

// TestServerErrorFrameFieldNamesMatchTheServer pins the field names against the
// TypeScript that emits them, from this side. The Vitest twin
// (agentWs.rejectionFrame.test.ts) pins the same contract in the other
// direction; either alone can be satisfied by renaming both the emitter and its
// own test.
func TestServerErrorFrameFieldNamesMatchTheServer(t *testing.T) {
	path := filepath.Clean(serverRejectionSource)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read the server rejection builder at %s: %v", path, err)
	}
	source := string(data)

	// The keys logServerErrorFrame depends on to attribute a rejection.
	for _, field := range []string{"messageType", "commandId", "code", "details"} {
		if !strings.Contains(source, field) {
			t.Errorf("the server no longer emits %q in its rejection frame; logServerErrorFrame "+
				"would silently log an empty value for it (issue #3001)", field)
		}
	}
	if !strings.Contains(source, "buildAgentMessageRejection") {
		t.Error("buildAgentMessageRejection is gone from agentWs.ts; the frame contract this test " +
			"guards has moved and this test must be repointed")
	}
}

// TestReadPumpHandlesErrorFramesBeforeTheIDLessSkip pins the ORDERING that made
// the fix work.
//
// Server rejections carry no `id`, so before this change they fell into the
// "not a command" skip a few lines below and were discarded without a word.
// Moving the `error` branch back under that skip would restore the silence
// while every other test kept passing, so the order is asserted directly.
func TestReadPumpHandlesErrorFramesBeforeTheIDLessSkip(t *testing.T) {
	source, err := os.ReadFile("client.go")
	if err != nil {
		t.Fatalf("read client.go: %v", err)
	}
	body := string(source)

	errorBranch := strings.Index(body, `if msg.Type == "error" {`)
	if errorBranch < 0 {
		t.Fatal(`readPump no longer has an "error" branch; server rejections are being discarded again`)
	}
	idLessSkip := strings.Index(body, `if msg.ID == "" {`)
	if idLessSkip < 0 {
		t.Fatal("the id-less skip is gone; this test needs repointing")
	}
	if errorBranch > idLessSkip {
		t.Fatal(`the "error" branch now sits AFTER the id-less skip, so error frames (which carry no id) ` +
			"are swallowed before it runs — exactly the #3001 silence")
	}
}
