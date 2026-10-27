package userhelper

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var nativeNow = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

func nativeFixture(t *testing.T, name string) ipc.PromptShow {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "prompt-host", name))
	if err != nil {
		t.Fatal(err)
	}
	var show ipc.PromptShow
	if err := json.Unmarshal(raw, &show); err != nil {
		t.Fatal(err)
	}
	return show
}

func TestNativeModelDefaultIsSafe(t *testing.T) {
	m, err := buildNativePromptModel(nativeFixture(t, "show.restart.json"), nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if m.DefaultID != "postpone" {
		t.Fatalf("default = %q, want the safe action postpone", m.DefaultID)
	}
	if len(m.Buttons) != 2 || m.Buttons[0].ID != "postpone" || m.Buttons[0].Role != ipc.PromptRoleSafe {
		t.Fatalf("buttons = %+v; the safe action comes first", m.Buttons)
	}
	if m.Buttons[0].Label != "Postpone until 14:00" {
		t.Fatalf("label placeholders not rendered: %q", m.Buttons[0].Label)
	}
	if !strings.Contains(m.Body, "Questions? Call the help desk.") {
		t.Fatalf("operator note missing from the body: %q", m.Body)
	}
	if !strings.Contains(m.Body, "restarts at 13:00") || !strings.Contains(m.Body, "Time left: 60:00") {
		t.Fatalf("time placeholders not rendered: %q", m.Body)
	}
	if !m.Deadline.Equal(time.UnixMilli(1793019600000)) {
		t.Fatalf("deadline = %v", m.Deadline)
	}
	// Every platform's spec honours the safe default.
	if spec := nativeTaskDialogSpecFor(m); spec.Buttons[spec.DefaultButtonIndex()].ID != "postpone" || !spec.AllowCancel {
		t.Fatalf("task dialog default = %+v", spec)
	}
	if script := nativePromptOsascript(m, nativeNow); !strings.Contains(script, `default button "Postpone until 14:00"`) || !strings.Contains(script, `cancel button "Postpone until 14:00"`) {
		t.Fatalf("osascript = %s", script)
	}
	args := strings.Join(nativePromptZenityArgs(m, nativeNow), " ")
	if !strings.Contains(args, "--cancel-label Postpone until 14:00") || !strings.Contains(args, "--ok-label Restart now") || !strings.Contains(args, "--default-cancel") {
		t.Fatalf("zenity = %s", args)
	}
}

func TestNativeModelEscMapsToSafeInPendingDecision(t *testing.T) {
	decision, err := buildNativePromptModel(nativeFixture(t, "show.restart.json"), nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if decision.CancelID != "postpone" {
		t.Fatalf("Esc on a pending decision = %q, want the safe action", decision.CancelID)
	}
	waiting, err := buildNativePromptModel(nativeFixture(t, "show.elevation.waiting.json"), nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if waiting.CancelID != "" {
		t.Fatalf("Esc on a waiting card = %q, want hide (no action)", waiting.CancelID)
	}
	// Result mapping: Esc and the close box give CancelID; a timeout is never a decision.
	if got := classifyNativeResult(decision, nativeResultCancel, ""); got.ActionID != "postpone" {
		t.Fatalf("Esc result = %+v", got)
	}
	if got := classifyNativeResult(waiting, nativeResultCancel, ""); got.ActionID != "" || !got.Hidden {
		t.Fatalf("Esc on a waiting card = %+v, want hidden", got)
	}
	if got := classifyNativeResult(decision, nativeResultTimeout, ""); got.ActionID != "" || !got.TimedOut {
		t.Fatalf("timeout = %+v, want no action (the agent's timer decides)", got)
	}
	if got := classifyNativeResult(decision, nativeResultButton, "restart_now"); got.ActionID != "restart_now" {
		t.Fatalf("button = %+v", got)
	}
	if got := classifyNativeResult(decision, nativeResultButton, "forged"); got.Err == nil {
		t.Fatal("an unknown button id must be an error, never an action")
	}
}

func TestNativeModelRefusesNoSafeDefault(t *testing.T) {
	show := nativeFixture(t, "show.restart.json")
	show.Actions[0].Role = ipc.PromptRoleProceed
	if _, err := buildNativePromptModel(show, nativeNow, time.UTC); !errors.Is(err, errNoSafeDefault) {
		t.Fatalf("err = %v, want errNoSafeDefault", err)
	}
	show = nativeFixture(t, "show.restart.json")
	show.DefaultActionID = "restart_now"
	if _, err := buildNativePromptModel(show, nativeNow, time.UTC); !errors.Is(err, errNoSafeDefault) {
		t.Fatalf("default on the proceed action: err = %v, want errNoSafeDefault", err)
	}
}

func TestNativeModelRefusesOperatorNoteOnBreezeKind(t *testing.T) {
	show := nativeFixture(t, "show.notice.json")
	show.Copy.OperatorNote = "Call 555-0100"
	if _, err := buildNativePromptModel(show, nativeNow, time.UTC); !errors.Is(err, errOperatorTextOnBreezeKind) {
		t.Fatalf("err = %v, want errOperatorTextOnBreezeKind", err)
	}
}

func TestNativePlaceholdersLeaveOperatorTextAndUnknownBracesLiteral(t *testing.T) {
	got := applyNativePlaceholders("{remaining} {{countdown}} {x} {time:1793019600000}", time.UnixMilli(1793016000000+59_000), nativeNow, time.UTC)
	if got != "0:59 {{countdown}} {x} 13:00" {
		t.Fatalf("got %q", got)
	}
	if got := applyNativePlaceholders("{remaining}", nativeNow.Add(-time.Hour), nativeNow, time.UTC); got != "0:00" {
		t.Fatalf("past deadline = %q, want 0:00", got)
	}
	if got := applyNativePlaceholders("{time:1793620800000}", time.Time{}, nativeNow, time.UTC); got != "Nov 2 12:00" {
		t.Fatalf("another day = %q", got)
	}
}

func TestNativeLinuxNeutralThirdActionDropped(t *testing.T) {
	show := nativeFixture(t, "show.restart.json")
	show.Actions = append(show.Actions, ipc.PromptAction{ID: "details", Label: "Details", Role: ipc.PromptRoleNeutral})
	m, err := buildNativePromptModel(show, nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(nativePromptZenityArgs(m, nativeNow), " ")
	if strings.Contains(args, "Details") {
		t.Fatalf("zenity cannot draw a third button: %s", args)
	}
	if strings.Contains(nativePromptOsascript(m, nativeNow), "Details") {
		t.Fatal("osascript must drop the neutral third action too")
	}
	if spec := nativeTaskDialogSpecFor(m); len(spec.Buttons) != 3 {
		t.Fatalf("Windows draws all three: %+v", spec.Buttons)
	}
}

// fakeNativeShow records dialogs and lets a test decide their outcome.
type fakeNativeShow struct {
	mu      sync.Mutex
	models  []nativePromptModel
	outcome chan nativeOutcome
}

func (f *fakeNativeShow) show(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome {
	f.mu.Lock()
	f.models = append(f.models, m)
	f.mu.Unlock()
	presented()
	select {
	case o := <-f.outcome:
		return o
	case <-ctx.Done():
		return nativeOutcome{Hidden: true}
	}
}

type sentPrompt struct {
	typ     string
	payload any
}

type promptSink struct {
	mu   sync.Mutex
	sent []sentPrompt
}

func (s *promptSink) send(typ string, payload any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent = append(s.sent, sentPrompt{typ, payload})
	return nil
}

func (s *promptSink) waitFor(t *testing.T, typ string) any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		for _, m := range s.sent {
			if m.typ == typ {
				s.mu.Unlock()
				return m.payload
			}
		}
		s.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no %s sent", typ)
	return nil
}

func (s *promptSink) types() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, m := range s.sent {
		out = append(out, m.typ)
	}
	return out
}

func envelopeFor(t *testing.T, typ string, payload any) *ipc.Envelope {
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &ipc.Envelope{ID: "e-1", Type: typ, Payload: raw}
}

func TestNativeRendererAdvertisesNothingInW02(t *testing.T) {
	if got := advertisedNativePromptKinds(ipc.HelperRoleUser); len(got) != 0 {
		t.Fatalf("W02 native helper advertises %v; it must advertise zero kinds", got)
	}
	if nativePromptProtocolFor(ipc.HelperRoleUser) != ipc.PromptProtocolVersion {
		t.Fatal("the user helper speaks the prompt protocol")
	}
	if nativePromptProtocolFor(ipc.HelperRoleSystem) != 0 {
		t.Fatal("the SYSTEM helper renderer ships in W07 (P14)")
	}
	sink := &promptSink{}
	r := newNativePromptRenderer(advertisedNativePromptKinds(ipc.HelperRoleUser), (&fakeNativeShow{}).show, sink.send, func() time.Time { return nativeNow })
	r.handle(envelopeFor(t, ipc.TypePromptShow, nativeFixture(t, "show.notice.json")))
	closed := sink.waitFor(t, ipc.TypePromptClosed).(ipc.PromptClosed)
	if closed.Reason != ipc.PromptClosedRenderFailed || closed.Detail != "unadvertised_kind" {
		t.Fatalf("closed = %+v; an unadvertised prompt_show is answered render_failed (rule 4)", closed)
	}
}

func TestNativeRendererPresentsAndReportsTheAction(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	sink := &promptSink{}
	r := newNativePromptRenderer([]string{"restart.prompt@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	show := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	p := sink.waitFor(t, ipc.TypePromptPresented).(ipc.PromptPresented)
	if p.Lease != show.Lease || p.Rev != show.Rev || !p.Visible {
		t.Fatalf("presented = %+v", p)
	}
	fake.outcome <- nativeOutcome{ActionID: "restart_now"}
	a := sink.waitFor(t, ipc.TypePromptAction).(ipc.PromptActionRequest)
	if a.ActionID != "restart_now" || a.Lease != show.Lease || a.Rev != show.Rev {
		t.Fatalf("action = %+v", a)
	}
}

func TestNativeRendererCloseTakesTheDialogDownSilently(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	sink := &promptSink{}
	r := newNativePromptRenderer([]string{"restart.prompt@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	show := nativeFixture(t, "show.restart.json")
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	r.handle(envelopeFor(t, ipc.TypePromptClose, ipc.PromptClose{PromptID: show.PromptID, Rev: show.Rev, Lease: show.Lease, Reason: ipc.PromptCloseFenced}))
	time.Sleep(50 * time.Millisecond)
	for _, typ := range sink.types() {
		if typ == ipc.TypePromptAction || typ == ipc.TypePromptClosed {
			t.Fatalf("a dialog the agent closed reported %s", typ)
		}
	}
	if r.activeCount() != 0 {
		t.Fatal("closed dialog still tracked")
	}
}

func TestNativeRendererStaleRevDropped(t *testing.T) {
	fake := &fakeNativeShow{outcome: make(chan nativeOutcome, 1)}
	sink := &promptSink{}
	r := newNativePromptRenderer([]string{"restart.prompt@1"}, fake.show, sink.send, func() time.Time { return nativeNow })
	show := nativeFixture(t, "show.restart.json")
	show.Rev = 5
	r.handle(envelopeFor(t, ipc.TypePromptShow, show))
	sink.waitFor(t, ipc.TypePromptPresented)
	old := show
	old.Rev = 4
	r.handle(envelopeFor(t, ipc.TypePromptShow, old))
	time.Sleep(30 * time.Millisecond)
	fake.mu.Lock()
	n := len(fake.models)
	fake.mu.Unlock()
	if n != 1 {
		t.Fatalf("an older rev was drawn (%d dialogs)", n)
	}
}
