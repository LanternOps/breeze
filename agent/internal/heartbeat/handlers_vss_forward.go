package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdVSSStatus] = handleVSSStatus
	handlerRegistry[tools.CmdVSSWriterList] = handleVSSWriterList
}

func handleVSSStatus(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Second)
}

func handleVSSWriterList(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Second)
}
