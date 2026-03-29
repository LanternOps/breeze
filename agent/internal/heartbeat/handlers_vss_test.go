package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestVSSHandlersRegistered(t *testing.T) {
	cmds := []string{
		tools.CmdVSSStatus,
		tools.CmdVSSWriterList,
	}
	for _, cmd := range cmds {
		if _, ok := handlerRegistry[cmd]; !ok {
			t.Errorf("handler not registered for %q", cmd)
		}
	}
}

func TestVSSStatusNilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "test-vss-1", Type: tools.CmdVSSStatus, Payload: map[string]any{}}
	result := handleVSSStatus(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}

func TestVSSWriterListNilBroker(t *testing.T) {
	h := &Heartbeat{}
	cmd := Command{ID: "test-vss-2", Type: tools.CmdVSSWriterList, Payload: map[string]any{}}
	result := handleVSSWriterList(h, cmd)
	if result.Status != "failed" {
		t.Errorf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "session broker") {
		t.Errorf("expected session broker error, got %q", result.Error)
	}
}
