package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdVMRestoreEstimate] = handleVMRestoreEstimate
	handlerRegistry[tools.CmdVMRestoreFromBackup] = handleVMRestoreFromBackup
	handlerRegistry[tools.CmdBMRRecover] = handleBMRRecover
}

func handleVMRestoreEstimate(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 1*time.Minute)
}

func handleVMRestoreFromBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 60*time.Minute)
}

func handleBMRRecover(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 60*time.Minute)
}
