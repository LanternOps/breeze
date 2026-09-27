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

	psCmd, err := buildVMStateScript(vmName, targetState)
	if err != nil {
		return nil, err
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
