package heartbeat

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

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
	env, err := h.sessionBroker.ForwardBackupCommand(cmd.ID, cmd.Type, payload, timeout)
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
