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

// D20-B: the success path used to run the helper's already-JSON stdout back
// through tools.NewSuccessResult, which json.Marshal's it a SECOND time. A
// queue-admission ack the helper sends as the 16-byte text `{"queued":true}`
// was therefore forwarded as the 24-byte text `"{\"queued\":true}"` — valid
// JSON, but a JSON STRING, not an object. The server's single JSON.parse of
// that (routes/backup/mssql.ts, hyperv.ts) yields a plain string, which is
// exactly the "expected object, received string" 500 proven live against
// agent 0.112.5 (D20). Stdout must now carry the helper's JSON text VERBATIM,
// matching the failure path's raw-text encoding — the two branches no longer
// need different encodings once the server (apps/api's parseAgentJsonStdout)
// tolerates a double-encoded body from an old agent on its own.
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
	if got.Stdout != body {
		t.Errorf("success body must be raw JSON text, not double-encoded: got %q, want %q", got.Stdout, body)
	}
	if got.Error != "" {
		t.Errorf("success must carry no error, got %q", got.Error)
	}
	// Pin the invariant the server depends on: exactly one parse yields an object.
	var decoded map[string]any
	if err := json.Unmarshal([]byte(got.Stdout), &decoded); err != nil {
		t.Fatalf("one parse of the success stdout must yield an object: %v", err)
	}
}

// D20-B: a queue-admission/started ack must survive the same hop without
// gaining a layer of encoding — this is the exact shape
// agent/cmd/breeze-backup/main.go sends for QueueAsync admission and for the
// legacy Async started ack.
func TestBackupResultToCommandResultQueuedAckNotDoubleEncoded(t *testing.T) {
	ack := `{"queued":true}`

	got := backupResultToCommandResult(backupipc.BackupCommandResult{
		Success:    true,
		Stdout:     ack,
		DurationMs: 1,
	})

	if got.Stdout != ack {
		t.Fatalf("queued ack stdout must be raw JSON text: got %q, want %q", got.Stdout, ack)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(got.Stdout), &decoded); err != nil {
		t.Fatalf("one parse of the ack stdout must yield an object: %v", err)
	}
	if decoded["queued"] != true {
		t.Errorf("queued marker lost: %v", decoded)
	}
}
