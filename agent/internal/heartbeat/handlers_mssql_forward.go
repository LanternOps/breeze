package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdMSSQLDiscover] = handleMSSQLDiscover
	handlerRegistry[tools.CmdMSSQLBackup] = handleMSSQLBackup
	handlerRegistry[tools.CmdMSSQLRestore] = handleMSSQLRestore
	handlerRegistry[tools.CmdMSSQLVerify] = handleMSSQLVerify
}

func handleMSSQLDiscover(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 2*time.Minute)
}

func handleMSSQLBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Minute)
}

func handleMSSQLRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 60*time.Minute)
}

func handleMSSQLVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Minute)
}
