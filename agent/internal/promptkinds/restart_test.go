package promptkinds

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

var restartAt = time.Date(2026, 10, 27, 14, 30, 0, 0, time.UTC)

func restartInput() RestartPromptInput {
	return RestartPromptInput{
		Campaign:        1793019600000,
		ScheduledAt:     restartAt,
		PostponeUntil:   restartAt.Add(time.Hour),
		DeferralAllowed: true,
		DeferralsLeft:   2,
		Legacy:          ipc.NotifyRequest{Title: "Restart Scheduled", Body: "legacy body", Urgency: "normal"},
	}
}

func action(t *testing.T, s ipc.PromptShow, id string) ipc.PromptAction {
	t.Helper()
	for _, a := range s.Actions {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("no %s action in %+v", id, s.Actions)
	return ipc.PromptAction{}
}

func validShow(t *testing.T, s ipc.PromptShow) {
	t.Helper()
	s.Rev = 1
	s.Lease = ipc.PromptLease{RendererSession: "r", Epoch: 1}
	if err := ipc.ValidatePromptShow(s); err != nil {
		t.Fatalf("invalid prompt_show: %v (%+v)", err, s)
	}
}

func TestRestartKindsRegistered(t *testing.T) {
	got := map[string]bool{}
	for _, s := range Specs() {
		got[s.Name+"@"+string(rune('0'+s.Version))] = true
	}
	for _, want := range []string{"notice.info@1", "restart.prompt@1", "restart.final@1"} {
		if !got[want] {
			t.Fatalf("Specs() lacks %s: %v", want, got)
		}
	}
	for _, k := range []string{RestartPromptKind.Name, RestartFinalKind.Name} {
		if c, ok := ipc.PromptKindClass(k); !ok || c != ipc.PromptCopyOperator {
			t.Fatalf("%s must be an operator-class kind (prompt_operator scope)", k)
		}
	}
}

func TestPostponeLabelEqualsComputeDeferralClampedTime(t *testing.T) {
	in := restartInput()
	// A postponement clamped to the deadline: 40 minutes, not the hour.
	in.PostponeUntil = restartAt.Add(40 * time.Minute)
	p := RestartPrompts{}.RestartPrompt(in)
	validShow(t, p.Show)
	if p.ID != "restart:1793019600000" || p.Show.State != ipc.PromptStatePending {
		t.Fatalf("id/state = %s/%s", p.ID, p.Show.State)
	}
	post := action(t, p.Show, "postpone")
	want := "Postpone until {time:" + itoa(in.PostponeUntil.UnixMilli()) + "}"
	if post.Label != want || post.Role != ipc.PromptRoleSafe {
		t.Fatalf("postpone = %+v, want label %q and role safe", post, want)
	}
	if p.Show.DefaultActionID != "postpone" || p.Show.Actions[0].ID != "postpone" {
		t.Fatalf("Postpone must be the default and first: default=%s actions=%+v", p.Show.DefaultActionID, p.Show.Actions)
	}
	now := action(t, p.Show, "restart_now")
	if now.Role != ipc.PromptRoleProceed || now.Label != "Restart now" {
		t.Fatalf("restart_now = %+v", now)
	}
	if p.Show.Timing.DeadlineUnixMs != restartAt.UnixMilli() || p.Show.Focus != ipc.PromptFocusNoActivate || p.Show.Presentation != ipc.PromptPresentationCard {
		t.Fatalf("timing/focus/presentation = %+v %s %s", p.Show.Timing, p.Show.Focus, p.Show.Presentation)
	}
	if !strings.Contains(p.Show.Copy.Consequence, "{time:"+itoa(restartAt.UnixMilli())+"}") {
		t.Fatalf("consequence must name the restart time: %q", p.Show.Copy.Consequence)
	}
	if p.Show.Copy.StateDetail != "2 postponements left" {
		t.Fatalf("budget line = %q", p.Show.Copy.StateDetail)
	}
}

func TestPostponeHiddenWhenBudgetUsedOrClampBelowMinGap(t *testing.T) {
	for _, tc := range []struct {
		name       string
		allowed    bool
		left       int
		wantDetail string
	}{
		{"budget spent", true, 0, "This restart can no longer be postponed."},
		{"clamp below the minimum gap", true, 2, "This restart can no longer be postponed."},
		{"policy off", false, 0, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := restartInput()
			in.PostponeUntil = time.Time{} // the manager offers none
			in.DeferralAllowed, in.DeferralsLeft = tc.allowed, tc.left
			p := RestartPrompts{}.RestartPrompt(in)
			validShow(t, p.Show)
			if p.Show.State != ipc.PromptStatePending {
				t.Fatalf("state = %s, want pending", p.Show.State)
			}
			if len(p.Show.Actions) != 2 || p.Show.Actions[0].ID != "ok" || p.Show.Actions[0].Role != ipc.PromptRoleSafe || p.Show.Actions[0].Label != "OK" {
				t.Fatalf("actions = %+v, want ok (safe) first", p.Show.Actions)
			}
			for _, a := range p.Show.Actions {
				if a.ID == "postpone" {
					t.Fatal("Postpone offered although the manager offered none")
				}
			}
			// Never Restart now as the default, nor as the only button (a
			// native dialog makes its first button the default).
			if p.Show.DefaultActionID != "ok" {
				t.Fatalf("default = %q, want ok", p.Show.DefaultActionID)
			}
			if p.Show.Copy.StateDetail != tc.wantDetail {
				t.Fatalf("budget line = %q, want %q", p.Show.Copy.StateDetail, tc.wantDetail)
			}
		})
	}
}

