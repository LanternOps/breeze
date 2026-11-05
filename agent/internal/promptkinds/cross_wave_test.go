package promptkinds

import (
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// W05 x W06: a restart card (restart.prompt@1, a card) and a remote consent
// (remote.consent@1, a modal decision that is never re-asked) are both live
// for one user session on one native renderer. Neither defers, collapses or
// steals the other's lease; decisions on both race safely through the one
// host (go test -race); losing the renderer withdraws only the consent.

func crossWaveHost(t *testing.T) (*prompthost.Host, *multiDir, *fakeManager, RestartPrompts) {
	t.Helper()
	dir := &multiDir{rs: []prompthost.RendererSession{{
		Key: "native-a", Role: ipc.HelperRoleUser, Owner: ownerA, Protocol: 1,
		KindAds: []string{"notice.info@1", "restart.prompt@1", "restart.final@1", "remote.consent@1", "remote.session@1"},
	}}}
	h := prompthost.New(prompthost.Deps{Broker: dir, Inbox: &entries{m: map[string]prompthost.ListEntry{}}})
	Register(h)
	h.SetEnabledKinds([]string{"restart.prompt", "restart.final", "remote.consent", "remote.session"})
	// The domains gate on KindLive before they take the prompt path, so both
	// waves' kinds must be spoken by this build (Register) at once.
	for _, k := range []string{"restart.prompt", "restart.final", "remote.consent", "remote.session"} {
		if !h.KindLive(k, 1) {
			t.Fatalf("%s@1 is not live: both waves must be registered together", k)
		}
	}
	m := &fakeManager{in: restartInput()}
	m.in.ScheduledAt = time.Now().Add(2 * time.Hour)
	m.in.PostponeUntil = m.in.ScheduledAt.Add(time.Hour)
	return h, dir, m, RestartPrompts{Postpone: m.Postpone, RestartNow: m.RestartNow, Refresh: h.Refresh}
}

// showBoth shows the consent first (the modal) and then the restart card, the
// order in which a card could wrongly be held behind a modal, and returns the
// show each one reached the renderer with.
func showBoth(t *testing.T, h *prompthost.Host, dir *multiDir, m *fakeManager, r RestartPrompts, calls *consentCalls) (consent, restart ipc.PromptShow, consentID, restartID string) {
	t.Helper()
	c := RemoteConsent(consentReq("block", 30_000), consentCfg("block", 30_000), calls.hooks())
	c.Owners = []prompthost.Owner{ownerA}
	if err := h.Show(c); err != nil {
		t.Fatal(err)
	}
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerA}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	shows := map[string]ipc.PromptShow{}
	for _, x := range dir.take("native-a") {
		if s, ok := x.payload.(ipc.PromptShow); ok {
			shows[s.Kind] = s
		}
	}
	consent, okC := shows["remote.consent"]
	restart, okR := shows["restart.prompt"]
	if !okC || !okR {
		t.Fatalf("both cards must reach the one session's renderer; got kinds %v", keysOf(shows))
	}
	if consent.Presentation != ipc.PromptPresentationModal || restart.Presentation != ipc.PromptPresentationCard {
		t.Fatalf("presentations: consent=%s restart=%s", consent.Presentation, restart.Presentation)
	}
	if consent.DefaultActionID != "deny" {
		t.Fatalf("consent default = %q, want deny", consent.DefaultActionID)
	}
	if !h.IsOpen(c.ID) || !h.IsOpen(p.ID) {
		t.Fatalf("both must be open: consent=%v restart=%v", h.IsOpen(c.ID), h.IsOpen(p.ID))
	}
	return consent, restart, c.ID, p.ID
}

