package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestDesktopClipboardSummaryPayload(t *testing.T) {
	in := ipc.ClipboardSummary{
		Transfers: []ipc.ClipboardTransferCount{
			{Direction: "host_to_viewer", Type: "text", Count: 2, Bytes: 40},
			{Direction: "sideways", Type: "text", Count: 1, Bytes: 1},          // unknown direction
			{Direction: "viewer_to_host", Type: "files", Count: 1, Bytes: 1},   // unknown type
			{Direction: "viewer_to_host", Type: "image", Count: -3, Bytes: -9}, // negative
		},
		Blocked: 1,
	}
	got := desktopClipboardSummaryPayload("sess-1", in)

	if got["event"] != "clipboard_summary" || got["sessionId"] != "sess-1" {
		t.Fatalf("envelope = %v", got)
	}
	clip, ok := got["clipboard"].(ipc.ClipboardSummary)
	if !ok {
		t.Fatalf("clipboard = %T", got["clipboard"])
	}
	// The API's schema rejects the whole result on any entry it does not
	// declare, so unknown directions and types are dropped here, and
	// negatives clamped, rather than losing the summary.
	want := []ipc.ClipboardTransferCount{
		{Direction: "host_to_viewer", Type: "text", Count: 2, Bytes: 40},
		{Direction: "viewer_to_host", Type: "image", Count: 0, Bytes: 0},
	}
	if len(clip.Transfers) != len(want) || clip.Transfers[0] != want[0] || clip.Transfers[1] != want[1] || clip.Blocked != 1 {
		t.Fatalf("clipboard = %+v", clip)
	}
}

func TestDesktopClipboardSummaryPayloadCapsEntries(t *testing.T) {
	in := ipc.ClipboardSummary{}
	for i := 0; i < 20; i++ {
		in.Transfers = append(in.Transfers, ipc.ClipboardTransferCount{Direction: "host_to_viewer", Type: "text", Count: 1, Bytes: 1})
	}
	clip := desktopClipboardSummaryPayload("s", in)["clipboard"].(ipc.ClipboardSummary)
	if len(clip.Transfers) > maxClipboardSummaryEntries {
		t.Fatalf("%d entries, cap %d", len(clip.Transfers), maxClipboardSummaryEntries)
	}
}

func TestDesktopOwnerMatchesCurrentAndRecentlyEndedOwner(t *testing.T) {
	h := &Heartbeat{}
	h.rememberDesktopOwner("d1", "helperA")
	if !h.desktopOwnerMatches("d1", "helperA") || h.desktopOwnerMatches("d1", "helperB") {
		t.Fatal("current owner check is wrong")
	}

	// A session's stop forgets its owner before the helper's teardown summary
	// arrives; the summary must still be accepted from that helper, briefly.
	h.forgetDesktopOwner("d1")
	if !h.desktopOwnerMatches("d1", "helperA") {
		t.Fatal("recently ended owner was rejected")
	}
	if h.desktopOwnerMatches("d1", "helperB") {
		t.Fatal("another helper was accepted for a recently ended session")
	}
	if h.desktopOwnerMatches("never", "helperA") {
		t.Fatal("a session that was never owned was accepted")
	}
}

func TestDesktopOwnerTombstoneExpires(t *testing.T) {
	old := desktopOwnerTombstoneTTL
	desktopOwnerTombstoneTTL = 10 * time.Millisecond
	t.Cleanup(func() { desktopOwnerTombstoneTTL = old })

	h := &Heartbeat{}
	h.rememberDesktopOwner("d1", "helperA")
	h.forgetDesktopOwner("d1")
	time.Sleep(20 * time.Millisecond)
	if h.desktopOwnerMatches("d1", "helperA") {
		t.Fatal("an ended owner was still accepted after the tombstone expired")
	}
}
