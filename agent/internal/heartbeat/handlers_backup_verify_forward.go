package heartbeat

import (
	"encoding/json"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

// backupVerificationForwardTimeout is how long the agent waits for the helper
// to answer a backup_verify / backup_test_restore: the server's budget for
// this command (payload.timeBudgetSeconds, scaled by the API with the
// snapshot's size) clamped to [backupipc.VerifyCommandTimeout,
// backupipc.VerifyMaxCommandTimeout]. Absent or unusable is the 2h base, which
// is what a server that predates the field budgets for.
//
// The wait travels to the helper as the IPC request's TimeoutMs, and the
// helper stops each run backupipc.VerifyRunMargin short of it, so its partial
// counts arrive before this wait gives up (#6598).
func backupVerificationForwardTimeout(payload map[string]any) time.Duration {
	var seconds float64
	switch v := payload["timeBudgetSeconds"].(type) {
	case float64:
		seconds = v
	case int:
		seconds = float64(v)
	case int64:
		seconds = float64(v)
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return backupipc.VerifyCommandTimeout
		}
		seconds = f
	default:
		return backupipc.VerifyCommandTimeout
	}
	return backupipc.ClampVerifyCommandTimeout(seconds)
}

func init() {
	handlerRegistry[tools.CmdBackupVerify] = handleBackupVerify
	handlerRegistry[tools.CmdBackupTestRestore] = handleBackupTestRestore
	handlerRegistry[tools.CmdBackupCleanup] = handleBackupCleanup
}

func handleBackupVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, backupVerificationForwardTimeout(cmd.Payload))
}

func handleBackupTestRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, backupVerificationForwardTimeout(cmd.Payload))
}

func handleBackupCleanup(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 1*time.Minute)
}

// isBackupVerificationCommand reports whether cmdType is one of the two
// verification commands that wait up to backupVerificationForwardTimeout on the
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
