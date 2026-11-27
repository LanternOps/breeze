package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// A restart the agent only listed (a replay that did not restore it) drew
// nothing, so an update to it announces nothing either (#12794 review).
func TestNativeListedPromptUpdateIsNotAnnounced(t *testing.T) {
	os := &fakeNoticeOS{toastOK: true}
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	r, _ := newNoticeRenderer(t, os, fake)
	r.noticeState = nil
	r.goAsync = func(f func()) { f() }
	show := nativeFixture(t, "show.restart.json")
	show.Presentation = ipc.PromptPresentationListOnly
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	cp := show.Copy
	cp.Body = "Postponed."
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: show.Rev + 1, Lease: show.Lease, Copy: &cp}))
	if _, toasts := os.snapshot(); len(toasts) != 0 || fake.shown() != 0 {
		t.Fatalf("toasts %d, dialogs %d for a listed prompt", len(toasts), fake.shown())
	}
}
