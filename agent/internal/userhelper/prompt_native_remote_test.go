package userhelper

import (
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
)

// W06 (#10190): the native user-helper draws remote.consent@1 (every OS
// whose native dialog can default to Deny) and remote.session@1 (Windows,
// where the native pill exists). All the logic is untagged so every OS's CI
// run checks every platform.

func TestNativeAdvertisesTheRemoteKinds(t *testing.T) {
	for _, tc := range []struct {
		goos    string
		consent bool
		want    []string
	}{
		{"windows", true, []string{"notice.info@1", "restart.prompt@1", "restart.final@1", "remote.consent@1", "remote.session@1"}},
		{"darwin", true, []string{"notice.info@1", "restart.prompt@1", "restart.final@1", "remote.consent@1"}},
		{"linux", true, []string{"notice.info@1", "restart.prompt@1", "restart.final@1", "remote.consent@1"}},
		// No zenity or no display: no native consent (the same rule as
		// SupportsConsentUI), so the agent never hands it one.
		{"linux", false, []string{"notice.info@1", "restart.prompt@1", "restart.final@1"}},
	} {
		if got := nativePromptKindsFor(ipc.HelperRoleUser, tc.goos, tc.consent); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s consent=%v advertises %v, want %v", tc.goos, tc.consent, got, tc.want)
		}
	}
	for _, role := range []ipc.HelperRole{ipc.HelperRoleSystem, ipc.HelperRoleAssist, ipc.HelperRoleWatchdog} {
		if got := nativePromptKindsFor(role, "windows", true); len(got) != 0 {
			t.Fatalf("role %s advertises %v", role, got)
		}
	}
}

// wireShow gives a constructor's show the fields the host adds on the wire.
func wireShow(p prompthost.Prompt) ipc.PromptShow {
	s := p.Show
	s.Rev, s.Lease = 1, ipc.PromptLease{RendererSession: "native-1", Epoch: 1}
	return s
}

func remoteCfg(allowEnd bool) ipc.DesktopPrompt {
	tech, org := "Dana Reyes", "Northwind IT"
	return ipc.DesktopPrompt{Mode: "consent", TechnicianName: &tech, OrgName: &org, ConsentUnavailableBehavior: "block", ConsentTimeoutMs: 30_000, ShowIndicator: true, AllowUserEndSession: allowEnd}
}

