package userhelper

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12794 review round 2: a notice that must be a dialog is never silently
// dropped, the Windows "nobody present" notice stays in the notification
// centre, the quiet lead after Postpone is announced, and a dialog process
// that fails at startup is never reported visible.

// presentedFor returns the visibility of every prompt_presented sent for id.
func presentedFor(s *promptSink, id string) []bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []bool
	for _, m := range s.sent {
		if p, ok := m.payload.(ipc.PromptPresented); ok && m.typ == ipc.TypePromptPresented && p.PromptID == id {
			out = append(out, p.Visible)
		}
	}
	return out
}

func (f *fakeNativeShow) promptAt(i int) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.models) {
		return ""
	}
	return f.models[i].PromptID
}

func anyTrue(v []bool) bool {
	for _, b := range v {
		if b {
			return true
		}
	}
	return false
}

// A notice that needs a dialog while a decision dialog is on screen waits
// for it and is drawn when it ends: it is reported presented but not
// visible meanwhile (so the agent does not count it as seen), and is never
// dropped.
func TestNativeBlockedNoticeDialogIsDeferredNotDropped(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil // macOS / Linux: the notification failed
	restart := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, restart))
	sink.waitFor(t, ipc.TypePromptPresented)

	notice := sessionEndedShow(t, "notice:session_ended:deferred")
	r.handle(envelopeFor(t, ipc.TypePromptShow, notice))
	waitUntil(t, func() bool { return len(presentedFor(sink, notice.PromptID)) == 1 }, "the deferred notice's presented")
	if vis := presentedFor(sink, notice.PromptID); vis[0] {
		t.Fatal("a notice waiting behind a decision was reported visible")
	}
	if n := fake.shown(); n != 1 {
		t.Fatalf("dialogs = %d: the notice was drawn over the decision", n)
	}
	if n := r.activeCount(); n != 2 {
		t.Fatalf("active = %d, want the restart and the waiting notice: the notice was dropped", n)
	}

	fake.outcome <- nativeOutcome{ActionID: "postpone"}
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the notice dialog once the decision ended")
	if got := fake.promptAt(1); got != notice.PromptID {
		t.Fatalf("second dialog = %q, want the deferred notice", got)
	}
	waitUntil(t, func() bool { return anyTrue(presentedFor(sink, notice.PromptID)) }, "the notice reported visible when drawn")
}

// The safe-mode reboot warning is a notice with a deadline: the reboot. It
// does not wait behind another dialog past its last useful moment (the
// deadline less the notice dialog's lifetime); it is drawn then even though
// another dialog is up, because an unwarned reboot is worse than two
// windows.
func TestNativeNoticeNearItsDeadlineIsNotHeldBehindADialog(t *testing.T) {
	os := &fakeNoticeOS{state: qunsQuietTime, toastOK: true} // Windows quiet hours
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	restart := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, restart))
	sink.waitFor(t, ipc.TypePromptPresented)

	warning := nativeFixture(t, "show.notice.json")
	warning.PromptID = "notice:safe_mode:1"
	warning.Timing.DeadlineUnixMs = nativeNow.Add(30 * time.Second).UnixMilli()
	r.handle(envelopeFor(t, ipc.TypePromptShow, warning))
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the reboot warning's dialog")
	if got := fake.promptAt(1); got != warning.PromptID {
		t.Fatalf("second dialog = %q, want the reboot warning", got)
	}
	waitUntil(t, func() bool { return anyTrue(presentedFor(sink, warning.PromptID)) }, "the warning reported visible")
}

// A notice withdrawn while it waits is never drawn afterwards.
func TestNativeWithdrawnDeferredNoticeIsNotDrawn(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	restart := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, restart))
	sink.waitFor(t, ipc.TypePromptPresented)
	gone := sessionEndedShow(t, "notice:session_ended:gone")
	r.handle(envelopeFor(t, ipc.TypePromptShow, gone))
	waitUntil(t, func() bool { return len(presentedFor(sink, gone.PromptID)) == 1 }, "the deferred notice's presented")
	r.handle(envelopeFor(t, ipc.TypePromptClose, ipc.PromptClose{PromptID: gone.PromptID, Rev: gone.Rev, Lease: gone.Lease, Reason: ipc.PromptCloseWithdrawn}))
	if n := r.activeCount(); n != 1 {
		t.Fatalf("active = %d after the withdrawal, want only the restart", n)
	}
	fake.outcome <- nativeOutcome{ActionID: "postpone"}
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the restart to end")
	next := sessionEndedShow(t, "notice:session_ended:next")
	r.handle(envelopeFor(t, ipc.TypePromptShow, next))
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the next notice's dialog")
	if got := fake.promptAt(1); got != next.PromptID {
		t.Fatalf("second dialog = %q: the withdrawn notice was drawn", got)
	}
}

