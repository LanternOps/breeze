package heartbeat

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// The restart card over a real prompt host (#10190 W05, plan Task 5.1).

type rcSent struct {
	key, typ string
	payload  any
}

type rcDir struct {
	mu   sync.Mutex
	rs   []prompthost.RendererSession
	sent []rcSent
}

func (d *rcDir) Renderers(o prompthost.Owner) []prompthost.RendererSession {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []prompthost.RendererSession
	for _, r := range d.rs {
		if r.Owner.Key() == o.Key() {
			out = append(out, r)
		}
	}
	return out
}

func (d *rcDir) Send(key, msgType, _ string, payload any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sent = append(d.sent, rcSent{key, msgType, payload})
	return nil
}

func (d *rcDir) take() []rcSent {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := d.sent
	d.sent = nil
	return out
}

func rcShows(msgs []rcSent, key string) []ipc.PromptShow {
	var out []ipc.PromptShow
	for _, m := range msgs {
		if s, ok := m.payload.(ipc.PromptShow); ok && m.key == key {
			out = append(out, s)
		}
	}
	return out
}

func rcUpdates(msgs []rcSent, key string) []ipc.PromptUpdate {
	var out []ipc.PromptUpdate
	for _, m := range msgs {
		if u, ok := m.payload.(ipc.PromptUpdate); ok && m.key == key {
			out = append(out, u)
		}
	}
	return out
}

func rcCloses(msgs []rcSent, key string) []ipc.PromptClose {
	var out []ipc.PromptClose
	for _, m := range msgs {
		if c, ok := m.payload.(ipc.PromptClose); ok && m.key == key {
			out = append(out, c)
		}
	}
	return out
}

type rcInbox struct {
	mu sync.Mutex
	m  map[string]prompthost.ListEntry
}

func (e *rcInbox) PutPrompt(x prompthost.ListEntry) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.m[x.ID] = x
	return nil
}
func (e *rcInbox) RetractPrompt(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.m, id)
	return nil
}
func (e *rcInbox) TombstonePrompt(string) error { return nil }
func (e *rcInbox) PromptTombstoned(string) bool { return false }
func (e *rcInbox) PromptEntries(owner string) []prompthost.ListEntry {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []prompthost.ListEntry
	for _, x := range e.m {
		if x.OwnerKey == owner {
			out = append(out, x)
		}
	}
	return out
}
func (e *rcInbox) get(id string) (prompthost.ListEntry, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	x, ok := e.m[id]
	return x, ok
}

type rcClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *rcClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *rcClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type rcDecider struct {
	mu        sync.Mutex
	rung      patching.RestartRung
	postpones []string
	restarts  []string
}

func (d *rcDecider) UserPostpone(campaign uint64, renderer string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.postpones = append(d.postpones, renderer)
	d.rung.ScheduledAt = d.rung.PostponeUntil
	d.rung.PostponeUntil = d.rung.ScheduledAt.Add(time.Hour)
	d.rung.DeferralsLeft--
	return nil
}
func (d *rcDecider) UserRestartNow(campaign uint64, renderer string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.restarts = append(d.restarts, renderer)
	return nil
}
func (d *rcDecider) RestartRungNow(campaign uint64) (patching.RestartRung, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	r := d.rung
	r.Resurface = false
	// The real manager's snapshot carries no rung copy (only a rung does).
	r.LegacyTitle, r.LegacyBody, r.LegacyUrgency = "", "", ""
	return r, true
}

var (
	rcOwnerA = prompthost.Owner{WinSessionID: 1, UserSID: "S-1-5-21-2001"}
	rcOwnerB = prompthost.Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}
	rcNow    = time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
)

type rcFixture struct {
	card    *restartCard
	host    *prompthost.Host
	dir     *rcDir
	inbox   *rcInbox
	clock   *rcClock
	decider *rcDecider
	toasts  []prompthost.Owner
	reqs    []ipc.NotifyRequest
	owners  []prompthost.Owner
}