// Review Focus 3: hostile operator copy.
func TestRestartOperatorCopyPlaceholders(t *testing.T) {
	in := restartInput()
	in.OperatorTitle = "Restart in {{countdown}} ({{countdown}})"
	in.OperatorBody = "Line one {{x}}\nLine two {{countdown}}"
	in.OperatorButton = "Do it now"
	p := RestartPrompts{}.RestartPrompt(in)
	validShow(t, p.Show)
	if p.Show.Copy.Title != "Restart in {remaining} ({remaining})" {
		t.Fatalf("title = %q", p.Show.Copy.Title)
	}
	if p.Show.Copy.Body != "Line one {{x}}\nLine two {remaining}" {
		t.Fatalf("body = %q (unknown {{x}} must stay literal, the newline kept)", p.Show.Copy.Body)
	}
	if action(t, p.Show, "restart_now").Label != "Do it now" {
		t.Fatal("operator button must fill the restart_now label")
	}
	if l := action(t, p.Show, "postpone").Label; !strings.HasPrefix(l, "Postpone until {time:") {
		t.Fatalf("operator copy must never fill the Postpone label: %q", l)
	}
	if strings.Contains(p.Show.Copy.Consequence, "{{") || p.Show.Copy.OperatorNote != "" {
		t.Fatalf("operator copy leaked into the consequence/note: %+v", p.Show.Copy)
	}
	// Localized: the operator text is verbatim in every locale; the rest is not.
	l, err := p.Localize(promptcatalog.Locale("de-DE"))
	if err != nil {
		t.Fatal(err)
	}
	if l.Copy.Title != p.Show.Copy.Title || l.ActionLabels["restart_now"] != "Do it now" {
		t.Fatalf("de-DE operator copy = %+v", l)
	}
	if !strings.HasPrefix(l.ActionLabels["postpone"], "Verschieben bis {time:") {
		t.Fatalf("de-DE postpone = %q", l.ActionLabels["postpone"])
	}
}

func TestRestartPromptDefaultsNameThePartnerOrTheGenericTeam(t *testing.T) {
	in := restartInput()
	p := RestartPrompts{}.RestartPrompt(in)
	if p.Show.Copy.Body != "Your IT support team needs to restart this computer to finish installing updates." {
		t.Fatalf("generic body = %q", p.Show.Copy.Body)
	}
	in.Partner = "Example IT\u202e"
	p = RestartPrompts{}.RestartPrompt(in)
	if p.Show.Copy.Body != "Example IT needs to restart this computer to finish installing updates." {
		t.Fatalf("partner body = %q (sanitised)", p.Show.Copy.Body)
	}
	l, err := p.Localize(promptcatalog.Locale("fr-CA"))
	if err != nil || !strings.HasPrefix(l.Copy.Body, "Example IT doit redémarrer") {
		t.Fatalf("fr-CA body = %q (%v)", l.Copy.Body, err)
	}
}

