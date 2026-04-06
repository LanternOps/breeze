//go:build windows

package hyperv

import (
	"fmt"
	"log/slog"
)

// ChangeVMState starts, stops, pauses, resumes, or saves a VM.
//
// Supported states: "start", "stop", "pause", "resume", "save", "force_stop".
func ChangeVMState(vmName, targetState string) (*VMStateResult, error) {
	if vmName == "" {
		return nil, fmt.Errorf("vmName is required")
	}

	vmNameEsc := escapePSString(vmName)

	var psCmd string
	switch targetState {
	case "start":
		psCmd = fmt.Sprintf(`Start-VM -Name '%s'`, vmNameEsc)
	case "stop":
		psCmd = fmt.Sprintf(`Stop-VM -Name '%s' -Force:$false`, vmNameEsc)
	case "force_stop":
		psCmd = fmt.Sprintf(`Stop-VM -Name '%s' -Force -TurnOff`, vmNameEsc)
	case "pause":
		psCmd = fmt.Sprintf(`Suspend-VM -Name '%s'`, vmNameEsc)
	case "resume":
		psCmd = fmt.Sprintf(`Resume-VM -Name '%s'`, vmNameEsc)
	case "save":
		psCmd = fmt.Sprintf(`Save-VM -Name '%s'`, vmNameEsc)
	default:
		return nil, fmt.Errorf("unsupported target state: %s", targetState)
	}

	slog.Info("hyperv: changing VM state", "vm", vmName, "targetState", targetState)

	if _, err := runPS(psCmd); err != nil {
		return &VMStateResult{
			VMName: vmName,
			State:  targetState,
			Status: "failed",
			Error:  err.Error(),
		}, err
	}

	return &VMStateResult{
		VMName: vmName,
		State:  targetState,
		Status: "completed",
	}, nil
}
