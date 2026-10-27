package promptkinds

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// remote.consent@1 and remote.session@1 (#10190 W06, plan Task 6.3).

func strp(s string) *string { return &s }

func consentReq(onTimeout string, timeoutMs int) ipc.ConsentRequest {
	return ipc.ConsentRequest{SessionID: "6f1c2d9e-0a4b-4c3d-9e8f-123456789abc", TechnicianName: "Dana Reyes", TechnicianEmail: "dana@example.test",
		OrgName: "Northwind IT", TimeoutMs: timeoutMs, OnTimeout: onTimeout, ProtocolVersion: ipc.ConsentProtocolVersion, Nonce: "0123456789abcdef0123456789abcdef"}
}

func consentCfg(onTimeout string, timeoutMs int) ipc.DesktopPrompt {
	return ipc.DesktopPrompt{Mode: "consent", TechnicianName: strp("Dana Reyes"), TechnicianEmail: strp("dana@example.test"), OrgName: strp("Northwind IT"),
		ConsentUnavailableBehavior: onTimeout, ConsentTimeoutMs: timeoutMs, ShowIndicator: true}
}

func actionByID(s ipc.PromptShow, id string) (ipc.PromptAction, bool) {
	for _, a := range s.Actions {
		if a.ID == id {
			return a, true
		}
	}
	return ipc.PromptAction{}, false
}

func TestConsentDefaultDenyAndEscDeny(t *testing.T) {
	p := RemoteConsent(consentReq("block", 30_000), consentCfg("block", 30_000), ConsentHooks{})
	s := p.Show
	if p.ID != "consent:0123456789abcdef0123456789abcdef" || s.PromptID != p.ID {
		t.Fatalf("id = %q / %q", p.ID, s.PromptID)
	}
	if p.Kind.Name != "remote.consent" || p.Kind.Version != 1 || !p.Kind.ShowWhileLocked || !p.Kind.NeverReask {
		t.Fatalf("kind = %+v", p.Kind)
	}
	if s.Presentation != ipc.PromptPresentationModal || s.Focus != ipc.PromptFocusSteal || s.State != ipc.PromptStatePending {
		t.Fatalf("presentation %s focus %s state %s", s.Presentation, s.Focus, s.State)
	}
	deny, ok := actionByID(s, "deny")
	if !ok || deny.Role != ipc.PromptRoleSafe || deny.Label != "Deny" {
		t.Fatalf("deny = %+v", deny)
	}
	allow, ok := actionByID(s, "allow")
	if !ok || allow.Role != ipc.PromptRoleProceed || allow.Label != "Allow" {
		t.Fatalf("allow = %+v", allow)
	}
	if len(s.Actions) != 2 {
		t.Fatalf("actions = %+v", s.Actions)
	}
	// Deny is the default; a pending decision maps Esc and the close box to
	// its one safe action (spec §3.1), so Esc is Deny on every renderer.
	if s.DefaultActionID != "deny" || !ipc.IsPromptDecision(s.State, s.Presentation) {
		t.Fatalf("default %q, decision %v", s.DefaultActionID, ipc.IsPromptDecision(s.State, s.Presentation))
	}
	probe := s
	probe.Rev, probe.Lease, probe.Kind, probe.KindVersion = 1, ipc.PromptLease{RendererSession: "x", Epoch: 1}, p.Kind.Name, 1
	if err := ipc.ValidatePromptShow(probe); err != nil {
		t.Fatalf("invalid show: %v", err)
	}
	if !s.ListEntry.Persistent {
		t.Fatal("every real consent prompt also appears in the notification list")
	}
	// The session's language.
	l, err := p.Localize(promptcatalog.Locale("de-DE"))
	if err != nil || l.ActionLabels["deny"] != "Ablehnen" || l.ActionLabels["allow"] != "Zulassen" {
		t.Fatalf("de-DE labels = %+v, %v", l.ActionLabels, err)
	}
}

