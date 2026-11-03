package userhelper

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Every platform's result mapping runs on every OS's CI (the specs are
// untagged): a timeout is never a decision, Esc on a decision is the safe
// action, and an unrecognised result is an error, never an action.

func restartModel(t *testing.T) nativePromptModel {
	t.Helper()
	m, err := buildNativePromptModel(nativeFixture(t, "show.restart.json"), nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func waitingModel(t *testing.T) nativePromptModel {
	t.Helper()
	m, err := buildNativePromptModel(nativeFixture(t, "show.elevation.waiting.json"), nativeNow, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestNativeTaskDialogResultMapping(t *testing.T) {
	spec := nativeTaskDialogSpecFor(restartModel(t))
	for _, b := range spec.Buttons {
		if id, ok := spec.actionFor(b.ControlID); !ok || id != b.ID {
			t.Fatalf("control %d -> %q %v", b.ControlID, id, ok)
		}
	}
	if _, ok := spec.actionFor(nativeIDCancel); ok {
		t.Fatal("IDCANCEL must not map to a button; it maps to the model's CancelID")
	}
}

func TestNativeMessageBoxFallbackKeepsTheSafeDefault(t *testing.T) {
	s := nativeMessageBoxSpecFor(restartModel(t))
	if s.NoID != "postpone" || s.YesID != "restart_now" {
		t.Fatalf("yes/no = %q/%q, want restart_now/postpone", s.YesID, s.NoID)
	}
	if s.Flags&consentMBDefButton2 == 0 || s.Flags&consentMBYesNo == 0 {
		t.Fatalf("flags %#x: No (the safe action) must be the default", s.Flags)
	}
	if !strings.Contains(s.Body, "Select Yes to restart now, or No to postpone until 14:00.") {
		t.Fatalf("body must say what Yes and No mean: %q", s.Body)
	}
	w := nativeMessageBoxSpecFor(waitingModel(t))
	if w.Flags&consentMBYesNo != 0 || w.OKID != "hide" || w.Flags&0xF != nativeMBOK {
		t.Fatalf("a non-decision falls back to OK for its default: %+v", w)
	}
}

func TestNativeOsascriptResultMapping(t *testing.T) {
	m := restartModel(t)
	cases := []struct {
		out    string
		failed bool
		want   nativeOutcome
	}{
		{"button returned:Restart now, gave up:false", false, nativeOutcome{ActionID: "restart_now"}},
		{"button returned:Postpone until 14:00\n", false, nativeOutcome{ActionID: "postpone"}},
		{"execution error: User canceled. (-128)", true, nativeOutcome{ActionID: "postpone"}},
		{"button returned:, gave up:true", false, nativeOutcome{TimedOut: true}},
	}
	for _, tc := range cases {
		if got := classifyNativeOsascript(m, tc.out, tc.failed); got != tc.want {
			t.Errorf("%q -> %+v, want %+v", tc.out, got, tc.want)
		}
	}
	for _, bad := range []struct {
		out    string
		failed bool
	}{{"execution error: not allowed (-1743)", true}, {"button returned:Hacked", false}, {"", false}} {
		if got := classifyNativeOsascript(m, bad.out, bad.failed); got.Err == nil || got.ActionID != "" {
			t.Errorf("%q -> %+v, want an error and no action", bad.out, got)
		}
	}
	if got := classifyNativeOsascript(waitingModel(t), "execution error: User canceled. (-128)", true); !got.Hidden {
		t.Errorf("cancel on a waiting card = %+v, want hidden", got)
	}
}

func TestNativeZenityExitMapping(t *testing.T) {
	m := restartModel(t)
	for code, want := range map[int]nativeOutcome{
		0: {ActionID: "restart_now"},
		1: {ActionID: "postpone"},
		5: {TimedOut: true},
	} {
		if got := classifyNativeZenity(m, code); got != want {
			t.Errorf("exit %d -> %+v, want %+v", code, got, want)
		}
	}
	if got := classifyNativeZenity(m, 255); got.Err == nil || got.ActionID != "" {
		t.Errorf("exit 255 -> %+v, want an error", got)
	}
	w := waitingModel(t)
	if got := classifyNativeZenity(w, 0); got.ActionID != "hide" {
		t.Errorf("info OK -> %+v, want the default action", got)
	}
	if got := classifyNativeZenity(w, 1); !got.Hidden {
		t.Errorf("info closed -> %+v, want hidden", got)
	}
	args := strings.Join(nativePromptZenityArgs(w, nativeNow), " ")
	if !strings.HasPrefix(args, "--info --no-markup") {
		t.Errorf("a non-decision is an info dialog: %s", args)
	}
	_ = ipc.PromptRoleSafe
}
