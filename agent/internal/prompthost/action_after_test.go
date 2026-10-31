package prompthost

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #10734: ActionOutcome.After runs once the action's own patch has been
// applied and sent, so an Update the domain makes from there is the last
// word, never overwritten by the action's patch.
func TestActionAfterRunsOnceThePatchIsAppliedAndSent(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	p := restartPrompt(t, "restart:42", t0.Add(time.Hour), &promptCalls{})
	var afterRuns int
	var sentBeforeAfter []ipc.PromptUpdate
	p.OnAction = func(string, Owner) (ActionOutcome, error) {
		return ActionOutcome{
			Accepted: true,
			Patch:    &Patch{Copy: &ipc.PromptCopy{Title: "From the action"}},
			After: func() {
				afterRuns++
				sentBeforeAfter = updatesTo(hh.dir.take(), "assist-1")
				if err := hh.h.Update("restart:42", Patch{Copy: &ipc.PromptCopy{Title: "From the domain"}}); err != nil {
					t.Errorf("Update from After: %v", err)
				}
			},
		}, nil
	}
	_ = hh.h.Show(p)
	show := showsTo(hh.dir.take(), "assist-1")[0]
	if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "postpone"); r.Result != ipc.PromptActionAccepted {
		t.Fatalf("postpone = %s", r.Result)
	}
	if afterRuns != 1 {
		t.Fatalf("After ran %d times, want once", afterRuns)
	}
	if len(sentBeforeAfter) != 1 || sentBeforeAfter[0].Copy == nil || sentBeforeAfter[0].Copy.Title != "From the action" {
		t.Fatalf("updates sent before After = %+v, want the action's patch already sent", sentBeforeAfter)
	}
	after := updatesTo(hh.dir.take(), "assist-1")
	if len(after) != 1 || after[0].Copy.Title != "From the domain" || after[0].Rev <= sentBeforeAfter[0].Rev {
		t.Fatalf("updates after After = %+v, want the domain's Update last at a newer rev", after)
	}
	// A duplicate of the same click gets the cached result; After never re-runs.
	if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "postpone"); r.Result != ipc.PromptActionAccepted {
		t.Fatalf("duplicate = %s", r.Result)
	}
	if afterRuns != 1 {
		t.Fatalf("After ran %d times after a duplicate click, want once", afterRuns)
	}
}

func TestActionAfterRunsWhenThePromptClosedMeanwhileButNotOnRefusal(t *testing.T) {
	for _, tc := range []struct {
		name      string
		accepted  bool
		closeIt   bool
		wantAfter int
	}{
		{"closed during the action", true, true, 1},
		{"refused by the domain", false, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
			p := restartPrompt(t, "restart:42", t0.Add(time.Hour), &promptCalls{})
			afterRuns := 0
			p.OnAction = func(string, Owner) (ActionOutcome, error) {
				if tc.closeIt {
					_ = hh.h.Close("restart:42", ipc.PromptCloseWithdrawn)
				}
				return ActionOutcome{Accepted: tc.accepted, After: func() { afterRuns++ }}, nil
			}
			_ = hh.h.Show(p)
			show := showsTo(hh.dir.take(), "assist-1")[0]
			hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "restart_now")
			if afterRuns != tc.wantAfter {
				t.Fatalf("After ran %d times, want %d", afterRuns, tc.wantAfter)
			}
		})
	}
}
