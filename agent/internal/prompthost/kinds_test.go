package prompthost

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// W04 (#10190): the host's side of the first enabled kind — the "agent
// speaks the kind" switch, per-session copy, and closing a scope's prompts.

func TestPromptPathAvailableNeedsAllThreeSwitches(t *testing.T) {
	notice := KindSpec{Name: "notice.info", Version: 1}
	cases := []struct {
		name       string
		register   bool
		enabled    []string
		advertised []string
		want       bool
		live       bool // KindLive: the agent speaks it and the server enables it
	}{
		{"all three on", true, []string{"notice.info"}, []string{"notice.info@1"}, true, true},
		{"kind@n enables that version", true, []string{"notice.info@1"}, []string{"notice.info@1"}, true, true},
		{"agent build does not speak the kind", false, []string{"notice.info"}, []string{"notice.info@1"}, false, false},
		{"server kill switch off", true, []string{}, []string{"notice.info@1"}, false, false},
		{"another version enabled", true, []string{"notice.info@2"}, []string{"notice.info@1"}, false, false},
		{"renderer advertised nothing", true, []string{"notice.info"}, nil, false, true},
		{"renderer advertised another kind", true, []string{"notice.info"}, []string{"restart.prompt@1"}, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHarness(t, nativeRenderer("native-1", tc.advertised...))
			hh.h.SetEnabledKinds(tc.enabled)
			if tc.register {
				hh.h.RegisterKind(notice)
			}
			if got := hh.h.PromptPathAvailable("notice.info", 1, testOwner); got != tc.want {
				t.Fatalf("PromptPathAvailable = %v, want %v", got, tc.want)
			}
			if got := hh.h.KindLive("notice.info", 1); got != tc.live {
				t.Fatalf("KindLive = %v, want %v", got, tc.live)
			}
		})
	}
}

func TestPromptPathAvailableIgnoresOtherOwnersRenderers(t *testing.T) {
	other := Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}
	r := nativeRenderer("native-2", "notice.info@1")
	r.Owner = other
	hh := newHarness(t, r)
	hh.h.RegisterKind(KindSpec{Name: "notice.info", Version: 1})
	if hh.h.PromptPathAvailable("notice.info", 1, testOwner) {
		t.Fatal("a renderer in another session must not make the prompt path available")
	}
	if !hh.h.PromptPathAvailable("notice.info", 1, other) {
		t.Fatal("the other session's own renderer should")
	}
}

// localizedNotice renders title, body, a fact and the ok label from the
// locale it is handed, so the test can see which locale each copy used.
func localizedNotice(t *testing.T, id string, calls *promptCalls) Prompt {
	p := noticePrompt(t, id, calls)
	p.Localize = func(loc promptcatalog.Locale) (Localized, error) {
		return Localized{
			Copy:         ipc.PromptCopy{Title: "title-" + string(loc), Body: "body-" + string(loc)},
			Facts:        []ipc.PromptFact{{Label: "label-" + string(loc), Value: "value-" + string(loc)}},
			ActionLabels: map[string]string{"ok": "ok-" + string(loc)},
		}, nil
	}
	return p
}

