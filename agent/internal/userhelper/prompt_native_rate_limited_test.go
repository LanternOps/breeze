package userhelper

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12828: the agent's card limiter makes the eleventh notice in ten minutes
// list-only and marks that show rate-limited. The native renderer has no
// list, so list-only alone would show the notice nowhere. It is delivered in
// the native renderer's quietest form instead: an OS notification, never a
// window, whatever the notification state.

// rateLimitedNotice is a session-ended notice as the limiter sends it.
func rateLimitedNotice(t *testing.T, id string) ipc.PromptShow {
	t.Helper()
	show := sessionEndedShow(t, id)
	show.Presentation = ipc.PromptPresentationListOnly
	show.RateLimited = true
	return show
}

func TestNativeRateLimitedNoticeIsANotification(t *testing.T) {
	cases := []struct {
		name        string
		windows     bool
		state       uint32
		toastOK     bool
		wantVisible bool
	}{
		{name: "macOS and Linux", toastOK: true, wantVisible: true},
		{name: "Windows accepts notifications", windows: true, state: qunsAcceptsNotifications, toastOK: true, wantVisible: true},
		// A normal notice is a dialog here; a rate-limited one stays a
		// notification, which Windows keeps in the notification centre.
		{name: "Windows quiet hours", windows: true, state: qunsQuietTime, toastOK: true},
		{name: "Windows nobody present", windows: true, state: qunsNotPresent, toastOK: true},
		// A normal notice is held here; a rate-limited one is not.
		{name: "Windows full screen", windows: true, state: qunsBusy, toastOK: true},
		// A normal notice becomes a dialog when the notification fails.
		{name: "notification failed", toastOK: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			os := &fakeNoticeOS{state: tc.state, toastOK: tc.toastOK}
			fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
			r, sink := newNoticeRenderer(t, os, fake)
			if !tc.windows {
				r.noticeState = nil
			}
			show := rateLimitedNotice(t, "notice:session_ended:k")
			r.handle(envelopeFor(t, ipc.TypePromptShow, show))
			waitUntil(t, func() bool { return len(presentedFor(sink, show.PromptID)) == 1 }, "the rate-limited notice reported")
			if _, toasts := os.snapshot(); len(toasts) != 1 || toasts[0].Title != show.Copy.Title {
				t.Fatalf("toasts = %+v, want the notice as one notification", toasts)
			}
			if got := presentedFor(sink, show.PromptID)[0]; got != tc.wantVisible {
				t.Fatalf("presented visible = %v, want %v", got, tc.wantVisible)
			}
			time.Sleep(30 * time.Millisecond)
			if fake.shown() != 0 || r.activeCount() != 0 {
				t.Fatalf("dialogs %d, active %d: a rate-limited notice is never a window", fake.shown(), r.activeCount())
			}
			// It is remembered: a later update is recorded, not refused.
			cp := show.Copy
			cp.Body = "changed"
			r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: show.Rev + 1, Lease: show.Lease, Copy: &cp}))
			if n := sink.count(ipc.TypePromptClosed); n != 0 {
				t.Fatal("an update for the rate-limited notice was refused as unknown")
			}
		})
	}
}

// A replay (list-only, not marked) still draws and raises nothing: that is
// what keeps a renderer change from re-presenting every notice at once.
func TestNativeListOnlyReplayStaysSilent(t *testing.T) {
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	show := rateLimitedNotice(t, "notice:session_ended:replayed")
	show.RateLimited = false
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	time.Sleep(30 * time.Millisecond)
	if _, toasts := os.snapshot(); len(toasts) != 0 || fake.shown() != 0 || len(sink.types()) != 0 {
		t.Fatalf("a replayed list entry raised %d notifications, %d dialogs, sent %v", len(toasts), fake.shown(), sink.types())
	}
}

// The same rate-limited show delivered twice raises one notification.
func TestNativeRateLimitedNoticeIsDeliveredOnce(t *testing.T) {
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	show := rateLimitedNotice(t, "notice:session_ended:twice")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	waitUntil(t, func() bool { return len(presentedFor(sink, show.PromptID)) == 1 }, "the first delivery")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	time.Sleep(30 * time.Millisecond)
	if _, toasts := os.snapshot(); len(toasts) != 1 {
		t.Fatalf("toasts = %d, want 1", len(toasts))
	}
}

// A notice inside its last useful minute (the safe-mode reboot warning just
// before the reboot) keeps the rules #12794 gave it even when rate-limited:
// during Windows quiet hours it is a dialog, because a notification would be
// silenced and the reboot would come unwarned.
func TestNativeRateLimitedNoticeNearItsDeadlineKeepsItsDialog(t *testing.T) {
	os := &fakeNoticeOS{state: qunsQuietTime, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	warning := nativeFixture(t, "show.notice.json")
	warning.PromptID = "notice:safe_mode:limited"
	warning.Timing.DeadlineUnixMs = nativeNow.Add(30 * time.Second).UnixMilli()
	warning.ListEntry.ExpiresAtUnixMs = warning.Timing.DeadlineUnixMs
	warning.Presentation = ipc.PromptPresentationListOnly
	warning.RateLimited = true
	r.handle(envelopeFor(t, ipc.TypePromptShow, warning))
	waitUntil(t, func() bool { return fake.shown() == 1 }, "the reboot warning's dialog")
	waitUntil(t, func() bool { return anyTrue(presentedFor(sink, warning.PromptID)) }, "the warning reported visible")
}
