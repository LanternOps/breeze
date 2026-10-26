package prompthost

import (
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestShowIsIdempotentByPromptID(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	p := noticePrompt(t, "notice:test:1", calls)
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	p.Show.Copy.Title = "Updated title"
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	shows := showsTo(hh.dir.take(), "assist-1")
	if len(shows) != 2 {
		t.Fatalf("want the replacement re-sent to the same renderer, got %d shows", len(shows))
	}
	if shows[0].Rev != 1 || shows[1].Rev != 2 || shows[1].Copy.Title != "Updated title" {
		t.Fatalf("revs/titles = %d %d %q", shows[0].Rev, shows[1].Rev, shows[1].Copy.Title)
	}
	if shows[0].Lease != shows[1].Lease {
		t.Fatalf("a replacement must keep the lease (same window): %+v vs %+v", shows[0].Lease, shows[1].Lease)
	}
	if n := hh.h.openCount(); n != 1 {
		t.Fatalf("open prompts = %d, want 1", n)
	}

	// Legacy has no replace: a second Show must not draw a second legacy window.
	legacy := newHarness(t)
	lc := &promptCalls{}
	lp := noticePrompt(t, "notice:test:2", lc)
	_ = legacy.h.Show(lp)
	_ = legacy.h.Show(lp)
	if n, _, _ := lc.counts(); n != 1 {
		t.Fatalf("legacy sender called %d times, want 1", n)
	}
}

func TestDecisionWithoutSingleSafeDefaultRefused(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	p := noticePrompt(t, "notice:test:1", calls)
	p.Show.Actions = []ipc.PromptAction{{ID: "ok", Label: "OK", Role: ipc.PromptRoleProceed}}
	if err := hh.h.Show(p); err == nil {
		t.Fatal("Show accepted a decision without a single safe default")
	}
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("sent %d messages for a refused prompt", len(msgs))
	}
	if n, _, _ := calls.counts(); n != 0 {
		t.Fatal("legacy sender called for a refused prompt")
	}
	if hh.h.openCount() != 0 {
		t.Fatal("a refused prompt was recorded")
	}
}

func TestStaleLeaseActionRejected(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	if err := hh.h.Show(noticePrompt(t, "notice:test:1", calls)); err != nil {
		t.Fatal(err)
	}
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)

	stale := show.Lease
	stale.Epoch++
	if r := hh.act("assist-1", show.PromptID, show.Rev, stale, "ok"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("wrong epoch: %s", r.Result)
	}
	other := ipc.PromptLease{RendererSession: "assist-1", Epoch: show.Lease.Epoch}
	if r := hh.act("user-1", show.PromptID, show.Rev, other, "ok"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("lease presented by another renderer: %s", r.Result)
	}
	if r := hh.act("assist-1", "notice:unknown:1", 1, show.Lease, "ok"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("unknown prompt: %s", r.Result)
	}
	if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "not_an_action"); r.Result != ipc.PromptActionRejectedInvalid {
		t.Fatalf("unknown action: %s", r.Result)
	}
	if _, n, _ := calls.counts(); n != 0 {
		t.Fatalf("OnAction ran %d times for rejected actions", n)
	}
}

func TestDuplicateActionAcceptedOnce(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)

	first := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok")
	second := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok")
	if first.Result != ipc.PromptActionAccepted || second != first {
		t.Fatalf("first %+v, second %+v; want the same accepted result twice", first, second)
	}
	if _, n, _ := calls.counts(); n != 1 {
		t.Fatalf("OnAction ran %d times, want 1", n)
	}
	// The transition table moved pending -> approved: the renderer got the new state.
	ups := updatesTo(hh.dir.take(), "assist-1")
	if len(ups) != 1 || ups[0].State == nil || *ups[0].State != ipc.PromptStateApproved || ups[0].Rev != first.Rev {
		t.Fatalf("updates = %+v, result rev %d", ups, first.Rev)
	}
}