func TestRestartFinalStealsFocusWithOnlyOK(t *testing.T) {
	at := restartAt.Add(time.Minute)
	var toasts []ipc.NotifyRequest
	rs := RestartPrompts{Notify: func(_ prompthost.Owner, req ipc.NotifyRequest) error { toasts = append(toasts, req); return nil }}
	p := rs.RestartFinal(42, at, ipc.NotifyRequest{Title: "Restarting Now", Body: "This computer restarts for updates in 1 minute. Save your work now.", Urgency: "critical"})
	validShow(t, p.Show)
	if p.ID != "restart:42:final" || p.Kind.Name != "restart.final" {
		t.Fatalf("id/kind = %s/%s", p.ID, p.Kind.Name)
	}
	if p.Show.Focus != ipc.PromptFocusSteal || len(p.Show.Actions) != 1 || p.Show.Actions[0].ID != "ok" || p.Show.Actions[0].Role != ipc.PromptRoleSafe || p.Show.DefaultActionID != "ok" {
		t.Fatalf("final = %+v", p.Show)
	}
	if !strings.Contains(p.Show.Copy.Body, "{remaining}") || p.Show.Timing.DeadlineUnixMs != at.UnixMilli() {
		t.Fatalf("final body/deadline = %q / %d", p.Show.Copy.Body, p.Show.Timing.DeadlineUnixMs)
	}
	out, err := p.OnAction("ok", testOwner)
	if err != nil || !out.Accepted || out.Close == nil || *out.Close != ipc.PromptCloseResolved {
		t.Fatalf("ok = %+v, %v", out, err)
	}
	// The last warning must reach a session whose renderer cannot draw it.
	if p.Legacy == nil {
		t.Fatal("the closing card needs today's closing warning as its fallback (#3197)")
	}
	if err := p.Legacy(testOwner); err != nil || len(toasts) != 1 || toasts[0].Title != "Restarting Now" || toasts[0].Urgency != "critical" {
		t.Fatalf("final legacy = %+v (%v)", toasts, err)
	}
}

func TestRestartCancelledAndRestartedAreFinished(t *testing.T) {
	c := RestartPrompts{}.RestartCancelled(RestartPromptID(7), RestartPromptKind, "Example IT")
	validShow(t, c.Show)
	if c.Show.State != ipc.PromptStateCancelled || len(c.Show.Actions) != 0 || c.Show.Copy.Body != "Example IT cancelled the restart." {
		t.Fatalf("cancelled = %+v", c.Show)
	}
	n := RestartPrompts{}.RestartedNotice(7, restartAt)
	validShow(t, n.Show)
	if n.ID != "notice:restarted:7" || n.Kind.Name != "notice.info" || n.Show.State != ipc.PromptStateApproved || !strings.Contains(n.Show.Copy.Body, "{time:"+itoa(restartAt.UnixMilli())+"}") {
		t.Fatalf("restarted = %+v", n.Show)
	}
}

func TestRestartLegacyIsTodaysWarningForTheOwner(t *testing.T) {
	var got []ipc.NotifyRequest
	r := RestartPrompts{Notify: func(o prompthost.Owner, req ipc.NotifyRequest) error {
		if o.Key() != testOwner.Key() {
			t.Fatalf("legacy went to %s", o.Key())
		}
		got = append(got, req)
		return nil
	}}
	p := r.RestartPrompt(restartInput())
	if err := p.Legacy(testOwner); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Title != "Restart Scheduled" || got[0].Body != "legacy body" {
		t.Fatalf("legacy = %+v", got)
	}
}

// --- through a real prompt host -------------------------------------------

type multiDir struct {
	mu   sync.Mutex
	rs   []prompthost.RendererSession
	sent map[string][]sent
}

