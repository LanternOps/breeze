package heartbeat

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestBMRHandlersRegistered(t *testing.T) {
	cmds := []string{
		tools.CmdVMRestoreEstimate,
		tools.CmdVMRestoreFromBackup,
		tools.CmdVMInstantBoot,
		tools.CmdBMRRecover,
		tools.CmdBareMetalRebuild,
	}
	for _, cmd := range cmds {
		if _, ok := handlerRegistry[cmd]; !ok {
			t.Errorf("handler not registered for %q", cmd)
		}
	}
}

// TestBMRCommandsRouteToBackupHelper proves each VM/BMR command type the API
// dispatches reaches forwardToBackupHelper through the real dispatch path.
// With no session broker the forwarder fails with "session broker not
// available"; an unrouted type would instead come back handled=false, which
// the heartbeat reports to the server as an unknown command. The type strings
// are literals on purpose: they are the wire values the API sends
// (apps/api/src/services/commandTypes.ts), so the test does not depend on the
// agent constants it is checking.
func TestBMRCommandsRouteToBackupHelper(t *testing.T) {
	tests := []struct {
		name    string
		cmdType string
	}{
		{name: "vm restore estimate", cmdType: "vm_restore_estimate"},
		{name: "vm restore from backup", cmdType: "vm_restore_from_backup"},
		{name: "vm instant boot", cmdType: "vm_instant_boot"},
		{name: "bmr recover", cmdType: "bmr_recover"},
		{name: "bare metal rebuild", cmdType: "bare_metal_rebuild"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Heartbeat{}
			result, handled := h.dispatchCommand(Command{
				ID:      "route-" + tt.cmdType,
				Type:    tt.cmdType,
				Payload: map[string]any{"snapshotId": "snap-1", "vmName": "vm-1"},
			})
			if !handled {
				t.Fatalf("%q is not routed: dispatchCommand returned handled=false (agent answers it as an unknown command)", tt.cmdType)
			}
			if result.Status != "failed" {
				t.Errorf("status = %q, want failed (nil session broker)", result.Status)
			}
			if !strings.Contains(result.Error, "session broker") {
				t.Errorf("error = %q, want the forwarder's session broker error", result.Error)
			}
		})
	}
}

func TestHandleVMRestoreFromBackup_NilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{
		ID:      "test-vm-1",
		Type:    tools.CmdVMRestoreFromBackup,
		Payload: map[string]any{"vmName": "test-vm", "hypervisor": "hyperv"},
	}
	result := handleVMRestoreFromBackup(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}

func TestHandleBMRRecover_NilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{
		ID:      "test-bmr-1",
		Type:    tools.CmdBMRRecover,
		Payload: map[string]any{"snapshotId": "snap-123"},
	}
	result := handleBMRRecover(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}

func TestHandleBareMetalRebuild_NilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{
		ID:      "test-bmr-rebuild-1",
		Type:    tools.CmdBareMetalRebuild,
		Payload: map[string]any{"recoveryId": "rec-1"},
	}
	result := handleBareMetalRebuild(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}

// TestForwardWaitExceedsHelperRunBudget pins every helper-bounded restore
// command: the agent must wait longer than the helper lets the run work, or
// the server records a forwarder timeout ("failed") while the restore is still
// running in the helper, and the helper's real result arrives unsolicited.
func TestForwardWaitExceedsHelperRunBudget(t *testing.T) {
	tests := []struct {
		cmdType     string
		forwardWait time.Duration
		helperCap   time.Duration
	}{
		{tools.CmdVMRestoreFromBackup, vmRestoreFromBackupForwardWait, backupipc.VMRestoreFromBackupRunBudget},
		{tools.CmdVMInstantBoot, vmInstantBootForwardWait, backupipc.VMInstantBootRunBudget},
		{tools.CmdBareMetalRebuild, bareMetalRebuildForwardWait, backupipc.BareMetalRebuildRunBudget},
	}
	for _, tt := range tests {
		t.Run(tt.cmdType, func(t *testing.T) {
			if tt.forwardWait < tt.helperCap+backupipc.HelperResultGrace {
				t.Errorf("agent waits %v for %s but the helper may run for %v; want at least %v (budget + HelperResultGrace)",
					tt.forwardWait, tt.cmdType, tt.helperCap, tt.helperCap+backupipc.HelperResultGrace)
			}
		})
	}
}