func TestPresentBudgetMissFallsBack(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"), nativeRenderer("user-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	first := showsTo(hh.dir.take(), "assist-1")
	if len(first) != 1 {
		t.Fatalf("Assist is preferred: got %d shows to it", len(first))
	}
	hh.tick(9 * time.Second)
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("fell back before the present budget ran out: %+v", msgs)
	}
	hh.tick(1 * time.Second)
	msgs := hh.dir.take()
	fence := closesTo(msgs, "assist-1")
	if len(fence) != 1 || fence[0].Reason != ipc.PromptCloseFenced || fence[0].Lease != first[0].Lease {
		t.Fatalf("fence = %+v", fence)
	}
	native := showsTo(msgs, "user-1")
	if len(native) != 1 || native[0].Lease.Epoch <= first[0].Lease.Epoch || native[0].Lease.RendererSession != "user-1" {
		t.Fatalf("native show = %+v", native)
	}
	// The fenced Assist can no longer act.
	if r := hh.act("assist-1", first[0].PromptID, native[0].Rev, first[0].Lease, "ok"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("fenced renderer action = %s", r.Result)
	}
}

func TestStalePresentedFromFencedRendererIgnored(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"), nativeRenderer("user-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	first := showsTo(hh.dir.take(), "assist-1")[0]
	hh.tick(10 * time.Second) // Assist missed its budget -> native
	if len(showsTo(hh.dir.take(), "user-1")) != 1 {
		t.Fatal("no native fallback")
	}
	hh.presented("assist-1", first) // late, on the fenced lease
	hh.tick(10 * time.Second)       // the native copy was never presented either
	if n, _, _ := calls.counts(); n != 1 {
		t.Fatalf("a fenced renderer's prompt_presented counted (legacy calls %d, want 1)", n)
	}
}

func TestSendFailureFallsBackAtNextTick(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	hh.dir.failSend = map[string]bool{"assist-1": true}
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	hh.tick(time.Second)
	if n, _, _ := calls.counts(); n != 1 {
		t.Fatalf("a show that never left did not fall back (legacy calls %d)", n)
	}
}

func TestRenderFailedFallsBackImmediately(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.closed("assist-1", show, ipc.PromptClosedRenderFailed)
	if n, _, _ := calls.counts(); n != 1 {
		t.Fatalf("render_failed did not fall back to the legacy sender (legacy calls %d)", n)
	}
}

func TestHiddenIsNotADomainAction(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	hh.closed("assist-1", show, ipc.PromptClosedHidden)
	hh.tick(time.Minute)
	if l, a, _ := calls.counts(); l != 0 || a != 0 {
		t.Fatalf("hiding ran the domain (legacy %d, actions %d)", l, a)
	}
	if hh.h.openCount() != 1 {
		t.Fatal("a hidden prompt must stay open")
	}
}

func TestAssistDisconnectGraceThenNativeWithRemainingBudget(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"), nativeRenderer("user-1", "restart.prompt@1"))
	calls := &promptCalls{}
	deadline := t0.Add(30 * time.Minute)
	_ = hh.h.Show(restartPrompt(t, "restart:42", deadline, calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)

	hh.clock.Advance(5 * time.Minute)
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(9 * time.Second)
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("re-shown before the 10 s grace ran out: %+v", msgs)
	}
	hh.tick(1 * time.Second)
	native := showsTo(hh.dir.take(), "user-1")
	if len(native) != 1 {
		t.Fatalf("want the decision re-shown on the native renderer, got %d", len(native))
	}
	if native[0].Timing.DeadlineUnixMs != deadline.UnixMilli() {
		t.Fatalf("deadline changed across the fallback: %d != %d", native[0].Timing.DeadlineUnixMs, deadline.UnixMilli())
	}
	if native[0].Lease.Epoch <= show.Lease.Epoch {
		t.Fatalf("epoch not bumped before the move: %d", native[0].Lease.Epoch)
	}
}

func TestRemainingBudgetPreservedAcrossFallback(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "remote.consent@1"), nativeRenderer("user-1", "remote.consent@1"))
	calls := &promptCalls{}
	show := loadShow(t, "show.notice.json")
	show.PromptID = "consent:abc"
	show.Kind = "remote.consent"
	show.Presentation = ipc.PromptPresentationModal
	show.Focus = ipc.PromptFocusSteal
	show.Actions = []ipc.PromptAction{{ID: "allow", Label: "Allow", Role: ipc.PromptRoleProceed}, {ID: "deny", Label: "Deny", Role: ipc.PromptRoleSafe}}
	show.DefaultActionID = "deny"
	show.Timing = ipc.PromptTiming{PresentWithinMs: 10000, ResponseMs: 30000}
	_ = hh.h.Show(Prompt{ID: "consent:abc", Kind: KindSpec{Name: "remote.consent", Version: 1}, Owners: []Owner{testOwner}, Show: show, Legacy: calls.Legacy, OnAction: calls.OnAction, OnExpire: calls.OnExpire})
	first := showsTo(hh.dir.take(), "assist-1")[0]
	if first.Timing.ResponseMs != 30000 || first.Timing.DeadlineUnixMs != 0 {
		t.Fatalf("first show must carry the response window: %+v", first.Timing)
	}
	hh.clock.Advance(2 * time.Second)
	presentedAt := hh.clock.Now()
	hh.presented("assist-1", first)

	hh.clock.Advance(3 * time.Second)
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(10 * time.Second)
	native := showsTo(hh.dir.take(), "user-1")
	if len(native) != 1 {
		t.Fatalf("native shows = %d", len(native))
	}
	if native[0].Timing.ResponseMs != 0 || native[0].Timing.DeadlineUnixMs != presentedAt.Add(30*time.Second).UnixMilli() {
		t.Fatalf("the response window restarted on the new renderer: %+v (want an absolute deadline at %d)", native[0].Timing, presentedAt.Add(30*time.Second).UnixMilli())
	}
}

