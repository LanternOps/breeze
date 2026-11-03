package userhelper

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// W05 (#10190): the restart card drawn natively (RDP sessions, a killed
// Assist) keeps the safe action — Postpone, or OK when no postponement is
// offered — as the default and as what Esc means. Restart now is never the
// default on any platform's dialog.
func TestNativeRestartCardDefaultsToTheSafeAction(t *testing.T) {
	withPostpone := nativeFixture(t, "show.restart.json")
	withoutPostpone := nativeFixture(t, "show.restart.json")
	withoutPostpone.Actions = []ipc.PromptAction{
		{ID: "ok", Label: "OK", Role: ipc.PromptRoleSafe},
		{ID: "restart_now", Label: "Restart now", Role: ipc.PromptRoleProceed},
	}
	withoutPostpone.DefaultActionID = "ok"
	for _, tc := range []struct {
		name string
		show ipc.PromptShow
		safe string
	}{{"postpone offered", withPostpone, "postpone"}, {"no postponement", withoutPostpone, "ok"}} {
		t.Run(tc.name, func(t *testing.T) {
			m, err := buildNativePromptModel(tc.show, nativeNow, time.UTC)
			if err != nil {
				t.Fatal(err)
			}
			if m.DefaultID != tc.safe || m.CancelID != tc.safe || !m.Decision {
				t.Fatalf("default/cancel/decision = %s/%s/%v, want %s", m.DefaultID, m.CancelID, m.Decision, tc.safe)
			}
			spec := nativeTaskDialogSpecFor(m)
			if i := spec.DefaultButtonIndex(); i < 0 || spec.Buttons[i].ID != tc.safe {
				t.Fatalf("TaskDialog default = %d (%+v)", i, spec.Buttons)
			}
			mb := nativeMessageBoxSpecFor(m)
			if mb.NoID != tc.safe || mb.Flags&consentMBDefButton2 == 0 {
				t.Fatalf("MessageBox fallback No/flags = %s/%#x, want No = %s as the default", mb.NoID, mb.Flags, tc.safe)
			}
			script := nativePromptOsascript(m, nativeNow)
			safeLabel, _ := m.button(tc.safe)
			if !strings.Contains(script, `default button "`+safeLabel.Label+`"`) || !strings.Contains(script, `cancel button "`+safeLabel.Label+`"`) {
				t.Fatalf("osascript = %s", script)
			}
			args := strings.Join(nativePromptZenityArgs(m, nativeNow), " ")
			if !strings.Contains(args, "--default-cancel") || !strings.Contains(args, "--cancel-label "+safeLabel.Label) {
				t.Fatalf("zenity = %s", args)
			}
		})
	}
}
