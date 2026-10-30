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

// elevation.request@1 (#10190 W07) through a real prompt host.

const elevationRequestID = "0f4c9e2a-6b1d-4c3e-9a7f-2d8e5b1c0a91"

var (
	elevAssist = prompthost.RendererSession{Key: "assist-1", Role: ipc.HelperRoleAssist, Owner: testOwner, Protocol: 1, KindAds: []string{"elevation.request@1"}, ConnectedAt: testNow}
	elevSystem = prompthost.RendererSession{Key: "system-1", Role: ipc.HelperRoleSystem, Owner: testOwner, Protocol: 1, KindAds: []string{"elevation.request@1"}, ConnectedAt: testNow}
)

type elevationCalls struct {
	mu       sync.Mutex
	answered []string
	cancels  int
	refuse   bool
	expired  []ipc.PromptState
	lost     []string
}

func (c *elevationCalls) hooks() ElevationHooks {
	return ElevationHooks{
		Answered: func(a string, _ ipc.HelperRole) { c.mu.Lock(); c.answered = append(c.answered, a); c.mu.Unlock() },
		CancelRequest: func(ipc.HelperRole) bool {
			c.mu.Lock()
			defer c.mu.Unlock()
			c.cancels++
			return !c.refuse
		},
		Expired: func(s ipc.PromptState) { c.mu.Lock(); c.expired = append(c.expired, s); c.mu.Unlock() },
		Lost: func(_ prompthost.PlacementInfo, r string) {
			c.mu.Lock()
			c.lost = append(c.lost, r)
			c.mu.Unlock()
		},
	}
}

func elevationHost(t *testing.T, renderers ...prompthost.RendererSession) (*prompthost.Host, *multiDir) {
	t.Helper()
	dir := &multiDir{rs: renderers}
	h := prompthost.New(prompthost.Deps{Broker: dir, Inbox: &entries{m: map[string]prompthost.ListEntry{}}, Clock: &settableClock{t: testNow}})
	Register(h)
	h.SetEnabledKinds([]string{"elevation.request"})
	return h, dir
}

func elevationParams(secure bool) ElevationParams {
	return ElevationParams{
		RequestID:          elevationRequestID,
		ProgramPath:        `C:\Program Files\7-Zip\7zFM.exe`,
		Publisher:          "Igor Pavlov",
		CommandLine:        `"C:\Program Files\7-Zip\7zFM.exe" {abc}`,
		Partner:            "Northwind IT",
		FirstQuestionRoles: FirstQuestionRoles(secure),
		WaitingDeadline:    testNow.Add(15 * time.Minute),
	}
}

func showElevation(t *testing.T, h *prompthost.Host, e *Elevation) {
	t.Helper()
	p := e.Prompt()
	p.Owners = []prompthost.Owner{testOwner}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
}

func showsIn(msgs []sent) []ipc.PromptShow {
	var out []ipc.PromptShow
	for _, m := range msgs {
		if s, ok := m.payload.(ipc.PromptShow); ok {
			out = append(out, s)
		}
	}
	return out
}

func closesIn(msgs []sent) []ipc.PromptClose {
	var out []ipc.PromptClose
	for _, m := range msgs {
		if c, ok := m.payload.(ipc.PromptClose); ok {
			out = append(out, c)
		}
	}
	return out
}

func TestElevationRegisteredAppendOnlyAfterW06(t *testing.T) {
	specs := Specs()
	if got := specs[len(specs)-1]; got.Name != "elevation.request" || got.Version != 1 {
		t.Fatalf("last registered kind = %s@%d, want elevation.request@1 appended after W06", got.Name, got.Version)
	}
}

func TestFirstQuestionRendererBySecureDesktopSetting(t *testing.T) {
	for _, tc := range []struct {
		secure bool
		want   string
	}{{true, "system-1"}, {false, "assist-1"}} {
		h, dir := elevationHost(t, elevAssist, elevSystem)
		e := NewElevation(elevationParams(tc.secure), (&elevationCalls{}).hooks())
		showElevation(t, h, e)
		for _, key := range []string{"assist-1", "system-1"} {
			shows := showsIn(dir.take(key))
			if (key == tc.want) != (len(shows) == 1) {
				t.Fatalf("secure=%v: %s got %d shows, want the first question only on %s", tc.secure, key, len(shows), tc.want)
			}
			if len(shows) == 1 {
				s := shows[0]
				if s.State != ipc.PromptStatePending || s.Presentation != ipc.PromptPresentationModal || s.DefaultActionID != ActionCancel {
					t.Fatalf("first question = %s/%s default %s", s.State, s.Presentation, s.DefaultActionID)
				}
				if s.Timing.ResponseMs != ElevationFirstQuestionMs || s.Timing.Expiry == nil || !strings.Contains(s.Timing.Expiry.Text, "{remaining}") {
					t.Fatalf("first question timing = %+v", s.Timing)
				}
			}
		}
	}
}