func TestConsentExpiryFollowsBehavior(t *testing.T) {
	for _, tc := range []struct {
		behavior string
		want     string
	}{
		{"proceed", "If no one answers, the session starts in {remaining}."},
		{"block", "If no one answers, the session is declined in {remaining}."},
		{"", "If no one answers, the session is declined in {remaining}."},
		{"PROCEED", "If no one answers, the session is declined in {remaining}."},
	} {
		t.Run(tc.behavior, func(t *testing.T) {
			p := RemoteConsent(consentReq(tc.behavior, 45_000), consentCfg(tc.behavior, 45_000), ConsentHooks{})
			tm := p.Show.Timing
			if tm.ResponseMs != 45_000 || tm.DeadlineUnixMs != 0 || tm.PresentWithinMs != 10_000 {
				t.Fatalf("timing = %+v", tm)
			}
			if tm.Expiry == nil || tm.Expiry.ActionID != nil || tm.Expiry.Text != tc.want {
				t.Fatalf("expiry = %+v, want %q and no action", tm.Expiry, tc.want)
			}
			l, err := p.Localize(promptcatalog.Locale("fr-FR"))
			if err != nil || !strings.Contains(l.ExpiryText, "{remaining}") || l.ExpiryText == tc.want {
				t.Fatalf("fr-FR expiry = %q, %v", l.ExpiryText, err)
			}
		})
	}
	// No countdown: no consequence sentence and no response budget.
	p := RemoteConsent(consentReq("proceed", 0), consentCfg("proceed", 0), ConsentHooks{})
	if p.Show.Timing.ResponseMs != 0 || p.Show.Timing.Expiry != nil {
		t.Fatalf("a prompt without a timeout = %+v", p.Show.Timing)
	}
}

func TestConsentShowsOnlyWhatTheServerSent(t *testing.T) {
	req := consentReq("block", 30_000)
	req.TechnicianName, req.TechnicianEmail = "", ""
	p := RemoteConsent(req, consentCfg("block", 30_000), ConsentHooks{})
	if p.Show.Copy.Body != "A technician from Northwind IT wants to start a remote session on this computer." {
		t.Fatalf("body = %q", p.Show.Copy.Body)
	}
	if len(p.Show.Facts) != 1 || p.Show.Facts[0].Label != "Organization" || p.Show.Facts[0].Value != "Northwind IT" {
		t.Fatalf("facts = %+v", p.Show.Facts)
	}
	full := RemoteConsent(consentReq("block", 30_000), consentCfg("block", 30_000), ConsentHooks{})
	if full.Show.Copy.Body != "Dana Reyes from Northwind IT wants to start a remote session on this computer." || len(full.Show.Facts) != 3 {
		t.Fatalf("full = %q %+v", full.Show.Copy.Body, full.Show.Facts)
	}
	// A server string is never read as a renderer placeholder.
	hostile := consentReq("block", 30_000)
	hostile.TechnicianName = "Dana {remaining} {time:1}"
	got := RemoteConsent(hostile, consentCfg("block", 30_000), ConsentHooks{})
	for _, s := range []string{got.Show.Copy.Body, got.Show.Facts[0].Value} {
		if strings.Contains(s, "{remaining}") || strings.Contains(s, "{time:") {
			t.Fatalf("placeholder survived in %q", s)
		}
	}
}

// consentHost is a real prompt host with one native renderer.
func consentHost(t *testing.T, kinds string) (*prompthost.Host, *oneRenderer) {
	t.Helper()
	r := prompthost.RendererSession{Key: "native-1", Role: ipc.HelperRoleUser, Owner: testOwner, Protocol: 1, KindAds: []string{kinds}}
	dir := &oneRenderer{r: r}
	h := prompthost.New(prompthost.Deps{Broker: dir})
	Register(h)
	h.SetEnabledKinds([]string{"remote.consent", "remote.session"})
	return h, dir
}

type consentCalls struct {
	mu      sync.Mutex
	decided []string
	expired int
	lost    []string
}

func (c *consentCalls) hooks() ConsentHooks {
	return ConsentHooks{
		Decided: func(id string, _ prompthost.Owner) { c.mu.Lock(); c.decided = append(c.decided, id); c.mu.Unlock() },
		Expired: func() { c.mu.Lock(); c.expired++; c.mu.Unlock() },
		Lost: func(_ prompthost.PlacementInfo, reason string) {
			c.mu.Lock()
			c.lost = append(c.lost, reason)
			c.mu.Unlock()
		},
	}
}

func TestConsentDecisionsThroughTheHost(t *testing.T) {
	for _, action := range []string{"allow", "deny"} {
		t.Run(action, func(t *testing.T) {
			h, dir := consentHost(t, "remote.consent@1")
			calls := &consentCalls{}
			p := RemoteConsent(consentReq("block", 30_000), consentCfg("block", 30_000), calls.hooks())
			p.Owners = []prompthost.Owner{testOwner}
			if err := h.Show(p); err != nil {
				t.Fatal(err)
			}
			s := dir.lastShow(t)
			if res := act(t, h, "native-1", s, action); res.Result != ipc.PromptActionAccepted {
				t.Fatalf("%s = %+v", action, res)
			}
			calls.mu.Lock()
			defer calls.mu.Unlock()
			if len(calls.decided) != 1 || calls.decided[0] != action {
				t.Fatalf("decided = %v", calls.decided)
			}
			if h.IsOpen(p.ID) {
				t.Fatal("a decided consent is not open")
			}
		})
	}
}

