package prompthost

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestShowDuringLingerDoesNotRevertTerminalState(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	p := noticePrompt(t, "notice:test:1", calls)
	_ = hh.h.Show(p)
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok") // -> approved, lingering
	hh.dir.take()
	if err := hh.h.Show(p); !errors.Is(err, ErrTombstoned) {
		t.Fatalf("Show during the terminal linger = %v, want ErrTombstoned", err)
	}
	if s := showsTo(hh.dir.take(), "assist-1"); len(s) != 0 {
		t.Fatalf("a decided prompt was redrawn as pending: %+v", s)
	}
}

func TestActionRefusedOrErroredIsRejectedAndRetryable(t *testing.T) {
	for _, tc := range []struct {
		name    string
		outcome ActionOutcome
		err     error
	}{
		{"domain error", ActionOutcome{Accepted: true}, errors.New("boom")},
		{"domain refusal", ActionOutcome{Accepted: false}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
			calls := &promptCalls{outcome: tc.outcome, actErr: tc.err}
			_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
			show := showsTo(hh.dir.take(), "assist-1")[0]
			if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok"); r.Result != ipc.PromptActionRejectedInvalid {
				t.Fatalf("result = %s, want rejected_invalid", r.Result)
			}
			if u := updatesTo(hh.dir.take(), "assist-1"); len(u) != 0 {
				t.Fatalf("a refused action changed the prompt: %+v", u)
			}
			calls.mu.Lock()
			calls.outcome, calls.actErr = ActionOutcome{Accepted: true}, nil
			calls.mu.Unlock()
			if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok"); r.Result != ipc.PromptActionAccepted {
				t.Fatalf("retry after a refusal = %s; a failure must not be cached", r.Result)
			}
			if _, n, _ := calls.counts(); n != 2 {
				t.Fatalf("OnAction ran %d times, want 2", n)
			}
		})
	}
}

func TestConcurrentSameActionRunsDomainOnce(t *testing.T) {
	other := Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"),
		RendererSession{Key: "assist-2", Role: ipc.HelperRoleAssist, Owner: other, Protocol: 1, KindAds: []string{"restart.prompt@1"}})
	var ran atomic.Int32
	release := make(chan struct{})
	p := restartPrompt(t, "restart:42", t0.Add(time.Hour), &promptCalls{})
	p.Owners = []Owner{testOwner, other}
	p.OnAction = func(string, Owner) (ActionOutcome, error) {
		ran.Add(1)
		<-release
		// The host's state lock is not held here: a domain may update its prompt.
		if err := hh.h.Update("restart:42", Patch{Copy: &ipc.PromptCopy{Title: "Restarting"}}); err != nil {
			t.Errorf("Update from inside OnAction: %v", err)
		}
		return ActionOutcome{Accepted: true}, nil
	}
	_ = hh.h.Show(p)
	msgs := hh.dir.take()
	s1, s2 := showsTo(msgs, "assist-1")[0], showsTo(msgs, "assist-2")[0]

	var wg sync.WaitGroup
	results := make([]ipc.PromptActionResult, 2)
	wg.Add(2)
	go func() { defer wg.Done(); results[0] = hh.act("assist-1", s1.PromptID, s1.Rev, s1.Lease, "restart_now") }()
	go func() { defer wg.Done(); results[1] = hh.act("assist-2", s2.PromptID, s2.Rev, s2.Lease, "restart_now") }()
	// Other host traffic must not block on an action in flight.
	done := make(chan struct{})
	go func() {
		hh.h.Tick()
		hh.h.RendererDisconnected("nobody")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the host state lock was held across OnAction")
	}
	close(release)
	wg.Wait()
	if n := ran.Load(); n != 1 {
		t.Fatalf("the domain ran %d times for one decision", n)
	}
	// The same action at the same rev is idempotent (spec §3.1): the second
	// answer gets the first one's result, and the domain ran once.
	if results[0] != results[1] || results[0].Result != ipc.PromptActionAccepted {
		t.Fatalf("results = %+v / %+v, want the same accepted result twice", results[0], results[1])
	}
}

