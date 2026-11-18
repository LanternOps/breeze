package prompthost

import (
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// #10190 W06: remote consent is never re-asked (spec §3.7 "Assist crashes
// mid-prompt": the host does not re-ask, so a lost prompt never turns into a
// second chance to allow). A NeverReask kind is never moved to another
// renderer; when its renderer is lost the prompt is withdrawn and the domain
// hears about it (OnRendererLost) and applies its own no-renderer rule.

type lostCall struct {
	info   PlacementInfo
	reason string
}

type lostRecorder struct {
	mu    sync.Mutex
	calls []lostCall
}

func (r *lostRecorder) lost(info PlacementInfo, reason string) {
	r.mu.Lock()
	r.calls = append(r.calls, lostCall{info, reason})
	r.mu.Unlock()
}

func (r *lostRecorder) snapshot() []lostCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]lostCall(nil), r.calls...)
}

func consentShow(id string) ipc.PromptShow {
	return ipc.PromptShow{
		PromptID:     id,
		State:        ipc.PromptStatePending,
		Presentation: ipc.PromptPresentationModal,
		Copy:         ipc.PromptCopy{Title: "Remote support request", Body: "A technician wants to start a remote session on this computer."},
		Actions: []ipc.PromptAction{
			{ID: "deny", Label: "Deny", Role: ipc.PromptRoleSafe},
			{ID: "allow", Label: "Allow", Role: ipc.PromptRoleProceed},
		},
		DefaultActionID: "deny",
		Timing: ipc.PromptTiming{PresentWithinMs: 10_000, ResponseMs: 30_000,
			Expiry: &ipc.PromptExpiry{Text: "If no one answers, the session is declined in {remaining}."}},
		Focus:     ipc.PromptFocusSteal,
		ListEntry: ipc.PromptListEntry{Persistent: true},
		Locale:    "en",
		Direction: "ltr",
	}
}

func consentPrompt(id string, calls *promptCalls, lost *lostRecorder) Prompt {
	return Prompt{
		ID: id,
		Kind: KindSpec{Name: "remote.consent", Version: 1, ShowWhileLocked: true, NeverReask: true,
			Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
				ipc.PromptStatePending: {"allow": ipc.PromptStateApproved, "deny": ipc.PromptStateDenied},
			}},
		Owners:         []Owner{testOwner},
		Show:           consentShow(id),
		OnAction:       calls.OnAction,
		OnExpire:       calls.OnExpire,
		OnRendererLost: lost.lost,
	}
}

func TestNeverReaskPromptIsNotMovedWhenItsRendererDisconnects(t *testing.T) {
	assist := assistRenderer("assist-1", "remote.consent@1")
	native := nativeRenderer("native-1", "remote.consent@1")
	hh := newHarness(t, assist, native)
	calls, lost := &promptCalls{outcome: ActionOutcome{Accepted: true}}, &lostRecorder{}
	if err := hh.h.Show(consentPrompt("consent:n1", calls, lost)); err != nil {
		t.Fatal(err)
	}
	msgs := hh.dir.take()
	shows := showsTo(msgs, "assist-1")
	if len(shows) != 1 || len(showsTo(msgs, "native-1")) != 0 {
		t.Fatalf("Assist draws it first (assist %d, native %d)", len(shows), len(showsTo(msgs, "native-1")))
	}
	hh.presented("assist-1", shows[0])

	// Assist is killed mid-consent.
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	for i := 0; i < 15; i++ {
		hh.tick(time.Second)
	}
	msgs = hh.dir.take()
	if n := len(showsTo(msgs, "native-1")); n != 0 {
		t.Fatalf("the consent was re-asked on the native helper (%d shows)", n)
	}
	got := lost.snapshot()
	if len(got) != 1 || got[0].reason != "renderer_gone" || !got[0].info.Presented || got[0].info.Role != ipc.HelperRoleAssist || got[0].info.RendererKey != "assist-1" {
		t.Fatalf("lost = %+v, want one renderer_gone for the presented Assist copy", got)
	}
	if hh.h.IsOpen("consent:n1") {
		t.Fatal("a lost consent must be withdrawn, not left open")
	}
	if _, _, expired := calls.counts(); expired != 0 {
		t.Fatal("a lost consent must not also expire")
	}
	// Assist comes back: nothing is replayed.
	hh.dir.add(assistRenderer("assist-2", "remote.consent@1"))
	hh.h.RendererConnected(assistRenderer("assist-2", "remote.consent@1"))
	hh.tick(time.Second)
	if n := len(showsTo(hh.dir.take(), "assist-2")); n != 0 {
		t.Fatalf("the lost consent was replayed into the reconnected Assist (%d shows)", n)
	}
}