func TestReconnectClosesNativeCopyAndReplaysWithoutActivation(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"), nativeRenderer("user-1", "restart.prompt@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(restartPrompt(t, "restart:1", t0.Add(time.Hour), calls))
	hh.clock.Advance(time.Second)
	_ = hh.h.Show(restartPrompt(t, "restart:2", t0.Add(time.Hour), calls))
	for _, s := range showsTo(hh.dir.take(), "assist-1") {
		hh.presented("assist-1", s)
	}
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(10 * time.Second)
	natives := showsTo(hh.dir.take(), "user-1")
	if len(natives) != 2 {
		t.Fatalf("native shows = %d, want 2", len(natives))
	}

	hh.dir.add(assistRenderer("assist-2", "restart.prompt@1"))
	hh.h.RendererConnected(assistRenderer("assist-2", "restart.prompt@1"))
	hh.tick(time.Second)
	msgs := hh.dir.take()
	if fences := closesTo(msgs, "user-1"); len(fences) != 2 || fences[0].Reason != ipc.PromptCloseFenced {
		t.Fatalf("native copies not fenced: %+v", fences)
	}
	replayed := showsTo(msgs, "assist-2")
	if len(replayed) != 2 {
		t.Fatalf("replayed = %d, want 2", len(replayed))
	}
	surfaces := 0
	for _, s := range replayed {
		if s.Focus != ipc.PromptFocusNoActivate {
			t.Fatalf("replay activated a window: %+v", s.Focus)
		}
		if s.Presentation != ipc.PromptPresentationListOnly {
			surfaces++
			if s.PromptID != "restart:1" {
				t.Fatalf("restored %s, want the oldest pending decision restart:1", s.PromptID)
			}
		}
		for _, n := range natives {
			if n.PromptID == s.PromptID && s.Lease.Epoch <= n.Lease.Epoch {
				t.Fatalf("replay did not take a new lease: %d <= %d", s.Lease.Epoch, n.Lease.Epoch)
			}
		}
	}
	if surfaces != 1 {
		t.Fatalf("restored %d decision surfaces, want exactly 1", surfaces)
	}
}

func TestTombstoneBlocksResurrection(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok"); r.Result != ipc.PromptActionAccepted {
		t.Fatal(r.Result)
	}
	hh.tick(7 * time.Second)
	if c := closesTo(hh.dir.take(), "assist-1"); len(c) != 0 {
		t.Fatalf("closed before the 8 s linger: %+v", c)
	}
	hh.tick(time.Second)
	if c := closesTo(hh.dir.take(), "assist-1"); len(c) != 1 || c[0].Reason != ipc.PromptCloseResolved {
		t.Fatalf("linger close = %+v", c)
	}
	if err := hh.h.Show(noticePrompt(t, "notice:test:1", calls)); !errors.Is(err, ErrTombstoned) {
		t.Fatalf("re-Show of a decided prompt = %v, want ErrTombstoned", err)
	}
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("a tombstoned prompt was drawn: %+v", msgs)
	}
	if !hh.inbox.PromptTombstoned("notice:test:1") {
		t.Fatal("tombstone not persisted to the inbox")
	}

	// A persisted tombstone blocks a new host process too (agent restart).
	fresh := New(Deps{Broker: hh.dir, Inbox: hh.inbox, Clock: hh.clock})
	fresh.SetEnabledKinds([]string{"notice.info"})
	if err := fresh.Show(noticePrompt(t, "notice:test:1", calls)); !errors.Is(err, ErrTombstoned) {
		t.Fatalf("restarted host resurrected a decided prompt: %v", err)
	}

	// Explicit Close tombstones too.
	_ = hh.h.Show(noticePrompt(t, "notice:test:2", calls))
	_ = hh.h.Close("notice:test:2", ipc.PromptCloseWithdrawn)
	if err := hh.h.Show(noticePrompt(t, "notice:test:2", calls)); !errors.Is(err, ErrTombstoned) {
		t.Fatalf("re-Show after Close = %v", err)
	}
}