func TestSessionIndicatorShape(t *testing.T) {
	started := time.UnixMilli(1793137749924)
	p := RemoteSession("6f1c2d9e-0a4b", consentCfg("block", 30_000), started, SessionHooks{})
	s := p.Show
	if p.ID != "session:6f1c2d9e-0a4b" || p.Kind.Name != "remote.session" || p.Kind.Version != 1 {
		t.Fatalf("id %q kind %+v", p.ID, p.Kind)
	}
	if s.Presentation != ipc.PromptPresentationIndicator || s.Focus != ipc.PromptFocusNoActivate || s.ListEntry.Persistent {
		t.Fatalf("presentation %s focus %s list %+v", s.Presentation, s.Focus, s.ListEntry)
	}
	if s.Copy.Title != "Dana Reyes from Northwind IT is connected" {
		t.Fatalf("title = %q", s.Copy.Title)
	}
	var startedFact string
	for _, f := range s.Facts {
		if f.Label == "Started" {
			startedFact = f.Value
		}
	}
	if startedFact != "{time:1793137749924}" {
		t.Fatalf("facts = %+v", s.Facts)
	}
	if s.Timing.DeadlineUnixMs != 0 || s.Timing.ResponseMs != 0 {
		t.Fatalf("an indicator lives until the session ends: %+v", s.Timing)
	}
}

func TestSessionEndOnlyWhenAllowed(t *testing.T) {
	ended := 0
	hooks := SessionHooks{EndConfirmed: func() { ended++ }}

	cfg := consentCfg("block", 30_000) // AllowUserEndSession absent: false
	p := RemoteSession("s-off", cfg, time.Now(), hooks)
	if _, ok := actionByID(p.Show, "end_session"); ok {
		t.Fatalf("end_session offered without the policy: %+v", p.Show.Actions)
	}
	if _, ok := actionByID(p.Show, "report_problem"); !ok {
		t.Fatalf("report_problem missing: %+v", p.Show.Actions)
	}
	h, dir := consentHost(t, "remote.session@1")
	p.Owners = []prompthost.Owner{testOwner}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	s := dir.lastShow(t)
	for _, id := range []string{"end_session", "end_confirm"} {
		if res := act(t, h, "native-1", s, id); res.Result != ipc.PromptActionRejectedInvalid {
			t.Fatalf("%s without the policy = %+v, want rejected_invalid", id, res)
		}
	}
	// Even a renderer quoting an action it was never offered cannot reach
	// the domain's end: the domain refuses it as well.
	if out, err := p.OnAction("end_session", testOwner); err == nil && out.Accepted {
		t.Fatal("the domain accepted end_session without the policy")
	}
	if out, err := p.OnAction("end_confirm", testOwner); err == nil && out.Accepted {
		t.Fatal("the domain accepted end_confirm without the policy")
	}
	if ended != 0 {
		t.Fatal("the session was ended without the policy")
	}

	cfg.AllowUserEndSession = true
	on := RemoteSession("s-on", cfg, time.Now(), hooks)
	if a, ok := actionByID(on.Show, "end_session"); !ok || a.Role != ipc.PromptRoleNeutral || a.Label != "End session" {
		t.Fatalf("end_session = %+v (%v)", a, ok)
	}
	if len(on.Show.Actions) != 2 {
		t.Fatalf("actions = %+v", on.Show.Actions)
	}
}