func newRCFixture(t *testing.T, enabled ...string) *rcFixture {
	t.Helper()
	f := &rcFixture{
		dir: &rcDir{rs: []prompthost.RendererSession{
			{Key: "assist-a", Role: ipc.HelperRoleAssist, Owner: rcOwnerA, Protocol: 1, KindAds: []string{"notice.info@1", "restart.prompt@1", "restart.final@1"}},
			// B runs a helper that predates W05: it advertises no restart kind.
			{Key: "old-b", Role: ipc.HelperRoleUser, Owner: rcOwnerB, Protocol: 1, KindAds: []string{"notice.info@1"}},
		}},
		inbox:  &rcInbox{m: map[string]prompthost.ListEntry{}},
		clock:  &rcClock{t: rcNow},
		owners: []prompthost.Owner{rcOwnerA, rcOwnerB},
	}
	f.host = prompthost.New(prompthost.Deps{Broker: f.dir, Inbox: f.inbox, Clock: f.clock})
	promptkinds.Register(f.host)
	f.host.SetEnabledKinds(enabled)
	f.decider = &rcDecider{rung: f.rung()}
	f.card = &restartCard{
		host:   f.host,
		mgr:    f.decider,
		owners: func() []prompthost.Owner { return f.owners },
		notify: func(o prompthost.Owner, req ipc.NotifyRequest) error {
			f.toasts = append(f.toasts, o)
			f.reqs = append(f.reqs, req)
			return nil
		},
	}
	return f
}

func (f *rcFixture) rung() patching.RestartRung {
	return patching.RestartRung{
		Campaign:        1793019600000,
		Resurface:       true,
		ScheduledAt:     rcNow.Add(2 * time.Hour),
		PostponeUntil:   rcNow.Add(3 * time.Hour),
		DeferralAllowed: true,
		DeferralsLeft:   3,
		LegacyTitle:     "Restart Scheduled",
		LegacyBody:      "A system restart for updates is scheduled in 2 hours. Please save your work.",
		LegacyUrgency:   "normal",
	}
}

func TestRestartCardOnlyWhereAllThreeSwitchesAreOn(t *testing.T) {
	f := newRCFixture(t, "notice.info", "restart.prompt", "restart.final")
	if !f.card.ShowRung(f.rung()) {
		t.Fatal("A can draw the card: the rung must be taken")
	}
	msgs := f.dir.take()
	shows := rcShows(msgs, "assist-a")
	if len(shows) != 1 || shows[0].Kind != "restart.prompt" || shows[0].DefaultActionID != "postpone" {
		t.Fatalf("A = %+v", shows)
	}
	if !strings.HasPrefix(shows[0].Copy.Body, "Your IT support team needs to restart") {
		t.Fatalf("body = %q", shows[0].Copy.Body)
	}
	if len(rcShows(msgs, "old-b")) != 0 {
		t.Fatal("B's helper did not advertise restart.prompt and must not get prompt_*")
	}
	if len(f.toasts) != 1 || f.toasts[0].Key() != rcOwnerB.Key() {
		t.Fatalf("B gets today's warning as a toast: %v", f.toasts)
	}
}

func TestRestartFallsBackToLegacyWhenDisabled(t *testing.T) {
	f := newRCFixture(t, "notice.info") // the kill switch: restart off
	if f.card.ShowRung(f.rung()) {
		t.Fatal("no session can draw the card: the rung must go out today's way")
	}
	if n := len(f.dir.take()); n != 0 || len(f.toasts) != 0 {
		t.Fatalf("a declined rung sent %d prompt messages and %d toasts", n, len(f.toasts))
	}
}

func TestLockedRungListOnlyThenCardAtUnlockSameDeadline(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	f.host.SessionStateChanged(rcOwnerA.WinSessionID, prompthost.SessionLocked)
	r := f.rung()
	if !f.card.ShowRung(r) {
		t.Fatal("the rung must be taken while locked (held, not sent today's way)")
	}
	if shows := rcShows(f.dir.take(), "assist-a"); len(shows) != 0 {
		t.Fatalf("a locked session got the card: %+v", shows)
	}
	id := promptkinds.RestartPromptID(r.Campaign)
	if _, ok := f.inbox.get(id + "#" + rcOwnerA.PrincipalKey()); !ok {
		t.Fatal("the list entry must be written while the session is locked")
	}
	f.clock.advance(20 * time.Minute)
	f.host.SessionStateChanged(rcOwnerA.WinSessionID, prompthost.SessionUnlocked)
	f.host.Tick()
	shows := rcShows(f.dir.take(), "assist-a")
	if len(shows) != 1 {
		t.Fatalf("the card must be drawn at unlock: %d shows", len(shows))
	}
	if shows[0].Timing.DeadlineUnixMs != r.ScheduledAt.UnixMilli() {
		t.Fatalf("deadline moved for presentation: %d, want %d", shows[0].Timing.DeadlineUnixMs, r.ScheduledAt.UnixMilli())
	}
}

