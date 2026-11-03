package heartbeat

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamdecline"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/promptkinds"
)

// #10694 review: Cancel request vs an approval already being applied, and
// the UAC prompt left after an unproven dismissal.

func TestCancelRequestRefusedWhileAnApplyIsInFlight(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	_, waiting := r.sendRequest("system-1")
	done := r.h.elevationApplyStarted(elevReq)
	if res := r.act("assist-1", waiting, promptkinds.ActionCancelRequest); res.Result == ipc.PromptActionAccepted {
		t.Fatal("Cancel request accepted while the approved launch is under way")
	}
	if refuse, _ := r.store.Check(elevReq); refuse {
		t.Fatal("a refused cancel declined the request")
	}
	done()
	r.h.notifyPamApplyOutcome(elevReq, pamlifetime.Result{State: pamlifetime.ResultVerifiedActive}, "")
	shows := rcShows(r.dir.take(), "assist-1")
	if len(shows) == 0 || shows[len(shows)-1].State != ipc.PromptStateApproved {
		t.Fatalf("the approval must still be shown: %+v", shows)
	}
}

func TestApplyAfterCancelIsRefusedByTheDeclineRecord(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	_, waiting := r.sendRequest("system-1")
	if res := r.act("assist-1", waiting, promptkinds.ActionCancelRequest); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("cancel = %s", res.Result)
	}
	done := r.h.elevationApplyStarted(elevReq) // the apply arrives just after
	defer done()
	if refuse, code := r.store.Check(elevReq); !refuse || code != pamdecline.CodeUserDeclined {
		t.Fatalf("an apply after Cancel request must be refused: %v %s", refuse, code)
	}
}

func TestCancelAfterUnprovenDismissRetriesTheUACPrompt(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	r.dismissOK = false
	_, waiting := r.sendRequest("system-1")
	r.mu.Lock()
	r.dismissOK = true
	before := len(r.dismissedInst)
	r.mu.Unlock()
	if res := r.act("assist-1", waiting, promptkinds.ActionCancelRequest); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("cancel = %s", res.Result)
	}
	r.h.elevationCancelDismissWG.Wait()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.dismissedInst) != before+1 || !strings.HasSuffix(r.dismissedInst[len(r.dismissedInst)-1], "-cancel-consent") {
		t.Fatalf("dismissals = %v, want a retry of the request's own UAC prompt after Cancel", r.dismissedInst)
	}
	if _, ok := r.h.pamPendingConsents.peek(elevReq); ok {
		t.Fatal("a proven dismissal clears the record")
	}
}

// #10734: RunPamFlow can reach its waiting card before the host has applied
// Send request's own patch (which fences the first question's renderer). The
// waiting card must survive that: still on Assist, its Cancel request live.
func TestWaitingCardSurvivesAFlowThatOutrunsTheSendRequestPatch(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	// Hold the goroutine that handed the answer over until RunPamFlow has
	// placed the waiting card: the interleaving that flaked ~1/300.
	r.h.elevationAfterSettle = func() {
		select {
		case <-r.done:
		case <-time.After(5 * time.Second):
		}
	}
	_, waiting := r.sendRequest("system-1")
	if c := rcCloses(r.dir.take(), "assist-1"); len(c) != 0 {
		t.Fatalf("the waiting card was taken down after it was shown: %+v", c)
	}
	if res := r.act("assist-1", waiting, promptkinds.ActionCancelRequest); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("cancel = %s, want Cancel request on the waiting card to work", res.Result)
	}
}

func TestCancelOutcomeAndSendRaceUnderRace(t *testing.T) {
	for i := 0; i < 50; i++ {
		r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
		_, waiting := r.sendRequest("system-1")
		var wg sync.WaitGroup
		var cancelled bool
		wg.Add(2)
		go func() {
			defer wg.Done()
			cancelled = r.act("assist-1", waiting, promptkinds.ActionCancelRequest).Result == ipc.PromptActionAccepted
		}()
		go func() {
			defer wg.Done()
			r.h.elevationOutcome(elevReq, ipc.PromptStateDenied, "", "no")
		}()
		wg.Wait()
		refuse, _ := r.store.Check(elevReq)
		if cancelled && !refuse {
			t.Fatal("an accepted cancel left the request applicable")
		}
	}
}

func TestStuckSentFlowIsWithdrawn(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	r.start()
	first := r.waitShow("system-1")
	// Answer through the host but finish the flow ourselves, as if
	// RunPamFlow had returned before elevationSendRequested.
	flow := r.h.pamElevations.get(elevReq)
	r.act("system-1", first, promptkinds.ActionSendRequest)
	r.wait()
	flow.mu.Lock()
	flow.phase = elevationSent
	flow.mu.Unlock()
	r.h.pamElevations.put(flow)
	r.h.finishElevationFlow(flow)
	if r.h.pamElevations.get(elevReq) != nil || r.host.IsOpen(flow.e.ID()) {
		t.Fatal("a flow left in Sent must be withdrawn and forgotten")
	}
}

func TestWaitingCardNotShownFallsBackToNotices(t *testing.T) {
	r := newElevRig(t, true, elevEnabled, elevAssist("assist-1"), elevSystem("system-1"))
	r.start()
	first := r.waitShow("system-1")
	flow := r.h.pamElevations.get(elevReq)
	r.act("system-1", first, promptkinds.ActionSendRequest)
	r.wait()
	// The prompt is gone (e.g. superseded just after the click): a second
	// elevationSendRequested must not leave the flow half-alive.
	_ = r.host.Close(flow.e.ID(), ipc.PromptCloseWithdrawn)
	flow.mu.Lock()
	flow.phase = elevationSent
	flow.mu.Unlock()
	r.h.pamElevations.put(flow)
	r.h.elevationSendRequested(flow)
	if r.h.pamElevations.get(elevReq) != nil {
		t.Fatal("a waiting card that could not be shown must end the flow")
	}
	r.h.notifyPamApplyOutcome(elevReq, pamlifetime.Result{State: pamlifetime.ResultVerifiedActive}, "")
	if len(r.toasts) != 1 {
		t.Fatalf("outcome must fall back to the notice: %v", r.toasts)
	}
}
