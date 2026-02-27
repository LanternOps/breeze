package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdSoftwareInstall] = handleSoftwareInstall
}

func handleSoftwareInstall(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.InstallSoftware(cmd.Payload)
}
