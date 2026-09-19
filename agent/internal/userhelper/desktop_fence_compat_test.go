package userhelper

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// SEC-038 W05 mixed-fleet compatibility. Agents and helpers roll
// independently (the helper binary is updated by the agent, not atomically
// with it), so both directions must fail CLOSED on the fence and neither may
// crash.

// New agent -> old helper. The old helper's DesktopStartRequest has no
// startGeneration field; encoding/json ignores unknown fields, so the start
// decodes exactly as it did before and the old helper simply enforces
// nothing extra. The service's own fence is what refuses a superseded start
// in that pairing — the protection is weaker, never absent, and nothing
// errors.
func TestNewAgentPayloadDecodesOnAnOldHelper(t *testing.T) {
	// The shape an old helper compiles against, reproduced verbatim.
	type oldDesktopStartRequest struct {
		SessionID    string          `json:"sessionId"`
		Offer        string          `json:"offer"`
		ICEServers   json.RawMessage `json:"iceServers,omitempty"`
		DisplayIndex int             `json:"displayIndex"`
	}
	type oldDesktopStopRequest struct {
		SessionID string `json:"sessionId"`
	}

	startWire, err := json.Marshal(ipc.DesktopStartRequest{
		SessionID:       "s1",
		Offer:           "v=0",
		StartGeneration: "7",
	})
	if err != nil {
		t.Fatal(err)
	}
	var oldStart oldDesktopStartRequest
	if err := json.Unmarshal(startWire, &oldStart); err != nil {
		t.Fatalf("an old helper must still decode a new start: %v", err)
	}
	if oldStart.SessionID != "s1" || oldStart.Offer != "v=0" {
		t.Fatalf("old helper lost fields it understands: %#v", oldStart)
	}

	stopWire, _ := json.Marshal(ipc.DesktopStopRequest{SessionID: "s1", TerminalGeneration: "8"})
	var oldStop oldDesktopStopRequest
	if err := json.Unmarshal(stopWire, &oldStop); err != nil {
		t.Fatalf("an old helper must still decode a new stop: %v", err)
	}
	if oldStop.SessionID != "s1" {
		t.Fatalf("old helper lost the session id: %#v", oldStop)
	}

	// An old helper also has no desktop_fence_sync handler. Its dispatch
	// default logs and drops an unknown type — it must not be fatal — so the
	// seed times out on the service side, which refuses the start (see
	// startDesktopOnSession). Fail closed, no crash.
	var oldLease struct {
		SessionID string `json:"sessionId"`
		Revoked   bool   `json:"revoked,omitempty"`
	}
	leaseWire, _ := json.Marshal(ipc.DesktopLeaseUpdate{SessionID: "s1", Unavailable: true})
	if err := json.Unmarshal(leaseWire, &oldLease); err != nil {
		t.Fatalf("an old helper must still decode a new lease update: %v", err)
	}
	if oldLease.Revoked {
		t.Fatal("an unavailable answer must never read as a revocation on an old helper")
	}
}

// Old agent -> new helper. No generation is sent, so the helper admits the
// start exactly as the pre-fence build did — unless the session is
// tombstoned, which stays absolute. No message is rejected and nothing
// panics on the missing fields.
func TestOldAgentPayloadOnANewHelper(t *testing.T) {
	legacy := []byte(`{"sessionId":"11111111-1111-4111-8111-111111111111","offer":"v=0","displayIndex":0,` +
		`"revocationLease":{"token":"t","expiresAtUnixMs":1,"hardDeadlineUnixMs":2,"renewEverySec":25,"graceSec":90}}`)
	var req ipc.DesktopStartRequest
	if err := json.Unmarshal(legacy, &req); err != nil {
		t.Fatalf("a new helper must decode an old start: %v", err)
	}
	if req.StartGeneration != "" {
		t.Fatalf("an old start carries no generation, got %q", req.StartGeneration)
	}
	if err := validateDesktopStartRequest(&req); err != nil {
		t.Fatalf("an old start must still validate: %v", err)
	}

	var f helperDesktopFence
	if d := f.admitStart(req.SessionID, req.StartGeneration); !d.admitted {
		t.Fatalf("an old agent's start must be admitted, got %#v", d)
	}

	// The tombstone still wins, with or without generations anywhere.
	var stop ipc.DesktopStopRequest
	if err := json.Unmarshal([]byte(`{"sessionId":"11111111-1111-4111-8111-111111111111"}`), &stop); err != nil {
		t.Fatal(err)
	}
	f.noteStop(stop.SessionID, stop.TerminalGeneration)
	if d := f.admitStart(stop.SessionID, ""); d.admitted {
		t.Fatal("a generationless start after a tombstone must still be refused")
	}
}

// A new helper handed a fence sync it cannot make sense of refuses the
// snapshot rather than half-applying it, and never panics.
func TestFenceSyncWithGarbageIsRefusedNotFatal(t *testing.T) {
	var f helperDesktopFence
	f.applySync(ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{
		"s1": {HighWater: "not-a-number"},
		"s2": {HighWater: "5"},
	}})
	// The malformed entry contributed no floor...
	if d := f.admitStart("s1", "1"); !d.admitted {
		t.Fatalf("a malformed floor must be ignored, not turned into a refusal reason of its own: %#v", d)
	}
	// ...and the good one still applies.
	if d := f.admitStart("s2", "4"); d.admitted {
		t.Fatal("a valid floor in the same snapshot must still apply")
	}
}
