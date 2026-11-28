package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12812 item 3: on Windows a notice held while the person is full screen,
// which then has to be a dialog (quiet hours) while another dialog is up and
// so waits, tells the agent prompt_presented{visible:false} once, not once for
// the hold and again for the wait.
func TestNativeHeldThenWaitingNoticeReportsNotVisibleOnce(t *testing.T) {
	os := &fakeNoticeOS{state: qunsBusy, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	restart := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, restart))
	sink.waitFor(t, ipc.TypePromptPresented)

	notice := sessionEndedShow(t, "notice:session_ended:held")
	r.handle(envelopeFor(t, ipc.TypePromptShow, notice))
	waitUntil(t, func() bool { return len(presentedFor(sink, notice.PromptID)) == 1 }, "the hold reported")
	waitUntil(t, func() bool { polls, _ := os.snapshot(); return polls >= 2 }, "the hold to re-poll")

	// Full screen ends into quiet hours: the notice must be a dialog, and the
	// restart question is on screen, so it waits.
	os.set(qunsQuietTime)
	waitUntil(t, func() bool { _, toasts := os.snapshot(); return len(toasts) == 1 }, "the toast raised alongside the dialog")
	fake.outcome <- nativeOutcome{ActionID: "postpone"}
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the notice's dialog once the question ends")

	got := presentedFor(sink, notice.PromptID)
	notVisible := 0
	for _, v := range got {
		if !v {
			notVisible++
		}
	}
	if notVisible != 1 {
		t.Fatalf("presented for the notice = %v: visible:false sent %d times, want once", got, notVisible)
	}
	waitUntil(t, func() bool { return anyTrue(presentedFor(sink, notice.PromptID)) }, "the notice reported visible when drawn")
}