func TestCancelPendingWithdrawsAndLists(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	r := f.rung()
	f.card.ShowRung(r)
	f.dir.take()
	f.card.Cancelled(r.Campaign + 1) // another campaign: ignored
	if n := len(f.dir.take()); n != 0 {
		t.Fatalf("a cancel for another campaign sent %d messages", n)
	}
	f.card.Cancelled(r.Campaign)
	ups := rcUpdates(f.dir.take(), "assist-a")
	if len(ups) != 1 || ups[0].State == nil || *ups[0].State != ipc.PromptStateCancelled || len(*ups[0].Actions) != 0 {
		t.Fatalf("cancel update = %+v", ups)
	}
	if ups[0].Copy == nil || ups[0].Copy.Body != "Your IT support team cancelled the restart." {
		t.Fatalf("cancel copy = %+v", ups[0].Copy)
	}
	f.clock.advance(9 * time.Second)
	f.host.Tick()
	if c := rcCloses(f.dir.take(), "assist-a"); len(c) != 1 || c[0].Reason != ipc.PromptCloseResolved {
		t.Fatalf("closes = %+v", c)
	}
	e, ok := f.inbox.get(promptkinds.RestartPromptID(r.Campaign) + "#" + rcOwnerA.PrincipalKey())
	if !ok || e.Show.State != ipc.PromptStateCancelled || e.Show.Copy.Title != "Restart cancelled" {
		t.Fatalf("the list keeps 'Restart cancelled': %+v (%v)", e.Show, ok)
	}
}

func TestFinalRungReplacesTheCardWithTheClosingCard(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	r := f.rung()
	f.card.ShowRung(r)
	f.dir.take()
	final := r
	final.Final, final.PostponeUntil = true, time.Time{}
	final.ScheduledAt = rcNow.Add(time.Minute)
	if !f.card.ShowRung(final) {
		t.Fatal("the closing rung must be taken")
	}
	msgs := f.dir.take()
	if c := rcCloses(msgs, "assist-a"); len(c) != 1 || c[0].PromptID != promptkinds.RestartPromptID(r.Campaign) || c[0].Reason != ipc.PromptCloseSuperseded {
		t.Fatalf("the card must close superseded: %+v", c)
	}
	shows := rcShows(msgs, "assist-a")
	if len(shows) != 1 || shows[0].Kind != "restart.final" || shows[0].Focus != ipc.PromptFocusSteal {
		t.Fatalf("closing card = %+v", shows)
	}
}

func TestQuietLeadAfterPostponeRefreshesInPlace(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	r := f.rung()
	f.card.ShowRung(r)
	f.dir.take()
	quiet := r
	quiet.Resurface = false
	quiet.ScheduledAt = r.PostponeUntil
	quiet.PostponeUntil = r.PostponeUntil.Add(time.Hour)
	f.card.ShowRung(quiet)
	msgs := f.dir.take()
	if len(rcShows(msgs, "assist-a")) != 0 {
		t.Fatal("the lead rung a postponement re-planned must not re-surface the card (#4941)")
	}
	ups := rcUpdates(msgs, "assist-a")
	if len(ups) != 1 || ups[0].Timing.DeadlineUnixMs != quiet.ScheduledAt.UnixMilli() {
		t.Fatalf("quiet lead update = %+v", ups)
	}
	// A reminder rung re-surfaces it.
	f.card.ShowRung(r)
	if shows := rcShows(f.dir.take(), "assist-a"); len(shows) != 1 {
		t.Fatalf("a reminder rung must re-show the card: %d", len(shows))
	}
}