func (d *multiDir) Renderers(o prompthost.Owner) []prompthost.RendererSession {
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

func (d *multiDir) Send(key, msgType, _ string, payload any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.sent == nil {
		d.sent = map[string][]sent{}
	}
	d.sent[key] = append(d.sent[key], sent{msgType, payload})
	return nil
}

func (d *multiDir) take(key string) []sent {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := d.sent[key]
	delete(d.sent, key)
	return out
}

func lastShowOf(t *testing.T, msgs []sent) ipc.PromptShow {
	t.Helper()
	for i := len(msgs) - 1; i >= 0; i-- {
		if s, ok := msgs[i].payload.(ipc.PromptShow); ok {
			return s
		}
	}
	t.Fatal("no prompt_show")
	return ipc.PromptShow{}
}

func updatesOf(msgs []sent) []ipc.PromptUpdate {
	var out []ipc.PromptUpdate
	for _, m := range msgs {
		if u, ok := m.payload.(ipc.PromptUpdate); ok {
			out = append(out, u)
		}
	}
	return out
}

// fakeManager is the reboot manager's decision surface: one campaign, a
// budget, and a schedule that moves by an hour per postponement.
type fakeManager struct {
	mu        sync.Mutex
	in        RestartPromptInput
	postpones []string
	restarts  []string
	gate      chan struct{} // when set, Postpone signals entered and blocks on it
	entered   chan struct{}
	stale     bool // the postponement applies but cannot be read back
}

func (m *fakeManager) Postpone(campaign uint64, renderer string) (RestartPromptInput, bool, error) {
	if m.gate != nil {
		m.entered <- struct{}{}
		<-m.gate
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if campaign != m.in.Campaign {
		return RestartPromptInput{}, false, errors.New("the restart was cancelled or replaced while the prompt was open")
	}
	m.postpones = append(m.postpones, renderer)
	m.in.ScheduledAt = m.in.PostponeUntil
	m.in.DeferralsLeft--
	m.in.PostponeUntil = m.in.ScheduledAt.Add(time.Hour)
	if m.in.DeferralsLeft == 0 {
		m.in.PostponeUntil = time.Time{}
	}
	return m.in, !m.stale, nil
}

func (m *fakeManager) RestartNow(campaign uint64, renderer string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if campaign != m.in.Campaign {
		return errors.New("another campaign")
	}
	m.restarts = append(m.restarts, renderer)
	return nil
}

var (
	ownerA = prompthost.Owner{WinSessionID: 1, UserSID: "S-1-5-21-1001"}
	ownerB = prompthost.Owner{WinSessionID: 2, UserSID: "S-1-5-21-1002"}
)

func restartHost(t *testing.T) (*prompthost.Host, *multiDir, *fakeManager, RestartPrompts) {
	t.Helper()
	dir := &multiDir{rs: []prompthost.RendererSession{
		{Key: "assist-a", Role: ipc.HelperRoleAssist, Owner: ownerA, Protocol: 1, KindAds: []string{"restart.prompt@1", "restart.final@1"}},
		{Key: "native-b", Role: ipc.HelperRoleUser, Owner: ownerB, Protocol: 1, KindAds: []string{"restart.prompt@1", "restart.final@1"}, UILocale: "de-DE"},
	}}
	h := prompthost.New(prompthost.Deps{Broker: dir, Inbox: &entries{m: map[string]prompthost.ListEntry{}}})
	Register(h)
	h.SetEnabledKinds([]string{"restart.prompt", "restart.final"})
	m := &fakeManager{in: restartInput()}
	m.in.ScheduledAt = time.Now().Add(2 * time.Hour)
	m.in.PostponeUntil = m.in.ScheduledAt.Add(time.Hour)
	r := RestartPrompts{Postpone: m.Postpone, RestartNow: m.RestartNow, Refresh: h.Refresh}
	return h, dir, m, r
}

func actOn(t *testing.T, h *prompthost.Host, key string, s ipc.PromptShow, actionID string) ipc.PromptActionResult {
	t.Helper()
	raw, _ := json.Marshal(ipc.PromptActionRequest{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, ActionID: actionID, Via: ipc.PromptViaClick})
	_, reply := h.HandleRendererMessage(&sessionbroker.Session{SessionID: key}, ipc.TypePromptAction, raw)
	return reply.(ipc.PromptActionResult)
}

// Review Focus 5: two signed-in users answer at the same moment, one
// Postpone and one Restart now. Exactly one decision is applied, the other
// session gets rejected_stale and then the update.
func TestRestartConcurrentDecisionsFirstWins(t *testing.T) {
	h, dir, m, r := restartHost(t)
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerA, ownerB}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	sa := lastShowOf(t, dir.take("assist-a"))
	sb := lastShowOf(t, dir.take("native-b"))
	if sb.Locale != "de-DE" || !strings.HasPrefix(action(t, sb, "postpone").Label, "Verschieben bis") {
		t.Fatalf("session B gets its own language: %s %+v", sb.Locale, sb.Actions)
	}

	m.gate, m.entered = make(chan struct{}), make(chan struct{}, 1)
	var wg sync.WaitGroup
	var resA, resB ipc.PromptActionResult
	wg.Add(2)
	go func() { defer wg.Done(); resA = actOn(t, h, "assist-a", sa, "postpone") }()
	<-m.entered // A is inside the domain call, holding the host's action lock
	// B crosses it: whether B reaches the action lock before or after A
	// finishes, it acts on the rev A's decision replaced.
	go func() { defer wg.Done(); resB = actOn(t, h, "native-b", sb, "restart_now") }()
	close(m.gate)
	wg.Wait()

	if resA.Result != ipc.PromptActionAccepted {
		t.Fatalf("first decision = %s, want accepted", resA.Result)
	}
	if resB.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("crossing decision = %s, want rejected_stale", resB.Result)
	}
	if len(m.postpones) != 1 || len(m.restarts) != 0 {
		t.Fatalf("domain applied postpones=%v restarts=%v, want exactly one postponement", m.postpones, m.restarts)
	}
	if m.postpones[0] != RendererAssist {
		t.Fatalf("renderer recorded = %q, want assist", m.postpones[0])
	}
	// Both sessions hold the new time, in place (no re-surfacing show).
	for key, want := range map[string]string{"assist-a": "Postpone until", "native-b": "Verschieben bis"} {
		msgs := dir.take(key)
		ups := updatesOf(msgs)
		if len(ups) == 0 {
			t.Fatalf("%s got no prompt_update after the postponement", key)
		}
		u := ups[len(ups)-1]
		if u.Timing == nil || u.Timing.DeadlineUnixMs != m.in.ScheduledAt.UnixMilli() {
			t.Fatalf("%s: update timing = %+v, want the new restart time", key, u.Timing)
		}
		found := false
		for _, a := range *u.Actions {
			if a.ID == "postpone" && strings.HasPrefix(a.Label, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s: update actions = %+v", key, *u.Actions)
		}
		for _, x := range msgs {
			if x.typ == ipc.TypePromptShow {
				t.Fatalf("%s: a postponement must not re-surface the card", key)
			}
		}
	}
	// B, now on the current rev, can act again.
	if res := actOn(t, h, "native-b", sb, "postpone"); res.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("B's old rev must stay stale: %s", res.Result)
	}
}

