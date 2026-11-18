package userhelper

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func newTestRenderer(t *testing.T, fake *fakeNativeShow) (*nativePromptRenderer, *promptSink) {
	t.Helper()
	sink := &promptSink{}
	r := newNativePromptRenderer([]string{"restart.prompt@1", "elevation.request@1", "notice.info@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	// Never the real SHQueryUserNotificationState or a real toast in a test;
	// notice_delivery_test.go installs fakes where it needs them.
	r.noticeState = nil
	r.toast = func(ipc.NotifyRequest) bool { return false }
	return r, sink
}

func (s *promptSink) count(typ string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, m := range s.sent {
		if m.typ == typ {
			n++
		}
	}
	return n
}

func (f *fakeNativeShow) shown() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.models)
}

func waitUntil(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestNativeRendererUpdateAfterTheDialogEnded(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 2)}
	r, sink := newTestRenderer(t, fake)
	show := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	fake.outcome <- nativeOutcome{ActionID: "postpone"}
	sink.waitFor(t, ipc.TypePromptAction)
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the dialog to end")

	// The agent applied the postponement: still pending, new label. The
	// question comes back; no render_failed (that would reroute an answered prompt).
	label := "Postpone until 15:00"
	actions := []ipc.PromptAction{{ID: "postpone", Label: label, Role: ipc.PromptRoleSafe}, {ID: "restart_now", Label: "Restart now", Role: ipc.PromptRoleProceed}}
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: 2, Lease: show.Lease, Actions: &actions, DefaultActionID: "postpone"}))
	waitUntil(t, func() bool { return fake.shown() == 2 }, "the redraw")

	// A terminal update for an ended dialog is ignored silently.
	fake.outcome <- nativeOutcome{ActionID: "restart_now"}
	waitUntil(t, func() bool { return sink.count(ipc.TypePromptAction) == 2 }, "the second action")
	waitUntil(t, func() bool { return r.activeCount() == 0 }, "the redraw to end")
	approved := ipc.PromptStateApproved
	none := []ipc.PromptAction{}
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: 3, Lease: show.Lease, State: &approved, Actions: &none}))
	time.Sleep(30 * time.Millisecond)
	if n := sink.count(ipc.TypePromptClosed); n != 0 {
		t.Fatalf("an update for an ended dialog was answered prompt_closed (%d)", n)
	}
	if fake.shown() != 2 {
		t.Fatal("a terminal update redrew the dialog")
	}
}

func TestNativeRendererUpdateForAPromptNeverHeldIsRefused(t *testing.T) {
	r, sink := newTestRenderer(t, &fakeNativeShow{})
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: "restart:99", Rev: 2, Lease: ipc.PromptLease{RendererSession: "u", Epoch: 1}}))
	if c := sink.waitFor(t, ipc.TypePromptClosed).(ipc.PromptClosed); c.Detail != "unknown_prompt" {
		t.Fatalf("closed = %+v", c)
	}
}

func TestNativeRendererAdoptsTheReplayLease(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, sink := newTestRenderer(t, fake)
	show := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	replayed := show
	replayed.Lease = ipc.PromptLease{RendererSession: show.Lease.RendererSession, Epoch: show.Lease.Epoch + 1}
	r.handle(envelopeFor(t, ipc.TypePromptShow, replayed))
	waitUntil(t, func() bool { return sink.count(ipc.TypePromptPresented) == 2 }, "presented on the new lease")
	if fake.shown() != 1 {
		t.Fatal("a same-rev replay drew a second window")
	}
	fake.outcome <- nativeOutcome{ActionID: "restart_now"}
	a := sink.waitFor(t, ipc.TypePromptAction).(ipc.PromptActionRequest)
	if a.Lease != replayed.Lease {
		t.Fatalf("action on lease %+v, want the replay's %+v", a.Lease, replayed.Lease)
	}
}

func TestNativeRendererAnswersAMalformedShow(t *testing.T) {
	r, sink := newTestRenderer(t, &fakeNativeShow{})
	raw := json.RawMessage(`{"promptId":"restart:42","rev":3,"lease":{"rendererSession":"u","epoch":2},"actions":"not-a-list"}`)
	r.handle(&ipc.Envelope{ID: "e-1", Type: ipc.TypePromptShow, Payload: raw})
	c := sink.waitFor(t, ipc.TypePromptClosed).(ipc.PromptClosed)
	if c.Reason != ipc.PromptClosedRenderFailed || c.Detail != "malformed" || c.PromptID != "restart:42" || c.Rev != 3 || c.Lease.Epoch != 2 {
		t.Fatalf("closed = %+v", c)
	}
}

func TestNativeRendererCloseAllTakesEveryDialogDownSilently(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome)}
	r, sink := newTestRenderer(t, fake)
	a := nativeFixture(t, "show.restart.json")
	b := nativeFixture(t, "show.notice.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, a))
	r.handle(envelopeFor(t, ipc.TypePromptShow, b))
	waitUntil(t, func() bool { return sink.count(ipc.TypePromptPresented) == 2 }, "both presented")
	r.closeAll()
	if r.activeCount() != 0 {
		t.Fatal("closeAll left dialogs tracked")
	}
	time.Sleep(30 * time.Millisecond)
	if sink.count(ipc.TypePromptAction)+sink.count(ipc.TypePromptClosed) != 0 {
		t.Fatalf("closeAll reported %v", sink.types())
	}
}

func TestNativeRendererPanicInTheDialogIsRenderFailed(t *testing.T) {
	sink := &promptSink{}
	r := newNativePromptRenderer([]string{"restart.prompt@1"}, func(context.Context, nativePromptModel, func()) nativeOutcome {
		panic("boom")
	}, sink.send, func() time.Time { return nativeNow })
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.restart.json")))
	if c := sink.waitFor(t, ipc.TypePromptClosed).(ipc.PromptClosed); c.Detail != "window_failed" {
		t.Fatalf("closed = %+v", c)
	}
}

func TestNativeZenityDisplayFailureIsNotADecision(t *testing.T) {
	m := restartModel(t)
	if got := classifyNativeZenityRun(m, 1, "(zenity:123): Gtk-WARNING **: cannot open display: :0"); got.Err == nil || got.ActionID != "" {
		t.Fatalf("display failure -> %+v; must be an error, never the safe action", got)
	}
	if got := classifyNativeZenityRun(m, 1, ""); got.ActionID != "postpone" {
		t.Fatalf("a real cancel -> %+v", got)
	}
}

func TestNativeOsascriptLabelWithAComma(t *testing.T) {
	show := nativeFixture(t, "show.restart.json")
	show.Actions[1].Label = "Restart now, please"
	m, err := buildNativePromptModel(show, nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if got := classifyNativeOsascript(m, "button returned:Restart now, please, gave up:false", false); got.ActionID != "restart_now" {
		t.Fatalf("comma label -> %+v", got)
	}
	if got := classifyNativeOsascript(m, "button returned:Restart now, please\n", false); got.ActionID != "restart_now" {
		t.Fatalf("comma label without gave up -> %+v", got)
	}
}
