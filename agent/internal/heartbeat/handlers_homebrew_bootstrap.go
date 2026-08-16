package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdHomebrewBootstrap] = handleHomebrewBootstrap
}

func handleHomebrewBootstrap(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.BootstrapHomebrew(cmd.Payload)
}
