package etwlua

import (
	"context"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// The offline notice (#8928 D3) is driven by NotifyElevationSubmitFailed. It
// must fire for a LIVE submit failure only: the user is looking at the UAC
// prompt right now. A drained event is a stale prompt that is long gone.

func TestHandleEventSubmitFailedNotifiesOnce(t *testing.T) {
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "r1", Status: ElevationPending}}
	hb.failNext.Store(1)
	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	pam := &fakePamRunner{}
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatal(err)
	}

	ev := sampleEvent("CORP\\alice", `C:\Windows\System32\mmc.exe`)
	ev.SubjectSessionID = 3
	handleEvent(context.Background(), ev, limiter, hb, q, pam)

	calls := pam.SubmitFailedCalls()
	if len(calls) != 1 {
		t.Fatalf("NotifyElevationSubmitFailed calls = %d, want 1", len(calls))
	}
	if calls[0].TargetExecutablePath != ev.TargetExecutablePath || calls[0].SubjectUsername != ev.SubjectUsername ||
		calls[0].SubjectSessionID != 3 {
		t.Fatalf("notified event = %+v, want the live event", calls[0])
	}
	if got := len(pam.Calls()); got != 0 {
		t.Fatalf("RunPamFlow invoked %d times on a failed submit", got)
	}
	if n, _ := q.Len(); n != 1 {
		t.Fatalf("failed event must still be queued for retry, queue len = %d", n)
	}
}

// Without a queue (init failed) the user still learns the request did not go
// out.
func TestHandleEventSubmitFailedNotifiesWithoutQueue(t *testing.T) {
	hb := &fakeHB{}
	hb.failNext.Store(1)
	pam := &fakePamRunner{}
	handleEvent(context.Background(), sampleEvent("alice", `C:\x.exe`), ipc.NewRateLimiter(1, dedupeWindow), hb, nil, pam)
	if got := len(pam.SubmitFailedCalls()); got != 1 {
		t.Fatalf("NotifyElevationSubmitFailed calls = %d, want 1", got)
	}
}

func TestHandleEventSubmitSuccessDoesNotNotifySubmitFailed(t *testing.T) {
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "r1", Status: ElevationPending}}
	pam := &fakePamRunner{}
	handleEvent(context.Background(), sampleEvent("alice", `C:\x.exe`), ipc.NewRateLimiter(1, dedupeWindow), hb, nil, pam)
	if got := len(pam.SubmitFailedCalls()); got != 0 {
		t.Fatalf("NotifyElevationSubmitFailed calls = %d on a successful submit, want 0", got)
	}
}

// A deduped re-fire never reaches the submit, so it cannot notify either.
func TestHandleEventDedupedDoesNotNotifySubmitFailed(t *testing.T) {
	hb := &fakeHB{}
	hb.failNext.Store(5)
	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	pam := &fakePamRunner{}
	ev := sampleEvent("alice", `C:\x.exe`)
	for i := 0; i < 3; i++ {
		handleEvent(context.Background(), ev, limiter, hb, nil, pam)
	}
	if got := len(pam.SubmitFailedCalls()); got != 1 {
		t.Fatalf("NotifyElevationSubmitFailed calls = %d, want 1 (re-fires are deduped)", got)
	}
}

// Queue.Drain replays stale prompts. Neither a failed nor a successful drain
// may notify — only the original live failure did.
func TestDrainedEventDoesNotNotifySubmitFailed(t *testing.T) {
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "r1", Status: ElevationAutoApproved}}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	pam := &fakePamRunner{}
	q, err := NewQueue(qPath(t))
	if err != nil {
		t.Fatal(err)
	}

	// Live failure: one notice, event queued.
	hb.failNext.Store(1)
	handleEvent(context.Background(), sampleEvent("alice", `C:\a.exe`), limiter, hb, q, pam)
	if got := len(pam.SubmitFailedCalls()); got != 1 {
		t.Fatalf("live failure notices = %d, want 1", got)
	}

	// A periodic drain that fails again: no notice.
	hb.failNext.Store(1)
	if drained, err := q.Drain(hb); err != nil || drained != 0 {
		t.Fatalf("forced-failure drain = (%d, %v), want (0, nil)", drained, err)
	}
	if n, _ := q.Len(); n != 1 {
		t.Fatalf("failed drain must keep the event, queue len = %d", n)
	}

	// A later live success opportunistically drains the queued event: still
	// no notice for it.
	handleEvent(context.Background(), sampleEvent("alice", `C:\b.exe`), limiter, hb, q, pam)
	if n, _ := q.Len(); n != 0 {
		t.Fatalf("queue should be drained, len = %d", n)
	}
	if got := len(pam.SubmitFailedCalls()); got != 1 {
		t.Fatalf("NotifyElevationSubmitFailed calls = %d after drains, want still 1", got)
	}
}

// Interception disabled: the event is dropped before any submit, so nothing
// is shown.
func TestHandleEventDisabledDoesNotNotifySubmitFailed(t *testing.T) {
	hb := &fakeHB{}
	hb.disabled.Store(true)
	hb.failNext.Store(1)
	pam := &fakePamRunner{}
	handleEvent(context.Background(), sampleEvent("alice", `C:\x.exe`), ipc.NewRateLimiter(1, dedupeWindow), hb, nil, pam)
	hb.disabled.Store(false)
	if got := len(pam.SubmitFailedCalls()); got != 0 {
		t.Fatalf("NotifyElevationSubmitFailed calls = %d while disabled, want 0", got)
	}
}