func TestDisableKindMidDecisionKeepsPresentedPrompt(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"), nativeRenderer("user-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	_ = hh.h.Show(noticePrompt(t, "notice:test:2", calls))
	shows := showsTo(hh.dir.take(), "assist-1")
	hh.presented("assist-1", shows[0]) // only the first was presented

	hh.h.SetEnabledKinds(nil) // kill switch
	hh.tick(20 * time.Second)
	msgs := hh.dir.take()
	for _, c := range closesTo(msgs, "assist-1") {
		if c.PromptID == "notice:test:1" {
			t.Fatal("the kill switch closed a presented prompt (P15)")
		}
	}
	if len(showsTo(msgs, "user-1")) != 0 {
		t.Fatal("a kind disabled mid-flight must not move to another prompt renderer")
	}
	// The never-presented one fell back when its present budget ran out — to legacy.
	if n, _, _ := calls.counts(); n != 1 {
		t.Fatalf("legacy calls = %d, want 1 (the unpresented prompt)", n)
	}
	if r := hh.act("assist-1", shows[0].PromptID, shows[0].Rev, shows[0].Lease, "ok"); r.Result != ipc.PromptActionAccepted {
		t.Fatalf("presented prompt can still be answered: %s", r.Result)
	}
}

func TestAbsoluteDeadlineFiresAfterSleepPastIt(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(restartPrompt(t, "restart:42", t0.Add(time.Minute), calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)

	hh.tick(2 * time.Hour) // the laptop slept across the deadline
	hh.h.Tick()
	hh.tick(time.Second)
	if _, _, n := calls.counts(); n != 1 {
		t.Fatalf("OnExpire fired %d times, want exactly 1", n)
	}
	closes := closesTo(hh.dir.take(), "assist-1")
	if len(closes) != 1 || closes[0].Reason != ipc.PromptCloseExpired {
		t.Fatalf("closes = %+v, want one expired", closes)
	}
	if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "postpone"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("an action after expiry = %s, want rejected_stale", r.Result)
	}
}

func TestExpiryBeforeDeadlineDoesNotFire(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(restartPrompt(t, "restart:42", t0.Add(time.Minute), calls))
	hh.tick(59 * time.Second)
	if _, _, n := calls.counts(); n != 0 {
		t.Fatal("expired early")
	}
}

func TestCardRateLimitGoesListOnly(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	for i := 0; i < 11; i++ {
		_ = hh.h.Show(noticePrompt(t, "notice:flood:"+string(rune('a'+i)), calls))
		hh.clock.Advance(time.Second)
	}
	shows := showsTo(hh.dir.take(), "assist-1")
	if len(shows) != 11 {
		t.Fatalf("shows = %d", len(shows))
	}
	for i, s := range shows[:10] {
		if s.Presentation != ipc.PromptPresentationCard {
			t.Fatalf("card %d presented as %s", i, s.Presentation)
		}
	}
	if shows[10].Presentation != ipc.PromptPresentationListOnly {
		t.Fatalf("11th card in 10 minutes = %s, want list_only", shows[10].Presentation)
	}
	hh.clock.Advance(10 * time.Minute)
	_ = hh.h.Show(noticePrompt(t, "notice:flood:z", calls))
	if s := showsTo(hh.dir.take(), "assist-1"); len(s) != 1 || s[0].Presentation != ipc.PromptPresentationCard {
		t.Fatalf("after the window: %+v", s)
	}
}

