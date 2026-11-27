package userhelper

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12794: a device without Breeze Assist draws prompts with the native
// renderer. It must not be worse off than with the prompt kinds off.

// An answered (or timed-out) native dialog is not redrawn by an update that
// needs no new decision: Postpone is counted once and the question does not
// come back until the next rung re-shows it (a full prompt_show). This is
// the rule the Assist card follows (promptkinds/restart.go decide: the card
// the person just answered collapses rather than re-opening, #4941).
func TestNativeAnsweredPromptIsNotRedrawnByAnUpdate(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fixture string
		outcome nativeOutcome
	}{
		{"restart postponed", "show.restart.json", nativeOutcome{ActionID: "postpone"}},
		{"restart dialog gave up", "show.restart.json", nativeOutcome{TimedOut: true}},
		{"notice acknowledged", "show.notice.json", nativeOutcome{ActionID: "ok"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
			r, sink := newTestRenderer(t, fake)
			show := nativeFixture(t, tc.fixture)
			r.handle(envelopeFor(t, ipc.TypePromptShow, show))
			sink.waitFor(t, ipc.TypePromptPresented)
			fake.outcome <- tc.outcome
			waitUntil(t, func() bool { return r.activeCount() == 0 }, "the dialog to end")

			// The agent re-planned (new label, new budget): still pending.
			actions := append([]ipc.PromptAction(nil), show.Actions...)
			actions[0].Label = actions[0].Label + " (2)"
			r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: show.Rev + 1, Lease: show.Lease, Actions: &actions, DefaultActionID: show.DefaultActionID}))
			// draw registers the window before handle returns: nothing may be
			// active now (deterministic; the sleep below also gives a racing
			// draw goroutine time to show itself).
			if r.activeCount() != 0 {
				t.Fatal("an update registered a new window for a dialog that already ended")
			}
			time.Sleep(40 * time.Millisecond)
			if n := fake.shown(); n != 1 {
				t.Fatalf("an update redrew a dialog that already ended: %d dialogs, want 1", n)
			}
			if n := sink.count(ipc.TypePromptClosed); n != 0 {
				t.Fatalf("the update was answered prompt_closed (%d): the agent would reroute an answered prompt", n)
			}

			// The next rung re-shows it (a full prompt_show at a newer rev):
			// that is a new decision point, and it is drawn.
			next := show
			next.Rev = show.Rev + 2
			r.handle(envelopeFor(t, ipc.TypePromptShow, next))
			waitUntil(t, func() bool { return fake.shown() == 2 }, "the next rung")
		})
	}
}

// An update for a dialog still on screen redraws it (a native dialog cannot
// change in place): the person has not answered, so the new content is the
// question they are answering.
func TestNativeOpenDialogIsRedrawnByAnUpdate(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newTestRenderer(t, fake)
	show := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	actions := append([]ipc.PromptAction(nil), show.Actions...)
	actions[0].Label = "Postpone until 16:00"
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: show.Rev + 1, Lease: show.Lease, Actions: &actions, DefaultActionID: show.DefaultActionID}))
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the redraw of the open dialog")
	if r.activeCount() != 1 {
		t.Fatalf("one window per prompt, got %d", r.activeCount())
	}
}

// sessionEndedShow is a remote-session-ended notice as the agent builds it:
// a 24 h deadline and list expiry (the Assist list lifetime).
func sessionEndedShow(t *testing.T, id string) ipc.PromptShow {
	t.Helper()
	show := nativeFixture(t, "show.notice.json")
	show.PromptID = id
	show.Timing.DeadlineUnixMs = nativeNow.Add(24 * time.Hour).UnixMilli()
	show.ListEntry.ExpiresAtUnixMs = show.Timing.DeadlineUnixMs
	return show
}

// macOS and Linux have no notification-state query: an informational notice
// is the OS notification, as it is with the kinds off — never a dialog that
// blocks the screen.
func TestNativeNoticeWithoutANotificationStateIsANotification(t *testing.T) {
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil // macOS, Linux
	r.handle(envelopeFor(t, ipc.TypePromptShow, sessionEndedShow(t, "notice:session_ended:a")))
	if p := sink.waitFor(t, ipc.TypePromptPresented).(ipc.PromptPresented); !p.Visible {
		t.Fatal("a delivered notification is presented visible")
	}
	if _, toasts := os.snapshot(); len(toasts) != 1 {
		t.Fatalf("toasts = %d, want the notice as one notification", len(toasts))
	}
	if fake.shown() != 0 {
		t.Fatalf("drew %d dialogs for an informational notice; want none", fake.shown())
	}
}