func TestLocalizeRendersEachRendererInItsSessionLocale(t *testing.T) {
	de := nativeRenderer("native-de", "notice.info@1")
	de.UILocale = "de_DE.UTF-8"
	fr := nativeRenderer("native-fr", "notice.info@1")
	fr.Owner = Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}
	fr.UILocale = "fr-CA"
	hh := newHarness(t, de, fr)
	p := localizedNotice(t, "notice:test:1", &promptCalls{})
	p.Owners = []Owner{testOwner, fr.Owner}
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	msgs := hh.dir.take()
	for key, loc := range map[string]string{"native-de": "de-DE", "native-fr": "fr-CA"} {
		shows := showsTo(msgs, key)
		if len(shows) != 1 {
			t.Fatalf("%s got %d shows", key, len(shows))
		}
		s := shows[0]
		if s.Locale != loc || s.Copy.Title != "title-"+loc || s.Copy.Body != "body-"+loc {
			t.Fatalf("%s: locale %q copy %+v, want %s", key, s.Locale, s.Copy, loc)
		}
		if len(s.Facts) != 1 || s.Facts[0].Label != "label-"+loc {
			t.Fatalf("%s: facts %+v", key, s.Facts)
		}
		if len(s.Actions) != 1 || s.Actions[0].ID != "ok" || s.Actions[0].Label != "ok-"+loc || s.Actions[0].Role != ipc.PromptRoleSafe {
			t.Fatalf("%s: actions %+v", key, s.Actions)
		}
		if err := ipc.ValidatePromptShow(s); err != nil {
			t.Fatalf("%s: localized show invalid: %v", key, err)
		}
	}
	// The list entry each principal keeps is in that principal's language.
	for _, o := range []Owner{testOwner, fr.Owner} {
		entries := hh.inbox.PromptEntries(o.PrincipalKey())
		if len(entries) != 1 {
			t.Fatalf("%s: %d entries", o.Key(), len(entries))
		}
		want := map[string]string{testOwner.Key(): "de-DE", fr.Owner.Key(): "fr-CA"}[o.Key()]
		if entries[0].Show.Locale != want || entries[0].Show.Copy.Title != "title-"+want {
			t.Fatalf("%s: entry in %q (%q), want %s", o.Key(), entries[0].Show.Locale, entries[0].Show.Copy.Title, want)
		}
	}
}

func TestLocalizeLegacyOwnerEntryUsesTheMachineLocale(t *testing.T) {
	dir := &fakeDir{}
	clock := &fakeClock{t: t0}
	inbox := newFakeInbox()
	h := New(Deps{Broker: dir, Inbox: inbox, Clock: clock, OSLocale: func() string { return "it_IT" }})
	calls := &promptCalls{}
	if err := h.Show(localizedNotice(t, "notice:test:legacy", calls)); err != nil {
		t.Fatal(err)
	}
	if legacy, _, _ := calls.counts(); legacy != 1 {
		t.Fatalf("legacy = %d, want 1", legacy)
	}
	entries := inbox.PromptEntries(testOwner.PrincipalKey())
	if len(entries) != 1 || entries[0].Show.Locale != "it-IT" || entries[0].Show.Copy.Title != "title-it-IT" {
		t.Fatalf("legacy owner's entry = %+v", entries)
	}
}

// A Reshowable prompt (the permission notice: the condition it reports can
// come back) is tombstoned only when it was resolved; closed undecided —
// expired, withdrawn (a grant, a scope change), superseded — the domain may
// show the same id again. Any other prompt keeps the 24 h tombstone.
func TestReshowablePromptIsTombstonedOnlyWhenResolved(t *testing.T) {
	for _, tc := range []struct {
		reason     ipc.PromptCloseReason
		reshowable bool
		wantTomb   bool
	}{
		{ipc.PromptCloseWithdrawn, true, false},
		{ipc.PromptCloseExpired, true, false},
		{ipc.PromptCloseSuperseded, true, false},
		{ipc.PromptCloseResolved, true, true},
		{ipc.PromptCloseWithdrawn, false, true},
		{ipc.PromptCloseExpired, false, true},
	} {
		t.Run(fmt.Sprintf("%s/reshowable=%v", tc.reason, tc.reshowable), func(t *testing.T) {
			hh := newHarness(t, nativeRenderer("native-1", "notice.info@1"))
			p := noticePrompt(t, "notice:test:again", &promptCalls{})
			p.Reshowable = tc.reshowable
			if err := hh.h.Show(p); err != nil {
				t.Fatal(err)
			}
			if err := hh.h.Close(p.ID, tc.reason); err != nil {
				t.Fatal(err)
			}
			err := hh.h.Show(p)
			if tc.wantTomb != errors.Is(err, ErrTombstoned) {
				t.Fatalf("re-show after %s: err = %v, want tombstoned=%v", tc.reason, err, tc.wantTomb)
			}
			if got := hh.inbox.PromptTombstoned(p.ID); got != tc.wantTomb {
				t.Fatalf("persisted tombstone = %v, want %v", got, tc.wantTomb)
			}
		})
	}
}