func TestRestartNowApprovesAndRecordsTheRenderer(t *testing.T) {
	h, dir, m, r := restartHost(t)
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerB}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	sb := lastShowOf(t, dir.take("native-b"))
	if res := actOn(t, h, "native-b", sb, "restart_now"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("restart_now = %s", res.Result)
	}
	if len(m.restarts) != 1 || m.restarts[0] != RendererNative {
		t.Fatalf("restarts = %v", m.restarts)
	}
	ups := updatesOf(dir.take("native-b"))
	if len(ups) != 1 || ups[0].State == nil || *ups[0].State != ipc.PromptStateApproved || ups[0].Actions == nil || len(*ups[0].Actions) != 0 {
		t.Fatalf("updates = %+v", ups)
	}
}

func TestRestartOKAcknowledgesWithoutChangingTheSchedule(t *testing.T) {
	h, dir, m, r := restartHost(t)
	m.in.PostponeUntil = time.Time{}
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerA}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	sa := lastShowOf(t, dir.take("assist-a"))
	if res := actOn(t, h, "assist-a", sa, "ok"); res.Result != ipc.PromptActionAccepted || res.Rev != sa.Rev {
		t.Fatalf("ok = %+v", res)
	}
	if len(m.postpones) != 0 || len(m.restarts) != 0 || !h.IsOpen(p.ID) {
		t.Fatalf("ok changed the schedule or closed the card: postpones=%v restarts=%v open=%v", m.postpones, m.restarts, h.IsOpen(p.ID))
	}
	if n := len(dir.take("assist-a")); n != 0 {
		t.Fatalf("ok sent %d messages", n)
	}
}