func TestAfterRestartEntryForTheCardsOwners(t *testing.T) {
	f := newRCFixture(t, "notice.info", "restart.prompt", "restart.final")
	r := f.rung()
	f.card.ShowRung(r)
	f.dir.take()
	at := rcNow.Add(2 * time.Hour)
	f.card.BeforeOSRestart(r.Campaign, at)
	id := promptkinds.RestartedNoticeID(r.Campaign)
	e, ok := f.inbox.get(id + "#" + rcOwnerA.PrincipalKey())
	if !ok || e.Show.State != ipc.PromptStateApproved || !strings.Contains(e.Show.Copy.Body, "{time:") {
		t.Fatalf("A's after-restart entry = %+v (%v)", e.Show, ok)
	}
	if _, ok := f.inbox.get(id + "#" + rcOwnerB.PrincipalKey()); ok {
		t.Fatal("B never had the card and gets no after-restart entry")
	}
	if n := len(f.dir.take()); n != 0 {
		t.Fatalf("the after-restart entry drew something before the restart: %d", n)
	}
	f.card.BeforeOSRestart(r.Campaign+1, at) // another campaign: nothing
}

func TestNewCampaignSupersedesTheOldCard(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	r := f.rung()
	f.card.ShowRung(r)
	f.dir.take()
	next := r
	next.Campaign++
	f.card.ShowRung(next)
	msgs := f.dir.take()
	if c := rcCloses(msgs, "assist-a"); len(c) != 1 || c[0].PromptID != promptkinds.RestartPromptID(r.Campaign) {
		t.Fatalf("old card close = %+v", c)
	}
	if s := rcShows(msgs, "assist-a"); len(s) != 1 || s[0].PromptID != promptkinds.RestartPromptID(next.Campaign) {
		t.Fatalf("new card = %+v", s)
	}
}

func TestLastUserActionInRebootStatusReport(t *testing.T) {
	now := time.Now()
	st := patching.RebootState{RebootScheduled: true, ScheduledAt: now.Add(time.Hour), DeferralAllowed: true, MaxDeferrals: 3, DeferralsUsed: 1,
		LastUserAction: &patching.RebootUserAction{Action: patching.UserActionPostponed, At: now.Add(-time.Minute), Renderer: "assist"}}
	rep := buildRebootStatusReport(st)
	if rep.LastUserAction == nil || rep.LastUserAction.Action != "postponed" || rep.LastUserAction.Renderer != "assist" || rep.LastUserAction.AtUnixMs != now.Add(-time.Minute).UnixMilli() {
		t.Fatalf("lastUserAction = %+v", rep.LastUserAction)
	}
	st.LastUserAction.At = now.Add(-25 * time.Hour)
	if rep := buildRebootStatusReport(st); rep.LastUserAction != nil {
		t.Fatal("a decision older than 24 h is not reported")
	}
	st.LastUserAction = nil
	if rep := buildRebootStatusReport(st); rep.LastUserAction != nil {
		t.Fatal("no decision, no field")
	}
}

// presentedBy answers prompt_presented for a show, as a renderer would.
func presentedBy(t *testing.T, h *prompthost.Host, key string, s ipc.PromptShow) {
	t.Helper()
	raw, _ := json.Marshal(ipc.PromptPresented{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, Visible: true})
	h.HandleRendererMessage(&sessionbroker.Session{SessionID: key}, ipc.TypePromptPresented, raw)
}

func actBy(t *testing.T, h *prompthost.Host, key string, s ipc.PromptShow, actionID string) ipc.PromptActionResult {
	t.Helper()
	raw, _ := json.Marshal(ipc.PromptActionRequest{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, ActionID: actionID, Via: ipc.PromptViaClick})
	_, reply := h.HandleRendererMessage(&sessionbroker.Session{SessionID: key}, ipc.TypePromptAction, raw)
	return reply.(ipc.PromptActionResult)
}

// The closing card is the last warning: if its renderer never draws it, the
// person still gets today's closing toast (#3197).
func TestClosingCardFallsBackToTodaysToastWhenNotPresented(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	final := f.rung()
	final.Final, final.PostponeUntil = true, time.Time{}
	final.ScheduledAt = rcNow.Add(time.Minute)
	final.LegacyTitle, final.LegacyBody, final.LegacyUrgency = "Restarting Now", "This computer restarts for updates in 1 minute. Save your work now.", "critical"
	if !f.card.ShowRung(final) {
		t.Fatal("the closing rung must be taken")
	}
	f.dir.take()
	f.clock.advance(11 * time.Second) // past the 10 s present budget
	f.host.Tick()
	if len(f.reqs) != 1 || f.reqs[0].Title != "Restarting Now" || f.reqs[0].Urgency != "critical" {
		t.Fatalf("closing toast = %+v", f.reqs)
	}
}

