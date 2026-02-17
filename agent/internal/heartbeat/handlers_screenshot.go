package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdTakeScreenshot] = handleTakeScreenshot
}

func handleTakeScreenshot(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.TakeScreenshot(cmd.Payload)
}