func TestActionRevAndTransitionGuards(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	p := restartPrompt(t, "restart:42", t0.Add(time.Hour), calls)
	p.Kind.Transitions = map[ipc.PromptState]map[string]ipc.PromptState{ipc.PromptStatePending: {"postpone": ipc.PromptStatePending}}
	_ = hh.h.Show(p)
	show := showsTo(hh.dir.take(), "assist-1")[0]
	if r := hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "restart_now"); r.Result != ipc.PromptActionRejectedInvalid {
		t.Fatalf("an action outside the transition table = %s", r.Result)
	}
	if err := hh.h.Update("restart:42", Patch{Copy: &ipc.PromptCopy{Title: "New"}}); err != nil {
		t.Fatal(err)
	}
	if r := hh.act("assist-1", show.PromptID, 1, show.Lease, "postpone"); r.Result != ipc.PromptActionRejectedStale || r.Rev != 2 {
		t.Fatalf("action on rev 1 after an update = %+v, want rejected_stale at rev 2", r)
	}
	if r := hh.act("assist-1", show.PromptID, 9, show.Lease, "postpone"); r.Result != ipc.PromptActionRejectedInvalid {
		t.Fatalf("action on a future rev = %s", r.Result)
	}
	if _, n, _ := calls.counts(); n != 0 {
		t.Fatalf("OnAction ran %d times", n)
	}
}

func TestUpdateAndCloseEdges(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	if err := hh.h.Update("notice:never:1", Patch{}); !errors.Is(err, ErrUnknownPrompt) {
		t.Fatalf("Update(unknown) = %v", err)
	}
	if err := hh.h.Close("notice:never:1", ipc.PromptCloseResolved); !errors.Is(err, ErrUnknownPrompt) {
		t.Fatalf("Close(unknown) = %v", err)
	}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	noSafe := []ipc.PromptAction{{ID: "ok", Label: "OK", Role: ipc.PromptRoleProceed}}
	if err := hh.h.Update("notice:test:1", Patch{Actions: &noSafe}); err == nil {
		t.Fatal("a patch leaving the decision without a safe default was applied")
	}
	if u := updatesTo(hh.dir.take(), "assist-1"); len(u) != 0 {
		t.Fatalf("a refused patch was sent: %+v", u)
	}
	hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok") // approved, lingering
	hh.dir.take()
	if err := hh.h.Update("notice:test:1", Patch{Copy: &ipc.PromptCopy{Title: "x"}}); err == nil {
		t.Fatal("a terminal prompt was updated")
	}
	if err := hh.h.Close("notice:test:1", ipc.PromptCloseResolved); err != nil {
		t.Fatal(err)
	}
	if err := hh.h.Close("notice:test:1", ipc.PromptCloseResolved); err != nil {
		t.Fatalf("a second Close = %v, want nil", err)
	}
	if err := hh.h.Update("notice:test:1", Patch{}); !errors.Is(err, ErrTombstoned) {
		t.Fatalf("Update after Close = %v", err)
	}
	hh.tick(10 * time.Second)
	if c := closesTo(hh.dir.take(), "assist-1"); len(c) != 1 {
		t.Fatalf("closes = %d, want exactly 1 (no double close from the linger)", len(c))
	}
}

func TestOnExpireMovingToTerminalLingersThenCloses(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	p := restartPrompt(t, "restart:42", t0.Add(time.Minute), &promptCalls{})
	p.OnExpire = func() {
		st := ipc.PromptStateExpired
		none := []ipc.PromptAction{}
		if err := hh.h.Update("restart:42", Patch{State: &st, Actions: &none, Copy: &ipc.PromptCopy{Title: "Restarting now"}}); err != nil {
			t.Errorf("Update from OnExpire: %v", err)
		}
	}
	_ = hh.h.Show(p)
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	hh.tick(2 * time.Minute)
	msgs := hh.dir.take()
	if len(closesTo(msgs, "assist-1")) != 0 {
		t.Fatal("closed as expired although OnExpire moved it to a terminal state")
	}
	if u := updatesTo(msgs, "assist-1"); len(u) != 1 || *u[0].State != ipc.PromptStateExpired {
		t.Fatalf("updates = %+v", u)
	}
	hh.tick(8 * time.Second)
	if c := closesTo(hh.dir.take(), "assist-1"); len(c) != 1 || c[0].Reason != ipc.PromptCloseResolved {
		t.Fatalf("after the linger: %+v", c)
	}
}

