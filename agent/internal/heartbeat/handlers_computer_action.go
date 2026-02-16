package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdComputerAction] = handleComputerAction
}

func handleComputerAction(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ComputerAction(cmd.Payload)
}
