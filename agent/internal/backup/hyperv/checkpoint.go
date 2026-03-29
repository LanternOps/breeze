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

	vmNameEsc := escapePSString(vmName)
	cpNameEsc := escapePSString(checkpointName)

	var psCmd string
	switch action {
	case "create":
		if checkpointName == "" {
			checkpointName = fmt.Sprintf("breeze-%d", time.Now().Unix())
			cpNameEsc = escapePSString(checkpointName)
		}
		psCmd = fmt.Sprintf(`Checkpoint-VM -Name '%s' -SnapshotName '%s'`, vmNameEsc, cpNameEsc)
	case "delete":
		psCmd = fmt.Sprintf(`Remove-VMSnapshot -VMName '%s' -Name '%s'`, vmNameEsc, cpNameEsc)
	case "apply":
		psCmd = fmt.Sprintf(`Restore-VMSnapshot -VMName '%s' -Name '%s' -Confirm:$false`, vmNameEsc, cpNameEsc)
	default:
		return nil, fmt.Errorf("%w: unsupported action %q (must be create, delete, or apply)", ErrCheckpointFailed, action)
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