func TestLegacyOnlyPromptIsTimedByItsLegacyPath(t *testing.T) {
	// Only a prompt that reached a prompt renderer is expired by the host; a
	// legacy-only prompt keeps the legacy path's own timing (today's behaviour).
	hh := newHarness(t)
	calls := &promptCalls{}
	_ = hh.h.Show(restartPrompt(t, "restart:42", t0.Add(time.Minute), calls))
	hh.tick(time.Hour)
	if _, _, n := calls.counts(); n != 0 {
		t.Fatalf("OnExpire fired %d times for a legacy-only prompt", n)
	}
}

func TestRateLimitedCardIsNotFallenBack(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	for i := 0; i < 11; i++ {
		_ = hh.h.Show(noticePrompt(t, "notice:flood:"+string(rune('a'+i)), calls))
	}
	hh.tick(30 * time.Second)
	msgs := hh.dir.take()
	for _, c := range closesTo(msgs, "assist-1") {
		if c.PromptID == "notice:flood:k" {
			t.Fatal("a list-only entry was fenced for missing a present budget it never had")
		}
	}
	if n, _, _ := calls.counts(); n != 10 {
		// The ten cards were never presented and fall back; the list-only one must not.
		t.Fatalf("legacy calls = %d, want 10 (not the list-only 11th)", n)
	}
}

func TestReconnectWithinGraceReplaysToNewAssist(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"), nativeRenderer("user-1", "restart.prompt@1"))
	calls := &promptCalls{}
	deadline := t0.Add(time.Hour)
	_ = hh.h.Show(restartPrompt(t, "restart:42", deadline, calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(3 * time.Second)
	hh.dir.add(assistRenderer("assist-2", "restart.prompt@1"))
	hh.h.RendererConnected(assistRenderer("assist-2", "restart.prompt@1"))
	hh.tick(time.Second)
	msgs := hh.dir.take()
	re := showsTo(msgs, "assist-2")
	if len(re) != 1 || re[0].Timing.DeadlineUnixMs != deadline.UnixMilli() || re[0].Lease.Epoch <= show.Lease.Epoch {
		t.Fatalf("replay = %+v", re)
	}
	if len(showsTo(msgs, "user-1")) != 0 {
		t.Fatal("a native copy was drawn although Assist came back within the grace")
	}
	hh.presented("assist-2", re[0])
	hh.tick(15 * time.Second)
	if s := showsTo(hh.dir.take(), "user-1"); len(s) != 0 {
		t.Fatalf("the cleared grace still fired: %+v", s)
	}
}

func TestNonDecisionDisconnectWaitsForReplay(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "elevation.request@1"))
	calls := &promptCalls{}
	show := loadShow(t, "show.elevation.waiting.json")
	_ = hh.h.Show(Prompt{ID: show.PromptID, Kind: KindSpec{Name: "elevation.request", Version: 1}, Owners: []Owner{testOwner}, Show: show, Legacy: calls.Legacy})
	first := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", first)
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(time.Minute)
	if n, _, _ := calls.counts(); n != 0 {
		t.Fatal("a waiting card fell back to legacy on disconnect")
	}
	hh.dir.add(assistRenderer("assist-2", "elevation.request@1"))
	hh.h.RendererConnected(assistRenderer("assist-2", "elevation.request@1"))
	hh.tick(time.Second)
	if s := showsTo(hh.dir.take(), "assist-2"); len(s) != 1 || s[0].Focus != ipc.PromptFocusNoActivate {
		t.Fatalf("waiting card not replayed: %+v", s)
	}
}

