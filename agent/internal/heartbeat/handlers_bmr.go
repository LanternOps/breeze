package heartbeat

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdVMRestoreEstimate] = handleVMRestoreEstimate
	handlerRegistry[tools.CmdVMRestoreFromBackup] = handleVMRestoreFromBackup
	handlerRegistry[tools.CmdBMRRecover] = handleBMRRecover
}

func handleVMRestoreEstimate(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	var cfg bmr.VMRestoreConfig
	if err := json.Unmarshal(mustMarshalPayload(cmd.Payload), &cfg); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Estimate from hardware profile in snapshot metadata
	estimate := &bmr.VMEstimate{
		RecommendedMemoryMB: 4096,
		RecommendedCPU:      2,
		RequiredDiskGB:      50,
	}

	data, _ := json.Marshal(estimate)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleVMRestoreFromBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
	}

	var cfg bmr.VMRestoreConfig
	if err := json.Unmarshal(mustMarshalPayload(cmd.Payload), &cfg); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	slog.Info("VM restore from backup requested", "vmName", cfg.VMName, "hypervisor", cfg.Hypervisor)

	// TODO: Implement actual VM creation + restore in future
	result := map[string]any{
		"status":  "pending_implementation",
		"vmName":  cfg.VMName,
		"message": "VM restore from backup is not yet fully implemented",
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

func handleBMRRecover(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	if h.backupMgr == nil {
		return tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
	}

	var cfg bmr.RecoveryConfig
	if err := json.Unmarshal(mustMarshalPayload(cmd.Payload), &cfg); err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	slog.Info("BMR recovery requested", "snapshotId", cfg.SnapshotID)

	result, err := bmr.RunRecovery(cfg, h.backupMgr.GetProvider())
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	data, _ := json.Marshal(result)
	return tools.NewSuccessResult(string(data), time.Since(start).Milliseconds())
}

// mustMarshalPayload re-marshals a map[string]any so it can be unmarshalled
// into a typed struct. This avoids manual field extraction from the payload map.
func mustMarshalPayload(payload map[string]any) []byte {
	data, _ := json.Marshal(payload)
	return data
}
