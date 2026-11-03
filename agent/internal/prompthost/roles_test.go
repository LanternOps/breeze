package prompthost

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #10190 W07: the elevation first question is drawn by the SYSTEM helper
// when UAC uses the secure desktop (Assist cannot be seen there), and the
// waiting card that follows "Send request" is drawn by Assist. A prompt can
// therefore restrict which renderer roles may draw it (Prompt.Roles), a
// patch can move it to other roles (Patch.Roles, with a new lease), and the
// first question is never re-asked while the card is (Prompt.NeverReask /
// Patch.NeverReask).

func systemRenderer(key string, kinds ...string) RendererSession {
	return RendererSession{Key: key, Role: ipc.HelperRoleSystem, Owner: testOwner, Protocol: 1, KindAds: kinds}
}

func elevationKind() KindSpec {
	return KindSpec{Name: "elevation.request", Version: 1, Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
		ipc.PromptStatePending: {"send_request": ipc.PromptStateWaiting, "cancel": ipc.PromptStateCancelled},
		ipc.PromptStateWaiting: {"cancel_request": ipc.PromptStateCancelled, "hide": ipc.PromptStateWaiting},
	}}
}

func elevationFirstQuestion(id string, roles []ipc.HelperRole, calls *promptCalls, lost *lostRecorder) Prompt {
	return Prompt{
		ID:   id,
		Kind: elevationKind(),
		Show: ipc.PromptShow{
			PromptID:     id,
			State:        ipc.PromptStatePending,
			Presentation: ipc.PromptPresentationModal,
			Copy:         ipc.PromptCopy{Title: "Ask your IT support team?", Body: "7zFM.exe needs administrator rights."},
			Actions: []ipc.PromptAction{
				{ID: "cancel", Label: "Cancel", Role: ipc.PromptRoleSafe},
				{ID: "send_request", Label: "Send request", Role: ipc.PromptRoleProceed},
			},
			DefaultActionID: "cancel",
			Timing:          ipc.PromptTiming{PresentWithinMs: 10_000, ResponseMs: 90_000, Expiry: &ipc.PromptExpiry{Text: "If you don't answer, the request is not sent."}},
			Focus:           ipc.PromptFocusSteal,
			ListEntry:       ipc.PromptListEntry{Persistent: true},
			Locale:          "en",
			Direction:       "ltr",
		},
		Owners:         []Owner{testOwner},
		Roles:          roles,
		NeverReask:     true,
		OnAction:       calls.OnAction,
		OnExpire:       calls.OnExpire,
		OnRendererLost: lost.lost,
	}
}

func waitingPatch(deadline time.Time) Patch {
	waiting := ipc.PromptStateWaiting
	card := ipc.PromptCopy{Title: "Waiting for your IT support team", StateDetail: "They have until {time:1}."}
	actions := []ipc.PromptAction{
		{ID: "cancel_request", Label: "Cancel request", Role: ipc.PromptRoleSafe},
		{ID: "hide", Label: "Hide", Role: ipc.PromptRoleNeutral},
	}
	timing := ipc.PromptTiming{PresentWithinMs: 10_000, DeadlineUnixMs: deadline.UnixMilli()}
	roles := []ipc.HelperRole{ipc.HelperRoleAssist}
	reask := false
	pres, focus := ipc.PromptPresentationCard, ipc.PromptFocusNoActivate
	return Patch{State: &waiting, Copy: &card, Actions: &actions, DefaultActionID: "hide", Timing: &timing,
		Presentation: &pres, Focus: &focus, Roles: &roles, NeverReask: &reask}
}

func TestPromptRolesRestrictTheRenderer(t *testing.T) {
	assist := assistRenderer("assist-1", "elevation.request@1")
	system := systemRenderer("system-1", "elevation.request@1")
	hh := newHarness(t, assist, system)
	calls, lost := &promptCalls{}, &lostRecorder{}
	if err := hh.h.Show(elevationFirstQuestion("elevation:r1", []ipc.HelperRole{ipc.HelperRoleSystem}, calls, lost)); err != nil {
		t.Fatal(err)
	}
	msgs := hh.dir.take()
	if n := len(showsTo(msgs, "assist-1")); n != 0 {
		t.Fatalf("Assist drew a prompt restricted to the SYSTEM helper (%d shows)", n)
	}
	if n := len(showsTo(msgs, "system-1")); n != 1 {
		t.Fatalf("SYSTEM helper shows = %d, want 1", n)
	}
	hh.h.RegisterKind(elevationKind())
	if !hh.h.PromptPathAvailableVia("elevation.request", 1, testOwner, []ipc.HelperRole{ipc.HelperRoleSystem}) {
		t.Fatal("the SYSTEM helper advertised the kind: the path is available via it")
	}
	hh.dir.remove("system-1")
	if hh.h.PromptPathAvailableVia("elevation.request", 1, testOwner, []ipc.HelperRole{ipc.HelperRoleSystem}) {
		t.Fatal("no SYSTEM helper: the path must not be available via it, even though Assist is there")
	}
}

