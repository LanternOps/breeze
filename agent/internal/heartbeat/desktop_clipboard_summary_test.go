package heartbeat

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
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

func TestDesktopClipboardSummaryPayloadClampsToAPIBounds(t *testing.T) {
	// The API rejects the whole summary on any counter over its bounds, so a
	// technician spamming blocked frames could otherwise erase their own audit
	// row. Saturate instead.
	in := ipc.ClipboardSummary{
		Transfers: []ipc.ClipboardTransferCount{{Direction: "viewer_to_host", Type: "text", Count: 2_000_000, Bytes: 1 << 50}},
		Blocked:   5_000_000,
	}
	clip := desktopClipboardSummaryPayload("s", in)["clipboard"].(ipc.ClipboardSummary)
	if clip.Blocked != maxClipboardSummaryCount || clip.Transfers[0].Count != maxClipboardSummaryCount || clip.Transfers[0].Bytes != maxClipboardSummaryBytes {
		t.Fatalf("clipboard = %+v", clip)
	}
}

func TestForgetDesktopOwnerSweepsExpiredTombstones(t *testing.T) {
	old := desktopOwnerTombstoneTTL
	desktopOwnerTombstoneTTL = 10 * time.Millisecond
	t.Cleanup(func() { desktopOwnerTombstoneTTL = old })

	h := &Heartbeat{}
	h.rememberDesktopOwner("d1", "helperA")
	h.forgetDesktopOwner("d1")
	time.Sleep(20 * time.Millisecond)
	h.rememberDesktopOwner("d2", "helperA")
	h.forgetDesktopOwner("d2")

	if _, ok := h.endedDesktopOwners.Load("d1"); ok {
		t.Fatal("an expired tombstone was never swept")
	}
}

func TestRememberDesktopOwnerClearsTombstone(t *testing.T) {
	h := &Heartbeat{}
	h.rememberDesktopOwner("d1", "helperA")
	h.forgetDesktopOwner("d1")
	h.rememberDesktopOwner("d1", "helperB")
	if _, ok := h.endedDesktopOwners.Load("d1"); ok {
		t.Fatal("a re-owned session kept its old tombstone")
	}
}

func TestHandleUserHelperMessageForwardsClipboardSummary(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	owner := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-owner", []string{"desktop"})
	other := sessionbroker.NewSession(serverIPC, 1001, "1001", "bob", "quartz", "helper-other", []string{"desktop"})
	t.Cleanup(func() { _ = clientConn.Close() })

	var mu sync.Mutex
	forwarded := map[string]int{}
	old := forwardDesktopClipboardSummary
	forwardDesktopClipboardSummary = func(_ *Heartbeat, sessionID string, _ ipc.ClipboardSummary) {
		mu.Lock()
		defer mu.Unlock()
		forwarded[sessionID]++
	}
	t.Cleanup(func() { forwardDesktopClipboardSummary = old })

	send := func(h *Heartbeat, from *sessionbroker.Session, sessionID string) {
		payload, _ := json.Marshal(ipc.DesktopClipboardSummaryNotice{SessionID: sessionID, Clipboard: ipc.ClipboardSummary{Blocked: 1}})
		h.handleUserHelperMessage(from, &ipc.Envelope{ID: "n", Type: ipc.TypeDesktopClipboardSummary, Payload: payload})
	}

	h := &Heartbeat{isHeadless: true}
	h.rememberDesktopOwner("desk-live", owner.SessionID)
	h.rememberDesktopOwner("desk-ended", owner.SessionID)
	h.forgetDesktopOwner("desk-ended")

	send(h, owner, "desk-live")
	send(h, owner, "desk-ended")
	send(h, other, "desk-live")
	send(h, owner, "bad id!")
	send(h, owner, "desk-ended") // the tombstone is consumed by the first report

	// Forwarding is asynchronous; give it a moment, then compare.
	deadline := time.Now().Add(time.Second)
	for {
		mu.Lock()
		n := forwarded["desk-live"] + forwarded["desk-ended"]
		mu.Unlock()
		if n >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond) // catch any extra, wrongly accepted report
	mu.Lock()
	defer mu.Unlock()
	if len(forwarded) != 2 || forwarded["desk-live"] != 1 || forwarded["desk-ended"] != 1 {
		t.Fatalf("forwarded = %v, want desk-live and desk-ended once each", forwarded)
	}
}