// A card rebuilt after a postponement keeps the newest rung's warning as its
// fallback (RestartRungNow carries none).
func TestPostponedCardKeepsItsFallbackWarning(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	r := f.rung()
	f.card.ShowRung(r)
	s := rcShows(f.dir.take(), "assist-a")[0]
	presentedBy(t, f.host, "assist-a", s)
	if res := actBy(t, f.host, "assist-a", s, "postpone"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("postpone = %s", res.Result)
	}
	f.dir.take()
	// Assist goes away and nothing else can draw the card.
	f.dir.mu.Lock()
	f.dir.rs = f.dir.rs[1:]
	f.dir.mu.Unlock()
	f.host.RendererDisconnected("assist-a")
	f.clock.advance(11 * time.Second) // past the 10 s grace
	f.host.Tick()
	if len(f.reqs) != 1 || f.reqs[0].Title != r.LegacyTitle || f.reqs[0].Body != r.LegacyBody {
		t.Fatalf("fallback after a postponement = %+v, want the newest rung's warning", f.reqs)
	}
}

func TestAfterRestartEntryWithdrawnWhenTheRestartDoesNotHappen(t *testing.T) {
	for _, tc := range []struct {
		name  string
		abort func(c *restartCard, campaign uint64)
	}{
		{"cancelled in the OS grace minute", func(c *restartCard, campaign uint64) { c.Cancelled(campaign) }},
		{"OS restart command failed", func(c *restartCard, campaign uint64) { c.OSRestartFailed(campaign) }},
		{"a new schedule aborted the countdown", func(c *restartCard, campaign uint64) {
			next := patching.RestartRung{Campaign: campaign + 1, Resurface: true, ScheduledAt: rcNow.Add(time.Hour), LegacyTitle: "t", LegacyBody: "b"}
			c.ShowRung(next)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRCFixture(t, "notice.info", "restart.prompt", "restart.final")
			f.owners = []prompthost.Owner{rcOwnerA}
			r := f.rung()
			f.card.ShowRung(r)
			f.card.BeforeOSRestart(r.Campaign, rcNow.Add(time.Minute))
			id := promptkinds.RestartedNoticeID(r.Campaign) + "#" + rcOwnerA.PrincipalKey()
			if _, ok := f.inbox.get(id); !ok {
				t.Fatal("precondition: the entry was written")
			}
			tc.abort(f.card, r.Campaign)
			if _, ok := f.inbox.get(id); ok {
				t.Fatal("'Your computer restarted' must not survive a restart that did not happen")
			}
		})
	}
}

func TestRungOfACancelledCampaignDrawsNoCard(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	r := f.rung()
	// The cancel lands before this campaign's first rung reaches the card.
	f.card.Cancelled(r.Campaign)
	if f.card.ShowRung(r) {
		t.Fatal("a rung of a cancelled campaign must not draw a card")
	}
	if n := len(f.dir.take()); n != 0 {
		t.Fatalf("sent %d prompt messages", n)
	}
}

// Windows SCM lock / unlock reach the prompt host through the heartbeat.
func TestSessionLockReachesThePromptHost(t *testing.T) {
	f := newRCFixture(t, "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	h := &Heartbeat{promptHost: f.host}
	h.promptSessionLockChanged(rcOwnerA.WinSessionID, true)
	f.card.ShowRung(f.rung())
	if n := len(rcShows(f.dir.take(), "assist-a")); n != 0 {
		t.Fatal("a locked session got the card")
	}
	h.promptSessionLockChanged(rcOwnerA.WinSessionID, false)
	f.host.Tick()
	if n := len(rcShows(f.dir.take(), "assist-a")); n != 1 {
		t.Fatalf("unlock must draw the card: %d", n)
	}
	(&Heartbeat{}).promptSessionLockChanged(1, true) // no prompt host: no panic
}

func TestLastUserActionWireShape(t *testing.T) {
	at := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	st := patching.RebootState{RebootScheduled: true, ScheduledAt: time.Now().Add(time.Hour),
		LastUserAction: &patching.RebootUserAction{Action: patching.UserActionRestartNow, At: at, Renderer: "native"}}
	raw, err := json.Marshal(buildRebootStatusReport(st))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	a, ok := got["lastUserAction"].(map[string]any)
	if !ok || a["action"] != "restart_now" || a["renderer"] != "native" || int64(a["atUnixMs"].(float64)) != at.UnixMilli() || len(a) != 3 {
		t.Fatalf("lastUserAction on the wire = %s", raw)
	}
	st.LastUserAction = nil
	raw, _ = json.Marshal(buildRebootStatusReport(st))
	if strings.Contains(string(raw), "lastUserAction") {
		t.Fatalf("an absent decision must be omitted: %s", raw)
	}
}

// --- end to end: the real reboot manager, card and prompt host ------------

type e2eTimers struct {
	mu  sync.Mutex
	fns map[time.Duration][]func()
}

func (f *e2eTimers) afterFunc(d time.Duration, fn func()) *time.Timer {
	f.mu.Lock()
	f.fns[d] = append(f.fns[d], fn)
	f.mu.Unlock()
	t := time.NewTimer(time.Hour)
	t.Stop()
	return t
}

func (f *e2eTimers) runAt(d time.Duration) {
	f.mu.Lock()
	fns := append([]func(){}, f.fns[d]...)
	f.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
}

// withDeadline fails the test instead of hanging on a lock-order deadlock.
func withDeadline(t *testing.T, name string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); f() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("%s did not return: deadlock between the reboot manager, the card and the prompt host?", name)
	}
}

