//go:build windows

package hyperv

import (
	"fmt"
	"log/slog"
	"time"
)

// ManageCheckpoint creates, deletes, or applies a VM checkpoint.
//
// Supported actions:
//   - "create": Creates a new checkpoint with name = checkpointName.
//   - "delete": Removes the checkpoint identified by checkpointName.
//   - "apply":  Restores the VM to the state of the named checkpoint.
func ManageCheckpoint(vmName, action, checkpointName string) (*CheckpointResult, error) {
	if vmName == "" {
		return nil, fmt.Errorf("%w: vmName is required", ErrCheckpointFailed)
	}
	if checkpointName == "" && action != "create" {
		return nil, fmt.Errorf("%w: checkpointName is required for %s", ErrCheckpointFailed, action)
	}

	if action == "create" && checkpointName == "" {
		checkpointName = fmt.Sprintf("breeze-%d", time.Now().Unix())
	}
	psCmd, err := buildCheckpointScript(vmName, action, checkpointName)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCheckpointFailed, err)
	}

	slog.Info("hyperv: managing checkpoint", "vm", vmName, "action", action, "checkpoint", checkpointName)

	if _, err := runPS(psCmd); err != nil {
		return &CheckpointResult{
			Action:       action,
			CheckpointID: checkpointName,
			VMName:       vmName,
			Status:       "failed",
			Error:        err.Error(),
		}, fmt.Errorf("%w: %v", ErrCheckpointFailed, err)
	}

	slog.Info("hyperv: checkpoint operation completed", "vm", vmName, "action", action)

	return &CheckpointResult{
		Action:       action,
		CheckpointID: checkpointName,
		VMName:       vmName,
		Status:       "completed",
	}, nil
}
