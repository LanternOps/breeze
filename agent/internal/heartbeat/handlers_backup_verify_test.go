package heartbeat

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// The forward wait follows the budget the API computed for the snapshot
// (payload.timeBudgetSeconds), clamped to [2h, 12h]; anything absent or
// unusable is the 2h base, which is what an older API sends.
func TestBackupVerificationForwardTimeoutFollowsPayloadBudget(t *testing.T) {
	cases := []struct {
		name    string
		payload map[string]any
		want    time.Duration
	}{
		{"nil payload", nil, 2 * time.Hour},
		{"absent", map[string]any{"snapshotId": "s"}, 2 * time.Hour},
		{"json number (float64)", map[string]any{"timeBudgetSeconds": float64(395 * 60)}, 395 * time.Minute},
		{"int", map[string]any{"timeBudgetSeconds": 395 * 60}, 395 * time.Minute},
		{"int64", map[string]any{"timeBudgetSeconds": int64(395 * 60)}, 395 * time.Minute},
		{"json.Number", map[string]any{"timeBudgetSeconds": json.Number("23700")}, 395 * time.Minute},
		{"below floor", map[string]any{"timeBudgetSeconds": float64(60)}, 2 * time.Hour},
		{"above cap", map[string]any{"timeBudgetSeconds": float64(48 * 3600)}, 12 * time.Hour},
		{"string", map[string]any{"timeBudgetSeconds": "23700"}, 2 * time.Hour},
		{"bad json.Number", map[string]any{"timeBudgetSeconds": json.Number("x")}, 2 * time.Hour},
		{"bool", map[string]any{"timeBudgetSeconds": true}, 2 * time.Hour},
		{"null", map[string]any{"timeBudgetSeconds": nil}, 2 * time.Hour},
		{"NaN", map[string]any{"timeBudgetSeconds": math.NaN()}, 2 * time.Hour},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := backupVerificationForwardTimeout(tc.payload); got != tc.want {
				t.Fatalf("backupVerificationForwardTimeout(%v) = %v, want %v", tc.payload, got, tc.want)
			}
		})
	}
}

// A verify with a scaled budget legitimately runs past the 2h default
// wedge-watchdog tier, so its warning waits for its own forward timeout.
func TestCommandWarnAfterForVerifyUsesForwardTimeout(t *testing.T) {
	h := &Heartbeat{}
	scaled := Command{Type: tools.CmdBackupVerify, Payload: map[string]any{"timeBudgetSeconds": float64(395 * 60)}}
	if got := h.commandWarnAfterFor(scaled); got != 395*time.Minute {
		t.Fatalf("scaled verify warn = %v, want 395m", got)
	}
	restore := Command{Type: tools.CmdBackupTestRestore, Payload: map[string]any{"timeBudgetSeconds": float64(48 * 3600)}}
	if got := h.commandWarnAfterFor(restore); got != 12*time.Hour {
		t.Fatalf("over-cap test restore warn = %v, want 12h", got)
	}
	unscaled := Command{Type: tools.CmdBackupVerify, Payload: map[string]any{}}
	if got := h.commandWarnAfterFor(unscaled); got != defaultCommandInFlightWarnAfter {
		t.Fatalf("unscaled verify warn = %v, want the default %v", got, defaultCommandInFlightWarnAfter)
	}
	other := Command{Type: "run_script", Payload: map[string]any{"timeBudgetSeconds": float64(48 * 3600)}}
	if got := h.commandWarnAfterFor(other); got != defaultCommandInFlightWarnAfter {
		t.Fatalf("non-verify warn = %v, want the default %v (payload field must be ignored)", got, defaultCommandInFlightWarnAfter)
	}
	// A test override still wins within its tier.
	h.commandInFlightWarnAfter = time.Second
	if got := h.commandWarnAfterFor(scaled); got != time.Second {
		t.Fatalf("override warn = %v, want 1s", got)
	}
}

func TestBackupVerifyHandlersRegistered(t *testing.T) {
	cmds := []string{
		tools.CmdBackupVerify,
		tools.CmdBackupTestRestore,
		tools.CmdBackupCleanup,
	}
	for _, cmd := range cmds {
		if _, ok := handlerRegistry[cmd]; !ok {
			t.Errorf("handler not registered for %q", cmd)
		}
	}
}

func TestHandleBackupVerify_NilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "test-1", Type: tools.CmdBackupVerify, Payload: map[string]any{}}
	result := handleBackupVerify(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}

func TestHandleBackupTestRestore_NilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "test-2", Type: tools.CmdBackupTestRestore, Payload: map[string]any{}}
	result := handleBackupTestRestore(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}

func TestHandleBackupCleanup_NilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{
		ID:      "test-3",
		Type:    tools.CmdBackupCleanup,
		Payload: map[string]any{"restorePath": "/etc/passwd"},
	}
	result := handleBackupCleanup(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}
