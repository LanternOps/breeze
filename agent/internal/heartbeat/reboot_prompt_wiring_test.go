package heartbeat

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// TestRebootManagerIsBuiltWithThePromptSeam is a source assertion, in the idiom
// of TestBrokerLifecycleCleanupNeverReopensRecordedPID (sessionbroker).
//
// The construction it guards sits inside the agent's start-up path, which cannot
// be driven in a unit test without standing up a broker, a config and a server.
// Reverting this one line to NewRebootManager compiles, passes every other test,
// and silently removes the postponement prompt from every device — a regression
// with no visible symptom short of a user watching their machine reboot with a
// button they were promised.
func TestRebootManagerIsBuiltWithThePromptSeam(t *testing.T) {
	_, testFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	source, err := os.ReadFile(filepath.Join(filepath.Dir(testFile), "heartbeat.go"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(source)
	if !strings.Contains(src, "patching.NewRebootManagerWithPrompt(") {
		t.Error("heartbeat no longer builds the reboot manager with a prompt seam; the postponement dialog would never appear")
	}
	if !strings.Contains(src, "rebootPromptFunc(") {
		t.Error("the prompt seam no longer routes through rebootPromptFunc, whose error handling is what the tests below pin")
	}
	if !strings.Contains(src, "RequestNotificationDecision(") {
		t.Error("the prompt seam no longer routes through the broker's correlated notification request")
	}
}

// TestRebootManagerIsBuiltWithTheLinuxDesktopFallback extends the guard above to
// the second delivery vehicle (#3207 W4).
//
// The same argument applies one layer out, and with a worse blast radius:
// unwrapping the chain back to a bare rebootPromptFunc compiles, passes every
// other test in this package, and silently removes the reboot dialog AND the
// desktop notification from every Linux device — the platform that has no
// helper binary and therefore nothing else to fall back to. Nothing about that
// regression is visible from the console; the only symptom is a Linux user
// whose machine reboots with no warning at all.
func TestRebootManagerIsBuiltWithTheLinuxDesktopFallback(t *testing.T) {
	_, testFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	source, err := os.ReadFile(filepath.Join(filepath.Dir(testFile), "heartbeat.go"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(source)

	for _, want := range []struct{ token, why string }{
		{"chainedRebootPrompt(", "the prompt no longer chains to the daemon-drawn dialog; Linux devices lose the postponement prompt entirely"},
		{"chainedRebootNotify(", "the warning no longer chains to the daemon-drawn notification; a Linux desktop user would never see a reboot warning"},
		{"patching.DesktopPrompt", "the Linux dialog is no longer wired in as the prompt fallback"},
		{"patching.DesktopNotify", "the Linux notification is no longer wired in as the warning fallback"},
		{`SessionsWithScope("notify")`, "the daemon path is no longer gated on the absence of a helper session, so a future Linux helper would double every warning"},
	} {
		if !strings.Contains(src, want.token) {
			t.Errorf("heartbeat.go no longer contains %q: %s", want.token, want.why)
		}
	}
}

// TestRebootPromptFuncTranslatesTheBrokerResult drives the REAL translation, not
// a hand-rolled stand-in. The distinction this pins is the one that decides
// whether a headless box gets warned at all: an unconfirmed prompt must report
// shown=false so the manager falls back, while a delivered one must not, or every
// rung would double.
func TestRebootPromptFuncTranslatesTheBrokerResult(t *testing.T) {
	cases := []struct {
		name      string
		res       ipc.NotifyResult
		err       error
		wantLabel string
		wantShown bool
	}{
		{
			name:      "the user clicked postpone",
			res:       ipc.NotifyResult{Delivered: true, ActionClicked: "Postpone 1 hour"},
			wantLabel: "Postpone 1 hour",
			wantShown: true,
		},
		{
			name:      "a real person saw the dialog and did nothing",
			res:       ipc.NotifyResult{Delivered: true},
			wantShown: true,
		},
		{
			// The headless case, and the one the earlier version of this code got
			// wrong: no notify-scoped session means the broker returns a zero
			// result and NO error, which must not be mistaken for a silent user.
			name:      "no helper session at all",
			res:       ipc.NotifyResult{},
			wantShown: false,
		},
		{
			// The helper answered honestly that neither the dialog nor its toast
			// fallback rendered.
			name:      "the helper reached nobody",
			res:       ipc.NotifyResult{Delivered: false},
			wantShown: false,
		},
		{
			name:      "the prompt went unanswered",
			err:       fmt.Errorf("session s1: %w", sessionbroker.ErrCommandTimeout),
			wantShown: false,
		},
		{
			name:      "the transport broke",
			err:       fmt.Errorf("session s1: broken pipe"),
			wantShown: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen ipc.NotifyRequest
			fn := rebootPromptFunc(func(req ipc.NotifyRequest, _ time.Duration) (ipc.NotifyResult, error) {
				seen = req
				return tc.res, tc.err
			})

			label, shown := fn("Restart Scheduled", "in 15 minutes", "normal",
				[]string{patching.RebootActionRestartNow, "Postpone 1 hour"}, 90*time.Second)

			if label != tc.wantLabel {
				t.Errorf("clicked = %q, want %q", label, tc.wantLabel)
			}
			if shown != tc.wantShown {
				t.Errorf("shown = %v, want %v", shown, tc.wantShown)
			}
			if seen.TimeoutMs != 90_000 {
				t.Errorf("TimeoutMs = %d, want 90000 — the manager's window must reach the helper's countdown", seen.TimeoutMs)
			}
			if len(seen.Actions) != 2 || seen.Actions[0] != patching.RebootActionRestartNow {
				t.Errorf("Actions = %v, want the affirmative first", seen.Actions)
			}
			if seen.Title != "Restart Scheduled" || seen.Urgency != "normal" {
				t.Errorf("request = %+v, want the manager's title and urgency passed through", seen)
			}
		})
	}
}

// TestRebootPromptFuncWithNoBrokerIsNotADecision covers the agent starting up
// before the session broker exists.
func TestRebootPromptFuncWithNoBrokerIsNotADecision(t *testing.T) {
	fn := rebootPromptFunc(func(ipc.NotifyRequest, time.Duration) (ipc.NotifyResult, error) {
		return ipc.NotifyResult{}, nil
	})
	label, shown := fn("Restart Scheduled", "in 15 minutes", "normal",
		[]string{patching.RebootActionRestartNow, "Postpone 1 hour"}, time.Minute)
	if label != "" || shown {
		t.Errorf("clicked = %q, shown = %v; want no decision and no delivery", label, shown)
	}
}
