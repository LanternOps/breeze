package heartbeat

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// TestBackupRunAsyncCapabilityConstant pins the exact capability name the
// server must advertise (apps/api/src/routes/agentWs.ts AGENT_WS_CAPABILITIES,
// extended by a separate task) — a typo here silently strands every agent on
// the slow legacy path forever with no error.
func TestBackupRunAsyncCapabilityConstant(t *testing.T) {
	if backupRunAsyncCapability != "backup_run_async" {
		t.Fatalf("got %q, want %q", backupRunAsyncCapability, "backup_run_async")
	}
}

// TestShouldForwardBackupRunAsync covers the gating decision in isolation
// from any real websocket/IPC plumbing. The compat invariant (old server ==
// byte-identical sync behavior) depends entirely on this returning false
// whenever the capability hasn't been seen, so every "off" branch is
// asserted explicitly rather than just the happy path.
func TestShouldForwardBackupRunAsync(t *testing.T) {
	tests := []struct {
		name               string
		cmdType            string
		hasAsyncCapability bool
		want               bool
	}{
		{"backup_run + capability present", tools.CmdBackupRun, true, true},
		{"backup_run + capability absent (old server)", tools.CmdBackupRun, false, false},
		{"backup_list + capability present (never async)", tools.CmdBackupList, true, false},
		{"backup_stop + capability present (never async)", tools.CmdBackupStop, true, false},
		{"backup_restore + capability present (never async)", tools.CmdBackupRestore, true, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldForwardBackupRunAsync(tt.cmdType, tt.hasAsyncCapability)
			if got != tt.want {
				t.Errorf("shouldForwardBackupRunAsync(%q, %v) = %v, want %v", tt.cmdType, tt.hasAsyncCapability, got, tt.want)
			}
		})
	}
}

// #3027: a failed backup run must still deliver its job body. The helper
// populates Stdout on failure (marshalBackupRunResult) precisely so the run's
// VSS diagnostics, warning text and partial counters survive; this hop used to
// discard it, which put the loss back exactly where the issue found it.
func TestBackupResultToCommandResultKeepsBodyOnFailure(t *testing.T) {
	body := `{"status":"failed","warning":"VSS shadow copy could not be created","vssMetadata":{"shadowCopyId":"set-1"}}`

	got := backupResultToCommandResult(backupipc.BackupCommandResult{
		Success:    false,
		Stdout:     body,
		Stderr:     "upload destination unreachable",
		DurationMs: 42,
	})

	// The run stays failed — the body only adds detail. The server keys the
	// job's terminal status on exactly this field, so carrying a body can never
	// turn a failed run green.
	if got.Status != "failed" {
		t.Fatalf("a failed backup must stay failed, got status %q", got.Status)
	}
	if got.Error != "upload destination unreachable" {
		t.Errorf("failure reason lost: got %q", got.Error)
	}
	// RAW, not double-encoded. toWSCommandResult only populates the parsed
	// `Result` field when Error == "", so on a failure the server falls back to
	// `stdout` with a single JSON.parse left to spend. Encoding this the way the
	// success body is encoded would make that parse yield a string, fail
	// backupCommandResultSchema, and surface as a malformed payload.
	if got.Stdout != body {
		t.Errorf("failure body must be raw object text, got %q", got.Stdout)
	}
	// Pin the invariant the server depends on: exactly one parse yields an object.
	var decoded map[string]any
	if err := json.Unmarshal([]byte(got.Stdout), &decoded); err != nil {
		t.Fatalf("one parse of the failure stdout must yield an object: %v", err)
	}
	if decoded["vssMetadata"] == nil {
		t.Errorf("VSS diagnostics missing from the failure body: %s", got.Stdout)
	}
}

func TestBackupResultToCommandResultSuccessUnchanged(t *testing.T) {
	body := `{"status":"completed"}`

	got := backupResultToCommandResult(backupipc.BackupCommandResult{
		Success:    true,
		Stdout:     body,
		DurationMs: 7,
	})

	if got.Status != "completed" {
		t.Fatalf("expected completed, got %q", got.Status)
	}
	if got.Stdout != encodeStdout(t, body) {
		t.Errorf("success body encoding changed: got %q", got.Stdout)
	}
	if got.Error != "" {
		t.Errorf("success must carry no error, got %q", got.Error)
	}
}

// The SUCCESS path runs the helper's stdout through json.Marshal
// (tools.NewSuccessResult), so its wire value is a JSON string literal rather
// than raw object text. That asymmetry with the failure path is deliberate —
// see backupResultToCommandResult — so pin it rather than hard-coding escaped
// literals in the assertion.
func encodeStdout(t *testing.T, raw string) string {
	t.Helper()
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("marshal stdout: %v", err)
	}
	return string(encoded)
}
