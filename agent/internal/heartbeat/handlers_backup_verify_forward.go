package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/workerpool"
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

// isBackupVerificationCommand reports whether cmdType is one of the two
// verification commands that wait up to backupVerificationTimeout on the
// helper. backup_stop is deliberately not one: it cancels a verification and
// must never queue behind it.
func isBackupVerificationCommand(cmdType string) bool {
	return cmdType == tools.CmdBackupVerify || cmdType == tools.CmdBackupTestRestore
}

// commandPoolFor returns the pool cmdType runs on: the verification lane for
// the two verification commands, the shared pool for everything else (#6106).
// Both dispatch sites use it, the websocket path
// (executeCommandViaPoolReportingDelivery) and the heartbeat poll path
// (dispatchPolledCommand). Lifecycle commands bypass both pools before this.
func (h *Heartbeat) commandPoolFor(cmdType string) *workerpool.Pool {
	if h.verificationPool != nil && isBackupVerificationCommand(cmdType) {
		return h.verificationPool
	}
	return h.pool
}

// dispatchPolledCommand submits a command delivered in a heartbeat response
// to its pool and reports whether the pool accepted it. A rejected command is
// logged and dropped without a result, like any polled command the shared
// pool rejects.
func (h *Heartbeat) dispatchPolledCommand(cmd Command) bool {
	if !h.commandPoolFor(cmd.Type).Submit(func() { h.processCommand(cmd) }) {
		log.Warn("command rejected, worker pool full", logging.KeyCommandID, cmd.ID, "type", cmd.Type)
		return false
	}
	return true
}
