package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdVMRestoreEstimate] = handleVMRestoreEstimate
	handlerRegistry[tools.CmdVMRestoreFromBackup] = handleVMRestoreFromBackup
	handlerRegistry[tools.CmdBMRRecover] = handleBMRRecover
	handlerRegistry[tools.CmdBareMetalRebuild] = handleBareMetalRebuild
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

// handleBareMetalRebuild forwards a server-driven rebuild (W05a) to the
// helper, which bounds the run itself (a stall watchdog plus
// backupipc.BareMetalRebuildRunBudget); the IPC wait is longer than that
// budget so the helper's own terminal result, not a forwarder timeout, is
// what the server sees.
func handleBareMetalRebuild(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, backupipc.BareMetalRebuildForwardTimeout)
}