func TestReshowablePromptExpiresAndComesBack(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1"))
	p := noticePrompt(t, "notice:test:expire", &promptCalls{})
	p.Reshowable = true
	p.Show.Timing.DeadlineUnixMs = t0.Add(time.Hour).UnixMilli()
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	hh.presented("native-1", showsTo(hh.dir.take(), "native-1")[0])
	hh.tick(2 * time.Hour)
	if hh.h.IsOpen(p.ID) {
		t.Fatal("past its deadline the notice must close")
	}
	if c := closesTo(hh.dir.take(), "native-1"); len(c) != 1 || c[0].Reason != ipc.PromptCloseExpired {
		t.Fatalf("closes = %+v", c)
	}
	p.Show.Timing.DeadlineUnixMs = t0.Add(26 * time.Hour).UnixMilli()
	if err := hh.h.Show(p); err != nil {
		t.Fatalf("an expired reshowable notice must be shown again: %v", err)
	}
}

// An accepted action that leaves the prompt as it was (Open Settings on the
// permission notice: pending -> pending, no new rev) can be taken again;
// it is not answered from the duplicate-click cache without running.
func TestStatePreservingActionRunsEveryTime(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	p := noticePrompt(t, "notice:test:settings", calls)
	p.Kind.Transitions[ipc.PromptStatePending]["open_settings"] = ipc.PromptStatePending
	p.Show.Actions = append(p.Show.Actions, ipc.PromptAction{ID: "open_settings", Label: "Open Settings", Role: ipc.PromptRoleNeutral})
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	s := showsTo(hh.dir.take(), "native-1")[0]
	for i := 1; i <= 2; i++ {
		if res := hh.act("native-1", s.PromptID, s.Rev, s.Lease, "open_settings"); res.Result != ipc.PromptActionAccepted {
			t.Fatalf("click %d = %+v", i, res)
		}
	}
	if _, n, _ := calls.counts(); n != 2 {
		t.Fatalf("Open Settings ran %d times for two clicks", n)
	}
	// A decision still applies once: ok moves the prompt on.
	if res := hh.act("native-1", s.PromptID, s.Rev, s.Lease, "ok"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("ok = %+v", res)
	}
	if res := hh.act("native-1", s.PromptID, s.Rev, s.Lease, "ok"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("a duplicate ok is answered from the cache, still accepted: %+v", res)
	}
	if _, n, _ := calls.counts(); n != 3 {
		t.Fatalf("the duplicate ok ran the domain again (%d calls)", n)
	}
}

// A prompt that only ever went the legacy path (no renderer advertised its
// kind) and has no expiry consequence (no OnExpire: a notice) is reaped at
// its deadline: no record stays in memory forever, its list entry settles
// as expired, and nothing is sent to a renderer that never had it.
func TestLegacyOnlyPromptWithoutOnExpireIsReapedAtItsDeadline(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-old")) // advertised nothing
	calls := &promptCalls{}
	p := noticePrompt(t, "notice:session_ended:s1", calls)
	p.OnExpire = nil
	p.Show.Timing.DeadlineUnixMs = t0.Add(24 * time.Hour).UnixMilli()
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	if legacy, _, _ := calls.counts(); legacy != 1 {
		t.Fatalf("legacy = %d", legacy)
	}
	hh.tick(23 * time.Hour)
	if !hh.h.IsOpen(p.ID) {
		t.Fatal("reaped before its deadline")
	}
	hh.tick(2 * time.Hour)
	if hh.h.IsOpen(p.ID) || hh.h.openCount() != 0 {
		t.Fatal("a legacy-only notice stayed in memory past its deadline")
	}
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("sent %+v to renderers that never had the prompt", msgs)
	}
	entries := hh.inbox.PromptEntries(testOwner.PrincipalKey())
	if len(entries) != 1 || entries[0].Show.State != ipc.PromptStateExpired || len(entries[0].Show.Actions) != 0 {
		t.Fatalf("list entry after the reap = %+v", entries)
	}
	if legacy, _, _ := calls.counts(); legacy != 1 {
		t.Fatalf("the reap re-ran the legacy call (%d)", legacy)
	}
}