func TestRestartCardEndToEndWithTheRealManager(t *testing.T) {
	f := newRCFixture(t, "notice.info", "restart.prompt", "restart.final")
	f.owners = []prompthost.Owner{rcOwnerA}
	timers := &e2eTimers{fns: map[time.Duration][]func(){}}
	dir := t.TempDir()
	var mu sync.Mutex
	var events []string
	var legacy []string
	mgr := patching.NewRebootManagerWithSeams(
		func(title, _, _ string) { mu.Lock(); legacy = append(legacy, title); mu.Unlock() },
		func(title, _, _ string, _ []string, _ time.Duration) (string, bool) {
			mu.Lock()
			legacy = append(legacy, "dialog:"+title)
			mu.Unlock()
			return "", true
		},
		3,
		patching.RebootSeams{
			Now:       time.Now,
			AfterFunc: timers.afterFunc,
			ExecOSReboot: func(time.Duration) error {
				mu.Lock()
				events = append(events, "os restart")
				mu.Unlock()
				return nil
			},
			AbortOSReboot: func() error { return nil },
			HistoryPath:   filepath.Join(dir, "history.json"),
			LedgerPath:    filepath.Join(dir, "ledger.json"),
		})
	f.card.mgr = mgr
	mgr.SetRestartSurface(f.card)
	// The host's clock is the manager's (real time) for this test.
	f.clock.mu.Lock()
	f.clock.t = time.Now()
	f.clock.mu.Unlock()

	if err := mgr.ScheduleWithOptions(2*time.Hour, time.Now().Add(10*time.Hour), "Patch", "patch_job",
		patching.RebootOptions{Deferral: patching.DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}}); err != nil {
		t.Fatal(err)
	}
	withDeadline(t, "lead rung", func() { timers.runAt(0) })
	shows := rcShows(f.dir.take(), "assist-a")
	if len(shows) != 1 || shows[0].DefaultActionID != "postpone" || shows[0].Copy.StateDetail != "3 postponements left" {
		t.Fatalf("lead card = %+v", shows)
	}
	card := shows[0]
	presentedBy(t, f.host, "assist-a", card)

	// Postpone on the card: the manager re-plans, the card is updated in place.
	var res ipc.PromptActionResult
	withDeadline(t, "postpone", func() { res = actBy(t, f.host, "assist-a", card, "postpone") })
	if res.Result != ipc.PromptActionAccepted {
		t.Fatalf("postpone = %+v", res)
	}
	st := mgr.State()
	if st.DeferralsUsed != 1 || st.LastUserAction == nil || st.LastUserAction.Renderer != "assist" {
		t.Fatalf("manager after postpone = %+v / %+v", st, st.LastUserAction)
	}
	msgs := f.dir.take()
	if len(rcShows(msgs, "assist-a")) != 0 {
		t.Fatal("a postponement must not re-surface the card")
	}
	ups := rcUpdates(msgs, "assist-a")
	if len(ups) == 0 || ups[len(ups)-1].Timing.DeadlineUnixMs != st.ScheduledAt.UnixMilli() {
		t.Fatalf("card update after postpone = %+v, want the new restart time %v", ups, st.ScheduledAt)
	}
	// The re-planned lead rung updates in place too (#4941).
	withDeadline(t, "re-planned lead rung", func() { timers.runAt(0) })
	msgs = f.dir.take()
	if len(rcShows(msgs, "assist-a")) != 0 {
		t.Fatal("the re-planned lead rung re-surfaced the card")
	}
	card, err := applyAll(card, append(ups, rcUpdates(msgs, "assist-a")...))
	if err != nil {
		t.Fatal(err)
	}
	if card.Copy.StateDetail != "2 postponements left" {
		t.Fatalf("budget line after one postponement = %q", card.Copy.StateDetail)
	}

	// Restart now: the closing card replaces this one; the after-restart
	// entry is on disk before the OS command.
	withDeadline(t, "restart now", func() { res = actBy(t, f.host, "assist-a", card, "restart_now") })
	if res.Result != ipc.PromptActionAccepted {
		t.Fatalf("restart_now = %+v", res)
	}
	withDeadline(t, "closing rung", func() { timers.runAt(0) })
	msgs = f.dir.take()
	finals := rcShows(msgs, "assist-a")
	if len(finals) != 1 || finals[0].Kind != "restart.final" {
		t.Fatalf("closing card = %+v", finals)
	}
	mu.Lock()
	gotEvents, gotLegacy := append([]string{}, events...), append([]string{}, legacy...)
	mu.Unlock()
	if len(gotEvents) != 1 {
		t.Fatalf("OS restart events = %v", gotEvents)
	}
	found := false
	for _, e := range f.inbox.PromptEntries(rcOwnerA.PrincipalKey()) {
		if strings.HasPrefix(e.PromptID, "notice:restarted:") {
			found = true
		}
	}
	if !found {
		t.Fatal("no after-restart entry")
	}
	if len(gotLegacy) != 0 {
		t.Fatalf("today's warnings went out although the card took every rung: %v", gotLegacy)
	}
}

