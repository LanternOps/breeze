package prompthost

import (
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// W05 host seams (#10190): an in-place, localized refresh that never
// re-surfaces a card, the renderer's role on an action, and after-the-fact
// list entries recorded without drawing anything.

// localizedRestart is a restart.prompt whose title depends on the locale.
func localizedRestart(t *testing.T, id, title string, deadline time.Time, calls *promptCalls) Prompt {
	p := restartPrompt(t, id, deadline, calls)
	p.Show.Copy.Title = "en:" + title
	p.Localize = func(loc promptcatalog.Locale) (Localized, error) {
		c := p.Show.Copy
		c.Title = string(loc) + ":" + title
		return Localized{Copy: c, ActionLabels: map[string]string{"restart_now": string(loc) + ":now"}}, nil
	}
	return p
}

func TestRefreshUpdatesInPlaceLocalizedWithoutResurfacing(t *testing.T) {
	r := assistRenderer("assist-1", "restart.prompt@1")
	r.UILocale = "de-DE"
	hh := newHarness(t, r)
	calls := &promptCalls{}
	deadline := t0.Add(time.Hour)
	if err := hh.h.Show(localizedRestart(t, "restart:7", "first", deadline, calls)); err != nil {
		t.Fatal(err)
	}
	first := showsTo(hh.dir.take(), "assist-1")
	if len(first) != 1 || first[0].Copy.Title != "de-DE:first" {
		t.Fatalf("first show = %+v", first)
	}
	hh.presented("assist-1", first[0])

	next := localizedRestart(t, "restart:7", "second", deadline.Add(time.Hour), calls)
	if err := hh.h.Refresh(next); err != nil {
		t.Fatal(err)
	}
	msgs := hh.dir.take()
	if got := showsTo(msgs, "assist-1"); len(got) != 0 {
		t.Fatalf("Refresh re-surfaced the card with a prompt_show: %+v", got)
	}
	ups := updatesTo(msgs, "assist-1")
	if len(ups) != 1 {
		t.Fatalf("updates = %d, want 1", len(ups))
	}
	u := ups[0]
	if u.Rev != first[0].Rev+1 || u.Lease != first[0].Lease {
		t.Fatalf("update rev/lease = %d/%+v, want %d/%+v", u.Rev, u.Lease, first[0].Rev+1, first[0].Lease)
	}
	if u.Copy == nil || u.Copy.Title != "de-DE:second" {
		t.Fatalf("update copy not localized for the session: %+v", u.Copy)
	}
	if u.Timing == nil || u.Timing.DeadlineUnixMs != deadline.Add(time.Hour).UnixMilli() {
		t.Fatalf("update timing = %+v", u.Timing)
	}
	if u.Actions == nil || u.State == nil {
		t.Fatalf("update must carry state and actions: %+v", u)
	}
	for _, a := range *u.Actions {
		if a.ID == "restart_now" && a.Label != "de-DE:now" {
			t.Fatalf("action label not localized: %+v", a)
		}
	}
	// The list entry follows the new content.
	e := hh.inbox.entries[listEntryID("restart:7", testOwner)]
	if e.Show.Copy.Title != "de-DE:second" {
		t.Fatalf("list entry = %q", e.Show.Copy.Title)
	}
	// A click on the old rev is stale; the new rev is honoured.
	if res := hh.act("assist-1", "restart:7", first[0].Rev, first[0].Lease, "postpone"); res.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("old-rev action = %s, want rejected_stale", res.Result)
	}
}

func TestRefreshToTerminalLingersThenClosesResolved(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	calls := &promptCalls{}
	p := restartPrompt(t, "restart:8", t0.Add(time.Hour), calls)
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	hh.dir.take()
	cancelled := p
	cancelled.Show.State = ipc.PromptStateCancelled
	cancelled.Show.Actions = []ipc.PromptAction{}
	cancelled.Show.DefaultActionID = ""
	cancelled.Show.Copy = ipc.PromptCopy{Title: "Restart cancelled", Body: "cancelled"}
	cancelled.Show.Timing.Expiry = nil
	if err := hh.h.Refresh(cancelled); err != nil {
		t.Fatal(err)
	}
	ups := updatesTo(hh.dir.take(), "assist-1")
	if len(ups) != 1 || ups[0].State == nil || *ups[0].State != ipc.PromptStateCancelled {
		t.Fatalf("updates = %+v", ups)
	}
	if err := hh.h.Refresh(cancelled); err == nil {
		t.Fatal("a lingering prompt must refuse another refresh")
	}
	hh.tick(defaultLinger)
	closes := closesTo(hh.dir.take(), "assist-1")
	if len(closes) != 1 || closes[0].Reason != ipc.PromptCloseResolved {
		t.Fatalf("closes = %+v", closes)
	}
	e, ok := hh.inbox.entries[listEntryID("restart:8", testOwner)]
	if !ok || e.Show.State != ipc.PromptStateCancelled || e.Show.Copy.Title != "Restart cancelled" {
		t.Fatalf("the list must keep the cancelled outcome: %+v", e)
	}
}

