package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

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

func TestHandleBackupVerify_NilManager(t *testing.T) {
	h := &Heartbeat{backupMgr: nil}
	cmd := Command{ID: "test-1", Type: tools.CmdBackupVerify, Payload: map[string]any{}}
	result := handleBackupVerify(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if result.Error == "" {
		t.Error("expected error message")
	}
}

func TestHandleBackupTestRestore_NilManager(t *testing.T) {
	h := &Heartbeat{backupMgr: nil}
	cmd := Command{ID: "test-2", Type: tools.CmdBackupTestRestore, Payload: map[string]any{}}
	result := handleBackupTestRestore(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
}

func TestHandleBackupCleanup_BadPath(t *testing.T) {
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
}