// TestNativeConsentDefaultDenyAndEscDeny: the agent's real consent prompt on
// every native dialog: Deny is the default button and what Esc or the close
// box answer; a countdown running out is never an answer.
func TestNativeConsentDefaultDenyAndEscDeny(t *testing.T) {
	req := ipc.ConsentRequest{SessionID: "s1", TechnicianName: "Dana Reyes", OrgName: "Northwind IT", TimeoutMs: 30_000, OnTimeout: "proceed", Nonce: "0123456789abcdef0123456789abcdef"}
	show := wireShow(promptkinds.RemoteConsent(req, remoteCfg(false), promptkinds.ConsentHooks{}))
	m, err := buildNativePromptModel(show, nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if m.DefaultID != "deny" || m.CancelID != "deny" || !m.Decision {
		t.Fatalf("default %q cancel %q decision %v", m.DefaultID, m.CancelID, m.Decision)
	}
	if len(m.Buttons) != 2 || m.Buttons[0].ID != "deny" || m.Buttons[0].Label != "Deny" || m.Buttons[1].Label != "Allow" {
		t.Fatalf("buttons = %+v", m.Buttons)
	}
	// The consequence sentence is on the dialog, with the countdown filled.
	if !strings.Contains(m.Body, "If no one answers, the session starts in 0:30.") {
		t.Fatalf("body = %q", m.Body)
	}
	if m.Response != 30*time.Second {
		t.Fatalf("response window = %v", m.Response)
	}
	// Windows: TaskDialogIndirect with real Allow / Deny buttons, Deny the
	// default, Esc allowed (and mapped to Deny).
	spec := nativeTaskDialogSpecFor(m)
	if spec.Buttons[spec.DefaultButtonIndex()].ID != "deny" || !spec.AllowCancel || spec.Buttons[0].Label != "Deny" || spec.Buttons[1].Label != "Allow" {
		t.Fatalf("task dialog = %+v", spec)
	}
	if got := classifyNativeResult(m, nativeResultCancel, ""); got.ActionID != "deny" {
		t.Fatalf("Esc = %+v", got)
	}
	if got := classifyNativeResult(m, nativeResultTimeout, ""); got.ActionID != "" || !got.TimedOut {
		t.Fatalf("timeout = %+v; the agent's timer decides", got)
	}
	// The message-box fallback: No (Deny) is the default button.
	box := nativeMessageBoxSpecFor(m)
	if box.NoID != "deny" || box.YesID != "allow" || box.Flags&consentMBDefButton2 == 0 {
		t.Fatalf("message box = %+v", box)
	}
	// macOS: Deny is the default and the cancel button.
	if script := nativePromptOsascript(m, nativeNow); !strings.Contains(script, `default button "Deny"`) || !strings.Contains(script, `cancel button "Deny"`) {
		t.Fatalf("osascript = %s", script)
	}
	// Linux: Deny is the focused cancel button.
	args := strings.Join(nativePromptZenityArgs(m, nativeNow), " ")
	if !strings.Contains(args, "--cancel-label Deny") || !strings.Contains(args, "--ok-label Allow") || !strings.Contains(args, "--default-cancel") {
		t.Fatalf("zenity = %s", args)
	}
	if got := classifyNativeZenity(m, 1); got.ActionID != "deny" {
		t.Fatalf("zenity Esc = %+v", got)
	}
}

func sessionShow(t *testing.T, allowEnd bool) ipc.PromptShow {
	t.Helper()
	return wireShow(promptkinds.RemoteSession("s1", remoteCfg(allowEnd), time.UnixMilli(1793019600000), promptkinds.SessionHooks{}))
}

// TestPillClickThroughWhenNotAllowed: the Windows pill stays hit-test
// invisible unless End session is offered.
func TestPillClickThroughWhenNotAllowed(t *testing.T) {
	off, err := nativeIndicatorModelFor(sessionShow(t, false), nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if off.Clickable || pillExStyle(off.Clickable)&pillExTransparent == 0 {
		t.Fatalf("not allowed: clickable %v style %#x", off.Clickable, pillExStyle(off.Clickable))
	}
	if off.Label != "Dana Reyes from Northwind IT is connected" || off.StartedAtUnixMs != 1793019600000 {
		t.Fatalf("pill = %+v", off)
	}
	// The fact value is exactly {time:<unixMs>} (what Assist fills).
	var started string
	for _, f := range sessionShow(t, false).Facts {
		if f.Label == "Started" {
			started = f.Value
		}
	}
	if started != "{time:1793019600000}" {
		t.Fatalf("started-at fact = %q", started)
	}
	on, err := nativeIndicatorModelFor(sessionShow(t, true), nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if !on.Clickable || pillExStyle(on.Clickable)&pillExTransparent != 0 {
		t.Fatalf("allowed: clickable %v style %#x", on.Clickable, pillExStyle(on.Clickable))
	}
	if !strings.HasSuffix(on.Label, " · End session") {
		t.Fatalf("a clickable pill says what a click does: %q", on.Label)
	}
	for _, style := range []uint32{pillExStyle(false), pillExStyle(true)} {
		for _, bit := range []uint32{pillExTopmost, pillExToolwindow, pillExNoactivate, pillExLayered} {
			if style&bit == 0 {
				t.Fatalf("style %#x lost %#x: the pill never activates or leaves the top", style, bit)
			}
		}
	}
	if on.Confirm != nil || off.Confirm != nil {
		t.Fatal("no confirm before End session")
	}
}

// fakePill records the native pill.
type fakePill struct {
	mu      sync.Mutex
	shows   []nativeIndicatorModel
	hides   int
	onClick func()
	fail    bool
}

func (f *fakePill) show(_ string, m nativeIndicatorModel, onClick func()) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return false
	}
	f.shows = append(f.shows, m)
	f.onClick = onClick
	return true
}

func (f *fakePill) hide(string) {
	f.mu.Lock()
	f.hides++
	f.mu.Unlock()
}

func (f *fakePill) last() (nativeIndicatorModel, func(), int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.shows) == 0 {
		return nativeIndicatorModel{}, nil, f.hides
	}
	return f.shows[len(f.shows)-1], f.onClick, f.hides
}

