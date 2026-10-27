package heartbeat

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
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
		notify: func(o prompthost.Owner, _ ipc.NotifyRequest) error {
			f.toasts = append(f.toasts, o)
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
