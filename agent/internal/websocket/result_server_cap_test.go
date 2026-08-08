package websocket

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/wire"
)

// oversizeEntryCount is the entry count used wherever a test needs a body that
// marshals past the server's cap. Each entry encodes to roughly 340 bytes, so
// this lands near 6.8 MB against a ~4.93 MB budget — comfortably over without
// being so large it slows the suite under -race. Every test that uses it
// asserts the resulting size, so a change to either the cap or the entry shape
// fails loudly here rather than quietly making a test vacuous.
const oversizeEntryCount = 20000

// oversizeResultBody builds a `result` body of `entries` per-file records,
// shaped like the arrays that actually cause this (a snapshot index, a software
// inventory, a filesystem walk).
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
	body := oversizeResultBody(oversizeEntryCount)
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
		// Sized off the budget rather than an entry count so it stays genuinely
		// "just under" whatever the cap becomes.
		{"just under the budget", map[string]any{"p": strings.Repeat("x", wire.CommandResultBudget-1000)}},
		{"a realistic in-budget file index", oversizeResultBody(1200)},
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

// TestSendResultRecoversFromAnUnencodableBody exercises the marshal-error
// recovery through the WIRED path, which is the only path that matters.
//
// The unit test for boundResultFieldForServer's marshal-error branch passed
// while that branch was unreachable in production: SendResult marshalled the
// whole result first and returned on error, so an unencodable body still lost
// its terminal status and the test asserted a repair that never ran. A NaN in
// any nested map is enough to trigger it — encoding/json rejects non-finite
// floats — and metrics-shaped results carry floats routinely.
func TestSendResultRecoversFromAnUnencodableBody(t *testing.T) {
	c := &Client{
		resultChan: make(chan outboundResult, 1),
		done:       make(chan struct{}),
	}

	// Sanity: this really is unencodable, so the test cannot pass vacuously.
	if _, err := json.Marshal(map[string]any{"cpu": math.NaN()}); err == nil {
		t.Fatal("fixture encodes cleanly; it must fail to marshal for this test to mean anything")
	}

	if err := c.SendResult(CommandResult{
		Type:      "command_result",
		CommandID: "cmd-nan",
		Status:    "completed",
		ExitCode:  0,
		Result:    map[string]any{"samples": []any{map[string]any{"cpu": math.NaN()}}},
	}); err != nil {
		t.Fatalf("SendResult returned %v; an unencodable BODY must not cost the terminal status", err)
	}

	select {
	case queued := <-c.resultChan:
		var decoded struct {
			CommandID string         `json:"commandId"`
			Status    string         `json:"status"`
			Result    map[string]any `json:"result"`
		}
		if err := json.Unmarshal(queued.data, &decoded); err != nil {
			t.Fatalf("unmarshal enqueued frame: %v", err)
		}
		if decoded.Status != "completed" || decoded.CommandID != "cmd-nan" {
			t.Fatalf("terminal status lost: %+v", decoded)
		}
		if decoded.Result[resultOmittedMarker] != true {
			t.Fatalf("enqueued frame does not carry the omission marker: %v", decoded.Result)
		}
	default:
		t.Fatal("SendResult enqueued nothing; the terminal status was dropped")
	}
}

// TestSendResultStillErrorsWhenThereIsNoBodyToDrop pins the other side of that
// recovery: it must repair an unencodable BODY, not swallow every marshal
// failure. With no body there is nothing to drop and the caller has to hear
// about it.
func TestSendResultStillErrorsWhenThereIsNoBodyToDrop(t *testing.T) {
	// Result is nil, so boundResultFieldForServer reports nothing to drop.
	// Nothing else on CommandResult can fail to encode, so this is a
	// contract test rather than a reachable production path.
	if _, dropped := boundResultFieldForServer(CommandResult{CommandID: "c1"}); dropped {
		t.Fatal("a nil body must report nothing dropped, or the error path above would swallow real failures")
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
		Result:    oversizeResultBody(oversizeEntryCount),
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
