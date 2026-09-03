package heartbeat

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
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
	if !strings.Contains(src, "RequestNotificationDecision(") {
		t.Error("the prompt seam no longer routes through the broker's correlated notification request")
	}
}

// TestRebootPromptSeamShapeMatchesTheBroker pins that the two halves of the seam
// still fit: patching.PromptFunc's signature on one side, and the broker request
// it is implemented with on the other. A change to either that did not update the
// other would otherwise only surface at the heartbeat's own build.
func TestRebootPromptSeamShapeMatchesTheBroker(t *testing.T) {
	var seen ipc.NotifyRequest
	var fn patching.PromptFunc = func(title, body, urgency string, actions []string, timeout time.Duration) string {
		seen = ipc.NotifyRequest{
			Title:     title,
			Body:      body,
			Urgency:   urgency,
			Actions:   actions,
			TimeoutMs: int(timeout.Milliseconds()),
		}
		return actions[0]
	}

	got := fn("Restart Scheduled", "in 15 minutes", "normal",
		[]string{patching.RebootActionRestartNow, "Postpone 1 hour"}, 90*time.Second)

	if got != patching.RebootActionRestartNow {
		t.Errorf("prompt returned %q, want %q", got, patching.RebootActionRestartNow)
	}
	if seen.TimeoutMs != 90_000 {
		t.Errorf("TimeoutMs = %d, want 90000 — the manager's timeout must reach the helper's countdown", seen.TimeoutMs)
	}
	if len(seen.Actions) != 2 {
		t.Fatalf("Actions = %v, want the two-button pair", seen.Actions)
	}
}
