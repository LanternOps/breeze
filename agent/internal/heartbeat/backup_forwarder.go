package heartbeat

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// backupRunAsyncCapability is the server-advertised WS capability that gates
// the async backup_run flow (immediate {"started":true} ack over IPC, real
// result delivered later as an unsolicited backup_result envelope). Must
// match AGENT_WS_CAPABILITIES in apps/api/src/routes/agentWs.ts exactly — a
// separate task adds "backup_run_async" to that list server-side.
const backupRunAsyncCapability = "backup_run_async"

// shouldForwardBackupRunAsync decides whether a given forwarded command
// should use the async ack/unsolicited-result flow. Only backup_run ever
// qualifies (backup_list/backup_stop/backup_restore keep their existing
// short-timeout synchronous round trip regardless of server capabilities),
// and only when the connected server has advertised support — an old server
// would otherwise parse the {"started":true} ack as a malformed terminal
// result. Pulled out as a pure function so the gating decision is testable
// without a live websocket/IPC connection.
func shouldForwardBackupRunAsync(cmdType string, hasAsyncCapability bool) bool {
	return cmdType == tools.CmdBackupRun && hasAsyncCapability
}

// backupResultToCommandResult maps the backup helper's IPC result onto the
// websocket CommandResult the server consumes.
//
// The failure arm deliberately carries Stdout. marshalBackupRunResult populates
// the job body even on a failed backup_run (#3027) so the run's VSS
// diagnostics, warning text and partial counters survive; discarding it here
// would simply move the loss one hop later, which is the bug class this issue
// is about. Status remains "failed" — NewErrorResult sets it, and the server
// keys the job's terminal status on exactly that (routes/agentWs.ts records
// `completed` only when `result.status === 'completed'`), so the body can never
// turn a failed run green. It only adds detail to a failure.
//
// Pulled out as a pure function so this mapping is testable without a live
// websocket/IPC connection, matching shouldForwardBackupRunAsync above.
func backupResultToCommandResult(result backupipc.BackupCommandResult) tools.CommandResult {
	if !result.Success {
		failed := tools.NewErrorResult(fmt.Errorf("%s", result.Stderr), result.DurationMs)
		// Carried RAW, not json.Marshal'd the way NewSuccessResult encodes the
		// success body — the two branches genuinely need different encodings,
		// because toWSCommandResult treats them differently:
		//
		//   success: Error == "", so it json.Unmarshals Stdout into `Result`.
		//            The double encoding means that yields the object TEXT as a
		//            string, and the server's single JSON.parse turns it into
		//            the object.
		//   failure: Error != "", so `Result` is never populated and the server
		//            falls back to `stdout` — with only ONE parse left. A
		//            double-encoded body would parse to a string, fail
		//            backupCommandResultSchema, and be reported as a malformed
		//            payload. Raw object text is what makes that one parse land.
		failed.Stdout = result.Stdout
		return failed
	}
	return tools.NewSuccessResult(result.Stdout, result.DurationMs)
}

// forwardToBackupHelper sends a command to the backup binary via IPC and returns the result.
func forwardToBackupHelper(h *Heartbeat, cmd Command, timeout time.Duration) tools.CommandResult {
	start := time.Now()

	if h.sessionBroker == nil {
		return tools.NewErrorResult(fmt.Errorf("session broker not available"), time.Since(start).Milliseconds())
	}

	_, err := h.sessionBroker.GetOrSpawnBackupHelper(h.backupBinaryPath)
	if err != nil {
		slog.Error("failed to get backup helper", "error", err.Error())
		return tools.NewErrorResult(fmt.Errorf("backup helper unavailable: %w", err), time.Since(start).Milliseconds())
	}

	payload, err := json.Marshal(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to marshal command payload: %w", err), time.Since(start).Milliseconds())
	}
	hasAsyncCapability := h.wsClient != nil && h.wsClient.HasServerCapability(backupRunAsyncCapability)
	queueAsync := h.wsClient != nil && h.wsClient.HasServerCapability("backup_queue_async") &&
		(cmd.Type == tools.CmdBackupRun || cmd.Type == tools.CmdMSSQLBackup || cmd.Type == tools.CmdHypervBackup)
	async := queueAsync || shouldForwardBackupRunAsync(cmd.Type, hasAsyncCapability)
	env, err := h.sessionBroker.ForwardBackupCommand(cmd.ID, cmd.Type, payload, timeout, async, queueAsync)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("backup command failed: %w", err), time.Since(start).Milliseconds())
	}

	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid backup result: %w", err), time.Since(start).Milliseconds())
	}

	return backupResultToCommandResult(result)
}
