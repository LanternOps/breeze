package prompthost

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// restartFinalPrompt is a restart.final closing card: pending, OK only. It is
// structurally a decision and not informational.
func restartFinalPrompt(t *testing.T, id string, calls *promptCalls) Prompt {
	show := loadShow(t, "show.notice.json")
	show.PromptID = id
	show.Kind = "restart.final"
	return Prompt{
		ID: id,
		Kind: KindSpec{Name: "restart.final", Version: 1, Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
			ipc.PromptStatePending: {"ok": ipc.PromptStateApproved},
		}},
		Owners:   []Owner{testOwner},
		Show:     show,
		Legacy:   calls.Legacy,
		OnAction: calls.OnAction,
		OnExpire: calls.OnExpire,
	}
}

// #12794 review: the card limiter limits notices. A prompt that needs the
// person's answer (a restart question, the closing restart card, a consent or
// elevation request) is never made list-only by it: on the native renderer a
// list-only prompt draws nothing, so the person would never be asked.
func TestCardLimiterNeverSuppressesADecision(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1", "restart.prompt@1", "restart.final@1"))
	hh.h.SetEnabledKinds([]string{"notice.info", "restart.prompt", "restart.final"})
	calls := &promptCalls{}
	for i := range 10 {
		_ = hh.h.Show(noticePrompt(t, "notice:flood:"+string(rune('a'+i)), calls))
		hh.clock.Advance(time.Second)
	}
	_ = hh.h.Show(restartPrompt(t, "restart:7", t0.Add(time.Hour), calls))
	_ = hh.h.Show(restartFinalPrompt(t, "restart_final:7", calls))
	_ = hh.h.Show(noticePrompt(t, "notice:flood:k", calls))

	got := map[string]ipc.PromptPresentation{}
	for _, s := range showsTo(hh.dir.take(), "native-1") {
		got[s.PromptID] = s.Presentation
	}
	for _, id := range []string{"restart:7", "restart_final:7"} {
		if got[id] != ipc.PromptPresentationCard {
			t.Errorf("%s after ten notices in ten minutes = %q, want card: a decision is never list-only by the limiter", id, got[id])
		}
	}
	if got["notice:flood:k"] != ipc.PromptPresentationListOnly {
		t.Errorf("the 11th notice = %q, want list_only: the limiter still limits notices", got["notice:flood:k"])
	}
}

// Decisions do not spend the notices' budget either.
func TestDecisionsDoNotSpendTheNoticeBudget(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1", "restart.prompt@1", "restart.final@1"))
	hh.h.SetEnabledKinds([]string{"notice.info", "restart.prompt", "restart.final"})
	calls := &promptCalls{}
	_ = hh.h.Show(restartPrompt(t, "restart:8", t0.Add(time.Hour), calls))
	_ = hh.h.Show(restartFinalPrompt(t, "restart_final:8", calls))
	for i := range 10 {
		_ = hh.h.Show(noticePrompt(t, "notice:budget:"+string(rune('a'+i)), calls))
	}
	shows := showsTo(hh.dir.take(), "native-1")
	if len(shows) != 12 {
		t.Fatalf("shows = %d, want 12", len(shows))
	}
	for _, s := range shows {
		if s.Presentation != ipc.PromptPresentationCard {
			t.Errorf("%s = %q: two decisions spent the notices' budget", s.PromptID, s.Presentation)
		}
	}
}