func TestNeverReaskPromptIsNotMovedOnRenderFailedOrPresentBudget(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fail   func(hh *harness, s ipc.PromptShow)
		reason string
	}{
		{"render_failed", func(hh *harness, s ipc.PromptShow) { hh.closed("assist-1", s, ipc.PromptClosedRenderFailed) }, "render_failed"},
		{"present budget", func(hh *harness, _ ipc.PromptShow) { hh.tick(11 * time.Second) }, "present_budget"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHarness(t, assistRenderer("assist-1", "remote.consent@1"), nativeRenderer("native-1", "remote.consent@1"))
			lost := &lostRecorder{}
			if err := hh.h.Show(consentPrompt("consent:n2", &promptCalls{}, lost)); err != nil {
				t.Fatal(err)
			}
			s := showsTo(hh.dir.take(), "assist-1")[0]
			tc.fail(hh, s)
			hh.tick(time.Second)
			msgs := hh.dir.take()
			if n := len(showsTo(msgs, "native-1")); n != 0 {
				t.Fatalf("moved to the native helper (%d shows)", n)
			}
			if got := lost.snapshot(); len(got) != 1 || got[0].reason != tc.reason || got[0].info.Presented {
				t.Fatalf("lost = %+v, want one unpresented %s", got, tc.reason)
			}
			if hh.h.IsOpen("consent:n2") {
				t.Fatal("still open")
			}
		})
	}
}

// A consent drawn by the native helper (no Assist yet) stays there when an
// Assist connects: moving it would be a second window asking again.
func TestNeverReaskPromptIsNotMovedOnReplay(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "remote.consent@1"))
	lost := &lostRecorder{}
	if err := hh.h.Show(consentPrompt("consent:n3", &promptCalls{}, lost)); err != nil {
		t.Fatal(err)
	}
	s := showsTo(hh.dir.take(), "native-1")[0]
	hh.presented("native-1", s)
	a := assistRenderer("assist-1", "remote.consent@1")
	hh.dir.add(a)
	hh.h.RendererConnected(a)
	hh.tick(time.Second)
	msgs := hh.dir.take()
	if len(showsTo(msgs, "assist-1")) != 0 || len(closesTo(msgs, "native-1")) != 0 {
		t.Fatalf("the consent moved on replay: %+v", msgs)
	}
	if !hh.h.IsOpen("consent:n3") || len(lost.snapshot()) != 0 {
		t.Fatal("the native copy must stay the live one")
	}
}

func TestPlacementOfReportsTheRendererAndPresentation(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "remote.consent@1"))
	if _, ok := hh.h.PlacementOf("consent:none", testOwner); ok {
		t.Fatal("an unknown prompt has no placement")
	}
	if err := hh.h.Show(consentPrompt("consent:n4", &promptCalls{}, &lostRecorder{})); err != nil {
		t.Fatal(err)
	}
	info, ok := hh.h.PlacementOf("consent:n4", testOwner)
	if !ok || info.Path != PathPrompt || info.RendererKey != "native-1" || info.Role != ipc.HelperRoleUser || info.Presented {
		t.Fatalf("before presentation: %+v %v", info, ok)
	}
	hh.presented("native-1", showsTo(hh.dir.take(), "native-1")[0])
	if info, _ = hh.h.PlacementOf("consent:n4", testOwner); !info.Presented {
		t.Fatalf("after presentation: %+v", info)
	}
	if _, ok := hh.h.PlacementOf("consent:n4", Owner{WinSessionID: 9, UserSID: "S-1-5-21-9"}); ok {
		t.Fatal("another owner has no placement")
	}
}