// The pill's "End session?" confirm dialog is a decision on screen too: a
// notice dialog waits for it.
func TestNativeConfirmDialogBlocksANoticeDialog(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	sink := &promptSink{}
	pill := &fakePill{}
	r := newNativePromptRenderer([]string{"remote.session@1", "notice.info@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	r.indicatorShow, r.indicatorHide = pill.show, pill.hide
	r.noticeState, r.toast = nil, os.toast
	show := sessionShow(t, true)
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	confirm := []ipc.PromptAction{{ID: "keep_session", Label: "Keep session", Role: ipc.PromptRoleSafe}, {ID: "end_confirm", Label: "End session", Role: ipc.PromptRoleProceed}}
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: 2, Lease: show.Lease, Actions: &confirm, DefaultActionID: "keep_session"}))
	waitUntil(t, func() bool { return fake.shown() == 1 }, "the confirm dialog")

	notice := sessionEndedShow(t, "notice:session_ended:confirm")
	r.handle(envelopeFor(t, ipc.TypePromptShow, notice))
	waitUntil(t, func() bool { return len(presentedFor(sink, notice.PromptID)) >= 1 }, "the notice's presented")
	if n := fake.shown(); n != 1 {
		t.Fatalf("dialogs = %d: a notice dialog opened over the End session confirm", n)
	}
	fake.outcome <- nativeOutcome{ActionID: "keep_session"}
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the notice dialog after the confirm")
	if got := fake.promptAt(1); got != notice.PromptID {
		t.Fatalf("second dialog = %q, want the notice", got)
	}
}

// Windows, nobody present (or quiet hours): the dialog may close before the
// person is back, so the toast is raised as well and the notice stays in the
// notification centre (spec §2: "toast + FallbackDialog").
func TestNativeNobodyPresentNoticeIsAlsoAToast(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state uint32
	}{
		{"nobody present", qunsNotPresent},
		{"quiet hours", qunsQuietTime},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os := &fakeNoticeOS{state: tc.state, toastOK: true}
			fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
			r, _ := newNoticeRenderer(t, os, fake)
			r.handle(envelopeFor(t, ipc.TypePromptShow, sessionEndedShow(t, "notice:session_ended:away")))
			waitUntil(t, func() bool { return fake.shown() == 1 }, "the fallback dialog")
			if _, toasts := os.snapshot(); len(toasts) != 1 {
				t.Fatalf("toasts = %d, want the notice in the notification centre as well", len(toasts))
			}
		})
	}
}

// After Postpone the agent re-plans the answered prompt (a prompt_update with
// the new time). The native path redraws nothing, but the new time is
// announced as an OS notification, as the legacy lead rung did: never as a
// dialog.
func TestNativeQuietLeadAfterPostponeIsANotification(t *testing.T) {
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	r.goAsync = func(f func()) { f() } // the announcement is decided and sent before handle returns
	show := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	fake.outcome <- nativeOutcome{ActionID: "postpone"}
	sink.waitFor(t, ipc.TypePromptAction)
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the dialog to end")

	cp := show.Copy
	cp.Body = "Postponed. Updates are still waiting for a restart."
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: show.Rev + 1, Lease: show.Lease, Copy: &cp}))
	_, toasts := os.snapshot()
	if len(toasts) != 1 {
		t.Fatalf("notifications = %d, want the new time announced once", len(toasts))
	}
	if toasts[0].Title != show.Copy.Title {
		t.Fatalf("notification title = %q", toasts[0].Title)
	}
	if want := "Postponed. Updates are still waiting for a restart."; len(toasts[0].Body) < len(want) || toasts[0].Body[:len(want)] != want {
		t.Fatalf("notification body = %q, want the updated copy", toasts[0].Body)
	}
	if n := fake.shown(); n != 1 || r.activeCount() != 0 {
		t.Fatalf("dialogs %d, active %d: the update drew a dialog", n, r.activeCount())
	}

	// A terminal update (the agent's outcome) announces nothing.
	approved := ipc.PromptStateApproved
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: show.Rev + 2, Lease: show.Lease, State: &approved}))
	if _, toasts := os.snapshot(); len(toasts) != 1 {
		t.Fatalf("notifications = %d after a terminal update, want 1", len(toasts))
	}
}

// An update for a notice that already ended is not announced again.
func TestNativeEndedNoticeUpdateIsNotAnnounced(t *testing.T) {
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	notice := sessionEndedShow(t, "notice:session_ended:once")
	r.handle(envelopeFor(t, ipc.TypePromptShow, notice))
	sink.waitFor(t, ipc.TypePromptPresented)
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the notice to end")
	cp := notice.Copy
	cp.Body = "changed"
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: notice.PromptID, Rev: notice.Rev + 1, Lease: notice.Lease, Copy: &cp}))
	if _, toasts := os.snapshot(); len(toasts) != 1 {
		t.Fatalf("notifications = %d, want only the notice itself", len(toasts))
	}
}