func (s *promptSink) all(typ string) []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []any
	for _, m := range s.sent {
		if m.typ == typ {
			out = append(out, m.payload)
		}
	}
	return out
}

func waitN(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestEndSessionRequiresConfirmOnTheNativePill: a click asks the agent to
// end (end_session); the agent's confirm step is a native dialog whose
// default — and Esc — is Keep session.
func TestEndSessionRequiresConfirmOnTheNativePill(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	sink := &promptSink{}
	pill := &fakePill{}
	r := newNativePromptRenderer([]string{"remote.session@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	r.indicatorShow, r.indicatorHide = pill.show, pill.hide
	show := sessionShow(t, true)
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	if p := sink.waitFor(t, ipc.TypePromptPresented).(ipc.PromptPresented); p.Lease != show.Lease || !p.Visible {
		t.Fatalf("presented = %+v", p)
	}
	m, click, _ := pill.last()
	if !m.Clickable || click == nil {
		t.Fatalf("pill = %+v", m)
	}
	click()
	a := sink.waitFor(t, ipc.TypePromptAction).(ipc.PromptActionRequest)
	if a.ActionID != "end_session" || a.Rev != show.Rev || a.Lease != show.Lease {
		t.Fatalf("click = %+v", a)
	}
	// No dialog yet: the agent decides whether to ask.
	fake.mu.Lock()
	dialogs := len(fake.models)
	fake.mu.Unlock()
	if dialogs != 0 {
		t.Fatal("the pill drew a dialog before the agent asked for the confirm step")
	}

	// The agent's confirm step.
	confirm := []ipc.PromptAction{{ID: "keep_session", Label: "Keep session", Role: ipc.PromptRoleSafe}, {ID: "end_confirm", Label: "End session", Role: ipc.PromptRoleProceed}}
	cp := show.Copy
	cp.StateDetail = "End this remote session? The technician will be disconnected."
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: 2, Lease: show.Lease, Copy: &cp, Actions: &confirm, DefaultActionID: "keep_session"}))
	waitN(t, func() bool { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.models) == 1 }, "the confirm dialog")
	fake.mu.Lock()
	dlg := fake.models[0]
	fake.mu.Unlock()
	if dlg.DefaultID != "keep_session" || dlg.CancelID != "keep_session" || !strings.Contains(dlg.Body, "The technician will be disconnected.") {
		t.Fatalf("confirm dialog = %+v", dlg)
	}
	// The started-at fact travels as {time:<unixMs>}; the native dialog
	// shows a clock time, never the raw token.
	if strings.Contains(dlg.Body, "{time:") || !strings.Contains(dlg.Body, "Started: ") {
		t.Fatalf("confirm body shows the raw time token: %q", dlg.Body)
	}
	if pm, _, _ := pill.last(); pm.Clickable {
		t.Fatal("the pill is not clickable while its confirm dialog is up")
	}
	fake.outcome <- classifyNativeResult(dlg, nativeResultButton, "end_confirm")
	waitN(t, func() bool { return len(sink.all(ipc.TypePromptAction)) == 2 }, "end_confirm")
	got := sink.all(ipc.TypePromptAction)[1].(ipc.PromptActionRequest)
	if got.ActionID != "end_confirm" || got.Rev != 2 || got.Lease != show.Lease {
		t.Fatalf("confirm = %+v", got)
	}

	// The agent closes the indicator: the pill comes down silently.
	r.handle(envelopeFor(t, ipc.TypePromptClose, ipc.PromptClose{PromptID: show.PromptID, Rev: 2, Lease: show.Lease, Reason: ipc.PromptCloseResolved}))
	waitN(t, func() bool { _, _, hides := pill.last(); return hides == 1 }, "the pill hidden")
	if n := len(sink.all(ipc.TypePromptClosed)); n != 0 {
		t.Fatalf("an agent close is never answered (%d prompt_closed)", n)
	}
}

