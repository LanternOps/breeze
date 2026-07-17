package heartbeat

import (
	"testing"

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
