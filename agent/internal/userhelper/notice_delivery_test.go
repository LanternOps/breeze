package userhelper

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// W04 (#10190, plan Task 4.1): how the native user-helper delivers a
// notice.info on Windows, by SHQueryUserNotificationState. The mapper and the
// hold loop are untagged so every CI run checks them; Windows CI runs only an
// allowlisted set of user-helper tests.

func TestNoticeDeliveryForNotificationState(t *testing.T) {
	cases := []struct {
		name  string
		state uint32
		err   error
		want  noticeDelivery
	}{
		{"accepts notifications", qunsAcceptsNotifications, nil, noticeToast},
		{"quiet time (first hour after setup, Focus Assist quiet hours)", qunsQuietTime, nil, noticeDialog},
		{"not present (screen saver, locked, inactive FUS session)", qunsNotPresent, nil, noticeDialog},
		{"busy (full-screen app)", qunsBusy, nil, noticeHold},
		{"Direct3D full screen", qunsRunningD3DFullScreen, nil, noticeHold},
		{"presentation mode", qunsPresentationMode, nil, noticeHold},
		{"Windows Store app in the foreground", qunsApp, nil, noticeToast},
		{"unknown state", 42, nil, noticeDialog},
		{"zero state", 0, nil, noticeDialog},
		{"query failed", qunsAcceptsNotifications, errors.New("E_FAIL"), noticeDialog},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := noticeDeliveryFor(tc.state, tc.err); got != tc.want {
				t.Fatalf("noticeDeliveryFor(%d, %v) = %v, want %v", tc.state, tc.err, got, tc.want)
			}
		})
	}
}

// fakeNoticeOS models SHQueryUserNotificationState and the toast.
type fakeNoticeOS struct {
	mu      sync.Mutex
	state   uint32
	err     error
	polls   int
	toasts  []ipc.NotifyRequest
	toastOK bool
}

func (f *fakeNoticeOS) query() (uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.polls++
	return f.state, f.err
}

func (f *fakeNoticeOS) toast(req ipc.NotifyRequest) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.toasts = append(f.toasts, req)
	return f.toastOK
}

func (f *fakeNoticeOS) set(state uint32) {
	f.mu.Lock()
	f.state = state
	f.mu.Unlock()
}

func (f *fakeNoticeOS) snapshot() (polls int, toasts []ipc.NotifyRequest) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.polls, append([]ipc.NotifyRequest(nil), f.toasts...)
}

func newNoticeRenderer(t *testing.T, os *fakeNoticeOS, fake *fakeNativeShow) (*nativePromptRenderer, *promptSink) {
	t.Helper()
	r, sink := newTestRenderer(t, fake)
	r.noticeState = os.query
	r.toast = os.toast
	r.noticeRepoll = 10 * time.Millisecond
	return r, sink
}

func presentedVisibility(s *promptSink) []bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []bool
	for _, m := range s.sent {
		if m.typ == ipc.TypePromptPresented {
			out = append(out, m.payload.(ipc.PromptPresented).Visible)
		}
	}
	return out
}

