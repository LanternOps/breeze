package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdHypervDiscover] = handleHypervDiscover
	handlerRegistry[tools.CmdHypervBackup] = handleHypervBackup
	handlerRegistry[tools.CmdHypervRestore] = handleHypervRestore
	handlerRegistry[tools.CmdHypervCheckpoint] = handleHypervCheckpoint
	handlerRegistry[tools.CmdHypervVMState] = handleHypervVMState
}

func handleHypervDiscover(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 2*time.Minute)
}

func handleHypervBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Minute)
}

func handleHypervRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 60*time.Minute)
}

func handleHypervCheckpoint(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 5*time.Minute)
}

func handleHypervVMState(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 2*time.Minute)
}