func TestRestartRefusedDecisionChangesNothing(t *testing.T) {
	h, dir, m, r := restartHost(t)
	var told []ipc.NotifyRequest
	r.Notify = func(o prompthost.Owner, req ipc.NotifyRequest) error {
		if o.Key() != ownerA.Key() {
			t.Errorf("the refusal went to %s", o.Key())
		}
		m.mu.Lock()
		told = append(told, req)
		m.mu.Unlock()
		return nil
	}
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerA}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	sa := lastShowOf(t, dir.take("assist-a"))
	m.in.Campaign++ // the operator replaced the restart meanwhile
	if res := actOn(t, h, "assist-a", sa, "postpone"); res.Result != ipc.PromptActionRejectedInvalid {
		t.Fatalf("refused postponement = %s, want rejected_invalid", res.Result)
	}
	if len(updatesOf(dir.take("assist-a"))) != 0 {
		t.Fatal("a refused decision must not change the card")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(told) != 1 || told[0].Title != "Restart Cannot Be Postponed" || !strings.Contains(told[0].Body, "cancelled or replaced") || told[0].Urgency != "critical" {
		t.Fatalf("the person must be told why, as the dialog path does: %+v", told)
	}
}

func TestRestartPostponeAppliedButUnreadableStillBumpsTheRev(t *testing.T) {
	h, dir, m, r := restartHost(t)
	m.stale = true
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerA}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	sa := lastShowOf(t, dir.take("assist-a"))
	if res := actOn(t, h, "assist-a", sa, "postpone"); res.Result != ipc.PromptActionAccepted || res.Rev <= sa.Rev {
		t.Fatalf("result = %+v, want accepted with a newer rev", res)
	}
	if again := actOn(t, h, "assist-a", sa, "postpone"); again.Result == ipc.PromptActionRejectedInvalid || len(m.postpones) != 1 {
		t.Fatalf("a duplicate click on the old rev = %s, postpones %v", again.Result, m.postpones)
	}
}

func TestRestartPostponeWithAFailedRefreshStillBumpsTheRev(t *testing.T) {
	h, dir, m, r := restartHost(t)
	r.Refresh = func(prompthost.Prompt) error { return errors.New("refresh refused") }
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerA}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	sa := lastShowOf(t, dir.take("assist-a"))
	if res := actOn(t, h, "assist-a", sa, "postpone"); res.Result != ipc.PromptActionAccepted || res.Rev <= sa.Rev {
		t.Fatalf("result = %+v, want accepted with a newer rev", res)
	}
	if again := actOn(t, h, "assist-a", sa, "postpone"); again.Result == ipc.PromptActionRejectedInvalid || len(m.postpones) != 1 {
		t.Fatalf("a duplicate click on the old rev = %s, postpones %v", again.Result, m.postpones)
	}
}

func TestRestartFallsBackToLegacyWhenDisabled(t *testing.T) {
	h, dir, m, r := restartHost(t)
	h.SetEnabledKinds([]string{"notice.info"}) // the kill switch: restart off
	if h.PromptPathAvailable(RestartPromptKind.Name, 1, ownerA) {
		t.Fatal("a disabled kind must not be on the prompt path")
	}
	var legacy []prompthost.Owner
	r.Notify = func(o prompthost.Owner, _ ipc.NotifyRequest) error {
		legacy = append(legacy, o)
		return nil
	}
	p := r.RestartPrompt(m.in)
	p.Owners = []prompthost.Owner{ownerA}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	if n := len(dir.take("assist-a")); n != 0 {
		t.Fatalf("a disabled kind sent %d prompt messages", n)
	}
	if len(legacy) != 1 || legacy[0].Key() != ownerA.Key() {
		t.Fatalf("legacy = %v", legacy)
	}
}

func itoa(n int64) string { return strings.TrimSpace(strings.Replace(fmtInt(n), "+", "", 1)) }

func fmtInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