func TestNativeNoticeHoldsDuringPresentation(t *testing.T) {
	os := &fakeNoticeOS{state: qunsPresentationMode, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	show := nativeFixture(t, "show.notice.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))

	// Held: the agent hears it was delivered but not visible (so it does not
	// fall back to the legacy toast after its present budget), and nothing
	// is drawn or toasted while the presentation runs.
	p := sink.waitFor(t, ipc.TypePromptPresented).(ipc.PromptPresented)
	if p.Visible || p.Lease != show.Lease || p.Rev != show.Rev {
		t.Fatalf("held notice presented = %+v; want visible=false on its lease", p)
	}
	waitUntil(t, func() bool { polls, _ := os.snapshot(); return polls >= 3 }, "the hold to re-poll")
	if _, toasts := os.snapshot(); len(toasts) != 0 || fake.shown() != 0 {
		t.Fatalf("drawn during a presentation: %d toasts, %d dialogs", len(toasts), fake.shown())
	}
	if r.activeCount() != 1 {
		t.Fatal("a held notice stays tracked so a prompt_close can withdraw it")
	}

	// The presentation ends: the next poll delivers it as a toast.
	os.set(qunsAcceptsNotifications)
	waitUntil(t, func() bool { _, toasts := os.snapshot(); return len(toasts) == 1 }, "the toast after the hold")
	_, toasts := os.snapshot()
	if toasts[0].Title != show.Copy.Title || toasts[0].Body != show.Copy.Body {
		t.Fatalf("toast = %+v, want the agent's copy", toasts[0])
	}
	waitUntil(t, func() bool { v := presentedVisibility(sink); return len(v) == 2 && v[1] }, "presented visible after the toast")
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the toasted notice to end")
	if fake.shown() != 0 || sink.count(ipc.TypePromptClosed) != 0 || sink.count(ipc.TypePromptAction) != 0 {
		t.Fatalf("a toasted notice drew %d dialogs and reported %v", fake.shown(), sink.types())
	}
}

func TestNativeNoticeHoldEndsWhenTheAgentClosesIt(t *testing.T) {
	os := &fakeNoticeOS{state: qunsBusy, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	show := nativeFixture(t, "show.notice.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	r.handle(envelopeFor(t, ipc.TypePromptClose, ipc.PromptClose{PromptID: show.PromptID, Rev: show.Rev, Lease: show.Lease, Reason: ipc.PromptCloseWithdrawn}))
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the hold to end")
	os.set(qunsAcceptsNotifications)
	time.Sleep(50 * time.Millisecond)
	if _, toasts := os.snapshot(); len(toasts) != 0 || fake.shown() != 0 {
		t.Fatal("a notice the agent withdrew during the hold was still delivered")
	}
}

func TestNativeNoticeHoldGivesUpAtListExpiry(t *testing.T) {
	os := &fakeNoticeOS{state: qunsRunningD3DFullScreen, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	clock := nativeNow
	var mu sync.Mutex
	r.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	show := nativeFixture(t, "show.notice.json")
	show.ListEntry.ExpiresAtUnixMs = nativeNow.Add(time.Minute).UnixMilli()
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	mu.Lock()
	clock = nativeNow.Add(2 * time.Minute)
	mu.Unlock()
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the hold to give up at expiry")
	os.set(qunsAcceptsNotifications)
	time.Sleep(50 * time.Millisecond)
	if _, toasts := os.snapshot(); len(toasts) != 0 || fake.shown() != 0 {
		t.Fatal("an expired notice was delivered after its hold")
	}
}

func TestNativeNoticeQuietTimeDrawsTheDialog(t *testing.T) {
	os := &fakeNoticeOS{state: qunsQuietTime, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	show := nativeFixture(t, "show.notice.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	if p := sink.waitFor(t, ipc.TypePromptPresented).(ipc.PromptPresented); !p.Visible {
		t.Fatal("the dialog is presented visible")
	}
	if fake.shown() != 1 {
		t.Fatalf("quiet time must draw the dialog, drew %d", fake.shown())
	}
	if _, toasts := os.snapshot(); len(toasts) != 0 {
		t.Fatal("quiet time suppresses toasts; none may be sent")
	}
	fake.outcome <- nativeOutcome{ActionID: "ok"}
	if a := sink.waitFor(t, ipc.TypePromptAction).(ipc.PromptActionRequest); a.ActionID != "ok" {
		t.Fatalf("action = %+v", a)
	}
}

func TestNativeNoticeToastFailureFallsBackToTheDialog(t *testing.T) {
	os := &fakeNoticeOS{state: qunsAcceptsNotifications, toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.notice.json")))
	sink.waitFor(t, ipc.TypePromptPresented)
	if _, toasts := os.snapshot(); len(toasts) != 1 || fake.shown() != 1 {
		t.Fatalf("toasts %d, dialogs %d: a toast that failed falls back to the dialog", len(toasts), fake.shown())
	}
}

func TestNativeNoticeStateAppliesOnlyToNotices(t *testing.T) {
	os := &fakeNoticeOS{state: qunsPresentationMode, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.restart.json")))
	if p := sink.waitFor(t, ipc.TypePromptPresented).(ipc.PromptPresented); !p.Visible {
		t.Fatal("a restart decision is drawn as before")
	}
	if polls, _ := os.snapshot(); polls != 0 || fake.shown() != 1 {
		t.Fatalf("polls %d, dialogs %d: only notice.info consults the notification state", polls, fake.shown())
	}
}

func TestNativeNoticeWithoutANotificationStateDrawsTheDialog(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newTestRenderer(t, fake)
	r.noticeState = nil // macOS, Linux: no equivalent query (spec §3.2)
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.notice.json")))
	sink.waitFor(t, ipc.TypePromptPresented)
	if fake.shown() != 1 {
		t.Fatal("without a notification state the notice is the native dialog")
	}
}