func TestNativePillEscOnConfirmKeepsTheSession(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	sink := &promptSink{}
	pill := &fakePill{}
	r := newNativePromptRenderer([]string{"remote.session@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	r.indicatorShow, r.indicatorHide = pill.show, pill.hide
	show := sessionShow(t, true)
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	confirm := []ipc.PromptAction{{ID: "keep_session", Label: "Keep session", Role: ipc.PromptRoleSafe}, {ID: "end_confirm", Label: "End session", Role: ipc.PromptRoleProceed}}
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: 2, Lease: show.Lease, Actions: &confirm, DefaultActionID: "keep_session"}))
	waitN(t, func() bool { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.models) == 1 }, "the confirm dialog")
	fake.mu.Lock()
	dlg := fake.models[0]
	fake.mu.Unlock()
	fake.outcome <- classifyNativeResult(dlg, nativeResultCancel, "")
	a := sink.waitFor(t, ipc.TypePromptAction).(ipc.PromptActionRequest)
	if a.ActionID != "keep_session" || a.Rev != 2 {
		t.Fatalf("Esc on the confirm = %+v, want keep_session", a)
	}
	// Back to the normal set: the confirm dialog is gone and the pill is
	// clickable again.
	normal := show.Actions
	r.handle(envelopeFor(t, ipc.TypePromptUpdate, ipc.PromptUpdate{PromptID: show.PromptID, Rev: 3, Lease: show.Lease, Actions: &normal}))
	waitN(t, func() bool { m, _, _ := pill.last(); return m.Clickable }, "a clickable pill again")
}

func TestNativePillWithoutEndSessionIgnoresClicks(t *testing.T) {
	sink := &promptSink{}
	pill := &fakePill{}
	r := newNativePromptRenderer([]string{"remote.session@1"}, (&fakeNativeShow{}).show, sink.send, func() time.Time { return nativeNow })
	r.indicatorShow, r.indicatorHide = pill.show, pill.hide
	r.handle(envelopeFor(t, ipc.TypePromptShow, sessionShow(t, false)))
	sink.waitFor(t, ipc.TypePromptPresented)
	if _, click, _ := pill.last(); click != nil {
		click() // a click that reaches it anyway
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(sink.all(ipc.TypePromptAction)); n != 0 {
		t.Fatalf("a pill without End session sent %d actions", n)
	}
}

func TestNativePillThatCannotBeDrawnIsRefused(t *testing.T) {
	sink := &promptSink{}
	pill := &fakePill{fail: true}
	r := newNativePromptRenderer([]string{"remote.session@1"}, (&fakeNativeShow{}).show, sink.send, func() time.Time { return nativeNow })
	r.indicatorShow, r.indicatorHide = pill.show, pill.hide
	r.handle(envelopeFor(t, ipc.TypePromptShow, sessionShow(t, true)))
	if c := sink.waitFor(t, ipc.TypePromptClosed).(ipc.PromptClosed); c.Reason != ipc.PromptClosedRenderFailed {
		t.Fatalf("closed = %+v", c)
	}
}