// When the notice must be a dialog (the notification failed, or Windows
// quiet hours), it is short-lived: the 24 h list lifetime is never a
// dialog's lifetime.
func TestNativeNoticeDialogIsShortLived(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state uint32 // 0: no notification-state query (macOS, Linux)
		toast bool
	}{
		{"macOS/Linux notification failed", 0, false},
		{"Windows quiet hours", qunsQuietTime, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os := &fakeNoticeOS{toastOK: tc.toast}
			fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
			r, sink := newNoticeRenderer(t, os, fake)
			if tc.state == 0 {
				r.noticeState = nil
			} else {
				os.state = tc.state
			}
			r.handle(envelopeFor(t, ipc.TypePromptShow, sessionEndedShow(t, "notice:session_ended:b")))
			sink.waitFor(t, ipc.TypePromptPresented)
			if fake.shown() != 1 {
				t.Fatalf("dialogs = %d, want the fallback dialog", fake.shown())
			}
			fake.mu.Lock()
			m := fake.models[0]
			fake.mu.Unlock()
			if got := nativeTimeout(m, nativeNow); got <= 0 || got > nativeNoticeDialogLifetime {
				t.Fatalf("notice dialog stays up %s; want at most %s", got, nativeNoticeDialogLifetime)
			}
			if script := nativePromptOsascript(m, nativeNow); !strings.Contains(script, "giving up after 60") {
				t.Fatalf("osascript = %s", script)
			}
		})
	}
}

// A notice never covers or stacks over a dialog that needs a decision, and
// notice dialogs never stack on each other: a notice that must wait is
// reported presented but not visible, and is drawn when the screen clears
// (#12794 review: deferred, never dropped).
func TestNativeNoticeDialogNeverStacks(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 4)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	restart := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, restart))
	sink.waitFor(t, ipc.TypePromptPresented)

	c := sessionEndedShow(t, "notice:session_ended:c")
	r.handle(envelopeFor(t, ipc.TypePromptShow, c))
	waitUntil(t, func() bool { return len(presentedFor(sink, c.PromptID)) == 1 }, "the notice's presented")
	if fake.shown() != 1 {
		t.Fatalf("a notice dialog was drawn over the restart question (%d dialogs)", fake.shown())
	}
	if vis := presentedFor(sink, c.PromptID); vis[0] {
		t.Fatal("a notice not drawn yet was reported visible")
	}

	// The restart is answered: the waiting notice is drawn, and only it.
	fake.outcome <- nativeOutcome{ActionID: "postpone"}
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the waiting notice's dialog")
	if got := fake.promptAt(1); got != c.PromptID {
		t.Fatalf("second dialog = %q, want the waiting notice", got)
	}
	d := sessionEndedShow(t, "notice:session_ended:d")
	r.handle(envelopeFor(t, ipc.TypePromptShow, d))
	waitUntil(t, func() bool { return len(presentedFor(sink, d.PromptID)) == 1 }, "the second notice's presented")
	if vis := presentedFor(sink, d.PromptID); vis[0] || fake.shown() != 2 {
		t.Fatalf("visible %v, dialogs %d: notice dialogs stacked", vis, fake.shown())
	}
	// The first notice is acknowledged: the second one follows.
	fake.outcome <- nativeOutcome{ActionID: "ok"}
	waitUntil(t, func() bool { return fake.shown() == 3 }, "the second notice's dialog")
	if got := fake.promptAt(2); got != d.PromptID {
		t.Fatalf("third dialog = %q, want the second notice", got)
	}
}

// A question that needs a decision takes a notice dialog down instead of
// opening over or under it. Nothing is reported for the notice (it stays in
// the agent's list), and a later update for it is not refused as unknown.
func TestNativeDecisionTakesANoticeDialogDown(t *testing.T) {
	os := &fakeNoticeOS{toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	notice := sessionEndedShow(t, "notice:session_ended:f")
	r.handle(envelopeFor(t, ipc.TypePromptShow, notice))
	sink.waitFor(t, ipc.TypePromptPresented)
	if fake.shown() != 1 {
		t.Fatalf("dialogs = %d", fake.shown())
	}
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.restart.json")))
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the restart question")
	waitUntil(t, func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return len(fake.cancelled) == 1 && fake.cancelled[0] == notice.PromptID
	}, "the notice dialog's window to be taken down")
	if r.activeCount() != 1 {
		t.Fatalf("active = %d, want only the restart question", r.activeCount())
	}
	if n := sink.count(ipc.TypePromptClosed) + sink.count(ipc.TypePromptAction); n != 0 {
		t.Fatalf("taking the notice down reported %d messages; want none", n)
	}
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: notice.PromptID, Rev: notice.Rev + 1, Lease: notice.Lease}))
	time.Sleep(20 * time.Millisecond)
	if n := sink.count(ipc.TypePromptClosed); n != 0 {
		t.Fatal("an update for the notice taken down was refused as unknown")
	}
	if fake.shown() != 2 {
		t.Fatal("the update redrew the notice over the restart question")
	}
}

