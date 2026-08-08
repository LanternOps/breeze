package websocket

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/wire"
)

// oversizeResultBody builds a `result` body that marshals past the server's
// cap, shaped like the per-file arrays that actually cause this (a snapshot
// index, a software inventory, a filesystem walk).
func oversizeResultBody(entries int) map[string]any {
	files := make([]map[string]any, 0, entries)
	for i := 0; i < entries; i++ {
		files = append(files, map[string]any{
			"sourcePath": `C:\Users\jdoe\AppData\Local\Cache\` + strings.Repeat("x", 64),
			"backupPath": "snapshot-1/C_/Users/jdoe/AppData/Local/Cache/" + strings.Repeat("y", 64),
			"checksum":   strings.Repeat("a", 64),
			"size":       4096 + i,
		})
	}
	return map[string]any{
		"id":            "job-1",
		"status":        "completed",
		"filesBackedUp": entries,
		"snapshot":      map[string]any{"id": "snapshot-1", "files": files},
	}
}

// TestBoundResultFieldDropsOversizeBodyAndKeepsTerminalStatus is the direct
// #3001 regression: an oversize `result` must cost the BODY, never the terminal
// status. Before this the whole message was refused server-side and the job was
// reaped as stalled.
func TestBoundResultFieldDropsOversizeBodyAndKeepsTerminalStatus(t *testing.T) {
	body := oversizeResultBody(4000)
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if len(encoded) <= wire.CommandResultBudget {
		t.Fatalf("fixture is only %d bytes, not over the %d budget — the test would prove nothing",
			len(encoded), wire.CommandResultBudget)
	}

	in := CommandResult{
		Type:      "command_result",
		CommandID: "cmd-3001",
		Status:    "completed",
		ExitCode:  0,
		Error:     "3 files could not be read",
		Result:    body,
	}

	out, changed := boundResultFieldForServer(in)
	if !changed {
		t.Fatal("an over-cap result body was left untouched; the server would reject the whole message")
	}
	if out.Status != "completed" || out.CommandID != "cmd-3001" || out.ExitCode != 0 {
		t.Fatalf("terminal status was not preserved: %+v", out)
	}
	if out.Error != "3 files could not be read" {
		t.Fatalf("error text was not preserved: %q", out.Error)
	}

	marker, ok := out.Result.(map[string]any)
	if !ok {
		t.Fatalf("bounded result body is %T, want the marker map", out.Result)
	}
	if marker[resultOmittedMarker] != true {
		t.Fatalf("marker key %q missing from %v", resultOmittedMarker, marker)
	}
	if marker["originalBytes"] != len(encoded) {
		t.Fatalf("marker reports originalBytes=%v, want %d", marker["originalBytes"], len(encoded))
	}
	if marker["limitBytes"] != wire.MaxCommandResultBytes {
		t.Fatalf("marker reports limitBytes=%v, want %d", marker["limitBytes"], wire.MaxCommandResultBytes)
	}

	// The point of the exercise: the bounded message is now deliverable.
	reencoded, err := json.Marshal(out.Result)
	if err != nil {
		t.Fatalf("marshal bounded body: %v", err)
	}
	if len(reencoded) > wire.CommandResultBudget {
		t.Fatalf("bounded body is still %d bytes, over the %d budget", len(reencoded), wire.CommandResultBudget)
	}
}

// TestBoundResultFieldLeavesInBudgetResultsAlone guards against the backstop
// becoming a silent data-loss path of its own: the overwhelming majority of
// command results are small and must reach the server byte-for-byte.
func TestBoundResultFieldLeavesInBudgetResultsAlone(t *testing.T) {
	for _, tc := range []struct {
		name string
		body any
	}{
		{"nil body", nil},
		{"small object", map[string]any{"filesBackedUp": 1200, "status": "completed"}},
		{"just under the budget", oversizeResultBody(1200)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.body != nil {
				encoded, err := json.Marshal(tc.body)
				if err != nil {
					t.Fatalf("marshal fixture: %v", err)
				}
				if len(encoded) > wire.CommandResultBudget {
					t.Fatalf("fixture is %d bytes, over the %d budget — it belongs in the oversize test",
						len(encoded), wire.CommandResultBudget)
				}
			}
			in := CommandResult{CommandID: "c1", Status: "completed", Result: tc.body}
			out, changed := boundResultFieldForServer(in)
			if changed {
				t.Fatal("an in-budget result body was rewritten; small results must pass through untouched")
			}
			if out.Result == nil && tc.body != nil {
				t.Fatal("result body was dropped")
			}
		})
	}
}

// TestBoundResultFieldUsesTheBudgetNotTheBareCap pins the margin.
//
// A body sitting in the band between the budget and the cap is the case where
// Go's byte count and the server's JSON.stringify re-measurement can disagree.
// Comparing against wire.MaxCommandResultBytes here would let such a body
// through on a coin-flip, which for every non-backup command type — the ones
// with no producer-side bounding at all — means the whole message is refused
// and the terminal status is lost. That is #3001 exactly.
func TestBoundResultFieldUsesTheBudgetNotTheBareCap(t *testing.T) {
	// {"p":"<padding>"} — 10 bytes of structure around the padding, sized to
	// land midway between the budget and the cap.
	target := wire.CommandResultBudget + wire.CommandResultHeadroom/2
	body := map[string]any{"p": strings.Repeat("x", target-10)}

	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if len(encoded) <= wire.CommandResultBudget || len(encoded) > wire.MaxCommandResultBytes {
		t.Fatalf("fixture is %d bytes; it must land strictly between the budget (%d) and the cap (%d)",
			len(encoded), wire.CommandResultBudget, wire.MaxCommandResultBytes)
	}

	out, changed := boundResultFieldForServer(CommandResult{
		CommandID: "c1", Status: "completed", Result: body,
	})
	if !changed {
		t.Fatalf("a %d-byte body was left in place; the backstop is comparing against the bare cap (%d) "+
			"instead of the budget (%d), and has no margin for the server's re-encoding",
			len(encoded), wire.MaxCommandResultBytes, wire.CommandResultBudget)
	}
	if out.Status != "completed" {
		t.Fatalf("terminal status lost: %+v", out)
	}
}

// TestBoundResultFieldHandlesUnmarshallableBody covers the branch where the
// body cannot be encoded at all. Marshalling it in SendResult would fail and
// the caller would return an error, losing the terminal status — the same
// outcome #3001 produced by a different route.
func TestBoundResultFieldHandlesUnmarshallableBody(t *testing.T) {
	in := CommandResult{
		CommandID: "c1",
		Status:    "completed",
		Result:    make(chan int), // channels are not JSON-encodable
	}
	out, changed := boundResultFieldForServer(in)
	if !changed {
		t.Fatal("an unmarshallable body was left in place; the whole result would fail to encode")
	}
	if out.Status != "completed" {
		t.Fatalf("terminal status lost: %+v", out)
	}
	if _, err := json.Marshal(out); err != nil {
		t.Fatalf("bounded result still cannot be marshalled: %v", err)
	}
}

// TestSendResultBoundsOversizeBodyBeforeEnqueue proves the backstop is actually
// wired into the send path, not merely present. It asserts on the bytes that
// reach resultChan, which is what writePump puts on the wire.
func TestSendResultBoundsOversizeBodyBeforeEnqueue(t *testing.T) {
	c := &Client{
		resultChan: make(chan outboundResult, 1),
		done:       make(chan struct{}),
	}

	if err := c.SendResult(CommandResult{
		Type:      "command_result",
		CommandID: "cmd-3001",
		Status:    "completed",
		Result:    oversizeResultBody(4000),
	}); err != nil {
		t.Fatalf("SendResult: %v", err)
	}

	select {
	case queued := <-c.resultChan:
		if len(queued.data) > wire.CommandResultBudget {
			t.Fatalf("enqueued frame is %d bytes, over the %d budget; the server caps `result` at %d",
				len(queued.data), wire.CommandResultBudget, wire.MaxCommandResultBytes)
		}
		var decoded struct {
			CommandID string         `json:"commandId"`
			Status    string         `json:"status"`
			Result    map[string]any `json:"result"`
		}
		if err := json.Unmarshal(queued.data, &decoded); err != nil {
			t.Fatalf("unmarshal enqueued frame: %v", err)
		}
		if decoded.Status != "completed" || decoded.CommandID != "cmd-3001" {
			t.Fatalf("terminal status lost in the enqueued frame: %+v", decoded)
		}
		if decoded.Result[resultOmittedMarker] != true {
			t.Fatalf("enqueued frame does not carry the omission marker: %v", decoded.Result)
		}
	default:
		t.Fatal("SendResult enqueued nothing")
	}
}
