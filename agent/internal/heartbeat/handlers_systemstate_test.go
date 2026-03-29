package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestSystemStateHandlersRegistered(t *testing.T) {
	cmds := []string{
		tools.CmdSystemStateCollect,
		tools.CmdHardwareProfile,
	}
	for _, cmd := range cmds {
		if _, ok := handlerRegistry[cmd]; !ok {
			t.Errorf("handler not registered for %q", cmd)
		}
	}
}