// A notice with an action beyond OK (the macOS permission notice's Open
// Settings) cannot be a notification, which has no buttons: it stays a
// dialog, short-lived like the legacy first-run permission dialog (60 s).
func TestNativeActionableNoticeIsAShortLivedDialog(t *testing.T) {
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.noticeState = nil // macOS
	show := sessionEndedShow(t, "notice:tcc:0a1b2c3d")
	show.Actions = append(show.Actions, ipc.PromptAction{ID: "open_settings", Label: "Open Settings", Role: ipc.PromptRoleNeutral})
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	if _, toasts := os.snapshot(); len(toasts) != 0 || fake.shown() != 1 {
		t.Fatalf("toasts %d, dialogs %d: an actionable notice is a dialog", len(toasts), fake.shown())
	}
	fake.mu.Lock()
	m := fake.models[0]
	fake.mu.Unlock()
	if _, ok := m.button("open_settings"); !ok {
		t.Fatalf("Open Settings missing from %+v", m.Buttons)
	}
	if got := nativeTimeout(m, nativeNow); got > nativeNoticeDialogLifetime {
		t.Fatalf("actionable notice dialog stays up %s", got)
	}
}

// Windows: a notice held while the user presents becomes, when the hold
// ends in quiet hours, a dialog that is short-lived too.
func TestNativeHeldNoticeThatBecomesADialogIsShortLived(t *testing.T) {
	os := &fakeNoticeOS{state: qunsBusy, toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	r.handle(envelopeFor(t, ipc.TypePromptShow, sessionEndedShow(t, "notice:session_ended:held")))
	sink.waitFor(t, ipc.TypePromptPresented) // visible:false, held
	os.set(qunsQuietTime)
	waitUntil(t, func() bool { return fake.shown() == 1 }, "the dialog after the hold")
	fake.mu.Lock()
	m := fake.models[0]
	fake.mu.Unlock()
	if got := nativeTimeout(m, nativeNow); got > nativeNoticeDialogLifetime {
		t.Fatalf("a held notice became a dialog that stays up %s", got)
	}
}

// A notice the agent withdrew while it was held leaves nothing behind: a
// later notice may still be a dialog.
func TestNativeWithdrawnHeldNoticeLeavesNoGhost(t *testing.T) {
	os := &fakeNoticeOS{state: qunsBusy, toastOK: false}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newNoticeRenderer(t, os, fake)
	held := sessionEndedShow(t, "notice:session_ended:withdrawn")
	r.handle(envelopeFor(t, ipc.TypePromptShow, held))
	sink.waitFor(t, ipc.TypePromptPresented)
	r.handle(envelopeFor(t, ipc.TypePromptClose, ipc.PromptClose{PromptID: held.PromptID, Rev: held.Rev, Lease: held.Lease, Reason: ipc.PromptCloseWithdrawn}))
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the hold to end")
	if n := sink.count(ipc.TypePromptPresented); n != 1 {
		t.Fatalf("a withdrawn notice sent %d presented messages, want only the hold's", n)
	}
	os.set(qunsQuietTime)
	r.handle(envelopeFor(t, ipc.TypePromptShow, sessionEndedShow(t, "notice:session_ended:next")))
	waitUntil(t, func() bool { return fake.shown() == 1 }, "the next notice's dialog")
}

// The cap never lengthens a notice whose own deadline is sooner.
func TestShortLivedNoticeKeepsASoonerDeadline(t *testing.T) {
	soon := nativePromptModel{Deadline: nativeNow.Add(10 * time.Second), Response: time.Minute}
	if got := shortLivedNotice(soon, nativeNow); !got.Deadline.Equal(soon.Deadline) || got.Response != 0 {
		t.Fatalf("deadline %s response %s; want the sooner deadline kept and no response window", got.Deadline, got.Response)
	}
	if got := shortLivedNotice(nativePromptModel{}, nativeNow); !got.Deadline.Equal(nativeNow.Add(nativeNoticeDialogLifetime)) {
		t.Fatalf("no deadline: got %s", got.Deadline)
	}
}