func TestEndSessionRequiresConfirm(t *testing.T) {
	ended := 0
	cfg := consentCfg("block", 30_000)
	cfg.AllowUserEndSession = true
	p := RemoteSession("s-confirm", cfg, time.Now(), SessionHooks{EndConfirmed: func() { ended++ }})
	p.Owners = []prompthost.Owner{testOwner}
	h, dir := consentHost(t, "remote.session@1")
	dir.r.UILocale = "de-DE"
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	s := dir.lastShow(t)
	// end_confirm is not offered before end_session.
	if res := act(t, h, "native-1", s, "end_confirm"); res.Result != ipc.PromptActionRejectedInvalid || ended != 0 {
		t.Fatalf("end_confirm before end_session = %+v (ended %d)", res, ended)
	}
	res := act(t, h, "native-1", s, "end_session")
	if res.Result != ipc.PromptActionAccepted || ended != 0 {
		t.Fatalf("end_session = %+v (ended %d): it only asks", res, ended)
	}
	u := dir.lastUpdate(t)
	if u.State != nil && *u.State != ipc.PromptStatePending {
		t.Fatalf("the confirm step stays pending: %v", *u.State)
	}
	if u.Actions == nil || len(*u.Actions) != 2 || u.DefaultActionID != "keep_session" {
		t.Fatalf("confirm actions = %+v default %q", u.Actions, u.DefaultActionID)
	}
	keep, _ := actionByID(ipc.PromptShow{Actions: *u.Actions}, "keep_session")
	confirm, _ := actionByID(ipc.PromptShow{Actions: *u.Actions}, "end_confirm")
	if keep.Role != ipc.PromptRoleSafe || confirm.Role != ipc.PromptRoleProceed || keep.Label != "Sitzung fortsetzen" || confirm.Label != "Sitzung beenden" {
		t.Fatalf("confirm set = keep %+v confirm %+v", keep, confirm)
	}
	if u.Copy == nil || u.Copy.StateDetail != "Diese Remotesitzung beenden? Die Verbindung des Technikers wird getrennt." {
		t.Fatalf("stateDetail = %+v", u.Copy)
	}
	// keep_session goes back to the normal set.
	cur := s
	cur.Rev = u.Rev
	if res := act(t, h, "native-1", cur, "keep_session"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("keep_session = %+v", res)
	}
	back := dir.lastUpdate(t)
	if back.Actions == nil || len(*back.Actions) != 2 || back.Copy == nil || back.Copy.StateDetail != "" {
		t.Fatalf("back = %+v %+v", back.Actions, back.Copy)
	}
	if _, ok := actionByID(ipc.PromptShow{Actions: *back.Actions}, "end_session"); !ok || ended != 0 {
		t.Fatalf("keep_session must restore end_session and not end (ended %d)", ended)
	}
	// end_session, then end_confirm: the session ends once and the pill closes.
	cur.Rev = back.Rev
	res = act(t, h, "native-1", cur, "end_session")
	cur.Rev = res.Rev
	if res := act(t, h, "native-1", cur, "end_confirm"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("end_confirm = %+v", res)
	}
	if ended != 1 {
		t.Fatalf("ended %d times, want once", ended)
	}
	if h.IsOpen(p.ID) || dir.count(ipc.TypePromptClose) != 1 {
		t.Fatalf("the pill must close resolved (open %v, closes %d)", h.IsOpen(p.ID), dir.count(ipc.TypePromptClose))
	}
	if c := dir.lastClose(t); c.Reason != ipc.PromptCloseResolved {
		t.Fatalf("close = %+v", c)
	}
	// A duplicate end_confirm does not end it twice.
	act(t, h, "native-1", cur, "end_confirm")
	if ended != 1 {
		t.Fatalf("a duplicate end_confirm ended it again (%d)", ended)
	}
}

func (d *oneRenderer) lastUpdate(t *testing.T) ipc.PromptUpdate {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := len(d.sent) - 1; i >= 0; i-- {
		if u, ok := d.sent[i].payload.(ipc.PromptUpdate); ok {
			return u
		}
	}
	t.Fatal("no prompt_update sent")
	return ipc.PromptUpdate{}
}

func (d *oneRenderer) lastClose(t *testing.T) ipc.PromptClose {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := len(d.sent) - 1; i >= 0; i-- {
		if c, ok := d.sent[i].payload.(ipc.PromptClose); ok {
			return c
		}
	}
	t.Fatal("no prompt_close sent")
	return ipc.PromptClose{}
}

func TestReportProblemAccepted(t *testing.T) {
	reports := 0
	p := RemoteSession("s-report", consentCfg("block", 30_000), time.Now(), SessionHooks{ReportProblem: func(prompthost.Owner) { reports++ }})
	p.Owners = []prompthost.Owner{testOwner}
	h, dir := consentHost(t, "remote.session@1")
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	s := dir.lastShow(t)
	for i := 0; i < 2; i++ {
		if res := act(t, h, "native-1", s, "report_problem"); res.Result != ipc.PromptActionAccepted || res.Rev != s.Rev {
			t.Fatalf("report_problem #%d = %+v (no state change)", i+1, res)
		}
	}
	if reports != 2 || !h.IsOpen(p.ID) || dir.count(ipc.TypePromptUpdate) != 0 {
		t.Fatalf("reports %d open %v updates %d", reports, h.IsOpen(p.ID), dir.count(ipc.TypePromptUpdate))
	}
}
