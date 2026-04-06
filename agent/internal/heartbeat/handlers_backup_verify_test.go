package heartbeat

import (
	"strings"
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