func TestOneModalAtATime(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "remote.consent@1"))
	calls := &promptCalls{}
	mk := func(id string) Prompt {
		show := loadShow(t, "show.notice.json")
		show.PromptID = id
		show.Kind = "remote.consent"
		show.Presentation = ipc.PromptPresentationModal
		show.Actions = []ipc.PromptAction{{ID: "allow", Label: "Allow", Role: ipc.PromptRoleProceed}, {ID: "deny", Label: "Deny", Role: ipc.PromptRoleSafe}}
		show.DefaultActionID = "deny"
		return Prompt{ID: id, Kind: KindSpec{Name: "remote.consent", Version: 1}, Owners: []Owner{testOwner}, Show: show, Legacy: calls.Legacy}
	}
	_ = hh.h.Show(mk("consent:a"))
	_ = hh.h.Show(mk("consent:b"))
	if s := showsTo(hh.dir.take(), "assist-1"); len(s) != 1 || s[0].PromptID != "consent:a" {
		t.Fatalf("second modal was not queued: %+v", s)
	}
	_ = hh.h.Close("consent:a", ipc.PromptCloseResolved)
	hh.tick(time.Second)
	if s := showsTo(hh.dir.take(), "assist-1"); len(s) != 1 || s[0].PromptID != "consent:b" {
		t.Fatalf("queued modal not shown after the first closed: %+v", s)
	}
}

func TestLockedSessionDefersUntilUnlock(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	hh.h.SessionStateChanged(1, SessionLocked)
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	hh.tick(time.Minute)
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("drew on a locked session: %+v", msgs)
	}
	if n, _, _ := calls.counts(); n != 0 {
		t.Fatal("a locked session must not fall back to legacy")
	}
	hh.h.SessionStateChanged(1, SessionUnlocked)
	hh.tick(time.Second)
	if s := showsTo(hh.dir.take(), "assist-1"); len(s) != 1 {
		t.Fatalf("not shown at unlock: %d", len(s))
	}
}

func TestListEntryPersistedPerOwnerAndRetractedOnWithdraw(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	entries := hh.inbox.PromptEntries(testOwner.Key())
	if len(entries) != 1 || entries[0].PromptID != "notice:test:1" || entries[0].ScopeID != "bad7313391508e4129c338752b2cc809" {
		t.Fatalf("entries = %+v", entries)
	}
	if other := hh.inbox.PromptEntries(Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}.Key()); len(other) != 0 {
		t.Fatal("an entry leaked to another owner")
	}
	_ = hh.h.Close("notice:test:1", ipc.PromptCloseWithdrawn)
	if e := hh.inbox.PromptEntries(testOwner.Key()); len(e) != 0 {
		t.Fatalf("withdrawn entry kept: %+v", e)
	}
}

func TestOwnerKeyIgnoresLogonButMatchesUsesIt(t *testing.T) {
	a := Owner{WinSessionID: 1, UserSID: "S-1", LogonID: "0x1"}
	b := Owner{WinSessionID: 1, UserSID: "S-1", LogonID: "0x2"}
	if a.Key() != b.Key() {
		t.Fatal("Key must not depend on the logon id (the broker cannot observe it)")
	}
	if a.Matches(b) {
		t.Fatal("two different logons of the same user in the same session must not match")
	}
	if !a.Matches(Owner{WinSessionID: 1, UserSID: "S-1"}) {
		t.Fatal("an owner without a logon id matches on session + SID")
	}
	if (Owner{UID: 501}).Key() == (Owner{UID: 502}).Key() {
		t.Fatal("unix owners must differ by uid")
	}
}

func TestConcurrentDecisionsFromTwoSessionsFirstWins(t *testing.T) {
	other := Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}
	r2 := RendererSession{Key: "assist-2", Role: ipc.HelperRoleAssist, Owner: other, Protocol: 1, KindAds: []string{"restart.prompt@1"}}
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"), r2)
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	p := restartPrompt(t, "restart:42", t0.Add(time.Hour), calls)
	p.Owners = []Owner{testOwner, other}
	_ = hh.h.Show(p)
	msgs := hh.dir.take()
	s1, s2 := showsTo(msgs, "assist-1")[0], showsTo(msgs, "assist-2")[0]
	if s1.Lease == s2.Lease {
		t.Fatal("each session holds its own lease")
	}
	r1 := hh.act("assist-1", s1.PromptID, s1.Rev, s1.Lease, "restart_now")
	rr2 := hh.act("assist-2", s2.PromptID, s2.Rev, s2.Lease, "postpone")
	if r1.Result != ipc.PromptActionAccepted || rr2.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("first %s, second %s; want accepted then rejected_stale", r1.Result, rr2.Result)
	}
	if _, n, _ := calls.counts(); n != 1 {
		t.Fatalf("OnAction ran %d times", n)
	}
	if ups := updatesTo(hh.dir.take(), "assist-2"); len(ups) != 1 || ups[0].State == nil || *ups[0].State != ipc.PromptStateApproved {
		t.Fatalf("the other session did not get the outcome: %+v", ups)
	}
}