func applyAll(s ipc.PromptShow, ups []ipc.PromptUpdate) (ipc.PromptShow, error) {
	for _, u := range ups {
		if u.Rev <= s.Rev {
			continue
		}
		next, err := ipc.ApplyPromptUpdate(s, u)
		if err != nil {
			return s, err
		}
		s = next
	}
	return s, nil
}

// An operator cancel racing a postponement on the card never deadlocks and
// never resurrects the restart.
func TestCardPostponeRacingCancelWithTheRealManager(t *testing.T) {
	for i := 0; i < 20; i++ {
		f := newRCFixture(t, "restart.prompt", "restart.final")
		f.owners = []prompthost.Owner{rcOwnerA}
		timers := &e2eTimers{fns: map[time.Duration][]func(){}}
		dir := t.TempDir()
		mgr := patching.NewRebootManagerWithSeams(func(string, string, string) {}, nil, 3, patching.RebootSeams{
			Now: time.Now, AfterFunc: timers.afterFunc,
			ExecOSReboot:  func(time.Duration) error { return nil },
			AbortOSReboot: func() error { return nil },
			HistoryPath:   filepath.Join(dir, "h.json"), LedgerPath: filepath.Join(dir, "l.json"),
		})
		f.card.mgr = mgr
		mgr.SetRestartSurface(f.card)
		f.clock.mu.Lock()
		f.clock.t = time.Now()
		f.clock.mu.Unlock()
		if err := mgr.ScheduleWithOptions(2*time.Hour, time.Now().Add(10*time.Hour), "Patch", "patch_job",
			patching.RebootOptions{Deferral: patching.DeferralPolicy{Allowed: true, MaxDeferrals: 3, DeferralMinutes: 60}}); err != nil {
			t.Fatal(err)
		}
		timers.runAt(0)
		card := rcShows(f.dir.take(), "assist-a")[0]
		presentedBy(t, f.host, "assist-a", card)
		withDeadline(t, "postpone racing cancel", func() {
			var wg sync.WaitGroup
			wg.Add(2)
			go func() { defer wg.Done(); actBy(t, f.host, "assist-a", card, "postpone") }()
			go func() { defer wg.Done(); _ = mgr.Cancel() }()
			wg.Wait()
		})
		if st := mgr.State(); st.RebootScheduled {
			t.Fatalf("iteration %d: the cancelled restart is scheduled again: %+v", i, st)
		}
	}
}