func TestRefreshUnknownPrompt(t *testing.T) {
	hh := newHarness(t)
	if err := hh.h.Refresh(restartPrompt(t, "restart:404", t0.Add(time.Hour), &promptCalls{})); !errors.Is(err, ErrUnknownPrompt) {
		t.Fatalf("err = %v, want ErrUnknownPrompt", err)
	}
}

func TestRefreshRefusesAnInvalidDecision(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	p := restartPrompt(t, "restart:9", t0.Add(time.Hour), &promptCalls{})
	if err := hh.h.Show(p); err != nil {
		t.Fatal(err)
	}
	bad := p
	bad.Show.Actions = []ipc.PromptAction{{ID: "restart_now", Label: "Restart now", Role: ipc.PromptRoleProceed}}
	bad.Show.DefaultActionID = ""
	if err := hh.h.Refresh(bad); err == nil {
		t.Fatal("a pending decision without a safe default must be refused")
	}
}

func TestOnActionRendererReceivesTheRenderersRole(t *testing.T) {
	for _, tc := range []struct {
		r    RendererSession
		want ipc.HelperRole
	}{
		{assistRenderer("assist-1", "restart.prompt@1"), ipc.HelperRoleAssist},
		{nativeRenderer("native-1", "restart.prompt@1"), ipc.HelperRoleUser},
	} {
		hh := newHarness(t, tc.r)
		p := restartPrompt(t, "restart:10", t0.Add(time.Hour), &promptCalls{})
		p.OnAction = nil
		var gotRole ipc.HelperRole
		var gotOwner Owner
		p.OnActionRenderer = func(actionID string, from Owner, role ipc.HelperRole) (ActionOutcome, error) {
			gotRole, gotOwner = role, from
			return ActionOutcome{Accepted: true}, nil
		}
		if err := hh.h.Show(p); err != nil {
			t.Fatal(err)
		}
		s := showsTo(hh.dir.take(), tc.r.Key)[0]
		hh.presented(tc.r.Key, s)
		if res := hh.act(tc.r.Key, s.PromptID, s.Rev, s.Lease, "postpone"); res.Result != ipc.PromptActionAccepted {
			t.Fatalf("%s: result = %s", tc.r.Key, res.Result)
		}
		if gotRole != tc.want || gotOwner.Key() != testOwner.Key() {
			t.Fatalf("%s: role/owner = %q/%s, want %q", tc.r.Key, gotRole, gotOwner.Key(), tc.want)
		}
	}
}

func TestRecordFinishedPersistsWithoutDrawingAndReplaysListOnly(t *testing.T) {
	r := assistRenderer("assist-1", "notice.info@1")
	r.UILocale = "fr-CA"
	hh := newHarness(t, r)
	show := loadShow(t, "show.notice.json")
	show.PromptID = "notice:restarted:5"
	show.State = ipc.PromptStateApproved
	show.Actions = []ipc.PromptAction{}
	show.DefaultActionID = ""
	p := Prompt{
		ID:     "notice:restarted:5",
		Kind:   KindSpec{Name: "notice.info", Version: 1},
		Owners: []Owner{testOwner},
		Show:   show,
		Localize: func(loc promptcatalog.Locale) (Localized, error) {
			return Localized{Copy: ipc.PromptCopy{Title: string(loc) + ":restarted"}}, nil
		},
	}
	if err := hh.h.RecordFinished(p); err != nil {
		t.Fatal(err)
	}
	if msgs := hh.dir.take(); len(msgs) != 0 {
		t.Fatalf("RecordFinished drew something now: %+v", msgs)
	}
	e, ok := hh.inbox.entries[listEntryID("notice:restarted:5", testOwner)]
	if !ok || e.Show.State != ipc.PromptStateApproved || e.Show.Copy.Title != "fr-CA:restarted" || e.OwnerKey != testOwner.PrincipalKey() {
		t.Fatalf("entry = %+v (ok=%v)", e, ok)
	}
	// Next sign-in: replayed into the list, never activated.
	hh.h.RendererConnected(r)
	hh.h.Tick()
	shows := showsTo(hh.dir.take(), "assist-1")
	if len(shows) != 1 || shows[0].Presentation != ipc.PromptPresentationListOnly || shows[0].Focus != ipc.PromptFocusNoActivate {
		t.Fatalf("replay = %+v", shows)
	}
	// A pending decision is not an after-the-fact entry.
	pending := p
	pending.Show.State = ipc.PromptStatePending
	pending.Show.Actions = []ipc.PromptAction{{ID: "ok", Label: "OK", Role: ipc.PromptRoleSafe}}
	pending.Show.DefaultActionID = "ok"
	if err := hh.h.RecordFinished(pending); err == nil {
		t.Fatal("RecordFinished must refuse a non-terminal state")
	}
}