func TestPromptRolesDefaultPrefersAssist(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "elevation.request@1"), systemRenderer("system-1", "elevation.request@1"))
	calls, lost := &promptCalls{}, &lostRecorder{}
	if err := hh.h.Show(elevationFirstQuestion("elevation:r1", []ipc.HelperRole{ipc.HelperRoleAssist, ipc.HelperRoleSystem}, calls, lost)); err != nil {
		t.Fatal(err)
	}
	msgs := hh.dir.take()
	if len(showsTo(msgs, "assist-1")) != 1 || len(showsTo(msgs, "system-1")) != 0 {
		t.Fatal("with the secure desktop off, Assist draws the first question")
	}
}

func TestPatchRolesMovesThePromptToAssistWithANewLease(t *testing.T) {
	assist := assistRenderer("assist-1", "elevation.request@1")
	system := systemRenderer("system-1", "elevation.request@1")
	hh := newHarness(t, assist, system)
	deadline := t0.Add(15 * time.Minute)
	calls, lost := &promptCalls{outcome: ActionOutcome{Accepted: true, Patch: ptrPatch(waitingPatch(deadline))}}, &lostRecorder{}
	if err := hh.h.Show(elevationFirstQuestion("elevation:r1", []ipc.HelperRole{ipc.HelperRoleSystem}, calls, lost)); err != nil {
		t.Fatal(err)
	}
	first := showsTo(hh.dir.take(), "system-1")[0]
	hh.presented("system-1", first)

	res := hh.act("system-1", "elevation:r1", first.Rev, first.Lease, "send_request")
	if res.Result != ipc.PromptActionAccepted {
		t.Fatalf("send_request = %s", res.Result)
	}
	msgs := hh.dir.take()
	if n := len(updatesTo(msgs, "system-1")); n != 0 {
		t.Fatalf("the SYSTEM helper was sent the waiting state (%d updates); it must only be fenced", n)
	}
	closes := closesTo(msgs, "system-1")
	if len(closes) != 1 || closes[0].Reason != ipc.PromptCloseFenced {
		t.Fatalf("SYSTEM helper closes = %+v, want one fenced", closes)
	}
	shows := showsTo(msgs, "assist-1")
	if len(shows) != 1 {
		t.Fatalf("Assist shows = %d, want the waiting card", len(shows))
	}
	got := shows[0]
	if got.State != ipc.PromptStateWaiting || got.Presentation != ipc.PromptPresentationCard || got.Focus != ipc.PromptFocusNoActivate {
		t.Fatalf("Assist got state %s / %s", got.State, got.Presentation)
	}
	if got.Lease.RendererSession != "assist-1" || got.Rev <= first.Rev {
		t.Fatalf("Assist lease %+v rev %d (first rev %d)", got.Lease, got.Rev, first.Rev)
	}
	// The old lease is dead: a late click from the SYSTEM helper is stale.
	if r := hh.act("system-1", "elevation:r1", got.Rev, first.Lease, "cancel_request"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("a click on the fenced SYSTEM copy = %s, want rejected_stale", r.Result)
	}

	// The waiting card is not NeverReask: an Assist restart replays it.
	hh.presented("assist-1", got)
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(time.Second)
	if lost := lost.snapshot(); len(lost) != 0 {
		t.Fatalf("the waiting card was treated as lost: %+v", lost)
	}
	assist2 := assistRenderer("assist-2", "elevation.request@1")
	hh.dir.add(assist2)
	hh.h.RendererConnected(assist2)
	hh.tick(time.Second)
	replayed := showsTo(hh.dir.take(), "assist-2")
	if len(replayed) != 1 || replayed[0].State != ipc.PromptStateWaiting {
		t.Fatalf("waiting card replay = %+v", replayed)
	}
}

func TestPerPromptNeverReaskLosesTheFirstQuestion(t *testing.T) {
	hh := newHarness(t, systemRenderer("system-1", "elevation.request@1"))
	calls, lost := &promptCalls{}, &lostRecorder{}
	if err := hh.h.Show(elevationFirstQuestion("elevation:r1", []ipc.HelperRole{ipc.HelperRoleSystem}, calls, lost)); err != nil {
		t.Fatal(err)
	}
	first := showsTo(hh.dir.take(), "system-1")[0]
	hh.presented("system-1", first)
	hh.dir.remove("system-1")
	hh.h.RendererDisconnected("system-1")
	// A SYSTEM helper respawned in the same session must not redraw it.
	system2 := systemRenderer("system-2", "elevation.request@1")
	hh.dir.add(system2)
	hh.h.RendererConnected(system2)
	hh.tick(time.Second)
	if n := len(showsTo(hh.dir.take(), "system-2")); n != 0 {
		t.Fatalf("the first question was redrawn natively after its helper was lost (%d)", n)
	}
	got := lost.snapshot()
	if len(got) != 1 || got[0].reason != "renderer_gone" || !got[0].info.Presented {
		t.Fatalf("lost = %+v", got)
	}
}

func ptrPatch(p Patch) *Patch { return &p }
