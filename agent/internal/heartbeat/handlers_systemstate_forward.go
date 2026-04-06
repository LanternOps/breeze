package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdSystemStateCollect] = handleSystemStateCollect
	handlerRegistry[tools.CmdHardwareProfile] = handleHardwareProfile
}

func handleSystemStateCollect(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 5*time.Minute)
}

func handleHardwareProfile(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 1*time.Minute)
}
