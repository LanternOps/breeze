package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdBackupRun] = handleBackupRun
	handlerRegistry[tools.CmdBackupList] = handleBackupList
	handlerRegistry[tools.CmdBackupStop] = handleBackupStop
	handlerRegistry[tools.CmdBackupRestore] = handleBackupRestore
}

func handleBackupRun(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Minute)
}

func handleBackupList(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Second)
}

func handleBackupStop(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Second)
}

func handleBackupRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Minute)
}
