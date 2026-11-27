package prompthost

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12794: when the chosen renderer changes (Assist removed, crashed or
// replaced), the open prompts it held move to the next renderer. A move is
// not a new card: informational entries the person already saw are never
// re-presented as a burst of windows, and a prompt that needs a decision is
// still presented.

func visibleShows(shows []ipc.PromptShow) []ipc.PromptShow {
	var out []ipc.PromptShow
	for _, s := range shows {
		if s.Presentation != ipc.PromptPresentationListOnly {
			out = append(out, s)
		}
	}
	return out
}

func showIDs(shows []ipc.PromptShow) []string {
	ids := make([]string, 0, len(shows))
	for _, s := range shows {
		ids = append(ids, s.PromptID)
	}
	return ids
}

func TestAssistGoneDoesNotReplaySeenNoticesAsABurst(t *testing.T) {
	kinds := []string{"notice.info@1", "restart.prompt@1"}
	hh := newHarness(t, assistRenderer("assist-1", kinds...), nativeRenderer("user-1", kinds...))
	calls := &promptCalls{}
	// 14 session-ended notices over the afternoon (each well inside the card
	// limit when it arrived), then a pending restart.
	for i := range 14 {
		_ = hh.h.Show(noticePrompt(t, fmt.Sprintf("notice:session_ended:%02d", i), calls))
		hh.clock.Advance(2 * time.Minute)
	}
	_ = hh.h.Show(restartPrompt(t, "restart:7", hh.clock.Now().Add(time.Hour), calls))
	for _, s := range showsTo(hh.dir.take(), "assist-1") {
		hh.presented("assist-1", s)
	}

	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(assistDisconnectGrace)
	native := visibleShows(showsTo(hh.dir.take(), "user-1"))
	if len(native) != 1 || native[0].PromptID != "restart:7" {
		t.Fatalf("native renderer drew %d windows %v; want only the pending restart", len(native), showIDs(native))
	}
	if legacy, _, _ := calls.counts(); legacy != 0 {
		t.Fatalf("seen notices were re-delivered the legacy way (%d)", legacy)
	}

	// Nothing comes later either: no present-budget fallback for the notices.
	hh.presented("user-1", native[0])
	hh.tick(30 * time.Second)
	if again := visibleShows(showsTo(hh.dir.take(), "user-1")); len(again) != 0 {
		t.Fatalf("drew %d more windows after the move: %v", len(again), showIDs(again))
	}
	if legacy, _, _ := calls.counts(); legacy != 0 {
		t.Fatalf("legacy deliveries after the move = %d", legacy)
	}

	// The notices stay open and in the list: Assist coming back lists them,
	// still without a window for any of them.
	hh.dir.add(assistRenderer("assist-2", kinds...))
	hh.h.RendererConnected(assistRenderer("assist-2", kinds...))
	hh.tick(time.Second)
	replayed := showsTo(hh.dir.take(), "assist-2")
	if len(replayed) != 15 {
		t.Fatalf("replayed %d prompts into the returning Assist, want 15", len(replayed))
	}
	for _, s := range visibleShows(replayed) {
		if s.Kind == "notice.info" {
			t.Fatalf("replay restored a notice as a window: %s", s.PromptID)
		}
	}
}

// A notice that never reached the screen on the renderer that went away is
// still delivered by the next one (it was never seen).
func TestAssistGoneStillDeliversAnUnseenNotice(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"), nativeRenderer("user-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:session_ended:x", calls))
	hh.dir.take() // sent to Assist, never presented
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(assistDisconnectGrace)
	if native := visibleShows(showsTo(hh.dir.take(), "user-1")); len(native) != 1 {
		t.Fatalf("an unseen notice was not moved to the native renderer (%d)", len(native))
	}
}

// On replay, the one restored decision surface is the oldest prompt that
// needs a decision: an older informational notice never takes that slot.
func TestReplayRestoresADecisionNotANotice(t *testing.T) {
	kinds := []string{"notice.info@1", "restart.prompt@1"}
	hh := newHarness(t, assistRenderer("assist-1", kinds...), nativeRenderer("user-1", kinds...))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:session_ended:old", calls))
	hh.clock.Advance(time.Second)
	_ = hh.h.Show(restartPrompt(t, "restart:8", hh.clock.Now().Add(time.Hour), calls))
	for _, s := range showsTo(hh.dir.take(), "assist-1") {
		hh.presented("assist-1", s)
	}
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(assistDisconnectGrace)
	hh.dir.take()

	hh.dir.add(assistRenderer("assist-2", kinds...))
	hh.h.RendererConnected(assistRenderer("assist-2", kinds...))
	hh.tick(time.Second)
	surfaces := visibleShows(showsTo(hh.dir.take(), "assist-2"))
	if len(surfaces) != 1 || surfaces[0].PromptID != "restart:8" {
		t.Fatalf("restored %v; want exactly the pending restart", showIDs(surfaces))
	}
}

func (hh *harness) presentedHidden(key string, show ipc.PromptShow) {
	hh.t.Helper()
	raw, _ := json.Marshal(ipc.PromptPresented{PromptID: show.PromptID, Rev: show.Rev, Lease: show.Lease, Visible: false})
	hh.h.handleRendererMessage(key, ipc.TypePromptPresented, raw)
}

// "Seen" means on screen, or in a renderer's list (Assist). A native notice
// reported presented{visible:false} (held while the user presents, or kept
// off the screen by a restart question) was never seen: when its renderer
// goes away it is still delivered by the next path.
func TestRendererGoneDeliversANoticeTheNativeRendererNeverShowed(t *testing.T) {
	for _, tc := range []struct {
		name       string
		visible    bool
		wantLegacy int
	}{
		{"held or kept off screen", false, 1},
		{"on screen", true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHarness(t, nativeRenderer("user-1", "notice.info@1"))
			calls := &promptCalls{}
			_ = hh.h.Show(noticePrompt(t, "notice:session_ended:held", calls))
			show := showsTo(hh.dir.take(), "user-1")[0]
			if tc.visible {
				hh.presented("user-1", show)
			} else {
				hh.presentedHidden("user-1", show)
			}
			hh.dir.remove("user-1")
			hh.h.RendererDisconnected("user-1")
			hh.tick(assistDisconnectGrace)
			if legacy, _, _ := calls.counts(); legacy != tc.wantLegacy {
				t.Fatalf("legacy deliveries = %d, want %d", legacy, tc.wantLegacy)
			}
		})
	}
}

