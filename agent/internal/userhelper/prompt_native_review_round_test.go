package userhelper

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Review round of #12828 / #12812.

// An announcement whose notification failed was not an announcement: the
// next update with the same text tries again, so the new restart time is not
// lost to one failed notification.
func TestNativeFailedAnnouncementIsTriedAgain(t *testing.T) {
	newTime := time.UnixMilli(1793019600000).Add(10 * time.Minute)
	r, os, show := postponeToNativeDialog(t)
	os.mu.Lock()
	os.toastOK = false
	os.mu.Unlock()
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+1, newTime)))
	os.mu.Lock()
	os.toastOK = true
	os.mu.Unlock()
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+2, newTime)))
	if _, toasts := os.snapshot(); len(toasts) != 2 {
		t.Fatalf("notification attempts = %d, want the failed one tried again", len(toasts))
	}
	// Once it got through, a repeat stays quiet.
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+3, newTime)))
	if _, toasts := os.snapshot(); len(toasts) != 2 {
		t.Fatalf("notification attempts = %d after a repeat, want 2", len(toasts))
	}
}

// A notice past its deadline is no longer kept up: a question takes it down.
func TestNativeNoticePastItsDeadlineMakesWay(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	warning := lastMinuteWarning(t, "notice:safe_mode:past")
	warning.Timing.DeadlineUnixMs = nativeNow.Add(-10 * time.Second).UnixMilli()
	warning.ListEntry.ExpiresAtUnixMs = warning.Timing.DeadlineUnixMs
	r.handle(envelopeFor(t, ipc.TypePromptShow, warning))
	waitUntil(t, func() bool { return anyTrue(presentedFor(sink, warning.PromptID)) }, "the warning's dialog")
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.restart.json")))
	waitUntil(t, func() bool {
		ids := cancelledIDs(fake)
		return len(ids) == 1 && ids[0] == warning.PromptID
	}, "the warning past its deadline to make way for the question")
}

// The session pill's "End session?" confirm is a decision too: it opens over
// a notice in its last minute and does not take it down.
func TestNativeLastMinuteNoticeStaysUpForTheEndSessionConfirm(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	sink := &promptSink{}
	pill := &fakePill{}
	r := newNativePromptRenderer([]string{"remote.session@1", "notice.info@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	r.indicatorShow, r.indicatorHide = pill.show, pill.hide
	r.noticeState, r.toast = nil, os.toast
	session := sessionShow(t, true)
	r.handle(envelopeFor(t, ipc.TypePromptShow, session))
	sink.waitFor(t, ipc.TypePromptPresented)

	warning := lastMinuteWarning(t, "notice:safe_mode:pill")
	r.handle(envelopeFor(t, ipc.TypePromptShow, warning))
	waitUntil(t, func() bool { return fake.shown() == 1 }, "the warning's dialog")

	confirm := []ipc.PromptAction{{ID: "keep_session", Label: "Keep session", Role: ipc.PromptRoleSafe}, {ID: "end_confirm", Label: "End session", Role: ipc.PromptRoleProceed}}
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: session.PromptID, Rev: 2, Lease: session.Lease, Actions: &confirm, DefaultActionID: "keep_session"}))
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the confirm dialog")
	if got := fake.promptAt(1); got != session.PromptID {
		t.Fatalf("newest dialog = %q, want the End session confirm", got)
	}
	time.Sleep(30 * time.Millisecond)
	for _, id := range cancelledIDs(fake) {
		if id == warning.PromptID {
			t.Fatal("the End session confirm took the warning down in its last minute")
		}
	}
}

// Just before its last minute a rate-limited notice is still only a
// notification.
func TestNativeRateLimitedNoticeJustBeforeItsLastMinuteIsANotification(t *testing.T) {
	os := &fakeNoticeOS{state: qunsQuietTime, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.goAsync = func(f func()) { f() }
	warning := lastMinuteWarning(t, "notice:safe_mode:early_limited")
	warning.Timing.DeadlineUnixMs = nativeNow.Add(nativeNoticeDialogLifetime + time.Second).UnixMilli()
	warning.ListEntry.ExpiresAtUnixMs = warning.Timing.DeadlineUnixMs
	warning.Presentation = ipc.PromptPresentationListOnly
	warning.RateLimited = true
	r.handle(envelopeFor(t, ipc.TypePromptShow, warning))
	if _, toasts := os.snapshot(); len(toasts) != 1 || fake.shown() != 0 || len(presentedFor(sink, warning.PromptID)) != 1 {
		t.Fatalf("toasts %d, dialogs %d: want one notification and no dialog", len(toasts), fake.shown())
	}
}