// The consequence sentence (timing.expiry.text) is copy too: it is rendered
// in each renderer's session locale.
func TestLocalizeRendersTheExpiryText(t *testing.T) {
	de := nativeRenderer("native-de", "remote.consent@1")
	de.UILocale = "de-DE"
	hh := newHarness(t, de)
	p := consentPrompt("consent:n5", &promptCalls{}, &lostRecorder{})
	p.Localize = func(loc promptcatalog.Locale) (Localized, error) {
		return Localized{Copy: ipc.PromptCopy{Title: "t-" + string(loc)}, ExpiryText: "expiry-" + string(loc) + " {remaining}"}, nil
	}
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	s := showsTo(hh.dir.take(), "native-de")[0]
	if s.Timing.Expiry == nil || s.Timing.Expiry.Text != "expiry-de-DE {remaining}" {
		t.Fatalf("expiry = %+v", s.Timing.Expiry)
	}
	// The record's own copy is untouched (a pointer is never shared).
	hh.h.mu.Lock()
	text := hh.h.prompts["consent:n5"].show.Timing.Expiry.Text
	hh.h.mu.Unlock()
	if text != "If no one answers, the session is declined in {remaining}." {
		t.Fatalf("the record's expiry text changed to %q", text)
	}
}

// WithdrawUnplaced decides, atomically, whether a prompt never reached any
// renderer (so the caller may ask the legacy way): it is false once a
// renderer was assigned, even if that renderer was lost meanwhile.
func TestWithdrawUnplacedOnlyWhenNoRendererWasEverAssigned(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "remote.consent@1"))
	lost := &lostRecorder{}
	// Drawn: never withdrawn this way.
	if err := hh.h.Show(consentPrompt("consent:w1", &promptCalls{}, lost)); err != nil {
		t.Fatal(err)
	}
	if hh.h.WithdrawUnplaced("consent:w1") || !hh.h.IsOpen("consent:w1") {
		t.Fatal("a placed prompt was withdrawn")
	}
	// Drawn, then lost before the caller looked: still false (the loss
	// callback answers), and nothing is re-shown.
	s := showsTo(hh.dir.take(), "native-1")[0]
	hh.closed("native-1", s, ipc.PromptClosedRenderFailed)
	if hh.h.WithdrawUnplaced("consent:w1") {
		t.Fatal("a lost prompt reported as never placed: the caller would re-ask")
	}
	// Held behind another modal for the same owner: withdrawn, closed.
	if err := hh.h.Show(consentPrompt("consent:w2", &promptCalls{}, lost)); err != nil {
		t.Fatal(err)
	}
	if err := hh.h.Show(consentPrompt("consent:w3", &promptCalls{}, lost)); err != nil {
		t.Fatal(err)
	}
	if !hh.h.WithdrawUnplaced("consent:w3") || hh.h.IsOpen("consent:w3") {
		t.Fatal("a held prompt that no renderer ever drew must be withdrawn")
	}
	if hh.h.WithdrawUnplaced("consent:none") {
		t.Fatal("an unknown prompt")
	}
}