func TestSendRequestFencesTheFirstQuestionThenWaitsOnAssist(t *testing.T) {
	h, dir := elevationHost(t, elevAssist, elevSystem)
	calls := &elevationCalls{}
	e := NewElevation(elevationParams(true), calls.hooks())
	showElevation(t, h, e)
	first := showsIn(dir.take("system-1"))[0]
	if res := act(t, h, "system-1", first, ActionSendRequest); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("send_request = %s", res.Result)
	}
	if c := closesIn(dir.take("system-1")); len(c) != 1 || c[0].Reason != ipc.PromptCloseFenced {
		t.Fatalf("the SYSTEM copy must be fenced at once: %+v", c)
	}
	if n := len(showsIn(dir.take("assist-1"))); n != 0 {
		t.Fatalf("the waiting card was drawn before the UAC prompt was dismissed (%d shows)", n)
	}
	patch, err := e.WaitingPatch(true)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Update(e.ID(), patch); err != nil {
		t.Fatal(err)
	}
	shows := showsIn(dir.take("assist-1"))
	if len(shows) != 1 {
		t.Fatalf("Assist shows = %d", len(shows))
	}
	w := shows[0]
	if w.State != ipc.PromptStateWaiting || w.Presentation != ipc.PromptPresentationCard || w.Focus != ipc.PromptFocusNoActivate {
		t.Fatalf("waiting card = %s/%s/%s", w.State, w.Presentation, w.Focus)
	}
	if w.Lease.RendererSession != "assist-1" || w.Rev <= first.Rev {
		t.Fatalf("waiting lease %+v rev %d", w.Lease, w.Rev)
	}
	if w.Actions[0].ID != ActionCancelRequest || w.Actions[0].Role != ipc.PromptRoleSafe || w.Actions[1].ID != ActionHide || w.Actions[1].Role != ipc.PromptRoleNeutral || w.DefaultActionID != ActionHide {
		t.Fatalf("waiting actions = %+v default %s", w.Actions, w.DefaultActionID)
	}
	want := testNow.Add(15 * time.Minute).UnixMilli()
	if w.Timing.DeadlineUnixMs != want || !strings.Contains(w.Copy.StateDetail, "{time:") || w.Copy.Title != "Waiting for Northwind IT" {
		t.Fatalf("waiting copy %+v timing %+v", w.Copy, w.Timing)
	}
	if got := calls.answered; len(got) != 1 || got[0] != ActionSendRequest {
		t.Fatalf("answered = %v", got)
	}
}

func TestUnprovenDismissCopy(t *testing.T) {
	e := NewElevation(elevationParams(true), ElevationHooks{})
	p, err := e.WaitingPatch(false)
	if err != nil {
		t.Fatal(err)
	}
	if p.Copy.StateDetail != "You can close the Windows prompt; your request stays with Northwind IT." {
		t.Fatalf("unproven dismiss detail = %q", p.Copy.StateDetail)
	}
	generic := elevationParams(true)
	generic.Partner = ""
	p, err = NewElevation(generic, ElevationHooks{}).WaitingPatch(false)
	if err != nil || !strings.Contains(p.Copy.StateDetail, "your IT support team") {
		t.Fatalf("generic unproven detail = %q, %v", p.Copy.StateDetail, err)
	}
}

func TestHideDoesNotCancel(t *testing.T) {
	h, dir := elevationHost(t, elevAssist)
	calls := &elevationCalls{}
	e := NewElevation(elevationParams(false), calls.hooks())
	showElevation(t, h, e)
	first := showsIn(dir.take("assist-1"))[0]
	act(t, h, "assist-1", first, ActionSendRequest)
	patch, _ := e.WaitingPatch(true)
	if err := h.Update(e.ID(), patch); err != nil {
		t.Fatal(err)
	}
	w := lastShowOf(t, dir.take("assist-1"))
	if res := act(t, h, "assist-1", w, ActionHide); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("hide = %s", res.Result)
	}
	if calls.cancels != 0 || !h.IsOpen(e.ID()) {
		t.Fatalf("hide cancelled the request (cancels %d, open %v)", calls.cancels, h.IsOpen(e.ID()))
	}
	if n := len(closesIn(dir.take("assist-1"))); n != 0 {
		t.Fatalf("hide closed the prompt agent-side (%d closes)", n)
	}
	// Cancel request is the decision: accepted, cancelled, the hook ran once.
	if res := act(t, h, "assist-1", w, ActionCancelRequest); res.Result != ipc.PromptActionAccepted || calls.cancels != 1 {
		t.Fatalf("cancel_request = %s, cancels %d", res.Result, calls.cancels)
	}
	msgs := dir.take("assist-1")
	var cancelled bool
	for _, m := range msgs {
		if u, ok := m.payload.(ipc.PromptUpdate); ok && u.State != nil && *u.State == ipc.PromptStateCancelled {
			cancelled = true
		}
	}
	if !cancelled {
		t.Fatal("cancel_request did not move the card to cancelled")
	}
}

