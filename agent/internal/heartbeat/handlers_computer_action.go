package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdComputerAction] = handleComputerAction
}

func handleComputerAction(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Service mode (Session 0): route through IPC to user helper which has a display
	if h.isService && h.sessionBroker != nil {
		return h.executeToolViaHelper(tools.CmdComputerAction, cmd.Payload, start)
	}

	return tools.ComputerAction(cmd.Payload)
}
