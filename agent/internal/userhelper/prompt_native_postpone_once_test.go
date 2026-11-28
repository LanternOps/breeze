package userhelper

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12812 item 1: one Postpone on the native restart dialog sends two
// updates: the agent refreshes the answered card with the new time, then the
// re-planned schedule's quiet lead rung refreshes it again with the same
// content. When the new schedule cannot be read back, the first update is
// an empty patch (the old time) and only the lead rung carries the new one.
// Either way the person gets exactly one notification, carrying the new time.

// postponeToNativeDialog draws the restart question and answers Postpone.
func postponeToNativeDialog(t *testing.T) (*nativePromptRenderer, *fakeNoticeOS, ipc.PromptShow) {
	t.Helper()
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	r.goAsync = func(f func()) { f() }
	show := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	fake.outcome <- nativeOutcome{ActionID: "postpone"}
	sink.waitFor(t, ipc.TypePromptAction)
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the dialog to end")
	return r, os, show
}

// rescheduled is the refresh the agent sends after a postponement to at.
func rescheduled(show ipc.PromptShow, rev uint64, at time.Time) ipc.PromptUpdate {
	token := fmt.Sprintf("{time:%d}", at.UnixMilli())
	cp := show.Copy
	cp.Consequence = "Your computer restarts at " + token + " whether or not you answer. Time left: {remaining}."
	cp.StateDetail = "2 postponements left"
	timing := show.Timing
	timing.DeadlineUnixMs = at.UnixMilli()
	actions := show.Actions
	return ipc.PromptUpdate{PromptID: show.PromptID, Rev: rev, Lease: show.Lease, Copy: &cp, Timing: &timing, Actions: &actions, DefaultActionID: show.DefaultActionID}
}

func TestNativeOnePostponeGivesOneNotification(t *testing.T) {
	newTime := time.UnixMilli(1793019600000).Add(10 * time.Minute)
	// The new restart time as the notification shows it (the renderer's own
	// clock and local time zone).
	newToken := applyNativePlaceholders(fmt.Sprintf("{time:%d}", newTime.UnixMilli()), time.Time{}, nativeNow, time.Local)

	t.Run("the card refreshed, then the quiet lead rung", func(t *testing.T) {
		r, os, show := postponeToNativeDialog(t)
		r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+1, newTime)))
		r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+2, newTime)))
		_, toasts := os.snapshot()
		if len(toasts) != 1 {
			t.Fatalf("notifications = %d after one Postpone, want 1", len(toasts))
		}
		if !strings.Contains(toasts[0].Body, newToken) {
			t.Fatalf("notification body = %q, want the new time %s", toasts[0].Body, newToken)
		}
	})

	t.Run("the schedule could not be read back: empty patch, then the lead rung", func(t *testing.T) {
		r, os, show := postponeToNativeDialog(t)
		r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: show.Rev + 1, Lease: show.Lease}))
		r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+2, newTime)))
		_, toasts := os.snapshot()
		if len(toasts) != 1 {
			t.Fatalf("notifications = %d after one Postpone, want 1", len(toasts))
		}
		if !strings.Contains(toasts[0].Body, newToken) {
			t.Fatalf("notification body = %q, want the new time %s, not the old one", toasts[0].Body, newToken)
		}
	})

	t.Run("a later update whose text really differs is still announced", func(t *testing.T) {
		r, os, show := postponeToNativeDialog(t)
		r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+1, newTime)))
		later := newTime.Add(10 * time.Minute)
		r.handle(envelopeFor(t, ipc.TypePromptUpdate, rescheduled(show, show.Rev+2, later)))
		if _, toasts := os.snapshot(); len(toasts) != 2 {
			t.Fatalf("notifications = %d, want one per distinct text", len(toasts))
		}
	})
}
