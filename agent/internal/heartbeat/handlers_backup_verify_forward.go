package heartbeat

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/wire"
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

// verificationMinUsefulRun is the shortest helper run worth starting: a
// verification with less than backupipc.VerifyRunMargin + this left of its
// budget when it reaches the helper is failed instead (#11813).
const verificationMinUsefulRun = 5 * time.Minute

// verificationForwardTimeoutAfterWait is the forward wait for a verification
// received at receivedAt that is about to reach the helper at now: its budget
// less the time it waited on this agent. The server's clocks for the command
// (its storage session's deadline, the stale-command reaper, the verification
// timeout) all run from delivery, so the wait here is spent out of the same
// budget; the helper, which stops backupipc.VerifyRunMargin short of the wait
// it is given, then finishes inside them.
//
// ok is false when less than backupipc.VerifyRunMargin +
// verificationMinUsefulRun is left: there is no useful run to start, and a
// wait no longer than the margin would make the helper fall back to its
// default run budget, past the server's deadline. A zero receivedAt (the
// handler was reached without a dispatch site's stamp) or a wait that is not
// positive deducts nothing.
func verificationForwardTimeoutAfterWait(budget time.Duration, receivedAt, now time.Time) (time.Duration, bool) {
	if receivedAt.IsZero() {
		return budget, true
	}
	waited := now.Sub(receivedAt)
	if waited <= 0 {
		return budget, true
	}
	remaining := budget - waited
	return remaining, remaining >= backupipc.VerifyRunMargin+verificationMinUsefulRun
}

// verificationNow is the clock for a verification's receipt stamp and its
// lane wait (time.Now, monotonic; a test seam).
func (h *Heartbeat) verificationNow() time.Time {
	if h.verificationClock != nil {
		return h.verificationClock()
	}
	return time.Now()
}

// stampVerificationReceipt records when a verification command reached this
// agent, before it joins its pool's queue, so the time it then waits there
// comes out of its budget (verificationForwardTimeoutAfterWait). Both
// dispatch sites call it; any other command is returned unchanged.
func (h *Heartbeat) stampVerificationReceipt(cmd Command) Command {
	if isBackupVerificationCommand(cmd.Type) && cmd.receivedAt.IsZero() {
		cmd.receivedAt = h.verificationNow()
	}
	return cmd
}

// forwardBackupVerification forwards a backup_verify or backup_test_restore
// with what is left of its budget once the helper is up, or fails it with
// ErrCodeVerificationQueueExpired, without reaching the helper, when too
// little is left for a useful run.
func forwardBackupVerification(h *Heartbeat, cmd Command) tools.CommandResult {
	budget := backupVerificationForwardTimeout(cmd.Payload)
	return forwardToBackupHelperWithin(h, cmd, func() (time.Duration, *tools.CommandResult) {
		now := h.verificationNow()
		remaining, ok := verificationForwardTimeoutAfterWait(budget, cmd.receivedAt, now)
		if ok {
			return remaining, nil
		}
		waited := now.Sub(cmd.receivedAt)
		left := max(remaining, 0)
		log.Warn("backup verification waited on this agent until too little of its budget was left; not starting it",
			logging.KeyCommandID, cmd.ID, "type", cmd.Type,
			"waited", waited.Round(time.Second).String(), "budget", budget.String(), "left", left.Round(time.Second).String())
		refused := tools.NewErrorResult(fmt.Errorf(
			"backup verification was not started: it waited %s on this device behind other verifications, "+
				"leaving %s of its %s time budget, less than the %s a run needs; run it again when fewer verifications are queued",
			waited.Round(time.Minute), left.Round(time.Minute), budget, backupipc.VerifyRunMargin+verificationMinUsefulRun), 0)
		refused.ErrorCode = wire.ErrCodeVerificationQueueExpired
		return 0, &refused
	})
}

func handleBackupVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardBackupVerification(h, cmd)
}

func handleBackupTestRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardBackupVerification(h, cmd)
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
	cmd = h.stampVerificationReceipt(cmd)
	if !h.commandPoolFor(cmd.Type).Submit(func() { h.processCommand(cmd) }) {
		log.Warn("command rejected, worker pool full", logging.KeyCommandID, cmd.ID, "type", cmd.Type)
		return false
	}
	return true
}
