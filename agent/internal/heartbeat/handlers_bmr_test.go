package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestBMRHandlersRegistered(t *testing.T) {
	cmds := []string{
		tools.CmdVMRestoreEstimate,
		tools.CmdVMRestoreFromBackup,
		tools.CmdBMRRecover,
	}
	for _, cmd := range cmds {
		if _, ok := handlerRegistry[cmd]; !ok {
			t.Errorf("handler not registered for %q", cmd)
		}
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
