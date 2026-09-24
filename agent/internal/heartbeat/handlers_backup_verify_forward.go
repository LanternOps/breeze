package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// Keep verify/test-restore aligned with the server-side command budget.
// Both commands are in the API's two-hour LONG_TIMEOUT_TYPES tier. The helper
// stops each run at backupipc.VerifyRunBudget, short of this, so its partial
// counts arrive before this wait gives up (#6598).
const backupVerificationTimeout = backupipc.VerifyCommandTimeout

func init() {
	handlerRegistry[tools.CmdBackupVerify] = handleBackupVerify
	handlerRegistry[tools.CmdBackupTestRestore] = handleBackupTestRestore
	handlerRegistry[tools.CmdBackupCleanup] = handleBackupCleanup
}

func handleBackupVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, backupVerificationTimeout)
}

func handleBackupTestRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, backupVerificationTimeout)
}

func handleBackupCleanup(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 1*time.Minute)
}