func keysOf(m map[string]ipc.PromptShow) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestRestartCardAndRemoteConsentLiveTogether(t *testing.T) {
	h, dir, m, r := crossWaveHost(t)
	calls := &consentCalls{}
	consent, restart, consentID, restartID := showBoth(t, h, dir, m, r, calls)

	// One person answers both at once: Postpone on the card (a Refresh in
	// place, under the host's action lock) and Deny on the consent. The
	// postponement is held inside the restart domain while Deny is sent, so
	// the two decisions really overlap (not merely two goroutines).
	m.gate, m.entered = make(chan struct{}), make(chan struct{}, 1)
	var wg sync.WaitGroup
	var resR, resC ipc.PromptActionResult
	wg.Add(2)
	go func() { defer wg.Done(); resR = actOn(t, h, "native-a", restart, "postpone") }()
	<-m.entered // Postpone is inside the domain call, holding the action lock
	go func() { defer wg.Done(); resC = actOn(t, h, "native-a", consent, "deny") }()
	close(m.gate)
	wg.Wait()

	if resR.Result != ipc.PromptActionAccepted || resC.Result != ipc.PromptActionAccepted {
		t.Fatalf("postpone = %s, deny = %s; each is its own prompt, both must be accepted", resR.Result, resC.Result)
	}
	calls.mu.Lock()
	decided := append([]string(nil), calls.decided...)
	lost := append([]string(nil), calls.lost...)
	calls.mu.Unlock()
	if len(decided) != 1 || decided[0] != "deny" || len(lost) != 0 {
		t.Fatalf("consent decided=%v lost=%v, want exactly one deny", decided, lost)
	}
	m.mu.Lock()
	postpones, restarts := append([]string(nil), m.postpones...), append([]string(nil), m.restarts...)
	m.mu.Unlock()
	if len(postpones) != 1 || postpones[0] != RendererNative || len(restarts) != 0 {
		t.Fatalf("restart domain postpones=%v restarts=%v, want one native postponement", postpones, restarts)
	}
	if h.IsOpen(consentID) {
		t.Fatal("a denied consent is closed")
	}
	if !h.IsOpen(restartID) {
		t.Fatal("deciding the consent must not close the restart card")
	}
	// The postponement reached the card in place; the consent's close never
	// re-surfaced it.
	var restartUpdates int
	for _, x := range dir.take("native-a") {
		switch p := x.payload.(type) {
		case ipc.PromptShow:
			t.Fatalf("no prompt_show after the decisions, got one for %s", p.Kind)
		case ipc.PromptUpdate:
			if p.PromptID == restartID {
				restartUpdates++
				if p.Timing == nil || p.Timing.DeadlineUnixMs != m.in.ScheduledAt.UnixMilli() {
					t.Fatalf("restart update timing = %+v, want the postponed time", p.Timing)
				}
			}
		}
	}
	if restartUpdates == 0 {
		t.Fatal("the restart card got no prompt_update for the postponement")
	}
}

// The renderer drawing both goes away: the consent (NeverReask) is lost at
// once and withdrawn, never moved; the restart card keeps its decision grace
// and stays open for the renderer's return.
func TestRendererLossWithdrawsOnlyTheConsentNotTheRestartCard(t *testing.T) {
	h, dir, m, r := crossWaveHost(t)
	calls := &consentCalls{}
	_, _, consentID, restartID := showBoth(t, h, dir, m, r, calls)

	h.RendererDisconnected("native-a")

	calls.mu.Lock()
	lost := append([]string(nil), calls.lost...)
	calls.mu.Unlock()
	if len(lost) != 1 || lost[0] != "renderer_gone" {
		t.Fatalf("consent lost = %v, want [renderer_gone]", lost)
	}
	if h.IsOpen(consentID) {
		t.Fatal("a lost consent is withdrawn")
	}
	if !h.IsOpen(restartID) {
		t.Fatal("the restart card must survive the consent's loss")
	}
}

// The renderer comes back (a new broker session): the restart card is
// replayed there, non-activating; the consent it had drawn stays withdrawn
// and is never asked again.
func TestReconnectReplaysTheRestartCardButNeverTheConsent(t *testing.T) {
	h, dir, m, r := crossWaveHost(t)
	calls := &consentCalls{}
	_, _, consentID, restartID := showBoth(t, h, dir, m, r, calls)

	h.RendererDisconnected("native-a")
	dir.mu.Lock()
	back := dir.rs[0]
	back.Key = "native-a2"
	dir.rs = []prompthost.RendererSession{back}
	dir.mu.Unlock()
	h.RendererConnected(back)
	h.Tick()

	var restartShows int
	for _, x := range dir.take("native-a2") {
		s, ok := x.payload.(ipc.PromptShow)
		if !ok {
			continue
		}
		switch s.Kind {
		case "remote.consent":
			t.Fatal("a lost consent must never be replayed")
		case "restart.prompt":
			restartShows++
			if s.Focus != ipc.PromptFocusNoActivate || s.Presentation != ipc.PromptPresentationCard {
				t.Fatalf("restart replay focus=%s presentation=%s, want no_activate card", s.Focus, s.Presentation)
			}
		}
	}
	if restartShows != 1 {
		t.Fatalf("restart card replayed %d times, want once", restartShows)
	}
	if h.IsOpen(consentID) || !h.IsOpen(restartID) {
		t.Fatalf("open: consent=%v restart=%v, want false/true", h.IsOpen(consentID), h.IsOpen(restartID))
	}
	calls.mu.Lock()
	defer calls.mu.Unlock()
	if len(calls.decided) != 0 || len(calls.lost) != 1 {
		t.Fatalf("consent decided=%v lost=%v, want lost once and never decided", calls.decided, calls.lost)
	}
}
