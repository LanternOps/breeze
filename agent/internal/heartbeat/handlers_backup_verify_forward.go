package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// Keep verify/test-restore aligned with the server-side command budget.
// Both commands are in the API's two-hour LONG_TIMEOUT_TYPES tier.
const backupVerificationTimeout = 2 * time.Hour

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