func TestCancelRequestRefusedWhenAlreadyDecided(t *testing.T) {
	h, dir := elevationHost(t, elevAssist)
	calls := &elevationCalls{refuse: true}
	e := NewElevation(elevationParams(false), calls.hooks())
	showElevation(t, h, e)
	act(t, h, "assist-1", showsIn(dir.take("assist-1"))[0], ActionSendRequest)
	patch, _ := e.WaitingPatch(true)
	_ = h.Update(e.ID(), patch)
	w := lastShowOf(t, dir.take("assist-1"))
	if res := act(t, h, "assist-1", w, ActionCancelRequest); res.Result == ipc.PromptActionAccepted {
		t.Fatal("a cancel the domain refused was accepted")
	}
}

func TestTechnicianNameShownOnlyWhenSent(t *testing.T) {
	e := NewElevation(elevationParams(true), ElevationHooks{})
	p, err := e.OutcomePatch(ipc.PromptStateApproved, "Dana Scully", "")
	if err != nil || p.Copy.Body != "Dana Scully at Northwind IT approved 7zFM.exe. It is starting." {
		t.Fatalf("approved with a name = %q, %v", p.Copy.Body, err)
	}
	p, err = e.OutcomePatch(ipc.PromptStateApproved, "", "")
	if err != nil || p.Copy.Body != "Northwind IT approved 7zFM.exe. It is starting." || strings.Contains(p.Copy.Body, "Dana") {
		t.Fatalf("approved without a name = %q, %v", p.Copy.Body, err)
	}
	// A hostile name is sanitized: no bidi override, no placeholder.
	p, _ = e.OutcomePatch(ipc.PromptStateApproved, "Eve\u202e{remaining}", "")
	if strings.ContainsRune(p.Copy.Body, '\u202e') || strings.Contains(p.Copy.Body, "{remaining}") {
		t.Fatalf("hostile technician name reached the copy: %q", p.Copy.Body)
	}
}

func TestDeniedReasonSanitized(t *testing.T) {
	e := NewElevation(elevationParams(true), ElevationHooks{})
	reason := "Not approved\n\u202eon this {time:1} device" + strings.Repeat("x", 600)
	p, err := e.OutcomePatch(ipc.PromptStateDenied, "", reason)
	if err != nil {
		t.Fatal(err)
	}
	var got string
	for _, f := range *p.Facts {
		if f.Label == "Reason" {
			got = f.Value
		}
	}
	if got == "" || strings.ContainsAny(got, "\n\u202e{}") || len([]rune(got)) > maxElevationReasonRunes {
		t.Fatalf("reason fact = %q", got)
	}
	if !strings.HasPrefix(got, "Not approved ") {
		t.Fatalf("reason lost its text: %q", got)
	}
	if p.Copy.Title != "Request denied" || p.Roles == nil || (*p.Roles)[0] != ipc.HelperRoleAssist {
		t.Fatalf("denied patch = %+v", p)
	}
}

func TestCommandLineBracesNeverBecomePlaceholders(t *testing.T) {
	e := NewElevation(elevationParams(true), ElevationHooks{})
	s := e.Prompt().Show
	for _, f := range s.Facts {
		if strings.ContainsAny(f.Value, "{}") {
			t.Fatalf("fact %q = %q carries a renderer brace", f.Label, f.Value)
		}
	}
	if len(s.Facts) != 3 || s.Facts[0].Value != "7zFM.exe" {
		t.Fatalf("facts = %+v", s.Facts)
	}
}

func TestFirstQuestionIsNeverReaskedButTheCardIs(t *testing.T) {
	e := NewElevation(elevationParams(true), ElevationHooks{})
	if p := e.Prompt(); !p.NeverReask || len(p.Roles) != 1 || p.Roles[0] != ipc.HelperRoleSystem {
		t.Fatalf("first question NeverReask %v roles %v", p.NeverReask, p.Roles)
	}
	p, _ := e.WaitingPatch(true)
	if p.NeverReask == nil || *p.NeverReask {
		t.Fatal("the waiting card must be replayable")
	}
}

func TestElevationCopyInEveryLocale(t *testing.T) {
	e := NewElevation(elevationParams(true), ElevationHooks{})
	for _, loc := range []string{"en", "de-DE", "es-419", "fr-FR", "fr-CA", "it-IT", "pt-BR", "tr-TR"} {
		for _, state := range []ipc.PromptState{ipc.PromptStatePending, ipc.PromptStateWaiting, ipc.PromptStateApproved, ipc.PromptStateFailed, ipc.PromptStateDenied, ipc.PromptStateExpired, ipc.PromptStateCancelled} {
			l, err := e.render(promptcatalog.Locale(loc), elevationView{state: state, technician: "Dana", reason: "no"})
			if err != nil || l.Copy.Title == "" || l.Copy.Body == "" {
				t.Fatalf("%s %s: %+v %v", loc, state, l.Copy, err)
			}
		}
	}
}