// An Assist that reported a notice presented but not visible put it in its
// notification list, where the person can find it: that counts as seen.
func TestAssistListedNoticeCountsAsSeen(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"), nativeRenderer("user-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:session_ended:listed", calls))
	hh.presentedHidden("assist-1", showsTo(hh.dir.take(), "assist-1")[0])
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(assistDisconnectGrace)
	if native := visibleShows(showsTo(hh.dir.take(), "user-1")); len(native) != 0 {
		t.Fatalf("a notice already in Assist's list was drawn again natively (%d)", len(native))
	}
}

// A notice nobody has seen yet (no renderer could take it, or it was only
// held) is not dropped by a replay: the newest unseen notice is restored,
// the others go to the list, and none takes the decision surface.
func TestReplayRestoresTheNewestUnseenNotice(t *testing.T) {
	hh := newHarness(t)
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:session_ended:first", calls))
	hh.clock.Advance(time.Second)
	_ = hh.h.Show(noticePrompt(t, "notice:session_ended:second", calls))
	hh.clock.Advance(time.Second)
	_ = hh.h.Show(restartPrompt(t, "restart:9", hh.clock.Now().Add(time.Hour), calls))
	hh.dir.take()

	native := nativeRenderer("user-1", "notice.info@1", "restart.prompt@1")
	hh.dir.add(native)
	hh.h.RendererConnected(native)
	hh.tick(time.Second)
	got := map[string]bool{}
	for _, id := range showIDs(visibleShows(showsTo(hh.dir.take(), "user-1"))) {
		got[id] = true
	}
	if len(got) != 2 || !got["restart:9"] || !got["notice:session_ended:second"] {
		t.Fatalf("replay drew %v; want the restart and only the newest unseen notice", got)
	}
}

// A seen notice stays seen after it was parked: when the person's renderer
// comes back, it is listed, not drawn.
func TestParkedSeenNoticeStaysListOnlyOnReplay(t *testing.T) {
	hh := newHarness(t, nativeRenderer("user-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:session_ended:seen", calls))
	hh.presented("user-1", showsTo(hh.dir.take(), "user-1")[0])
	hh.dir.remove("user-1")
	hh.h.RendererDisconnected("user-1")
	hh.tick(assistDisconnectGrace)
	hh.dir.take()

	back := nativeRenderer("user-2", "notice.info@1")
	hh.dir.add(back)
	hh.h.RendererConnected(back)
	hh.tick(time.Second)
	if drawn := visibleShows(showsTo(hh.dir.take(), "user-2")); len(drawn) != 0 {
		t.Fatalf("a notice the person saw was drawn again on replay: %v", showIDs(drawn))
	}
}