// A renderer drops any message whose rev is not greater than the last one
// it applied for that promptId, also across a close. A Reshowable prompt
// closed withdrawn and shown again (a viewer reconnect on the same session
// id) must continue its revs, never restart at 1.
func TestReshownPromptContinuesItsRevs(t *testing.T) {
	r := nativeRenderer("native-1", "remote.session@1")
	hh := newHarness(t, r)
	hh.h.SetEnabledKinds([]string{"remote.session"})
	pill := func() Prompt {
		return Prompt{
			ID:     "session:s1",
			Kind:   KindSpec{Name: "remote.session", Version: 1, Transitions: map[ipc.PromptState]map[string]ipc.PromptState{ipc.PromptStatePending: {"end_session": ipc.PromptStatePending}}},
			Owners: []Owner{testOwner},
			Show: ipc.PromptShow{State: ipc.PromptStatePending, Presentation: ipc.PromptPresentationIndicator,
				Copy:    ipc.PromptCopy{Title: "t"},
				Actions: []ipc.PromptAction{{ID: "end_session", Label: "End session", Role: ipc.PromptRoleNeutral}},
				Timing:  ipc.PromptTiming{PresentWithinMs: 10_000}, Focus: ipc.PromptFocusNoActivate, Locale: "en", Direction: "ltr"},
			Reshowable: true,
		}
	}
	if err := hh.h.Show(pill()); err != nil {
		t.Fatal(err)
	}
	// Two patches: the closed prompt's last rev is 3.
	for i := 0; i < 2; i++ {
		if err := hh.h.Update("session:s1", Patch{Copy: &ipc.PromptCopy{Title: "t"}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := hh.h.Close("session:s1", ipc.PromptCloseWithdrawn); err != nil {
		t.Fatal(err)
	}
	var last uint64
	for _, m := range hh.dir.take() {
		if c, ok := m.Payload.(ipc.PromptClose); ok {
			last = c.Rev
		}
	}
	if last != 3 {
		t.Fatalf("closed at rev %d, want 3", last)
	}
	if err := hh.h.Show(pill()); err != nil {
		t.Fatalf("re-show: %v", err)
	}
	shows := showsTo(hh.dir.take(), "native-1")
	if len(shows) != 1 || shows[0].Rev <= last {
		t.Fatalf("re-shown at rev %+v, want > %d", shows, last)
	}
	// The floor is forgotten with the tombstones (24 h), not kept forever.
	hh.tick(promptTombstoneTTL + time.Second)
	hh.h.mu.Lock()
	n := len(hh.h.revFloor)
	hh.h.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d rev floors kept past their TTL", n)
	}
}

// A Relocalize patch is rendered per renderer; a plain patch keeps its copy
// as given (the W04 contract).
func TestRelocalizedPatchIsRenderedPerRenderer(t *testing.T) {
	de := nativeRenderer("native-de", "remote.session@1")
	de.UILocale = "de-DE"
	hh := newHarness(t, de)
	hh.h.SetEnabledKinds([]string{"remote.session"})
	confirming := false
	p := Prompt{
		ID: "session:s1",
		Kind: KindSpec{Name: "remote.session", Version: 1, Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
			ipc.PromptStatePending: {"end_session": ipc.PromptStatePending, "keep_session": ipc.PromptStatePending},
		}},
		Owners: []Owner{testOwner},
		Show: ipc.PromptShow{State: ipc.PromptStatePending, Presentation: ipc.PromptPresentationIndicator,
			Copy:    ipc.PromptCopy{Title: "t"},
			Actions: []ipc.PromptAction{{ID: "end_session", Label: "End session", Role: ipc.PromptRoleNeutral}},
			Timing:  ipc.PromptTiming{PresentWithinMs: 10_000}, Focus: ipc.PromptFocusNoActivate, Locale: "en", Direction: "ltr"},
		OnAction: func(string, Owner) (ActionOutcome, error) { return ActionOutcome{Accepted: true}, nil },
		Localize: func(loc promptcatalog.Locale) (Localized, error) {
			l := Localized{Copy: ipc.PromptCopy{Title: "t-" + string(loc)}, ActionLabels: map[string]string{
				"end_session": "end-" + string(loc), "keep_session": "keep-" + string(loc)}}
			if confirming {
				l.Copy.StateDetail = "confirm-" + string(loc)
			}
			return l, nil
		},
	}
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	hh.dir.take()
	confirming = true
	actions := []ipc.PromptAction{{ID: "keep_session", Label: "Keep session", Role: ipc.PromptRoleSafe}}
	if err := hh.h.Update("session:s1", Patch{Copy: &ipc.PromptCopy{Title: "t", StateDetail: "confirm-en"}, Actions: &actions, DefaultActionID: "keep_session", Relocalize: true}); err != nil {
		t.Fatal(err)
	}
	ups := updatesTo(hh.dir.take(), "native-de")
	if len(ups) != 1 || ups[0].Copy == nil || ups[0].Copy.StateDetail != "confirm-de-DE" || ups[0].Actions == nil || (*ups[0].Actions)[0].Label != "keep-de-DE" {
		t.Fatalf("relocalized update = %+v", ups)
	}
	// A plain patch still sends its copy as given.
	if err := hh.h.Update("session:s1", Patch{Copy: &ipc.PromptCopy{Title: "as given"}}); err != nil {
		t.Fatal(err)
	}
	ups = updatesTo(hh.dir.take(), "native-de")
	if len(ups) != 1 || ups[0].Copy.Title != "as given" {
		t.Fatalf("plain update = %+v", ups)
	}
}
