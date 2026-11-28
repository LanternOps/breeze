package prompthost

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12828: the card limiter makes the eleventh notice in ten minutes
// list-only. The one prompt_show that does so says why (RateLimited), so a
// renderer without a notification list can still deliver it quietly. No other
// show carries the mark: not the notices the limiter let through, and not a
// replay of the limited one.
func TestCardLimiterMarksOnlyTheShowItLimited(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1"))
	calls := &promptCalls{}
	for i := range 10 {
		_ = hh.h.Show(noticePrompt(t, "notice:flood:"+string(rune('a'+i)), calls))
		hh.clock.Advance(time.Second)
	}
	_ = hh.h.Show(noticePrompt(t, "notice:flood:k", calls))

	for _, s := range showsTo(hh.dir.take(), "native-1") {
		limited := s.PromptID == "notice:flood:k"
		if limited && (s.Presentation != ipc.PromptPresentationListOnly || !s.RateLimited) {
			t.Errorf("the 11th notice = %q rateLimited=%v, want list_only and marked rate-limited", s.Presentation, s.RateLimited)
		}
		if !limited && (s.Presentation != ipc.PromptPresentationCard || s.RateLimited) {
			t.Errorf("%s = %q rateLimited=%v, want a card that is not marked", s.PromptID, s.Presentation, s.RateLimited)
		}
	}

	// The helper reconnects: the replay of the limited notice is list-only
	// and unmarked, so it is not delivered a second time.
	hh.dir.remove("native-1")
	hh.h.RendererDisconnected("native-1")
	hh.tick(assistDisconnectGrace)
	hh.dir.take()
	back := nativeRenderer("native-2", "notice.info@1")
	hh.dir.add(back)
	hh.h.RendererConnected(back)
	hh.tick(time.Second)
	for _, s := range showsTo(hh.dir.take(), "native-2") {
		if s.RateLimited {
			t.Errorf("replay of %s is marked rate-limited: a replay would deliver it again", s.PromptID)
		}
	}
}

// A decision is never limited, so it is never marked either.
func TestCardLimiterNeverMarksADecision(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1", "restart.prompt@1"))
	calls := &promptCalls{}
	for i := range 10 {
		_ = hh.h.Show(noticePrompt(t, "notice:flood:"+string(rune('a'+i)), calls))
	}
	_ = hh.h.Show(restartPrompt(t, "restart:9", t0.Add(time.Hour), calls))
	for _, s := range showsTo(hh.dir.take(), "native-1") {
		if s.PromptID == "restart:9" && (s.RateLimited || s.Presentation != ipc.PromptPresentationCard) {
			t.Fatalf("restart = %q rateLimited=%v, want an unmarked card", s.Presentation, s.RateLimited)
		}
	}
}