// W02 semantics kept: a legacy-only prompt whose domain acts at expiry
// (OnExpire: restart, consent, elevation) is never expired by the host —
// the legacy surface owns its own timeout.
func TestLegacyOnlyPromptWithOnExpireKeepsW02Semantics(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-old"))
	calls := &promptCalls{}
	p := noticePrompt(t, "notice:test:domain", calls)
	p.Show.Timing.DeadlineUnixMs = t0.Add(time.Hour).UnixMilli()
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	hh.tick(2 * time.Hour)
	if _, _, expired := calls.counts(); expired != 0 || !hh.h.IsOpen(p.ID) {
		t.Fatalf("the host expired a legacy-only domain prompt (OnExpire ran %d times, open=%v)", expired, hh.h.IsOpen(p.ID))
	}
}

func TestIsOpenUntilClosedOrDecided(t *testing.T) {
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1"))
	calls := &promptCalls{}
	if hh.h.IsOpen("notice:test:open") {
		t.Fatal("unknown prompt reported open")
	}
	if err := hh.h.Show(noticePrompt(t, "notice:test:open", calls)); err != nil {
		t.Fatal(err)
	}
	if !hh.h.IsOpen("notice:test:open") {
		t.Fatal("a shown prompt is open")
	}
	if err := hh.h.Close("notice:test:open", ipc.PromptCloseWithdrawn); err != nil {
		t.Fatal(err)
	}
	if hh.h.IsOpen("notice:test:open") {
		t.Fatal("a closed prompt is not open")
	}
}

func TestCloseScopeClosesOnlyThatScopesOpenPrompts(t *testing.T) {
	const oldScope, newScope = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	hh := newHarness(t, nativeRenderer("native-1", "notice.info@1"))
	old := noticePrompt(t, "notice:test:old", &promptCalls{})
	old.Show.IdentityRef = &ipc.PromptIdentityRef{ScopeID: oldScope}
	keep := noticePrompt(t, "notice:test:keep", &promptCalls{})
	keep.Show.IdentityRef = &ipc.PromptIdentityRef{ScopeID: newScope}
	unscoped := noticePrompt(t, "notice:test:unscoped", &promptCalls{})
	unscoped.Show.IdentityRef = nil
	for _, p := range []Prompt{old, keep, unscoped} {
		if err := hh.h.Show(p); err != nil {
			t.Fatal(err)
		}
	}
	hh.dir.take()

	if n := hh.h.CloseScope(oldScope, ipc.PromptCloseWithdrawn); n != 1 {
		t.Fatalf("CloseScope closed %d prompts, want 1", n)
	}
	closes := closesTo(hh.dir.take(), "native-1")
	if len(closes) != 1 || closes[0].PromptID != "notice:test:old" || closes[0].Reason != ipc.PromptCloseWithdrawn {
		t.Fatalf("closes = %+v", closes)
	}
	if hh.h.openCount() != 2 {
		t.Fatalf("open prompts = %d, want 2", hh.h.openCount())
	}
	for _, e := range hh.inbox.PromptEntries(testOwner.PrincipalKey()) {
		if e.PromptID == "notice:test:old" {
			t.Fatal("the closed prompt's list entry must be retracted")
		}
	}
	if hh.h.CloseScope("", ipc.PromptCloseWithdrawn) != 0 {
		t.Fatal("an empty scope closes nothing")
	}
}
