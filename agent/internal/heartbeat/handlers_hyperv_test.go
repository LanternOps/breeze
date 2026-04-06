package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestHypervHandlersRegistered(t *testing.T) {
	commands := []string{
		tools.CmdHypervDiscover,
		tools.CmdHypervBackup,
		tools.CmdHypervRestore,
		tools.CmdHypervCheckpoint,
		tools.CmdHypervVMState,
	}

	for _, cmd := range commands {
		t.Run(cmd, func(t *testing.T) {
			handler, ok := handlerRegistry[cmd]
			if !ok {
				t.Errorf("handler not registered for command %q", cmd)
			}
			if handler == nil {
				t.Errorf("handler is nil for command %q", cmd)
			}
		})
	}
}

func TestHypervCommandConstants(t *testing.T) {
	// Verify command constants have expected values.
	tests := []struct {
		name     string
		constant string
		expected string
	}{
		{"discover", tools.CmdHypervDiscover, "hyperv_discover"},
		{"backup", tools.CmdHypervBackup, "hyperv_backup"},
		{"restore", tools.CmdHypervRestore, "hyperv_restore"},
		{"checkpoint", tools.CmdHypervCheckpoint, "hyperv_checkpoint"},
		{"vm_state", tools.CmdHypervVMState, "hyperv_vm_state"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.constant != tc.expected {
				t.Errorf("expected %q, got %q", tc.expected, tc.constant)
			}
		})
	}
}
