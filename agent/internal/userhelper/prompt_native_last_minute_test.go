package userhelper

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12812 item 2: a notice dialog inside its last useful minute (the safe-mode
// reboot warning just before the reboot) stays up until it is answered or its
// deadline passes. A decision that arrives afterwards opens over it, as the
// newer window, and is never held back or hidden behind it; the notice is
// not taken down for it, so the warning is not lost in its last minute.

func lastMinuteWarning(t *testing.T, id string) ipc.PromptShow {
	t.Helper()
	w := nativeFixture(t, "show.notice.json")
	w.PromptID = id
	w.Timing.DeadlineUnixMs = nativeNow.Add(30 * time.Second).UnixMilli()
	w.ListEntry.ExpiresAtUnixMs = w.Timing.DeadlineUnixMs
	return w
}

func cancelledIDs(f *fakeNativeShow) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.cancelled...)
}

func TestNativeLastMinuteNoticeStaysUpForALaterDecision(t *testing.T) {
	cases := []struct {
		name string
		// redraw: the decision that arrives is an update that redraws the
		// restart question already on screen, rather than a new question.
		redraw bool
	}{
		{name: "a new question arrives"},
		{name: "the question on screen is redrawn by an update", redraw: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			os := &fakeNoticeOS{state: qunsQuietTime, toastOK: true} // Windows quiet hours: the warning is a dialog
			fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 3)}
			r, sink := newNoticeRenderer(t, os, fake)
			restart := nativeFixture(t, "show.restart.json")
			if tc.redraw {
				r.handle(envelopeFor(t, ipc.TypePromptShow, restart))
				sink.waitFor(t, ipc.TypePromptPresented)
			}
			warning := lastMinuteWarning(t, "notice:safe_mode:last")
			r.handle(envelopeFor(t, ipc.TypePromptShow, warning))
			waitUntil(t, func() bool { return anyTrue(presentedFor(sink, warning.PromptID)) }, "the warning's dialog")

			before := fake.shown()
			if tc.redraw {
				cp := restart.Copy
				cp.StateDetail = "1 postponement left"
				r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: restart.PromptID, Rev: restart.Rev + 1, Lease: restart.Lease, Copy: &cp}))
			} else {
				r.handle(envelopeFor(t, ipc.TypePromptShow, restart))
			}
			// The decision is drawn at once, after the warning: the newer window.
			waitUntil(t, func() bool { return fake.shown() == before+1 }, "the restart question")
			if got := fake.promptAt(fake.shown() - 1); got != restart.PromptID {
				t.Fatalf("newest dialog = %q, want the restart question", got)
			}
			time.Sleep(30 * time.Millisecond)
			for _, id := range cancelledIDs(fake) {
				if id == warning.PromptID {
					t.Fatal("the warning was taken down in its last minute by a later decision")
				}
			}
			if n := r.activeCount(); n != 2 {
				t.Fatalf("active = %d, want the warning and the restart question", n)
			}
		})
	}
}

// A notice dialog far from its deadline still makes way for a decision
// (#12794): only the last minute is kept.
func TestNativeNoticeDialogBeforeItsLastMinuteStillMakesWay(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	warning := lastMinuteWarning(t, "notice:safe_mode:early")
	warning.Timing.DeadlineUnixMs = nativeNow.Add(5 * time.Minute).UnixMilli()
	warning.ListEntry.ExpiresAtUnixMs = warning.Timing.DeadlineUnixMs
	r.handle(envelopeFor(t, ipc.TypePromptShow, warning))
	waitUntil(t, func() bool { return anyTrue(presentedFor(sink, warning.PromptID)) }, "the warning's dialog")
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.restart.json")))
	waitUntil(t, func() bool {
		ids := cancelledIDs(fake)
		return len(ids) == 1 && ids[0] == warning.PromptID
	}, "the warning to make way for the question")
}