func TestHeadlessCalledOnceAndNoRendererStaysQuiet(t *testing.T) {
	hh := newHarness(t)
	var headless atomic.Int32
	other := Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}
	p := noticePrompt(t, "notice:test:1", &promptCalls{})
	p.Legacy = nil
	p.Headless = func() error { headless.Add(1); return nil }
	p.Owners = []Owner{testOwner, other}
	_ = hh.h.Show(p)
	hh.tick(time.Minute)
	if n := headless.Load(); n != 1 {
		t.Fatalf("headless ran %d times for two owners, want 1", n)
	}

	none := noticePrompt(t, "notice:test:2", &promptCalls{})
	none.Legacy = nil
	if err := hh.h.Show(none); err != nil {
		t.Fatal(err)
	}
	hh.tick(time.Minute)
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("a prompt with no path sent %+v", msgs)
	}
}

func TestSendFailureKeepsListOnlyAndFallsBackOnce(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{}
	for i := 0; i < 10; i++ {
		_ = hh.h.Show(noticePrompt(t, "notice:flood:"+string(rune('a'+i)), calls))
	}
	hh.dir.take()
	hh.dir.failSend = map[string]bool{"assist-1": true}
	_ = hh.h.Show(noticePrompt(t, "notice:flood:k", calls)) // list-only, and its send fails
	hh.dir.failSend = nil
	hh.dir.add(nativeRenderer("user-1", "notice.info@1"))
	hh.tick(time.Second)
	for _, s := range showsTo(hh.dir.take(), "user-1") {
		if s.PromptID == "notice:flood:k" && s.Presentation != ipc.PromptPresentationListOnly {
			t.Fatalf("a failed send turned a rate-limited entry into a card: %s", s.Presentation)
		}
	}
}

func TestListEntriesFollowThePrincipalAcrossSessions(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "notice.info@1"))
	calls := &promptCalls{outcome: ActionOutcome{Accepted: true}}
	_ = hh.h.Show(noticePrompt(t, "notice:test:1", calls))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	hh.act("assist-1", show.PromptID, show.Rev, show.Lease, "ok")
	hh.tick(9 * time.Second) // linger over -> resolved, the outcome stays in the list

	// The same user signs in again into another session id: the outcome follows.
	again := RendererSession{Key: "assist-9", Role: ipc.HelperRoleAssist, Owner: Owner{WinSessionID: 5, UserSID: testOwner.UserSID}, Protocol: 1, KindAds: []string{"notice.info@1"}}
	hh.dir.add(again)
	hh.h.RendererConnected(again)
	hh.tick(time.Second)
	re := showsTo(hh.dir.take(), "assist-9")
	if len(re) != 1 || re[0].Presentation != ipc.PromptPresentationListOnly || re[0].Focus != ipc.PromptFocusNoActivate || re[0].State != ipc.PromptStateApproved {
		t.Fatalf("finished entry replay = %+v", re)
	}

	// Another user in that session never sees it.
	stranger := RendererSession{Key: "assist-10", Role: ipc.HelperRoleAssist, Owner: Owner{WinSessionID: 5, UserSID: "S-1-5-21-7777"}, Protocol: 1, KindAds: []string{"notice.info@1"}}
	hh.dir.add(stranger)
	hh.h.RendererConnected(stranger)
	hh.tick(time.Second)
	if s := showsTo(hh.dir.take(), "assist-10"); len(s) != 0 {
		t.Fatalf("an entry crossed principals: %+v", s)
	}
}

func TestExpiredCloseLeavesNoPendingDecisionInTheList(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	_ = hh.h.Show(restartPrompt(t, "restart:42", t0.Add(time.Minute), &promptCalls{}))
	show := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", show)
	hh.tick(2 * time.Minute)
	for _, e := range hh.inbox.PromptEntries(testOwner.PrincipalKey()) {
		if e.PromptID == "restart:42" && !e.Show.State.Terminal() {
			t.Fatalf("an expired prompt stays in the list as %s with %d actions", e.Show.State, len(e.Show.Actions))
		}
		if err := ipc.ValidatePromptShow(e.Show); err != nil {
			t.Fatalf("the persisted entry is not a drawable show: %v", err)
		}
	}
}
