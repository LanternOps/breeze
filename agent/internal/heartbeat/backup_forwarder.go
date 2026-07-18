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
	async := shouldForwardBackupRunAsync(cmd.Type, hasAsyncCapability)
	env, err := h.sessionBroker.ForwardBackupCommand(cmd.ID, cmd.Type, payload, timeout, async)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("backup command failed: %w", err), time.Since(start).Milliseconds())
	}

	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid backup result: %w", err), time.Since(start).Milliseconds())
	}

	if !result.Success {
		return tools.NewErrorResult(fmt.Errorf("%s", result.Stderr), result.DurationMs)
	}
	return tools.NewSuccessResult(result.Stdout, result.DurationMs)
}
