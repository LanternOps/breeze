package prompthost

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestActionAfterTheDeadlineIsStaleBeforeTheTick(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	_ = hh.h.Show(restartPrompt(t, "restart:42", t0.Add(time.Minute), calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	hh.clock.Advance(time.Minute) // deadline reached; the tick has not run yet
	if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "restart_now"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("an answer at the deadline = %s; expiry and the answer must not both apply", r.Result)
	}
	if _, n, _ := calls.counts(); n != 0 {
		t.Fatal("the domain applied an answer after the deadline")
	}
}

func TestReplayKeepsAnIndicatorAnIndicator(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "remote.session@1", "restart.prompt@1"))
	hh.h.SetEnabledKinds([]string{"remote.session", "restart.prompt"})
	calls := &promptCalls{}
	_ = hh.h.Show(restartPrompt(t, "restart:1", t0.Add(time.Hour), calls))
	pill := loadShow(t, "show.notice.json")
	pill.PromptID = "session:1"
	pill.Presentation = ipc.PromptPresentationIndicator
	pill.Actions = []ipc.PromptAction{{ID: "details", Label: "Details", Role: ipc.PromptRoleNeutral}}
	pill.DefaultActionID = ""
	hh.clock.Advance(time.Second)
	if err := hh.h.Show(Prompt{ID: "session:1", Kind: KindSpec{Name: "remote.session", Version: 1}, Owners: []Owner{testOwner}, Show: pill, Legacy: calls.Legacy}); err != nil {
		t.Fatal(err)
	}
	for _, s := range showsTo(hh.dir.take(), "assist-1") {
		hh.presented("assist-1", s)
	}
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	next := assistRenderer("assist-2", "remote.session@1", "restart.prompt@1")
	hh.dir.add(next)
	hh.h.RendererConnected(next)
	hh.tick(time.Second)
	var got ipc.PromptShow
	for _, s := range showsTo(hh.dir.take(), "assist-2") {
		if s.PromptID == "session:1" {
			got = s
		}
	}
	if got.Presentation != ipc.PromptPresentationIndicator {
		t.Fatalf("indicator replayed as %q", got.Presentation)
	}
	if err := ipc.ValidatePromptShow(got); err != nil {
		t.Fatalf("replayed indicator is not a valid show: %v", err)
	}
}
