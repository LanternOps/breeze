package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// SEC-038 W05: what the service puts on the IPC wire for the helper's own
// fence, and what it refuses to send until the helper has been seeded.

func TestBuildHelperStartRequestCarriesGeneration(t *testing.T) {
	payload := map[string]any{
		"sessionId":       fenceSessionID,
		"startGeneration": "9007199254740993",
	}
	got := desktopStartGenerationForHelper(payload)
	if got != "9007199254740993" {
		t.Fatalf("the helper must receive the generation verbatim as a decimal string, got %q", got)
	}
}

func TestBuildHelperStartRequestOmitsMalformedGeneration(t *testing.T) {
	// A malformed generation never reaches the fence check here: the start was
	// already refused upstream. This is belt and braces — an unparseable value
	// must never be forwarded as if it were a real one.
	for _, raw := range []any{float64(7), "007", nil} {
		if got := desktopStartGenerationForHelper(map[string]any{"startGeneration": raw}); got != "" {
			t.Fatalf("startGeneration %#v must not be forwarded, got %q", raw, got)
		}
	}
}

func TestFenceSnapshotForHelperEncodesGenerationsAsStrings(t *testing.T) {
	h := newFenceHeartbeat()
	h.desktopStartFence.noteStop("tombstoned", desktopStopFenceInput{Generation: 4, HasGeneration: true})
	syncTest(&h.desktopStartFence, "live", liveSync(2))

	snap := h.desktopFenceSnapshotForHelper()
	if snap.Sessions["tombstoned"].Terminal != true {
		t.Fatalf("the tombstone must be in the snapshot: %#v", snap.Sessions["tombstoned"])
	}
	if snap.Sessions["tombstoned"].HighWater != "4" {
		t.Fatalf("high water must be a decimal string, got %q", snap.Sessions["tombstoned"].HighWater)
	}
	if _, present := snap.Sessions["live"]; !present {
		t.Fatal("a live session's high-water mark belongs in the snapshot too")
	}
}

func TestFenceSnapshotOmitsSessionsWithNothingToSay(t *testing.T) {
	var h Heartbeat
	h.desktopStartFence.noteSync("seen-only", desktopFenceSyncInput{})
	snap := h.desktopFenceSnapshotForHelper()
	if _, present := snap.Sessions["seen-only"]; present {
		t.Fatalf("a session with no high-water mark and no tombstone carries no fence knowledge: %#v", snap.Sessions)
	}
}

func TestFenceSyncMessageShape(t *testing.T) {
	var sync ipc.DesktopFenceSync
	if sync.Sessions != nil {
		t.Fatal("zero value must be empty")
	}
}
